// Keepalive's decisions, pure: what the toggle accepts, the gap and turn bookkeeping, what one tick does with the state
// and the reader's TTL and touch, the status line's and the footer line's words, how a ping's outcome is
// judged, and the debug line of a ping. register.ts holds the state, writes it, and makes the fork; nothing here reads the engine.
import type { ModelForkResult, ModelUsage, PluginOptions } from 'claude-code'
import type { CacheView, HintCost, KeepaliveState, Spend, Tally, TallyState, Unit } from '../types'
import { touchOf } from './countdown'
import { addSpend, dollars, figureOf, kTokens, NO_KINDS, NO_SPEND, spendOf, type Money } from './prices'

// Everything off: no config, no pings, nothing shown, no turn bookkeeping. A session's start and end reset to this.
export const INITIAL: KeepaliveState = {
  config: null,
  remaining: 0,
  stop: null,
  last: null,
  seq: 0,
  active: false,
  gap: true,
  coldPending: false,
  lastTurn: null,
  generation: 0,
  lastUsed: null,
  pauseEpoch: 0,
  runCount: 0,
}

// Whether a value has the keys given, each a number: the shape of the last ping's read and write.
const numbers = (v: unknown, keys: string[]): boolean =>
  typeof v === 'object' && v !== null && keys.every((key) => typeof (v as Record<string, unknown>)[key] === 'number')

// A lead and a count, the count null when none was pinned.
const run = (v: unknown): boolean => {
  if (!numbers(v, ['leadMs'])) return false
  const count = (v as Record<string, unknown>).count
  return count === null || typeof count === 'number'
}

// What each nullable field holds when it is not null.
const NULLABLE: Record<string, (v: unknown) => boolean> = {
  config: run,
  lastUsed: run,
  last: (v) => numbers(v, ['read', 'write']),
  stop: (v) => typeof v === 'string',
  lastTurn: (v) => typeof v === 'string',
}

// Keepalive's state as an earlier load of the module left it, which may be another version's shape: each field whose kind
// matches the default's is kept, a nullable one when it is null or holds its shape, and the rest take the default. The
// generation moves on, so a ping the earlier load sent changes nothing.
export const restored = (held: unknown): KeepaliveState => {
  const k: Record<string, unknown> = { ...INITIAL }
  if (typeof held === 'object' && held !== null) {
    for (const [key, d] of Object.entries(INITIAL)) {
      const v = (held as Record<string, unknown>)[key]
      const fits = d === null ? v === null || NULLABLE[key]?.(v) === true : typeof v === typeof d
      if (v !== undefined && fits) k[key] = v
    }
  }
  const kept = k as KeepaliveState
  return { ...kept, generation: kept.generation + 1 }
}

// Keepalive off, keeping the turn bookkeeping that the main thread's own events maintain and the lead and count last used.
// Bumps the generation so a ping in flight changes nothing once it is off.
export const off = (k: KeepaliveState): KeepaliveState => ({
  ...INITIAL,
  seq: k.seq,
  pauseEpoch: k.pauseEpoch,
  active: k.active,
  gap: k.gap,
  coldPending: k.coldPending,
  lastTurn: k.lastTurn,
  lastUsed: k.lastUsed,
  generation: k.generation + 1,
})

export type Request =
  | { kind: 'status' }
  | { kind: 'off' }
  | { kind: 'on'; leadMs: number; count: number | null }
  | { kind: 'default'; mode: Mode }
  | { kind: 'unit'; unit: Unit }
  | { kind: 'usage' }

// The mode a session starts in: the `keepalive_default` option, off unless it says on.
export type Mode = 'on' | 'off'
export const modeOf = (option: unknown): Mode => (option === 'on' ? 'on' : 'off')

const SECONDS = /^\d+(\.\d+)?$/
const WHOLE = /^\d+$/

// The toggle's arguments: `` shows the state, `off` turns it off, `on <lead seconds> [pings]` turns it on, `default on|off`
// sets the mode new sessions start in, and `unit dollars|tokens` switches the unit the figures show in. The lead is
// required; the pings pin the count, and without them each run sends the break-even count.
export const parseRequest = (args: string): Request => {
  const parts = args.split(/\s+/).filter((p) => p !== '')
  if (parts.length === 0) return { kind: 'status' }
  if (parts.length === 1 && parts[0] === 'off') return { kind: 'off' }
  if (parts.length === 2 && parts[0] === 'default' && (parts[1] === 'on' || parts[1] === 'off')) return { kind: 'default', mode: parts[1] }
  if (parts.length === 2 && parts[0] === 'unit' && (parts[1] === 'dollars' || parts[1] === 'tokens')) return { kind: 'unit', unit: parts[1] }
  if ((parts.length === 2 || parts.length === 3) && parts[0] === 'on') {
    const [, lead = '', count] = parts
    const pinned = count === undefined || (WHOLE.test(count) && Number(count) > 0)
    if (SECONDS.test(lead) && Number(lead) > 0 && pinned) {
      return { kind: 'on', leadMs: Number(lead) * 1000, count: count === undefined ? null : Number(count) }
    }
  }
  return { kind: 'usage' }
}

const secs = (ms: number) => `${ms / 1000} s`
// A round trip to one decimal, rounded up: never shorter than it was measured.
const secsUp = (ms: number) => `${(Math.ceil(ms / 100) / 10).toFixed(1)} s`

const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// The user's own prompts, typed or sent from the phone bridge; a peer's, a schedule's or a notification's do not re-arm.
export const isUserPrompt = (origin: { kind: string }): boolean => origin.kind === 'composer' || origin.kind === 'bridge'

// The idle gap is a boolean: open at rest, closed while a prompt enters or a main-thread turn runs, opened by the turn's end.
export const gapOpen = (k: KeepaliveState): boolean => k.gap

// A main-thread turn's first step: it is running, and the gap is closed. Its request writes the cache on the current model,
// so it also lifts a cold mark still pending: a mark whose write failed would otherwise hold pings for the session.
// Undefined when the turn was already counted.
export const turnBegun = (k: KeepaliveState, turnId: string): KeepaliveState | undefined => {
  if (k.lastTurn === turnId) return undefined
  return { ...k, lastTurn: turnId, active: true, gap: false, coldPending: false, generation: k.generation + 1 }
}

// A main-thread turn's end: the gap opens. A turn that never stepped opens it too.
export const turnEnded = (k: KeepaliveState, turnId: string): KeepaliveState | undefined => {
  if (k.lastTurn === turnId) return k.active ? { ...k, active: false, gap: true } : undefined
  return { ...k, lastTurn: turnId, active: false, gap: true, generation: k.generation + 1 }
}

// A submitted prompt closes the gap while it enters, so no ping is sent between it and its turn.
export const promptSubmitted = (k: KeepaliveState): KeepaliveState => ({
  ...k,
  gap: false,
  generation: k.generation + 1,
})

// A submitted prompt that another hook dropped, or whose entry threw, starts no turn: the gap reopens, unless a turn is running.
export const promptDropped = (k: KeepaliveState): KeepaliveState => ({ ...k, gap: !k.active })

// The session's reset: off, with the ping sequence kept. The generation only moves on, so a ping still in flight from before
// the reset can never match the state after it.
export const reset = (k: KeepaliveState): KeepaliveState => ({
  ...INITIAL,
  coldPending: k.coldPending,
  seq: k.seq,
  generation: k.generation + 1,
  pauseEpoch: k.pauseEpoch + 1,
})

// A cold mark is about to be written (a model switch or a compaction). Until it lands, no ping may start, and a ping in flight
// is stale: no tick that read the cache before the mark can commit a fork after it.
export const coldBegun = (k: KeepaliveState): KeepaliveState => ({ ...k, coldPending: true, generation: k.generation + 1 })

// The cold mark has landed; pings may consider the cache cold (the view reads it) from here.
export const coldLanded = (k: KeepaliveState): KeepaliveState => ({ ...k, coldPending: false, generation: k.generation + 1 })

// A user prompt refills the count and clears the stop reason. The count bounds unattended pings; each user prompt is
// the start of a new run of them. `runCount` is the run's count, which the caller resolves from the config and the prices.
export const rearm = (k: KeepaliveState, runCount: number): KeepaliveState => ({
  ...k,
  pauseEpoch: k.pauseEpoch + 1,
  ...(k.config === null ? {} : { remaining: runCount, runCount, stop: null }),
})

// Whether a run's count is held: pinned, or kept since its pause's first ping. A count that is not held follows the reasons.
const countHeld = (k: KeepaliveState): boolean => k.config !== null && (k.config.count !== null || k.remaining !== k.runCount)

// An unpinned run's count follows the prices until its first ping: a run enabled before the cache or the price list was read
// took the fallback count, and the break-even count replaces it once they are. A run that has pinged keeps its count.
export const recount = (k: KeepaliveState, runCount: number): KeepaliveState =>
  k.config === null || countHeld(k) || runCount === k.runCount ? k : { ...k, remaining: runCount, runCount }

// The count an unpinned run keeps though the reasons now give `runCount`, else null: held since its first ping, as recount holds it.
// The lines that name the count read it, so they say what the tick keeps.
export const keptCount = (k: KeepaliveState, runCount: number): number | null =>
  k.config !== null && k.config.count === null && countHeld(k) && runCount !== k.runCount ? k.runCount : null

// Whether a refresh is due: a known TTL, a lead below it, and a touch to count from (the caller passes the cache as keepalive
// counts it). `expired` is whether the cache has lapsed by now.
type Readiness =
  | { kind: 'not-ready' }
  | { kind: 'ready'; dueMs: number; expired: boolean }

const readiness = (view: CacheView, leadMs: number, liveMs: number | null, nowMs: number): Readiness => {
  const touch = view.kind === 'known' ? touchOf(view, liveMs) : null
  if (view.kind !== 'known' || touch === null || leadMs >= view.ttlMs) return { kind: 'not-ready' }
  const expiryMs = touch + view.ttlMs
  return { kind: 'ready', dueMs: expiryMs - leadMs, expired: nowMs >= expiryMs }
}

// The stop a run enabled now starts with: the cache has already lapsed, so the run stays paused until a prompt. Null otherwise.
export const enabledStop = (view: CacheView, leadMs: number, liveMs: number | null, nowMs: number): string | null => {
  const r = readiness(view, leadMs, liveMs, nowMs)
  return r.kind === 'ready' && r.expired ? 'cache expired' : null
}

// The toggle's state change: a new config, a full count, a fresh generation. `count` is the pinned count, or null for the
// break-even one; `runCount` is the count this run sends, resolved by the caller. A run enabled on a cache that has already
// lapsed starts paused by it, as a stop (enabledStop); otherwise it is on, and its refresh is due when the figures say.
export const enable = (
  k: KeepaliveState,
  leadMs: number,
  count: number | null,
  runCount: number,
  view: CacheView,
  liveMs: number | null,
  nowMs: number,
): KeepaliveState => ({
  ...k,
  config: { leadMs, count },
  remaining: runCount,
  runCount,
  stop: enabledStop(view, leadMs, liveMs, nowMs),
  last: null,
  lastUsed: { leadMs, count },
  generation: k.generation + 1,
})

// The word the bare command's Keepalive heading carries: keepalive's state, one of five.
export type Heading = 'off' | 'on, refreshing' | 'on, no count' | 'paused' | 'stopped'

// What the bare command says about the state, and what the tick does with it. The heading word, the reason line (why keepalive is
// paused or stopped, when it is) and the lines beneath it are what the command shows; the kind and a stop's reason are what the tick
// reads. A `ping` is the only way a fork starts, and only while the idle gap is open, a count is left and nothing has stopped it.
type Shown = { heading: Heading; why: string | null; lines: string[] }
export type Step =
  | ({ kind: 'ping' } & Shown)
  | ({ kind: 'stop'; reason: string } & Shown)
  | ({ kind: 'wait' } & Shown)

// The settled verdict in the pieces `step` composes its lines from: the figure lines, then the schedule line where the branch gives one.
type Settled = { heading: Heading; why: string | null; figure: string[]; schedule?: string } & ({ kind: 'ping' } | { kind: 'wait' } | { kind: 'stop'; reason: string })

// The last refresh's read and write, a line of its own after the figures, so a live session can check the served threshold.
const lastOf = (k: KeepaliveState): string[] => (k.last === null ? [] : [`last refresh read ${k.last.read}, wrote ${k.last.write}`])

type KnownView = Extract<CacheView, { kind: 'known' }>

// The interval between pings as the figures say it: minutes and seconds when there are seconds, else whole minutes.
const intervalOf = (ms: number): string => {
  const s = Math.round(ms / 1000)
  const seconds = s % 60
  return seconds === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)}:${String(seconds).padStart(2, '0')}`
}

// The running figure the bare command's Keepalive lines name: the context each ping reads, and how often.
// Null where there is no known TTL with a lead below it, so no figure is real.
const figuresOf = (view: CacheView, leadMs: number, money: Money): string | null =>
  view.kind === 'known' && leadMs < view.ttlMs ? `${nextPing(view, money)}, every ${intervalOf(view.ttlMs - leadMs)}` : null

// Paused by design: keepalive is on and waits for the next user prompt, because its count or the cache's expiry ended it.
export const armedOf = (k: KeepaliveState): boolean => k.config !== null && k.stop !== null && ENDED_BY_DESIGN.includes(k.stop)

// Why a stop reads as a clause: the design stops in words, any other stop as it was given.
const WHY: Record<string, string> = { 'count used': 'its refreshes for this pause are used up', 'cache expired': 'the cache expired' }
const whyOf = (stop: string): string => WHY[stop] ?? stop

// The two stop sentences, each written once here: every wording of a stop reads one of them.
const byDesignSentence = (stop: string): string => `${whyOf(stop)}; it resumes after your next prompt`
const failureSentence = (stop: string): string => `${stop}; your next prompt restarts it`

// What an enabled keepalive says a refresh would cost when it resumes: the context each refresh reads, not a run's interval.
const rereadFigure = (view: CacheView, money: Money): string | null => {
  if (view.kind !== 'known') return null
  const usd = pingUsd(view, money)
  const read = `${kTokens(view.promptTokens)} cached tokens`
  return usd === null ? `each refresh reads ${read}` : `each refresh costs ${dollars(usd)} (reads ${read})`
}

// A paused-by-design verdict: the stop's by-design sentence, what a refresh would read once it resumes, and how often one would be
// sent wherever figureAt gives the figure of one at the run's lead.
const pausedBy = (view: CacheView, leadMs: number, money: Money, reason: string): { heading: Heading; why: string; figure: string[] } => {
  const reread = rereadFigure(view, money)
  const interval = figureAt(view, leadMs, money)
  return { heading: 'paused', why: byDesignSentence(reason), figure: [...(reread === null ? [] : [reread]), ...(interval === null ? [] : [interval.figures])] }
}

// The settled verdict: the one a state with no cold mark pending gives, `gap` being whether the main thread is idle (no turn running).
// It reads no pending flag, so `step` lays the pending-write overlay over it.
const settledOf = (k: KeepaliveState, leadMs: number, view: CacheView, liveMs: number | null, gap: boolean, nowMs: number, money: Money): Settled => {
  const figures = figuresOf(view, leadMs, money)
  const running = figures === null ? [] : [figures]
  if (armedOf(k)) return { kind: 'wait', ...pausedBy(view, leadMs, money, k.stop ?? '') }
  if (k.stop !== null) return { kind: 'wait', heading: 'stopped', why: failureSentence(k.stop), figure: running }
  const r = readiness(view, leadMs, liveMs, nowMs)
  if (r.kind === 'not-ready' || figures === null) {
    if (view.kind === 'known' && leadMs >= view.ttlMs) {
      return { kind: 'wait', heading: 'paused', why: `lead ${secs(leadMs)} is not below the ${secs(view.ttlMs)} TTL`, figure: [] }
    }
    // A no-cache view's next reply is what writes a cache, so its line says so; a TTL-unknown or unread view may hold one unseen, so it says nothing of replies.
    const reply = view.kind === 'no-cache' ? '; there is no cache until the next reply' : ''
    return { kind: 'wait', heading: 'on, no count', why: null, figure: [`no live cache to count from, nothing scheduled${reply}`] }
  }
  if (r.expired) return { kind: 'stop', reason: 'cache expired', ...pausedBy(view, leadMs, money, 'cache expired') }
  // A learned count of no pings: nothing is sent, and the run stays on, so a prompt that learns otherwise can still ping.
  if (k.runCount === 0) {
    return { kind: 'wait', heading: 'paused', why: 'no refreshes this pause: your pauses rarely outlast the cache; it resumes after your next prompt', figure: [figures] }
  }
  if (k.remaining <= 0) return { kind: 'stop', reason: 'count used', ...pausedBy(view, leadMs, money, 'count used') }
  const refreshing = { heading: 'on, refreshing' as const, why: null }
  if (nowMs < r.dueMs) {
    return { kind: 'wait', ...refreshing, figure: [figures], schedule: `next refresh in ${clock(r.dueMs - nowMs)}, ${k.remaining} left` }
  }
  if (!gap) return { kind: 'wait', ...refreshing, figure: [figures], schedule: 'refresh due, waits for the turn to end' }
  return { kind: 'ping', ...refreshing, figure: [figures] }
}

// While a cold mark's write is pending and no stop is held, the verdict is paused until the write is recorded: the settled reason and
// figure stay, and the schedule line goes, since a refresh is held while the write is pending.
export const step = (k: KeepaliveState, view: CacheView, liveMs: number | null, gap: boolean, nowMs: number, money: Money): Step => {
  if (k.config === null) return { kind: 'wait', heading: 'off', why: null, lines: [] }
  const settled = settledOf(k, k.config.leadMs, view, liveMs, gap, nowMs, money)
  const last = lastOf(k)
  if (k.stop === null && k.coldPending) {
    return { kind: 'wait', heading: 'paused', why: 'until the cache reset is recorded', lines: [...(settled.why === null ? [] : [settled.why]), ...settled.figure, ...last] }
  }
  const lines = [...settled.figure, ...(settled.schedule === undefined ? [] : [settled.schedule]), ...last]
  const verdict = { heading: settled.heading, why: settled.why, lines }
  return settled.kind === 'stop' ? { kind: 'stop', reason: settled.reason, ...verdict } : { kind: settled.kind, ...verdict }
}

// What one ping on the current cache costs: a read of its whole context, at the model and speed that wrote it.
const pingSpend = (view: KnownView, money: Money): Spend =>
  spendOf(money.list, view.model, view.speed, { ...NO_KINDS, read: view.promptTokens })

// A ping's dollars when they are shown: the unit is dollars and the ping has a price. Null shows the ping in tokens.
const pingUsd = (view: KnownView, money: Money): number | null => (money.unit === 'dollars' ? pingSpend(view, money).usd : null)

// The next refresh's cost, the one wording every surface uses: the details pane, the status line, and the toggle.
const nextPing = (view: KnownView, money: Money): string => {
  const usd = pingUsd(view, money)
  const read = `${kTokens(view.promptTokens)} cached tokens read`
  return usd === null ? `Next refresh: ${read}` : `Next refresh: ${dollars(usd)} (${read})`
}

// The figure of one refresh at a lead: what it costs, or the context it reads, and how often at that lead. Null with no known cache,
// or a lead at or above its TTL, which sends no refresh.
const figureAt = (view: CacheView, leadMs: number, money: Money): HintCost | null => {
  if (view.kind !== 'known' || leadMs >= view.ttlMs) return null
  const usd = pingUsd(view, money)
  return {
    label: usd === null ? `${kTokens(view.promptTokens)} read/refresh` : `${dollars(usd)}/refresh`,
    explain: `${nextPing(view, money)}.`,
    figures: `One refresh every ${intervalOf(view.ttlMs - leadMs)}.`,
  }
}

// The figure keepalive's refreshes show while it runs: what each refresh costs, or the context it reads, and how often. Shown
// while it runs, a refresh in flight included; null when it is off, stopped, paused, or learned no refreshes for this pause, so
// the pie warns instead.
export const costOf = (k: KeepaliveState, view: CacheView, money: Money): HintCost | null =>
  k.config === null || k.stop !== null || k.runCount === 0 ? null : figureAt(view, k.config.leadMs, money)

// The figure a press would show while keepalive is off: the run a press would start, at the lead and count it would use. The details
// pane and the hover above the time show it. Null where that run sends no refresh.
export const offerOf = (view: CacheView, money: Money, leadMs: number, runCount: number): HintCost | null =>
  runCount === 0 ? null : figureAt(view, leadMs, money)

// Stops that end keepalive by design. Any other stop, and a pause from a lead at or above the TTL, is a failure the status
// line names in one clause; the footer names neither.
const ENDED_BY_DESIGN: readonly string[] = ['count used', 'cache expired']

// What the status line says keepalive has failed at, as one clause with no refresh figures; null when it has not failed.
export const failureOf = (k: KeepaliveState, view: CacheView): string | null => {
  if (k.config === null) return null
  if (k.stop !== null) return ENDED_BY_DESIGN.includes(k.stop) ? null : `keepalive stopped: ${k.stop}`
  return view.kind === 'known' && k.config.leadMs >= view.ttlMs ? `keepalive paused: lead ${secs(k.config.leadMs)} is not below the ${secs(view.ttlMs)} TTL` : null
}

// Why keepalive is on and not refreshing, as the pane's sentence after `Keepalive is paused:`; null while it refreshes or is off.
// A lead at or above the TTL is no prompt's to fix, so its sentence does not say it resumes.
export const pausedWhy = (k: KeepaliveState, view: CacheView, expired: boolean): string | null => {
  if (k.config === null) return null
  if (k.stop !== null) return ENDED_BY_DESIGN.includes(k.stop) ? byDesignSentence(k.stop) : failureSentence(k.stop)
  if (view.kind !== 'known') return 'there is no cache until the next reply'
  if (k.config.leadMs >= view.ttlMs) return `the lead ${secs(k.config.leadMs)} is not below the ${secs(view.ttlMs)} TTL`
  if (expired) return byDesignSentence('cache expired')
  if (k.runCount === 0) return 'your pauses rarely outlast the cache, so no refresh is sent; it resumes after your next prompt'
  return null
}

// The pie's click: keepalive on turns it off, as `/keepalive off` does; off turns it on with the lead and count last used this
// session, else the plugin's values.
export type Press = { kind: 'off' } | { kind: 'on'; leadMs: number; count: number | null }

export const pressOf = (k: KeepaliveState, defaults: Defaults): Press => {
  if (k.config !== null) return { kind: 'off' }
  const values = k.lastUsed ?? defaults
  return { kind: 'on', leadMs: values.leadMs, count: values.count }
}

// The click's values from the plugin's options: the lead, no pinned count, and the cap on a run's count, null when unset. The
// engine checks each declared type before the load; a value of the right type that cannot be a lead or a cap is refused here,
// by name, so the load says what is wrong.
// `count` is the count an unpinned run sends when one is learned, else null for break-even.
export type Defaults = { leadMs: number; count: number | null; cap: number | null }

export const defaultsOf = (options: PluginOptions): Defaults => {
  const lead = options.keepalive_lead_s
  // An unset number field reaches the module as the empty string.
  const cap = options.keepalive_count === '' ? undefined : options.keepalive_count
  if (typeof lead !== 'number' || !(lead > 0)) throw new Error('cachier: option keepalive_lead_s must be a positive number of seconds')
  if (cap !== undefined && (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0)) {
    throw new Error('cachier: option keepalive_count must be a whole number of refreshes above zero')
  }
  return { leadMs: lead * 1000, count: null, cap: cap ?? null }
}

// Why a ping did not keep the cache alive, or null when it was answered. A fork that answered without reading the cache
// paid for the whole prefix; a reply with no usage at all (the fork had nothing to fork) gives no reason here.
export const reasonOf = (r: ModelForkResult): string | null => {
  if (r.isAnswered) return null
  switch (r.reason) {
    case 'nothing-to-fork':
      return 'nothing to fork yet'
    case 'api-error': {
      const what = r.status === null ? 'API error, no response' : `API error ${r.status}`
      return `${what} (${r.error})`
    }
    case 'empty-reply':
      return 'empty reply'
    case 'aborted':
      return 'aborted'
  }
}

// A fork's outcome: an answer, or the reason it was not, an empty reply's included. It is the debug line's.
export const outcomeOf = (r: ModelForkResult): string => reasonOf(r) ?? 'answered'

// A fork's usage, or null for a reply that reports none.
export const usageOf = (r: ModelForkResult): ModelUsage | null => ('usage' in r ? r.usage : null)

// Why a fork's reply must stop keepalive, or null when keepalive may go on. An answer, or an empty reply that reports its usage, is
// judged by the cache it read, since a refresh exists to read the cache. Any other reply stops keepalive with its reason (reasonOf).
export const stopFor = (r: ModelForkResult): string | null => {
  const usage = usageOf(r)
  if (!r.isAnswered && (r.reason !== 'empty-reply' || usage === null)) return reasonOf(r)
  if (usage !== null && usage.cache_read_input_tokens === 0) return 'reply not served from cache'
  return null
}

// A ping whose reply has not come by the TTL: the cache may have lapsed while it was in flight, so keepalive stops with it.
export const lapsedReason = (ttlMs: number): string => `round trip over ${secs(ttlMs)} TTL, no reply yet`

// A raised lead past half the TTL stops keepalive: no lead above that keeps 2x headroom under the TTL. Exactly half still raises.
export const pastHalfTtl = (raisedMs: number, ttlMs: number): boolean => raisedMs > ttlMs / 2
// That stop's reason: the round trip measured, and the lead it would need.
export const pastHalfTtlStop = (rtMs: number, raisedMs: number, ttlMs: number): string =>
  `a ${secsUp(rtMs)} round trip needs a ${secs(raisedMs)} lead, over half the ${secs(ttlMs)} TTL`

// The lead after a ping whose round trip was `rtMs`: a round trip over half the lead raises it to twice the round trip, rounded up
// to whole seconds. A lead is never lowered, so without such a round trip the lead is `leadMs` unchanged.
export const raisedLeadOf = (leadMs: number, rtMs: number): number => (rtMs > leadMs / 2 ? Math.ceil((2 * rtMs) / 1000) * 1000 : leadMs)

// The details pane's sentence for a raised lead.
export const raiseNote = (leadMs: number): string => `The lead was raised to ${secs(leadMs)} after a slow refresh.`

// A count of refreshes, singular for one.
const refreshesOf = (count: number): string => (count === 1 ? '1 refresh' : `${count} refreshes`)

// The cost `/keepalive on` answers with: the context each refresh reads, how often, and that the first refresh after a turn can write.
export const costText = (view: KnownView, leadMs: number, count: number, money: Money): string => {
  return `${nextPing(view, money)}, every ${intervalOf(view.ttlMs - leadMs)} (${view.ttlLabel} TTL less the ${secs(leadMs)} lead). The first refresh after a turn can also write that turn's new tokens. ${refreshesOf(count)}, then it stops until a prompt.`
}

// What the toggle says when it turns keepalive on: the cost with its figures when the view allows it, else what it is
// waiting for, and any stop it has already reached.
export const enableText = (view: CacheView, leadMs: number, count: number, stop: string | null, money: Money): string => {
  const head = `keepalive on: lead ${secs(leadMs)}, ${refreshesOf(count)}.`
  const armed = stop !== null && ENDED_BY_DESIGN.includes(stop)
  const tail = stop === null ? '' : armed ? ` Paused: ${byDesignSentence(stop)}.` : ` Stopped: ${failureSentence(stop)}.`
  if (view.kind !== 'known') return `${head} No live cache to count from yet, so nothing is scheduled until there is one.${tail}`
  if (leadMs >= view.ttlMs) return `${head} Paused: lead ${secs(leadMs)} is not below the ${secs(view.ttlMs)} TTL.${tail}`
  return `${head} ${armed ? `${capital(rereadFigure(view, money) ?? '')}.` : costText(view, leadMs, count, money)}${tail}`
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

// The debug line of one ping, written once its outcome is known. `stale` marks a result from a generation the state has since
// left, or one that came after the TTL lapsed: it changed nothing.
export type PingLine = {
  time: string
  seq: number
  generation: number
  lead_s: number
  ttl_s: number
  round_trip_ms: number
  usage: { read: number; write: number; input: number; output: number } | null
  outcome: string
  stale: boolean
}

export const pingLine = (p: {
  decidedMs: number
  seq: number
  generation: number
  leadMs: number
  ttlMs: number
  roundTripMs: number
  usage: ModelUsage | null
  outcome: string
  stale: boolean
}): PingLine => ({
  time: new Date(p.decidedMs).toISOString(),
  seq: p.seq,
  generation: p.generation,
  lead_s: p.leadMs / 1000,
  ttl_s: p.ttlMs / 1000,
  round_trip_ms: p.roundTripMs,
  usage:
    p.usage === null
      ? null
      : {
          read: p.usage.cache_read_input_tokens,
          write: p.usage.cache_creation_input_tokens,
          input: p.usage.input_tokens,
          output: p.usage.output_tokens,
        },
  outcome: p.outcome,
  stale: p.stale,
})

// The tallies: every fork counts, stale ones and late ones included, and what it read and wrote is its spend. A reply with
// no usage adds none.
export const ZERO_TALLY: Tally = { pings: 0, spend: NO_SPEND }
export const INITIAL_TALLY: TallyState = { pause: ZERO_TALLY, session: ZERO_TALLY, raisedMs: null, epoch: 0 }

const addTally = (t: Tally, pings: number, spend: Spend | null): Tally => ({
  pings: t.pings + pings,
  spend: spend === null ? t.spend : addSpend(t.spend, spend),
})

// A fork counted once: its send adds the ping, and a reply that came after the TTL adds only its tokens. Both go to the pause only
// if the fork was sent in the current pause (`pauseEpoch`, the pause's epoch when it was sent). A raise this ping made is kept as
// the session's raised lead.
export const countPing = (
  t: TallyState,
  spend: Spend | null,
  raisedMs: number | null,
  ping: { late: boolean; pauseEpoch: number },
): TallyState => {
  const pings = ping.late ? 0 : 1
  return {
    pause: ping.pauseEpoch === t.epoch ? addTally(t.pause, pings, spend) : t.pause,
    session: addTally(t.session, pings, spend),
    raisedMs: raisedMs ?? t.raisedMs,
    epoch: t.epoch,
  }
}

// A user's prompt starts a new idle stretch: the pause's tally is cleared, and a fork sent before it counts no more into it.
export const restartPause = (t: TallyState, pauseEpoch: number): TallyState => ({ ...t, pause: ZERO_TALLY, epoch: pauseEpoch })

export const tallyOf = (label: string, t: Tally, unit: Money['unit']): string => `${label}: ${refreshesOf(t.pings)} costing ${figureOf(t.spend, unit)}.`

// A fork's usage as a spend: its uncached input, its read, and its write at the TTL of the cache it was sent on, priced at
// the main thread's model and speed (a fork that reads the cache runs on both, since a switch would have invalidated it).
export const forkSpend = (usage: ModelUsage, view: KnownView, money: Money): Spend => {
  const write = usage.cache_creation_input_tokens
  return spendOf(money.list, view.model, view.speed, {
    input: usage.input_tokens,
    read: usage.cache_read_input_tokens,
    write5m: view.ttlLabel === '1h' ? 0 : write,
    write1h: view.ttlLabel === '1h' ? write : 0,
  })
}

