import { describe, expect, test } from 'claude-code/testing'
import { pieces } from './fixture'
import type { PauseRecord } from './history'
import { COMPACT_FLOOR_TOKENS, compactionDueOf, IDLE_MS, overnightOf, overnightRowOf, restFactOf, restReadingOf, restsOf, scanWanted, SCAN_STANDS_MS, stepNoticeOf, windowNoticeOf, type RestInputs, type RestReading, type Scan, type StopCache } from './night'
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

describe('the option: only `off` turns the night step off', () => {
  test('an unset, empty or unknown value reads as on, and `off` as off', () => {
    for (const value of [undefined, null, '', 'on', 'ON', 'Off', ' off', 'off ', 'no', 'false', 0, 1, true, false]) expect(overnightOf(value)).toBe('on')
    expect(overnightOf('off')).toBe('off')
  })
})

// The rest fact: due, held or none, from the option, the window, the clock, the idle times and the step mark alone.
const WINDOW = { opensMin: 3 * 60 + 18, closesMin: 6 * 60 + 28 }
// A window across midnight, from 22:30 to 06:30.
const NIGHT_WINDOW = { opensMin: 22 * 60 + 30, closesMin: 6 * 60 + 30 }
const NOW = at(1, 4, 0)
// The cache a stop would let lapse. At the 5 m TTL a stop is asked to repay nothing; at the 1 h TTL it must, and `oneHour(n)` is a 1 h cache whose break-even count is n, or none.
const FIVE_MIN: StopCache = { ttlLabel: '5m', ttlMs: 5 * MIN, breakEven: 24 }
const oneHour = (breakEven: number | null): StopCache => ({ ttlLabel: '1h', ttlMs: H, breakEven })
// A scan made at `atMs` that found the newest action at `newestMs` (none by default), and one that found none.
const foundAt = (newestMs: number | null, atMs = NOW): Scan => ({ kind: 'done', atMs, newestMs })
const clearAt = (atMs: number): Scan => foundAt(null, atMs)
// Inputs for which every condition holds at `nowMs` (04:00 on day 1 unless given): a 5 m cache, the last request 40 minutes old, no action and no step, the step mark read, and a
// scan just made that found no action. Each test changes what it names.
const inputs = (over: Partial<RestInputs> = {}): RestInputs => {
  const nowMs = over.nowMs ?? NOW
  return { option: 'on', keepaliveOn: true, window: WINDOW, nowMs, cache: FIVE_MIN, touchMs: nowMs - 40 * MIN, read: true, stepMs: null, actionMs: null, scan: clearAt(nowMs), ...over }
}
const factOf = (over: Partial<RestInputs> = {}) => restFactOf(inputs(over))
const DUE = { kind: 'due', canAct: true }
const NONE = { kind: 'none', canAct: true }
const HELD = { kind: 'held', canAct: true }

describe('the idle figure and the scan: 30 minutes, and a clear scan stands for a minute', () => {
  test('the figures', () => {
    expect(IDLE_MS).toBe(30 * MIN)
    expect(SCAN_STANDS_MS).toBe(MIN)
  })
})

describe('the rest fact: due when every condition holds, none when any one fails', () => {
  test('every condition holding gives a due fact that can act', () => {
    expect(factOf()).toEqual(DUE)
  })

  test('the option off, no window, or keepalive off gives none, and the step cannot act', () => {
    expect(factOf({ option: 'off' })).toEqual({ kind: 'none', canAct: false })
    expect(factOf({ window: null })).toEqual({ kind: 'none', canAct: false })
    expect(factOf({ keepaliveOn: false })).toEqual({ kind: 'none', canAct: false })
  })

  test('the local time one minute before the window opens is none, and the minute it opens is due', () => {
    expect(factOf({ nowMs: at(1, 3, 17) })).toEqual(NONE)
    expect(factOf({ nowMs: at(1, 3, 17) + 59999 })).toEqual(NONE)
    expect(factOf({ nowMs: at(1, 3, 18) })).toEqual(DUE)
  })

  test('the minute the window closes is none, and the moment before it is due', () => {
    expect(factOf({ nowMs: at(1, 6, 28) - 1 })).toEqual(DUE)
    expect(factOf({ nowMs: at(1, 6, 28) })).toEqual(NONE)
  })

  test('a window from 22:30 to 06:30 is due at 00:10 and not at 12:00', () => {
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 0, 10) })).toEqual(DUE)
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 12, 0) })).toEqual(NONE)
    for (const [h, m, kind] of [[22, 29, 'none'], [22, 30, 'due'], [23, 59, 'due'], [0, 0, 'due'], [6, 29, 'due'], [6, 30, 'none']] as const) {
      expect([h, m, factOf({ window: NIGHT_WINDOW, nowMs: at(1, h, m) }).kind]).toEqual([h, m, kind])
    }
  })

  test('this session idle one minute short of the figure is none, and at the figure due', () => {
    expect(factOf({ touchMs: NOW - IDLE_MS + MIN })).toEqual(NONE)
    expect(factOf({ touchMs: NOW - IDLE_MS })).toEqual(DUE)
    // No known cache has no last request to count from, and one stamped after now is no idle time.
    expect(factOf({ touchMs: null })).toEqual(NONE)
    expect(factOf({ touchMs: NOW + MIN })).toEqual(NONE)
  })

  test('another session\'s action one minute inside the figure is none, and at the figure due', () => {
    expect(factOf({ scan: foundAt(NOW - IDLE_MS + MIN) })).toEqual(NONE)
    expect(factOf({ scan: foundAt(NOW - IDLE_MS) })).toEqual(DUE)
    expect(factOf({ scan: foundAt(NOW - 3 * H) })).toEqual(DUE)
  })

  test('this session\'s own action one minute inside the figure is none, and at the figure due', () => {
    expect(factOf({ actionMs: NOW - IDLE_MS + MIN })).toEqual(NONE)
    expect(factOf({ actionMs: NOW - IDLE_MS })).toEqual(DUE)
  })

  test('a scan not made, a scan that failed, and a clear scan a minute old are none; one a moment short of a minute is due', () => {
    expect(factOf({ scan: { kind: 'none' } })).toEqual(NONE)
    expect(factOf({ scan: { kind: 'failed' } })).toEqual(NONE)
    expect(factOf({ scan: clearAt(NOW - SCAN_STANDS_MS) })).toEqual(NONE)
    expect(factOf({ scan: clearAt(NOW - SCAN_STANDS_MS + 1) })).toEqual(DUE)
    // A scan stamped after now is a clock that moved back, which no scan stands for.
    expect(factOf({ scan: clearAt(NOW + 1) })).toEqual(NONE)
  })

  test('a step on today\'s local date holds the step off, and one dated yesterday does not, whatever the hours between', () => {
    // The user acted 20 minutes after the step and has been idle since, so only the step's date can hold today's step off. It is 02:00 on day 1.
    const after = (stepMs: number) => ({ nowMs: at(1, 2, 0), window: NIGHT_WINDOW, stepMs, actionMs: stepMs + 20 * MIN })
    expect(factOf(after(at(0, 22, 40)))).toEqual(DUE)
    expect(factOf(after(at(0, 23, 59)))).toEqual(DUE)
    expect(factOf(after(at(1, 0, 0)))).toEqual(NONE)
    expect(factOf(after(at(1, 0, 1)))).toEqual(NONE)
    expect(factOf({ ...after(at(1, 1, 0)), actionMs: at(1, 1, 20) })).toEqual(NONE)
  })

  test('a step mark not yet read gives none, held or not', () => {
    expect(factOf({ read: false })).toEqual(NONE)
    expect(factOf({ read: false, stepMs: NOW - 10 * MIN })).toEqual(NONE)
  })

  test('a step or an action stamped after now reads as absent: it holds nothing', () => {
    expect(factOf({ stepMs: NOW + H })).toEqual(DUE)
    expect(factOf({ actionMs: NOW + H })).toEqual(DUE)
  })

  test('can-act is true exactly when the option is on, keepalive is on and a window is learned, at the 5 m TTL, whatever else holds', () => {
    for (const option of ['on', 'off'] as const) {
      for (const keepaliveOn of [true, false]) {
        for (const window of [WINDOW, null]) {
          const want = option === 'on' && keepaliveOn && window !== null
          expect([option, keepaliveOn, window !== null, factOf({ option, keepaliveOn, window }).canAct]).toEqual([option, keepaliveOn, window !== null, want])
          // Outside the window, busy, and unread: can-act is about the setup, not the moment.
          expect(factOf({ option, keepaliveOn, window, nowMs: at(1, 12, 0), touchMs: null, read: false, scan: { kind: 'failed' } }).canAct).toBe(want)
        }
      }
    }
  })
})

describe('the rest fact: held from a step until the user\'s next action', () => {
  test('a step later than every action of this session holds, whether or not the session has acted before it', () => {
    expect(factOf({ stepMs: NOW - 10 * MIN })).toEqual(HELD)
    expect(factOf({ stepMs: NOW - 10 * MIN, actionMs: NOW - 20 * MIN })).toEqual(HELD)
  })

  test('an action later than the step ends it, and one in the same millisecond does too', () => {
    expect(factOf({ stepMs: NOW - 10 * MIN, actionMs: NOW - 10 * MIN + 1 })).toEqual(NONE)
    expect(factOf({ stepMs: NOW - 10 * MIN, actionMs: NOW - 10 * MIN })).toEqual(NONE)
  })

  test('it holds whatever the clock, the window, the idle times and the scan say', () => {
    const step = at(1, 11, 0)
    expect(factOf({ nowMs: at(1, 12, 0), stepMs: step, touchMs: at(1, 11, 59), scan: { kind: 'none' } })).toEqual(HELD)
    expect(factOf({ nowMs: at(1, 12, 0), stepMs: step, touchMs: null, scan: foundAt(at(1, 11, 59)) })).toEqual(HELD)
  })

  test('it holds on a step dated yesterday too, until an action', () => {
    expect(factOf({ nowMs: at(1, 4, 0), stepMs: at(0, 23, 0) })).toEqual(HELD)
    expect(factOf({ nowMs: at(1, 4, 0), stepMs: at(0, 23, 0), actionMs: at(0, 23, 10) })).toEqual(DUE)
  })

  test('it needs the step able to act: the option on, keepalive on and a window learned', () => {
    const held = { stepMs: NOW - 10 * MIN }
    expect(factOf({ ...held, option: 'off' })).toEqual({ kind: 'none', canAct: false })
    expect(factOf({ ...held, keepaliveOn: false })).toEqual({ kind: 'none', canAct: false })
    expect(factOf({ ...held, window: null })).toEqual({ kind: 'none', canAct: false })
  })

  test('after the action the day\'s step is used: the fact is none, not due', () => {
    expect(factOf({ stepMs: NOW - 90 * MIN, actionMs: NOW - 60 * MIN })).toEqual(NONE)
  })
})

// The window is 3 h 10 min, from 03:18 to 06:28: three whole hours at most, from its opening.
describe('the stop repays the rewrite it adds: at the 5 m TTL as it is built, at the 1 h TTL only with the break-even count of whole hours left in the window', () => {
  test('at the 5 m TTL the fact is due in a window of far fewer periods than the break-even count, and with the model unpriced', () => {
    // One hour is 12 periods of 5 minutes, against the 24 a refresh run sends.
    expect(factOf({ window: { opensMin: 4 * 60, closesMin: 5 * 60 }, nowMs: at(1, 4, 30) })).toEqual(DUE)
    expect(factOf({ cache: { ...FIVE_MIN, breakEven: null } })).toEqual(DUE)
  })

  test('at the 1 h TTL the fact is due while the whole hours left in the window are at least the break-even count, and not a millisecond after', () => {
    // Three hours are left at 03:28, the window closing at 06:28; at its opening, 3 h 10 min.
    expect(factOf({ nowMs: at(1, 3, 28), cache: oneHour(3) })).toEqual(DUE)
    expect(factOf({ nowMs: at(1, 3, 28) + 1, cache: oneHour(3) })).toEqual(NONE)
    expect(factOf({ nowMs: at(1, 3, 18), cache: oneHour(3) })).toEqual(DUE)
    // Two hours at 04:28 and one at 05:28; none to count in the last minute.
    expect(factOf({ nowMs: at(1, 4, 28), cache: oneHour(2) })).toEqual(DUE)
    expect(factOf({ nowMs: at(1, 4, 28) + 1, cache: oneHour(2) })).toEqual(NONE)
    expect(factOf({ nowMs: at(1, 5, 28), cache: oneHour(1) })).toEqual(DUE)
    expect(factOf({ nowMs: at(1, 5, 28) + 1, cache: oneHour(1) })).toEqual(NONE)
    expect(factOf({ nowMs: at(1, 6, 27), cache: oneHour(1) })).toEqual(NONE)
  })

  test('a window one hour short of the break-even count cannot act at any moment: none, and the step cannot act', () => {
    for (const nowMs of [at(1, 3, 18), at(1, 3, 28), at(1, 4, 0), at(1, 6, 27)]) expect(factOf({ nowMs, cache: oneHour(4) })).toEqual({ kind: 'none', canAct: false })
  })

  test('the window across midnight counts its hours across it: 22:30 to 06:30 is eight, seven are left at 23:30 and six at 00:30', () => {
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 23, 30), cache: oneHour(7) })).toEqual(DUE)
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 23, 30) + 1, cache: oneHour(7) })).toEqual(NONE)
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 0, 30), cache: oneHour(6) })).toEqual(DUE)
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 0, 30), cache: oneHour(7) })).toEqual(NONE)
    expect(factOf({ window: NIGHT_WINDOW, nowMs: at(1, 22, 30), cache: oneHour(8) })).toEqual(DUE)
    expect(factOf({ window: NIGHT_WINDOW, cache: oneHour(9) })).toEqual({ kind: 'none', canAct: false })
  })

  test('a 1 h cache with no price, and no known cache, repay nothing: none, and the step cannot act', () => {
    expect(factOf({ cache: oneHour(null) })).toEqual({ kind: 'none', canAct: false })
    expect(factOf({ cache: null })).toEqual({ kind: 'none', canAct: false })
  })

  test('can-act is the setup with a cache a stop repays, however late the clock or busy the session', () => {
    for (const [cache, want] of [[FIVE_MIN, true], [{ ...FIVE_MIN, breakEven: null }, true], [oneHour(3), true], [oneHour(4), false], [oneHour(null), false], [null, false]] as const) {
      expect([cache, factOf({ cache }).canAct]).toEqual([cache, want])
      expect([cache, factOf({ cache, nowMs: at(1, 12, 0), touchMs: null, read: false, scan: { kind: 'failed' } }).canAct]).toEqual([cache, want])
    }
  })

  test('a held fact holds whatever the cache says: the step was taken, and the user has not acted since', () => {
    const held = { stepMs: NOW - 10 * MIN }
    expect(factOf({ ...held, cache: oneHour(40) })).toEqual(HELD)
    expect(factOf({ ...held, cache: oneHour(null) })).toEqual(HELD)
    expect(factOf({ ...held, cache: null })).toEqual(HELD)
  })
})

describe('the scan: wanted only when everything else gives a due fact and the scan on hand does not stand', () => {
  test('no scan, a failed scan, a clear scan a minute old and a hold that has ended are each wanted', () => {
    expect(scanWanted(inputs({ scan: { kind: 'none' } }))).toBe(true)
    expect(scanWanted(inputs({ scan: { kind: 'failed' } }))).toBe(true)
    expect(scanWanted(inputs({ scan: clearAt(NOW - SCAN_STANDS_MS) }))).toBe(true)
    // A scan 25 minutes ago found an action 35 minutes ago: its hold ended five minutes ago, and a clear scan stands only for a minute.
    expect(scanWanted(inputs({ scan: foundAt(NOW - 35 * MIN, NOW - 25 * MIN) }))).toBe(true)
  })

  test('a clear scan that stands is not wanted again, and neither is a hold that has not ended', () => {
    expect(scanWanted(inputs({ scan: clearAt(NOW) }))).toBe(false)
    expect(scanWanted(inputs({ scan: clearAt(NOW - SCAN_STANDS_MS + 1) }))).toBe(false)
    // An action found 10 minutes ago, by a scan 5 minutes ago: the fact is held off for 20 minutes more with no scan between.
    const holding = inputs({ scan: foundAt(NOW - 10 * MIN, NOW - 5 * MIN) })
    expect(restFactOf(holding)).toEqual(NONE)
    expect(scanWanted(holding)).toBe(false)
    // Until the hold ends, and then at once.
    expect(scanWanted({ ...holding, nowMs: NOW + 20 * MIN - 1 })).toBe(false)
    expect(scanWanted({ ...holding, nowMs: NOW + 20 * MIN })).toBe(true)
  })

  test('an action found stamped after now stands for nothing', () => {
    expect(scanWanted(inputs({ scan: foundAt(NOW + H, NOW - 5 * MIN) }))).toBe(true)
  })

  test('nothing is wanted while any other condition fails', () => {
    const none: Scan = { kind: 'none' }
    for (const over of [
      { option: 'off' as const },
      { keepaliveOn: false },
      { window: null },
      { nowMs: at(1, 3, 17) },
      { nowMs: at(1, 6, 28) },
      { touchMs: NOW - IDLE_MS + MIN },
      { touchMs: null },
      { actionMs: NOW - IDLE_MS + MIN },
      { stepMs: at(1, 1, 0), actionMs: at(1, 2, 0) },
      { stepMs: NOW - 10 * MIN },
      { read: false },
      { cache: oneHour(4) },
      { cache: oneHour(null) },
      { cache: null },
    ]) {
      expect([over, scanWanted(inputs({ ...over, scan: none }))]).toEqual([over, false])
    }
  })

  test('at the 1 h TTL it is wanted while a stop would repay, and not a millisecond after', () => {
    const none: Scan = { kind: 'none' }
    expect(scanWanted(inputs({ scan: none, nowMs: at(1, 3, 28), cache: oneHour(3) }))).toBe(true)
    expect(scanWanted(inputs({ scan: none, nowMs: at(1, 3, 28) + 1, cache: oneHour(3) }))).toBe(false)
    expect(scanWanted(inputs({ scan: none, cache: FIVE_MIN }))).toBe(true)
  })
})

describe('the overnight row: its label dim, then the window and the idle figure, or the step\'s time', () => {
  const rowOf = (over: Partial<RestInputs> = {}) => overnightRowOf(inputs(over))

  test('with the option on and a window learned it states the window and the idle figure', () => {
    expect(rowOf()).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle'))
    expect(plainOf(rowOf({ window: NIGHT_WINDOW }))).toBe('overnight: 22:30–06:30 · after 30m idle')
  })

  test('with keepalive off it says the window acts only with keepalive on', () => {
    expect(rowOf({ keepaliveOn: false })).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle · only with keepalive on'))
  })

  test('once this session stepped today it says when', () => {
    expect(rowOf({ stepMs: at(1, 3, 19) })).toEqual(pieces('overnight:', ' done 03:19'))
    expect(rowOf({ stepMs: at(1, 0, 5), window: NIGHT_WINDOW })).toEqual(pieces('overnight:', ' done 00:05'))
    // Whether or not keepalive is on: the day's step was taken.
    expect(rowOf({ stepMs: at(1, 3, 19), keepaliveOn: false })).toEqual(pieces('overnight:', ' done 03:19'))
    // A step is the day's, held or not.
    expect(rowOf({ stepMs: at(1, 3, 19), actionMs: at(1, 3, 25) })).toEqual(pieces('overnight:', ' done 03:19'))
  })

  test('a step dated yesterday leaves the row at its window', () => {
    expect(rowOf({ stepMs: at(0, 23, 50) })).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle'))
  })

  test('with the option off, or no window learned, there is no row', () => {
    expect(rowOf({ option: 'off' })).toBe('')
    expect(rowOf({ window: null })).toBe('')
    expect(rowOf({ option: 'off', stepMs: at(1, 3, 19) })).toBe('')
    expect(rowOf({ window: null, stepMs: at(1, 3, 19) })).toBe('')
  })

  test('at the 1 h TTL it is there only where a stop in the window would repay: this window holds three hours, enough for three and not for four', () => {
    expect(rowOf({ cache: oneHour(3) })).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle'))
    expect(rowOf({ cache: oneHour(4) })).toBe('')
    expect(rowOf({ cache: oneHour(4), keepaliveOn: false })).toBe('')
    expect(rowOf({ cache: oneHour(3), keepaliveOn: false })).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle · only with keepalive on'))
    // The row is the window's, not the moment's: it stays after the moment when a stop would repay has passed.
    expect(rowOf({ cache: oneHour(3), nowMs: at(1, 5, 30) })).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle'))
  })

  test('at the 5 m TTL it is there as before, with the model unpriced too', () => {
    expect(rowOf({ cache: FIVE_MIN, window: { opensMin: 4 * 60, closesMin: 5 * 60 } })).toEqual(pieces('overnight:', ' 04:00–05:00 · after 30m idle'))
    expect(rowOf({ cache: { ...FIVE_MIN, breakEven: null } })).toEqual(pieces('overnight:', ' 03:18–06:28 · after 30m idle'))
  })

  test('a 1 h cache with no price, or no known cache, leaves no row', () => {
    expect(rowOf({ cache: oneHour(null) })).toBe('')
    expect(rowOf({ cache: null })).toBe('')
  })

  test('once this session stepped today it says when, whatever the cache', () => {
    for (const cache of [oneHour(40), oneHour(null), null]) expect(rowOf({ stepMs: at(1, 3, 19), cache })).toEqual(pieces('overnight:', ' done 03:19'))
  })
})

describe('the compaction floor: the smallest cached context the night step compacts', () => {
  test('the floor is 60,000 tokens', () => {
    expect(COMPACT_FLOOR_TOKENS).toBe(60000)
  })

  test('a context is compacted at the floor and not one token below it', () => {
    expect(compactionDueOf(COMPACT_FLOOR_TOKENS)).toBe(true)
    expect(compactionDueOf(COMPACT_FLOOR_TOKENS - 1)).toBe(false)
  })

  test('a larger context is compacted, and a smaller or an empty one is not', () => {
    for (const tokens of [COMPACT_FLOOR_TOKENS + 1, 200000, 1000000]) expect(compactionDueOf(tokens)).toBe(true)
    for (const tokens of [0, 1, 18579, 50000]) expect(compactionDueOf(tokens)).toBe(false)
  })
})

describe('the two notices: the lines the user is told once, with the window and the step time filled in', () => {
  test('the first states the learned window, the idle figure, that a conversation of 60,000 tokens or more is compacted, and the option that turns the step off', () => {
    expect(windowNoticeOf(WINDOW)).toBe(
      'cachier: learned your daily rest, 03:18–06:28. After 30 min with no prompt in any session inside it, keepalive stops until your next prompt, and a conversation of 60,000 tokens or more is compacted, which is not undone. Turn it off with the overnight option in /config.',
    )
    expect(windowNoticeOf(NIGHT_WINDOW)).toBe(
      'cachier: learned your daily rest, 22:30–06:30. After 30 min with no prompt in any session inside it, keepalive stops until your next prompt, and a conversation of 60,000 tokens or more is compacted, which is not undone. Turn it off with the overnight option in /config.',
    )
  })

  test('the figure the first states is the floor the step compacts from: a conversation of that many tokens is compacted and one a token shorter is not', () => {
    const [, figure] = windowNoticeOf(WINDOW).match(/a conversation of ([\d,]+) tokens or more is compacted/)!
    const stated = Number(figure!.replace(/,/g, ''))
    expect(stated).toBe(COMPACT_FLOOR_TOKENS)
    expect(compactionDueOf(stated)).toBe(true)
    expect(compactionDueOf(stated - 1)).toBe(false)
  })

  test('the second states the local time of the step, that the conversation was compacted, and the option that turns the step off', () => {
    expect(stepNoticeOf(at(1, 3, 19), true)).toBe(
      'cachier: keepalive stopped for your daily rest at 03:19 and the conversation was compacted; keepalive resumes on your next prompt. Turn it off with the overnight option in /config.',
    )
    expect(stepNoticeOf(at(1, 0, 5), true)).toBe(
      'cachier: keepalive stopped for your daily rest at 00:05 and the conversation was compacted; keepalive resumes on your next prompt. Turn it off with the overnight option in /config.',
    )
    expect(stepNoticeOf(at(1, 23, 59), true)).toBe(
      'cachier: keepalive stopped for your daily rest at 23:59 and the conversation was compacted; keepalive resumes on your next prompt. Turn it off with the overnight option in /config.',
    )
  })

  test('the second says nothing of a compaction where none stood', () => {
    expect(stepNoticeOf(at(1, 3, 19), false)).toBe('cachier: keepalive stopped for your daily rest at 03:19; keepalive resumes on your next prompt. Turn it off with the overnight option in /config.')
    expect(stepNoticeOf(at(1, 0, 5), false)).toBe('cachier: keepalive stopped for your daily rest at 00:05; keepalive resumes on your next prompt. Turn it off with the overnight option in /config.')
    expect(stepNoticeOf(at(1, 23, 59), false)).toBe('cachier: keepalive stopped for your daily rest at 23:59; keepalive resumes on your next prompt. Turn it off with the overnight option in /config.')
  })

  test('the window and the idle figure read as the overnight row states them', () => {
    for (const window of [WINDOW, NIGHT_WINDOW]) {
      const [, text, idle] = plainOf(overnightRowOf(inputs({ window }))).match(/^overnight: (\S+) · after (\d+)m idle$/)!
      expect(windowNoticeOf(window)).toContain(`daily rest, ${text}. `)
      expect(windowNoticeOf(window)).toContain(`After ${idle} min with no prompt`)
    }
  })

  test('the step time reads as the overnight row states it once the session has stepped', () => {
    for (const stepMs of [at(1, 3, 19), at(1, 0, 5)]) {
      const [, time] = plainOf(overnightRowOf(inputs({ stepMs }))).match(/^overnight: done (\S+)$/)!
      expect(stepNoticeOf(stepMs, true)).toContain(`daily rest at ${time} and `)
      expect(stepNoticeOf(stepMs, false)).toContain(`daily rest at ${time}; `)
    }
  })
})
