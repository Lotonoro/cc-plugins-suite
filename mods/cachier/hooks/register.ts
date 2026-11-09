import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { ModelForkResult, ModelUsage } from 'claude-code'
import type { CacheView, ColdMark, HintCost, HintState, Judged, KeepaliveState, PriceCue, Spend, StatsState, TallyState, Unit } from '../types'
import { expiredAt, expiryOf, pieOf, readingOf, rebuildDrawnOf, settleCold, touchedAt, warmthOf } from './countdown'
import {
  coldBegun,
  coldLanded,
  costOf,
  countPing,
  defaultsOf,
  type Defaults,
  enable,
  enabledStop,
  enableText,
  failureOf,
  forkSpend,
  gapOpen,
  INITIAL,
  INITIAL_TALLY,
  isUserPrompt,
  lapsedReason,
  off,
  parseRequest,
  pingLine,
  pressOf,
  promptDropped,
  promptSubmitted,
  pastHalfTtl,
  pastHalfTtlStop,
  raisedLeadOf,
  rearm,
  outcomeOf,
  refused,
  restored,
  retriedOf,
  reset,
  restartPause,
  step,
  stopFor,
  turnBegun,
  turnEnded,
  modeOf,
  keptCount,
  usageOf,
  recount,
  offerOf,
  pressOfferOf,
  type Figure,
  type Mode,
  type Pair,
  type Retry,
} from './keepalive'
import { singleFlight } from './guard'
import { footerLine, paneOf } from './hint'
import { followDraw, isPaneOpen, lastRows, paneAlarm, PANE, pressSize, readPane, recordRows, recordSize, syncPane, togglePane } from './pane'
import { appended, HISTORY_BOUND, keyOf, KEY_PREFIX, merged, recordOf, recordsOf, staleKeys, type PauseRecord } from './history'
import { adviceOf, ratesOfView, ttlLineOf, type Inputs } from './advice'
import { learnedLine, learnedOf, ttlSwitchOf, type Learned } from './learn'
import { breakEvenLine, countLineOf, judge, KEPT_COUNT, ratioOf, rebuildSpendOf, runCountOf, sessionBalanceLine, NO_JUDGED, pauseOf, type Pause } from './verdict'
import { answerOf, paneLayoutOf, type PaneRow, type PaneSize, type Setting, type Snapshot } from './sections'
import { stampLabel, withStamp } from './stamp'
import { foldStatsEvents, INITIAL_STATS, pendingFor, rundownSections, sessionLineOf, type MissEvent, type LongPauseEvent } from './stats'
import { lookupRows, readCache, type History, type Host, type Row } from './transcript'
import { NO_KINDS, spendOf, TTL_WORDS, unitOf, uponOf, writeReadRatio, type Money } from './prices'
import { priceCheck, priceList, priceReady, priceSink, priceSync, report, type PriceEvent } from './pricesync'

type Dollar = EngineInterface

const TICK_MS = 1000
const READ_TIMEOUT_MS = 10000
// How long a landed or failed read's cue stays on the footer.
const CUE_MS = 3000
const NO_CACHE: CacheView = { kind: 'no-cache' }
// The plugin's name: its state's owner, and the first part of its options' /config keys.
const PLUGIN = 'cachier'
const TRANSCRIPT = { plugin: 'cachier', key: 'transcript' } as const
const VIEW = { plugin: 'cachier', key: 'view' } as const
const COLD = { plugin: 'cachier', key: 'cold' } as const
// The footer line's state, written when it changes; the footer draws from it, so a write redraws it alone.
const HINT = { plugin: 'cachier', key: 'hint' } as const
// The last cache touch: the start of the newest main-thread request the mod saw (its turn.step), or of a keepalive
// ping that read the cache.
const TOUCH = { plugin: 'cachier', key: 'touch' } as const
const STATS = { plugin: 'cachier', key: 'stats' } as const
const KEEPALIVE = { plugin: 'cachier', key: 'keepalive' } as const
// What the forks cost this pause and this session, and the lead a slow ping raised.
const TALLY = { plugin: 'cachier', key: 'tally' } as const
const JUDGED = { plugin: 'cachier', key: 'judged' } as const
// The price read's phase for the footer's cue: written by the read's sink, cleared a few seconds after it ends.
const CUE = { plugin: 'cachier', key: 'cue' } as const
const SHAPE = { plugin: 'cachier', key: 'shape' } as const
// The unit costs are shown in.
const UNIT = { plugin: 'cachier', key: 'unit' } as const
// Attempts at one keepalive state write before it is given up, when other hooks keep beating it to the version.
const WRITE_ATTEMPTS = 5
const PING_PROMPT = 'ok'
const COMMAND = 'keepalive'

// Stamps, for the transcript they were read from. A row's raw time is kept; its label is worked out at draw time, so
// a stamp is right after midnight. Null: the row has no time.
let stampSession: string | null = null
// The plugin's default lead and count, as a click would set them: what the marker prices keepalive at while it has never run.
let defaultRun: Defaults | undefined
// The run keepalive is on, else the one a click on the pie would start: its last used, else the defaults.
const runOf = <D>(k: KeepaliveState, defaults: D) => k.config ?? k.lastUsed ?? defaults
// The unit a session starts in, from the plugin's option.
let defaultUnit: Unit = 'dollars'
// The mode a session starts in, from the plugin's option; `/keepalive default` sets the option.
let defaultMode: Mode = 'off'
// Every session's pauses, oldest first: the store's as the last load read them, and each pause a prompt ended since.
let history: PauseRecord[] = []
// Every pause this load's prompts ended, each with the key it is written under, oldest first, the newest HISTORY_BOUND. Kept for the whole load,
// so a pause the store does not hold (a read or write refused, or trimmed) still counts; a merge with the store's records dedupes it by identity. Replaced on
// every change, never changed in place.
type AppendedPause = { key: string; record: PauseRecord }
let appendedPauses: readonly AppendedPause[] = []
// The appended pauses kept under `key`, oldest first.
const appendedUnder = (key: string | undefined): PauseRecord[] => appendedPauses.filter((u) => u.key === key).map((u) => u.record)
// Every key this load has kept a pause under, unbounded where the appended pauses are not: the keys deleteKeys leaves.
const appendedKeys = new Set<string>()
// The records the last landed read of one key returned.
let stored: { key: string; records: readonly PauseRecord[] } | undefined
// The key whose pauses are this session's: the learned transcript's, or before any learn, the one the last pause was kept under.
let sessionKey: string | undefined
const NO_PAUSES: readonly PauseRecord[] = []
let sessionMemo: Memo<PauseRecord[]> | null = null
// This session's pauses: the records its key's last read returned, and the appended ones under the key, the newest HISTORY_BOUND by start.
const sessionPauses = (): readonly PauseRecord[] => {
  const read = stored !== undefined && stored.key === sessionKey ? stored.records : NO_PAUSES
  sessionMemo = memoised(sessionMemo, [read, appendedPauses], sessionKey ?? '', () =>
    merged(read, appendedUnder(sessionKey))
      .sort((a, b) => a.startMs - b.startMs)
      .slice(-HISTORY_BOUND),
  )
  return sessionMemo.value
}
// The newest read of this session's key running. The running read is its own object, so an earlier read of the same path that ends after a
// later one began does not mark none running. `stored` is set only by a landed read of the held path and cleared by every learn, so while
// it is unset the held path is unread, and a tick reads again (sessionRetry).
let sessionReading: { path: string } | undefined
// The transcript whose key's read has failed and been reported since its last learn or landed read: the tick's retries of it are not
// reported again.
let sessionFailed: string | undefined
// Whether the tick's last read of the engine's record of the pane failed and was reported: the ticks that fail after it are not reported
// again, and a tick read that returns a record ends the run.
let paneTickFailed = false
// Whether the pane's last draw failed a state read: a run of failed draws is reported once.
let paneDrawFailed = false
// A value memoised on the arrays it read and a key of its other inputs. `history`, the appended pauses and each read's records are replaced
// on every change, never changed in place, so the arrays themselves say whether the pauses changed.
type Memo<T> = { pauses: readonly (readonly unknown[])[]; key: string; value: T }
const memoised = <T>(memo: Memo<T> | null, pauses: readonly (readonly unknown[])[], key: string, make: () => T): Memo<T> =>
  memo !== null && memo.key === key && memo.pauses.every((p, i) => p === pauses[i]) ? memo : { pauses, key, value: make() }
let learnedMemo: Memo<Learned | null> | null = null
// The TTL line, memoised on the history it prices and the inputs it words.
let ttlLineMemo: Memo<string> | null = null
// The best-setup sentence, memoised on the pauses and inputs it prices.
let sentenceMemo: Memo<string> | null = null
// This load's reset of the state an earlier load left, from session.start; unset until it starts.
let restoring: Promise<string | null> | undefined
const stampTimes = new Map<string, number | null>()
// Row ids drawn and not yet found, each with the transcript path it was drawn under. A path change drops the ids drawn
// under the old one.
const wanted = new Map<string, string>()
// Ids newly drawn since the last lookup pass.
const fresh = new Set<string>()
// Whether the transcript's size could not be read at the last tick: a failure is logged when it starts, and once more
// when it is readable again.
let unreadable = false
// The transcript size at the last lookup pass; a pass also runs when the transcript has changed size since.
let lastPassSize: number | undefined
// The transcript's size when the last read started. A tick that sees a larger file asks for a reread, so a reply written after the
// turn's last read is folded on the next tick. A read that failed after its stat leaves this at the size it saw, so it is not
// reread every tick; only growth asks again.
let sizeAtRead: number | undefined
// A reply stamp read ahead of the clock, and the time it was first read at: a reread before the clock catches up keeps that time as the
// touch, so the touch does not move later with each read.
let aheadStamp: { stampMs: number; readMs: number } | undefined
// The transcript path the mod last learned, and the learn in flight: a second hook waits for it.
let heldPath: string | undefined
let learning: Promise<void> = Promise.resolve()
// The clock at the last tick; stamp labels are worked out from it at draw time.
let lastNow: number | undefined
let timer: { cancel: () => void } | undefined
// Whether a reading is in flight, and whether a request came in while it ran and needs one more read after it.
let reading = false
let rereadWanted = false
// Whether a keepalive ping is claimed, from before its first await to its outcome; a tick that finds one claimed starts
// no second.
let pinging = false
// Set when a main-thread hook could not write its state: the gap then counts as closed until a main-thread write lands.
let gapBroken = false
// Set when a stats write failed, and cleared by the next stats write that lands. Stats are not on the cache path, so this
// alarm blocks nothing.
let statsBroken = false
// A countdown press that threw: the status line says so until a press completes.
let pressFailure: string | null = null
const PRESS_FAILED = 'the countdown press failed; see the debug log'
// One press at a time: a second press while one runs is dropped, so two presses cannot both turn keepalive on.
export const pressOnce = singleFlight()

// The reader's host reads, through the engine's `$` here and nowhere else in the reader.
const hostOf = ($: Dollar): Host => ({
  size: async (path) => (await $.fs.stat(path)).size,
  run: async (argv) => {
    const run = await $.process.run(argv, { timeoutMs: READ_TIMEOUT_MS })
    return { exitCode: run.exitCode, stdout: run.stdout, isStdoutTruncated: run.isStdoutTruncated }
  },
})

// This load's shared price record and page read. Re-created in register(), so a reload starts with none of it.
let sync = priceSync()

// Work a hook starts and does not wait for: a failure is reported, and the hook's own result is not held up by it.
const inBackground = ($: Dollar, work: Promise<unknown>) => {
  work.catch((err: unknown) => report($, err))
}

// The unit pressed this session, or the option's while none is: a value of another shape, from an earlier load, counts as
// none, so the unit is never written for want of a press.
const unitPressedNow = (held: unknown): held is Unit => held === 'dollars' || held === 'tokens'
export const unitFrom = (held: unknown, fallback: Unit = defaultUnit): Unit => (unitPressedNow(held) ? held : fallback)

const unitNow = async ($: Dollar): Promise<Unit> => unitFrom((await $.state.get(UNIT)).value)

// What figures are worded with now: the session's unit, the price list, and the model, speed and TTL of the cache a ping
// would read.
const moneyFrom = (held: unknown, view: CacheView): Money => {
  const known = view.kind === 'known' ? view : null
  return { unit: unitFrom(held), list: priceList(sync), model: known?.model ?? null, speed: known?.speed ?? null, ttl: known?.ttlLabel ?? '5m' }
}
const moneyOf = async ($: Dollar, view: CacheView): Promise<Money> => moneyFrom((await $.state.get(UNIT)).value, view)

// A cold mark lifts once the reading or a live request start is later than it.
const settleColdMark = async ($: Dollar) => {
  const held = await $.state.get(COLD)
  if (held.value === undefined || held.value === null) return
  const view = (await $.state.get(VIEW)).value ?? NO_CACHE
  const live = (await $.state.get(TOUCH)).value ?? null
  if (settleCold(held.value, view, live) === null) await $.state.set(COLD, null, { ifVersion: held.version })
}

// Reads the transcript and writes its reading. A path learned while the read ran makes the reading stale: it is not
// written, and the reread that learning queued reads the new path.
const readOnce = async ($: Dollar) => {
  const transcript = (await $.state.get(TRANSCRIPT)).value ?? null
  if (transcript === null) return
  let view: CacheView
  let read: History | null = null
  try {
    sizeAtRead = undefined
    if (await $.fs.exists(transcript)) {
      sizeAtRead = (await $.fs.stat(transcript)).size
      const cursor = ((await $.state.get(STATS)).value ?? INITIAL_STATS).cursor
      const result = await readCache(hostOf($), transcript, cursor)
      const readMs = await $.clock.now()
      const stampMs = result.view.kind === 'known' ? result.view.touchMs : null
      if (stampMs !== null && stampMs > readMs && aheadStamp?.stampMs !== stampMs) aheadStamp = { stampMs, readMs }
      view = touchedAt(result.view, aheadStamp?.stampMs === stampMs ? aheadStamp.readMs : readMs)
      read = result.history
    } else {
      view = NO_CACHE
    }
  } catch (err) {
    report($, err)
    view = { kind: 'unread' }
  }
  if ((await $.state.get(TRANSCRIPT)).value !== transcript) return
  await $.state.set(VIEW, view)
  const counted = read
  if (counted !== null) {
    // Each response is priced at the record in force when it is counted, so the fold waits for this session's first read of it.
    await priceReady(sync, $)
    let found: MissEvent[] = []
    let pauses: LongPauseEvent[] = []
    const wrote = await statsWrite($, (s) => {
      const out = foldStatsEvents(s, counted, priceList(sync))
      found = out.events
      pauses = out.pauses
      return out.state
    })
    if (wrote) for (const miss of found) debugLine($, 'cachier miss', miss)
    if (wrote) for (const pause of pauses) debugLine($, 'cachier pause', pause)
  }
  await settleColdMark($)
}

// The stats are one state record, written with the version it was read at, as the keepalive is. A failed write is reported and
// the next pass counts again from the state it left.
const editStats = async ($: Dollar, change: (s: StatsState) => StatsState): Promise<void> => {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const held = await $.state.get(STATS)
    const written = await $.state.set(STATS, change(held.value ?? INITIAL_STATS), { ifVersion: held.version })
    if (written.isSet) return
  }
  throw new Error('cachier: the stats changed on every write attempt; the change was not applied')
}
// Whether the change was written: a miss is logged only then, so a refused write is counted again, and logged, on the next pass.
const statsWrite = async ($: Dollar, change: (s: StatsState) => StatsState): Promise<boolean> => {
  try {
    await editStats($, change)
    statsBroken = false
    return true
  } catch (err) {
    report($, err)
    statsBroken = true
    return false
  }
}

// Reads the transcript, one read at a time. A request that comes in during a read is merged into one read after it.
// The flag is cleared in the same step the loop exits, so no request can fall between the loop and its end.
const readUntilSettled = async ($: Dollar) => {
  try {
    do {
      rereadWanted = false
      try {
        await readOnce($)
      } catch (err) {
        report($, err)
      }
    } while (rereadWanted)
  } finally {
    reading = false
  }
}

const refresh = ($: Dollar) => {
  if (reading) {
    rereadWanted = true
    return
  }
  reading = true
  inBackground($, readUntilSettled($))
}

// Forgets what was touched in the session that ended or was replaced: a live request start and a cold mark belong to
// their own transcript.
const forgetLive = async ($: Dollar) => {
  await $.state.set(TOUCH, null)
  await $.state.set(COLD, null)
}

// The path whose stats reset did not land. The next hook that carries it runs the reset alone, not the rest of the learn.
let resetPending: string | undefined

// Resets the stats for a path. A reset that does not land leaves the old counts under the path, so the path is marked pending
// unless another path was learned meanwhile; the next hook that carries it retries. The stats alarm stays up until a write lands.
const resetStats = async ($: Dollar, path: string): Promise<void> => {
  // The counts are of one transcript: a new path starts them again, and the marks the old counts held go with them. The write
  // is versioned, so the reset replaces the state it read, not a write that landed after it.
  const reset = await statsWrite($, (s) => (s.transcript === path ? s : { ...INITIAL_STATS, transcript: path }))
  if (reset) {
    if (resetPending === path) resetPending = undefined
  } else if (heldPath === path) {
    resetPending = path
  }
}

// Learns the transcript path a hook carries. Returns whether it is a new path. The decision is taken before the first
// await, so two hooks in the same moment cannot both see a new path; a hook that does not win waits for the learn.
export const learnTranscript = async ($: Dollar, path: string): Promise<boolean> => {
  if (heldPath === path && resetPending !== path) {
    await learning
    return false
  }
  if (heldPath === path) {
    learning = resetStats($, path)
    await learning
    return true
  }
  heldPath = path
  resetPending = undefined
  // This session's pauses are the appended ones under the path's key, pauses ended before any learn included, and the key's records once the
  // read below lands. The key is unread for this learn, even for a path read before: a tick reads it again should the read below fail.
  sessionKey = keyOf(path)
  stored = undefined
  // No state write covers the reset above, so an open pane is asked to draw again.
  if (isPaneOpen()) $.ui.invalidate('ui.render')
  sessionFailed = undefined
  // Not part of the learn: a hook waiting on the learn need not wait on this store read too.
  inBackground($, sessionLoad($, path))
  for (const [id, drawn] of wanted) {
    if (drawn !== path) {
      wanted.delete(id)
      fresh.delete(id)
    }
  }
  learning = (async () => {
    // A reload's module holds no path, so the transcript the state already names comes back here: its live touch and cold mark
    // are that transcript's own and stay. Only a different transcript forgets them.
    const named = (await $.state.get(TRANSCRIPT)).value ?? null
    if (named !== path) {
      await $.state.set(TRANSCRIPT, path)
      await forgetLive($)
    }
    await resetStats($, path)
  })()
  await learning
  return true
}

const learnPath = async ($: Dollar, path: string) => {
  if (await learnTranscript($, path)) refresh($)
}

// `adds` says, once pings are paused and before the mark is written, whether the mark's time joins the reset times the miss
// classifier reads. Compaction and /clear always add.
const setCold = async ($: Dollar, reason: ColdMark['reason'], adds: (atMs: number) => Promise<boolean> = async () => true) => {
  // Pings wait from the start of the mark until it lands, so no tick can read the cache as warm across the switch.
  await editKeepalive($, coldBegun)
  const atMs = await $.clock.now()
  const add = await adds(atMs)
  await $.state.set(COLD, { reason, atMs })
  if (add) await statsWrite($, (s) => ({ ...s, coldSince: [...s.coldSince, atMs] }))
  await editKeepalive($, coldLanded)
  await settleColdMark($)
}

// A cold mark from a hook the engine awaits. A failure is logged and fails closed, so no ping forks on a cache the mod could
// not mark cold; it never reaches the engine.
const markCold = async ($: Dollar, reason: ColdMark['reason'], adds?: (atMs: number) => Promise<boolean>): Promise<void> => {
  try {
    await setCold($, reason, adds)
  } catch (err) {
    report($, err)
    gapBroken = true
  }
}

// Whether a switch forfeits a cache cachier reads as warm now, the footer's own reading with the cache view and the standing mark
// as they stand. A reading that cannot be taken is not warm. The engine's flag and the reading go to the debug log to compare.
const switchForfeits = async ($: Dollar, engineWarm: boolean, nowMs: number): Promise<boolean> => {
  let state = 'unread'
  try {
    const view = (await $.state.get(VIEW)).value ?? NO_CACHE
    const live = (await $.state.get(TOUCH)).value ?? null
    const cold = (await $.state.get(COLD)).value ?? null
    state = readingOf(view, live, cold, nowMs, '')?.state ?? 'none'
  } catch (err) {
    report($, err)
  }
  debugLine($, 'cachier switch', { prompt_cache_warm: engineWarm, reading: state })
  return state === 'warm'
}

const liveTouch = async ($: Dollar) => {
  await $.state.set(TOUCH, await $.clock.now())
  await settleColdMark($)
}

const sessionStarted = async ($: Dollar, path: string, source: string) => {
  const changed = await learnTranscript($, path)
  if (source === 'clear') await setCold($, 'cleared')
  if (changed) refresh($)
}

// Writes keepalive's state from what it holds when the write lands, retrying a write another hook beat. A change that
// returns undefined writes nothing; the result says whether a write landed.
const editKeepalive = async ($: Dollar, change: (k: KeepaliveState) => KeepaliveState | undefined): Promise<boolean> => {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const held = await $.state.get(KEEPALIVE)
    const next = change(held.value ?? INITIAL)
    if (next === undefined) return false
    const written = await $.state.set(KEEPALIVE, next, { ifVersion: held.version })
    if (written.isSet) return true
  }
  throw new Error('cachier: keepalive state changed on every write attempt; the change was not applied')
}

// A keepalive write from a hook. A failure is logged with its stack and fails closed: no ping forks on a state the mod could
// not write. It never reaches the engine. Only a turn's first step (`landsMain`), when its write lands, clears a failure an
// earlier write left: that write closes the gap for the turn it starts. Returns whether the change is in place.
const hookWrite = async (
  $: Dollar,
  change: (k: KeepaliveState) => KeepaliveState | undefined,
  landsMain = false,
): Promise<boolean> => {
  try {
    const wrote = await editKeepalive($, change)
    if (wrote && landsMain) gapBroken = false
    return true
  } catch (err) {
    report($, err)
    gapBroken = true
    return false
  }
}

// The session's reset. Never throws: a failed write is logged and fails closed.
const resetKeepalive = async ($: Dollar): Promise<void> => {
  try {
    await editKeepalive($, reset)
    const epoch = ((await $.state.get(KEEPALIVE)).value ?? INITIAL).pauseEpoch
    await editTally($, () => ({ ...INITIAL_TALLY, epoch }))
    await $.state.set(JUDGED, NO_JUDGED)
  } catch (err) {
    report($, err)
    gapBroken = true
  }
}

// The shape of the values this code keeps in the session's state. Bump it with any change to a value's shape in
// types/index.d.ts: a reload under a new shape resets what the old one wrote, and one under the same shape keeps it.
export const STATE_SHAPE = 15

// The cue's writes, one after another, so a read's `started` never lands over its own end; and the timer that clears a cue that has ended.
let cueWrites: Promise<void> = Promise.resolve()
let cueTimer: { cancel: () => void } | undefined
// Set when a session ends and cleared when the next one starts, at session.start and at classic.SessionStart (which a /clear raises with no
// session.start): a read still in flight then reports to no cue, so its end never writes one or arms its timer after the session.
let sessionEnded = false

const setCue = async ($: Dollar, cue: PriceCue | null) => {
  try {
    await $.state.set(CUE, cue)
  } catch (err) {
    report($, err)
  }
}

// Turns the price read's events into the cue's phase: `⟳` while it runs, `✓` or `!` for CUE_MS after it ends. A new read replaces a standing cue.
// Registered as the session's one sink at session.start, so only the reading session shows a cue.
const cueEvent = ($: Dollar, event: PriceEvent) => {
  if (sessionEnded) return
  cueTimer?.cancel()
  cueTimer = undefined
  if (event !== 'started') {
    const clear = () => {
      cueWrites = cueWrites.then(() => setCue($, null))
    }
    cueTimer = $.clock.after(CUE_MS, clear)
  }
  const phase: PriceCue = event === 'started' ? 'reading' : event
  cueWrites = cueWrites.then(() => setCue($, phase))
}

// Registers this load's one sink, if it has none: the session start does, and so does the first hook of a mod installed mid-session.
const ensureSink = ($: Dollar) => {
  if (sync.sink === null) priceSink(sync, (event) => cueEvent($, event))
}

// Clears a cue still standing and its timer: at a reload and at a session's end, so a cue never outlives its read.
const clearCue = async ($: Dollar) => {
  cueTimer?.cancel()
  cueTimer = undefined
  await cueWrites
  await setCue($, null)
}

// A reload runs session.start again and keeps the session's state, which an earlier load wrote. Keepalive keeps what still fits, so a
// reload mid-turn keeps the gap shut and a toggle that was on stays on, and the transcript is kept while it is a path. The unit is left as
// pressed: its reader takes any other value for none. Under another shape, or none (a version before shapes were stamped), every other
// value starts over: the view is read again, the hint redrawn, the stats and tallies counted again, the live touch and cold mark dropped,
// and the session net, which only the prompts that ended pauses added to, starts from nothing. In a new session it writes the defaults over
// nothing. Returns the transcript, or null.
export const restoreState = async ($: Dollar): Promise<string | null> => {
  const keepalive = await $.state.get(KEEPALIVE)
  const k = restored(keepalive.value)
  await $.state.set(KEEPALIVE, k)
  if ((await $.state.get(SHAPE)).value !== STATE_SHAPE) {
    await $.state.set(TALLY, { ...INITIAL_TALLY, epoch: k.pauseEpoch })
    await $.state.set(STATS, INITIAL_STATS)
    await $.state.set(JUDGED, NO_JUDGED)
    await $.state.set(VIEW, NO_CACHE)
    await $.state.set(HINT, null)
    await $.state.set(TOUCH, null)
    await $.state.set(COLD, null)
    await $.state.set(SHAPE, STATE_SHAPE)
  }
  const path = (await $.state.get(TRANSCRIPT)).value
  return typeof path === 'string' ? path : null
}

// The debug log's lines: a fixed marker, then one JSON object. Without `--debug` or `--debug-file` they go nowhere.
const debugLine = ($: Dollar, marker: string, value: object) => $.ui.log(`${marker} ${JSON.stringify(value)}`, { to: 'debug' })

// Writes the tallies from what they hold when the write lands, the way keepalive's state is written.
const editTally = async ($: Dollar, change: (t: TallyState) => TallyState): Promise<void> => {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const held = await $.state.get(TALLY)
    const written = await $.state.set(TALLY, change(held.value ?? INITIAL_TALLY), { ifVersion: held.version })
    if (written.isSet) return
  }
  throw new Error('cachier: the ping tallies changed on every write attempt; the change was not applied')
}

// A tally that cannot be written is logged with its stack. The tallies count for the details pane and the bare command; no ping waits on
// them.
const tallyWrite = async ($: Dollar, change: (t: TallyState) => TallyState) => {
  try {
    await editTally($, change)
  } catch (err) {
    report($, err)
  }
}

// The cache as keepalive counts it: a cold cache has no live entry to count from until a request touches it again.
const effectiveOf = (view: CacheView, cold: ColdMark | null): CacheView => cold === null ? view : NO_CACHE
const effectiveView = async ($: Dollar): Promise<CacheView> => {
  const view = (await $.state.get(VIEW)).value ?? NO_CACHE
  const cold = (await $.state.get(COLD)).value ?? null
  return effectiveOf(view, cold)
}

// A fork's end, as a ping sees it: a reply, a throw, or the TTL lapsing before any reply.
type Ended = { kind: 'reply'; reply: ModelForkResult } | { kind: 'threw'; err: unknown } | { kind: 'lapsed' }

type Ping = {
  fork: Promise<ModelForkResult>
  // The cache the ping was sent on: its model, speed and TTL price the fork's usage.
  view: Extract<CacheView, { kind: 'known' }>
  generation: number
  seq: number
  decidedMs: number
  leadMs: number
  ttlMs: number
  pauseEpoch: number
}

// What a fork's end says: its outcome, and the usage it reported.
const endOf = ($: Dollar, p: Ping, ended: Ended): { outcome: string; usage: ModelUsage | null; stop: string | null } => {
  switch (ended.kind) {
    case 'reply': {
      const usage = usageOf(ended.reply)
      return { outcome: outcomeOf(ended.reply), usage, stop: stopFor(ended.reply) }
    }
    case 'threw': {
      report($, ended.err)
      const outcome = 'the refresh threw; see the debug log'
      return { outcome, usage: null, stop: outcome }
    }
    case 'lapsed': {
      const outcome = lapsedReason(p.ttlMs)
      return { outcome, usage: null, stop: outcome }
    }
  }
}

// A ping's end. The state changes only while its generation is current, and never for a `late` reply, which came after the TTL
// lapsed and so changes nothing. A reply slower than half the lead raises the lead to twice its round trip, unless that lead
// would exceed half the TTL: then keepalive stops. A rate-limited refusal is decided by `refused` instead: it raises no lead, and
// stops keepalive only when no retry fits. Every fork is logged and counted, stale ones included.
const applyPing = async ($: Dollar, p: Ping, ended: Ended, late: boolean): Promise<void> => {
  const { outcome, usage, stop: outcomeStop } = endOf($, p, ended)
  const nowMs = await $.clock.now()
  const roundTripMs = nowMs - p.decidedMs
  // The expiry the state reads now, before the guarded change: that change is synchronous, so it cannot read the state itself.
  const retried = ended.kind === 'reply' && retriedOf(ended.reply)
  const expiryMs = retried ? expiryOf(p.view, (await $.state.get(TOUCH)).value ?? null) : null
  let decided: { raisedMs: number | null; fromMs: number; retry: Retry | null } = { raisedMs: null, fromMs: p.leadMs, retry: null }
  const servedFromCache = outcomeStop === null
  const applied = late
    ? false
    : await editKeepalive($, (cur) => {
        if (cur.generation !== p.generation || cur.config === null) return undefined
        if (retried) {
          const refusal = refused(cur, cur.config.leadMs, outcome, nowMs, expiryMs, TICK_MS)
          decided = { raisedMs: null, fromMs: cur.config.leadMs, retry: refusal.retry }
          return refusal.state
        }
        const raised = raisedLeadOf(cur.config.leadMs, roundTripMs)
        const isRaise = raised > cur.config.leadMs
        const past = isRaise && pastHalfTtl(raised, p.ttlMs)
        const raisedMs = isRaise && !past ? raised : null
        const stop = outcomeStop ?? (past ? pastHalfTtlStop(roundTripMs, raised, p.ttlMs) : null)
        decided = { raisedMs, fromMs: cur.config.leadMs, retry: null }
        return {
          ...cur,
          config: raisedMs === null ? cur.config : { ...cur.config, leadMs: raisedMs },
          lastUsed: raisedMs === null || cur.lastUsed === null ? cur.lastUsed : { ...cur.lastUsed, leadMs: raisedMs },
          last: usage === null ? cur.last : { read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens },
          stop: stop ?? cur.stop,
        }
      })
  // A reply served without the cache moves no touch: the countdown keeps running from the last one. A reply that read it moves
  // the touch even when keepalive stops after it, so the countdown does not show a cache just refreshed as expired.
  if (applied && servedFromCache) {
    const touched = (await $.state.get(TOUCH)).value ?? null
    await $.state.set(TOUCH, touched === null ? p.decidedMs : Math.max(touched, p.decidedMs))
    await settleColdMark($)
  }
  if (applied && decided.raisedMs !== null) {
    debugLine($, 'cachier lead', {
      time: new Date(p.decidedMs).toISOString(),
      from_s: decided.fromMs / 1000,
      to_s: decided.raisedMs / 1000,
      round_trip_ms: roundTripMs,
    })
  }
  const spend = usage === null ? null : forkSpend(usage, p.view, await moneyOf($, p.view))
  await tallyWrite($, (t) => countPing(t, spend, applied ? decided.raisedMs : null, { late, pauseEpoch: p.pauseEpoch }))
  debugLine(
    $,
    'cachier ping',
    pingLine({
      decidedMs: p.decidedMs,
      seq: p.seq,
      generation: p.generation,
      leadMs: p.leadMs,
      ttlMs: p.ttlMs,
      roundTripMs,
      usage,
      outcome,
      stale: !applied,
      retry: applied ? decided.retry : null,
    }),
  )
}

// A ping's fork, from its send to its end. The TTL bounds the wait: a reply still missing when it lapses stops keepalive, since
// the cache may have expired, and the fork's own reply is logged as it arrives. A throw in the state write is logged, and fails
// closed.
const settlePing = async ($: Dollar, p: Ping) => {
  try {
    let lapse: () => void = () => {}
    const lapsed = new Promise<Ended>((resolve) => {
      lapse = () => resolve({ kind: 'lapsed' })
    })
    const timer = $.clock.after(p.ttlMs, lapse)
    const ended = await Promise.race([
      p.fork.then(
        (reply): Ended => ({ kind: 'reply', reply }),
        (err: unknown): Ended => ({ kind: 'threw', err }),
      ),
      lapsed,
    ])
    timer.cancel()
    await applyPing($, p, ended, false)
    if (ended.kind === 'lapsed') {
      inBackground(
        $,
        p.fork.then(
          (reply) => applyPing($, p, { kind: 'reply', reply }, true),
          (err: unknown) => applyPing($, p, { kind: 'threw', err }, true),
        ),
      )
    }
  } catch (err) {
    report($, err)
    gapBroken = true
  }
}

// One tick. A ping starts only when the state, read here, says it may, and the commit of its count checks that the state
// has not moved since: the fork is sent straight after that commit, with no await between.
const keepaliveTick = async ($: Dollar) => {
  if (pinging) return
  pinging = true
  try {
    if (gapBroken) return
    const held = await $.state.get(KEEPALIVE)
    const k = held.value ?? INITIAL
    if (k.config === null) return
    const decidedMs = await $.clock.now()
    const view = await effectiveView($)
    const live = (await $.state.get(TOUCH)).value ?? null
    const verdict = step(k, view, live, gapOpen(k), decidedMs, await moneyOf($, view), null)
    if (verdict.kind === 'stop') {
      await $.state.set(KEEPALIVE, { ...k, stop: verdict.reason }, { ifVersion: held.version })
      return
    }
    if (verdict.kind !== 'ping' || view.kind !== 'known' || k.config === null) return
    const seq = k.seq + 1
    const committed = await $.state.set(KEEPALIVE, { ...k, remaining: k.remaining - 1, seq }, { ifVersion: held.version })
    if (!committed.isSet) return
    const fork = $.model.fork({ prompt: PING_PROMPT })
    await settlePing($, { fork, view, generation: k.generation, seq, decidedMs, leadMs: k.config.leadMs, ttlMs: view.ttlMs, pauseEpoch: k.pauseEpoch })
  } finally {
    pinging = false
  }
}

// Turns keepalive off, as `/keepalive off` does.
const turnOff = async ($: Dollar): Promise<string> => {
  await editKeepalive($, off)
  return 'keepalive off'
}

// Turns keepalive on with a lead and a count: a state change only, which the pie's click and the command both make. Returns the figures
// the run starts with, for the command's answer.
const turnOn = async ($: Dollar, leadMs: number, count: number | null) => {
  const nowMs = await $.clock.now()
  const view = await effectiveView($)
  const live = (await $.state.get(TOUCH)).value ?? null
  const money = await moneyOf($, view)
  const runCount = countNow(count, view, money, leadMs, nowMs)
  await editKeepalive($, (k) => enable(k, leadMs, count, runCount, view, live, nowMs))
  await tallyWrite($, (t) => ({ ...t, raisedMs: null }))
  // The stop enable wrote, and whether the cache is warm, both worked out from the same figures.
  return { view, money, runCount, stop: enabledStop(view, leadMs, live, nowMs), warm: !expiredAt(view, live, nowMs) }
}

// A session that starts on, at the defaults a click uses. No cache is read yet, so the run waits for its figures, which the hover
// and the details pane show once they are known. A failure is logged and leaves keepalive off.
const startOn = async ($: Dollar) => {
  if (defaultRun === undefined) return
  try {
    const nowMs = await $.clock.now()
    const view = await effectiveView($)
    const live = (await $.state.get(TOUCH)).value ?? null
    const runCount = countNow(null, view, await moneyOf($, view), defaultRun.leadMs, nowMs)
    await editKeepalive($, (k) => enable(k, defaultRun!.leadMs, null, runCount, view, live, nowMs))
  } catch (err) {
    report($, err)
  }
}

// Sets the mode new sessions start in through the plugin's own option, so /config shows the same value. The engine reloads
// the plugin with it, and a reload keeps this session's state: the session's own mode is left as it is.
const setDefault = async ($: Dollar, mode: Mode): Promise<string> => {
  const r = await $.config.set({ key: `${PLUGIN}.keepalive_default`, value: mode })
  if (r.deny !== undefined) return `keepalive default unchanged: ${r.deny}`
  return `keepalive default: ${mode}. Sessions started from now on start with keepalive ${mode}; this one stays as it is.`
}

// The words a drawing shows, in order: its strings, the labels of its buttons and links, and the text a leaf holds in its props (a
// Markdown's `text`, a Code's `source`, a picture's `alt`). A drawing with none shows nothing. The engine's own node is opaque, drawn by
// core from the props: its words are the mode labels it was given (`modes`).
const LEAF_WORDS = ['label', 'text', 'source', 'alt'] as const
const wordsOf = (node: unknown, modes: readonly string[]): string => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map((child) => wordsOf(child, modes)).join('')
  if (typeof node !== 'object' || node === null) return ''
  const el = node as { type?: unknown; props?: Partial<Record<(typeof LEAF_WORDS)[number], unknown>>; children?: unknown }
  if (el.type === 'engine') return modes.join(' & ')
  const own = LEAF_WORDS.map((prop) => el.props?.[prop]).filter((word): word is string => typeof word === 'string')
  return own.join('') + wordsOf(el.children, modes)
}

// The pie's click: the same toggle as the command, with no answer shown. A press that throws is logged and named on the status line
// until a press completes.
export const pressCountdown = async ($: Dollar, defaults: Defaults) => {
  try {
    const k = (await $.state.get(KEEPALIVE)).value ?? INITIAL
    const press = pressOf(k, defaults)
    if (press.kind === 'off') {
      await turnOff($)
    } else {
      await turnOn($, press.leadMs, press.count)
    }
    pressFailure = null
  } catch (err) {
    report($, err)
    pressFailure = PRESS_FAILED
  }
}

// The settings the bare command names: each one's value, where the value came from when that is knowable, and what changes it. A
// setting that changes only new sessions says so. `kept` is the count a run keeps where the reasons give another (keptOf), named as the one
// the pause started with. `unitPressed` is whether the unit was switched this session.
const settingsOf = (raw: CacheView, run: { leadMs: number; count: number | null } | undefined, kept: number | null, tally: TallyState, view: CacheView, money: Money, nowMs: number, unitPressed: boolean): Setting[] => {
  const known = raw.kind === 'known'
  const hour = known && raw.ttlLabel === '1h'
  const pinned = run?.count ?? null
  const learned = pinned === null && run !== undefined && view.kind === 'known' && learnedNow(view, money, run.leadMs, nowMs) !== null
  return [
    {
      name: 'TTL',
      value: known ? (hour ? '1 h' : '5 min') : 'not read yet',
      source: known ? 'read from the last response' : null,
      change: hour ? `${ttlSwitchOf('5m')} for 5 min (new sessions)` : `${ttlSwitchOf('1h')} for 1 h (new sessions)`,
    },
    {
      name: 'lead',
      value: run === undefined ? 'not set' : `${run.leadMs / 1000} s`,
      source: tally.raisedMs === null ? null : 'raised after a slow refresh',
      change: '/keepalive on <lead seconds>',
    },
    {
      name: 'refreshes a pause',
      value: pinned !== null ? `${pinned}, pinned` : kept !== null ? `${kept}` : learned ? 'learned' : 'break-even',
      // The cap bounds the break-even and learned counts, never a pinned one (runCountOf) or a kept one.
      source: pinned !== null ? null : kept !== null ? KEPT_COUNT : defaultRun?.cap == null ? null : 'keepalive_count caps it',
      change: '/keepalive on <lead seconds> <refreshes>, or keepalive_count',
    },
    { name: 'start mode', value: defaultMode, source: 'keepalive_default option', change: '/keepalive default on|off, for new sessions' },
    { name: 'unit', value: money.unit, source: unitPressed ? 'switched this session' : 'cost_unit option', change: '/keepalive unit tokens|dollars' },
  ]
}

// The figures and sentences the bare command's sections state. The clock is read first, then each state key once, in sequence:
// not an atomic snapshot, so a write that lands between two reads can leave figures from two moments. A surface that states the
// sections calls it: the bare command, which lays them out wrapped at 48 columns, and the details pane's draw, which lays them out for the engine to wrap.
const snapshotNow = async ($: Dollar): Promise<Snapshot> => {
  const nowMs = await $.clock.now()
  const held = (await $.state.get(KEEPALIVE)).value ?? INITIAL
  const live = (await $.state.get(TOUCH)).value ?? null
  const raw = (await $.state.get(VIEW)).value ?? NO_CACHE
  const cold = (await $.state.get(COLD)).value ?? null
  const unitHeld = (await $.state.get(UNIT)).value
  const view = effectiveOf(raw, cold)
  const money = moneyFrom(unitHeld, view)
  const tally = (await $.state.get(TALLY)).value ?? INITIAL_TALLY
  const stats = (await $.state.get(STATS)).value ?? INITIAL_STATS
  // The rebuild is priced once here: the figure and the 'Shown in tokens' reason both come from this spend.
  const rebuildPriced = raw.kind === 'known' ? rebuildSpendOf(raw, money) : null
  const rebuild = rebuildPriced === null ? '' : uponOf(rebuildPriced, money.unit)
  const reading = readingOf(raw, live, cold, nowMs, rebuild)
  // The lines that state a refresh price state the rebuild beside it while the cache is warm.
  const pair = { warm: reading?.state === 'warm', rebuild: rebuildPriced }
  // The reason is given only where the warmth line draws the figure (rebuildDrawnOf): not on a warm cache, nor after /clear, which leaves the view known and no reading.
  const rebuildSpend = rebuildDrawnOf(reading, rebuild) ? rebuildPriced : null
  const judged = (await $.state.get(JUDGED)).value ?? NO_JUDGED
  const run = runOf(held, defaultRun)
  const rundown = rundownSections(tally, stats, money)
  const balance = sessionBalanceLine(judged, money.unit)
  const refreshes = sessionLineOf(tally, money)
  const kept = keptOf(held, view, money, nowMs)
  const verdict = step(held, view, live, gapOpen(held), nowMs, money, rebuildPriced)
  // The pie's own judgement, from the held state and the view under the cold mark, so the sentence agrees with the heading above it.
  const { colour } = pieOf(reading, held.config !== null, costOf(held, view, money, pair)?.label ?? null, held.stop !== null)
  // While keepalive is off, the offer a press would start: the same figure the tick writes, from the same inputs.
  const offer = held.config === null && defaultRun !== undefined ? offerNow(held, view, money, nowMs, defaultRun, pair) : null
  return {
    cache: [warmthOf(reading, raw.kind === 'known' ? raw.ttlLabel : '5m', rebuild)].filter((line) => line !== ''),
    keepalive: {
      state: verdict.heading,
      lines: [
        ...(verdict.why === null ? [] : [verdict.why]),
        ...(colour === null ? [] : [colour]),
        ...(offer === null ? [] : offer.lines),
        ...verdict.lines,
        ...countLines(held, view, money, nowMs, kept),
        ...(defaultRun === undefined ? [] : [breakEvenLine(held, view, money, defaultsNow(defaultRun, view, money, nowMs))]),
        balance,
        ...rundown.keepalive,
      ].filter((line) => line !== ''),
    },
    // This session repeats the Keepalive section's refreshes line and balance, and the Advice section's misses line, word for word. Before the
    // first refresh the refreshes line is the fallback here, this section's own.
    session: [refreshes === '' ? 'This session: no refreshes yet.' : refreshes, balance, ...rundown.advice].filter((line) => line !== ''),
    advice: [sentenceNow(held, view, money), ttlLineNow(held, view, money), ...rundown.advice, ...unitNotes(money, view, rebuildSpend, tally, stats)].filter((line) => line !== ''),
    settings: settingsOf(raw, run, kept, tally, view, money, nowMs, unitPressedNow(unitHeld)),
  }
}

const keepaliveCommand = async ($: Dollar, args: string, origin: { kind: string }): Promise<string> => {
  const request = parseRequest(args)
  switch (request.kind) {
    case 'status':
      return answerOf(await snapshotNow($))
    case 'usage':
      return 'usage: /keepalive on <lead seconds> [refreshes], /keepalive off, /keepalive default on|off, or /keepalive unit dollars|tokens. Without refreshes, each run sends the count learned from your pauses, else the break-even count. The default is the mode new sessions start in.'
    case 'off':
      return turnOff($)
    case 'on': {
      // Only the user's own toggle turns keepalive on: a command from a plugin, a schedule or a peer is refused.
      if (!isUserPrompt(origin)) return "keepalive stays off: only the user's own /keepalive turns it on."
      const { view, money, runCount, stop, warm } = await turnOn($, request.leadMs, request.count)
      return enableText(view, request.leadMs, runCount, stop, money, { warm, rebuild: view.kind === 'known' ? rebuildSpendOf(view, money) : null })
    }
    case 'default':
      // As with on, only the user's own command makes keepalive start on in later sessions.
      if (request.mode === 'on' && !isUserPrompt(origin)) return "keepalive default stays: only the user's own /keepalive sets it on."
      return setDefault($, request.mode)
    case 'unit':
      // The unit switch: the figures redraw, and a switch to dollars after a failed price read reads the page again.
      await setUnit($, request.unit)
      return `figures show in ${request.unit} for this session.`
  }
}

// An empty path is a hook with no local transcript, not a file to read.
const transcriptOf = (path: unknown): string | undefined => (typeof path === 'string' && path !== '' ? path : undefined)

// What the status line says: only what is wrong, each in one clause. Null when nothing is, and the line is cleared.
export const alarmOf = async ($: Dollar, view: CacheView): Promise<string | null> => {
  const alarms: string[] = []
  if (gapBroken) alarms.push('a state write failed; see the debug log')
  if (statsBroken) alarms.push('stats write failed; see the debug log')
  if (view.kind === 'unread') alarms.push('TTL unread; see the debug log')
  if (pressFailure !== null) alarms.push(pressFailure)
  const paneFault = paneAlarm()
  if (paneFault !== null) alarms.push(paneFault)
  const k = (await $.state.get(KEEPALIVE)).value ?? INITIAL
  const failure = failureOf(k, await effectiveView($))
  if (failure !== null) alarms.push(failure)
  return alarms.length === 0 ? null : alarms.join(' · ')
}

// The bare command's notes on the unit. In tokens, what a cache write costs in reads on this model, which no token count says by
// itself. In dollars, why a figure is shown in tokens instead, once per reason. `rebuild` is the rebuild figure's spend, null where none is drawn.
const unitNotes = (money: Money, view: CacheView, rebuild: Spend | null, tally: TallyState, stats: StatsState): string[] => {
  if (money.unit === 'tokens') {
    const ratio = writeReadRatio(money.list, money.model, money.ttl)
    return ratio === null || money.model === null
      ? []
      : [`A ${TTL_WORDS[money.ttl]} cache write costs about ${Math.round(ratio)} cache reads on ${money.model}.`]
  }
  const ping = view.kind === 'known' ? spendOf(money.list, view.model, view.speed, { ...NO_KINDS, read: view.promptTokens }) : null
  const spends: (Spend | null)[] = [ping, rebuild, tally.session.spend, stats.misses.lapse.spend, stats.misses.cold.spend, stats.misses.unexplained.spend, stats.saved.spend, stats.saved.avoided, stats.ranOut.spend, stats.notNeeded.spend]
  const whys = new Set(spends.flatMap((sp) => (sp !== null && sp.usd === null && sp.why !== null ? [sp.why] : [])))
  return [...whys].map((why) => `Shown in tokens: ${why}.`)
}

// One draw at a time: a unit switch's draw that comes while the tick's runs is skipped, and the next tick draws the figures, so two
// draws never write the hint together.
const drawOnce = singleFlight()

// Sets the session's unit and draws it at once, or by the next tick when a draw is already running. Keepalive's state is not
// touched. A switch to dollars from another unit reads the shared record at once; the figures redraw when the read lands.
// `/keepalive unit` switches through here.
const setUnit = async ($: Dollar, unit: Unit): Promise<void> => {
  const before = await unitNow($)
  await $.state.set(UNIT, unit)
  await drawOnce(() => drawStatus($))
  if (unit === 'dollars' && before !== 'dollars') {
    await priceCheck(sync, $, true)
    await drawOnce(() => drawStatus($))
  }
}

// The pause the marker judges at `nowMs`, from the state as it stands.
const pauseNow = async ($: Dollar, nowMs: number): Promise<Pause | null> => {
  if (defaultRun === undefined) return null
  const k = (await $.state.get(KEEPALIVE)).value ?? INITIAL
  const view = await effectiveView($)
  const live = (await $.state.get(TOUCH)).value ?? null
  const tally = (await $.state.get(TALLY)).value ?? INITIAL_TALLY
  const money = await moneyOf($, view)
  return pauseOf(k, view, live, tally.pause.spend, money, defaultsNow(defaultRun, view, money, nowMs), nowMs)
}

// The pause a prompt is about to end, as the history keeps it: where it started, the TTL, the price ratio, and the transcript whose
// key keeps it. Null outside an idle gap or with no warm cache, so a prompt typed during a turn or before the first reply records nothing.
type PauseStart = { startMs: number; ttlMs: number; ratio: number | null; contextTokens: number; path: string }

const pauseStartNow = async ($: Dollar): Promise<PauseStart | null> => {
  const k = (await $.state.get(KEEPALIVE)).value ?? INITIAL
  const view = await effectiveView($)
  if (k.active || !k.gap || view.kind !== 'known') return null
  // The transcript the prompt is entered in: the path learned, which the state names only once the learn's write lands; before any
  // learn, a reload's state. A known view is only written while the state names a transcript (readOnce), so one is always named here.
  const named = (await $.state.get(TRANSCRIPT)).value
  const path = heldPath ?? (typeof named === 'string' ? named : null)
  if (path === null) return null
  return { startMs: view.touchMs, ttlMs: view.ttlMs, ratio: ratioOf(view, await moneyOf($, view)), contextTokens: view.promptTokens, path }
}

// Reads the pauses under a transcript's own key into this session, once the path is learned. The key comes from the path the hook
// carries, never from the transcript state, which may still name the one before. A failed read is logged, once while it keeps failing
// (sessionFailed), and leaves its key's records unread; the next tick reads again (sessionRetry). A pause a prompt ended while the read ran
// stays appended, so it is counted whichever way the read was answered. A pane drawn meanwhile priced other pauses, and a still footer state
// draws nothing again, so the pane is drawn again here.
const sessionLoad = async ($: Dollar, path: string) => {
  const reading = { path }
  sessionReading = reading
  const key = keyOf(path)
  let held: unknown
  try {
    held = await $.store.get(key)
  } catch (err) {
    if (sessionFailed !== path) report($, err)
    // A read of a path no longer held is reported, and leaves the held path's mark alone, so its retries stay unreported.
    if (heldPath === path) sessionFailed = path
    return
  } finally {
    if (sessionReading === reading) sessionReading = undefined
  }
  if (heldPath !== path) return
  sessionFailed = undefined
  stored = { key, records: recordsOf(held) }
  $.ui.invalidate('ui.render')
}

// A tick reads this session's pauses again while the held path's read has not landed and none is running, so a failed read does not
// leave the sentence on recent pauses for the rest of the session.
const sessionRetry = ($: Dollar) => {
  if (heldPath !== undefined && stored === undefined && sessionReading?.path !== heldPath) inBackground($, sessionLoad($, heldPath))
}

// Records a pause a prompt ended, under the key of the transcript the prompt was entered in, in the history the count is learned from and
// in the appended pauses. Only this session writes that key, and its newest pause is what the context grew from. A failed read or write is
// logged; the pause still counts. After a failed read nothing is written, since the write would replace the pauses the key holds with this
// one.
const historyWrite = async ($: Dollar, started: PauseStart, endMs: number) => {
  const key = keyOf(started.path)
  let held: unknown
  let readFailed = false
  try {
    held = await $.store.get(key)
  } catch (err) {
    report($, err)
    readFailed = true
  }
  // The growth counts from the newest pause the key holds: the records this read returned, the last landed read's, and the appended ones
  // under the key. One whose write was refused is in no key, and a failed read returns none.
  const own = [...recordsOf(held), ...(stored?.key === key ? stored.records : []), ...appendedUnder(key)]
  const newest = own.reduce<PauseRecord | undefined>((a, r) => (a === undefined || r.startMs > a.startMs ? r : a), undefined)
  const record = recordOf(started.startMs, endMs, started.ratio, started.ttlMs, started.contextTokens, newest === undefined ? [] : [newest])
  history = [...history, record].slice(-HISTORY_BOUND)
  // Before any learn, the learn decides by the key: a pause kept under another transcript than the one learned since is that session's, not
  // this one's.
  appendedPauses = [...appendedPauses, { key, record }].slice(-HISTORY_BOUND)
  appendedKeys.add(key)
  if (heldPath === undefined) sessionKey = key
  // No state write covers the in-memory changes above, so an open pane is asked to draw again.
  if (isPaneOpen()) $.ui.invalidate('ui.render')
  if (readFailed) return
  try {
    await $.store.set(key, appended(held, record))
  } catch (err) {
    report($, err)
  }
}

// The most store calls loadHistory has running at once: a store with many sessions' keys is not asked about all of them together.
const STORE_CALLS = 8

// Runs `work` on each key by a pool of STORE_CALLS workers, each taking the next key as its last call lands, until every key is taken
// or one call rejects. Each key is its own session's and none waits on another. The first call that rejects rejects the whole, and no
// worker takes a key after it.
const pooled = async (keys: readonly string[], work: (key: string, i: number) => Promise<void>): Promise<void> => {
  let next = 0
  let rejected = false
  const worker = async () => {
    while (!rejected && next < keys.length) {
      const i = next++
      try {
        await work(keys[i]!, i)
      } catch (err) {
        rejected = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(STORE_CALLS, keys.length) }, worker))
}

// Each key's value. The first read refused rejects the whole (pooled).
const readKeys = async ($: Dollar, keys: readonly string[]): Promise<Record<string, unknown>> => {
  const values: unknown[] = []
  await pooled(keys, async (key, i) => {
    values[i] = await $.store.get(key)
  })
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]))
}

// Deletes the keys. Each delete is tried, a refused one included, since each key is its own; the first refusal is reported, once, and
// a key left stays stale, so the next load deletes it again. A key this load (the module's, appendedKeys) has written a pause under is
// left, whenever it was written: one written after the keys were read was judged stale without it, and a delete would drop that pause
// from the store.
const deleteKeys = async ($: Dollar, keys: readonly string[]): Promise<void> => {
  let refusal: { err: unknown } | undefined
  await pooled(keys, async (key) => {
    if (appendedKeys.has(key)) return
    try {
      await $.store.delete(key)
    } catch (err) {
      refusal ??= { err }
    }
  })
  if (refusal !== undefined) report($, refusal.err)
}

// Reads every session's pauses into the history the count is learned from, and deletes the keys that hold only pauses
// older than the newest it keeps. At each start and reload: other sessions' later pauses are read at the next one. The history is what
// the store holds, as read, and the appended pauses; a record the store has dropped is not brought back from the last history.
const loadHistory = async ($: Dollar) => {
  const keys = (await $.store.keys()).filter((key) => key.startsWith(KEY_PREFIX))
  const held = await readKeys($, keys)
  const stale = staleKeys(held)
  const read = Object.entries(held)
    .filter(([key]) => !stale.includes(key))
    .flatMap(([, value]) => recordsOf(value))
  history = merged(read, appendedPauses.map((u) => u.record))
    .sort((a, b) => a.startMs - b.startMs)
    .slice(-HISTORY_BOUND)
  // A pane drawn before the read priced no history, and a still footer state draws nothing again, as in sessionLoad.
  $.ui.invalidate('ui.render')
  await deleteKeys($, stale)
}

// The history read in flight. A process's start runs both classic.SessionStart and session.start, and the second shares the first's read
// instead of reading every key again. A failed read is reported here, once, for both callers.
let historyLoading: Promise<void> | null = null
const loadHistoryOnce = ($: Dollar): Promise<void> => {
  historyLoading ??= loadHistory($).catch((err: unknown) => report($, err)).finally(() => {
    historyLoading = null
  })
  return historyLoading
}

// The count learned for a pause starting now on this cache, at this lead; null where break-even stands: no warm cache, no
// price, or a history that does not beat it. Recomputed only when its inputs change, since every tick asks.
const learnedNow = (view: CacheView, money: Money, leadMs: number, nowMs: number): Learned | null => {
  if (view.kind !== 'known' || defaultRun === undefined) return null
  const ratio = ratioOf(view, money)
  if (ratio === null) return null
  const maxCount = runCountOf(null, view, money, defaultRun.cap)
  const hour = new Date(nowMs).getHours()
  const key = [hour, maxCount, view.ttlMs, leadMs, ratio].join('|')
  learnedMemo = memoised(learnedMemo, [history], key, () => learnedOf(history, hour, maxCount, { ttlMs: view.ttlMs, leadMs, ratio }))
  return learnedMemo.value
}

// The count a running unpinned run keeps when the reasons now give another, else null (keptCount). The Settings line and the count line
// both read it, so they agree.
const keptOf = (k: KeepaliveState, view: CacheView, money: Money, nowMs: number): number | null =>
  k.config === null ? null : keptCount(k, countNow(null, view, money, k.config.leadMs, nowMs))

// The bare command's line on how many refreshes a pause sends: the learned count while one is in force and nothing is pinned, else why the
// count is what it is. The run is the one a click would start, or the running one, with its own lead and pin. A running run's line reports
// the count it sends (`runCount`), not one worked out now: from a pause's first refresh that count is kept (recount). `kept` is keptOf's,
// worked out once by the caller, so this line and the Settings line name the same count.
const countLines = (k: KeepaliveState, view: CacheView, money: Money, nowMs: number, kept: number | null): string[] => {
  if (defaultRun === undefined || view.kind !== 'known') return []
  const run = runOf(k, defaultRun)
  if (kept === null && run.count === null) {
    const l = learnedNow(view, money, run.leadMs, nowMs)
    if (l !== null) return [learnedLine(l, view.ttlMs)]
  }
  return [countLineOf(run.count, view, money, defaultRun.cap, kept)]
}

// How a new session runs keepalive, as a switch of TTL needs one: on or off as keepalive_default says (defaultMode), at the options'
// lead and pin, since it has no lastUsed.
const newSessionRun = (d: Defaults) => ({ on: defaultMode === 'on', leadMs: d.leadMs, pinned: d.count })

// The inputs both Advice sentences are priced and worded from, or null where neither gives anything: the view is not known, its model has
// no rates, or the options' defaults are not loaded yet. The "on" setups at this TTL run as keepalive does: the running run, or the one a
// click on the pie would start. At the other TTL they run as the new session a switch needs would (newSessionRun), with no lastUsed to
// start from.
const adviceInputs = (k: KeepaliveState, view: CacheView, money: Money): Inputs | null => {
  if (view.kind !== 'known' || defaultRun === undefined) return null
  const rates = ratesOfView(view, money)
  if (rates === null) return null
  const run = runOf(k, defaultRun)
  return {
    session: sessionPauses(),
    history,
    rates,
    leadMs: run.leadMs,
    cap: defaultRun.cap,
    current: { ttl: view.ttlLabel, keepalive: k.config !== null },
    pinned: run.count,
    fresh: newSessionRun(defaultRun),
  }
}

// The Advice section's TTL line, once the recorded pauses say the other TTL would have cost less at today's prices: '' with no line. The
// current TTL is priced in the mode keepalive is in, at the running run; the other as the new session a switch needs would run it. It prices
// no session pauses, so it is memoised on the history alone and the inputs it words; with keepalive off a lead and pin that change neither
// price nor words still rebuild it, which is harmless.
const ttlLineNow = (k: KeepaliveState, view: CacheView, money: Money): string => {
  const inputs = adviceInputs(k, view, money)
  if (inputs === null) return ''
  const key = [JSON.stringify(inputs.rates), inputs.leadMs, inputs.cap, JSON.stringify(inputs.current), inputs.pinned, JSON.stringify(inputs.fresh)].join('|')
  ttlLineMemo = memoised(ttlLineMemo, [history], key, () => ttlLineOf(inputs))
  return ttlLineMemo.value
}

// The one sentence on the best setup, as the details pane and bare /keepalive show it: '' with no result. Pricing the history is the costly
// part, so the sentence is memoised on the pauses and the inputs it prices, and every surface asks the same memo.
const sentenceNow = (k: KeepaliveState, view: CacheView, money: Money): string => {
  const inputs = adviceInputs(k, view, money)
  if (inputs === null) return ''
  const key = [JSON.stringify(inputs.rates), inputs.leadMs, inputs.cap, JSON.stringify(inputs.current), inputs.pinned, JSON.stringify(inputs.fresh), money.unit].join('|')
  sentenceMemo = memoised(sentenceMemo, [inputs.session, history], key, () => adviceOf(inputs, money.unit))
  return sentenceMemo.value
}

// The count a run sends: a pinned count as pinned, else the learned count, else break-even.
const countNow = (count: number | null, view: CacheView, money: Money, leadMs: number, nowMs: number): number =>
  count ?? learnedNow(view, money, leadMs, nowMs)?.count ?? runCountOf(null, view, money, defaultRun?.cap ?? null)

// The defaults a click would run with, the learned count among them: what the marker and the break-even line price a
// keepalive that has not run at.
const defaultsNow = (defaults: Defaults, view: CacheView, money: Money, nowMs: number): Defaults => ({
  ...defaults,
  count: learnedNow(view, money, defaults.leadMs, nowMs)?.count ?? null,
})

// Folds the pause a prompt ended into the session's net, which bare `/keepalive` shows (sessionBalanceLine). A failed write is only logged.
const judgedWrite = async ($: Dollar, change: (j: Judged) => Judged) => {
  try {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const held = await $.state.get(JUDGED)
      if ((await $.state.set(JUDGED, change(held.value ?? NO_JUDGED), { ifVersion: held.version })).isSet) return
    }
    throw new Error("cachier: the session's judged pauses changed on every write attempt; the pause was not counted")
  } catch (err) {
    report($, err)
  }
}

// The part of a figure the hint keeps: its label.
const labelOf = (figure: Figure | null): HintCost | null => (figure === null ? null : { label: figure.label })

// The hint's state is written only when it changes, so a tick that changes nothing writes nothing.
const setHint = async ($: Dollar, hint: HintState | null) => {
  const held = (await $.state.get(HINT)).value ?? null
  if (JSON.stringify(held) !== JSON.stringify(hint)) await $.state.set(HINT, hint)
}

// The figure the time's hover shows while keepalive is off: the run a press would start, at the lead and count it would use, as the press
// itself reads them, which on a warm cache is the rebuild's price alone where the run sends no refresh. While it is on but paused or
// spent, the figure is the run it is on, at its lead and count, which a resume sends.
// The tick writes its label with the other figures for the hover, and the gather works the whole figure out from the same inputs rather than
// reading the stored hint.
const offerNow = (k: KeepaliveState, view: CacheView, money: Money, nowMs: number, defaults: Defaults, pair: Pair): Figure | null => {
  if (k.config !== null) return offerOf(view, money, k.config.leadMs, k.runCount, pair)
  const press = pressOf(k, defaults)
  return press.kind === 'on' ? pressOfferOf(view, money, press.leadMs, countNow(press.count, view, money, press.leadMs, nowMs), pair) : null
}

// Drawn on every tick, outside the lookup's single flight, so a held lookup cannot freeze it.
const drawStatus = async ($: Dollar) => {
  sessionRetry($)
  const transcript = (await $.state.get(TRANSCRIPT)).value ?? null
  const view = (await $.state.get(VIEW)).value ?? NO_CACHE
  const cold = (await $.state.get(COLD)).value ?? null
  const live = (await $.state.get(TOUCH)).value ?? null
  const nowMs = await $.clock.now()
  lastNow = nowMs
  if (transcript === null) {
    $.ui.status(undefined)
    await setHint($, null)
    return
  }
  $.ui.status((await alarmOf($, view)) ?? undefined)
  const counted = await effectiveView($)
  const money = await moneyOf($, counted)
  // Until a run's first ping, an unpinned count follows what is known now: a run enabled before the cache or the prices were
  // read, or before the pause it ended joined the history, takes the count they give.
  await hookWrite($, (k) => {
    const next = k.config === null ? k : recount(k, countNow(null, counted, money, k.config.leadMs, nowMs))
    return next === k ? undefined : next
  })
  const held = (await $.state.get(KEEPALIVE)).value ?? INITIAL
  // The figure to rebuild an expired cache: what the next prompt pays to write it again, in the unit shown.
  const rebuildPriced = view.kind === 'known' ? rebuildSpendOf(view, money) : null
  const reading = readingOf(view, live, cold, nowMs, rebuildPriced === null ? '' : uponOf(rebuildPriced, money.unit))
  const pair = { warm: reading?.state === 'warm', rebuild: rebuildPriced }
  const figure = costOf(held, counted, money, pair)
  const hint: HintState = {
    reading,
    cost: labelOf(figure),
    offer: defaultRun === undefined ? null : labelOf(offerNow(held, counted, money, nowMs, defaultRun, pair)),
  }
  await setHint($, hint)
  // An open pane follows the size its draw recorded; nothing is built here to know it.
  if (isPaneOpen()) inBackground($, followDraw($))
}

// Whether a main-thread turn is running. Its first step and its end read the transcript, so growth while it runs needs no reread.
const turnRunning = async ($: Dollar) => ((await $.state.get(KEEPALIVE)).value ?? INITIAL).active

// One backward pass over the transcript for the drawn ids not yet found. It runs when an id is newly drawn, or when the
// transcript has changed size since the last pass, so an id that is missing is looked up again only after growth. A
// failed lookup is retried the same way: on the next size change, not on every tick.
const lookupStamps = async ($: Dollar) => {
  const transcript = (await $.state.get(TRANSCRIPT)).value ?? null
  if (transcript === null) return
  let changed = false
  if (transcript !== stampSession) {
    stampSession = transcript
    stampTimes.clear()
    lastPassSize = undefined
    changed = true
  }
  let size: number | undefined
  try {
    size = (await $.fs.exists(transcript)) ? (await $.fs.stat(transcript)).size : undefined
    if (unreadable) {
      unreadable = false
      $.ui.log('cachier: transcript readable again', { to: 'debug' })
    }
  } catch (err) {
    if (!unreadable) {
      unreadable = true
      report($, err)
    }
  }
  // The file grew since the last read: its newest rows are not in the view or the counts yet, so read again.
  if (size !== undefined && size !== sizeAtRead && !(await turnRunning($))) refresh($)
  if (size !== undefined && wanted.size > 0 && (fresh.size > 0 || size !== lastPassSize)) {
    const asked = [...wanted.keys()]
    fresh.clear()
    lastPassSize = size
    let found: Map<string, Row>
    try {
      found = await lookupRows(hostOf($), transcript, asked)
    } catch (err) {
      report($, err)
      found = new Map()
    }
    for (const id of asked) {
      const row = found.get(id)
      if (row !== undefined) {
        stampTimes.set(id, row.timestampMs)
        wanted.delete(id)
        changed = true
      }
    }
  }
  if (changed) $.ui.invalidate('ui.render')
}

// A tick that finds a pass still running is skipped; the running pass is not waited on. Each process run carries its own timeout.
const runTick = singleFlight()

// The tick's read of the engine's record of the pane, which catches a close the mod never hears within about a second. A run of failed
// reads is reported once.
const paneTick = async ($: Dollar) => {
  try {
    await readPane($)
    paneTickFailed = false
  } catch (err) {
    if (!paneTickFailed) report($, err)
    paneTickFailed = true
  }
}

const tick = ($: Dollar) => {
  inBackground($, paneTick($))
  inBackground($, priceCheck(sync, $))
  inBackground($, drawOnce(() => drawStatus($)).then(() => runTick(() => lookupStamps($))))
  inBackground($, keepaliveTick($))
}

const ensureTicker = ($: Dollar) => {
  ensureSink($)
  if (timer !== undefined) return
  timer = $.clock.every(TICK_MS, () => {
    tick($)
  })
}

const stopTicker = () => {
  timer?.cancel()
  timer = undefined
}

const stamped = (requestId: string, tree: RenderElement): RenderElement => {
  const ms = stampTimes.get(requestId)
  if (heldPath !== undefined && ms === undefined && !wanted.has(requestId)) {
    wanted.set(requestId, heldPath)
    fresh.add(requestId)
  }
  const label = ms === undefined || ms === null || lastNow === undefined ? undefined : stampLabel(ms, lastNow)
  return withStamp(label, tree)
}

export const register: Register = (on, options) => {
  sync = priceSync()
  paneTickFailed = false
  paneDrawFailed = false
  const defaults = defaultsOf(options)
  defaultRun = defaults
  defaultUnit = unitOf(options.cost_unit)
  defaultMode = modeOf(options.keepalive_default)
  on('classic.SessionStart', async ($, e, next) => {
    sessionEnded = false
    const result = await next(e)
    ensureTicker($)
    const path = transcriptOf(e.transcript_path)
    // The default mode at every session start but a compaction, whose toggle stays. Awaited, so a toggle made after this hook
    // returns is kept. Neither the reset nor the start throws into the engine.
    if (e.source !== 'compact') {
      await resetKeepalive($)
      if (defaultMode === 'on') await startOn($)
      inBackground($, loadHistoryOnce($))
    }
    if (path !== undefined) inBackground($, sessionStarted($, path, e.source))
    return result
  })

  // Every classic hook that carries a transcript path teaches it, so a mod installed mid-session starts working on its
  // first hook; the countdown timer also starts from any of them.
  on('classic.*', async ($, e, next) => {
    const result = await next(e)
    ensureTicker($)
    const path = transcriptOf('transcript_path' in e ? e.transcript_path : undefined)
    if (path !== undefined) inBackground($, learnPath($, path))
    return result
  })

  // The cold mark starts before the downstream hooks run, so no tick can commit on the new model's cache while they do.
  // A resume restores the model the session's cache was written by, and a switch to the model in use changes nothing: neither
  // forfeits the cache.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.source !== 'resume' && e.from_model !== e.to_model) await markCold($, 'model switch', (atMs) => switchForfeits($, e.prompt_cache_warm, atMs))
    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    await markCold($, 'compaction')
    return next(e)
  })

  // A main-thread request is about to be sent: its start is the touch the countdown counts from. Its reply's usage is
  // read from the transcript when the turn completes; the TTL comes from there.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await hookWrite($, (k) => turnBegun(k, e.turnId), true)
      ensureTicker($)
      refresh($)
      inBackground($, liveTouch($))
    }
    return yield* next(e)
  })

  // A main-thread turn's end opens the idle gap, once no submitted prompt waits for its turn: the only window a keepalive
  // ping may start in.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await hookWrite($, (k) => turnEnded(k, e.turnId))
      ensureTicker($)
      refresh($)
    }
    return next(e)
  })

  // The session's live touch and cold mark end with it, whatever the reason: a resumed session counts from its own
  // transcript. Keepalive is off in every session.
  on('session.end', async ($, e, next) => {
    sessionEnded = true
    await resetKeepalive($)
    try {
      stopTicker()
      await forgetLive($)
      await $.state.set(HINT, null)
    } catch (err) {
      report($, err)
    }
    // Its own try: the cue clears whether or not a step above threw.
    try {
      await clearCue($)
    } catch (err) {
      report($, err)
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    sessionEnded = false
    // Started before anything else is awaited: a hint drawn meanwhile waits for it, so it never reads an earlier load's shape.
    restoring = restoreState($)
    // A cue the earlier load left standing is cleared, and this load's reads report to it.
    await clearCue($)
    ensureSink($)
    // A reload starts the module's history over: it is read again, as at a start.
    inBackground($, loadHistoryOnce($))
    await $.command.register({
      name: COMMAND,
      description: 'Refresh the prompt cache before it lapses: /keepalive on <lead seconds> [refreshes], off, default on|off, or unit dollars|tokens.',
      argumentHint: '<lead seconds> [refreshes] | off | default on|off | unit dollars|tokens',
      immediate: true,
    })
    // The engine's record of the pane, read once: a reload keeps the pane open, and the next click must close it. A failed read is
    // reported and leaves the pane counted shut; it does not hold back the countdown below.
    try {
      await syncPane($)
    } catch (err) {
      report($, err)
    }
    // After a reload, the countdown is back at once, not at the next hook that carries the transcript.
    try {
      const path = await restoring
      if (path !== null) {
        ensureTicker($)
        await learnPath($, path)
      }
    } catch (err) {
      report($, err)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    try {
      return { text: await keepaliveCommand($, e.args, e.origin) }
    } catch (err) {
      report($, err)
      return { text: 'keepalive: the toggle failed; the error is in the debug log' }
    }
  })

  // A user's own prompt starts a fresh count of pings for a keepalive that is on, and clears its stop.
  on('prompt.submit', async ($, e, next) => {
    // Judged before the prompt closes the gap: the pause as it stands when the prompt ends it. A failure only leaves it uncounted.
    const ended = await pauseNow($, await $.clock.now()).catch((err: unknown) => {
      report($, err)
      return null
    })
    const started = await pauseStartNow($).catch((err: unknown) => {
      report($, err)
      return null
    })
    const counted = await hookWrite($, promptSubmitted)
    let entered = false
    try {
      const result = await next(e)
      entered = !('drop' in result)
      if (entered && isUserPrompt(e.origin)) {
        // The run's count is resolved for the cache this prompt leaves: its model and TTL set the break-even count.
        const armView = await effectiveView($)
        const armMoney = await moneyOf($, armView)
        const armMs = await $.clock.now()
        if (await hookWrite($, (k) => rearm(k, k.config === null ? 0 : countNow(k.config.count, armView, armMoney, k.config.leadMs, armMs)))) {
          // The pause this prompt ends is judged by the first response after it, so its record waits in the stats.
          const pause = ((await $.state.get(TALLY)).value ?? INITIAL_TALLY).pause
          const view = (await $.state.get(VIEW)).value ?? NO_CACHE
          const promptMs = await $.clock.now()
          await statsWrite($, (s) => ({ ...s, pending: pendingFor(pause, view, promptMs) }))
          const pauseEpoch = ((await $.state.get(KEEPALIVE)).value ?? INITIAL).pauseEpoch
          await tallyWrite($, (t) => restartPause(t, pauseEpoch))
          await judgedWrite($, (j) => judge(j, ended))
          if (started !== null) await historyWrite($, started, promptMs)
        }
      }
      return result
    } finally {
      if (counted && !entered) await hookWrite($, promptDropped)
    }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => stamped(e.requestId, await next(e)))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) =>
    e.props.isFirstOfReply ? stamped(e.requestId, await next(e)) : next(e),
  )

  // The footer's mode labels, with the line drawn after them: the engine's and another plugin's, as the hooks beneath draw them. The
  // engine's footer is awaited so those hooks run first. The pie is keepalive's switch; a click on the word beside it (the time, the rebuild figure, `reset` or `no count`)
  // opens the details pane.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const tree = await next(e)
    await restoring?.catch(() => null)
    const state = (await $.state.get(HINT)).value ?? null
    const keepalive = (await $.state.get(KEEPALIVE)).value ?? INITIAL
    const cue = (await $.state.get(CUE)).value ?? null
    const t = $.ui.resolve(e)
    const line = footerLine(
      t,
      state,
      keepalive.config !== null,
      () => inBackground($, pressOnce(() => pressCountdown($, defaults))),
      // The size is the pane's draw's record, read as the press is made: the open must be made inside the press, with nothing awaited (pane.ts).
      () => inBackground($, togglePane($, pressSize())),
      cue,
      keepalive.stop !== null,
    )
    if (line === null) return tree
    // The separator stands between the line and what is drawn beneath, and only where something is: judged from what the hooks beneath
    // drew, since a plugin beneath may draw a label where the engine draws no mode.
    const separator = wordsOf(tree, e.props.modes).trim() === '' ? [] : [t.Text({ dimColor: true, children: [' · '] })]
    return t.Box({ flexDirection: 'row', children: [tree, ...separator, line] })
  })

  // The details pane: the sections the bare command answers with, gathered and laid out by this draw alone, and the size it records for the press
  // and the tick. The hint state is read only to be redrawn with the tick's write each second, as the footer is: the countdown advances.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await restoring?.catch(() => null)
    // A throw while drawn draws the engine's own, so a failed state read in the draw is reported (once per run of failures) and the last rows
    // are drawn again; before the first draw there are none, and one row says so, since nothing else redraws a pane no countdown is running in. The size record stands as the last draw left it.
    let rows: PaneRow[]
    let size: PaneSize
    try {
      // The reads sit after the restore wait, as the HINT read did, and are made here in the hook body as one batch: the keys snapshotNow
      // reads, plus CUE, which the price sink writes as the price list changes. The engine redraws the pane on a write of state it read
      // while drawing, and the types do not say whether a read made after an await inside the draw counts; HINT is written only when its
      // JSON changes. The values are not used here: snapshotNow reads the keys again.
      await Promise.all([
        $.state.get(HINT),
        $.state.get(KEEPALIVE),
        $.state.get(TOUCH),
        $.state.get(VIEW),
        $.state.get(COLD),
        $.state.get(UNIT),
        $.state.get(TALLY),
        $.state.get(STATS),
        $.state.get(JUDGED),
        $.state.get(CUE),
      ])
      ;({ rows, size } = paneLayoutOf(await snapshotNow($)))
    } catch (err) {
      if (!paneDrawFailed) report($, err)
      paneDrawFailed = true
      const shown = lastRows()
      return paneOf($.ui.resolve(e), shown.length === 0 ? [{ kind: 'line', text: 'The details could not be read; see the debug log.' }] : shown)
    }
    paneDrawFailed = false
    recordSize(size)
    recordRows(rows)
    return paneOf($.ui.resolve(e), rows)
  })

  // Every close of the pane, whoever made it and whether or not another plugin keeps it open: the engine's record is read once the close has
  // settled, and the flag the press reads follows it. A failed read is reported and does not hold the close back.
  on('ui.close', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.id === PANE) {
        try {
          await readPane($)
        } catch (err) {
          report($, err)
        }
      }
    }
  })

}
