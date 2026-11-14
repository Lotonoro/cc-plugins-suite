// The night step's store: two keys per session, each a plain time in ms, one key for the install, and the running state the tick, the pane and the prompt hook share. The step mark,
// `overnight/<session id>`, is written by the tick alone, once per step; the action time, `prompted/<session id>`, is written by the prompt hook and the turn-on core alone, and
// is the time of the user's last prompt or of the user turning keepalive on. A write of a time never reads first, so no update is lost between two writers; the scan reads every
// session's action key for the idle check, and the clean-up deletes the keys two days old. The install's key, `notices-v2`, records which of the two notices the user has been told
// (night.ts words them) and is written by nightNotice alone, from a fresh read of the record, outside the two families the clean-up scans. The compaction the step also asks of the engine,
// and its outcome as the step's debug line states it, are here too (nightCompact). The rules that decide from these times are night.ts's; this module reads and writes them and holds the
// state, as pricesync.ts keeps its own: one object per load of the plugin, so a reload starts with none of it, taken by function declarations because the engine follows `$` past an
// import only into those.

import type { EngineInterface } from 'claude-code'
import { idOf } from './history'
import type { Scan } from './night'
import { report } from './pricesync'

type Dollar = EngineInterface

export const STEP_PREFIX = 'overnight/'
export const ACTION_PREFIX = 'prompted/'
// The first build of the two notices wrote its record under `notices`. The notices are reworded, so an install that read them is to read the new ones once: the record is a new key, and the old
// one is neither read nor deleted.
export const NOTICES_KEY = 'notices-v2'
// A key older than this, in either family, is deleted.
const OLD_MS = 2 * 24 * 60 * 60 * 1000

// The two notices the user is told once, each when it is first meant: the window, the first time the step can act for them, and the step, the first time it acts.
export type Notice = 'window' | 'step'
export type Notices = Record<Notice, boolean>

export type NightState = {
  // The session's id once its path is learned, null before.
  id: string | null
  // Whether this session's own two keys have been read, and their times as read or set: the step the session took and its user's last action.
  read: boolean
  stepMs: number | null
  actionMs: number | null
  // The scan of every session's action times as the tick last made it.
  scan: Scan
  // Bumped by each new id; a read lands only while it is still the latest.
  generation: number
  // The generation whose read of the own keys is running, null when none is.
  reading: number | null
  // The id whose failed read was reported, so a retry that fails again is not reported again.
  failedId: string | null
  // Whether the last scan failed, and that was reported.
  scanReported: boolean
  // Whether an action set before any path was known waits to be written.
  unwritten: boolean
  // The clean-up asked before any path was known, as it was asked, for the learn to run.
  cleaning: { keys: readonly string[]; nowMs: number } | null
  // The install's record of the notices written, as read when the path was learned and as spent in memory since: null until read, and an unread record writes nothing. A notice
  // spent here asks the store nothing; one not spent here is read fresh before it is written.
  notices: Notices | null
  // Whether the learn's read of the record is running, and whether the last read of it, the learn's or one before a write, failed and was reported: the tick reads the learn's again
  // while it is unread and this is set.
  noticesReading: boolean
  noticesFailed: boolean
}

export const nightState = (): NightState => ({
  id: null,
  read: false,
  stepMs: null,
  actionMs: null,
  scan: { kind: 'none' },
  generation: 0,
  reading: null,
  failedId: null,
  scanReported: false,
  unwritten: false,
  cleaning: null,
  notices: null,
  noticesReading: false,
  noticesFailed: false,
})

// A stored value as a time: a number at or before `nowMs`. Any other shape, and a time later than now (a clock that moved back), is no time.
const timeOf = (value: unknown, nowMs: number): number | null => (typeof value === 'number' && Number.isFinite(value) && value <= nowMs ? value : null)

const latest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b))

// Writes one time and says whether it landed. A refusal is reported and the caller carries on: the time stays in memory, and is not written again.
async function writeTime($: Dollar, key: string, ms: number): Promise<boolean> {
  try {
    await $.store.set(key, ms)
    return true
  } catch (err) {
    report($, err)
    return false
  }
}

// Reads the own keys of the id held now, the step mark first, and lands both together: a time held in memory meanwhile is not lowered by an older stored one. It never throws.
// A refusal is reported once while it keeps failing for the id, and leaves the state unread, for the next call to read again. A result for an id that has since moved on lands
// nowhere.
async function readOwn($: Dollar, state: NightState): Promise<void> {
  const { id, generation } = state
  if (id === null) return
  state.reading = generation
  try {
    const stepValue = await $.store.get(STEP_PREFIX + id)
    const actionValue = await $.store.get(ACTION_PREFIX + id)
    const nowMs = await $.clock.now()
    if (state.generation !== generation) return
    state.stepMs = latest(state.stepMs, timeOf(stepValue, nowMs))
    state.actionMs = latest(state.actionMs, timeOf(actionValue, nowMs))
    state.read = true
    state.failedId = null
  } catch (err) {
    if (state.failedId !== id) report($, err)
    if (state.generation === generation) state.failedId = id
  } finally {
    if (state.reading === generation) state.reading = null
  }
}

// A stored record as the notices told: a field is told only when it is exactly true, and a value of another shape tells nothing.
const noticesOf = (value: unknown): Notices => {
  const held = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return { window: held.window === true, step: held.step === true }
}

// Reads the install's record as the store holds it now, null when the read is refused. A refusal is reported once while reads keep failing. It never throws.
async function readRecord($: Dollar, state: NightState): Promise<Notices | null> {
  try {
    const record = noticesOf(await $.store.get(NOTICES_KEY))
    state.noticesFailed = false
    return record
  } catch (err) {
    if (!state.noticesFailed) report($, err)
    state.noticesFailed = true
    return null
  }
}

// Reads the record into the state while it is unread and no read is running. A refusal leaves it unread, for the next call to read again. It never throws.
async function readNotices($: Dollar, state: NightState): Promise<void> {
  if (state.notices !== null || state.noticesReading) return
  state.noticesReading = true
  try {
    state.notices = await readRecord($, state)
  } finally {
    state.noticesReading = false
  }
}

// Teaches the state the session's transcript. The first path, or one that names another session, starts the own times over and reads them; the same path again does nothing. The
// install's record is read into the state once, with the first path (a notice's ask reads it fresh again before it writes). An action set before any path was known is written now, whether or not the read lands; a clean-up asked before any path was
// known runs once the own keys and the record are read.
export async function nightLearn($: Dollar, state: NightState, path: string): Promise<void> {
  const id = idOf(path)
  if (state.id === id) return
  state.id = id
  state.generation++
  state.read = false
  state.stepMs = null
  const cleaning = state.cleaning
  state.cleaning = null
  if (state.unwritten && state.actionMs !== null) {
    state.unwritten = false
    await writeTime($, ACTION_PREFIX + id, state.actionMs)
  } else {
    state.actionMs = null
  }
  await readOwn($, state)
  await readNotices($, state)
  if (cleaning !== null) await nightClean($, state, cleaning.keys, cleaning.nowMs)
}

// Reads the own keys again while the read has not landed and none is running, as the session's pause read is: a failed read does not leave the step undecided for the rest of the
// session. The install's record is read again the same way, once a read of it has failed.
export async function nightRead($: Dollar, state: NightState): Promise<void> {
  if (state.id === null) return
  if (!state.read && state.reading !== state.generation) await readOwn($, state)
  if (state.noticesFailed) await readNotices($, state)
}

// Records the user's action at `atMs`: in memory at once, before anything else is awaited, so no tick can decide on the time before it; then in the session's key, with no read
// first. Before any path is known the time is held and written once the path is learned.
export async function nightAction($: Dollar, state: NightState, atMs: number): Promise<void> {
  state.actionMs = atMs
  if (state.id === null) {
    state.unwritten = true
    return
  }
  await writeTime($, ACTION_PREFIX + state.id, atMs)
}

// Records the step the tick took at `atMs`, in memory at once and then in the session's key, with no read first, and says whether the mark landed in the store: it does not before
// the session's path is known, nor when the write is refused. It is called once the stop's commit has landed.
export async function nightStepped($: Dollar, state: NightState, atMs: number): Promise<boolean> {
  state.stepMs = atMs
  return state.id !== null && (await writeTime($, STEP_PREFIX + state.id, atMs))
}

// What a compaction came to, as the step's debug line states it. Nothing of the conversation is here, which the engine's result holds: only the counts it states and its own words. The keys
// avoid the word token, whose numbers the engine's debug sink redacts.
export type Compaction =
  | { kind: 'stood'; size_before: number | null; size_after: number | null; summarizer: { in: number; out: number; cache_read: number; cache_write: number } | null }
  | { kind: 'skipped'; reason: string }
  | { kind: 'refused'; error: string }
  | { kind: 'thrown'; error: string }

// A count the engine states: a finite number that is not negative. Any other shape is none.
const countOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

// The usage of the summarizer's request, whole or not at all: a part of it would state a request the engine did not make.
const usageOf = (value: unknown): Extract<Compaction, { kind: 'stood' }>['summarizer'] => {
  const held = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const input = countOf(held.input_tokens)
  const output = countOf(held.output_tokens)
  const cacheRead = countOf(held.cache_read_input_tokens)
  const cacheWrite = countOf(held.cache_creation_input_tokens)
  return input === null || output === null || cacheRead === null || cacheWrite === null ? null : { in: input, out: output, cache_read: cacheRead, cache_write: cacheWrite }
}

// The engine's answer to a compaction as the debug line states it. The answer is read for the shapes the engine declares (a skip with its reason, or the compacted conversation) and for nothing
// else, so that no word of the conversation can pass: the result is built from the counts named here and never spreads the answer. Any other answer is thrown.
const outcomeOf = (answer: unknown): Compaction => {
  const held = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
  if (typeof held.skip === 'string') return { kind: 'skipped', reason: held.skip }
  if (!Array.isArray(held.messages)) return { kind: 'thrown', error: 'the engine answered a compaction with neither a conversation nor a skip' }
  return { kind: 'stood', size_before: countOf(held.tokensBefore), size_after: countOf(held.tokensAfter), summarizer: usageOf(held.usage) }
}

const textOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// Compacts the conversation through the engine, once, with no instructions of the mod's own, and says what came of it. The engine rejects the call while a turn runs, which is refused, and
// answers a skip when another plugin vetoed it; a call that throws instead of returning (an engine without the call, for one) is thrown, and so is an answer of neither shape. The call has
// no timeout of the mod's own: the engine owns the request. It never throws.
export async function nightCompact($: Dollar): Promise<Compaction> {
  let pending: Promise<unknown>
  try {
    pending = $.session.compact()
  } catch (err) {
    return { kind: 'thrown', error: textOf(err) }
  }
  try {
    return outcomeOf(await pending)
  } catch (err) {
    return { kind: 'refused', error: textOf(err) }
  }
}

const unspent = (notices: Notices | null, which: Notice): notices is Notices => notices !== null && !notices[which]

// Whether asking for a notice goes to the store: the record was read, and the notice is not spent in this load. Any other ask answers no at once, touching nothing.
export const noticeOpen = (state: NightState, which: Notice): boolean => unspent(state.notices, which)

// Spends a notice for the install and says whether its line may be written now. The notice is marked spent in memory first, so that no second ask of this load reaches the store
// meanwhile; the record is then read fresh and written whole as that read found it with this one notice added, so a flag another session has spent since this load read the record
// is kept, and a notice that session spent is not written again. The answer is yes only when the fresh record showed the notice unspent and the write has landed. A refused read
// writes nothing, is reported once while reads keep failing and gives the notice back, for the next ask to try again. A refused write is reported and says no, and the notice stays
// spent for this load, so the line comes late (a later load reads the record unspent) and never twice. An unread record and a notice already spent say no. The engine's store has no
// version check: two sessions meeting the same notice in the same moment, between one's read and its write, may both write it.
export async function nightNotice($: Dollar, state: NightState, which: Notice): Promise<boolean> {
  const held = state.notices
  if (!unspent(held, which)) return false
  state.notices = { ...held, [which]: true }
  const fresh = await readRecord($, state)
  if (fresh === null) {
    state.notices = { ...state.notices, [which]: false }
    return false
  }
  if (fresh[which]) return false
  try {
    await $.store.set(NOTICES_KEY, { ...fresh, [which]: true })
  } catch (err) {
    report($, err)
    return false
  }
  return true
}

// Scans every session's action key for the newest action, one key after another, and records the outcome and the time it was made. A refused list or read is a failed
// scan with no time taken from the keys before it, reported once while scans keep failing; the next call scans again. It never throws.
export async function nightScan($: Dollar, state: NightState, nowMs: number): Promise<void> {
  try {
    const keys = (await $.store.keys()).filter((key) => key.startsWith(ACTION_PREFIX))
    let newestMs: number | null = null
    for (const key of keys) newestMs = latest(newestMs, timeOf(await $.store.get(key), nowMs))
    state.scan = { kind: 'done', atMs: nowMs, newestMs }
    state.scanReported = false
  } catch (err) {
    state.scan = { kind: 'failed' }
    if (!state.scanReported) report($, err)
    state.scanReported = true
  }
}

// Deletes the keys of the two families whose value is older than two days or not a time, this session's own excepted; a key of any other family is neither read nor
// deleted, and a time later than now is kept, since a clock set back must not cost another session its times. Each key is read once and tried on its own: the first refusal
// is reported, once, and a key left is cleaned by the next load. `keys` is the list the caller read. The session's own keys are known by its id: before any path is known nothing is
// deleted, and the list asked last waits for the learn, which cleans it.
export async function nightClean($: Dollar, state: NightState, keys: readonly string[], nowMs: number): Promise<void> {
  if (state.id === null) {
    state.cleaning = { keys, nowMs }
    return
  }
  const own = [STEP_PREFIX + state.id, ACTION_PREFIX + state.id]
  let refusal: { err: unknown } | undefined
  for (const key of keys) {
    if (!(key.startsWith(STEP_PREFIX) || key.startsWith(ACTION_PREFIX)) || own.includes(key)) continue
    try {
      const value = await $.store.get(key)
      if (typeof value === 'number' && Number.isFinite(value) && nowMs - value <= OLD_MS) continue
      await $.store.delete(key)
    } catch (err) {
      refusal ??= { err }
    }
  }
  if (refusal !== undefined) report($, refusal.err)
}
