// Whether the keepalive toggle, as it stands, is saving or wasting money right now: the cost of this pause so far if the
// next prompt came now, against the same pause with the toggle the other way. Pure: register.ts gathers the inputs.
//
// With keepalive on, the pause has cost its pings, plus a rewrite if the cache lapsed anyway (the count ran out). With it
// off, the pause costs nothing until the TTL passes and a rewrite after. A rewrite is priced as what it costs over the read
// a warm cache would have taken. The other reality's pings are counted as keepalive would have sent them: ping k at
// k×(ttl−lead) after the touch, up to the count.
import type { CacheView, Judged, KeepaliveState, Spend, Unit, Verdict } from '../types'
import { clockOf, expiredAt } from './countdown'
import type { Defaults } from './keepalive'
import { dollars, NO_KINDS, spendOf, uponOf, type Money } from './prices'

export type Pause = {
  // Whether keepalive is on: the reality the session is in.
  on: boolean
  // Time since the main thread's last cache touch, the start of this pause.
  pausedMs: number
  ttlMs: number
  // The lead and count keepalive runs with, or would run with were it turned on.
  leadMs: number
  count: number
  // One ping's dollars, and what a rewrite costs over a read, both for the current context.
  pingUsd: number
  lapseUsd: number
  // With keepalive on: what this pause's pings have cost, and whether the cache is alive now.
  spentUsd: number
  alive: boolean
}

// What a pause costs with keepalive off: a rewrite once the TTL has passed.
const offCost = (p: Pause): number => (p.pausedMs >= p.ttlMs ? p.lapseUsd : 0)

// What a pause would have cost with keepalive on, for a session that has it off: the pings that would have fired by now,
// and a rewrite once they could no longer hold the cache.
const wouldOnCost = (p: Pause): number => {
  if (p.leadMs >= p.ttlMs) return offCost(p)
  const step = p.ttlMs - p.leadMs
  const pings = Math.min(p.count, Math.floor(p.pausedMs / step))
  const alive = p.pausedMs < pings * step + p.ttlMs
  return pings * p.pingUsd + (alive ? 0 : p.lapseUsd)
}

// Costs this close are equal: float sums of per-token prices never land exactly.
const EPSILON_USD = 1e-9

// This pause's cost as it stands, and the other reality's.
const costs = (p: Pause): { actual: number; other: number } => ({
  actual: p.on ? p.spentUsd + (p.alive ? 0 : p.lapseUsd) : offCost(p),
  other: p.on ? offCost(p) : wouldOnCost(p),
})

// What the toggle as it stands has saved this pause over the other way: negative when it wasted, zero on par.
export const marginOf = (p: Pause): number => {
  const { actual, other } = costs(p)
  return Math.abs(actual - other) < EPSILON_USD ? 0 : other - actual
}

const verdictOfMargin = (usd: number): Verdict => (usd === 0 ? 'par' : usd > 0 ? 'saving' : 'wasting')

export const verdictOf = (p: Pause): Verdict => verdictOfMargin(marginOf(p))

// The session's pauses judged so far, each folded in as its prompt ended it: the net saved, and how many.
export const NO_JUDGED: Judged = { netUsd: 0, pauses: 0 }
export const judge = (j: Judged, p: Pause | null): Judged => (p === null ? j : { netUsd: j.netUsd + marginOf(p), pauses: j.pauses + 1 })

// The session's balance against the other keepalive setting: the net over the pauses judged, in dollars. In tokens no balance is stated,
// since a balance is a sum of prices; the line says which unit states it. Empty before the first judged pause.
export const sessionBalanceLine = (j: Judged, unit: Unit): string => {
  if (j.pauses === 0) return ''
  const over = `Over ${j.pauses} ${j.pauses === 1 ? 'pause' : 'pauses'} this session`
  if (unit === 'tokens') return `${over}, the balance is stated in dollars: /keepalive unit dollars.`
  const net = Math.abs(j.netUsd) < EPSILON_USD ? 0 : j.netUsd
  const verdict = verdictOfMargin(net)
  if (verdict === 'par') return `${over}, keepalive cost the same as the other setting.`
  if (verdict === 'saving') return `${over}, keepalive saved ${dollars(net)} net against the other setting.`
  return `${over}, keepalive cost ${dollars(-net)} net more than the other setting.`
}

// What a lapse rewrites over the prefix alone: the view's context at its model's write rate for the TTL in force, for the lapse
// comparisons. Unpriced when the model has no price.
export const rewriteSpendOf = (view: Extract<CacheView, { kind: 'known' }>, money: Money): Spend => {
  const write = view.ttlLabel === '1h' ? { ...NO_KINDS, write1h: view.promptTokens } : { ...NO_KINDS, write5m: view.promptTokens }
  return spendOf(money.list, money.model, money.speed, write, view.promptTokens)
}

// What the next prompt pays to write an expired cache again: the view's context plus the last reply's output, which the
// next request re-sends and writes with it, at the write rate for the TTL in force of the model and speed the view itself names,
// not the money's: under a cold mark the money names no model, yet the stored view still does. A size tier follows that total.
// The lapse comparisons stay over the prefix alone (rewriteSpendOf): a warm cache writes the output too.
export const rebuildSpendOf = (view: Extract<CacheView, { kind: 'known' }>, money: Money): Spend => {
  const total = view.promptTokens + view.outputTokens
  const write = view.ttlLabel === '1h' ? { ...NO_KINDS, write1h: total } : { ...NO_KINDS, write5m: total }
  return spendOf(money.list, view.model, view.speed, write, total)
}

// The rebuild figure in the unit shown, for the footer and the Cache section's warmth line; empty for a view that isn't known.
export const rebuildOf = (view: CacheView, money: Money): string => (view.kind === 'known' ? uponOf(rebuildSpendOf(view, money), money.unit) : '')

// One refresh's dollars, and what a rewrite costs over a read, for the context a warm cache holds; null with no warm cache or no
// price for either.
const ratesOf = (view: CacheView, money: Money): { pingUsd: number; lapseUsd: number } | null => {
  if (view.kind !== 'known') return null
  const prompt = view.promptTokens
  const ping = spendOf(money.list, money.model, money.speed, { ...NO_KINDS, read: prompt }, prompt).usd
  const rewrite = rewriteSpendOf(view, money).usd
  return ping === null || rewrite === null ? null : { pingUsd: ping, lapseUsd: rewrite - ping }
}

// What a rewrite of the cache costs over a ping, in pings; null with no warm cache or no price.
export const ratioOf = (view: CacheView, money: Money): number | null => {
  const rates = ratesOf(view, money)
  return rates === null ? null : rates.lapseUsd / rates.pingUsd
}

// The count a run sends when none is pinned and the model has no price: the fixed count cachier sent before break-even.
export const UNPRICED_COUNT = 3

// The break-even count: the most pings whose sum stays within the rewrite they avoid, rounded down and never under one. Null
// with no warm cache or no price.
const breakEvenOf = (view: CacheView, money: Money): number | null => {
  const rates = ratesOf(view, money)
  return rates === null ? null : Math.max(1, Math.floor((rates.lapseUsd + EPSILON_USD) / rates.pingUsd))
}

// The count of pings a run sends. A pinned count is sent as pinned. Otherwise it is the break-even count: pings until they
// have cost one rewrite, then stop. That is the rent-or-buy rule, whose cost is never more than twice the best choice in
// hindsight, however long the pause; the README sets out why. It is the price ratio (write less read) over read, not a
// figure of the context's size, and the cap bounds it. A model with no price takes the cap, or UNPRICED_COUNT.
export const runCountOf = (count: number | null, view: CacheView, money: Money, cap: number | null): number => {
  if (count !== null) return count
  const even = breakEvenOf(view, money)
  if (even === null) return cap ?? UNPRICED_COUNT
  return cap === null ? even : Math.min(cap, even)
}

// The lead and count keepalive runs with, or would run with were it turned on: a running keepalive's own count, else the
// count its config, the last used or the defaults resolve to.
const runOf = (k: KeepaliveState, view: CacheView, money: Money, defaults: Defaults): { leadMs: number; count: number } => {
  if (k.config !== null) return { leadMs: k.config.leadMs, count: k.runCount }
  const run = k.lastUsed ?? defaults
  return { leadMs: run.leadMs, count: runCountOf(run.count ?? defaults.count, view, money, defaults.cap) }
}

// The break-even line: the pauses keepalive on costs less in than off, by the marker's own model. They start at the
// TTL, where the cache would have lapsed, and end at the ping that brings the pings to the rewrite they avoid, where the two
// are even, or where the count runs out and the cache lapses anyway, whichever comes first. Empty with no warm cache or no
// price.
export const breakEvenLine = (k: KeepaliveState, view: CacheView, money: Money, defaults: Defaults): string => {
  if (view.kind !== 'known') return ''
  const rates = ratesOf(view, money)
  if (rates === null) return ''
  const run = runOf(k, view, money, defaults)
  // A learned count of no pings pays off in no pause; the learned line says why.
  if (run.count === 0) return ''
  const step = view.ttlMs - run.leadMs
  // The first ping whose sum reaches the rewrite, by the margin verdictOf counts as par.
  const even = Math.max(1, Math.ceil((rates.lapseUsd - EPSILON_USD) / rates.pingUsd))
  const untilMs = step <= 0 ? 0 : even <= run.count ? even * step : run.count * step + view.ttlMs
  if (untilMs <= view.ttlMs) return "Keepalive doesn't pay off on this context"
  return `Keepalive pays off if you're back between ${clockOf(view.ttlMs)} and ${clockOf(untilMs)}`
}

// Why a running run sends a count the reasons no longer give: the count its pause started with, kept until the pause ends.
export const KEPT_COUNT = 'the count this pause started with; your next prompt works it out again'

// The line on how many refreshes a pause sends when no learned count stands: the count pinned, the break-even count and the
// cap on it, or with no price the cap or UNPRICED_COUNT, each with its reason. Empty with no warm cache, where there is no price to count from.
// `kept` is the count a running run keeps where the reasons now give another (register.ts's keptOf decides it): the line reports that count, and says
// the pause keeps the one it started with.
export const countLineOf = (pinned: number | null, view: CacheView, money: Money, cap: number | null, kept: number | null = null): string => {
  if (view.kind !== 'known') return ''
  const n = kept ?? runCountOf(pinned, view, money, cap)
  const sends = `Each pause sends at most ${n === 1 ? '1 refresh' : `${n} refreshes`}`
  if (kept !== null) return `${sends}: ${KEPT_COUNT}.`
  if (pinned !== null) return `${sends}: the count you pinned with /keepalive on.`
  const even = breakEvenOf(view, money)
  if (even === null) {
    const why = cap === null ? 'the default, since the price of this model is unknown and keepalive_count is unset' : 'keepalive_count, since the price of this model is unknown'
    return `${sends}: ${why}.`
  }
  if (cap !== null && cap < even) return `${sends}: keepalive_count, which caps the break-even count of ${even}.`
  return `${sends}: the break-even count, the most refreshes that cost no more than the rewrite they avoid.`
}

// The pause the marker judges, from the session's state: null while a turn runs or the gap is closed, with no warm cache
// counted, or with any figure unpriced, where the marker rests on par.
export const pauseOf = (
  k: KeepaliveState,
  view: CacheView,
  live: number | null,
  pauseSpend: Spend,
  money: Money,
  defaults: Defaults,
  nowMs: number,
): Pause | null => {
  if (k.active || !k.gap || view.kind !== 'known') return null
  const rates = ratesOf(view, money)
  if (rates === null || pauseSpend.usd === null) return null
  const run = runOf(k, view, money, defaults)
  return {
    on: k.config !== null,
    pausedMs: nowMs - view.touchMs,
    ttlMs: view.ttlMs,
    leadMs: run.leadMs,
    count: run.count,
    pingUsd: rates.pingUsd,
    lapseUsd: rates.lapseUsd,
    spentUsd: pauseSpend.usd,
    alive: !expiredAt(view, live, nowMs),
  }
}
