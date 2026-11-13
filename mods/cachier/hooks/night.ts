// The user's daily rest, read from the pauses every session recorded: when it falls on the clock, how well the pauses show it, and the window it leaves inside
// its margins. Pure: it takes pause records and no engine handle, and register.ts holds the reading beside the history it was read from.
//
// A rest is a gap of idleness on one timeline of every recorded moment (each pause's start and its end), whatever the hour. The habit is the 4 hour arc of the
// clock that holds the most rest starts of the newest 14; only its rests give a window, and only once there are 7 of them. Every start and end is read as minutes
// after the arc's anchor, so nothing wraps around midnight or noon.

import { labelled, type Run } from './countdown'
import type { PauseRecord } from './history'
import { percentileOf } from './rank'

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
