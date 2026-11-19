// Keepalive's decisions, pure: what the toggle accepts, the gap and turn bookkeeping, what one tick does with the state
// and the reader's TTL and touch, the status line's and the footer line's words, how a ping's outcome is
// judged, and the debug line of a ping. register.ts holds the state, writes it, and makes the fork; nothing here reads the engine.
import type { ModelApiError, ModelForkResult, ModelUsage, PluginOptions } from 'claude-code'
import type { CacheView, HintCost, KeepaliveState, RestFact, Spend, Tally, TallyState, Unit } from '../types'
import { expiredAt, expiryOf, labelled, type Tone } from './countdown'
import { addSpend, cachedOf, dollars, figureOf, NO_KINDS, NO_SPEND, readOf, spendOf, uponOf, writtenOf, type Money } from './prices'
import type { Line } from './sections'
import { notBelowTtl, refreshIntervalMs, SECONDS_SUFFIX, secs, secsTerse } from './setup'

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

// The text of an `on`, `off` or `default` request, as parseRequest reads it back: the lead is the milliseconds over the parser's 1000,
// printed as JavaScript prints the number, which reads back to the same milliseconds for any lead that is a number of seconds times 1000.
export const printRequest = (request: Extract<Request, { kind: 'on' | 'off' | 'default' }>): string =>
  request.kind === 'off'
    ? '/keepalive off'
    : request.kind === 'default'
      ? `/keepalive default ${request.mode}`
      : `/keepalive on ${request.leadMs / 1000}${request.count === null ? '' : ` ${request.count}`}`

// A round trip to one decimal, rounded up: never shorter than it was measured.
const secsUp = (ms: number) => `${(Math.ceil(ms / 100) / 10).toFixed(1)}${SECONDS_SUFFIX}`

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
  const expiryMs = expiryOf(view, liveMs)
  if (view.kind !== 'known' || expiryMs === null || refreshIntervalMs(leadMs, view.ttlMs) === null) return { kind: 'not-ready' }
  return { kind: 'ready', dueMs: expiryMs - leadMs, expired: expiredAt(view, liveMs, nowMs) }
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

// The tone the pane draws each heading word in, from the pie's vocabulary. It follows keepalive's state, which the pie's tone tells only as on or off: with
// keepalive on the pie is green whatever the state, so `on, no count` (a waiting state worth a glance) and `paused` are amber and `stopped` red, beside a green
// pie. Total over `Heading`, so a state added later fails `tsc` until it has a tone.
export const HEADING_TONE: Record<Heading, Tone> = {
  off: 'gone',
  'on, refreshing': 'on',
  'on, no count': 'warning',
  paused: 'warning',
  stopped: 'alarm',
}

// What the bare command says about the state, and what the tick does with it. The heading word, the reason line (why keepalive is
// paused or stopped, when it is) and the lines beneath it are what the command shows; the kind and a stop's reason are what the tick
// reads. A `ping` is the only way a fork starts, and only while the idle gap is open, a count is left and nothing has stopped it.
type Shown = { heading: Heading; why: string | null; lines: Line[] }
export type Step =
  | ({ kind: 'ping' } & Shown)
  | ({ kind: 'stop'; reason: string } & Shown)
  | ({ kind: 'wait' } & Shown)

// The settled verdict in the pieces `step` composes its lines from: the figure lines, then the schedule line where the branch gives one.
type Settled = { heading: Heading; why: string | null; figure: Line[]; schedule?: Line } & ({ kind: 'ping' } | { kind: 'wait' } | { kind: 'stop'; reason: string })

// The last refresh's read and write, a line of its own after the figures, so a live session can check the served threshold.
const lastOf = (k: KeepaliveState): Line[] => (k.last === null ? [] : [labelled('last refresh:', ` ${k.last.read} read · ${k.last.write} written`)])

type KnownView = Extract<CacheView, { kind: 'known' }>

// The interval between pings as the figures say it: minutes and seconds when there are seconds, else whole minutes.
const intervalOf = (ms: number): string => {
  const s = Math.round(ms / 1000)
  const seconds = s % 60
  return seconds === 0 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 60)}:${String(seconds).padStart(2, '0')}`
}

// The running lines the bare command's Keepalive section names: the context each ping reads, how often, and while the cache is warm
// what its rebuild would cost. Null where there is no known TTL with a lead below it, so no figure is real.
const figuresOf = (view: CacheView, leadMs: number, money: Money, pair: Pair): Line[] | null => {
  if (view.kind !== 'known') return null
  const interval = refreshIntervalMs(leadMs, view.ttlMs)
  if (interval === null) return null
  const tail = ` · every ${intervalOf(interval)}`
  const stated = pairing(view, money, pair)
  return stated === null ? [nextRefreshRow(view, money, tail)] : [refreshRow(view, money, tail), ...rebuildRows(stated.rebuilt)]
}

// The stop the user's daily rest gives: keepalive stops its refreshes for the rest, and resumes at the user's next prompt.
export const OVERNIGHT_STOP = 'overnight'

// The stop a run gives when its count is used: the refreshes of the pause are all sent, and it resumes at the user's next prompt.
const COUNT_USED = 'count used'

// Paused by design: keepalive is on and waits for the next user prompt, because its count, the cache's expiry or the user's rest ended it.
export const armedOf = (k: KeepaliveState): boolean => k.config !== null && k.stop !== null && ENDED_BY_DESIGN.includes(k.stop)

// Why a stop reads as a clause in the `/keepalive on` answer: the design stops in words, any other stop as it was given.
const WHY: Record<string, string> = {
  [COUNT_USED]: 'its refreshes for this pause are used up',
  'cache expired': 'the cache expired',
  [OVERNIGHT_STOP]: 'your daily rest began',
}
const whyOf = (stop: string): string => WHY[stop] ?? stop

// The answer's two stop sentences, each written once here: every wording of a stop in the answer reads one of them.
const byDesignSentence = (stop: string): string => `${whyOf(stop)}; it resumes after your next prompt`
const failureSentence = (stop: string): string => `${stop}; your next prompt restarts it`

// The section's two stop tails, the terse pair beside the sentences: the by-design half names its reason as it is stored, `count used`,
// `cache expired` or `overnight` included, so those keys are words the user reads.
const byDesignTerse = (reason: string): string => `${reason} · resumes on next prompt`
const failureTerse = (stop: string): string => `${stop} · restarts on next prompt`

// The figure of one refresh of a warm cache, which `/keepalive on` and the section each wrap: dollars first where it has them, and the cached tokens.
const cachedParts = (view: KnownView, money: Money): { usd: string | null; cached: string } => {
  const usd = pingUsd(view, money)
  return { usd: usd === null ? null : dollars(usd), cached: cachedOf(view.promptTokens) }
}
const cachedFigure = (view: KnownView, money: Money): string => {
  const { usd, cached } = cachedParts(view, money)
  return usd === null ? cached : `${usd} (${cached})`
}

// The section's refresh row on a warm cache: the warm row and the armed row of a pause by design read the same figure. `tail` is what follows the figure on the row.
const refreshRow = (view: KnownView, money: Money, tail = ''): Line => labelled('refresh', ` ${cachedFigure(view, money)}${tail}`)

// What an enabled keepalive says a refresh would cost when it resumes on an expired cache: the context each refresh reads, not a run's interval.
const rereadFigure = (view: CacheView, money: Money): string | null => {
  if (view.kind !== 'known') return null
  const { usd, cached } = cachedParts(view, money)
  return usd === null ? `each refresh reads ${cached}` : `each refresh costs ${usd} (reads ${cached})`
}

// The section's rebuild row, empty where no rebuild is priced.
const rebuildRows = (rebuilt: string | null): Line[] => (rebuilt === null ? [] : [labelled('if cold:', ` rebuild ${rebuilt}`)])

// A paused-by-design verdict: the reason with its by-design tail, what a refresh would read once it resumes, how often one would be sent
// wherever the run's lead gives an interval, and while the cache is warm what its rebuild would cost.
const pausedBy = (view: CacheView, leadMs: number, money: Money, reason: string, pair: Pair): { heading: Heading; why: string; figure: Line[] } => {
  const stated = pairing(view, money, pair)
  const interval = intervalRow(view, leadMs)
  return {
    heading: 'paused',
    why: byDesignTerse(reason),
    figure: [...(view.kind === 'known' ? [refreshRow(view, money)] : []), ...(interval === null ? [] : [interval]), ...(stated === null ? [] : rebuildRows(stated.rebuilt))],
  }
}

// The settled verdict: the one a state with no cold mark pending gives, `gap` being whether the main thread is idle (no turn running).
// `rest` is what the user's daily rest says: a held one stops keepalive whatever the cache, and a due one stops a run that would
// otherwise go on. It reads no pending flag, so `step` lays the pending-write overlay over it.
const settledOf = (k: KeepaliveState, leadMs: number, view: CacheView, liveMs: number | null, gap: boolean, nowMs: number, money: Money, rebuild: Spend | null, rest: RestFact): Settled => {
  // Whether the cache is warm is asked of the expiry owner once, whatever the lead, for every line that states a price.
  const pair = { warm: !expiredAt(view, liveMs, nowMs), rebuild }
  const figures = figuresOf(view, leadMs, money, pair)
  const running = figures ?? []
  if (armedOf(k)) return { kind: 'wait', ...pausedBy(view, leadMs, money, k.stop ?? '', pair) }
  if (k.stop !== null) return { kind: 'wait', heading: 'stopped', why: failureTerse(k.stop), figure: running }
  // The step already taken stands until the user acts: a state that lost the stop (a start that reset it, a reload) is stopped again, whatever the cache.
  if (rest.kind === 'held') return { kind: 'stop', reason: OVERNIGHT_STOP, ...pausedBy(view, leadMs, money, OVERNIGHT_STOP, pair) }
  const r = readiness(view, leadMs, liveMs, nowMs)
  if (r.kind === 'not-ready' || figures === null) {
    if (view.kind === 'known' && refreshIntervalMs(leadMs, view.ttlMs) === null) {
      return { kind: 'wait', heading: 'paused', why: `${notBelowTtl(leadMs, view.ttlMs)} · sends nothing`, figure: rebuildRows(pairing(view, money, pair)?.rebuilt ?? null) }
    }
    // A no-cache view's next reply is what writes a cache, so its line says so; a TTL-unknown or unread view may hold one unseen, so it says nothing of replies.
    const reply = view.kind === 'no-cache' ? ' · cache from next reply' : ''
    return { kind: 'wait', heading: 'on, no count', why: null, figure: [`no live cache · nothing scheduled${reply}`] }
  }
  if (r.expired) return { kind: 'stop', reason: 'cache expired', ...pausedBy(view, leadMs, money, 'cache expired', pair) }
  // A learned count of no pings: nothing is sent, and the run stays on, so a prompt that learns otherwise can still ping.
  if (k.runCount === 0) {
    return { kind: 'wait', heading: 'paused', why: byDesignTerse('0 refreshes this pause (learned: pauses rarely outlast TTL)'), figure: figures }
  }
  if (k.remaining <= 0) return { kind: 'stop', reason: COUNT_USED, ...pausedBy(view, leadMs, money, COUNT_USED, pair) }
  // Here the cache is warm, a count is left and a refresh is wanted: a rest that has begun ends the run, ahead of a refresh due at the same moment.
  if (rest.kind === 'due' && gap) return { kind: 'stop', reason: OVERNIGHT_STOP, ...pausedBy(view, leadMs, money, OVERNIGHT_STOP, pair) }
  const refreshing = { heading: 'on, refreshing' as const, why: null }
  if (nowMs < r.dueMs) {
    return { kind: 'wait', ...refreshing, figure: figures, schedule: labelled('next in', ` ${clock(r.dueMs - nowMs)} · ${k.remaining} left`) }
  }
  if (!gap) return { kind: 'wait', ...refreshing, figure: figures, schedule: 'refresh due · waits for turn end' }
  return { kind: 'ping', ...refreshing, figure: figures }
}

// While a cold mark's write is pending and no stop is held, the verdict is paused until the write is recorded: the settled reason and
// figure stay, and the schedule line goes, since a refresh is held while the write is pending. `rebuild` is what the next prompt pays to
// rebuild the cache if it goes cold; handed null, the lines state no rebuild price, as at the tick, which reads only the kind and the stop.
export const step = (k: KeepaliveState, view: CacheView, liveMs: number | null, gap: boolean, nowMs: number, money: Money, rebuild: Spend | null, rest: RestFact): Step => {
  if (k.config === null) return { kind: 'wait', heading: 'off', why: null, lines: [] }
  const settled = settledOf(k, k.config.leadMs, view, liveMs, gap, nowMs, money, rebuild, rest)
  const last = lastOf(k)
  if (k.stop === null && k.coldPending) {
    return { kind: 'wait', heading: 'paused', why: 'recording cache reset', lines: [...(settled.why === null ? [] : [settled.why]), ...settled.figure, ...last] }
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

// The next refresh's figure as an expired cache states it, which the section and the answer each wrap.
const nextPing = (view: KnownView, money: Money): string => {
  const usd = pingUsd(view, money)
  const read = readOf(view.promptTokens)
  return usd === null ? read : `${dollars(usd)} (${read})`
}

// The section's next refresh row on an expired cache: the next ping's figure. `tail` is what follows the figure on the row.
const nextRefreshRow = (view: KnownView, money: Money, tail = ''): Line => labelled('next refresh', ` ${nextPing(view, money)}${tail}`)

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

// Whether the cache is warm, and what the next prompt pays to rebuild it if it goes cold, null where no rebuild is priced. The caller
// answers `warm` from the expiry owner: keepalive counts a refresh's price, and the pair states it, only while the cache is warm.
export type Pair = { warm: boolean; rebuild: Spend | null }

// The pair of prices a warm cache states, each half worded once: the hover's label, the rebuild half of it alone as `bare`, the warm
// refresh's figure, and the rebuild's, null where no rebuild is priced. The figures are bare: the section and the `/keepalive on` answer each
// wrap them. Null for an expired cache or a view with no figures, which keep the refresh's price alone.
const pairing = (view: CacheView, money: Money, pair: Pair): { label: string; bare: string | null; figure: string; rebuilt: string | null } | null => {
  if (view.kind !== 'known' || !pair.warm) return null
  const usd = pingUsd(view, money)
  const spend = pair.rebuild
  const written = spend === null ? '' : writtenOf(spend.write5m + spend.write1h)
  const rebuilt = spend !== null && money.unit === 'dollars' && spend.usd !== null ? `${uponOf(spend, money.unit)} (${written})` : written
  const bare = spend === null ? null : `if cold ${uponOf(spend, money.unit)} rebuild`
  return {
    label: `keep warm ${usd === null ? readOf(view.promptTokens) : dollars(usd)}/refresh${bare === null ? '' : ` · ${bare}`}`,
    bare,
    figure: cachedFigure(view, money),
    rebuilt: spend === null ? null : rebuilt,
  }
}

// The interval between refreshes at a lead as its own row of the section: null where the lead sends no refresh.
const intervalRow = (view: CacheView, leadMs: number): string | null => {
  const interval = view.kind === 'known' ? refreshIntervalMs(leadMs, view.ttlMs) : null
  return interval === null ? null : `every ${intervalOf(interval)}`
}

// The figure of one refresh at a lead, worked out where it is stated: its label, which the footer and the hover keep, and the lines the
// Keepalive section states: the refresh's price, the interval row, and while the cache is warm the rebuild's price.
export type Figure = HintCost & { lines: Line[] }

// The figure of one refresh at a lead: what it costs, or the context it reads, and how often at that lead. Null with no known cache,
// or a lead at or above its TTL, which sends no refresh.
const figureAt = (view: CacheView, leadMs: number, money: Money, pair: Pair): Figure | null => {
  const row = intervalRow(view, leadMs)
  if (view.kind !== 'known' || row === null) return null
  const stated = pairing(view, money, pair)
  if (stated !== null) return { label: stated.label, lines: [refreshRow(view, money), row, ...rebuildRows(stated.rebuilt)] }
  const usd = pingUsd(view, money)
  return { label: usd === null ? `${readOf(view.promptTokens)}/refresh` : `${dollars(usd)}/refresh`, lines: [nextRefreshRow(view, money), row] }
}

// The lead a run's refreshes go at, whether or not a stop stands: null with keepalive off, a learned count of 0, no known cache, or a lead not below the cache's TTL, which sends none.
const sendingLeadOf = (k: KeepaliveState, view: CacheView): number | null =>
  k.config === null || k.runCount === 0 || view.kind !== 'known' || refreshIntervalMs(k.config.leadMs, view.ttlMs) === null ? null : k.config.leadMs

// The lead a run refreshes at while it runs: its sending lead, with no stop standing. The refresh figure and the pie's counts are given exactly where this is not null.
const refreshLeadOf = (k: KeepaliveState, view: CacheView): number | null => (k.stop === null ? sendingLeadOf(k, view) : null)

// The figure keepalive's refreshes show while it runs: what each refresh costs, or the context it reads, and how often. Shown
// while it runs, a refresh in flight included; null when it is off, stopped, paused, or learned no refreshes for this pause, so
// over a warm cache the pie's hover names keepalive off or paused, not on.
export const costOf = (k: KeepaliveState, view: CacheView, money: Money, pair: Pair): Figure | null => {
  const lead = refreshLeadOf(k, view)
  return lead === null ? null : figureAt(view, lead, money, pair)
}

// What the pie counts of a run's refreshes: the lead it sends at, its count, and how many of them are still to come.
export type Planned = { leadMs: number; count: number; left: number }

// The run's planned refreshes, where the refresh figure is given: its count and the refreshes left of it. A run that used its count keeps them through its last TTL, with none left, while the
// cache it kept warm is still warm by the cache's one expiry owner. Every other state, stops included, gives none, and the pie counts the TTL alone.
export const plannedOf = (k: KeepaliveState, view: CacheView, liveMs: number | null, nowMs: number): Planned | null => {
  const running = refreshLeadOf(k, view)
  if (running !== null) return { leadMs: running, count: k.runCount, left: k.remaining }
  const sending = sendingLeadOf(k, view)
  return k.stop === COUNT_USED && sending !== null && !expiredAt(view, liveMs, nowMs) ? { leadMs: sending, count: k.runCount, left: 0 } : null
}

// The figure of a run at the lead and count it would use: what a resume sends, and what a press would start. The hover above the time
// shows its label, the Keepalive section its lines. Null where that run sends no refresh.
export const offerOf = (view: CacheView, money: Money, leadMs: number, runCount: number, pair: Pair): Figure | null =>
  runCount === 0 ? null : figureAt(view, leadMs, money, pair)

// The figure a press would show while keepalive is off: the resume's figure where the run sends refreshes. Where it sends none, at a lead
// at or above the TTL or a count of 0, a warm cache states the rebuild's price alone, with no section lines.
export const pressOfferOf = (view: CacheView, money: Money, leadMs: number, runCount: number, pair: Pair): Figure | null => {
  const sends = offerOf(view, money, leadMs, runCount, pair)
  if (sends !== null) return sends
  const bare = pairing(view, money, pair)?.bare ?? null
  return bare === null ? null : { label: bare, lines: [] }
}

// Stops that end keepalive by design. Any other stop, and a pause from a lead at or above the TTL, is a failure the status
// line names in one clause; the footer names neither.
const ENDED_BY_DESIGN: readonly string[] = [COUNT_USED, 'cache expired', OVERNIGHT_STOP]

// What the status line says keepalive has failed at, as one clause with no refresh figures; null when it has not failed.
export const failureOf = (k: KeepaliveState, view: CacheView): string | null => {
  if (k.config === null) return null
  if (k.stop !== null) return ENDED_BY_DESIGN.includes(k.stop) ? null : `keepalive stopped: ${k.stop}`
  return view.kind === 'known' && refreshIntervalMs(k.config.leadMs, view.ttlMs) === null ? `keepalive paused: ${notBelowTtl(k.config.leadMs, view.ttlMs)}` : null
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

// Why a fork's reply did not keep the cache alive, or null when it did. An answer, or an empty reply that reports its usage, is judged by
// the cache it read, since a refresh exists to read the cache. Any other reply gives its reason (reasonOf); a rate-limited refusal gives
// its reason too, and `refused` decides whether that reason stops keepalive.
export const stopFor = (r: ModelForkResult): string | null => {
  const usage = usageOf(r)
  if (!r.isAnswered && (r.reason !== 'empty-reply' || usage === null)) return reasonOf(r)
  if (usage !== null && usage.cache_read_input_tokens === 0) return 'reply not served from cache'
  return null
}

// The API error kinds a refused refresh is retried for: the rate limit alone, the kind the user named and the engine's doc says may clear on
// its own. The other kinds it names as may clear (`overloaded`, `server_error`) stop keepalive at once, as any failure does.
const RETRIED_KINDS: readonly ModelApiError[] = ['rate_limit']

// Whether a fork's reply is a refusal of a kind a refresh is retried for. The kind is Claude Code's own classification of the error, so the
// status is not asked: a rate limit with no response is retried as one with status 429.
export const retriedOf = (r: ModelForkResult): boolean => !r.isAnswered && r.reason === 'api-error' && RETRIED_KINDS.includes(r.error)

// Whether a rate-limited refusal's retry may go: `allowed` when the next tick sends it, `none` when the refusal ended the run.
export type Retry = 'allowed' | 'none'

// A rate-limited refusal, decided at its end. A retry goes at the next tick when the refusal's reply time plus one tick still leaves half
// the run's lead before the expiry; the run then stays due with its count given back, and the tick sends the attempt, so nothing is held
// between attempts. Otherwise the run ends with the refusal's reason and the window's close. Either way the count is given back, since no
// refresh reached the cache, and the lead and `last` are untouched, since a refusal measured nothing. A null expiry allows no retry.
export const refused = (
  k: KeepaliveState,
  leadMs: number,
  reason: string,
  repliedMs: number,
  expiryMs: number | null,
  tickMs: number,
): { state: KeepaliveState; retry: Retry } => {
  const given = { ...k, remaining: k.remaining + 1 }
  if (expiryMs !== null && expiryMs - (repliedMs + tickMs) >= leadMs / 2) return { state: given, retry: 'allowed' }
  return { state: { ...given, stop: `${reason}, no retry before expiry` }, retry: 'none' }
}

// A ping whose reply has not come by the TTL: the cache may have lapsed while it was in flight, so keepalive stops with it.
export const lapsedReason = (ttlMs: number): string => `round trip over ${secsTerse(ttlMs)} TTL, no reply yet`

// A raised lead past half the TTL stops keepalive: no lead above that keeps 2x headroom under the TTL. Exactly half still raises.
export const pastHalfTtl = (raisedMs: number, ttlMs: number): boolean => raisedMs > ttlMs / 2
// That stop's reason: the round trip measured, and the lead it would need.
export const pastHalfTtlStop = (rtMs: number, raisedMs: number, ttlMs: number): string =>
  `${secsUp(rtMs)} round trip needs ${secsTerse(raisedMs)} lead > ½ of ${secsTerse(ttlMs)} TTL`

// The lead after a ping whose round trip was `rtMs`: a round trip over half the lead raises it to twice the round trip, rounded up
// to whole seconds. A lead is never lowered, so without such a round trip the lead is `leadMs` unchanged.
export const raisedLeadOf = (leadMs: number, rtMs: number): number => (rtMs > leadMs / 2 ? Math.ceil((2 * rtMs) / 1000) * 1000 : leadMs)

// Why a lead is raised, as the details pane's raise row and the Settings lead's source both say it.
export const SLOW_REFRESH = 'slow refresh'

// The details pane's row for a raised lead.
export const raiseNote = (leadMs: number): string => `lead raised to ${secsTerse(leadMs)} (${SLOW_REFRESH})`

// The `/keepalive on` answer's lead-in to the rebuild figure.
const REBUILD_LEAD = 'if it goes cold, your next prompt rebuilds it: '

// A count of refreshes, singular for one.
const refreshesOf = (count: number): string => (count === 1 ? '1 refresh' : `${count} refreshes`)

// The cost `/keepalive on` answers with: the context each refresh reads, how often, while the cache is warm what its rebuild would cost,
// and that the first refresh after a turn can write.
export const costText = (view: KnownView, leadMs: number, intervalMs: number, count: number, money: Money, pair: Pair): string => {
  const stated = pairing(view, money, pair)
  const price = stated === null ? `Next refresh: ${nextPing(view, money)}` : `A refresh reads the warm cache: ${stated.figure}`
  const rebuild = stated === null || stated.rebuilt === null ? '' : `; ${REBUILD_LEAD}${stated.rebuilt}`
  return `${price}, every ${intervalOf(intervalMs)} (${view.ttlLabel} TTL less the ${secs(leadMs)} lead)${rebuild}. The first refresh after a turn can also write that turn's new tokens. ${refreshesOf(count)}, then it stops until a prompt.`
}

// What the toggle says when it turns keepalive on: the cost with its figures when the view allows it, else what it is waiting for, and
// any stop it has already reached. The pair's warm answer is the toggle's, from the expiry owner. At a lead at or above the TTL a warm
// cache states the rebuild price alone, before the stop tail.
export const enableText = (view: CacheView, leadMs: number, count: number, stop: string | null, money: Money, pair: Pair): string => {
  const head = `keepalive on: lead ${secs(leadMs)}, ${refreshesOf(count)}.`
  const armed = stop !== null && ENDED_BY_DESIGN.includes(stop)
  const tail = stop === null ? '' : armed ? ` Paused: ${byDesignSentence(stop)}.` : ` Stopped: ${failureSentence(stop)}.`
  if (view.kind !== 'known') return `${head} No live cache to count from yet, so nothing is scheduled until there is one.${tail}`
  const interval = refreshIntervalMs(leadMs, view.ttlMs)
  if (interval === null) {
    const rebuilt = pairing(view, money, pair)?.rebuilt
    const rebuild = rebuilt === undefined || rebuilt === null ? '' : ` ${capital(REBUILD_LEAD)}${rebuilt}.`
    return `${head} Paused: ${notBelowTtl(leadMs, view.ttlMs)}.${rebuild}${tail}`
  }
  return `${head} ${armed ? `${capital(rereadFigure(view, money) ?? '')}.` : costText(view, leadMs, interval, count, money, pair)}${tail}`
}

// The debug line of one ping, written once its outcome is known. `stale` marks a result from a generation the state has since
// left, or one that came after the TTL lapsed: it changed nothing. `retry` is what a rate-limited refusal decided, null on every other line.
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
  retry: Retry | null
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
  retry: Retry | null
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
  retry: p.retry,
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

// A tally as a line: the word it is named by and a colon as the dim label, then its refreshes and what they cost.
export const tallyOf = (word: string, t: Tally, unit: Money['unit']): Line => labelled(`${word}:`, ` ${refreshesOf(t.pings)} · ${figureOf(t.spend, unit)}`)

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

