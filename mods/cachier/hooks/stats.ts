// The session's measured history: the cache misses, and what each earlier pause saved or wasted. Pure: the reader supplies the
// main-thread responses and the price list, and register.ts keeps the state. Each count keeps its tokens by kind and its
// dollars at the price when it was counted, so the pane can show either unit.
import type { CacheView, Cause, PendingPause, Spend, StatCount, StatsState, Tally, TallyState } from '../types'
import { raiseNote, tallyOf } from './keepalive'
import { addSpend, dollars, figureOf, NO_SPEND, rewriteOf, spendOf, TTL_MS, writeReadRatio, writtenOf, type Money, type PriceList } from './prices'
import type { History, Response } from './transcript'

const NONE: StatCount = { count: 0, spend: NO_SPEND }
export const INITIAL_STATS: StatsState = {
  transcript: null,
  cursor: null,
  lastAtMs: null,
  lastTotal: null,
  lastTtlMs: null,
  coldSince: [],
  misses: { lapse: NONE, cold: NONE, unexplained: NONE },
  overlap: 0,
  saved: { ...NONE, avoided: NO_SPEND },
  ranOut: NONE,
  notNeeded: NONE,
  pending: null,
  longCount: 0,
  maxMs: 0,
  longGaps: [],
}

// The gaps a p90 and a mean are taken over: the last this many long pauses.
const LONG_GAPS_KEPT = 100

// The 90th percentile, nearest-rank: the ceil(0.9·n)-th smallest of the kept gaps, computed as floor((9n + 9) / 10) so no float
// rounds the rank. Below ten gaps that rank is the largest, and the rundown names it max.
export const p90Of = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  const rank = Math.floor((9 * sorted.length + 9) / 10)
  return sorted[rank - 1] ?? 0
}

// A duration as m:ss, rounded down as a stopwatch shows elapsed time (the countdown rounds up, elsewhere), so a pause of 301 s reads 5:01.
const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// The record a user prompt leaves for the pause it ends. Null when the pause had no pings, or the cache is not known: its
// expiry, the thing a pause is judged by, is then unknown.
export const pendingFor = (pause: Tally, view: CacheView, promptMs: number): PendingPause | null => {
  if (pause.pings === 0 || view.kind !== 'known') return null
  return { spend: pause.spend, touchMs: view.touchMs, ttlMs: view.ttlMs, promptMs }
}

const add = (c: StatCount, spend: Spend): StatCount => ({ count: c.count + 1, spend: addSpend(c.spend, spend) })

// The cause of a miss, or null when the response is not one. A miss is a response whose write is most of its context and
// whose read is at most half the previous response's context: the cache was rewritten, not read. The first response of a
// transcript has no previous one to compare with, so it is never a miss. A cold mark in the gap explains the rewrite whatever
// the gap, so it is tested first. Past that, a gap longer than the TTL is a lapse, and any other gap is unexplained.
const missCause = (s: StatsState, r: Response, total: number): Cause | null => {
  const prev = s.lastAtMs
  if (prev === null || s.lastTotal === null) return null
  if (!(r.write > 0 && r.write * 2 >= total && r.read * 2 <= s.lastTotal)) return null
  // A response consumes the marks at or before it, so the marks left are all after the previous response.
  if (s.coldSince.some((m) => m <= r.timestampMs)) return 'cold'
  const ttl = s.lastTtlMs ?? r.ttlMs
  if (ttl !== null && r.timestampMs - prev > ttl) return 'lapse'
  return 'unexplained'
}

// The first response at or after the prompt that ended a pause classifies it. A lapse miss means the pings ran out before the
// user returned: a wasted pause. Another miss has another cause (a model switch, compaction or clear, or an edit of the
// context), so the pause is not classified. With no miss, a prompt after the cache's expiry without the pings means they saved
// a full-context write, priced as the write of the response's context at the pause's TTL; a prompt before it means the
// pings were not needed.
const classify = (s: StatsState, p: PendingPause, miss: Cause | null, avoided: Spend): StatsState => {
  const done = { ...s, pending: null }
  if (miss === 'lapse') return { ...done, ranOut: add(s.ranOut, p.spend), overlap: s.overlap + 1 }
  if (miss !== null) return done
  if (p.promptMs > p.touchMs + p.ttlMs) {
    return { ...done, saved: { ...add(s.saved, p.spend), avoided: addSpend(s.saved.avoided, avoided) } }
  }
  return { ...done, notNeeded: add(s.notNeeded, p.spend) }
}

// One miss, as its debug line records it: the response's time, its cause, its read and write, and the gap since the previous
// response. No field is named `tokens`: the engine redacts that key name.
export type MissEvent = { atMs: number; cause: Cause; read: number; write: number; gapMs: number }

// A pause longer than the TTL: its gap, from one response's time to the next. The TTL is the one the previous response showed.
export type LongPauseEvent = { atMs: number; gapMs: number }

// A response's write as it was billed, at its own model and speed, the tier picked by its whole prompt.
const writeSpend = (list: PriceList, r: Response, total: number): Spend =>
  spendOf(list, r.model, r.speed, { input: 0, read: 0, write5m: r.write5m, write1h: r.write1h }, total)

// What a write of the response's whole context would have cost at a TTL of `ttlMs`: the write a pause's pings saved.
const avoidedSpend = (list: PriceList, r: Response, total: number, ttlMs: number): Spend => {
  const kinds = ttlMs > TTL_MS['5m'] ? { input: 0, read: 0, write5m: 0, write1h: total } : { input: 0, read: 0, write5m: total, write1h: 0 }
  return spendOf(list, r.model, r.speed, kinds, total)
}

const foldOne = (s: StatsState, r: Response, list: PriceList): { state: StatsState; event: MissEvent | null; pause: LongPauseEvent | null } => {
  const total = r.input + r.read + r.write
  const miss = missCause(s, r, total)
  let next: StatsState = { ...s, coldSince: s.coldSince.filter((m) => m > r.timestampMs) }
  if (miss !== null) next = { ...next, misses: { ...next.misses, [miss]: add(next.misses[miss], writeSpend(list, r, total)) } }
  if (next.pending !== null && r.timestampMs >= next.pending.promptMs) {
    next = classify(next, next.pending, miss, avoidedSpend(list, r, total, next.pending.ttlMs))
  }
  const gap = s.lastAtMs === null ? null : r.timestampMs - s.lastAtMs
  const ttl = s.lastTtlMs ?? r.ttlMs
  const pause = gap !== null && ttl !== null && gap > ttl ? { atMs: r.timestampMs, gapMs: gap } : null
  const longs = pause === null ? {} : { longCount: s.longCount + 1, maxMs: Math.max(s.maxMs, pause.gapMs), longGaps: [...s.longGaps, pause.gapMs].slice(-LONG_GAPS_KEPT) }
  const state = { ...next, ...longs, lastAtMs: r.timestampMs, lastTotal: total, lastTtlMs: r.ttlMs ?? next.lastTtlMs }
  const event = miss !== null && s.lastAtMs !== null ? { atMs: r.timestampMs, cause: miss, read: r.read, write: r.write, gapMs: r.timestampMs - s.lastAtMs } : null
  return { state, event, pause }
}

// The counts after a pass's responses, and the misses to log. Only responses newer than the newest one already counted are
// folded, so a recount re-reads the file and counts nothing twice. It keeps what the counts already hold: the pause outcomes,
// and each old miss's cause, which the cold marks that gave it cannot be read again. The cursor moves to the newest response,
// so the next pass stops there. Each response is priced from `list` as it is folded.
export const foldStatsEvents = (
  s: StatsState,
  history: History,
  list: PriceList,
): { state: StatsState; events: MissEvent[]; pauses: LongPauseEvent[] } => {
  let acc = s
  const events: MissEvent[] = []
  const pauses: LongPauseEvent[] = []
  for (const r of history.responses) {
    if (s.lastAtMs !== null && r.timestampMs <= s.lastAtMs) continue
    const out = foldOne(acc, r, list)
    acc = out.state
    if (out.event !== null) events.push(out.event)
    if (out.pause !== null) pauses.push(out.pause)
  }
  const newest = history.responses[history.responses.length - 1]
  const cursor = newest !== undefined ? newest.messageId : history.recount ? null : s.cursor
  return { state: { ...acc, cursor }, events, pauses }
}

const missTotal = (s: StatsState): StatCount => {
  const { lapse, cold, unexplained } = s.misses
  return { count: lapse.count + cold.count + unexplained.count, spend: addSpend(addSpend(lapse.spend, cold.spend), unexplained.spend) }
}

// The session line, shown in the Keepalive and This session sections: this session's refreshes and their cost, empty while there are none.
export const sessionLineOf = (t: TallyState, money: Money): string => (t.session.pings > 0 ? tallyOf('This session', t.session, money.unit) : '')

// The lines that show the tallies and a raised lead, for the rundown. A zero tally is not a line.
const tallyLines = (t: TallyState, money: Money): string[] => [
  ...(t.pause.pings > 0 ? [tallyOf('This pause', t.pause, money.unit)] : []),
  ...[sessionLineOf(t, money)].filter((line) => line !== ''),
  ...(t.raisedMs === null ? [] : [raiseNote(t.raisedMs)]),
]

// A cause's name on the rundown.
const CAUSE_WORD: Record<Cause, string> = { lapse: 'lapse', cold: 'switch or compaction', unexplained: 'unexplained' }
const CAUSES: readonly Cause[] = ['lapse', 'cold', 'unexplained']

// The saved pauses in the unit shown. In dollars, what the pings cost, what the writes they avoided would have cost, and the
// difference. In tokens, the pings' reads and the writes' tokens, and how many pings one write is worth at the current
// model's prices, which no token count says by itself; without a price that clause is left out.
const savedOf = (s: StatsState, money: Money): string => {
  const writes = s.saved.count === 1 ? '1 write' : `${s.saved.count} writes`
  const { spend, avoided } = s.saved
  if (money.unit === 'dollars' && spend.usd !== null && avoided.usd !== null) {
    return `Earlier pauses: ${s.saved.count} saved (refreshes ${dollars(spend.usd)}; ${writes} avoided, ${dollars(avoided.usd)}; net ${dollars(Math.max(0, avoided.usd - spend.usd))} saved)`
  }
  const ratio = writeReadRatio(money.list, money.model, money.ttl)
  const worth = ratio === null ? '' : `, a write is worth about ${Math.floor(ratio)} refreshes`
  return `Earlier pauses: ${s.saved.count} saved (refreshes ${figureOf(spend, 'tokens')}; ${writes} avoided, ${writtenOf(avoided.write5m + avoided.write1h)}${worth})`
}

// The pauses' lines of the rundown: this pause, this session and any raise, then the earlier pauses by outcome.
const pauseParts = (t: TallyState, s: StatsState, money: Money): string[] => {
  const parts = tallyLines(t, money)
  if (s.saved.count > 0) parts.push(savedOf(s, money))
  if (s.ranOut.count > 0) parts.push(`Earlier pauses: ${s.ranOut.count} wasted, ran out (refreshes ${figureOf(s.ranOut.spend, money.unit)})`)
  if (s.notNeeded.count > 0) parts.push(`Earlier pauses: ${s.notNeeded.count} wasted, not needed (refreshes ${figureOf(s.notNeeded.spend, money.unit)})`)
  return parts
}

// The misses by cause, in one line; empty with none.
const missParts = (s: StatsState, money: Money): string[] => {
  const misses = missTotal(s)
  if (misses.count === 0) return []
  const causes = CAUSES.filter((c) => s.misses[c].count > 0)
    .map((c) => `${CAUSE_WORD[c]} ${s.misses[c].count}`)
    .join(', ')
  return [`Cache misses: ${misses.count} (${causes}), ${rewriteOf(misses.spend, money.unit)} rewritten`]
}

// The long pauses, the overlap with lapse misses, and the hint for the larger kind of waste.
const tailParts = (s: StatsState): string[] => {
  const parts: string[] = []
  if (s.longCount > 0) {
    const mean = s.longGaps.reduce((a, b) => a + b, 0) / s.longGaps.length
    parts.push(`Long pauses: ${s.longCount} · p90 ${clock(p90Of(s.longGaps))} · mean ${clock(mean)} · max ${clock(s.maxMs)}`)
  }
  if (s.overlap > 0) {
    parts.push(
      s.overlap === 1
        ? '1 of the lapse misses is also a wasted ran-out pause: one event, shown under both'
        : `${s.overlap} of the lapse misses are also wasted ran-out pauses: one event, shown under both`,
    )
  }
  if (s.ranOut.count > s.notNeeded.count) parts.push('most wasted pauses ran out: your pauses outlast the refreshes')
  else if (s.notNeeded.count > s.ranOut.count) parts.push('most wasted pauses were not needed: refreshes fire just before you return')
  return parts
}

// The rundown the Keepalive section carries (the pauses, then the long pauses and the notes) and the one the Advice section carries (the
// misses by cause), each as lines.
export const rundownSections = (t: TallyState, s: StatsState, money: Money): { keepalive: string[]; advice: string[] } => ({
  keepalive: [...pauseParts(t, s, money), ...tailParts(s)],
  advice: missParts(s, money),
})
