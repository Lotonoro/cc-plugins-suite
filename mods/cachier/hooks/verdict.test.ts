import { describe, expect, test } from 'claude-code/testing'
import type { CacheView } from '../types'
import { INITIAL } from './keepalive'
import { NO_SPEND, PRICES, type Money } from './prices'
import { breakEvenLine, countLineOf, judge, runCountOf, sessionBalanceLine, NO_JUDGED, pauseOf, rewriteSpendOf, verdictOf, type Pause } from './verdict'

// A 32k context on Opus 5.5 at list prices: a ping reads it at $0.20 per million, and a rewrite costs the 5 m write
// ($5 per million) over that read. A rewrite is worth 24 pings. The TTL is 5 m and the lead 15 s, so a ping every 285 s.
const PING = 32000 * 2e-7
const LAPSE = 32000 * (5e-6 - 2e-7)
const S = 1000
const base: Pause = { on: false, pausedMs: 0, ttlMs: 300 * S, leadMs: 15 * S, count: 3, pingUsd: PING, lapseUsd: LAPSE, spentUsd: 0, alive: true }

// With keepalive on: the pings that have fired by `t`, and whether they still hold the cache, as the session would record them.
const on = (t: number, count = 3): Pause => {
  const pings = Math.min(count, Math.floor(t / (285 * S)))
  return { ...base, on: true, count, pausedMs: t, spentUsd: pings * PING, alive: t < pings * 285 * S + 300 * S }
}
const off = (t: number, count = 3): Pause => ({ ...base, count, pausedMs: t, alive: t < 300 * S })

describe('verdictOf: is the toggle saving or wasting money right now, against the other way', () => {
  test('a pause that has cost nothing either way is on par, with keepalive on or off', () => {
    expect(verdictOf(on(0))).toBe('par')
    expect(verdictOf(off(284 * S))).toBe('par')
  })

  test('keepalive on saves once the cache would have lapsed without it, and wastes once its pings cost more than the rewrite', () => {
    // The first ping fires 15 s before the TTL: returning in that window, it was not needed.
    expect(verdictOf(on(290 * S, 30))).toBe('wasting')
    expect(verdictOf(on(300 * S, 30))).toBe('saving')
    // 24 pings cost what the rewrite does, so the 24th brings it to par and the 25th tips it.
    expect(verdictOf(on(24 * 285 * S - 1, 30))).toBe('saving')
    expect(verdictOf(on(24 * 285 * S, 30))).toBe('par')
    expect(verdictOf(on(25 * 285 * S, 30))).toBe('wasting')
  })

  test('keepalive on wastes once its count ran out and the cache lapsed anyway: it paid the pings and the rewrite', () => {
    expect(verdictOf(on(1154 * S))).toBe('saving')
    expect(verdictOf(on(1155 * S))).toBe('wasting')
  })

  test('keepalive off wastes once the cache lapses, and saves once the pings it skipped would have cost more', () => {
    expect(verdictOf(off(300 * S))).toBe('wasting')
    expect(verdictOf(off(24 * 285 * S - 1, 30))).toBe('wasting')
    expect(verdictOf(off(24 * 285 * S, 30))).toBe('par')
    expect(verdictOf(off(25 * 285 * S, 30))).toBe('saving')
    // With 3 pings, the cache would have lapsed after them too, so skipping them saved their cost.
    expect(verdictOf(off(1155 * S))).toBe('saving')
  })

  test('a lead at or past the TTL could not hold the cache, so the other reality costs the same and the verdict is par', () => {
    expect(verdictOf({ ...off(400 * S), leadMs: 300 * S })).toBe('par')
  })
})

describe('rewriteSpendOf: what the next prompt pays to write an expired cache again', () => {
  test('the view\'s context at its model\'s write rate for the TTL in force, priced in dollars', () => {
    const view = { kind: 'known' as const, touchMs: 0, ttlMs: 300 * S, ttlLabel: '5m' as const, promptTokens: 1000000, model: 'claude-opus-5-5', speed: null }
    // Opus 5.5 at $4 input: a 5 m write of a million tokens is $5.
    const micro = (usd: number | null) => Math.round((usd ?? -1) * 1e6) / 1e6
    expect(micro(rewriteSpendOf(view, { unit: 'dollars', list: PRICES, model: 'claude-opus-5-5', speed: null, ttl: '5m' }).usd)).toBe(5)
    expect(micro(rewriteSpendOf({ ...view, ttlLabel: '1h', ttlMs: 3600 * S }, { unit: 'dollars', list: PRICES, model: 'claude-opus-5-5', speed: null, ttl: '1h' }).usd)).toBe(8)
  })

  test('an unpriced model leaves the rewrite unpriced, and it is written in tokens', () => {
    const view = { kind: 'known' as const, touchMs: 0, ttlMs: 300 * S, ttlLabel: '5m' as const, promptTokens: 29000, model: 'claude-nonesuch-1', speed: null }
    const spend = rewriteSpendOf(view, { unit: 'dollars', list: PRICES, model: 'claude-nonesuch-1', speed: null, ttl: '5m' })
    expect(spend.usd).toBeNull()
    expect(spend.write5m).toBe(29000)
  })
})

describe("pauseOf: the pause from the session's state", () => {
  const LIST = PRICES
  const money: Money = { unit: 'dollars', list: LIST, model: 'claude-opus-5-5', speed: null, ttl: '5m' }
  const T = 1_800_000_000_000
  const view: CacheView = { kind: 'known', touchMs: T, ttlMs: 300 * S, ttlLabel: '5m', promptTokens: 32000, model: 'claude-opus-5-5', speed: null }
  const gap = INITIAL
  const defaults = { leadMs: 20 * S, count: null, cap: 4 }

  test('a pause in the idle gap is priced from the view and runs at the defaults while keepalive never ran', () => {
    const p = pauseOf(gap, view, null, NO_SPEND, money, defaults, T + 60 * S)
    expect(p).toMatchObject({ on: false, pausedMs: 60 * S, ttlMs: 300 * S, leadMs: 20 * S, count: 4, spentUsd: 0, alive: true })
    expect(Math.round(p!.pingUsd * 1e6)).toBe(6400)
    expect(Math.round(p!.lapseUsd * 1e6)).toBe(153600)
  })

  test("keepalive's own lead and count win over the last used, and those over the defaults; a 1h cache prices the 1h write", () => {
    const used = pauseOf({ ...gap, lastUsed: { leadMs: 30 * S, count: 2 } }, view, null, NO_SPEND, money, defaults, T)
    expect(used).toMatchObject({ on: false, leadMs: 30 * S, count: 2 })
    const running = pauseOf({ ...gap, config: { leadMs: 10 * S, count: 5 }, runCount: 5, lastUsed: { leadMs: 30 * S, count: 2 } }, view, null, NO_SPEND, money, defaults, T)
    expect(running).toMatchObject({ on: true, leadMs: 10 * S, count: 5 })
    const hour = pauseOf(gap, { ...view, ttlMs: 3600 * S, ttlLabel: '1h' }, null, NO_SPEND, money, defaults, T)
    expect(Math.round(hour!.lapseUsd * 1e6)).toBe(249600)
  })

  test('the pause is timed from the main thread, while a ping touch keeps the cache alive', () => {
    const p = pauseOf({ ...gap, config: { leadMs: 15 * S, count: 3 }, runCount: 3 }, view, T + 285 * S, NO_SPEND, money, defaults, T + 400 * S)
    expect(p).toMatchObject({ pausedMs: 400 * S, alive: true })
    expect(pauseOf(gap, view, null, NO_SPEND, money, defaults, T + 300 * S)!.alive).toBe(false)
  })

  test('the break-even window starts at the TTL and ends at the ping that tips past the rewrite, or where the count runs out', () => {
    // A rewrite is worth 24 pings: the 24th brings them even with it, at 24 × 280 s with a 20 s lead, so the window ends there.
    expect(breakEvenLine(gap, view, money, { leadMs: 20 * S, count: null, cap: 30 })).toBe("Keepalive pays off if you're back between 5:00 and 1:52:00")
    expect(breakEvenLine(gap, view, money, { leadMs: 20 * S, count: null, cap: null })).toBe("Keepalive pays off if you're back between 5:00 and 1:52:00")
    // With 4 pings the cache lapses at 4 × 280 s + 300 s.
    expect(breakEvenLine(gap, view, money, defaults)).toBe("Keepalive pays off if you're back between 5:00 and 23:40")
    // Keepalive's own run wins over the defaults; a 1h cache counts from its own TTL and write.
    expect(breakEvenLine({ ...gap, config: { leadMs: 15 * S, count: 3 }, runCount: 3 }, view, money, defaults)).toBe("Keepalive pays off if you're back between 5:00 and 19:15")
    expect(breakEvenLine(gap, { ...view, ttlMs: 3600 * S, ttlLabel: '1h' }, money, defaults)).toBe("Keepalive pays off if you're back between 1:00:00 and 4:58:40")
    // A rewrite worth 15.67 pings: the run sends 15, which never reach it, so the window runs on to the lapse after the 15th.
    const odd = { 'claude-opus-5-5': { ...PRICES['claude-opus-5-5']!, read: 3e-7 } }
    expect(runCountOf(null, view, { ...money, list: odd }, null)).toBe(15)
    expect(breakEvenLine(gap, view, { ...money, list: odd }, { leadMs: 20 * S, count: null, cap: null })).toBe("Keepalive pays off if you're back between 5:00 and 1:15:00")
  })

  test('a lead at or past the TTL never pays off; no warm cache or no price draws no line', () => {
    expect(breakEvenLine(gap, view, money, { leadMs: 300 * S, count: null, cap: 3 })).toBe("Keepalive doesn't pay off on this context")
    expect(breakEvenLine(gap, { kind: 'no-cache' }, money, defaults)).toBe('')
    expect(breakEvenLine(gap, view, { ...money, model: 'claude-nonesuch-1' }, defaults)).toBe('')
  })

  test('a run sends its pinned count, else the break-even count under the cap, else with no price the cap or 3', () => {
    expect(runCountOf(5, view, money, null)).toBe(5)
    // A rewrite is worth 24 pings at 5m and 39 at 1h, whatever the context's size.
    expect(runCountOf(null, view, money, null)).toBe(24)
    expect(runCountOf(null, { ...view, promptTokens: 900 }, money, null)).toBe(24)
    expect(runCountOf(null, { ...view, ttlMs: 3600 * S, ttlLabel: '1h' }, money, null)).toBe(39)
    expect(runCountOf(null, view, money, 6)).toBe(6)
    expect(runCountOf(null, view, money, 40)).toBe(24)
    expect(runCountOf(null, view, { ...money, model: 'claude-nonesuch-1' }, null)).toBe(3)
    expect(runCountOf(null, { kind: 'no-cache' }, money, 7)).toBe(7)
  })

  test('the count line says why a pause sends the count it does: pinned, the break-even count or its cap, or the default with no price', () => {
    const unpriced = { ...money, model: 'claude-nonesuch-1' }
    expect(countLineOf(2, view, money, null)).toBe('Each pause sends at most 2 refreshes: the count you pinned with /keepalive on.')
    expect(countLineOf(1, view, money, null)).toBe('Each pause sends at most 1 refresh: the count you pinned with /keepalive on.')
    expect(countLineOf(null, view, money, null)).toBe('Each pause sends at most 24 refreshes: the break-even count, the most refreshes that cost no more than the rewrite they avoid.')
    // A cap above the break-even count does not bind, so the line gives the break-even count.
    expect(countLineOf(null, view, money, 30)).toBe('Each pause sends at most 24 refreshes: the break-even count, the most refreshes that cost no more than the rewrite they avoid.')
    expect(countLineOf(null, view, money, 6)).toBe('Each pause sends at most 6 refreshes: keepalive_count, which caps the break-even count of 24.')
    expect(countLineOf(null, view, unpriced, null)).toBe('Each pause sends at most 3 refreshes: the default, since the price of this model is unknown and keepalive_count is unset.')
    expect(countLineOf(null, view, unpriced, 7)).toBe('Each pause sends at most 7 refreshes: keepalive_count, since the price of this model is unknown.')
    expect(countLineOf(null, { kind: 'no-cache' }, money, 7)).toBe('')
  })

  test("the count line gives its reason, or the count the pause kept when the caller passes that count", () => {
    expect(countLineOf(null, view, money, null)).toBe('Each pause sends at most 24 refreshes: the break-even count, the most refreshes that cost no more than the rewrite they avoid.')
    expect(countLineOf(2, view, money, null)).toBe('Each pause sends at most 2 refreshes: the count you pinned with /keepalive on.')
    expect(countLineOf(null, view, money, null, 3)).toBe('Each pause sends at most 3 refreshes: the count this pause started with; your next prompt works it out again.')
  })

  test('a running turn, a closed gap, no warm cache, or an unpriced figure leaves nothing to judge', () => {
    expect(pauseOf({ ...gap, active: true }, view, null, NO_SPEND, money, defaults, T)).toBeNull()
    expect(pauseOf({ ...INITIAL, gap: false }, view, null, NO_SPEND, money, defaults, T)).toBeNull()
    expect(pauseOf(gap, { kind: 'no-cache' }, null, NO_SPEND, money, defaults, T)).toBeNull()
    expect(pauseOf(gap, view, null, NO_SPEND, { ...money, model: 'claude-nonesuch-1' }, defaults, T)).toBeNull()
    expect(pauseOf(gap, view, null, { ...NO_SPEND, usd: null }, money, defaults, T)).toBeNull()
  })
})

describe('sessionBalanceLine: the session\x27s balance against the other keepalive setting, in dollars', () => {
  test('no pause judged says nothing', () => {
    expect(sessionBalanceLine(NO_JUDGED, 'dollars')).toBe('')
  })

  test('a saving, a loss and a tie are worded, with the net and the pauses counted', () => {
    expect(sessionBalanceLine({ netUsd: 0.15, pauses: 1 }, 'dollars')).toBe('Over 1 pause this session, keepalive saved $0.15 net against the other setting.')
    expect(sessionBalanceLine({ netUsd: -0.09, pauses: 2 }, 'dollars')).toBe('Over 2 pauses this session, keepalive cost $0.09 net more than the other setting.')
    expect(sessionBalanceLine({ netUsd: 0, pauses: 2 }, 'dollars')).toBe('Over 2 pauses this session, keepalive cost the same as the other setting.')
  })

  test('in tokens the balance is not stated, and the line says the unit that states it', () => {
    expect(sessionBalanceLine({ netUsd: -0.09, pauses: 2 }, 'tokens')).toBe('Over 2 pauses this session, the balance is stated in dollars: /keepalive unit dollars.')
  })
})
