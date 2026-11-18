// The Advice section's two blocks of label rows: the cheapest setup over the recorded pauses, of the four there are (TTL 5 m or 1 h,
// keepalive on or off), and the TTL block, which prices the other TTL against this one over every priced pause. Each opens with a `setup:`
// row naming the setup you are on (the TTL block leaves it out where the best-setup block, which has it, is shown), and their steps share
// the new-session clause. Pure: register.ts gathers the view, the prices, the lead, the cap, the pinned count and the pauses, and this
// words them from the pricing learn.ts does. A block is its list of rows, each one section line, so the answer wraps each at 48 columns
// and the pane draws each whole. A row's label is its line's first piece (countdown.ts labelled), which the pane draws dim; the rows that
// open with a setup, not a label, are plain text.
//
// Each setup of the best-setup block prices the same pauses, through the pricing the TTL block uses (learn.ts pausesCost). Every pause carries the growth writes its
// turn made, at the TTL's write rate, and then the pause itself: with keepalive off a rewrite once the TTL has passed; with it on, the
// pings its count sends and a rewrite if they could not hold the cache. An "on" count is the pinned one, else the count learned from the
// whole history (learn.ts), else break-even. An "on" setup at the current TTL runs at this session's lead and pin; one at the other TTL
// needs a new session, so it runs at the lead and pin a new session starts with (`fresh`). That new session starts keepalive on or off as
// `fresh.on` says, so a change of TTL names that start, and the default, the command and the click only where the setup it names differs from it.
import type { CacheView, TtlLabel, Unit } from '../types'
import { labelled } from './countdown'
import type { PauseRecord } from './history'
import { pausesCost, priceable, ttlAdviceOf, ttlSwitchOf, type TtlRates } from './learn'
import { dollars, DOLLARS_ONLY, pricedSpeed, ratesFor, TTL_MS, tierOf, type Money } from './prices'
import { printRequest } from './keepalive'
import { spanOf, type Line } from './sections'
import { refreshIntervalMs, setupToken, type Setup } from './setup'

// Whether the pauses priced are this session's, or the newest recent ones across sessions.
export type Source = 'session' | 'recent'
export type Inputs = {
  session: readonly PauseRecord[]
  history: readonly PauseRecord[]
  rates: TtlRates
  leadMs: number
  cap: number | null
  current: Setup
  pinned: number | null
  // The new session a switch of TTL starts: whether it starts keepalive on (keepalive_default), and the lead and pin its run, or its
  // first click on the pie, runs at: the options' defaults.
  fresh: { on: boolean; leadMs: number; pinned: number | null }
}
// A run's lead and the count it pins, or null for none.
export type Run = { leadMs: number; pinned: number | null }
// The cheapest setup that is not worth changing to, and its saving over the current setup: the one that came closest.
export type Near = { setup: Setup; savedUsd: number }
// `change`: the cheapest setup differs from the current one, by a saving worth recommending. `best`: no change is worth making, and the
// current setup's saving against its baseline is above zero. `even`: no change is worth making, and the baseline cost no more, so no figure
// is stated; `baselineSavedUsd` is what the baseline would have saved over the current setup, zero or more, which says whether it cost
// about the same or a little less. Every kind names the pauses it priced (`of`, `source`). `near` is the cheapest setup when it is cheaper
// than the current one but under the threshold, else null: a block that names it never calls the current setup optimal. A change's
// `startsOn` is whether keepalive is on where `to` would start: this session at the same TTL, the new session a switch starts (`fresh.on`)
// at the other.
export type Result =
  | { kind: 'change'; from: Setup; to: Setup; savedUsd: number; of: number; source: Source; startsOn: boolean; run: Run }
  | { kind: 'best'; setup: Setup; savedUsd: number; of: number; source: Source; near: Near | null }
  | { kind: 'even'; setup: Setup; near: Near | null; baselineSavedUsd: number; of: number; source: Source }

// The setups in the order a tie goes: keepalive off first, then the 5 m cache. The current setup is always tried first.
const SETUPS: readonly Setup[] = [
  { ttl: '5m', keepalive: false },
  { ttl: '1h', keepalive: false },
  { ttl: '5m', keepalive: true },
  { ttl: '1h', keepalive: true },
]
// A change is recommended only when it saves at least a cent and at least a twentieth of what the current setup cost.
const CHANGE_MIN_USD = 0.01
const CHANGE_MIN_SHARE = 0.05
// Pauses priced: this session's once this many can be priced, else the newest recent ones across sessions, which need this many too.
const PRICED_MIN = 5
const RECENT_MAX = 50
// Costs this close are equal: float sums of per-token prices never land exactly.
const EPSILON_USD = 1e-9
// A baseline cheaper by less than half a cent reads as about the same. The setups are compared in dollars in either unit, so the
// threshold is the same in both.
const HALF_CENT_USD = 0.005

// The pauses a comparison prices, and where they came from; null with fewer than PRICED_MIN priceable pauses anywhere.
export const pricedOf = (session: readonly PauseRecord[], history: readonly PauseRecord[]): { pauses: PauseRecord[]; source: Source } | null => {
  const own = session.filter(priceable)
  if (own.length >= PRICED_MIN) return { pauses: own, source: 'session' }
  const all = history.filter(priceable)
  if (all.length < PRICED_MIN) return null
  return { pauses: all.slice(-RECENT_MAX), source: 'recent' }
}

// Where a setup of this TTL starts: this session's keepalive state, lead and pin at the current TTL, the new session's at the other. One
// choice, so the run a setup is priced at, the start its change step words and the run that step names cannot drift.
const startOf = (ttl: TtlLabel, inputs: Inputs): { on: boolean } & Run =>
  ttl === inputs.current.ttl ? { on: inputs.current.keepalive, leadMs: inputs.leadMs, pinned: inputs.pinned } : inputs.fresh

// What the pauses cost under a setup, in dollars, as the TTL block prices them (pausesCost); null where that setup cannot be priced.
const costOf = (pauses: readonly PauseRecord[], setup: Setup, inputs: Inputs): number | null => {
  const run = startOf(setup.ttl, inputs)
  return pausesCost(pauses, inputs.history, setup.ttl, inputs.rates, run.leadMs, inputs.cap, { on: setup.keepalive, pinned: run.pinned })
}

const setupKey = (s: Setup): string => `${s.ttl}:${s.keepalive ? 'on' : 'off'}`

// The setup a setup's saving is stated against: keepalive off at the same TTL when keepalive is on, or the other TTL when it is off.
const baselineOf = (setup: Setup): Setup => ({ ttl: setup.keepalive ? setup.ttl : setup.ttl === '5m' ? '1h' : '5m', keepalive: false })

// The cheapest setup against the current one, over the pauses priced; null with nothing to price, or where the current setup or its
// baseline cannot be priced. A setup that cannot be priced (no write price above the read at its TTL) is not a candidate.
export const bestSetupOf = (inputs: Inputs): Result | null => {
  if (!(inputs.rates.read > 0)) return null
  const priced = pricedOf(inputs.session, inputs.history)
  if (priced === null) return null
  const usd = new Map<string, number>()
  for (const setup of SETUPS) {
    const cost = costOf(priced.pauses, setup, inputs)
    if (cost !== null) usd.set(setupKey(setup), cost)
  }
  const current = inputs.current
  if (!usd.has(setupKey(current)) || !usd.has(setupKey(baselineOf(current)))) return null
  const cost = (s: Setup): number => usd.get(setupKey(s))!
  const others = SETUPS.filter((s) => setupKey(s) !== setupKey(current) && usd.has(setupKey(s)))
  const best = [current, ...others].reduce((b, c) => (cost(c) < cost(b) - EPSILON_USD ? c : b))
  const now = cost(current)
  const of = priced.pauses.length
  const source = priced.source
  const saved = now - cost(best)
  if (setupKey(best) !== setupKey(current) && saved >= CHANGE_MIN_USD && saved >= CHANGE_MIN_SHARE * now) {
    const { on: startsOn, leadMs, pinned } = startOf(best.ttl, inputs)
    return { kind: 'change', from: current, to: best, savedUsd: saved, of, source, startsOn, run: { leadMs, pinned } }
  }
  const near = setupKey(best) === setupKey(current) ? null : { setup: best, savedUsd: saved }
  const against = cost(baselineOf(current)) - now
  if (against > EPSILON_USD) return { kind: 'best', setup: current, savedUsd: against, of, source, near }
  return { kind: 'even', setup: current, near, baselineSavedUsd: Math.max(0, -against), of, source }
}

// "1 pause this session", "10 recent pauses".
const pausesOf = (of: number, source: Source): string => {
  const noun = of === 1 ? 'pause' : 'pauses'
  return source === 'session' ? `${of} ${noun} this session` : `${of} recent ${noun}`
}

// A target, near or baseline setup is never an "on" that sends nothing: bestSetupOf prices such a setup as its "off" twin and a tie puts
// that first. So it is named at a lead no TTL reaches, and reads on or off as it is priced. A setup at the other TTL runs as a new session
// starts it, so this session's lead, which may be above its TTL, says nothing of it. Only the current setup is named at this session's lead,
// which can pause it.
const NO_PAUSE_LEAD_MS = 0
const otherSetup = (setup: Setup): string => spanOf(setupToken(setup, NO_PAUSE_LEAD_MS))

// The row that opens a block: the setup you are on, at this session's lead, and `(optimal)` where nothing would have cost less.
const setupRow = (current: Setup, leadMs: number, optimal = false): Line => labelled('setup:', ` ${spanOf(setupToken(current, leadMs))}${optimal ? ' (optimal)' : ''}`)

// The row that says how to make a change.
const doRow = (step: string): Line => labelled('do:', ` ${step}`)

// What a switch of TTL leaves new sessions on: the keepalive state they start with, and the option that decides it.
export const newSessionClause = (startsOn: boolean): string => `new sessions start ${startsOn ? 'on' : 'off'}: keepalive_default`

// A saving in the unit shown. In tokens a saving is a sum of prices, so it is named as money and the first row to say so points to the dollar unit.
const amountOf = (usd: number, unit: Unit): string => (unit === 'dollars' ? dollars(usd) : 'money')

// The parenthesis a row's figure ends in: the pauses it prices where it names them, and the pointer to the dollar unit where it is the first row
// to state money in tokens.
const parenOf = (scope: string | null, pointed: boolean): string => {
  const parts = [...(scope === null ? [] : [scope]), ...(pointed ? [DOLLARS_ONLY] : [])]
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`
}

// The row that names the cheapest setup that is not worth changing to, and its saving in the unit shown. `scope` names the pauses where no
// row after it does.
const nextBestRow = (near: Near, unit: Unit, scope: string | null, pointed: boolean): Line =>
  labelled('next best:', ` ${otherSetup(near.setup)} · would have saved ${amountOf(near.savedUsd, unit)}${parenOf(scope, pointed)}, too little to change`)

// How to make a change, the command first and the click after it. At the same TTL the click is made in this session, which a keepalive change
// always leaves other than the change wants. At the other TTL a new session starts, and its start does what the target wants when it starts
// keepalive as the target has it, or when the target has keepalive off and the new session's run sends nothing at the target TTL.
const stepOf = ({ from, to, startsOn, run }: Extract<Result, { kind: 'change' }>): string => {
  const onOrOff = to.keepalive ? 'on' : 'off'
  const click = `${spanOf(printRequest(to.keepalive ? { kind: 'on', leadMs: run.leadMs, count: run.pinned } : { kind: 'off' }))} or click pie ${onOrOff}`
  if (from.ttl === to.ttl) return click
  const set = ttlSwitchOf(to.ttl)
  const clause = newSessionClause(startsOn)
  if (startsOn === to.keepalive) return `${set} (${clause})`
  if (startsOn && refreshIntervalMs(run.leadMs, TTL_MS[to.ttl]) === null) return `${set} (${clause}, so run ${spanOf(setupToken({ ttl: to.ttl, keepalive: true }, run.leadMs))})`
  return `${set} (${clause}); then ${spanOf(printRequest({ kind: 'default', mode: onOrOff }))} before the new session, or in it ${click}`
}

// The best-setup block on a result: its rows, which open with the setup you are on, at this session's lead `leadMs`. In tokens a saving is
// named as money and the first row that states it points to the dollar unit, once.
export const adviceLine = (result: Result, unit: Unit, leadMs: number): Line[] => {
  const tokens = unit === 'tokens'
  if (result.kind === 'even') {
    const { setup, near, baselineSavedUsd, of, source } = result
    const baseline = baselineOf(setup)
    const span = pausesOf(of, source)
    // The next-best row already names the baseline and its saving: a tail would only repeat it.
    if (near !== null && setupKey(near.setup) === setupKey(baseline)) return [setupRow(setup, leadMs), nextBestRow(near, unit, span, tokens)]
    const tail =
      baselineSavedUsd < HALF_CENT_USD
        ? `${otherSetup(baseline)} ≈ same cost (${span})`
        : `${otherSetup(baseline)} a little cheaper (${span}), too little to change`
    // The next-best row, where there is one, states the only money: the tail states none.
    return near === null ? [setupRow(setup, leadMs, true), tail] : [setupRow(setup, leadMs), nextBestRow(near, unit, null, tokens), tail]
  }
  if (result.kind === 'best') {
    const { setup, savedUsd, of, source, near } = result
    const shown = dollars(savedUsd)
    // "<$0.001" already says the saving is small: "~" before it would blur the bound.
    const amount = tokens ? 'money' : shown.startsWith('<') ? shown : `~${shown}`
    const saves = labelled('saves', ` ${amount} vs ${otherSetup(baselineOf(setup))}${parenOf(pausesOf(of, source), tokens)}`)
    // The saves row states the money first, so the next-best row after it carries no pointer.
    return near === null ? [setupRow(setup, leadMs, true), saves] : [setupRow(setup, leadMs), saves, nextBestRow(near, unit, null, false)]
  }
  const { from, to, savedUsd, of, source } = result
  const best = labelled('best:', ` ${otherSetup(to)} · would have saved ${amountOf(savedUsd, unit)}${parenOf(pausesOf(of, source), tokens)}`)
  return [setupRow(from, leadMs), best, doRow(stepOf(result))]
}

// The rates a view's cached context pays: the model's, at the tier its prompt is priced at; null where its spends have no price
// (spendOf): a model the list lacks, or a speed other than standard.
export const ratesOfView = (view: Extract<CacheView, { kind: 'known' }>, money: Money): TtlRates | null => {
  const base = pricedSpeed(view.speed) ? ratesFor(money.list, view.model) : null
  return base === null ? null : tierOf(base, view.promptTokens)
}

// The best-setup block for these inputs, or no rows when there is no result to give.
export const adviceOf = (inputs: Inputs, unit: Unit): Line[] => {
  const result = bestSetupOf(inputs)
  return result === null ? [] : adviceLine(result, unit, inputs.leadMs)
}

// The TTL block on a TTL that would have cost less (ttlAdviceOf): the setup you are on, unless `bestShown` says the best-setup block has it, then the
// other TTL as a new session starts it, so at the new session's lead, where it can be paused. It names its scope, every priced pause across
// sessions, so it does not read as contradicting the best-setup block, which prices this session's pauses or the recent ones. The figure is in
// dollars in either unit.
export const ttlLine = (a: { better: TtlLabel; savedUsd: number; of: number }, inputs: Inputs, bestShown = false): Line[] => {
  const { fresh } = inputs
  const target = spanOf(setupToken({ ttl: a.better, keepalive: fresh.on }, fresh.leadMs))
  const pauses = `${a.of} priced ${a.of === 1 ? 'pause' : 'pauses'}, all sessions`
  return [
    ...(bestShown ? [] : [setupRow(inputs.current, inputs.leadMs)]),
    labelled('other TTL:', ` ${target} · would have saved ${dollars(a.savedUsd)} (${pauses})`),
    doRow(`${ttlSwitchOf(a.better)} (${newSessionClause(fresh.on)})`),
  ]
}

// The TTL block for these inputs, or no rows while the current TTL would not have cost more.
export const ttlLineOf = (inputs: Inputs, bestShown = false): Line[] => {
  const { history, rates, leadMs, cap, current, pinned, fresh } = inputs
  const a = ttlAdviceOf(history, rates, leadMs, cap, current.ttl, { on: current.keepalive, pinned }, fresh)
  return a === null ? [] : ttlLine(a, inputs, bestShown)
}
