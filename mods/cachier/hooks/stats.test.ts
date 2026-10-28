import { describe, expect, test } from 'claude-code/testing'
import type { CacheView, Spend, StatsState, TallyState } from '../types'
import { ZERO_TALLY } from './keepalive'
import { NO_SPEND, PRICES, TOKENS, type Money } from './prices'
import { foldStatsEvents, INITIAL_STATS, p90Of, pendingFor, rundownSections, sessionLineOf } from './stats'
import type { History, Response } from './transcript'

const T = Date.parse('2026-10-18T10:00:00.000Z')
const MIN = 60000
const TTL = 300000

// A main-thread response: its input is the fixed 8 the fixture gives every reply; read and write are the cache's.
const resp = (atMs: number, id: string, read: number, write: number, ttlMs: number | null = TTL): Response => ({
  messageId: id,
  timestampMs: atMs,
  input: 8,
  read,
  write,
  write5m: write,
  write1h: 0,
  ttlMs,
  model: null,
  speed: null,
})
const history = (responses: Response[], recount = false) => ({ responses, recount })
const foldStats = (s: StatsState, h: History): StatsState => foldStatsEvents(s, h, {}).state
// Spends as the counts hold them with no price list: tokens read, or written at 5 m, and no dollars.
const r = (read: number): Spend => ({ ...NO_SPEND, read, usd: null, why: 'no price for an unnamed model' })
const w = (write5m: number): Spend => ({ ...NO_SPEND, write5m, usd: null, why: 'no price for an unnamed model' })
const NONE = { count: 0, spend: NO_SPEND }
// Whether a section's lines carry a line with this text. The rundown is read by section: the pauses under Keepalive, the misses under Advice.
const carries = (lines: string[], text: string) => lines.some((line) => line.includes(text))
const known = (touchMs: number): CacheView => ({ kind: 'known', touchMs, ttlMs: TTL, ttlLabel: '5m', promptTokens: 1, outputTokens: 0, model: null, speed: null })
// The rundown in tokens; the dollar wording has its own tests.
const tally = (pings: number, tokens: number): TallyState => ({
  pause: { pings, spend: r(tokens) },
  session: { pings, spend: r(tokens) },
  raisedMs: null,
  epoch: 0,
})

describe('misses: a whole-context write after a context the cache no longer reads', () => {
  test('a warm turn that reads most of its context is not a miss', () => {
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 100000), resp(T + MIN, 'm2', 99000, 1000)]))
    expect(s.misses.lapse.count + s.misses.cold.count + s.misses.unexplained.count).toBe(0)
  })

  test('a whole-context write after a gap longer than the TTL is a lapse miss, with the write as its tokens', () => {
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 50000), resp(T + 6 * MIN, 'm2', 0, 50008)]))
    expect(s.misses.lapse).toEqual({ count: 1, spend: w(50008) })
    expect(s.misses.cold.count + s.misses.unexplained.count).toBe(0)
  })

  test('a whole-context write inside the TTL after a cold mark is a cold miss', () => {
    const s = foldStats({ ...INITIAL_STATS, coldSince: [T + 30000] }, history([resp(T, 'm1', 0, 50000), resp(T + MIN, 'm2', 0, 50008)]))
    expect(s.misses.cold).toEqual({ count: 1, spend: w(50008) })
    expect(s.misses.lapse.count).toBe(0)
  })

  test('a whole-context write inside the TTL with no cold mark is unexplained', () => {
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 50000), resp(T + MIN, 'm2', 0, 50008)]))
    expect(s.misses.unexplained).toEqual({ count: 1, spend: w(50008) })
  })

  test('the first response of a transcript is never a miss, whatever it wrote', () => {
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 50000)]))
    expect(s.misses.lapse.count + s.misses.cold.count + s.misses.unexplained.count).toBe(0)
  })

  test('a cold mark consumed by a response is not reused for a later miss', () => {
    const s = foldStats({ ...INITIAL_STATS, coldSince: [T + 30000] }, history([resp(T, 'm1', 0, 50000), resp(T + MIN, 'm2', 50000, 100)]))
    expect(s.coldSince).toEqual([])
  })
})

describe('the miss test and the pause test at their boundaries', () => {
  test('a response with no tokens at all is not a miss', () => {
    const empty = { ...resp(T + 6 * MIN, 'm2', 0, 0), input: 0 }
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 50000), empty]))
    expect(s.misses.lapse.count + s.misses.cold.count + s.misses.unexplained.count).toBe(0)
  })

  test('a read above half the previous context is not a miss, even when most of the context is rewritten', () => {
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 100000), resp(T + 6 * MIN, 'm2', 60000, 70000)]))
    expect(s.misses.lapse.count + s.misses.cold.count + s.misses.unexplained.count).toBe(0)
  })

  test('a write under half its context is not a miss, even after a gap longer than the TTL', () => {
    const s = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 100000), resp(T + 6 * MIN, 'm2', 40000, 30000)]))
    expect(s.misses.lapse.count + s.misses.cold.count + s.misses.unexplained.count).toBe(0)
  })

  test('a prompt exactly at the cache expiry is not after it: the pings were not needed', () => {
    const p = { spend: r(1000), touchMs: T, ttlMs: TTL, promptMs: T + TTL }
    const s = foldStats({ ...INITIAL_STATS, pending: p }, history([resp(T + TTL + 1000, 'm1', 40000, 1000)]))
    expect(s.notNeeded).toEqual({ count: 1, spend: r(1000) })
    expect(s.saved.count).toBe(0)
  })
})

describe('a miss other than a lapse is not the pings running out', () => {
  test('a model switch during a pinged pause is a cold miss even past the TTL, and the pause is not classified', () => {
    const pending = { spend: r(1000), touchMs: T, ttlMs: TTL, promptMs: T + 400000 }
    const s = foldStats({ ...INITIAL_STATS, pending, coldSince: [T + 399000] }, history([resp(T, 'm0', 0, 50000), resp(T + 401000, 'm1', 0, 50008)]))
    expect(s.misses.cold).toEqual({ count: 1, spend: w(50008) })
    expect(s.ranOut.count).toBe(0)
    expect(s.saved.count).toBe(0)
    expect(s.notNeeded.count).toBe(0)
    expect(s.pending).toBeNull()
  })

  test('an unexplained miss after the pings is not classified either', () => {
    const pending = { spend: r(1000), touchMs: T, ttlMs: TTL, promptMs: T + 100000 }
    const s = foldStats({ ...INITIAL_STATS, pending }, history([resp(T, 'm0', 0, 50000), resp(T + 101000, 'm1', 0, 50008)]))
    expect(s.misses.unexplained.count).toBe(1)
    expect(s.ranOut.count).toBe(0)
    expect(s.notNeeded.count).toBe(0)
    expect(s.pending).toBeNull()
  })
})

describe('pauses: a pending record is classified by the first response after its prompt', () => {
  const pending = { spend: r(1000), touchMs: T, ttlMs: TTL, promptMs: T + 400000 }

  test('a prompt after the cache would have expired, answered from the cache, is saved, with the avoided write as the context', () => {
    const s = foldStats({ ...INITIAL_STATS, pending }, history([resp(T + 401000, 'm1', 40000, 1000)]))
    expect(s.saved).toEqual({ count: 1, spend: r(1000), avoided: w(41008) })
    expect(s.pending).toBeNull()
  })

  test('a first response that wrote the cache is wasted and ran out, and the lapse it is also counted as is named as the overlap', () => {
    const s = foldStats({ ...INITIAL_STATS, pending }, history([resp(T, 'm0', 0, 50000), resp(T + 401000, 'm1', 0, 50008)]))
    expect(s.ranOut).toEqual({ count: 1, spend: r(1000) })
    expect(s.overlap).toBe(1)
    expect(s.misses.lapse.count).toBe(1)
    expect(s.pending).toBeNull()
  })

  test('a prompt before the cache would have expired, answered from the cache, is wasted and not needed', () => {
    const s = foldStats({ ...INITIAL_STATS, pending: { ...pending, promptMs: T + 100000 } }, history([resp(T + 101000, 'm1', 40000, 1000)]))
    expect(s.notNeeded).toEqual({ count: 1, spend: r(1000) })
    expect(s.saved.count).toBe(0)
  })

  test('the current pause is never classified: with no response after its prompt, the record waits', () => {
    const s = foldStats({ ...INITIAL_STATS, pending }, history([resp(T, 'm0', 0, 50000)]))
    expect(s.pending).toEqual(pending)
    expect(s.saved.count + s.ranOut.count + s.notNeeded.count).toBe(0)
  })

  test('a pause with no pings leaves no record, and neither does a pause whose view is not known', () => {
    expect(pendingFor({ pings: 0, spend: r(0) }, known(T), T)).toBeNull()
    expect(pendingFor({ pings: 2, spend: r(900) }, { kind: 'unread' }, T)).toBeNull()
    expect(pendingFor({ pings: 2, spend: r(900) }, known(T), T + 1)).toEqual({ spend: r(900), touchMs: T, ttlMs: TTL, promptMs: T + 1 })
  })
})

describe('the fold keeps its counters across reads', () => {
  test('a miss is an event with its time, cause, read, write and gap', () => {
    const { events } = foldStatsEvents(INITIAL_STATS, history([resp(T, 'm1', 0, 50000), resp(T + MIN, 'm2', 0, 50008)]), {})
    expect(events).toEqual([{ atMs: T + MIN, cause: 'unexplained', read: 0, write: 50008, gapMs: MIN }])
  })

  test('a recount counts only the responses it has not counted, and logs none twice', () => {
    const counted = { ...INITIAL_STATS, lastAtMs: T + 6 * MIN, lastTotal: 50008, lastTtlMs: TTL }
    const out = foldStatsEvents(counted, history([resp(T, 'm1', 0, 50000), resp(T + 6 * MIN, 'm2', 0, 50008)], true), {})
    expect(out.events).toEqual([])
    expect(out.state.misses.lapse.count).toBe(0)
  })

  test('an incremental fold adds to the counters and moves the cursor to the newest response', () => {
    const first = foldStats(INITIAL_STATS, history([resp(T, 'm1', 0, 50000)]))
    const next = foldStats(first, history([resp(T + 6 * MIN, 'm2', 0, 50008)]))
    expect(next.misses.lapse.count).toBe(1)
    expect(next.cursor).toBe('m2')
  })

  test('a recount keeps the pause outcomes and the cause of each old miss, and the pending record and cold marks', () => {
    const pending = { spend: r(1000), touchMs: T, ttlMs: TTL, promptMs: T + 400000 }
    const before: StatsState = {
      ...INITIAL_STATS,
      cursor: 'm2',
      lastAtMs: T + 6 * MIN,
      lastTotal: 50008,
      lastTtlMs: TTL,
      saved: { count: 2, spend: r(5), avoided: w(9) },
      misses: { lapse: NONE, cold: { count: 1, spend: w(50008) }, unexplained: NONE },
      pending,
      coldSince: [T + 1],
    }
    const s = foldStats(before, history([resp(T, 'm1', 0, 50000), resp(T + 6 * MIN, 'm2', 0, 50008)], true))
    expect(s.saved.count).toBe(2)
    expect(s.misses.cold).toEqual({ count: 1, spend: w(50008) })
    expect(s.misses.unexplained.count).toBe(0)
    expect(s.pending).toEqual(pending)
    expect(s.coldSince).toEqual([T + 1])
  })
})

describe('the details pane\'s session line, and the bare command', () => {
  test('with no session refresh the session line is empty', () => {
    expect(sessionLineOf(tally(0, 0), TOKENS)).toBe('')
  })

  test('the session line states this session\'s refreshes and their cost, with no pause, raised lead or history in it', () => {
    const t: TallyState = { pause: { pings: 2, spend: r(30000) }, session: { pings: 3, spend: r(60000) }, raisedMs: 16000, epoch: 0 }
    expect(sessionLineOf(t, TOKENS)).toBe('This session: 3 refreshes costing ~60k tokens read.')
  })

  test('the bare command names what each wasted pause was, with a hint for the larger kind', () => {
    const s: StatsState = { ...INITIAL_STATS, ranOut: { count: 2, spend: r(2000) }, notNeeded: { count: 1, spend: r(1000) } }
    expect(carries(rundownSections(tally(0, 0), s, TOKENS).keepalive, 'most wasted pauses ran out: your pauses outlast the refreshes')).toBe(true)
    const other: StatsState = { ...INITIAL_STATS, ranOut: { count: 1, spend: r(1000) }, notNeeded: { count: 3, spend: r(3000) } }
    expect(carries(rundownSections(tally(0, 0), other, TOKENS).keepalive, 'most wasted pauses were not needed: refreshes fire just before you return')).toBe(true)
  })

  test('the bare command prints no stat that has nothing to report: a session with none has empty sections', () => {
    expect(rundownSections(ZERO_TALLY_TALLY, INITIAL_STATS, TOKENS)).toEqual({ keepalive: [], advice: [] })
    const saved = rundownSections(tally(0, 0), { ...INITIAL_STATS, saved: { count: 1, spend: r(0), avoided: w(0) } }, TOKENS)
    expect(carries([...saved.keepalive, ...saved.advice], 'wasted')).toBe(false)
  })

  test('the Keepalive lines name each kind of wasted pause with its refresh tokens, and the saved write with its avoided tokens', () => {
    const { keepalive } = rundownSections(tally(0, 0), {
      ...INITIAL_STATS,
      saved: { count: 1, spend: r(1000), avoided: w(41008) },
      ranOut: { count: 2, spend: r(2000) },
      notNeeded: { count: 1, spend: r(1000) },
    }, TOKENS)
    expect(carries(keepalive, '1 write avoided, ~41k tokens written')).toBe(true)
    expect(carries(keepalive, 'Earlier pauses: 2 wasted, ran out (refreshes ~2k tokens read)')).toBe(true)
    expect(carries(keepalive, 'Earlier pauses: 1 wasted, not needed (refreshes ~1k tokens read)')).toBe(true)
  })

  test('in tokens, one avoided write is worth as many refreshes as a write costs reads at the current price; an overlap with a lapse miss is named', () => {
    const s: StatsState = {
      ...INITIAL_STATS,
      saved: { count: 1, spend: r(1000), avoided: w(41008) },
      ranOut: { count: 1, spend: r(1000) },
      overlap: 1,
      misses: { lapse: { count: 1, spend: w(50008) }, cold: { count: 0, spend: w(0) }, unexplained: { count: 0, spend: w(0) } },
    }
    const priced = rundownSections(ZERO_TALLY_TALLY, s, { ...TOKENS, list: OPUS, model: 'claude-opus-5-5' }).keepalive
    expect(carries(priced, 'a write is worth about 25 refreshes')).toBe(true)
    expect(carries(priced, 'is also a wasted ran-out pause: one event, shown under both')).toBe(true)
    const unpriced = rundownSections(ZERO_TALLY_TALLY, s, TOKENS)
    expect(carries([...unpriced.keepalive, ...unpriced.advice], '≈')).toBe(false)
  })
})

const ZERO_TALLY_TALLY: TallyState = { pause: ZERO_TALLY, session: ZERO_TALLY, raisedMs: null, epoch: 0 }

// Opus 5.5 rates per token: input $4, 5 m write $5, 1 h write $8, read $0.20 per million.
const OPUS = PRICES
const DOLLARS: Money = { unit: 'dollars', list: OPUS, model: 'claude-opus-5-5', speed: 'standard', ttl: '5m' }
const opus = (atMs: number, id: string, read: number, write: number, ttlMs: number | null = TTL): Response => ({ ...resp(atMs, id, read, write, ttlMs), model: 'claude-opus-5-5', speed: 'standard' })

describe('the counts in dollars', () => {
  test('a miss is priced at the model that rewrote the cache, as it is counted, and its tokens stay counted', () => {
    const out = foldStatsEvents(INITIAL_STATS, history([opus(T, 'm1', 0, 50000), opus(T + 6 * MIN, 'm2', 0, 20000)]), OPUS).state
    expect(out.misses.lapse.count).toBe(1)
    expect(out.misses.lapse.spend.write5m).toBe(20000)
    expect(Math.round((out.misses.lapse.spend.usd ?? -1) * 1e9) / 1e9).toBe(0.1)
    expect(carries(rundownSections(ZERO_TALLY_TALLY, out, DOLLARS).advice, 'Cache misses: 1 (lapse 1), $0.10 rewritten')).toBe(true)
    expect(carries(rundownSections(ZERO_TALLY_TALLY, out, TOKENS).advice, 'Cache misses: 1 (lapse 1), ~20k tokens rewritten')).toBe(true)
  })

  test('a miss on a model with no price leaves the dollars unknown, and the line falls back to tokens', () => {
    const fable = (atMs: number, id: string, write: number): Response => ({ ...resp(atMs, id, 0, write), model: 'claude-nonesuch-1', speed: 'standard' })
    const out = foldStatsEvents(INITIAL_STATS, history([opus(T, 'm1', 0, 50000), fable(T + 6 * MIN, 'm2', 20000)]), OPUS).state
    expect(out.misses.lapse.spend).toMatchObject({ write5m: 20000, usd: null, why: 'no price for claude-nonesuch-1' })
    expect(carries(rundownSections(ZERO_TALLY_TALLY, out, DOLLARS).advice, 'Cache misses: 1 (lapse 1), ~20k tokens rewritten')).toBe(true)
  })

  test('a saved pause names what the pings cost, what the avoided write would have cost, and the net', () => {
    const pending = { spend: { ...NO_SPEND, read: 38000, usd: 0.0076 }, touchMs: T, ttlMs: TTL, promptMs: T + 400000 }
    const out = foldStatsEvents({ ...INITIAL_STATS, pending }, history([opus(T + 401000, 'm1', 39992, 0)]), OPUS).state
    expect(out.saved.avoided.write5m).toBe(40000)
    expect(carries(rundownSections(ZERO_TALLY_TALLY, out, DOLLARS).keepalive, 'Earlier pauses: 1 saved (refreshes $0.008; 1 write avoided, $0.20; net $0.19 saved)')).toBe(true)
  })

  test('a pause at a 1 h TTL is credited with a 1 h write', () => {
    const pending = { spend: r(1000), touchMs: T, ttlMs: 3600000, promptMs: T + 3700000 }
    const out = foldStatsEvents({ ...INITIAL_STATS, pending }, history([opus(T + 3701000, 'm1', 39992, 0, 3600000)]), OPUS).state
    expect(out.saved.avoided).toMatchObject({ write5m: 0, write1h: 40000 })
  })
})

// Long pauses: a gap longer than the TTL. The formula's boundaries at 5 m TTL and 15 s lead (285 s between pings).
describe('long pauses: the pings that cover a pause, the p90, and the fold', () => {
  const LEAD = 15000
  test('the p90 is the nearest rank: the ceil(0.9·n)-th smallest, so the max below ten gaps and the 9th of ten', () => {
    const mins = (k: number) => Array.from({ length: k }, (_, i) => (i + 1) * MIN)
    expect(p90Of(mins(9))).toBe(9 * MIN)
    expect(p90Of(mins(10))).toBe(9 * MIN)
    expect(p90Of(mins(20))).toBe(18 * MIN)
    expect(p90Of([9 * MIN, 1 * MIN, 5 * MIN])).toBe(9 * MIN)
  })

  test('the Keepalive lines carry the long pauses: their count, p90, mean and max', () => {
    const s = { ...INITIAL_STATS, lastTtlMs: TTL, longCount: 2, maxMs: 10 * MIN, longGaps: [6 * MIN, 10 * MIN] }
    expect(carries(rundownSections(tally(0, 0), s, TOKENS).keepalive, 'Long pauses: 2 · p90 10:00 · mean 8:00 · max 10:00')).toBe(true)
  })

  test('a gap exactly the TTL is not long; a gap one second longer is, and records its gap', () => {
    const history = { responses: [resp(T, 'a', 0, 0), resp(T + TTL, 'b', 0, 0), resp(T + 2 * TTL + 1000, 'c', 0, 0)], recount: false } as any
    const out = foldStatsEvents(INITIAL_STATS, history, {})
    expect(out.state.longCount).toBe(1)
    expect(out.state.longGaps).toEqual([TTL + 1000])
    expect(out.pauses).toEqual([{ atMs: T + 2 * TTL + 1000, gapMs: TTL + 1000 }])
  })

  test('the kept gaps are the last 100, and the count and the max are all-time', () => {
    // The first gap is the largest and the first to be dropped; the others are distinct, so a window or a first-100 cap shows.
    const responses = [resp(T, 'r0', 0, 0)]
    let at = T
    for (let i = 0; i < 102; i++) {
      at += i === 0 ? TTL + 500000 : TTL + 1000 + i
      responses.push(resp(at, `r${i + 1}`, 0, 0))
    }
    const out = foldStatsEvents(INITIAL_STATS, { responses, recount: false } as any, {})
    expect(out.state.longCount).toBe(102)
    expect(out.state.longGaps.length).toBe(100)
    expect(out.state.longGaps[0]).toBe(TTL + 1002)
    expect(out.state.longGaps[99]).toBe(TTL + 1101)
    // The 102nd fold runs after the first gap was evicted: a window's max would be the 100th gap, not the evicted first.
    expect(out.state.maxMs).toBe(TTL + 500000)
  })
})

