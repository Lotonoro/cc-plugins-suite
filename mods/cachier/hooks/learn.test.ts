import { describe, expect, test } from 'claude-code/testing'
import { pieces } from './fixture'
import type { PauseRecord } from './history'
import { learnedLine as learnedLineRaw, learnedOf, looCosts, pauseCost, pausesCost, ttlAdviceOf, type Pricing } from './learn'
import { plainOf } from './sections'

// The learned line as the tests below read it: its text, a labelled line being its pieces joined. The pieces have their own test at the end.
const learnedLine = (...args: Parameters<typeof learnedLineRaw>) => plainOf(learnedLineRaw(...args))

const S = 1000
const MIN = 60 * S
// Opus 5.5 at 5m: a rewrite costs 24 pings over the read; a 15 s lead pings every 4:45.
const P: Pricing = { ttlMs: 300 * S, leadMs: 15 * S, ratio: 24 }
const BE = 24
const pause = (pausedMs: number, hour = 10, i = 0): PauseRecord => ({ startMs: i, pausedMs, hour, weekday: 2, ratio: 24, ttlMs: 300 * S })
const many = (lengths: number[], hour = 10) => lengths.map((l, i) => pause(l, hour, i))
const total = (h: PauseRecord[], c: number) => h.reduce((s, r) => s + pauseCost(c, r.pausedMs, P), 0)

describe('pauseCost: the pings fired before the return, plus a rewrite if the cache lapsed', () => {
  test('off costs a rewrite once the TTL passes, and nothing before', () => {
    expect(pauseCost(0, 299 * S, P)).toBe(0)
    expect(pauseCost(0, 300 * S, P)).toBe(24)
  })

  test('each ping fired before the return costs one, and the cache lapses after the last ping plus the TTL', () => {
    expect(pauseCost(3, 280 * S, P)).toBe(0)
    expect(pauseCost(3, 290 * S, P)).toBe(1)
    expect(pauseCost(3, 10 * MIN, P)).toBe(2)
    expect(pauseCost(3, 3 * 285 * S + 299 * S, P)).toBe(3)
    expect(pauseCost(3, 3 * 285 * S + 300 * S, P)).toBe(27)
  })
})

describe('learnedOf: the count that would have cost least, when the history beats break-even', () => {
  test('with no history, or one pause, break-even stands', () => {
    expect(learnedOf([], 10, BE, P)).toBeNull()
    expect(learnedOf([pause(2 * MIN)], 10, BE, P)).toBeNull()
  })

  test('pauses that mostly outlast any count learn no pings, and the card says how many ended within the TTL', () => {
    const h = many([...Array(8).fill(3 * 60 * MIN), 2 * MIN, 40 * MIN])
    const l = learnedOf(h, 10, BE, P)
    expect(l).toMatchObject({ count: 0, rule: 'all', within: 1, of: 10 })
    expect(learnedLine(l!, P.ttlMs)).toBe('learned: 0 refreshes · 1/10 pauses within 5:00 TTL')
  })

  test('half-hour pauses among a few long ones learn the pings that cover the half hour, not break-even', () => {
    const h = many([...[28, 29, 30, 30, 31, 29, 30, 28, 31, 30].map((m) => m * MIN), ...Array(3).fill(3 * 60 * MIN)])
    const l = learnedOf(h, 10, BE, P)
    // 6 pings keep the cache warm to 6 × 4:45 + 5:00.
    expect(l).toMatchObject({ count: 6, coverMs: 2010 * S, within: 10, of: 13 })
    expect(learnedLine(l!, P.ttlMs)).toBe('learned: 6 refreshes/pause · covers 33:30 · 10/13 pauses within')
  })

  test('half-hour pauses alone learn nothing: every count that covers them costs the same, so break-even stands', () => {
    expect(learnedOf(many(Array(10).fill(30 * MIN)), 10, BE, P)).toBeNull()
  })

  test("the hour's own pauses are used when they differ from the rest, and the line says so", () => {
    const h = [...many(Array(12).fill(3 * 60 * MIN), 14), ...many(Array(12).fill(30 * MIN), 9)]
    const afternoon = learnedOf(h, 14, BE, P)!
    expect(afternoon).toMatchObject({ count: 0, rule: 'hour', of: 12 })
    expect(learnedLine(afternoon, P.ttlMs)).toBe('learned (this hour): 0 refreshes · 0/12 pauses within 5:00 TTL')
    expect(learnedOf(h, 9, BE, P)).toBeNull()
  })

  test('the learned count never costs more over the history than break-even or keepalive off', () => {
    // A spread of pauses: short ones, half-hour ones, and a few past any count.
    const h = many([1, 2, 2, 3, 4, 6, 8, 12, 25, 30, 31, 45, 90, 180, 600].map((m) => m * MIN))
    const l = learnedOf(h, 10, BE, P)
    const c = l?.count ?? BE
    expect(total(h, c)).toBeLessThanOrEqual(total(h, BE))
    expect(total(h, c)).toBeLessThanOrEqual(total(h, 0))
  })

  test('leave-one-out: a learned rule is chosen only when it would have cost less on the pauses it did not see', () => {
    const steady = many(Array(10).fill(3 * 60 * MIN))
    const loo = looCosts(steady, BE, P)
    expect(loo.all).toBeLessThan(loo['break-even'])
    // Two pauses that disagree: the long one, held out, is priced at the count the short one learns, which is break-even.
    const split = many([2 * MIN, 3 * 60 * MIN])
    const disagree = looCosts(split, BE, P)
    expect(disagree.all).toBeGreaterThanOrEqual(disagree['break-even'])
    expect(learnedOf(split, 10, BE, P)).toBeNull()
  })

  test('a lead at or past the TTL learns nothing', () => {
    expect(learnedOf(many(Array(10).fill(2 * MIN)), 10, BE, { ...P, leadMs: 300 * S })).toBeNull()
  })
})

describe('ttlAdviceOf: the TTL that would have cost less over the recorded pauses', () => {
  // Opus 5.5 rates per token.
  const OPUS = { read: 2e-7, write5m: 5e-6, write1h: 8e-6 }
  const OFF = { on: false, pinned: null }
  const ON = { on: true, pinned: null }
  // The lead and pin a new session starts with, at which the other TTL is priced.
  const FRESH = { on: false, leadMs: 15 * S, pinned: null }
  const sized = (pausedMs: number, grownTokens: number, n = 10): PauseRecord[] =>
    Array.from({ length: n }, (_, i) => ({ ...pause(pausedMs, 10, i), contextTokens: 100000, grownTokens }))

  test('with keepalive off, twenty-minute pauses on a slowly growing context are cheaper at 1h', () => {
    // Per pause at 5m: a rewrite of 100k (24 reads over the read, $0.48) and 2k written ($0.01). At 1h: the 2k ($0.016).
    const a = ttlAdviceOf(sized(20 * MIN, 2000), OPUS, 15 * S, null, '5m', OFF, FRESH)!
    expect(a.better).toBe('1h')
    expect(Math.round(a.savedUsd * 100) / 100).toBe(4.74)
    expect(a.of).toBe(10)
  })

  test('short pauses on a fast-growing context stay at 5m; from 1h they say to go back, by the writes alone', () => {
    const h = sized(2 * MIN, 50000)
    expect(ttlAdviceOf(h, OPUS, 15 * S, null, '5m', OFF, FRESH)).toBeNull()
    const back = ttlAdviceOf(h, OPUS, 15 * S, null, '1h', OFF, FRESH)!
    // 50k written per pause at $8 rather than $5 per million.
    expect(back).toMatchObject({ better: '5m', of: 10 })
    expect(Math.round(back.savedUsd * 100) / 100).toBe(1.5)
  })

  test('with keepalive on, the pauses are priced at the pings it would send, so 1h saves less', () => {
    const off = ttlAdviceOf(sized(20 * MIN, 2000), OPUS, 15 * S, null, '5m', OFF, FRESH)!
    const on = ttlAdviceOf(sized(20 * MIN, 2000), OPUS, 15 * S, null, '5m', ON, FRESH)!
    // At 5m on, each twenty-minute pause fires 4 pings ($0.08) and keeps the cache: 1h still wins, by less.
    expect(on.better).toBe('1h')
    expect(Math.round(on.savedUsd * 100) / 100).toBe(0.74)
    expect(on.savedUsd).toBeLessThan(off.savedUsd)
    // A pinned 3 runs out at 19:15 at 5m, so each pause pays its 3 pings and the rewrite; at 1h none fires.
    const pinned = ttlAdviceOf(sized(20 * MIN, 2000), OPUS, 15 * S, null, '5m', { on: true, pinned: 3 }, FRESH)!
    expect(Math.round(pinned.savedUsd * 100) / 100).toBe(5.34)
  })

  test('the other TTL is priced with keepalive on or off as a new session starts it, not as this session runs it', () => {
    // 150-minute pauses with no growth: on 5 m each pays its rewrite ($0.48) with keepalive off, and with it on at the learned count of
    // none. At 1 h keepalive on holds each for two reads ($0.04); off, each pays the 1 h rewrite ($0.78).
    const pauses = sized(150 * MIN, 0)
    const onStart = { ...FRESH, on: true }
    expect(ttlAdviceOf(pauses, OPUS, 15 * S, null, '5m', OFF, onStart)).toMatchObject({ better: '1h', of: 10 })
    expect(Math.round(ttlAdviceOf(pauses, OPUS, 15 * S, null, '5m', OFF, onStart)!.savedUsd * 100) / 100).toBe(4.4)
    expect(ttlAdviceOf(pauses, OPUS, 15 * S, null, '5m', ON, FRESH)).toBeNull()
  })

  test('the other TTL is priced at a new session\'s lead and pin, since switching TTL starts one', () => {
    // 150-minute pauses with no growth, the count capped at 1, on 5 m at a 60 s lead pinned at 2: each pays two pings and the rewrite
    // ($0.52). At 1 h that run would hold each for two reads ($0.04), but a new session's 15 s lead and capped count cannot, so it learns
    // none and pays the 1 h rewrite ($0.78): 5 m stays.
    const pauses = sized(150 * MIN, 0)
    expect(ttlAdviceOf(pauses, OPUS, 60 * S, 1, '5m', { on: true, pinned: 2 }, { ...FRESH, on: true })).toBeNull()
    // Priced at the session's own run, 1 h would have won: the fresh run is what changes the answer.
    expect(ttlAdviceOf(pauses, OPUS, 60 * S, 1, '5m', { on: true, pinned: 2 }, { on: true, leadMs: 60 * S, pinned: 2 })).toMatchObject({ better: '1h' })
  })

  test('with keepalive off nothing pings, so a lead at or past the 5-minute TTL still prices both TTLs', () => {
    const a = ttlAdviceOf(sized(20 * MIN, 2000), OPUS, 400 * S, null, '5m', OFF, FRESH)!
    expect(a.better).toBe('1h')
    expect(Math.round(a.savedUsd * 100) / 100).toBe(4.74)
  })

  test('with keepalive on, a lead at or past a TTL sends no refresh at that TTL, so it is priced as keepalive off there', () => {
    const pauses = sized(20 * MIN, 2000)
    // The run pauses on its lead (keepalive.ts step), so at 5m every pause pays its rewrite, as with keepalive off.
    expect(pausesCost(pauses, pauses, '5m', OPUS, 400 * S, null, ON)).toBe(pausesCost(pauses, pauses, '5m', OPUS, 400 * S, null, OFF))
    const a = ttlAdviceOf(pauses, OPUS, 400 * S, null, '5m', ON, FRESH)!
    expect(a.better).toBe('1h')
    expect(Math.round(a.savedUsd * 100) / 100).toBe(4.74)
  })

  test('the counts learned from a history are learned once per hour and TTL, and shared by every pricing of that history', () => {
    const pauses = sized(20 * MIN, 2000)
    // The history is read through a proxy that counts its reads, so a learn that runs again shows.
    let reads = 0
    const history = new Proxy(sized(20 * MIN, 2000), { get: (t, k, r) => (reads++, Reflect.get(t, k, r)) })
    const at5m = pausesCost(pauses, history, '5m', OPUS, 15 * S, null, ON)
    const first = reads
    expect(first).toBeGreaterThan(0)
    // The TTL line and the sentence price the same history at the same inputs: no second learn.
    expect(pausesCost(pauses, history, '5m', OPUS, 15 * S, null, ON)).toBe(at5m)
    expect(reads).toBe(first)
    // Another TTL is another learn, and once learned it is shared too.
    pausesCost(pauses, history, '1h', OPUS, 15 * S, null, ON)
    const second = reads
    expect(second).toBeGreaterThan(first)
    pausesCost(pauses, history, '1h', OPUS, 15 * S, null, ON)
    expect(reads).toBe(second)
    // A new history, as a recorded pause makes, learns again.
    expect(pausesCost(pauses, [...pauses], '5m', OPUS, 15 * S, null, ON)).toBe(at5m)
  })

  test('the TTL line and the best-setup sentence price the same pauses alike: one pricing serves both', () => {
    const pauses = sized(20 * MIN, 2000)
    const off = pausesCost(pauses, pauses, '5m', OPUS, 15 * S, null, OFF)! - pausesCost(pauses, pauses, '1h', OPUS, 15 * S, null, OFF)!
    expect(ttlAdviceOf(pauses, OPUS, 15 * S, null, '5m', OFF, FRESH)!.savedUsd).toBe(off)
  })

  test('pauses recorded without their context are not priced, and with none there is no advice', () => {
    expect(ttlAdviceOf(many(Array(10).fill(20 * MIN)), OPUS, 15 * S, null, '5m', OFF, FRESH)).toBeNull()
    expect(ttlAdviceOf([], OPUS, 15 * S, null, '5m', OFF, FRESH)).toBeNull()
  })
})

describe('the learned line\'s label: the first, dim piece of the line, with its colon, and the rest one untoned piece', () => {
  test('learned: opens the line of a count learned from every pause, with no refreshes and with some', () => {
    const none = learnedOf(many([...Array(8).fill(3 * 60 * MIN), 2 * MIN, 40 * MIN]), 10, BE, P)!
    expect(learnedLineRaw(none, P.ttlMs)).toEqual(pieces('learned:', ' 0 refreshes · 1/10 pauses within 5:00 TTL'))
    const some = learnedOf(many([...[28, 29, 30, 30, 31, 29, 30, 28, 31, 30].map((m) => m * MIN), ...Array(3).fill(3 * 60 * MIN)]), 10, BE, P)!
    expect(learnedLineRaw(some, P.ttlMs)).toEqual(pieces('learned:', ' 6 refreshes/pause · covers 33:30 · 10/13 pauses within'))
  })

  test('learned (this hour): is the label of a count learned from the hour\'s own pauses', () => {
    const h = [...many(Array(12).fill(3 * 60 * MIN), 14), ...many(Array(12).fill(30 * MIN), 9)]
    expect(learnedLineRaw(learnedOf(h, 14, BE, P)!, P.ttlMs)).toEqual(pieces('learned (this hour):', ' 0 refreshes · 0/12 pauses within 5:00 TTL'))
  })
})
