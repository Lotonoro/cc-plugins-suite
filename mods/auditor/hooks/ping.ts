import type { CoreEngineInterface } from 'claude-code'
import type { Conversation, TodoEntry } from '../types/index'
import { PLUGIN, within } from './boundary'
import { committedNudge } from './notes'
import { clip, promptEntry, withEntry } from './record'

// The ping: at the main agent's Stop, with entries still open on its own TODO list and nothing in flight to wake it, the Stop's result carries a short text asking it to carry on, to mark the entries done, or to say what it waits on. This module is the decision and its write, over plain values: what the Stop and the hooks beneath it said, and what human-plugin's state holds. The Stop hook in register.ts reads the stall fact and runs the one state change the write goes into. The state reads take `$` as an argument and are function declarations, since a hooks module's `$` is followed past an import only into one.

// human-plugin owns the agent's TODO list and the human list and is the only plugin that writes them. The references are literal here, where the engine's scan of the state calls reads them.
const TODO = { plugin: 'human-plugin', key: 'todo' } as const
const LIST = { plugin: 'human-plugin', key: 'list' } as const

// How many entries the text names, and the longest title it shows whole: the limit the owner's own tool holds a title to when it is written, applied again since a stored title is read as it stands.
const NAMED = 5
const TITLE_CHARS = 80

// The two values of human-plugin's state as the owner stored them: not trusted, since the owner may move its format, and undefined where it never wrote one.
export type Lists = { todo: unknown; list: unknown }

// Both lists in one wait, since the Stop's review waits behind them. Each read is bounded (`within`), and one that threw or did not answer is recorded under its own name; the lists are then undefined, and the ping is withheld.
export async function readLists($: Pick<CoreEngineInterface, 'state' | 'clock' | 'ui'>): Promise<Lists | undefined> {
  const [todo, list] = await Promise.all([
    within($, 'read of human-plugin\'s "todo" state', () => $.state.get(TODO)),
    within($, 'read of human-plugin\'s "list" state', () => $.state.get(LIST)),
  ])
  return todo === undefined || list === undefined ? undefined : { todo: todo.value.value, list: list.value.value }
}

// A TODO entry as its owner reads one: a title that is text and a state of queued or in flight. Any other is skipped.
const entryOf = (raw: unknown): TodoEntry | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { title, state } = raw as Record<string, unknown>
  return typeof title === 'string' && (state === 'queued' || state === 'in_flight') ? { title, state } : undefined
}

// The readable entries of the TODO list. A list never written (null) or emptied has none; a value that is no list, or a list whose entries none is readable, is of a shape this does not know (undefined).
const entriesOf = (raw: unknown): TodoEntry[] | undefined => {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return undefined
  const entries = raw.flatMap(entry => entryOf(entry) ?? [])
  return raw.length > 0 && entries.length === 0 ? undefined : entries
}

// Whether a stored item may be one the agent's work waits on the user for: marked blocking, and not one its owner reads as done. The owner reads `done-pending` as done, and `done-waiting` as done only while its press time is a finite number (an undo window with no press time cannot end, so it reads as open); any other state, a missing or an unknown one included, is open. Fails toward withholding the ping, as an item the owner would drop for lacking an id or a title still counts.
const mayBlock = (item: Record<string, unknown>): boolean => {
  if (item['blocking'] !== true) return false
  const { state, pressedAt } = item
  return !(state === 'done-pending' || (state === 'done-waiting' && typeof pressedAt === 'number' && Number.isFinite(pressedAt)))
}

// How an item is named in the debug line: by the owner's number, `#3`.
const named = (id: unknown): string => (typeof id === 'number' ? `#${id}` : '(no id)')

// The stored items that may be open and blocking, named, in the order stored. A list never written is the empty store, as its owner reads it; a value that is not a store holding a list of items is of a shape this does not know (undefined); a stored entry that is not an object is no item.
const blockingOf = (raw: unknown): string[] | undefined => {
  if (raw === undefined || raw === null) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { items } = raw as { items?: unknown }
  if (!Array.isArray(items)) return undefined
  return items.flatMap(item => (typeof item === 'object' && item !== null && mayBlock(item as Record<string, unknown>) ? [named((item as Record<string, unknown>)['id'])] : []))
}

// What the two lists say: the entries the ping names, none where it is withheld, and the debug lines that say why for the reasons that are not the ordinary ones: a value of a shape not known (naming its key), and an item that may be an open blocking one (naming it).
export type Reading = { entries: TodoEntry[]; lines: string[] }

const unknownShape = (key: string): string => `${PLUGIN}: no ping: human-plugin's "${key}" holds a value of a shape the ping does not know`

export const readingOf = ({ todo, list }: Lists): Reading => {
  const entries = entriesOf(todo)
  const blocking = blockingOf(list)
  const lines = [
    ...(entries === undefined ? [unknownShape('todo')] : []),
    ...(blocking === undefined ? [unknownShape('list')] : blocking.length > 0 ? [`${PLUGIN}: no ping: human-plugin's human list holds an item that may be an open blocking one: ${blocking.join(', ')}`] : []),
  ]
  return { entries: lines.length > 0 ? [] : (entries ?? []), lines }
}

// The ping's text: one paragraph that says who asks and the fact, names up to NAMED of the open entries, those in flight first, and asks for one of three ways out. It names the entries since the list lives in human-plugin's state and the agent may no longer hold their titles, it does not accuse, and it leaves "stalled" to the reviewer, so the two read apart in the record.
export const pingText = (entries: readonly TodoEntry[]): string => {
  const open = [...entries.filter(entry => entry.state === 'in_flight'), ...entries.filter(entry => entry.state === 'queued')]
  const shown = open.slice(0, NAMED).map(entry => `"${clip(entry.title, TITLE_CHARS)}" (${entry.state})`)
  const rest = open.length - shown.length
  const count = open.length === 1 ? '1 open entry' : `${open.length} open entries`
  return `${PLUGIN}: you stopped with ${count} on your TODO list, and no background task or scheduled wake-up is in flight to wake you: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}. If the work is not done, carry on. If it is done, mark the entries done. If you are waiting on something, say in one line what.`
}

// The hooks beneath's answer for the Stop, as far as the ping reads it.
export type Beneath = { block?: string; preventContinuation?: true; additionalContext?: string[] }

// A Stop when the ping is decided and again when its write lands. `active`: it follows a continuation (`stop_hook_active`). `beneath`: what the hooks beneath answered, undefined where they did not. `nothingWakes`: the stall fact says nothing will wake the worker. `started`: the user's own prompts counted when the Stop began, undefined where the count could not be read.
export type Stopped = { active: boolean; beneath: Beneath | undefined; nothingWakes: boolean; started: number | undefined }

// Whether the Stop may ping, on the conversation as it stands: everything the ping rests on but the two lists. The auditor is on; the Stop follows no continuation; the hooks beneath answered, neither blocking nor stopping the session (entries they gave are no obstacle); nothing will wake the worker; the user's own prompt has not arrived since the Stop began; and no nudge has gone out this prompt, or is committed to (`committedNudge`).
export const mayPing = (c: Conversation, s: Stopped): boolean =>
  !c.off && !s.active && s.beneath !== undefined && s.beneath.block === undefined && s.beneath.preventContinuation === undefined && s.nothingWakes && c.prompts === s.started && !committedNudge(c)

// A decided ping: its text, the epoch it was decided under, and the Stop it rests on.
export type Ping = { text: string; epoch: number; stopped: Stopped }

// The ping's write, one transition over the conversation the change lands on. It checks again that the epoch is the one the decision was made under and that the Stop may still ping, and where either fails changes nothing and says so, so a ping and a stall note admitted at the same moment cannot both go out. A ping sets the stall guard (the prompt's one nudge) and leaves no wake line; in a turn a reviewer's task notification started it makes the turn a recorded one, its start `other`, which records and still dispatches nothing after a failed review; and it adds its text to the record as a plugin's prompt, so the reviewer reads the worker's reply as an answer to it.
export const withPing = (c: Conversation, ping: Ping): { next: Conversation; pinged: boolean } => {
  if (c.epoch !== ping.epoch || !mayPing(c, ping.stopped)) return { next: c, pinged: false }
  const recorded = c.turnStart === 'notice' ? { ...c, turnStart: 'other' as const } : c
  return { next: withEntry({ ...recorded, nudged: true, wake: null }, promptEntry('plugin', ping.text)), pinged: true }
}

// The result from beneath with the ping's text as its last context entry, every other field as it was.
export const withText = <R extends Beneath>(beneath: R, text: string): R => ({ ...beneath, additionalContext: [...(beneath.additionalContext ?? []), text] })
