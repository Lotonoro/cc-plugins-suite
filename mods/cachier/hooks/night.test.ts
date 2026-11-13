import { describe, expect, test } from 'claude-code/testing'
import { pieces } from './fixture'
import type { PauseRecord } from './history'
import { restReadingOf, restsOf, type RestReading } from './night'
import { plainOf } from './sections'

const MIN = 60000
const H = 60 * MIN
const pad = (n: number): string => String(n).padStart(2, '0')

// Local time `h`:`m` on day `d`, day 0 being 5 January 2026. January keeps clear of every zone's change of clocks, so a span in milliseconds and the same span on the clock agree.
const at = (d: number, h: number, m = 0): number => new Date(2026, 0, 5 + d, h, m).getTime()
const hhmm = (ms: number): string => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`
const clockOf = (min: number): string => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`

const pause = (startMs: number, pausedMs: number): PauseRecord => ({ startMs, pausedMs, hour: new Date(startMs).getHours(), weekday: new Date(startMs).getDay(), ratio: null, ttlMs: 300000 })

// A stretch with no activity, from one moment to another.
type Span = [fromMs: number, toMs: number]

// The history of a user who is idle through each span, as one pause each, and active in between, as a one-minute pause at the top of each hour that no span covers: nothing
// but a span is a long gap.
const living = (spans: Span[]): PauseRecord[] => {
  const first = Math.min(...spans.map(([from]) => from))
  const last = Math.max(...spans.map(([, to]) => to))
  const active: PauseRecord[] = []
  for (let t = new Date(first - 3 * H).setMinutes(0, 0, 0); t <= last + 3 * H; t += H) {
    if (spans.every(([from, to]) => t + MIN <= from || t >= to)) active.push(pause(t, MIN))
  }
  return [...spans.map(([from, to]) => pause(from, to - from)), ...active]
}

// The spans of a routine: the rest of day `firstDay + i` begins `offset` minutes after `h`:`m` of that day and lasts `length` minutes.
type Shape = [offset: number, length: number]
const routine = (h: number, m: number, rests: Shape[], firstDay = 0): Span[] =>
  rests.map(([offset, length], i): Span => [at(firstDay + i, h, m) + offset * MIN, at(firstDay + i, h, m) + (offset + length) * MIN])
// `n` rests that all begin at `h`:`m` and last `length` minutes.
const same = (n: number, h: number, m: number, length: number, firstDay = 0): Span[] =>
  routine(h, m, Array.from({ length: n }, (): Shape => [0, length]), firstDay)

const readingOf = (spans: Span[]): RestReading => restReadingOf(living(spans))
const rowOf = (r: RestReading): string => plainOf(r.row)
// The window as `opens-closes` on the clock, or null for none.
const windowOf = (r: RestReading): string | null => (r.window === null ? null : `${clockOf(r.window.opensMin)}-${clockOf(r.window.closesMin)}`)

describe('a rest: a gap of 5 to 16 hours between recorded moments, at any hour of the day', () => {
  for (const hour of [0, 6, 12, 18]) {
    test(`a gap of 5, 10 or 16 hours from ${pad(hour)}:00 is a rest, and one of 4 h 59 min or 16 h 1 min is not`, () => {
      const from = at(0, hour)
      for (const hours of [5, 10, 16]) expect(restsOf([pause(from, hours * H)])).toEqual([{ startMs: from, endMs: from + hours * H }])
      expect(restsOf([pause(from, 5 * H - MIN)])).toEqual([])
      expect(restsOf([pause(from, 16 * H + MIN)])).toEqual([])
    })
  }

  test('moments from two sessions interleave into one timeline: a gap one session leaves while another is active is not a rest', () => {
    const night = pause(at(0, 1), 7 * H)
    expect(restsOf([night])).toHaveLength(1)
    // Another session answers for five minutes at 03:00.
    expect(restsOf([night, pause(at(0, 3), 5 * MIN)])).toEqual([])
    // Another session is active until 01:30: the rest begins when the last of them goes quiet.
    expect(restsOf([night, pause(at(0, 0), 90 * MIN)])).toEqual([{ startMs: at(0, 1, 30), endMs: at(0, 8) }])
  })

  test('the pauses may come in any order, and the rests come oldest first', () => {
    const records = [pause(at(2, 1), 7 * H), pause(at(0, 1), 7 * H), pause(at(1, 1), 6 * H)]
    expect(restsOf(records).map((rest) => rest.startMs)).toEqual([at(0, 1), at(1, 1), at(2, 1)])
  })
})

describe('the window: the habit\'s rests, at their 90th percentile of starts and 10th of ends, each less an hour', () => {
  test('8 rests from 01:00 to 08:00 open the window at 02:00 and close it at 07:00', () => {
    const r = readingOf(same(8, 1, 0, 420))
    expect(r.rests).toHaveLength(8)
    expect(r.habit).toHaveLength(8)
    expect(windowOf(r)).toBe('02:00-07:00')
    expect(rowOf(r)).toBe('rest: from ≤01:00 · back ≥08:00 · 8 rests')
  })

  test('a day-long gap and a weekend gap are not rests, and the window is the one the 8 rests give alone', () => {
    const nights: Span[] = [0, 2, 3, 4, 7, 8, 9, 10].map((d): Span => [at(d, 1), at(d, 8)])
    // 23 hours, from 23:00 to 22:00 the next day, and the weekend's 39: from Friday 23:00 to Sunday 14:00.
    const day: Span = [at(0, 23), at(1, 22)]
    const weekend: Span = [at(4, 23), at(6, 14)]
    const records = living([...nights, day, weekend])
    expect(restsOf(records).map((rest) => `${hhmm(rest.startMs)}-${hhmm(rest.endMs)}`)).toEqual(Array(8).fill('01:00-08:00'))
    expect(restReadingOf(records)).toEqual(readingOf(nights))
    expect(windowOf(restReadingOf(records))).toBe('02:00-07:00')
  })

  test('a night worker\'s rests, from 08:30 to 16:00, give a window in the daytime and never one between 18:00 and 06:00', () => {
    const r = readingOf(same(8, 8, 30, 450))
    expect(windowOf(r)).toBe('09:30-15:00')
    expect(rowOf(r)).toBe('rest: from ≤08:30 · back ≥16:00 · 8 rests')
    expect(r.window!.opensMin).toBeGreaterThanOrEqual(6 * 60)
    expect(r.window!.closesMin).toBeLessThanOrEqual(18 * 60)
  })

  test('8 rests from 01:00 to 08:00 and 4 afternoon gaps of 6 hours give the 01:00 habit\'s window, unchanged by the afternoon gaps', () => {
    const nights = same(8, 1, 0, 420)
    const afternoons: Span[] = [2, 3, 5, 6].map((d): Span => [at(d, 12), at(d, 18)])
    const r = readingOf([...nights, ...afternoons])
    expect(r.rests).toHaveLength(12)
    expect(r.habit.map((rest) => hhmm(rest.startMs))).toEqual(Array(8).fill('01:00'))
    expect(r.window).toEqual(readingOf(nights).window)
    expect(rowOf(r)).toBe(rowOf(readingOf(nights)))
  })

  test('a habit whose rests all end past midnight gives the window their lengths say', () => {
    // 9 hours from 22:00: the window is those 9 hours less an hour at each end, from 23:00 to 06:00.
    const r = readingOf(same(8, 22, 0, 540))
    expect(rowOf(r)).toBe('rest: from ≤22:00 · back ≥07:00 · 8 rests')
    expect(windowOf(r)).toBe('23:00-06:00')
    expect((r.window!.closesMin - r.window!.opensMin + 1440) % 1440).toBe(7 * 60)
  })

  test('7 rests from 19:30, six ending at 08:30 and one at 10:00, open the window at 20:30 and close it at 07:30', () => {
    const r = readingOf(routine(19, 30, [...Array.from({ length: 6 }, (): Shape => [0, 13 * 60]), [0, 14 * 60 + 30]]))
    expect(r.habit).toHaveLength(7)
    expect(rowOf(r)).toBe('rest: from ≤19:30 · back ≥08:30 · 7 rests')
    expect(windowOf(r)).toBe('20:30-07:30')
  })

  test('a habit straddling midnight, with starts from 23:00 to 01:00, gives its window with no wrap in the figures', () => {
    const r = readingOf(routine(23, 0, [0, 15, 30, 45, 60, 75, 90, 120].map((offset): Shape => [offset, 8 * 60])))
    expect(r.habit).toHaveLength(8)
    expect(rowOf(r)).toBe('rest: from ≤01:00 · back ≥07:00 · 8 rests')
    expect(windowOf(r)).toBe('02:00-06:00')
  })

  test('a habit straddling noon, with starts from 11:00 to 13:00, gives its window with no wrap in the figures', () => {
    const r = readingOf(routine(11, 0, [0, 15, 30, 60, 75, 90, 105, 120].map((offset): Shape => [offset, 6 * 60])))
    expect(r.habit).toHaveLength(8)
    expect(rowOf(r)).toBe('rest: from ≤13:00 · back ≥17:00 · 8 rests')
    expect(windowOf(r)).toBe('14:00-16:00')
  })

  test('minutes are whole: a start is read at its clock minute and a length in whole minutes, rounded down', () => {
    // Each rest begins at 01:00:30 and lasts 6 h 59 min 50 s: it begins in minute 01:00 and lasts 419 minutes, so by the figures it ends at 07:59, though it ends at 08:00:20.
    const r = readingOf(Array.from({ length: 7 }, (_, i): Span => [at(i, 1) + 30000, at(i, 1) + 30000 + 419 * MIN + 50000]))
    expect(rowOf(r)).toBe('rest: from ≤01:00 · back ≥07:59 · 7 rests')
    expect(windowOf(r)).toBe('02:00-06:59')
  })

  test('the percentiles of 12 rests: the 11th start and the 2nd end, as the README quotes the row', () => {
    // From 00:30, the starts' minutes after it: the 11th smallest is 108 (02:18); the ends, those plus each length: the smallest is 390 and the 2nd smallest 418 (07:28).
    const starts = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 108, 130]
    const lengths = [390, 480, 398, 480, 480, 480, 480, 480, 480, 480, 480, 480]
    const r = readingOf(routine(0, 30, starts.map((offset, i): Shape => [offset, lengths[i]!])))
    expect(r.habit).toHaveLength(12)
    expect(rowOf(r)).toBe('rest: from ≤02:18 · back ≥07:28 · 12 rests')
    expect(windowOf(r)).toBe('03:18-06:28')
  })
})

describe('the habit: the 4 hour arc of starts that holds the most of the newest 14 rests', () => {
  test('with 6 rests in the arc there is no window and the row counts them against the 7 it needs', () => {
    const r = readingOf(same(6, 1, 0, 420))
    expect(r.window).toBeNull()
    expect(rowOf(r)).toBe('rest: 6 of 7 seen')
    expect(r.row).toEqual(pieces('rest:', ' 6 of 7 seen'))
    // A seventh opens it.
    expect(readingOf(same(7, 1, 0, 420)).window).not.toBeNull()
  })

  test('the count is of the arc, not of every rest: rests elsewhere on the clock are not seen', () => {
    const afternoons: Span[] = [7, 8, 9].map((d): Span => [at(d, 12), at(d, 18)])
    const r = readingOf([...same(6, 1, 0, 420), ...afternoons])
    expect(r.rests).toHaveLength(9)
    expect(rowOf(r)).toBe('rest: 6 of 7 seen')
  })

  test('with no rest the row reads 0 of 7 seen', () => {
    const none = restReadingOf([])
    expect(none).toMatchObject({ rests: [], habit: [], window: null })
    expect(none.row).toEqual(pieces('rest:', ' 0 of 7 seen'))
    // Pauses with no gap of 5 hours between their moments leave no rest either.
    expect(rowOf(restReadingOf([pause(at(0, 1), 3 * H), pause(at(0, 4), 4 * H)]))).toBe('rest: 0 of 7 seen')
  })

  test('10 rests whose starts spread evenly over the clock fill no 4 hour arc with 7, and give no window', () => {
    // A start every 2 h 24 min: an arc of 4 hours holds two of them at most.
    const r = readingOf(routine(0, 0, Array.from({ length: 10 }, (_, i): Shape => [i * 144, 360])))
    expect(r.rests).toHaveLength(10)
    expect(r.window).toBeNull()
    expect(rowOf(r)).toBe('rest: 2 of 7 seen')
  })

  test('10 rests at 01:00 and then 7 at 09:00 give the 09:00 window: the newest 14 hold 7 of each, and the tie goes to the arc holding the newest rest', () => {
    const r = readingOf([...same(10, 1, 0, 420), ...same(7, 9, 0, 420, 10)])
    expect(r.rests).toHaveLength(14)
    expect(rowOf(r)).toBe('rest: from ≤09:00 · back ≥16:00 · 7 rests')
    expect(windowOf(r)).toBe('10:00-15:00')
  })

  test('with 6 rests at 09:00 the 01:00 window stands', () => {
    const r = readingOf([...same(10, 1, 0, 420), ...same(6, 9, 0, 420, 10)])
    expect(rowOf(r)).toBe('rest: from ≤01:00 · back ≥08:00 · 8 rests')
    expect(windowOf(r)).toBe('02:00-07:00')
  })

  test('14 rests alternating between 01:00 and 07:00 starts give the window of the arc holding the newest rest', () => {
    const alternating = (days: number[]): Span[] => days.map((d): Span => (d % 2 === 0 ? [at(d, 7), at(d, 13)] : [at(d, 1), at(d, 7)]))
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
    // The newest, on day 13, begins at 01:00.
    const newestAtOne = readingOf(alternating(range(0, 13)))
    expect(newestAtOne.rests).toHaveLength(14)
    expect(rowOf(newestAtOne)).toBe('rest: from ≤01:00 · back ≥07:00 · 7 rests')
    expect(windowOf(newestAtOne)).toBe('02:00-06:00')
    // The newest, on day 14, begins at 07:00.
    const newestAtSeven = readingOf(alternating(range(1, 14)))
    expect(rowOf(newestAtSeven)).toBe('rest: from ≤07:00 · back ≥13:00 · 7 rests')
    expect(windowOf(newestAtSeven)).toBe('08:00-12:00')
  })

  test('two arcs of 7, only one holding the newest rest: that one is the habit, though the other is anchored at newer rests', () => {
    // Six rests at 01:00, seven at 07:30, then the newest at 03:00. The arc from 01:00 holds its six and the newest; the arc from 07:30 holds its seven.
    const r = readingOf([...same(6, 1, 0, 420), ...same(7, 7, 30, 420, 6), ...same(1, 3, 0, 420, 13)])
    expect(r.rests).toHaveLength(14)
    expect(rowOf(r)).toBe('rest: from ≤03:00 · back ≥08:00 · 7 rests')
    expect(windowOf(r)).toBe('04:00-07:00')
  })

  test('two arcs of 7 that both hold the newest rest: the one anchored at the newest rest is the habit', () => {
    // Four rests at 01:00, then four at 08:00, then three at 04:30, the newest. The arc from 01:00 holds the 01:00 and 04:30 rests, the arc from 04:30 the 04:30 and 08:00 rests: 7 each.
    const r = readingOf([...same(4, 1, 0, 360), ...same(4, 8, 0, 360, 4), ...same(3, 4, 30, 360, 8)])
    expect(r.rests).toHaveLength(11)
    expect(rowOf(r)).toBe('rest: from ≤08:00 · back ≥10:30 · 7 rests')
    expect(windowOf(r)).toBe('09:00-09:30')
  })

  test('a rest exactly 4 hours after an anchor is inside its arc, and one 4 hours 1 minute after is not', () => {
    const withLate = (minutes: number) => readingOf([...same(7, 1, 0, 420), ...routine(1, 0, [[minutes, 360]], 7)])
    const inside = withLate(240)
    expect(inside.habit).toHaveLength(8)
    expect(rowOf(inside)).toBe('rest: from ≤05:00 · back ≥08:00 · 8 rests')
    const outside = withLate(241)
    expect(outside.rests).toHaveLength(8)
    expect(outside.habit).toHaveLength(7)
    expect(rowOf(outside)).toBe('rest: from ≤01:00 · back ≥08:00 · 7 rests')
  })

  test('the window is read over the newest 14 rests only', () => {
    // Six older rests begin at 04:00, inside the 01:00 arc, where the 14 newer begin at 01:00. Read with them, the 90th percentile of starts would be 04:00.
    const r = readingOf([...same(6, 4, 0, 420), ...same(14, 1, 0, 420, 6)])
    expect(r.rests).toHaveLength(14)
    expect(r.rests.every((rest) => hhmm(rest.startMs) === '01:00')).toBe(true)
    expect(rowOf(r)).toBe('rest: from ≤01:00 · back ≥08:00 · 14 rests')
    expect(windowOf(r)).toBe('02:00-07:00')
  })

  test('the reading does not depend on the order the pauses are given in', () => {
    const records = living([...same(10, 1, 0, 420), ...same(7, 9, 0, 420, 10)])
    const evensThenOdds = [...records.filter((_, i) => i % 2 === 0), ...records.filter((_, i) => i % 2 === 1)]
    expect(restReadingOf([...records].reverse())).toEqual(restReadingOf(records))
    expect(restReadingOf(evensThenOdds)).toEqual(restReadingOf(records))
  })
})

describe('no window: the margins meet', () => {
  // Rests of the minutes after 00:00 and lengths given; the last to begin is the 90th percentile of the starts of 7, and the shortest to end the 10th of the ends.
  test('margins that meet give no window, and the row says so', () => {
    const r = readingOf(routine(0, 0, [[0, 300], [30, 480], [60, 480], [90, 480], [120, 480], [150, 480], [190, 480]]))
    expect(r.habit).toHaveLength(7)
    expect(r.window).toBeNull()
    expect(rowOf(r)).toBe('rest: from ≤03:10 · back ≥05:00 · no window')
    expect(r.row).toEqual(pieces('rest:', ' from ≤03:10 · back ≥05:00 · no window'))
  })

  test('a window that would close the minute it opens is none, and one minute wider is a window of that minute', () => {
    // Six rests from 00:00 lasting 5 hours, and a seventh beginning `late` minutes after 00:00: it opens `late` + 60 minutes in and closes 240 minutes in.
    const edge = (late: number) => readingOf(routine(0, 0, [...Array.from({ length: 6 }, (): Shape => [0, 300]), [late, 480]]))
    expect(edge(180).window).toBeNull()
    expect(rowOf(edge(180))).toBe('rest: from ≤03:00 · back ≥05:00 · no window')
    expect(windowOf(edge(179))).toBe('03:59-04:00')
    expect(rowOf(edge(179))).toBe('rest: from ≤02:59 · back ≥05:00 · 7 rests')
  })
})

describe('the row: `rest:` as its dim label, then the figures as one untoned piece', () => {
  test('each form is the label and its rest, built through the label constructor', () => {
    expect(readingOf(same(3, 1, 0, 420)).row).toEqual(pieces('rest:', ' 3 of 7 seen'))
    expect(readingOf(same(8, 1, 0, 420)).row).toEqual(pieces('rest:', ' from ≤01:00 · back ≥08:00 · 8 rests'))
  })
})
