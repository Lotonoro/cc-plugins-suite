import { describe, expect, test } from 'claude-code/testing'
import { footerOf, readingOf, refreshingOf, settleCold, warmthOf } from './countdown'

const T = 1_000_000
const known = { kind: 'known' as const, touchMs: T, ttlMs: 300000, ttlLabel: '5m' as const, promptTokens: 1, model: null, speed: null }
const hour = { ...known, ttlMs: 3600000, ttlLabel: '1h' as const }
const COLD = { reason: 'model switch' as const, atMs: T }
const UPON = '~$0.42'

describe('readingOf: the countdown the pie and its time show', () => {
  test('a live touch later than the time read counts the full TTL: the full pie and its time, never past either', () => {
    expect(readingOf(known, T + 5000, null, T, UPON)).toEqual({ words: '5:00', state: 'warm', quarter: 4, warn: 'calm' })
  })
  test('a warm cache counts its TTL less the time since the touch, in m:ss, with its quarter step', () => {
    expect(readingOf(known, null, null, T + 1000, UPON)).toEqual({ words: '4:59', state: 'warm', quarter: 4, warn: 'calm' })
    expect(readingOf(known, null, null, T + 108000, UPON)).toEqual({ words: '3:12', state: 'warm', quarter: 3, warn: 'calm' })
  })

  test('a fraction of a second left still shows the second', () => {
    expect(readingOf(known, null, null, T + 299_500, UPON)).toMatchObject({ words: '0:01', quarter: 1, warn: 'tenth' })
  })

  test('the quarter step is the quarters left, rounded up, and steps at the quarter boundaries of a 5 m TTL', () => {
    expect(readingOf(known, null, null, T + 75000, UPON)).toMatchObject({ words: '3:45', quarter: 3 })
    expect(readingOf(known, null, null, T + 74999, UPON)).toMatchObject({ quarter: 4 })
    expect(readingOf(known, null, null, T + 150000, UPON)).toMatchObject({ quarter: 2 })
    expect(readingOf(known, null, null, T + 149999, UPON)).toMatchObject({ quarter: 3 })
    expect(readingOf(known, null, null, T + 150001, UPON)).toMatchObject({ quarter: 2 })
    expect(readingOf(known, null, null, T + 225000, UPON)).toMatchObject({ quarter: 1 })
    expect(readingOf(known, null, null, T + 224999, UPON)).toMatchObject({ quarter: 2 })
  })

  test('the quarter steps of a 1 h TTL fall at the same fractions, and past an hour the time is minutes', () => {
    expect(readingOf(hour, null, null, T, UPON)).toEqual({ words: '60:00', state: 'warm', quarter: 4, warn: 'calm' })
    expect(readingOf(hour, null, null, T + 1800000, UPON)).toMatchObject({ words: '30:00', quarter: 2 })
    expect(readingOf(hour, null, null, T + 3300000, UPON)).toMatchObject({ words: '5:00', quarter: 1 })
  })

  test('warn is last tenth at or under a tenth of the TTL, last quarter at or under a quarter, and calm above', () => {
    expect(readingOf(known, null, null, T + 224999, UPON)).toMatchObject({ warn: 'calm' })
    expect(readingOf(known, null, null, T + 225000, UPON)).toMatchObject({ warn: 'quarter' })
    expect(readingOf(known, null, null, T + 240000, UPON)).toMatchObject({ warn: 'quarter' })
    expect(readingOf(known, null, null, T + 269999, UPON)).toMatchObject({ warn: 'quarter' })
    expect(readingOf(known, null, null, T + 270000, UPON)).toMatchObject({ words: '0:30', warn: 'tenth' })
    expect(readingOf(hour, null, null, T + 2999999, UPON)).toMatchObject({ warn: 'quarter' })
    expect(readingOf(hour, null, null, T + 3240000, UPON)).toMatchObject({ words: '6:00', warn: 'tenth' })
  })

  test('at and past the TTL the cache is expired, and the rebuild figure follows as the figure to rebuild', () => {
    expect(readingOf(known, null, null, T + 300000, UPON)).toEqual({ words: '~$0.42 to rebuild', state: 'expired', quarter: 0, warn: 'calm' })
    expect(readingOf(known, null, null, T + 400000, '~29k tokens')).toEqual({ words: '~29k tokens to rebuild', state: 'expired', quarter: 0, warn: 'calm' })
  })

  test('a cold mark after a model switch or compaction is cold, with no words, whatever the reading', () => {
    expect(readingOf(known, null, COLD, T + 1000, UPON)).toEqual({ words: '', state: 'cold', quarter: 0, warn: 'calm' })
    expect(readingOf(known, null, { reason: 'compaction', atMs: T }, T + 1000, UPON)).toMatchObject({ words: '', state: 'cold' })
    expect(readingOf({ kind: 'ttl-unknown' }, null, COLD, T, UPON)).toMatchObject({ words: '', state: 'cold' })
  })

  test('nothing to count: no cache yet, a clear, a TTL unknown or unread', () => {
    expect(readingOf({ kind: 'no-cache' }, null, null, T, UPON)).toBeNull()
    expect(readingOf({ kind: 'ttl-unknown' }, null, null, T, UPON)).toBeNull()
    expect(readingOf({ kind: 'unread' }, null, null, T, UPON)).toBeNull()
    expect(readingOf(known, null, { reason: 'cleared', atMs: T }, T + 1000, UPON)).toBeNull()
  })

  test('a model switch before the first reply leaves nothing to count, since there is nothing to go cold', () => {
    expect(readingOf({ kind: 'no-cache' }, null, COLD, T + 1000, UPON)).toBeNull()
    expect(readingOf({ kind: 'no-cache' }, null, { reason: 'compaction', atMs: T }, T + 1000, UPON)).toBeNull()
  })
})

describe('footerOf: the pie and its time, and the tone the pie is drawn in', () => {
  const warm = readingOf(known, null, null, T + 108000, UPON)
  const quarter = readingOf(known, null, null, T + 240000, UPON)
  const tenth = readingOf(known, null, null, T + 280000, UPON)
  const expired = readingOf(known, null, null, T + 300000, UPON)
  const cold = readingOf(known, null, COLD, T, UPON)

  test('with nothing to count, nothing is drawn unless keepalive is on, and then the pie alone, in green', () => {
    expect(footerOf(null, false, false)).toBeNull()
    expect(footerOf(null, true, false)).toEqual({ quarter: 0, words: '', tone: 'on' })
  })

  test('a warm cache that keepalive will refresh is green at every quarter, the time after the pie', () => {
    expect(footerOf(warm, true, true)).toEqual({ quarter: 3, words: '3:12', tone: 'on' })
    expect(footerOf(tenth, true, true)).toMatchObject({ quarter: 1, tone: 'on' })
  })

  test('a warm cache with keepalive off is the normal text colour, then amber in the last quarter, then red in the last tenth', () => {
    expect(footerOf(warm, false, false)).toEqual({ quarter: 3, words: '3:12', tone: 'quiet' })
    expect(footerOf(quarter, false, false)).toEqual({ quarter: 1, words: '1:00', tone: 'warning' })
    expect(footerOf(tenth, false, false)).toEqual({ quarter: 1, words: '0:20', tone: 'alarm' })
  })

  test('a warm cache that keepalive is on but paused or spent for warns as an off one does', () => {
    expect(footerOf(warm, true, false)).toEqual({ quarter: 3, words: '3:12', tone: 'quiet' })
    expect(footerOf(quarter, true, false)).toEqual({ quarter: 1, words: '1:00', tone: 'warning' })
    expect(footerOf(tenth, true, false)).toEqual({ quarter: 1, words: '0:20', tone: 'alarm' })
  })

  test('an expired cache is red with keepalive on, and dim off, the rebuild figure beside its empty pie', () => {
    expect(footerOf(expired, true, false)).toEqual({ quarter: 0, words: '~$0.42 to rebuild', tone: 'alarm' })
    expect(footerOf(expired, false, false)).toEqual({ quarter: 0, words: '~$0.42 to rebuild', tone: 'gone' })
  })

  test('a cold cache is an empty pie with no words: green with keepalive on, dim off', () => {
    expect(footerOf(cold, true, false)).toEqual({ quarter: 0, words: '', tone: 'on' })
    expect(footerOf(cold, false, false)).toEqual({ quarter: 0, words: '', tone: 'gone' })
  })
})

describe('warmthOf: the details\' first line, the cache\'s warmth with its figure', () => {
  test('a warm cache gives its time left and its lifetime', () => {
    expect(warmthOf(readingOf(known, null, null, T + 1000, UPON), '5m', UPON)).toBe('Prompt cache warm, 4:59 left (5-minute cache)')
    expect(warmthOf(readingOf(hour, null, null, T + 1000, UPON), '1h', UPON)).toBe('Prompt cache warm, 59:59 left (1-hour cache)')
  })

  test('an expired or reset cache gives the figure to rebuild it, and with no figure just its state', () => {
    const expired = readingOf(known, null, null, T + 300000, UPON)
    expect(warmthOf(expired, '5m', UPON)).toBe('Prompt cache expired, ~$0.42 to rebuild.')
    expect(warmthOf(readingOf(known, null, COLD, T, UPON), '5m', UPON)).toBe('Prompt cache reset, ~$0.42 to rebuild.')
    expect(warmthOf(readingOf(known, null, COLD, T, ''), '5m', '')).toBe('Prompt cache reset.')
  })

  test('with nothing to count there is no line', () => {
    expect(warmthOf(null, '5m', UPON)).toBe('')
    expect(warmthOf(readingOf(known, null, { reason: 'cleared', atMs: T }, T, UPON), '5m', UPON)).toBe('')
  })
})

describe('refreshingOf: refreshing as the pie shows it', () => {
  test('on, with a figure, and a warm cache to refresh', () => {
    const warm = readingOf(known, null, null, T, UPON)
    expect(refreshingOf(true, warm, '$0.006/refresh')).toBe(true)
    expect(refreshingOf(false, warm, '$0.006/refresh')).toBe(false)
    expect(refreshingOf(true, warm, null)).toBe(false)
    expect(refreshingOf(true, readingOf(known, null, null, T + 300000, UPON), '$0.006/refresh')).toBe(false)
    expect(refreshingOf(true, null, '$0.006/refresh')).toBe(false)
  })
})

describe('settleCold', () => {
  test('a cold mark is lifted by a known touch made after it', () => {
    expect(settleCold({ reason: 'model switch', atMs: T - 5 }, known, null)).toBeNull()
  })

  test('a touch no later than the mark leaves it in place, as does a view with no touch', () => {
    expect(settleCold({ reason: 'compaction', atMs: T }, known, null)).toEqual({ reason: 'compaction', atMs: T })
    expect(settleCold({ reason: 'cleared', atMs: T }, { kind: 'no-cache' }, null)).toEqual({ reason: 'cleared', atMs: T })
  })

  test('no mark stays no mark', () => {
    expect(settleCold(null, known, null)).toBeNull()
  })

  test('a live request start later than the transcript touch lifts the cold mark', () => {
    expect(settleCold({ reason: 'model switch', atMs: T + 5000 }, known, T + 6000)).toBeNull()
  })

  test('a live touch before the mark leaves it in place', () => {
    expect(settleCold({ reason: 'model switch', atMs: T + 5000 }, known, T + 4000)).not.toBeNull()
  })
})

describe('the reading and a live request start', () => {
  test('a request started after the transcript touch moves the countdown to its own start', () => {
    expect(readingOf(known, T + 60000, null, T + 61000, UPON)).toMatchObject({ words: '4:59', quarter: 4 })
  })

  test('a transcript touch later than the live start is what counts', () => {
    expect(readingOf(known, T - 60000, null, T + 1000, UPON)).toMatchObject({ words: '4:59', quarter: 4 })
  })
})
