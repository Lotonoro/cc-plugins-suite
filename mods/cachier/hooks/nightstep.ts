// The night step's store: two keys per session, each a plain time in ms, one key for the install, and the running state the tick, the pane and the prompt hook share. The step mark,
// `overnight/<session id>`, is written by the tick alone, once per step; the action time, `prompted/<session id>`, is written by the prompt hook and the turn-on core alone, and
// is the time of the user's last prompt or of the user turning keepalive on. A write never reads first, so no update is lost between two writers; the scan reads every
// session's action key for the idle check, and the clean-up deletes the keys two days old. The install's key, `notices`, records which of the two notices the user has been told
// (night.ts words them) and is written by nightNotice alone, outside the two families the clean-up scans. The rules that decide from these times are night.ts's; this module reads and
// writes them and holds the state, as pricesync.ts keeps its own: one object per load of the plugin, so a reload starts with none of it, taken by function declarations
// because the engine follows `$` past an import only into those.

import type { EngineInterface } from 'claude-code'
import { idOf } from './history'
import type { Scan } from './night'
import { report } from './pricesync'

type Dollar = EngineInterface

export const STEP_PREFIX = 'overnight/'
export const ACTION_PREFIX = 'prompted/'
export const NOTICES_KEY = 'notices'
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
  // The install's record of the notices written, as read and as spent in memory since: null until read, and an unread record writes nothing.
  notices: Notices | null
  // Whether a read of the record is running, and whether the last one failed and was reported: the tick reads again while it fails.
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

// Writes one time. A refusal is reported and the caller carries on: the time stays in memory, and is not written again.
async function writeTime($: Dollar, key: string, ms: number): Promise<void> {
  try {
    await $.store.set(key, ms)
  } catch (err) {
    report($, err)
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

// Reads the install's record while it is unread and no read is running. A refusal is reported once while it keeps failing and leaves the record unread, for the next call to read
// again. It never throws.
async function readNotices($: Dollar, state: NightState): Promise<void> {
  if (state.notices !== null || state.noticesReading) return
  state.noticesReading = true
  try {
    state.notices = noticesOf(await $.store.get(NOTICES_KEY))
    state.noticesFailed = false
  } catch (err) {
    if (!state.noticesFailed) report($, err)
    state.noticesFailed = true
  } finally {
    state.noticesReading = false
  }
}

// Teaches the state the session's transcript. The first path, or one that names another session, starts the own times over and reads them; the same path again does nothing. The
// install's record is read once, with the first path. An action set before any path was known is written now, whether or not the read lands; a clean-up asked before any path was
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

// Records the step the tick took at `atMs`, in memory at once and then in the session's key, with no read first. It is called once the stop's commit has landed.
export async function nightStepped($: Dollar, state: NightState, atMs: number): Promise<void> {
  state.stepMs = atMs
  if (state.id !== null) await writeTime($, STEP_PREFIX + state.id, atMs)
}

// Spends a notice for the install and says whether its line may be written now. The record is marked in memory first, then written whole, and the answer is yes only once that
// write has landed: a refusal is reported and says no, and the notice stays spent for this load, so the line comes late (a later load reads the record unspent) and never twice.
// An unread record and a notice already spent say no. There is no read before the write and no version check: two sessions meeting the same notice at once may both write it.
export async function nightNotice($: Dollar, state: NightState, which: Notice): Promise<boolean> {
  if (state.notices === null || state.notices[which]) return false
  state.notices = { ...state.notices, [which]: true }
  try {
    await $.store.set(NOTICES_KEY, state.notices)
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
