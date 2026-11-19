import { describe, expect, test } from 'claude-code/testing'
import { COLOUR_SENTENCE, cacheLineOf, clockOf, cueOf, expiredAt, expiryOf, footerOf, glyphOf, labelled, pieOf, readingOf, refreshingOf, settleCold, touchedAt, touchOf, warmthOf, type PieState, type Run, type Tone } from './countdown'

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
    expect(readingOf(hour, null, null, T + 2700000, UPON)).toMatchObject({ quarter: 1 })
    expect(readingOf(hour, null, null, T + 2699999, UPON)).toMatchObject({ quarter: 2 })
    expect(readingOf(hour, null, null, T + 900000, UPON)).toMatchObject({ quarter: 3 })
    expect(readingOf(hour, null, null, T + 899999, UPON)).toMatchObject({ quarter: 4 })
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
    expect(readingOf({ kind: 'unread' }, null, COLD, T, UPON)).toMatchObject({ words: '', state: 'cold' })
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
    expect(footerOf(null, false)).toBeNull()
    expect(footerOf(null, true)).toEqual({ quarter: 0, words: 'no count', tone: 'on' })
  })

  test('a warm cache with keepalive on is green at every quarter and in the last tenth, the time after the pie', () => {
    expect(footerOf(warm, true)).toEqual({ quarter: 3, words: '3:12', tone: 'on' })
    expect(footerOf(quarter, true)).toEqual({ quarter: 1, words: '1:00', tone: 'on' })
    expect(footerOf(tenth, true)).toEqual({ quarter: 1, words: '0:20', tone: 'on' })
  })

  test('a warm cache with keepalive off is the normal text colour, then amber in the last quarter, then red in the last tenth', () => {
    expect(footerOf(warm, false)).toEqual({ quarter: 3, words: '3:12', tone: 'quiet' })
    expect(footerOf(quarter, false)).toEqual({ quarter: 1, words: '1:00', tone: 'warning' })
    expect(footerOf(tenth, false)).toEqual({ quarter: 1, words: '0:20', tone: 'alarm' })
  })

  test('an expired cache is green with keepalive on, and dim off, the rebuild figure beside its empty pie', () => {
    expect(footerOf(expired, true)).toEqual({ quarter: 0, words: '~$0.42 to rebuild', tone: 'on' })
    expect(footerOf(expired, false)).toEqual({ quarter: 0, words: '~$0.42 to rebuild', tone: 'gone' })
  })

  test('a cold cache is an empty pie with `reset`: green with keepalive on, dim off', () => {
    expect(footerOf(cold, true)).toEqual({ quarter: 0, words: 'reset', tone: 'on' })
    expect(footerOf(cold, false)).toEqual({ quarter: 0, words: 'reset', tone: 'gone' })
  })
})

describe('warmthOf: the Cache line\'s words after the pie, the cache\'s state with its figure when one is drawn', () => {
  test('a warm cache gives its time left and its TTL label', () => {
    expect(warmthOf(readingOf(known, null, null, T + 1000, UPON), '5m', UPON)).toBe('warm · 4:59 left · 5m TTL')
    expect(warmthOf(readingOf(hour, null, null, T + 1000, UPON), '1h', UPON)).toBe('warm · 59:59 left · 1h TTL')
  })

  test('an expired or reset cache gives the figure to rebuild it, and with no figure just its state', () => {
    const expired = readingOf(known, null, null, T + 300000, UPON)
    expect(warmthOf(expired, '5m', UPON)).toBe('expired · rebuild ~$0.42')
    expect(warmthOf(readingOf(known, null, COLD, T, UPON), '5m', UPON)).toBe('reset · rebuild ~$0.42')
    expect(warmthOf(readingOf(known, null, COLD, T, ''), '5m', '')).toBe('reset')
    expect(warmthOf(readingOf(known, null, null, T + 300000, ''), '5m', '')).toBe('expired')
  })

  test('with nothing to count there is no line', () => {
    expect(warmthOf(null, '5m', UPON)).toBe('')
    expect(warmthOf(readingOf(known, null, { reason: 'cleared', atMs: T }, T, UPON), '5m', UPON)).toBe('')
  })
})

describe('glyphOf: the pie\'s glyph by its quarter step', () => {
  test('empty at 0, a quarter fuller at each step, and full at 4', () => {
    expect([0, 1, 2, 3, 4].map(glyphOf)).toEqual(['○', '◔', '◑', '◕', '●'])
  })
})

// The Cache line's pieces from the reading and the pie's judgement of it. The expected glyph and tone are literals, not read from footerOf: the
// last test then holds the glyph and tone to the footer's own.
describe('cacheLineOf: the Cache line as pieces, the pie\'s glyph in the pie\'s tone and then a space and the warmth untoned', () => {
  const FIGURE = '$0.004/refresh'
  const fresh = readingOf(known, null, null, T + 1000, UPON)
  const warm = readingOf(known, null, null, T + 108000, UPON)
  const half = readingOf(known, null, null, T + 160000, UPON)
  const quarter = readingOf(known, null, null, T + 240000, UPON)
  const tenth = readingOf(known, null, null, T + 280000, UPON)
  const expired = readingOf(known, null, null, T + 300000, UPON)
  const cold = readingOf(known, null, COLD, T, UPON)
  type Case = {
    name: string
    reading: ReturnType<typeof readingOf>
    ttl?: '1h' | '5m'
    rebuild?: string
    on: boolean
    refresh?: string
    stopped?: boolean
    glyph: string
    tone: Tone
    rest: string
  }
  const cases: Case[] = [
    { name: 'a fresh cache, keepalive off: the full pie in the normal colour', reading: fresh, on: false, glyph: '●', tone: 'quiet', rest: 'warm · 4:59 left · 5m TTL' },
    { name: 'three quarters left, keepalive off', reading: warm, on: false, glyph: '◕', tone: 'quiet', rest: 'warm · 3:12 left · 5m TTL' },
    { name: 'two quarters left, keepalive off', reading: half, on: false, glyph: '◑', tone: 'quiet', rest: 'warm · 2:20 left · 5m TTL' },
    { name: 'the last quarter, keepalive off: amber', reading: quarter, on: false, glyph: '◔', tone: 'warning', rest: 'warm · 1:00 left · 5m TTL' },
    { name: 'the last tenth, keepalive off: red', reading: tenth, on: false, glyph: '◔', tone: 'alarm', rest: 'warm · 0:20 left · 5m TTL' },
    { name: 'a warm cache keepalive refreshes: green', reading: warm, on: true, refresh: FIGURE, glyph: '◕', tone: 'on', rest: 'warm · 3:12 left · 5m TTL' },
    { name: 'the last tenth keepalive refreshes: still green', reading: tenth, on: true, refresh: FIGURE, glyph: '◔', tone: 'on', rest: 'warm · 0:20 left · 5m TTL' },
    { name: 'keepalive on with no refresh to send, on a calm cache: green', reading: warm, on: true, glyph: '◕', tone: 'on', rest: 'warm · 3:12 left · 5m TTL' },
    { name: 'keepalive on with no refresh to send, in the last quarter: green', reading: quarter, on: true, glyph: '◔', tone: 'on', rest: 'warm · 1:00 left · 5m TTL' },
    { name: 'keepalive on with no refresh to send, in the last tenth: green', reading: tenth, on: true, glyph: '◔', tone: 'on', rest: 'warm · 0:20 left · 5m TTL' },
    { name: 'an expired cache, keepalive off: the empty pie, dim', reading: expired, on: false, glyph: '○', tone: 'gone', rest: 'expired · rebuild ~$0.42' },
    { name: 'an expired cache, keepalive on: the empty pie, green', reading: expired, on: true, glyph: '○', tone: 'on', rest: 'expired · rebuild ~$0.42' },
    { name: 'a reset cache, keepalive off: the empty pie, dim', reading: cold, on: false, glyph: '○', tone: 'gone', rest: 'reset · rebuild ~$0.42' },
    { name: 'a reset cache, keepalive on: the empty pie, green', reading: cold, on: true, glyph: '○', tone: 'on', rest: 'reset · rebuild ~$0.42' },
    { name: 'a reset cache, keepalive on and a stop recorded: the empty pie, still green', reading: cold, on: true, stopped: true, glyph: '○', tone: 'on', rest: 'reset · rebuild ~$0.42' },
    { name: 'a reset cache with no rebuild figure: the state alone after the pie', reading: readingOf(known, null, COLD, T, ''), rebuild: '', on: false, glyph: '○', tone: 'gone', rest: 'reset' },
    { name: 'a 1h TTL', reading: readingOf(hour, null, null, T + 1000, UPON), ttl: '1h', on: false, glyph: '●', tone: 'quiet', rest: 'warm · 59:59 left · 1h TTL' },
  ]
  const lineOf = (c: Case) => cacheLineOf(c.reading, c.ttl ?? '5m', c.rebuild ?? UPON, pieOf(c.reading, c.on, c.refresh ?? null, c.stopped ?? false))

  for (const c of cases) {
    test(c.name, () => {
      expect(lineOf(c)).toEqual([{ text: c.glyph, tone: c.tone }, { text: ` ${c.rest}`, tone: 'quiet' }])
    })
  }

  test('the pieces joined are the glyph, a space and the warmth line', () => {
    for (const c of cases) {
      const text = lineOf(c)?.map((run) => run.text).join('')
      expect(text).toBe(`${c.glyph} ${warmthOf(c.reading, c.ttl ?? '5m', c.rebuild ?? UPON)}`)
    }
  })

  test('with nothing to count there is no line, whatever keepalive and a recorded stop say, and none after a /clear', () => {
    for (const [on, stopped] of [[false, false], [true, false], [true, true]] as const) expect(cacheLineOf(null, '5m', UPON, pieOf(null, on, null, stopped))).toBeNull()
    const cleared = readingOf(known, null, { reason: 'cleared', atMs: T }, T, UPON)
    expect(cacheLineOf(cleared, '5m', UPON, pieOf(cleared, false, null, false))).toBeNull()
    expect(cacheLineOf(cleared, '5m', UPON, pieOf(cleared, true, FIGURE, false))).toBeNull()
  })

  test('the glyph and its tone are the footer\'s pie\'s, from the one judgement', () => {
    for (const c of cases) {
      const pie = pieOf(c.reading, c.on, c.refresh ?? null, c.stopped ?? false)
      expect(pie.footer).not.toBeNull()
      expect(lineOf(c)?.[0]).toEqual({ text: glyphOf(pie.footer!.quarter), tone: pie.footer!.tone })
    }
  })

  test('the colour sentence is drawn exactly when keepalive is off, so a glyph in amber or red always stands beside the sentence naming those colours', () => {
    for (const c of cases) {
      const pie = pieOf(c.reading, c.on, c.refresh ?? null, c.stopped ?? false)
      expect(pie.colour !== null).toBe(!c.on)
      if (c.tone === 'warning' || c.tone === 'alarm') expect(pie.colour).not.toBeNull()
    }
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
    expect(settleCold({ reason: 'model switch', atMs: T + 5000 }, known, T + 4000)).toEqual({ reason: 'model switch', atMs: T + 5000 })
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

// The pie's whole judgement from its inputs. Each reading is taken through readingOf from a view, a touch, a clock and a cold mark, so
// the quarter and tenth boundaries are readingOf's own. The expected tone, state and whether the sentence shows are literals, not derived from
// footerOf or from the entry. Each case lists, in order: keepalive off with no refresh figure, off with a figure, on with none, on with one.
// With keepalive on the tone is green whatever the reading and the figure, and the sentence is absent; with it off the tone is the reading's own
// and the sentence is present, with a reading or without one.
describe('pieOf: the pie\'s tone, its keepalive state and the colour sentence, from the reading, keepalive, and the refresh figure', () => {
  const FIGURE = '$0.004/refresh'
  const COMBOS = [
    { on: false, refresh: null },
    { on: false, refresh: FIGURE },
    { on: true, refresh: null },
    { on: true, refresh: FIGURE },
  ]
  type Expected = [tone: Tone | null, state: PieState | null, sentence: boolean]
  const cases: { name: string; reading: ReturnType<typeof readingOf>; expected: [Expected, Expected, Expected, Expected] }[] = [
    { name: 'no cache', reading: readingOf({ kind: 'no-cache' }, null, null, T, UPON), expected: [[null, null, true], [null, null, true], ['on', 'on', false], ['on', 'on', false]] },
    { name: 'cold', reading: readingOf(known, null, COLD, T + 1000, UPON), expected: [['gone', 'off', true], ['gone', 'off', true], ['on', 'on', false], ['on', 'on', false]] },
    { name: 'expired', reading: readingOf(known, null, null, T + 300000, UPON), expected: [['gone', 'off', true], ['gone', 'off', true], ['on', 'paused', false], ['on', 'paused', false]] },
    { name: 'warm, a fresh cache with the full pie', reading: readingOf(known, null, null, T + 1000, UPON), expected: [['quiet', 'off', true], ['quiet', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, calm', reading: readingOf(known, null, null, T + 100000, UPON), expected: [['quiet', 'off', true], ['quiet', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, just above a quarter left', reading: readingOf(known, null, null, T + 224999, UPON), expected: [['quiet', 'off', true], ['quiet', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, exactly a quarter left', reading: readingOf(known, null, null, T + 225000, UPON), expected: [['warning', 'off', true], ['warning', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, inside the last quarter', reading: readingOf(known, null, null, T + 250000, UPON), expected: [['warning', 'off', true], ['warning', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, just above a tenth left', reading: readingOf(known, null, null, T + 269999, UPON), expected: [['warning', 'off', true], ['warning', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, exactly a tenth left', reading: readingOf(known, null, null, T + 270000, UPON), expected: [['alarm', 'off', true], ['alarm', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, inside the last tenth', reading: readingOf(known, null, null, T + 290000, UPON), expected: [['alarm', 'off', true], ['alarm', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
  ]
  for (const { name, reading, expected } of cases) {
    test(`${name}: the tone, the state and the sentence for keepalive off and on, with and without a refresh figure`, () => {
      const drawn = COMBOS.map(({ on, refresh }) => {
        const pie = pieOf(reading, on, refresh, false)
        return [pie.footer?.tone ?? null, pie.state, pie.colour !== null]
      })
      expect(drawn).toEqual(expected)
    })
  }

  test('the sentence is the pane\'s words as pieces, and the footer is footerOf\'s, whatever the refresh figure', () => {
    const quarter = readingOf(known, null, null, T + 250000, UPON)
    expect(pieOf(quarter, false, null, false).colour).toEqual(COLOUR_SENTENCE)
    expect(COLOUR_SENTENCE.map((run) => run.text).join('')).toBe('pie: amber ≤¼ TTL left, red ≤⅒')
    expect(pieOf(quarter, true, FIGURE, false).footer).toEqual(footerOf(quarter, true))
    expect(pieOf(quarter, true, null, false).footer).toEqual(footerOf(quarter, true))
    expect(pieOf(null, false, null, false)).toEqual({ footer: null, state: null, colour: COLOUR_SENTENCE })
  })

  // The footer's tones at the quarter and tenth steps are `warning` and `alarm`, which the sentence's two colour words take, so the legend and the pie agree. The
  // expectation is written here, not read from the sentence or the footer's table: any other tone on any piece fails it. The label `pie:` opens the sentence as
  // its one dim piece, and every piece after it but the two colour words is quiet.
  test('the sentence opens with the dim label `pie:`, tones `amber` warning and `red` alarm, and every other piece quiet', () => {
    expect(COLOUR_SENTENCE[0]).toEqual({ text: 'pie:', tone: 'gone' })
    expect(COLOUR_SENTENCE.slice(1).filter((run) => run.tone !== 'quiet')).toEqual([{ text: 'amber', tone: 'warning' }, { text: 'red', tone: 'alarm' }])
    expect(COLOUR_SENTENCE.slice(1).map((run) => run.text)).toEqual([' ', 'amber', ' ≤¼ TTL left, ', 'red', ' ≤⅒'])
  })

  test('each call hands out its own pieces, so a line changed in place leaves the sentence and the next call alone', () => {
    const first = pieOf(null, false, null, false).colour!
    first[0]!.text = 'changed'
    first.pop()
    expect(pieOf(null, false, null, false).colour).toEqual(COLOUR_SENTENCE)
    expect(COLOUR_SENTENCE.map((run) => run.text).join('')).toBe('pie: amber ≤¼ TTL left, red ≤⅒')
  })
})

describe('pieOf with a recorded stop standing: the tone and the colour sentence as with no stop, and the hover paused beside reset or no count with keepalive on', () => {
  const FIGURE = '$0.004/refresh'
  const COMBOS = [
    { on: false, refresh: null },
    { on: false, refresh: FIGURE },
    { on: true, refresh: null },
    { on: true, refresh: FIGURE },
  ]
  type Expected = [tone: Tone | null, state: PieState | null, sentence: boolean]
  const cases: { name: string; reading: ReturnType<typeof readingOf>; expected: [Expected, Expected, Expected, Expected] }[] = [
    { name: 'no cache', reading: readingOf({ kind: 'no-cache' }, null, null, T, UPON), expected: [[null, null, true], [null, null, true], ['on', 'paused', false], ['on', 'paused', false]] },
    { name: 'cold', reading: readingOf(known, null, COLD, T + 1000, UPON), expected: [['gone', 'off', true], ['gone', 'off', true], ['on', 'paused', false], ['on', 'paused', false]] },
    { name: 'expired', reading: readingOf(known, null, null, T + 300000, UPON), expected: [['gone', 'off', true], ['gone', 'off', true], ['on', 'paused', false], ['on', 'paused', false]] },
    { name: 'warm, a fresh cache with the full pie', reading: readingOf(known, null, null, T + 1000, UPON), expected: [['quiet', 'off', true], ['quiet', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, calm', reading: readingOf(known, null, null, T + 100000, UPON), expected: [['quiet', 'off', true], ['quiet', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, two quarters left', reading: readingOf(known, null, null, T + 160000, UPON), expected: [['quiet', 'off', true], ['quiet', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, inside the last quarter', reading: readingOf(known, null, null, T + 250000, UPON), expected: [['warning', 'off', true], ['warning', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
    { name: 'warm, inside the last tenth', reading: readingOf(known, null, null, T + 290000, UPON), expected: [['alarm', 'off', true], ['alarm', 'off', true], ['on', 'paused', false], ['on', 'on', false]] },
  ]
  for (const { name, reading, expected } of cases) {
    test(`${name}: the tone, the state and the sentence for keepalive off and on, with and without a refresh figure, under a stop`, () => {
      const drawn = COMBOS.map(({ on, refresh }) => {
        const pie = pieOf(reading, on, refresh, true)
        return [pie.footer?.tone ?? null, pie.state, pie.colour !== null]
      })
      expect(drawn).toEqual(expected)
    })
  }

  test('a stop changes no tone and no sentence, for any reading, keepalive and figure, and the state only from on to paused, over reset or no count with keepalive on', () => {
    for (const { reading } of cases) {
      for (const { on, refresh } of COMBOS) {
        const free = pieOf(reading, on, refresh, false)
        const stopped = pieOf(reading, on, refresh, true)
        expect(stopped.footer).toEqual(free.footer)
        expect(stopped.colour).toEqual(free.colour)
        const empty = reading === null || reading.state === 'cold'
        expect(stopped.state).toBe(on && empty ? 'paused' : free.state)
      }
    }
  })
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

describe('touchOf, touchedAt and clockOf', () => {
  test('the touch is the later of the reply start and the live start, and none for a view that is not known', () => {
    expect(touchOf(known, null)).toBe(T)
    expect(touchOf(known, T + 5)).toBe(T + 5)
    expect(touchOf(known, T - 5)).toBe(T)
    expect(touchOf({ kind: 'unread' }, T)).toBeNull()
  })
  test('a reply stamp ahead of the clock counts as now, and any other view is left as it is', () => {
    expect(touchedAt(known, T - 10)).toEqual({ ...known, touchMs: T - 10 })
    expect(touchedAt(known, T)).toBe(known)
    const none = { kind: 'no-cache' as const }
    expect(touchedAt(none, T)).toBe(none)
  })
  test('a span reads m:ss under an hour and h:mm:ss past it', () => {
    expect(clockOf(0)).toBe('0:00')
    expect(clockOf(59_999)).toBe('0:59')
    expect(clockOf(3_599_000)).toBe('59:59')
    expect(clockOf(3_600_000)).toBe('1:00:00')
    expect(clockOf(3_723_000)).toBe('1:02:03')
  })
})

describe('labelled: a labelled line\'s pieces, the label dim and the rest after it', () => {
  const run = (text: string, tone: Tone = 'quiet'): Run => ({ text, tone })

  test('a rest given as text is one untoned piece after the label\'s one dim piece, and the pieces joined are the label then the rest', () => {
    const pieces = labelled('last refresh:', ' 18000 read · 0 written')
    expect(pieces).toEqual([run('last refresh:', 'gone'), run(' 18000 read · 0 written')])
    expect(pieces.map((piece) => piece.text).join('')).toBe('last refresh: 18000 read · 0 written')
  })

  test('a label keeps its colon where it has one and its words alone where it has none, and the constructor adds nothing of its own', () => {
    expect(labelled('next in', ' 4:44 · 3 left').map((piece) => piece.text)).toEqual(['next in', ' 4:44 · 3 left'])
    expect(labelled('learned (this hour):', ' 2 refreshes/pause').map((piece) => piece.text)).toEqual(['learned (this hour):', ' 2 refreshes/pause'])
    expect(labelled('saves', ' ~$0.12 vs 1h/off').map((piece) => piece.tone)).toEqual(['gone', 'quiet'])
  })

  test('a rest given as pieces is kept as given, in order, after the label\'s dim piece', () => {
    const rest = [run(' '), run('amber', 'warning'), run(' ≤¼'), run('red', 'alarm')]
    const pieces = labelled('pie:', rest)
    expect(pieces).toEqual([run('pie:', 'gone'), ...rest])
    expect(pieces.slice(1)).toEqual(rest)
  })
})
