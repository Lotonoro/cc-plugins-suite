// The learned ping count: the count, from 0 up to the break-even count, that would have cost least over the user's own
// pauses. It is priced the way the marker prices a pause: the pings fired before the return, plus a rewrite if the cache
// lapsed. Costs are in pings, so a rewrite costs `ratio` pings over the read the next prompt makes anyway.
//
// Which pauses to learn from is decided by the history itself, with no threshold: leave-one-out validation prices every
// past pause under the count learned from the others, for three rules (the break-even count, a count learned from every
// pause, and one learned from the pauses that started in the same hour), and the rule that would have cost least is used
// now. With little history neither learned rule can beat break-even, so break-even stands until the history says otherwise.

import type { TtlLabel } from '../types'
import { labelled } from './countdown'
import type { PauseRecord } from './history'
import { TTL_MS } from './prices'
import type { Line } from './sections'
import { refreshIntervalMs } from './setup'

// The cache's timing and price that a count is learned for: those of the cache the next pause would ping.
export type Pricing = { ttlMs: number; leadMs: number; ratio: number }

// What one pause of `pausedMs` would have cost with a run of `count` pings, in pings.
export const pauseCost = (count: number, pausedMs: number, p: Pricing): number => {
  // Where the run sends none, the count handed in is none, so no ping fires and the pause holds only within the TTL.
  const interval = refreshIntervalMs(p.leadMs, p.ttlMs)
  const fired = interval === null ? 0 : Math.min(count, Math.max(0, Math.ceil(pausedMs / interval) - 1))
  const alive = pausedMs < count * (interval ?? 0) + p.ttlMs
  return fired + (alive ? 0 : p.ratio)
}

// The cheapest count, given each count's total; ties go to the higher count, toward break-even.
const cheapest = (totals: readonly number[]): number => {
  let best = totals.length - 1
  for (let c = totals.length - 2; c >= 0; c--) if (totals[c]! < totals[best]! - 1e-9) best = c
  return best
}

const totalsOf = (lengths: readonly number[], maxCount: number, p: Pricing): number[] =>
  Array.from({ length: maxCount + 1 }, (_, c) => lengths.reduce((sum, l) => sum + pauseCost(c, l, p), 0))

export type Rule = 'break-even' | 'all' | 'hour'

// The learned count and its evidence: which pauses it came from, how many of them, and how many ended while the cache it
// keeps alive was still warm. Null when the break-even count stands.
export type Learned = { count: number; rule: Exclude<Rule, 'break-even'>; within: number; of: number; coverMs: number }

// Each rule's leave-one-out cost over the history: every pause priced under the count its rule learns from the others.
// A rule with no other pause to learn from falls back to break-even for that pause.
export const looCosts = (history: readonly PauseRecord[], maxCount: number, p: Pricing): Record<Rule, number> => {
  const cost = history.map((r) => Array.from({ length: maxCount + 1 }, (_, c) => pauseCost(c, r.pausedMs, p)))
  const all = totalsOf(
    history.map((r) => r.pausedMs),
    maxCount,
    p,
  )
  const byHour = new Map<number, { totals: number[]; n: number }>()
  history.forEach((r, i) => {
    const t = byHour.get(r.hour) ?? { totals: Array.from({ length: maxCount + 1 }, () => 0), n: 0 }
    cost[i]!.forEach((v, c) => (t.totals[c]! += v))
    t.n += 1
    byHour.set(r.hour, t)
  })
  const sums: Record<Rule, number> = { 'break-even': 0, all: 0, hour: 0 }
  history.forEach((r, i) => {
    const own = cost[i]!
    sums['break-even'] += own[maxCount]!
    const rest = (totals: readonly number[], others: number) => (others === 0 ? own[maxCount]! : own[cheapest(totals.map((t, c) => t - own[c]!))]!)
    sums.all += rest(all, history.length - 1)
    const hour = byHour.get(r.hour)!
    sums.hour += rest(hour.totals, hour.n - 1)
  })
  return sums
}

// A value memoised on a history array and a pricing: a recorded pause makes a new history array, which computes afresh, and an old
// array's values go with it.
type PricingMemo<T> = WeakMap<readonly PauseRecord[], Map<string, T>>
const memoAt = <T>(memo: PricingMemo<T>, history: readonly PauseRecord[], maxCount: number, p: Pricing, make: () => T): T => {
  let pricings = memo.get(history)
  if (pricings === undefined) memo.set(history, (pricings = new Map()))
  const key = [maxCount, p.ttlMs, p.leadMs, p.ratio].join('|')
  let value = pricings.get(key)
  if (value === undefined) pricings.set(key, (value = make()))
  return value
}

// The leave-one-out costs do not depend on the hour, so every hour a history is asked about at a pricing shares them.
const looMemo: PricingMemo<Record<Rule, number>> = new WeakMap()
const looCostsOnce = (history: readonly PauseRecord[], maxCount: number, p: Pricing): Record<Rule, number> =>
  memoAt(looMemo, history, maxCount, p, () => looCosts(history, maxCount, p))

// The count to send now, learned for a pause starting at `hour`; null when break-even stands, learned or not. A pause shorter
// than the interval between pings costs nothing at any count, so what a count is learned from is the long pauses: one past
// every count costs break-even's pings and the rewrite too, where no pings would cost the rewrite alone. Ties between rules go to
// break-even first, then to all pauses over the hour's.
export const learnedOf = (history: readonly PauseRecord[], hour: number, maxCount: number, p: Pricing): Learned | null => {
  const interval = refreshIntervalMs(p.leadMs, p.ttlMs)
  if (history.length === 0 || interval === null) return null
  const loo = looCostsOnce(history, maxCount, p)
  const rule: Rule = loo.all < loo['break-even'] - 1e-9 && loo.all <= loo.hour + 1e-9 ? 'all' : loo.hour < loo['break-even'] - 1e-9 ? 'hour' : 'break-even'
  if (rule === 'break-even') return null
  const scope = rule === 'all' ? history : history.filter((r) => r.hour === hour)
  if (scope.length === 0) return null
  const lengths = scope.map((r) => r.pausedMs)
  const count = cheapest(totalsOf(lengths, maxCount, p))
  if (count === maxCount) return null
  const coverMs = count * interval + p.ttlMs
  return { count, rule, within: lengths.filter((l) => l < coverMs).length, of: lengths.length, coverMs }
}

const clock = (ms: number): string => {
  const s = Math.round(ms / 1000)
  const mm = `${Math.floor((s % 3600) / 60)}`.padStart(s >= 3600 ? 2 : 1, '0')
  const ss = `${s % 60}`.padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`
}

// The line on a learned count: the count, the time its refreshes keep the cache warm, and the pauses behind it.
export const learnedLine = (l: Learned, ttlMs: number): Line => {
  const label = l.rule === 'hour' ? 'learned (this hour):' : 'learned:'
  const pauses = `${l.within}/${l.of} pauses within`
  if (l.count === 0) return labelled(label, ` 0 refreshes · ${pauses} ${clock(ttlMs)} TTL`)
  return labelled(label, ` ${l.count === 1 ? '1 refresh' : `${l.count} refreshes`}/pause · covers ${clock(l.coverMs)} · ${pauses}`)
}

// The per-token rates a TTL comparison is priced at: the current model's read and its two write rates.
export type TtlRates = { read: number; write5m: number; write1h: number }

// The counts learned from a history, by hour and pricing: every pricing of the same history shares them, so the TTL block and the best-setup
// block learn each count once.
const learnedCounts: PricingMemo<Map<number, number>> = new WeakMap()

// The counts by hour learned from `history` at a pricing, each learned when first asked for, else the break-even `maxCount`.
const learnedCountsAt = (history: readonly PauseRecord[], maxCount: number, p: Pricing): ((hour: number) => number) => {
  const counts = memoAt(learnedCounts, history, maxCount, p, () => new Map<number, number>())
  return (hour) => {
    let count = counts.get(hour)
    if (count === undefined) counts.set(hour, (count = learnedOf(history, hour, maxCount, p)?.count ?? maxCount))
    return count
  }
}

// What the pauses would have cost at a TTL, in dollars: each pause's turn writes at that TTL's write rate, then the pause with no pings
// while keepalive is off, or else at its pinned count, or the count it would learn from `history` for that TTL, or break-even. Keepalive on
// with a lead not below the TTL is priced as off: such a run pauses on its lead and sends no refresh (keepalive.ts step). Null where the
// model has no price for that TTL. Only pauses that carry their context and growth can be priced: the caller passes those. The Advice
// section's two blocks, the TTL block and the best-setup block (both in advice.ts), price through this, so they cannot disagree on the same pauses.
export const pausesCost = (
  pauses: readonly PauseRecord[],
  history: readonly PauseRecord[],
  ttl: TtlLabel,
  rates: TtlRates,
  leadMs: number,
  cap: number | null,
  keepalive: { on: boolean; pinned: number | null },
): number | null => {
  const write = ttl === '5m' ? rates.write5m : rates.write1h
  const p: Pricing = { ttlMs: TTL_MS[ttl], leadMs, ratio: (write - rates.read) / rates.read }
  if (!(p.ratio > 0)) return null
  const even = Math.max(1, Math.floor(p.ratio + 1e-9))
  const maxCount = cap === null ? even : Math.min(cap, even)
  const pinned = keepalive.pinned
  const countAt: (hour: number) => number =
    !keepalive.on || refreshIntervalMs(leadMs, p.ttlMs) === null ? () => 0 : pinned !== null ? () => pinned : learnedCountsAt(history, maxCount, p)
  return pauses.reduce((sum, r) => sum + r.grownTokens! * write + pauseCost(countAt(r.hour), r.pausedMs, p) * rates.read * r.contextTokens!, 0)
}

// Whether a pause can be priced: it carries its context and the growth its turn wrote.
export const priceable = (r: PauseRecord): boolean => r.contextTokens !== undefined && r.grownTokens !== undefined

// Which TTL would have cost less over the recorded pauses, and by how much, in dollars; null while the current one would
// not have cost more. Each pause is priced at both by pausesCost, in the mode keepalive is in (a 1 h write costs 8/5 of a 5 m one on
// Opus 5.5). Only pauses that carry their context and growth are priced; the count is still learned from them all. The current TTL runs
// in this session's mode at its `leadMs` and pin; a switch to the other needs a new session, so it runs as one starts (`fresh`): keepalive
// on or off as keepalive_default says, at the options' lead and pin.
export const ttlAdviceOf = (
  history: readonly PauseRecord[],
  rates: TtlRates,
  leadMs: number,
  cap: number | null,
  current: TtlLabel,
  keepalive: { on: boolean; pinned: number | null },
  fresh: { on: boolean; leadMs: number; pinned: number | null },
): { better: TtlLabel; savedUsd: number; of: number } | null => {
  const priced = history.filter(priceable)
  if (priced.length === 0 || !(rates.read > 0)) return null
  const other: TtlLabel = current === '5m' ? '1h' : '5m'
  const now = pausesCost(priced, history, current, rates, leadMs, cap, keepalive)
  const then = pausesCost(priced, history, other, rates, fresh.leadMs, cap, { on: fresh.on, pinned: fresh.pinned })
  if (now === null || then === null || then >= now - 1e-9) return null
  return { better: other, savedUsd: now - then, of: priced.length }
}

// How to switch to a TTL: the `promptCacheTtl` setting, which the prompt-caching docs rank above ENABLE_PROMPT_CACHING_1H and below
// only FORCE_PROMPT_CACHING_5M and CLAUDE_CODE_PROMPT_CACHE_TTL. The docs don't say a running session picks up a change to it, so a
// switch is priced and worded as a new session. The Advice section's two blocks (advice.ts) and the Settings section's TTL row all say it this way.
export const ttlSwitchOf = (ttl: TtlLabel): string => `set "promptCacheTtl": "${ttl}" in settings.json`
