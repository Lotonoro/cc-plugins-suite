// The cheapest setup over the recorded pauses, of the four there are: TTL 5 m or 1 h, keepalive on or off. Pure: register.ts gathers the
// view, the prices, the lead, the cap, the pinned count and the pauses, and this says the one sentence to show.
//
// Each setup prices the same pauses, through the pricing the TTL line uses (learn.ts pausesCost). Every pause carries the growth writes its
// turn made, at the TTL's write rate, and then the pause itself: with keepalive off a rewrite once the TTL has passed; with it on, the
// pings its count sends and a rewrite if they could not hold the cache. An "on" count is the pinned one, else the count learned from the
// whole history (learn.ts), else break-even. An "on" setup at the current TTL runs at this session's lead and pin; one at the other TTL
// needs a new session, so it runs at the lead and pin a new session starts with (`fresh`). That new session starts keepalive on or off as
// `fresh.on` says, so a change of TTL says to click the pie only where the setup it names differs from that start.
import type { CacheView, Unit } from '../types'
import type { PauseRecord } from './history'
import { pausesCost, priceable, ttlSwitchOf, type TtlRates } from './learn'
import { dollars, pricedSpeed, ratesFor, tierOf, TTL_WORDS, type Money } from './prices'
import type { Setup } from './setup'

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
// The cheapest setup that is not worth changing to, and its saving over the current setup: the one that came closest.
export type Near = { setup: Setup; savedUsd: number }
// `change`: the cheapest setup differs from the current one, by a saving worth recommending. `best`: no change is worth making, and the
// current setup's saving against its baseline is above zero. `even`: no change is worth making, and the baseline cost no more, so no figure
// is stated; `baselineSavedUsd` is what the baseline would have saved over the current setup, zero or more, which says whether it cost
// about the same or a little less. Every kind names the pauses it priced (`of`, `source`). `near` is the cheapest setup when it is cheaper
// than the current one but under the threshold, else null: a sentence that names it never calls the current setup the cheapest. A change's
// `startsOn` is whether keepalive is on where `to` would start: this session at the same TTL, the new session a switch starts (`fresh.on`)
// at the other.
export type Result =
  | { kind: 'change'; from: Setup; to: Setup; savedUsd: number; of: number; source: Source; startsOn: boolean }
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
const TOKENS_NOTE = ' (the saving is in dollars; see /keepalive unit dollars)'
// The same note inside a parenthesis already open, so two never stand back to back.
const TOKENS_NOTE_INSIDE = '; the saving is in dollars, see /keepalive unit dollars'

// The pauses a comparison prices, and where they came from; null with fewer than PRICED_MIN priceable pauses anywhere.
export const pricedOf = (session: readonly PauseRecord[], history: readonly PauseRecord[]): { pauses: PauseRecord[]; source: Source } | null => {
  const own = session.filter(priceable)
  if (own.length >= PRICED_MIN) return { pauses: own, source: 'session' }
  const all = history.filter(priceable)
  if (all.length < PRICED_MIN) return null
  return { pauses: all.slice(-RECENT_MAX), source: 'recent' }
}

// What the pauses cost under a setup, in dollars, as the TTL line prices them (pausesCost); null where that setup cannot be priced.
const costOf = (pauses: readonly PauseRecord[], setup: Setup, inputs: Inputs): number | null => {
  const run = setup.ttl === inputs.current.ttl ? { leadMs: inputs.leadMs, pinned: inputs.pinned } : inputs.fresh
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
    const startsOn = best.ttl === current.ttl ? current.keepalive : inputs.fresh.on
    return { kind: 'change', from: current, to: best, savedUsd: saved, of, source, startsOn }
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

// The opening that names the cheapest setup that is not worth changing to, and its saving in the unit shown: over `span` when no tail names
// the pauses. `noted` puts the tokens note inside its parenthesis, where no later clause carries one.
const nearOpening = (near: Near, unit: Unit, span?: string, noted = false): string => {
  const amount = unit === 'dollars' ? dollars(near.savedUsd) : 'money'
  const over = span === undefined ? '' : ` over ${span}`
  const note = noted && unit === 'tokens' ? TOKENS_NOTE_INSIDE : ''
  return `No other setup would have saved enough to change (a ${TTL_WORDS[near.setup.ttl]} cache with keepalive ${near.setup.keepalive ? 'on' : 'off'} would have saved ${amount}${over}${note})`
}

// The one sentence on a result. In tokens a saving is a sum of prices, so it is named as money and the sentence points to the dollar unit.
export const adviceLine = (result: Result, unit: Unit): string => {
  const note = unit === 'tokens' ? TOKENS_NOTE : ''
  if (result.kind === 'even') {
    const { setup, near, baselineSavedUsd, of, source } = result
    const baseline = baselineOf(setup)
    const span = pausesOf(of, source)
    // The opening already names the baseline and its saving: a tail would only repeat it.
    if (near !== null && setupKey(near.setup) === setupKey(baseline)) return `${nearOpening(near, unit, span, true)}.`
    const words = setup.keepalive ? 'keepalive off' : `the ${TTL_WORDS[baseline.ttl]} cache`
    const tail =
      baselineSavedUsd < HALF_CENT_USD
        ? `${words} would have cost about the same over ${span}`
        : `${words} would have cost a little less over ${span}, too little to change`
    // The opening's figure is the one the note is on: the tail states none.
    return near === null ? `You're on the cheapest setup; ${tail}.` : `${nearOpening(near, unit, undefined, true)}: ${tail}.`
  }
  if (result.kind === 'best') {
    const { setup, savedUsd, of, source, near } = result
    const shown = dollars(savedUsd)
    // "<$0.001" already says the saving is small: "about" before it would blur the bound.
    const amount = unit === 'dollars' ? (shown.startsWith('<') ? shown : `about ${shown}`) : 'money'
    const span = pausesOf(of, source)
    const tail = setup.keepalive
      ? `at your current setting, keepalive saves ${amount} over ${span} against having it off`
      : `with keepalive off, the ${TTL_WORDS[setup.ttl]} cache saves ${amount} over ${span} against the ${TTL_WORDS[baselineOf(setup).ttl]} one`
    return `${near === null ? "You're on the cheapest setup" : nearOpening(near, unit)}: ${tail}${note}.`
  }
  const { from, to, savedUsd, of, source, startsOn } = result
  const amount = unit === 'dollars' ? dollars(savedUsd) : 'money'
  // The click is in the new session when the TTL switch starts one: it is the session the click is made in.
  const click = startsOn === to.keepalive ? '' : `click the pie ${to.keepalive ? 'on' : 'off'}`
  const how = from.ttl === to.ttl ? click : click === '' ? `${ttlSwitchOf(to.ttl)} (new sessions)` : `${ttlSwitchOf(to.ttl)} and, in the new session, ${click}`
  return `A ${TTL_WORDS[to.ttl]} cache with keepalive ${to.keepalive ? 'on' : 'off'} would have saved ${amount} over ${pausesOf(of, source)}${note}: ${how}.`
}

// The rates a view's cached context pays: the model's, at the tier its prompt is priced at; null where its spends have no price
// (spendOf): a model the list lacks, or a speed other than standard.
export const ratesOfView = (view: Extract<CacheView, { kind: 'known' }>, money: Money): TtlRates | null => {
  const base = pricedSpeed(view.speed) ? ratesFor(money.list, view.model) : null
  return base === null ? null : tierOf(base, view.promptTokens)
}

// The sentence for these inputs, or '' when there is no result to give.
export const adviceOf = (inputs: Inputs, unit: Unit): string => {
  const result = bestSetupOf(inputs)
  return result === null ? '' : adviceLine(result, unit)
}
