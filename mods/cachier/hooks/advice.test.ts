import { describe, expect, test } from 'claude-code/testing'
import type { PauseRecord } from './history'
import { adviceLine, adviceOf, bestSetupOf, newSessionClause, pricedOf, ratesOfView, ttlLine, ttlLineOf, type Inputs } from './advice'
import { PRICES } from './prices'

const S = 1000
const MIN = 60 * S
// Opus 5.5 rates per token, as learn.test.ts prices them: a 100k context reads at $0.02, and a 5 m rewrite costs 24 reads.
const OPUS = { read: 2e-7, write5m: 5e-6, write1h: 8e-6 }
const CONTEXT = 100000
const pause = (i: number, pausedMs: number, grownTokens = 0): PauseRecord => ({
  startMs: i,
  pausedMs,
  hour: 10,
  weekday: 2,
  ratio: 24,
  ttlMs: 300 * S,
  contextTokens: CONTEXT,
  grownTokens,
})
const pauses = (n: number, pausedMs: number, grownTokens = 0): PauseRecord[] => Array.from({ length: n }, (_, i) => pause(i, pausedMs, grownTokens))
const inputs = (over: Partial<Inputs>): Inputs => ({
  session: [],
  history: [],
  rates: OPUS,
  leadMs: 15 * S,
  cap: null,
  current: { ttl: '5m', keepalive: true },
  pinned: null,
  fresh: { on: false, leadMs: 15 * S, pinned: null },
  ...over,
})
// Rates at which a 5 m rewrite costs a quarter of a read-priced ping's context, and a 1 h write is twice a read: one unit is a dollar.
const UNIT = { read: 1e-5, write5m: 1.25e-5, write1h: 2e-5 }

describe('pricedOf: this session\'s pauses once five can be priced, else the 50 newest recent ones', () => {
  test('five priceable session pauses are priced alone', () => {
    const session = pauses(5, 30 * MIN)
    expect(pricedOf(session, pauses(10, 30 * MIN))).toEqual({ pauses: session, source: 'session' })
  })

  test('fewer than five session pauses fall back to the 50 newest history pauses, and say so', () => {
    const history = pauses(60, 30 * MIN)
    const priced = pricedOf(pauses(4, 30 * MIN), history)
    expect(priced).toEqual({ pauses: history.slice(-50), source: 'recent' })
  })

  test('fewer than five priceable pauses anywhere give no result, and unpriced pauses do not count', () => {
    const unpriced = { startMs: 9, pausedMs: MIN, hour: 10, weekday: 2, ratio: 24, ttlMs: 300 * S }
    expect(pricedOf(pauses(4, 30 * MIN), [...pauses(4, 30 * MIN), unpriced])).toBeNull()
    expect(pricedOf([], [])).toBeNull()
  })
})

describe('bestSetupOf: the cheapest of the four setups, against the current one', () => {
  test('a lead at or above the 5-minute TTL prices keepalive on at 5 m as off: such a run sends no refresh, and the setups with keepalive off do not ping', () => {
    // A 400 s lead on 1 h with keepalive off: 30-minute pauses cost nothing on 1 h, and a $0.48 rewrite each on 5 m.
    const result = bestSetupOf(inputs({ leadMs: 400 * S, current: { ttl: '1h', keepalive: false }, history: pauses(10, 30 * MIN) }))
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '1h', keepalive: false }, near: null })
    expect(result?.kind === 'best' && Math.abs(result.savedUsd - 4.8)).toBeLessThan(1e-9)
    // On 5 m with keepalive on at that lead, the run pauses and every pause rewrites: the 1 h cache with keepalive off saves the $4.80.
    const paused = bestSetupOf(inputs({ leadMs: 400 * S, current: { ttl: '5m', keepalive: true }, history: pauses(10, 30 * MIN) }))
    expect(paused).toMatchObject({ kind: 'change', from: { ttl: '5m', keepalive: true }, to: { ttl: '1h', keepalive: false } })
    expect(paused?.kind === 'change' && Math.abs(paused.savedUsd - 4.8)).toBeLessThan(1e-9)
  })

  test('on even, the baseline\'s own saving over the current setup is carried, so the sentence can state it', () => {
    // 6-minute pauses on 1 h off: the 5 m baseline costs $0.70 a pause against $0.72, $0.20 over ten.
    const result = bestSetupOf(inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 36000) }))
    expect(result?.kind === 'even' && Math.abs(result.baselineSavedUsd - 0.2)).toBeLessThan(1e-9)
    expect(bestSetupOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 2 * MIN) }))).toMatchObject({ kind: 'even', baselineSavedUsd: 0 })
  })

  test('on 5 min with keepalive on, 1 h with keepalive off costs least by more than the threshold: both settings change, and the saving is given', () => {
    // Each 30-minute pause: keepalive on at 5 m fires six pings ($0.12); off at 5 m is a rewrite ($0.48); 1 h off costs nothing.
    expect(bestSetupOf(inputs({ history: pauses(10, 30 * MIN) }))).toEqual({
      kind: 'change',
      from: { ttl: '5m', keepalive: true },
      to: { ttl: '1h', keepalive: false },
      savedUsd: expect.any(Number),
      of: 10,
      source: 'recent',
      startsOn: false,
    })
    const change = bestSetupOf(inputs({ history: pauses(10, 30 * MIN) }))
    expect(change?.kind === 'change' && Math.abs(change.savedUsd - 1.2)).toBeLessThan(1e-9)
  })

  test('the priced pauses are this session\'s when five of them are priceable, and say so', () => {
    const result = bestSetupOf(inputs({ session: pauses(5, 30 * MIN), history: pauses(10, 30 * MIN) }))
    expect(result).toMatchObject({ kind: 'change', of: 5, source: 'session' })
  })

  test('the saving is priced over the 50 newest recent pauses, not all of them', () => {
    const result = bestSetupOf(inputs({ history: pauses(60, 30 * MIN) }))
    expect(result).toMatchObject({ kind: 'change', of: 50, source: 'recent' })
    expect(result?.kind === 'change' && Math.abs(result.savedUsd - 6)).toBeLessThan(1e-9)
  })

  test('the "on" counts come from the whole history, so pricing this session or the same history gives the same result', () => {
    const history = pauses(10, 30 * MIN)
    const own = bestSetupOf(inputs({ session: history, history }))
    const recent = bestSetupOf(inputs({ session: [], history }))
    expect(own).toEqual({ ...recent, source: 'session' })
  })

  test('a change under a cent is not recommended: the current setup is best, and its saving against the baseline is above zero', () => {
    // The same pauses priced at a thousandth of the rates: the change saves less than $0.01.
    const scaled = { read: OPUS.read / 1000, write5m: OPUS.write5m / 1000, write1h: OPUS.write1h / 1000 }
    const result = bestSetupOf(inputs({ rates: scaled, history: pauses(10, 30 * MIN) }))
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '5m', keepalive: true }, of: 10 })
    expect(result?.kind === 'best' && Math.abs(result.savedUsd - 0.0036)).toBeLessThan(1e-9)
  })

  test('a change under a twentieth of what the current setup cost is not recommended: the baseline costs no more, so the result is even', () => {
    // 6-minute pauses with 36k tokens written each: 1 h off costs $0.72 a pause, 5 m off $0.70, a $0.02 difference under 5 %.
    expect(bestSetupOf(inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 36000) }))).toMatchObject({ kind: 'even', near: { setup: { ttl: '5m', keepalive: false } } })
  })

  test('the same pauses at a saving above a twentieth and above a cent are a change', () => {
    // 50k tokens written each: 1 h off costs $1.00 a pause, 5 m off $0.875, a 12.5 % saving.
    const result = bestSetupOf(inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 50000) }))
    expect(result).toMatchObject({ kind: 'change', from: { ttl: '1h', keepalive: false }, to: { ttl: '5m', keepalive: false }, of: 10 })
    expect(result?.kind === 'change' && Math.abs(result.savedUsd - 1.25)).toBeLessThan(1e-9)
  })

  test('on 1 h with keepalive off and 20-minute pauses, the saving is against the 5-minute cache, and the current setup is best', () => {
    const result = bestSetupOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 20 * MIN, 2000) }))
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '1h', keepalive: false }, of: 10, source: 'recent' })
    expect(result?.kind === 'best' && Math.abs(result.savedUsd - 4.74)).toBeLessThan(0.005)
  })

  test('on 5 min with keepalive on, and ten-minute pauses with a large context growth, keepalive on is cheapest and saves against keepalive off', () => {
    // Keepalive on at 5 m fires two pings a pause ($0.04) on $5.00 of growth; off at 5 m is a rewrite ($0.48); 1 h costs $8.00 of growth.
    const result = bestSetupOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }))
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '5m', keepalive: true }, of: 10 })
    expect(result?.kind === 'best' && Math.abs(result.savedUsd - 4.4)).toBeLessThan(1e-9)
  })

  test('two-minute pauses with no growth cost the same at every setup: about even', () => {
    expect(bestSetupOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 2 * MIN) }))).toEqual({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near: null, baselineSavedUsd: 0, of: 10, source: 'recent' })
  })

  test('an "on" setup at the other TTL is priced at a new session\'s lead and pin, since switching TTL starts one; at the current TTL, at this session\'s', () => {
    // 150-minute pauses, the count capped at 1. At 1 h a 60 s lead pinned at two refreshes holds each pause for two reads ($0.04), but a new
    // session runs the 15 s lead unpinned: one refresh cannot hold it, so it learns none and costs the 1 h rewrite ($0.78), as off does.
    const run = { cap: 1, leadMs: 60 * S, pinned: 2, history: pauses(10, 150 * MIN) }
    const result = bestSetupOf(inputs({ ...run, current: { ttl: '5m', keepalive: false } }))
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '5m', keepalive: false }, near: null })
    expect(result?.kind === 'best' && Math.abs(result.savedUsd - 3)).toBeLessThan(1e-9)
    // On 1 h itself the session's own run is the one priced, and it beats the 5 m cache.
    expect(bestSetupOf(inputs({ ...run, current: { ttl: '1h', keepalive: true } }))).toMatchObject({ kind: 'best', setup: { ttl: '1h', keepalive: true }, near: null })
  })

  test('no price for the model gives no result', () => {
    expect(bestSetupOf(inputs({ rates: { read: 0, write5m: 0, write1h: 0 }, history: pauses(10, 30 * MIN) }))).toBeNull()
  })
})

describe('adviceLine and adviceOf: the one sentence, in the unit shown', () => {
  test('a change names the setting that changes, the saving, the pauses, and how to make it', () => {
    expect(adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'dollars')).toBe(
      'You\'re on a 5-minute cache with keepalive on. A 1-hour cache with keepalive off would have saved $1.20 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json (new sessions).',
    )
  })

  test('a change of TTL says to click the pie only where the new session starts keepalive other than the change wants', () => {
    // The new session a TTL switch needs starts keepalive as keepalive_default says, not as this session runs it.
    const history = pauses(10, 30 * MIN)
    expect(bestSetupOf(inputs({ history, fresh: { on: true, leadMs: 15 * S, pinned: null } }))).toMatchObject({ kind: 'change', to: { ttl: '1h', keepalive: false }, startsOn: true })
    expect(adviceOf(inputs({ history, fresh: { on: true, leadMs: 15 * S, pinned: null } }), 'dollars')).toBe(
      'You\'re on a 5-minute cache with keepalive on. A 1-hour cache with keepalive off would have saved $1.20 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json and, in the new session, click the pie off.',
    )
    // On 5 m with keepalive on and new sessions starting off, a change to 1 h with keepalive on needs the click though keepalive is on now.
    const to1hOn = { kind: 'change' as const, from: { ttl: '5m' as const, keepalive: true }, to: { ttl: '1h' as const, keepalive: true }, savedUsd: 0.5, of: 10, source: 'recent' as const }
    expect(adviceLine({ ...to1hOn, startsOn: false }, 'dollars', 15 * S)).toBe(
      'You\'re on a 5-minute cache with keepalive on. A 1-hour cache with keepalive on would have saved $0.50 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json and, in the new session, click the pie on.',
    )
    expect(adviceLine({ ...to1hOn, startsOn: true }, 'dollars', 15 * S)).toBe('You\'re on a 5-minute cache with keepalive on. A 1-hour cache with keepalive on would have saved $0.50 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json (new sessions).')
  })

  test('a change over this session\'s pauses says so', () => {
    expect(adviceOf(inputs({ session: pauses(5, 30 * MIN), history: pauses(10, 30 * MIN) }), 'dollars')).toContain('over 5 pauses this session:')
  })

  test('a change of the TTL alone names only the promptCacheTtl setting, and going back to 5 m sets it to "5m"', () => {
    expect(adviceOf(inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 50000) }), 'dollars')).toBe(
      'You\'re on a 1-hour cache with keepalive off. A 5-minute cache with keepalive off would have saved $1.25 over 10 recent pauses: set "promptCacheTtl": "5m" in settings.json (new sessions).',
    )
  })

  test('a change of keepalive alone names the pie', () => {
    const result = adviceLine({ kind: 'change', from: { ttl: '5m', keepalive: false }, to: { ttl: '5m', keepalive: true }, savedUsd: 0.5, of: 3, source: 'recent', startsOn: false }, 'dollars', 15 * S)
    expect(result).toBe('You\'re on a 5-minute cache with keepalive off. A 5-minute cache with keepalive on would have saved $0.50 over 3 recent pauses: click the pie on.')
  })

  test('the on-best sentence with keepalive on says what keepalive saves against having it off', () => {
    expect(adviceOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }), 'dollars')).toBe(
      "You're on a 5-minute cache with keepalive on, the cheapest setup: it saves about $4.40 over 10 recent pauses against a 5-minute cache with keepalive off.",
    )
  })

  test('the on-best sentence with keepalive off says what the current TTL saves against the other', () => {
    expect(adviceOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 20 * MIN, 2000) }), 'dollars')).toBe(
      "You're on a 1-hour cache with keepalive off, the cheapest setup: it saves about $4.74 over 10 recent pauses against a 5-minute cache with keepalive off.",
    )
  })

  test('a saving under a tenth of a cent is shown as "<$0.001", with no "about" before it', () => {
    expect(adviceLine({ kind: 'best', setup: { ttl: '5m', keepalive: true }, savedUsd: 0.0001, of: 10, source: 'recent', near: null }, 'dollars', 15 * S)).toBe(
      "You're on a 5-minute cache with keepalive on, the cheapest setup: it saves <$0.001 over 10 recent pauses against a 5-minute cache with keepalive off.",
    )
  })

  test('about even, with no cheaper setup, says the cheapest and the other TTL or keepalive off cost about the same, with no figure', () => {
    expect(adviceOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 2 * MIN) }), 'dollars')).toBe(
      "You're on a 1-hour cache with keepalive off, the cheapest setup; a 5-minute cache with keepalive off would have cost about the same over 10 recent pauses.",
    )
    expect(adviceOf(inputs({ history: pauses(10, 2 * MIN) }), 'dollars')).toBe(
      "You're on a 5-minute cache with keepalive on, the cheapest setup; a 5-minute cache with keepalive off would have cost about the same over 10 recent pauses.",
    )
  })

  test('a cheaper setup under the change threshold, with a saving over the current one: the opening names it and its saving, and never says cheapest', () => {
    // 6-minute pauses at 5 m on with one ping pinned: 1 h off costs $0.048 a pause and 5 m on $0.050, a 4 % saving, so no change.
    const near = inputs({ rates: OPUS, pinned: 1, history: pauses(10, 6 * MIN, 6000) })
    const result = bestSetupOf(near)
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '5m', keepalive: true }, near: { setup: { ttl: '1h', keepalive: false } } })
    expect(result?.kind === 'best' && Math.abs(result.near!.savedUsd - 0.02)).toBeLessThan(1e-9)
    expect(adviceOf(near, 'dollars')).toBe(
      'You\'re on a 5-minute cache with keepalive on. No other setup would have saved enough to change (a 1-hour cache with keepalive off would have saved $0.02): your setup saves about $4.60 over 10 recent pauses against a 5-minute cache with keepalive off.',
    )
  })

  test('a cheaper setup under the change threshold that is the baseline: the opening names it and its saving, and no tail repeats or contradicts it', () => {
    // 6-minute pauses on 1 h off: 5 m off costs $0.70 a pause against $0.72, a 2.8 % saving, so no change; the baseline is that setup.
    const cheaper = inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 36000) })
    expect(bestSetupOf(cheaper)).toMatchObject({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near: { setup: { ttl: '5m', keepalive: false } } })
    expect(adviceOf(cheaper, 'dollars')).toBe('You\'re on a 1-hour cache with keepalive off. No other setup would have saved enough to change (a 5-minute cache with keepalive off would have saved $0.20 over 10 recent pauses).')
  })

  test('a baseline cheaper by a cent or more, under the threshold, says it cost a little less, with no figure, never "about the same"', () => {
    const near = { setup: { ttl: '1h' as const, keepalive: false }, savedUsd: 5 }
    const on = adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 4, of: 10, source: 'recent' }, 'dollars', 15 * S)
    expect(on).toBe(
      'You\'re on a 5-minute cache with keepalive on. No other setup would have saved enough to change (a 1-hour cache with keepalive off would have saved $5.00): a 5-minute cache with keepalive off would have cost a little less over 10 recent pauses, too little to change.',
    )
    const off = adviceLine({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near: { setup: { ttl: '5m', keepalive: true }, savedUsd: 5 }, baselineSavedUsd: 4, of: 5, source: 'session' }, 'dollars', 15 * S)
    expect(off).toBe(
      'You\'re on a 1-hour cache with keepalive off. No other setup would have saved enough to change (a 5-minute cache with keepalive on would have saved $5.00): a 5-minute cache with keepalive off would have cost a little less over 5 pauses this session, too little to change.',
    )
    expect(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 4, of: 10, source: 'recent' }, 'tokens', 15 * S)).toBe(
      'You\'re on a 5-minute cache with keepalive on. No other setup would have saved enough to change (a 1-hour cache with keepalive off would have saved money; the saving is in dollars, see /keepalive unit dollars): a 5-minute cache with keepalive off would have cost a little less over 10 recent pauses, too little to change.',
    )
  })

  test('in tokens a cheaper setup under the threshold that is the baseline holds the dollar note in its one parenthesis', () => {
    const near = { setup: { ttl: '5m' as const, keepalive: false }, savedUsd: 0.2 }
    expect(adviceLine({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near, baselineSavedUsd: 0.2, of: 10, source: 'recent' }, 'tokens', 15 * S)).toBe(
      'You\'re on a 1-hour cache with keepalive off. No other setup would have saved enough to change (a 5-minute cache with keepalive off would have saved money over 10 recent pauses; the saving is in dollars, see /keepalive unit dollars).',
    )
  })

  test('a baseline cheaper by less than half a cent reads as about the same, in either unit, since both compare dollars', () => {
    const near = { setup: { ttl: '1h' as const, keepalive: false }, savedUsd: 0.5 }
    expect(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 0.004, of: 10, source: 'recent' }, 'dollars', 15 * S)).toBe(
      'You\'re on a 5-minute cache with keepalive on. No other setup would have saved enough to change (a 1-hour cache with keepalive off would have saved $0.50): a 5-minute cache with keepalive off would have cost about the same over 10 recent pauses.',
    )
    expect(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 0.004, of: 10, source: 'recent' }, 'tokens', 15 * S)).toContain('a 5-minute cache with keepalive off would have cost about the same')
    expect(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 0.005, of: 10, source: 'recent' }, 'tokens', 15 * S)).toContain('a 5-minute cache with keepalive off would have cost a little less over 10 recent pauses, too little to change')
  })

  test('in tokens a sentence with a saving names the setup and points to the dollar unit, and states no dollars', () => {
    const change = adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'tokens')
    expect(change).toContain('A 1-hour cache with keepalive off would have saved money over 10 recent pauses')
    expect(change).toBe(
      'You\'re on a 5-minute cache with keepalive on. A 1-hour cache with keepalive off would have saved money over 10 recent pauses (the saving is in dollars; see /keepalive unit dollars): set "promptCacheTtl": "1h" in settings.json (new sessions).',
    )
    expect(adviceOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }), 'tokens')).not.toContain('$')
  })

  test('with no result the sentence is empty', () => {
    expect(adviceOf(inputs({ rates: { read: 0, write5m: 0, write1h: 0 }, history: pauses(10, 30 * MIN) }), 'dollars')).toBe('')
  })
})

describe('adviceOf: the sentence names the setup you are on, paused where keepalive sends nothing, over every point of the grid', () => {
  const WORD = { '5m': '5-minute', '1h': '1-hour' }
  const TTL_MS = { '5m': 300 * S, '1h': 3600 * S }
  // The setup as the sentence names it: keepalive on at a lead not below its TTL is paused, with the reason the Keepalive section gives.
  const phraseOf = (setup: { ttl: '5m' | '1h'; keepalive: boolean }, leadMs: number): string => {
    const ttl = TTL_MS[setup.ttl]
    const state = setup.keepalive ? (leadMs < ttl ? 'on' : `paused, sending nothing (lead ${leadMs / S} s is not below the ${ttl / S} s TTL)`) : 'off'
    return `a ${WORD[setup.ttl]} cache with keepalive ${state}`
  }
  const SPANS = [2, 6, 30, 150].map((minutes) => pauses(10, minutes * MIN))
  const currents = [
    { ttl: '5m' as const, keepalive: false },
    { ttl: '5m' as const, keepalive: true },
    { ttl: '1h' as const, keepalive: false },
    { ttl: '1h' as const, keepalive: true },
  ]

  test('the current setup is named first, paused exactly when keepalive is on at a lead not below its TTL; no other setup is named paused, and no change or near setup is an "on" that sends nothing', () => {
    let points = 0
    for (const current of currents)
      for (const leadMs of [15 * S, TTL_MS[current.ttl], TTL_MS[current.ttl] + 100 * S])
        for (const freshLead of [15 * S, 300 * S])
          for (const history of SPANS) {
            const run = { current, leadMs, history, fresh: { on: false, leadMs: freshLead, pinned: null } }
            const sentence = adviceOf(inputs(run), 'dollars')
            const result = bestSetupOf(inputs(run))
            if (result === null) {
              expect(sentence).toBe('')
              continue
            }
            points++
            const naming = `You're on ${phraseOf(current, leadMs)}`
            expect(sentence.startsWith(naming)).toBe(true)
            expect(sentence.replace(naming, '')).not.toContain('keepalive paused')
            const runLeadOf = (setup: { ttl: '5m' | '1h' }) => (setup.ttl === current.ttl ? leadMs : freshLead)
            const others = result.kind === 'change' ? [result.to] : result.kind === 'best' || result.kind === 'even' ? (result.near ? [result.near.setup] : []) : []
            for (const setup of others) expect(setup.keepalive && runLeadOf(setup) >= TTL_MS[setup.ttl]).toBe(false)
          }
    // Every point of the grid gives a sentence, so none is skipped by the null guard.
    expect(points).toBe(currents.length * 3 * 2 * SPANS.length)
  })
})

describe('adviceOf: a current setup paused at a lead not below its TTL', () => {
  test('a change names the paused setup it leaves, with the Keepalive section\'s reason', () => {
    expect(adviceOf(inputs({ leadMs: 300 * S, current: { ttl: '5m', keepalive: true }, history: pauses(10, 30 * MIN) }), 'dollars')).toBe(
      'You\'re on a 5-minute cache with keepalive paused, sending nothing (lead 300 s is not below the 300 s TTL). A 1-hour cache with keepalive off would have saved $4.80 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json (new sessions).',
    )
  })

  test('the cheapest-setup sentence names it paused, and states the baseline in full', () => {
    expect(adviceOf(inputs({ leadMs: 300 * S, current: { ttl: '5m', keepalive: true }, history: pauses(10, 2 * MIN) }), 'dollars')).toBe(
      'You\'re on a 5-minute cache with keepalive paused, sending nothing (lead 300 s is not below the 300 s TTL), the cheapest setup; a 5-minute cache with keepalive off would have cost about the same over 10 recent pauses.',
    )
  })
})

describe('ratesOfView: the rates a known cache pays, and none for a model with no price', () => {
  const view = { kind: 'known' as const, touchMs: 0, ttlMs: 300 * S, ttlLabel: '5m' as const, promptTokens: 1000, outputTokens: 0, model: 'claude-opus-5-5', speed: 'standard' }

  test('a priced model gives its read and write rates', () => {
    const money = { unit: 'dollars' as const, list: PRICES, model: 'claude-opus-5-5', speed: 'standard', ttl: '5m' as const }
    const rates = ratesOfView(view, money)!
    expect(Math.abs(rates.read - OPUS.read)).toBeLessThan(1e-15)
    expect(Math.abs(rates.write5m - OPUS.write5m)).toBeLessThan(1e-15)
    expect(Math.abs(rates.write1h - OPUS.write1h)).toBeLessThan(1e-15)
  })

  test('a model the price list lacks gives no rates', () => {
    const money = { unit: 'dollars' as const, list: {}, model: 'claude-opus-5-5', speed: 'standard', ttl: '5m' as const }
    expect(ratesOfView(view, money)).toBeNull()
  })

  test('a cache written in fast mode gives no rates, as its spends have no price', () => {
    const money = { unit: 'dollars' as const, list: PRICES, model: 'claude-opus-5-5', speed: 'fast', ttl: '5m' as const }
    expect(ratesOfView({ ...view, speed: 'fast' }, money)).toBeNull()
  })
})

describe('newSessionClause: the words 41 reuses for what a switch of TTL leaves new sessions on', () => {
  test('it says the start mode and the option that decides it', () => {
    expect(newSessionClause(true)).toBe('for new sessions, which start with keepalive on (keepalive_default)')
    expect(newSessionClause(false)).toBe('for new sessions, which start with keepalive off (keepalive_default)')
  })
})

describe('ttlLineOf: the TTL line names the setup you are on, the setup it is priced against, and the keepalive state new sessions start with', () => {
  const back = inputs({ history: pauses(10, 2 * MIN, 50000), current: { ttl: '1h', keepalive: false }, fresh: { on: true, leadMs: 300 * S, pinned: null } })

  test('the target is a setup that sends nothing, named paused at the new session\'s lead, and the clause still says on', () => {
    expect(ttlLineOf(back)).toBe(
      'You\'re on a 1-hour cache with keepalive off. A 5-minute cache with keepalive paused, sending nothing (lead 300 s is not below the 300 s TTL) would have saved $1.50 over 10 priced pauses across sessions: set "promptCacheTtl": "5m" in settings.json for new sessions, which start with keepalive on (keepalive_default).',
    )
  })

  test('over one priced pause it says pause', () => {
    expect(ttlLineOf({ ...back, history: back.history.slice(0, 1) })).toContain('over 1 priced pause across sessions')
  })

  test('it names the target at the new session\'s lead, not this session\'s', () => {
    const slow = inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: false } })
    // This session at a 15 s lead, new sessions on at 300 s, switching back from 1 h: the 5-minute target reads paused.
    const line = ttlLineOf({ ...back, leadMs: 15 * S, current: { ttl: '1h', keepalive: true } })
    expect(line).toContain('You\'re on a 1-hour cache with keepalive on. A 5-minute cache with keepalive paused, sending nothing (lead 300 s is not below the 300 s TTL) would have saved')
    // And at a 15 s new-session lead the same target reads on.
    expect(ttlLineOf({ ...back, fresh: { ...back.fresh, leadMs: 15 * S } })).toContain('A 5-minute cache with keepalive on would have saved')
    expect(ttlLineOf(slow)).toContain('A 1-hour cache with keepalive off would have saved $4.74')
  })

  test('it names a paused current setup with the reason, and the figure is dollars in either unit', () => {
    const line = ttlLineOf({ ...inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: true } }), leadMs: 300 * S })
    expect(line).toBe(
      'You\'re on a 5-minute cache with keepalive paused, sending nothing (lead 300 s is not below the 300 s TTL). A 1-hour cache with keepalive off would have saved $4.74 over 10 priced pauses across sessions: set "promptCacheTtl": "1h" in settings.json for new sessions, which start with keepalive off (keepalive_default).',
    )
  })

  test('the target names the keepalive state new sessions start with', () => {
    expect(ttlLineOf(inputs({ history: pauses(10, 150 * MIN), current: { ttl: '5m', keepalive: false }, fresh: { on: true, leadMs: 15 * S, pinned: null } }))).toBe(
      'You\'re on a 5-minute cache with keepalive off. A 1-hour cache with keepalive on would have saved $4.40 over 10 priced pauses across sessions: set "promptCacheTtl": "1h" in settings.json for new sessions, which start with keepalive on (keepalive_default).',
    )
  })

  test('with nothing to price the line is empty', () => {
    expect(ttlLineOf(inputs({ history: pauses(10, 2 * MIN, 50000), current: { ttl: '5m', keepalive: false } }))).toBe('')
    expect(ttlLineOf(inputs({ current: { ttl: '5m', keepalive: false } }))).toBe('')
  })

  test('the best-setup sentence and the TTL line open with the same words for the same setup and lead', () => {
    for (const current of [{ ttl: '5m' as const, keepalive: true }, { ttl: '5m' as const, keepalive: false }]) {
      for (const leadMs of [15 * S, 300 * S]) {
        const run = { current, leadMs, history: pauses(10, 30 * MIN, 2000) }
        const opening = (text: string): string => text.slice(0, text.indexOf('. '))
        const sentence = adviceOf(inputs(run), 'dollars')
        const line = ttlLineOf(inputs(run))
        expect(sentence).not.toBe('')
        expect(line).not.toBe('')
        expect(opening(line)).toBe(opening(sentence))
        expect(opening(line).startsWith('You\'re on a ')).toBe(true)
      }
    }
  })

  test('across current TTL, keepalive, new-session start and new-session lead, the line names the current setup first and the target second, and the clause says the start mode', () => {
    const NAMED = /a (5|1)-(minute|hour) cache with keepalive (on|off|paused, sending nothing \([^)]*\))/gi
    let lines = 0
    let paused = 0
    for (const ttl of ['5m', '1h'] as const) {
      for (const keepalive of [true, false]) {
        for (const startOn of [true, false]) {
          for (const freshLead of [15 * S, 300 * S]) {
            // Pauses on which the other TTL wins: long and slowly growing from 5m, short and fast growing from 1h.
            const history = ttl === '5m' ? pauses(10, 20 * MIN, 2000) : pauses(10, 2 * MIN, 50000)
            const i = inputs({ history, current: { ttl, keepalive }, fresh: { on: startOn, leadMs: freshLead, pinned: null } })
            const line = ttlLineOf(i)
            if (line === '') continue
            lines++
            const [current, target] = line.match(NAMED)!
            expect(line.startsWith(`You're on ${current}. ${target} would have saved`)).toBe(true)
            expect(current!.includes(ttl === '5m' ? '5-minute' : '1-hour')).toBe(true)
            expect(target!.includes(ttl === '5m' ? '1-hour' : '5-minute')).toBe(true)
            const clause = line.match(/which start with keepalive (on|off) \(keepalive_default\)/)![1]
            expect(clause).toBe(startOn ? 'on' : 'off')
            if (target!.includes('paused')) {
              paused++
              expect(clause).toBe('on')
            } else expect(target!.endsWith(`keepalive ${clause}`)).toBe(true)
            expect(line).not.toContain('A 1-hour cache would have saved')
            expect(line).not.toContain('A 5-minute cache would have saved')
          }
        }
      }
    }
    expect(lines).toBeGreaterThan(0)
    expect(paused).toBeGreaterThan(0)
  })

  test('ttlLine words a result it is handed', () => {
    expect(ttlLine({ better: '1h', savedUsd: 4.74, of: 10 }, inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: false } }))).toBe(
      'You\'re on a 5-minute cache with keepalive off. A 1-hour cache with keepalive off would have saved $4.74 over 10 priced pauses across sessions: set "promptCacheTtl": "1h" in settings.json for new sessions, which start with keepalive off (keepalive_default).',
    )
  })
})
