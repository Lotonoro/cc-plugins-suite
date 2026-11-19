import type { EngineInterface } from 'claude-code'
import type { Item } from '../types'
import { ALREADY_ASKING, NOTHING_OPEN, openOf, outcomeLine, readAnswer, skippedLine, walkDialog, walkEnd, walkSummary, type Dialog, type Reason } from './commands'
import { messageOf } from './done'
import { markRead } from './pane'
import { readList } from './shared'
import { setWalkAsking } from './turns'
import { pressShown } from './windows'

// The walk behind `/todo answer`: it asks about each open item in one dialog, writes each answer the person gives through the path `/todo <n> <form>` takes (a
// guarded write, windows.ts), and ends with the text the command returns (commands.ts words every line). It runs inside the command's hook, so the plugin's own
// `tool.call` hook sees each dialog's result before the dialog returns, which is how a walk tells an answer a person gave from one the engine made for them. The
// state is the module's, and none of it is in `$.state`: a reload drops a walk (an accepted cost).

// The walk that is asking, if one is. A walk takes the flag in the step it starts, before it awaits anything, so two `/todo answer` cannot both start. The flag
// is also the walk's tie to its session: a walk whose flag is no longer its own has lost its session (endWalk), and asks and writes nothing more. Only the walk
// that took the flag clears it, so a walk that settles late leaves a newer walk's flag in place. The same step tells the turn-state module a walk is asking, so
// no submit is tried for a notice meanwhile (turns.ts), and only the walk that took the flag tells it the walk is over; a session's end resets that module.
let walking: symbol | null = null

// What the observer saw of the plugin's own call: the question as the call carried it, and whether the result carried `afkTimeoutMs`, which only a dialog the
// engine resolved for an absent person carries.
type Seen = { question: string; afk: boolean }
// The dialog the walk has open: its item, its question, and the record the observer made of its call. A new object is made for each ask, which clears the record.
type Asking = { id: number; question: string; seen: Seen | null }
let asking: Asking | null = null

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// The question a raw AskUserQuestion call asks, or null when the call has no first question as text: a hook's call is not checked against the tool's typing.
function questionOf(call: unknown): string | null {
  if (!isRecord(call) || !Array.isArray(call.questions)) return null
  const first: unknown = call.questions[0]
  return isRecord(first) && typeof first.question === 'string' ? first.question : null
}

// The plugin's own AskUserQuestion call, as the tool.call hook sees it once the dialog has been answered: the call and its result, both raw. While a walk is asking
// it records the question the call carried and whether the result carries `afkTimeoutMs`, and writes the record's debug line. A call it can make no record of
// leaves none, which the walk reads as an answer it cannot confirm.
export function observeAsked($: EngineInterface, call: unknown, result: unknown): void {
  const current = asking
  if (current === null) return
  const question = questionOf(call)
  if (question === null) return
  const afk = isRecord(result) && isRecord(result.result) && result.result.afkTimeoutMs !== undefined
  current.seen = { question, afk }
  $.ui.log(`human-plugin: walk record for #${current.id}: afkTimeoutMs ${afk ? 'present' : 'absent'}`, { to: 'debug' })
}

// A session's end: the walk that is asking belongs to the session that ended, so its flag is released and its record dropped. Its open dialog may still return;
// the walk then finds the flag is not its own, and asks and writes nothing more.
export function endWalk(): void {
  walking = null
  asking = null
}

// Whether the walk `me` still owns its session: its flag is its own until the session ends (endWalk). It is the one test a walk makes of that: before each
// question, after each dialog, and, handed to the guarded write, inside the list update that carries its answer.
const owns = (me: symbol): boolean => walking === me

// How far a walk has got: the items it has asked about (an item is asked at most once per walk), the answers it has written, and the outcome line of the last
// item that no question has shown yet.
type Progress = { asked: Set<number>; sent: number; pending: string | null }

// What the dialog gave back: the text it resolved with, or the message it was rejected with (a dismissal, an expiry or a refusal alike).
type Returned = { kind: 'text'; text: string } | { kind: 'rejected'; message: string }

// How the walk's ask line ends: what became of the answer.
type Outcome = 'written' | 'refused as changed' | 'left the list' | 'skipped' | 'stopped' | 'not written' | 'session ended'

// The record the observer made of the dialog's call: none, one for the question the walk asked, or one for another question.
const recordState = (slot: Asking): 'matched' | 'missing' | 'other question' =>
  slot.seen === null ? 'missing' : slot.seen.question === slot.question ? 'matched' : 'other question'

// What the dialog gave back, for the ask line: the label it resolved with, a count of the characters of any other text (a reply's own text is never logged), or
// the rejection's message.
const returnedText = (returned: Returned, labels: readonly string[]): string => {
  if (returned.kind === 'rejected') return `rejected: ${returned.message}`
  if (labels.includes(returned.text)) return `label "${returned.text}"`
  return returned.text.trim() === '' ? 'blank' : `text of ${returned.text.length} characters`
}

// An item that is shown is read: its unread mark goes, as `/todo <n>` clears it, and only while the item is still the one shown. A mark that cannot be cleared is
// logged, and the walk goes on: the question is what the person asked for.
async function clearMark($: EngineInterface, item: Item): Promise<void> {
  try {
    await markRead($, item.id, item)
  } catch (err) {
    $.ui.log(`human-plugin: the unread mark of #${item.id} was not cleared: ${String(err)}`)
  }
}

// One question: the dialog is asked, and what it gave back is read in this order. A walk that lost its session ends, and a rejected dialog ends the walk. An answer
// the observer saw no result for, or only one for another question, ends it as one that cannot be confirmed as the person's, and so does one whose result carries
// `afkTimeoutMs`. Only then is the answer read against the item: Stop ends the walk, Skip goes on, and any other answer is written through the guarded write, which
// is handed the walk's test of its session and writes nothing once it fails, so a session that ends after the test above and before the write's list update ends
// the walk the same way. Every ask leaves its line in the debug log, a throw included. Returns the reason the walk ended, or null to go on with the next item.
async function askOne($: EngineInterface, windowMs: number, me: symbol, progress: Progress, item: Item, dialog: Dialog): Promise<Reason | null> {
  const slot: Asking = { id: item.id, question: dialog.question, seen: null }
  asking = slot
  let returned: Returned
  try {
    returned = { kind: 'text', text: await $.ui.ask(dialog.question, { options: dialog.options, header: dialog.header }) }
  } catch (err) {
    returned = { kind: 'rejected', message: err instanceof Error ? err.message : String(err) }
  } finally {
    if (asking === slot) asking = null
  }
  const state = recordState(slot)
  let outcome: Outcome = 'not written'
  // The walk lost its session: nothing more is asked or written, and the ask line says so.
  const sessionEnded = (): Reason => {
    outcome = 'session ended'
    return { kind: 'session' }
  }
  try {
    if (!owns(me)) return sessionEnded()
    if (returned.kind === 'rejected') return { kind: 'closed', id: item.id }
    if (state !== 'matched') return { kind: 'unconfirmed', id: item.id }
    if (slot.seen?.afk === true) return { kind: 'auto', id: item.id }
    const reading = readAnswer(item, returned.text)
    if (reading.kind === 'stop') {
      outcome = 'stopped'
      return { kind: 'stop' }
    }
    if (reading.kind === 'skip') {
      outcome = 'skipped'
      progress.pending = skippedLine(item)
      return null
    }
    const written = await pressShown($, item, reading.form, windowMs, () => owns(me))
    if (written.kind === 'session') return sessionEnded()
    progress.pending = outcomeLine(item, written)
    if (written.kind === 'applied') progress.sent++
    outcome = written.kind === 'applied' ? 'written' : written.kind === 'changed' ? 'refused as changed' : 'left the list'
    return null
  } finally {
    $.ui.log(`human-plugin: walk ask #${item.id}: ${returnedText(returned, dialog.options)}; record ${state}; ${outcome}`, { to: 'debug' })
  }
}

// The walk's loop. Before each question the list is read again, and the first open item in the band's order that this walk has not asked about is asked: an item
// filed meanwhile is asked in its place, one removed is not, and none is asked twice. The first question opens with the summary, each later one with the outcome
// line of the item before it. Returns why the walk ended, or null when nothing was open to ask about.
async function askEach($: EngineInterface, windowMs: number, me: symbol, progress: Progress): Promise<Reason | null> {
  for (;;) {
    const { items } = await readList($)
    if (!owns(me)) return { kind: 'session' }
    const open = openOf(items)
    const rest = open.filter(it => !progress.asked.has(it.id))
    const item = rest[0]
    if (item === undefined) return progress.asked.size === 0 ? null : { kind: 'every' }
    const lead = progress.asked.size === 0 ? walkSummary(open) : progress.pending === null ? [] : [progress.pending]
    progress.asked.add(item.id)
    const dialog = walkDialog(item, progress.asked.size, progress.asked.size + rest.length - 1, lead)
    progress.pending = null
    await clearMark($, item)
    if (!owns(me)) return { kind: 'session' }
    const ended = await askOne($, windowMs, me, progress, item, dialog)
    if (ended !== null) return ended
  }
}

// A throw inside the walk, logged with its stack.
function logWalkError($: EngineInterface, err: unknown): void {
  $.ui.log(`human-plugin: the walk stopped on an error: ${messageOf(err)}`)
}

// `/todo answer`: the command's output. A walk already asking, or nothing open, ends it at once and asks nothing. Otherwise the walk asks about each open item
// and returns its end text: the outcome no question showed, why it ended, and what it sent and what is still open. A throw ends it with the error reason and the
// same counts, and the error is logged with its stack. So does a throw from the read of the list for those counts, which leaves the end text the count of what was
// sent alone, since what is still open is unknown. The answers already written stay written, whatever ends the walk.
export async function walk($: EngineInterface, windowMs: number): Promise<string> {
  if (walking !== null) return ALREADY_ASKING
  const me = Symbol('walk')
  walking = me
  setWalkAsking(true)
  try {
    const progress: Progress = { asked: new Set(), sent: 0, pending: null }
    let reason: Reason | null
    try {
      reason = await askEach($, windowMs, me, progress)
    } catch (err) {
      logWalkError($, err)
      reason = { kind: 'error' }
    }
    if (reason === null) return NOTHING_OPEN
    let open: number | null = null
    try {
      open = openOf((await readList($)).items).length
    } catch (err) {
      logWalkError($, err)
      reason = { kind: 'error' }
    }
    return walkEnd(progress.pending, reason, progress.sent, open)
  } finally {
    if (owns(me)) {
      walking = null
      setWalkAsking(false)
    }
  }
}
