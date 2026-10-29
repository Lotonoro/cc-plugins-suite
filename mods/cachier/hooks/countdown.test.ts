import { describe, expect, test } from 'claude-code/testing'
import { COLOUR_SENTENCE, cueOf, expiredAt, expiryOf, footerOf, pieOf, readingOf, refreshingOf, settleCold, warmthOf, type Tone } from './countdown'

const T = 1_000_000
const known = { kind: 'known' as const, touchMs: T, ttlMs: 300000, ttlLabel: '5m' as const, promptTokens: 1, outputTokens: 0, model: null, speed: null }
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

describe('footerOf: the pie and its words, and the tone the pie is drawn in', () => {
  const warm = readingOf(known, null, null, T + 108000, UPON)
  const quarter = readingOf(known, null, null, T + 240000, UPON)
  const tenth = readingOf(known, null, null, T + 280000, UPON)
  const expired = readingOf(known, null, null, T + 300000, UPON)
  const cold = readingOf(known, null, COLD, T, UPON)

  test('with nothing to count, nothing is drawn unless keepalive is on, and then the pie with `no count`, in green', () => {
    expect(footerOf(null, false, false)).toBeNull()
    expect(footerOf(null, true, false)).toEqual({ quarter: 0, words: 'no count', tone: 'on' })
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

  test('a cold cache is an empty pie with `reset`: green with keepalive on, dim off', () => {
    expect(footerOf(cold, true, false)).toEqual({ quarter: 0, words: 'reset', tone: 'on' })
    expect(footerOf(cold, false, false)).toEqual({ quarter: 0, words: 'reset', tone: 'gone' })
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

// The pie's whole judgement from its three inputs. Each reading is taken through readingOf from a view, a touch, a clock and a cold mark, so
// the quarter and tenth boundaries are readingOf's own. The expected tone and whether the sentence shows are literals, not derived from
// footerOf or from the entry. Each case lists, in order: keepalive off with no refresh figure, off with a figure, on with none, on with one.
describe('pieOf: the pie\'s tone and the colour sentence, from the reading, keepalive, and the refresh figure', () => {
  const FIGURE = '$0.004/refresh'
  const COMBOS = [
    { on: false, refresh: null },
    { on: false, refresh: FIGURE },
    { on: true, refresh: null },
    { on: true, refresh: FIGURE },
  ]
  type Expected = [tone: Tone | null, sentence: boolean]
  const cases: { name: string; reading: ReturnType<typeof readingOf>; expected: [Expected, Expected, Expected, Expected] }[] = [
    { name: 'no cache', reading: readingOf({ kind: 'no-cache' }, null, null, T, UPON), expected: [[null, true], [null, true], ['on', false], ['on', false]] },
    { name: 'cold', reading: readingOf(known, null, COLD, T + 1000, UPON), expected: [['gone', true], ['gone', true], ['on', true], ['on', true]] },
    { name: 'expired', reading: readingOf(known, null, null, T + 300000, UPON), expected: [['gone', true], ['gone', true], ['alarm', true], ['alarm', true]] },
    { name: 'warm, calm', reading: readingOf(known, null, null, T + 100000, UPON), expected: [['quiet', true], ['quiet', true], ['quiet', true], ['on', false]] },
    { name: 'warm, just above a quarter left', reading: readingOf(known, null, null, T + 224999, UPON), expected: [['quiet', true], ['quiet', true], ['quiet', true], ['on', false]] },
    { name: 'warm, exactly a quarter left', reading: readingOf(known, null, null, T + 225000, UPON), expected: [['warning', true], ['warning', true], ['warning', true], ['on', false]] },
    { name: 'warm, inside the last quarter', reading: readingOf(known, null, null, T + 250000, UPON), expected: [['warning', true], ['warning', true], ['warning', true], ['on', false]] },
    { name: 'warm, just above a tenth left', reading: readingOf(known, null, null, T + 269999, UPON), expected: [['warning', true], ['warning', true], ['warning', true], ['on', false]] },
    { name: 'warm, exactly a tenth left', reading: readingOf(known, null, null, T + 270000, UPON), expected: [['alarm', true], ['alarm', true], ['alarm', true], ['on', false]] },
    { name: 'warm, inside the last tenth', reading: readingOf(known, null, null, T + 290000, UPON), expected: [['alarm', true], ['alarm', true], ['alarm', true], ['on', false]] },
  ]
  for (const { name, reading, expected } of cases) {
    test(`${name}: the tone and the sentence for keepalive off and on, with and without a refresh figure`, () => {
      const drawn = COMBOS.map(({ on, refresh }) => {
        const pie = pieOf(reading, on, refresh)
        return [pie.footer?.tone ?? null, pie.colour !== null]
      })
      expect(drawn).toEqual(expected)
    })
  }

  test('the sentence is the pane\'s words, and the footer is footerOf\'s over refreshingOf', () => {
    const quarter = readingOf(known, null, null, T + 250000, UPON)
    expect(pieOf(quarter, false, null).colour).toBe("The pie turns amber in the cache's last quarter and red in its last tenth: the cache is about to lapse.")
    expect(COLOUR_SENTENCE).toBe(pieOf(quarter, false, null).colour)
    expect(pieOf(quarter, true, FIGURE).footer).toEqual(footerOf(quarter, true, refreshingOf(true, quarter, FIGURE)))
    expect(pieOf(null, false, null)).toEqual({ footer: null, colour: COLOUR_SENTENCE })
  })
})

// The colour sentence's rule as a literal oracle: it shows exactly where no refresh is coming, that is, not refreshing, and either keepalive
// is off or a reading is held. Each reading lists, in order: keepalive off, on and refreshing, on and not refreshing. The expected values are
// literals, not derived from the rule.
describe('pieOf: the colour sentence as a literal oracle, by the reading and keepalive', () => {
  const FIGURE = '$0.004/refresh'
  const STATES: [boolean, string | null][] = [
    [false, null],
    [true, FIGURE],
    [true, null],
  ]
  const cases: { name: string; reading: ReturnType<typeof readingOf>; expected: [boolean, boolean, boolean] }[] = [
    { name: 'green, a warm reading calm', reading: readingOf(known, null, null, T + 100000, UPON), expected: [true, false, true] },
    { name: 'amber, a warm reading in the last quarter', reading: readingOf(known, null, null, T + 240000, UPON), expected: [true, false, true] },
    { name: 'red, a warm reading in the last tenth', reading: readingOf(known, null, null, T + 280000, UPON), expected: [true, false, true] },
    { name: 'cold', reading: readingOf(known, null, COLD, T + 1000, UPON), expected: [true, true, true] },
    { name: 'expired', reading: readingOf(known, null, null, T + 300000, UPON), expected: [true, true, true] },
    { name: 'no reading', reading: readingOf({ kind: 'no-cache' }, null, null, T, UPON), expected: [true, false, false] },
  ]
  for (const { name, reading, expected } of cases) {
    test(`${name}: the sentence by keepalive off, on and refreshing, and on and not refreshing`, () => {
      expect(STATES.map(([on, refresh]) => pieOf(reading, on, refresh).colour !== null)).toEqual(expected)
    })
  }
})

describe('cueOf: the glyph and tone after the footer words', () => {
  test('a running read is a dim cycle arrow, a landed one a check mark, a failed one an amber exclamation mark, and none is none', () => {
    expect(cueOf('reading')).toEqual({ glyph: '⟳', tone: 'dim' })
    expect(cueOf('landed')).toEqual({ glyph: '✓', tone: 'plain' })
    expect(cueOf('failed')).toEqual({ glyph: '!', tone: 'warning' })
    expect(cueOf(null)).toBeNull()
  })
})

describe('expiryOf and expiredAt: the one owner of the live cache\'s expiry', () => {
  test('each view with no touch has no expiry moment and is never expired', () => {
    for (const view of [{ kind: 'ttl-unknown' as const }, { kind: 'no-cache' as const }, { kind: 'unread' as const }]) {
      expect(expiryOf(view, null)).toBeNull()
      expect(expiryOf(view, T)).toBeNull()
      expect(expiredAt(view, null, T + 10_000_000)).toBe(false)
    }
  })
  test('the cache is expired at exactly the touch plus the TTL, and not one millisecond before', () => {
    expect(expiryOf(known, null)).toBe(T + 300000)
    expect(expiredAt(known, null, T + 300000)).toBe(true)
    expect(expiredAt(known, null, T + 299999)).toBe(false)
  })
  test('a live request start later than the reply\'s moves the moment; an earlier one changes nothing', () => {
    expect(expiredAt(known, T + 5000, T + 300000)).toBe(false)
    expect(expiryOf(known, T + 5000)).toBe(T + 305000)
    expect(expiryOf(known, T - 5000)).toBe(expiryOf(known, null))
  })
})
