// The user's daily rest, read from the pauses every session recorded: when it falls on the clock, how well the pauses show it, and the window it leaves inside
// its margins. Pure: it takes pause records and no engine handle, and register.ts holds the reading beside the history it was read from.
//
// A rest is a gap of idleness on one timeline of every recorded moment (each pause's start and its end), whatever the hour. The habit is the 4 hour arc of the
// clock that holds the most rest starts of the newest 14; only its rests give a window, and only once there are 7 of them. Every start and end is read as minutes
// after the arc's anchor, so nothing wraps around midnight or noon.
//
// The rest then gives keepalive its fact (restFactOf): whether the rest has begun for this session, from the option, the window, the clock, the idle times, the session's step
// mark, which nightstep.ts reads and writes, and the cache the stop would let lapse: at the 1 h TTL the stop acts only where it repays the rewrite it adds. The words of the two
// notices the user is told once, when the stop can first act and when it first acts, are written here too, beside the row that states the same window.

import type { RestFact, TtlLabel } from '../types'
import { labelled, type Run } from './countdown'
import type { PauseRecord } from './history'
import { percentileOf } from './rank'
import type { Line } from './sections'

export type Rest = { startMs: number; endMs: number }

// The newest rests (oldest first), the habit among them (the arc's rests), the window in minutes after midnight (null when there is none), and the row that
// states what was read.
export type RestReading = { rests: Rest[]; habit: Rest[]; window: { opensMin: number; closesMin: number } | null; row: Run[] }

const MIN_MS = 60000
const HOUR_MS = 60 * MIN_MS
const DAY_MIN = 24 * 60
// A gap shorter than 5 hours is a long lunch or a meeting; one longer than 16 is a day or a weekend away, which would drag the end of a rest a day later.
const REST_MIN_MS = 5 * HOUR_MS
const REST_MAX_MS = 16 * HOUR_MS
// The newest rests the habit and the window are read from, so a routine that moves takes over once its rests are most of them.
const NEWEST = 14
// An arc spans its anchor and this many minutes after it, both ends included.
const ARC_MIN = 4 * 60
// The rests the habit must hold before the window is given.
const NEEDED = 7
// What the window keeps inside the percentiles: the bound of the timeline's biases, a last turn that ran before the rest and a first one that ran after it.
const MARGIN_MIN = 60

// The rests of the pauses, oldest first: each gap between two moments, of every pause's start and end, that lasts 5 to 16 hours. A gap one session leaves while
// another is active holds a moment of that other, so it is no rest.
export const restsOf = (pauses: readonly PauseRecord[]): Rest[] => {
  const moments = pauses.flatMap((p) => [p.startMs, p.startMs + p.pausedMs]).sort((a, b) => a - b)
  return moments
    .slice(1)
    .map((endMs, i): Rest => ({ startMs: moments[i]!, endMs }))
    .filter((r) => r.endMs - r.startMs >= REST_MIN_MS && r.endMs - r.startMs <= REST_MAX_MS)
}

const minuteOf = (ms: number): number => new Date(ms).getHours() * 60 + new Date(ms).getMinutes()
// How many minutes after the anchor's minute of the day `ms` falls, 0 to the day's last minute.
const afterAnchor = (ms: number, anchorMin: number): number => (minuteOf(ms) - anchorMin + DAY_MIN) % DAY_MIN

// The habit: of the arcs anchored at each rest's start, the one holding the most rest starts. Ties go to an arc holding the newest rest, then to the arc whose
// anchor rest is newest, so the choice does not depend on the order the rests are read in. Its anchor's minute of the day goes with it.
const habitOf = (rests: readonly Rest[]): { habit: Rest[]; anchorMin: number } => {
  const newest = rests[rests.length - 1]
  const arcs = rests.map((anchor) => {
    const anchorMin = minuteOf(anchor.startMs)
    const habit = rests.filter((r) => afterAnchor(r.startMs, anchorMin) <= ARC_MIN)
    return { habit, anchorMin, holdsNewest: newest !== undefined && habit.includes(newest), anchorMs: anchor.startMs }
  })
  const [best] = arcs.sort((a, b) => b.habit.length - a.habit.length || Number(b.holdsNewest) - Number(a.holdsNewest) || b.anchorMs - a.anchorMs)
  return best ?? { habit: [], anchorMin: 0 }
}

// A minute after midnight as `23:40`; one past the day's end wraps to the next day.
const timeOf = (min: number): string => {
  const day = min % DAY_MIN
  return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`
}

// The rests and the habit the pauses give, and the window the habit leaves: opening at its starts' 90th percentile and closing at its ends' 10th, each margin
// inside, none where they meet. The row states the habit's count against the 7 it needs, else the percentiles before the margins with the rests they came from.
export const restReadingOf = (pauses: readonly PauseRecord[]): RestReading => {
  const rests = restsOf(pauses).slice(-NEWEST)
  const { habit, anchorMin } = habitOf(rests)
  if (habit.length < NEEDED) return { rests, habit, window: null, row: labelled('rest:', ` ${habit.length} of ${NEEDED} seen`) }
  const starts = habit.map((r) => afterAnchor(r.startMs, anchorMin))
  const ends = habit.map((r, i) => starts[i]! + Math.floor((r.endMs - r.startMs) / MIN_MS))
  const from = percentileOf(starts, 90)
  const back = percentileOf(ends, 10)
  const opens = from + MARGIN_MIN
  const closes = back - MARGIN_MIN
  const window = opens < closes ? { opensMin: (anchorMin + opens) % DAY_MIN, closesMin: (anchorMin + closes) % DAY_MIN } : null
  const figures = ` from ≤${timeOf(anchorMin + from)} · back ≥${timeOf(anchorMin + back)} · ${window === null ? 'no window' : `${habit.length} rests`}`
  return { rests, habit, window, row: labelled('rest:', figures) }
}

// The idle figure: the step acts once this session's last request and every session's last user action are this old.
export const IDLE_MS = 30 * MIN_MS
// How long a scan that found no action within the idle figure stands: a prompt in another session lands unseen for at most this long.
export const SCAN_STANDS_MS = MIN_MS

// The newest user action over every session's key, as the tick last scanned them: not scanned yet, failed, or done at a time with the newest action it found (null for none).
export type Scan = { kind: 'none' } | { kind: 'failed' } | { kind: 'done'; atMs: number; newestMs: number | null }

// The cache a stop would let lapse: its TTL, and the break-even count of a refresh run on it, null where its model has no price.
export type StopCache = { ttlLabel: TtlLabel; ttlMs: number; breakEven: number | null }

// What the fact is decided from. `cache` is the cache a stop would let lapse, null with no known cache; `touchMs` is the start of this session's last main-thread request, null
// with no known cache. `read` is whether the session's own two times have been read; `stepMs` is the time of the step this session took and `actionMs` the time of its user's
// last action (a prompt, or turning keepalive on), each null for none.
export type RestInputs = {
  option: 'on' | 'off'
  keepaliveOn: boolean
  window: RestReading['window']
  nowMs: number
  cache: StopCache | null
  touchMs: number | null
  read: boolean
  stepMs: number | null
  actionMs: number | null
  scan: Scan
}

// The `overnight` option: only `off` turns the step off, so an unset or hand-edited value leaves it on, as the manifest's default says.
export const overnightOf = (value: unknown): 'on' | 'off' => (value === 'off' ? 'off' : 'on')

// The window as the row and the debug line state it: `03:18–06:28`.
export const windowTextOf = (window: { opensMin: number; closesMin: number }): string => `${timeOf(window.opensMin)}–${timeOf(window.closesMin)}`

const insideOf = (window: { opensMin: number; closesMin: number }, ms: number): boolean => {
  const min = minuteOf(ms)
  return window.opensMin <= window.closesMin ? min >= window.opensMin && min < window.closesMin : min >= window.opensMin || min < window.closesMin
}

// A stored time as of `nowMs`: one stamped later is a clock that moved back, and holds nothing.
const pastOf = (ms: number | null, nowMs: number): number | null => (ms !== null && ms <= nowMs ? ms : null)

// The step this session took on the local day of `nowMs`, null for none.
const stepToday = (i: RestInputs): number | null => {
  const step = pastOf(i.stepMs, i.nowMs)
  return step !== null && new Date(step).toDateString() === new Date(i.nowMs).toDateString() ? step : null
}

type Setup = RestInputs & { window: NonNullable<RestInputs['window']> }
// The setup the step needs, whatever the moment: the option on, keepalive on and a window learned.
const setupOf = (i: RestInputs): i is Setup => i.option === 'on' && i.keepaliveOn && i.window !== null

// The window's length, and the time from a moment inside it to its close, counted on the clock the window is stated in, minutes after midnight: a night the clock changes in is off by the change.
const spanOf = (window: { opensMin: number; closesMin: number }): number => ((window.closesMin - window.opensMin + DAY_MIN) % DAY_MIN) * MIN_MS
const leftOf = (window: { opensMin: number; closesMin: number }, nowMs: number): number => {
  const now = new Date(nowMs)
  return ((window.closesMin - minuteOf(nowMs) + DAY_MIN) % DAY_MIN) * MIN_MS - now.getSeconds() * 1000 - now.getMilliseconds()
}

// Whether a stop with `leftMs` of the window left to its close repays the rewrite it adds. At the 5 m TTL a run's own count ends its refreshes within about two hours of the last
// request, so the cache lapses in the rest with or without the stop, and the stop is asked to repay nothing. At the 1 h TTL a run outlasts the rest, so the stop adds a rewrite, and
// the refreshes it saves, the whole TTL periods left, must be at least the break-even count that TTL's run uses. No known cache, or no price for it, repays nothing.
const stopRepaysOf = (cache: StopCache | null, leftMs: number): boolean => {
  if (cache === null) return false
  if (cache.ttlLabel === '5m') return true
  return cache.breakEven !== null && Math.floor(leftMs / cache.ttlMs) >= cache.breakEven
}

// Whether the step can act at all, whatever the moment: the setup, and a cache whose stop repays when taken at the window's opening, its best moment.
const canActOf = (i: RestInputs): boolean => setupOf(i) && stopRepaysOf(i.cache, spanOf(i.window))

// The step this session took stands until its user acts: the mark is later than the user's last action.
const heldOf = (i: RestInputs): boolean => {
  const step = pastOf(i.stepMs, i.nowMs)
  const action = pastOf(i.actionMs, i.nowMs)
  return step !== null && (action === null || action < step)
}

// Every condition of a due fact but the scan's: the setup is there and the own times are read, the step is neither held nor taken today, the clock is inside the window and a
// stop taken now repays, and this session and its own user have been idle the figure.
const readyOf = (i: RestInputs): boolean => {
  if (!setupOf(i) || !i.read || heldOf(i) || stepToday(i) !== null || !insideOf(i.window, i.nowMs) || !stopRepaysOf(i.cache, leftOf(i.window, i.nowMs))) return false
  const action = pastOf(i.actionMs, i.nowMs)
  return i.touchMs !== null && i.nowMs - i.touchMs >= IDLE_MS && (action === null || i.nowMs - action >= IDLE_MS)
}

// What the scan on hand says of the other sessions as of `nowMs`: `holding` while an action it found is within the idle figure (the fact stays off until that action's
// figure has passed, with no scan between); `clear` while a scan that found none within the figure is under SCAN_STANDS_MS old; `none` once it has run out, when it failed
// or was never made, and when a clock that moved back has put it later than now.
const standingOf = (scan: Scan, nowMs: number): 'holding' | 'clear' | 'none' => {
  if (scan.kind !== 'done' || scan.atMs > nowMs || (scan.newestMs !== null && scan.newestMs > nowMs)) return 'none'
  if (scan.newestMs !== null && nowMs - scan.newestMs < IDLE_MS) return 'holding'
  return nowMs - scan.atMs < SCAN_STANDS_MS ? 'clear' : 'none'
}

// The rest fact: due when the rest has begun, a stop repays and every session has been idle the figure, held from this session's step until its user's next action whatever the
// cache has become since, none otherwise.
export const restFactOf = (i: RestInputs): RestFact => {
  if (setupOf(i) && i.read && heldOf(i)) return { kind: 'held', canAct: true }
  return { kind: readyOf(i) && standingOf(i.scan, i.nowMs) === 'clear' ? 'due' : 'none', canAct: canActOf(i) }
}

// Whether the tick must scan the other sessions' action times to decide: every other condition gives a due fact, and the scan on hand does not stand.
export const scanWanted = (i: RestInputs): boolean => readyOf(i) && standingOf(i.scan, i.nowMs) === 'none'

// The Keepalive section's `overnight:` row, after the `rest:` row: the window and the idle figure the step waits for, or `done` and its time once this session stepped today.
// No row while the option is off or no window is learned, and none where even the whole window leaves a stop too few periods to repay, which the row would promise.
export const overnightRowOf = (i: RestInputs): Line => {
  if (i.option !== 'on' || i.window === null) return ''
  const done = stepToday(i)
  if (done !== null) return labelled('overnight:', ` done ${timeOf(minuteOf(done))}`)
  if (!stopRepaysOf(i.cache, spanOf(i.window))) return ''
  return labelled('overnight:', ` ${windowTextOf(i.window)} · after ${IDLE_MS / MIN_MS}m idle${i.keepaliveOn ? '' : ' · only with keepalive on'}`)
}

// The sentence both notices end on.
const SWITCH_TEXT = 'Turn it off with the overnight option in /config.'

// The first notice, for the first time the step can act for the user: the window learned and what the step does inside it, worded with the figures the `overnight:` row states.
export const windowNoticeOf = (window: { opensMin: number; closesMin: number }): string =>
  `cachier: learned your daily rest, ${windowTextOf(window)}. After ${IDLE_MS / MIN_MS} min with no prompt in any session inside it, keepalive stops until your next prompt. ${SWITCH_TEXT}`

// The second notice, for the first time the step acts: the local time of the stop, as the row says it after the step.
export const stepNoticeOf = (stepMs: number): string =>
  `cachier: keepalive stopped for your daily rest at ${timeOf(minuteOf(stepMs))}; it resumes on your next prompt. ${SWITCH_TEXT}`
