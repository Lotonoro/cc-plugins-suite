import { describe, expect, test } from 'claude-code/testing'
import type { CacheView } from '../types'
import { INITIAL } from './keepalive'
import { NO_SPEND, PRICES, uponOf, type Money } from './prices'
import { breakEvenLine, countLineOf, judge, runCountOf, sessionBalanceLine, NO_JUDGED, pauseOf, rebuildSpendOf, rewriteSpendOf, verdictOf, type Pause } from './verdict'

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
    const view = { kind: 'known' as const, touchMs: 0, ttlMs: 300 * S, ttlLabel: '5m' as const, promptTokens: 1000000, outputTokens: 0, model: 'claude-opus-5-5', speed: null }
    // Opus 5.5 at $4 input: a 5 m write of a million tokens is $5.
    const micro = (usd: number | null) => Math.round((usd ?? -1) * 1e6) / 1e6
    expect(micro(rewriteSpendOf(view, { unit: 'dollars', list: PRICES, model: 'claude-opus-5-5', speed: null, ttl: '5m' }).usd)).toBe(5)
    expect(micro(rewriteSpendOf({ ...view, ttlLabel: '1h', ttlMs: 3600 * S }, { unit: 'dollars', list: PRICES, model: 'claude-opus-5-5', speed: null, ttl: '1h' }).usd)).toBe(8)
  })

  test('an unpriced model leaves the rewrite unpriced, and it is written in tokens', () => {
    const view = { kind: 'known' as const, touchMs: 0, ttlMs: 300 * S, ttlLabel: '5m' as const, promptTokens: 29000, outputTokens: 0, model: 'claude-nonesuch-1', speed: null }
    const spend = rewriteSpendOf(view, { unit: 'dollars', list: PRICES, model: 'claude-nonesuch-1', speed: null, ttl: '5m' })
    expect(spend.usd).toBeNull()
    expect(spend.write5m).toBe(29000)
  })
})

describe('rebuildSpendOf: what the next prompt pays, the last reply\'s output included', () => {
  const view = { kind: 'known' as const, touchMs: 0, ttlMs: 300 * S, ttlLabel: '5m' as const, promptTokens: 900000, outputTokens: 100000, model: 'claude-opus-5-5', speed: null }
  const money: Money = { unit: 'dollars', list: PRICES, model: 'claude-opus-5-5', speed: null, ttl: '5m' }
  const micro = (usd: number | null) => Math.round((usd ?? -1) * 1e6) / 1e6
  // The figure in the unit shown, as the footer and the Cache section word the spend.
  const worded = (v: Extract<CacheView, { kind: 'known' }>, m: Money) => uponOf(rebuildSpendOf(v, m), m.unit)

  test('prices the prefix plus the output at the write rate for the TTL, and the lapse price stays over the prefix', () => {
    // Opus 5.5: a 5 m write is $5 per million. 900k + 100k is $5; the prefix alone is $4.50.
    expect(micro(rebuildSpendOf(view, money).usd)).toBe(5)
    expect(micro(rewriteSpendOf(view, money).usd)).toBe(4.5)
    expect(micro(rebuildSpendOf({ ...view, ttlLabel: '1h', ttlMs: 3600 * S }, { ...money, ttl: '1h' }).usd)).toBe(8)
  })

  test('the size tier follows the rebuild\'s own total', () => {
    const tiered: Money = { unit: 'dollars', list: { ...PRICES, 'claude-opus-5-5': { ...PRICES['claude-opus-5-5']!, above: { threshold: 950000, input: 8e-6, read: 8e-7, write5m: 10e-6, write1h: 16e-6 } } }, model: 'claude-opus-5-5', speed: null, ttl: '5m' }
    expect(micro(rewriteSpendOf(view, tiered).usd)).toBe(4.5)
    expect(micro(rebuildSpendOf(view, tiered).usd)).toBe(10)
  })

  test('the spend is worded in the unit shown', () => {
    expect(worded(view, money)).toBe('~$5.00')
    expect(worded(view, { ...money, unit: 'tokens' })).toBe('~1000k tokens')
  })

  test('prices the model and speed of the view it is handed, whatever model the money names', () => {
    // Under a cold mark the money names no model, yet the stored view does: the figure is the view's own model's.
    const none: Money = { ...money, model: null, speed: null }
    expect(micro(rebuildSpendOf(view, none).usd)).toBe(5)
    expect(worded(view, none)).toBe('~$5.00')
    // The money's own model is not the figure's: Sonnet 5.5's 5 m write is $2.50 per million, Opus 5.5's is $5.
    expect(micro(rebuildSpendOf(view, { ...money, model: 'claude-sonnet-5-5' }).usd)).toBe(5)
    expect(micro(rebuildSpendOf({ ...view, model: 'claude-sonnet-5-5' }, money).usd)).toBe(2.5)
    // The unit and the list are the money's.
    expect(worded(view, { ...none, unit: 'tokens' })).toBe('~1000k tokens')
  })

  test('a view that is fast mode, names no model or a model with no price leaves the figure in tokens, whatever the money names', () => {
    const named: Money = { ...money, model: 'claude-opus-5-5', speed: 'standard' }
    for (const odd of [{ speed: 'fast' }, { model: null }, { model: 'claude-nonesuch-1' }]) {
      const spend = rebuildSpendOf({ ...view, ...odd }, named)
      expect(spend.usd).toBeNull()
      expect(spend.write5m).toBe(1000000)
      expect(worded({ ...view, ...odd }, named)).toBe('~1000k tokens')
    }
    expect(rebuildSpendOf({ ...view, speed: 'fast' }, money).why).toBe('no price for fast mode')
    expect(rebuildSpendOf({ ...view, model: null }, money).why).toBe('no price for an unnamed model')
    expect(rebuildSpendOf({ ...view, model: 'claude-nonesuch-1' }, money).why).toBe('no price for claude-nonesuch-1')
  })
})

describe("pauseOf: the pause from the session's state", () => {
  const LIST = PRICES
  const money: Money = { unit: 'dollars', list: LIST, model: 'claude-opus-5-5', speed: null, ttl: '5m' }
  const T = 1_800_000_000_000
  const view: CacheView = { kind: 'known', touchMs: T, ttlMs: 300 * S, ttlLabel: '5m', promptTokens: 32000, outputTokens: 0, model: 'claude-opus-5-5', speed: null }
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

  test('the pause figures follow the cache\'s one expiry owner: alive until the exact expiry, and past a later live start', () => {
    const at = (live: number | null, now: number) => pauseOf(gap, view, live, NO_SPEND, money, defaults, now)!.alive
    expect(at(null, T + 300 * S - 1)).toBe(true)
    expect(at(null, T + 300 * S)).toBe(false)
    expect(at(T + 5 * S, T + 300 * S)).toBe(true)
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
