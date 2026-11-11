import { describe, expect, test } from 'claude-code/testing'
import type { PauseRecord } from './history'
import { adviceLine, adviceOf, bestSetupOf, newSessionClause, pricedOf, ratesOfView, ttlLine, ttlLineOf, type Inputs } from './advice'
import { parseRequest } from './keepalive'
import { PRICES } from './prices'
import { SPAN_SPACE, wrapLine } from './sections'
import { sessionBalanceLine } from './verdict'

const S = 1000
// A row as the pane and the answer print it: the spans of a command or a setup joined by plain spaces.
const plain = (text: string): string => text.split(SPAN_SPACE).join(' ')
// A block's rows as the pane prints them, one string each.
const printed = (rows: string[]): string[] => rows.map(plain)
// The step of a change block: its `do:` row after the label, as printed; '' where the block has none.
const stepOf = (rows: string[]): string => printed(rows).find((row) => row.startsWith('do: '))?.slice('do: '.length) ?? ''
// A dollar figure in a text: a `$` before a digit, or the `<$` of a saving under a tenth of a cent. The pointer's own `$ only` is neither.
const DOLLAR_FIGURE = /\$\d|<\$/
// The /keepalive commands of a step, each up to the first ` or ` or ` before ` that follows it.
const commandsOf = (step: string): string[] => {
  const commands: string[] = []
  for (let from = step.indexOf('/keepalive'); from !== -1; from = step.indexOf('/keepalive', from + 1)) {
    const ends = [step.indexOf(' or ', from), step.indexOf(' before ', from)].filter((i) => i !== -1)
    commands.push(step.slice(from, Math.min(...ends)))
  }
  return commands
}
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
      run: { leadMs: 15 * S, pinned: null },
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
    // 6-minute pauses with 36k written each: 1 h off costs $0.72 a pause, 5 m off $0.70, a $0.02 difference under 5 %.
    expect(bestSetupOf(inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 36000) }))).toMatchObject({ kind: 'even', near: { setup: { ttl: '5m', keepalive: false } } })
  })

  test('the same pauses at a saving above a twentieth and above a cent are a change', () => {
    // 50k written each: 1 h off costs $1.00 a pause, 5 m off $0.875, a 12.5 % saving.
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

describe('adviceLine and adviceOf: the best-setup block of label rows, in the unit shown', () => {
  test('a change names the setting that changes, the saving, the pauses, and how to make it', () => {
    expect(printed(adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'dollars'))).toEqual([
      'setup: 5m/on',
      'best: 1h/off · would have saved $1.20 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
    ])
  })

  test('a change of TTL names the keepalive state new sessions start with, and the default, the command and the click only where they start it other than the change wants', () => {
    // The new session a TTL switch needs starts keepalive as keepalive_default says, not as this session runs it.
    const history = pauses(10, 30 * MIN)
    expect(bestSetupOf(inputs({ history, fresh: { on: true, leadMs: 15 * S, pinned: null } }))).toMatchObject({ kind: 'change', to: { ttl: '1h', keepalive: false }, startsOn: true })
    expect(printed(adviceOf(inputs({ history, fresh: { on: true, leadMs: 15 * S, pinned: null } }), 'dollars'))).toEqual([
      'setup: 5m/on',
      'best: 1h/off · would have saved $1.20 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start on: keepalive_default); then /keepalive default off before the new session, or in it /keepalive off or click pie off',
    ])
    // On 5 m with keepalive on and new sessions starting off, a change to 1 h with keepalive on needs the click though keepalive is on now.
    const to1hOn = { kind: 'change' as const, from: { ttl: '5m' as const, keepalive: true }, to: { ttl: '1h' as const, keepalive: true }, savedUsd: 0.5, of: 10, source: 'recent' as const, run: { leadMs: 15 * S, pinned: null } }
    expect(printed(adviceLine({ ...to1hOn, startsOn: false }, 'dollars', 15 * S))).toEqual([
      'setup: 5m/on',
      'best: 1h/on · would have saved $0.50 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default); then /keepalive default on before the new session, or in it /keepalive on 15 or click pie on',
    ])
    expect(adviceLine({ ...to1hOn, startsOn: true }, 'dollars', 15 * S)).toEqual([
      'setup: 5m/on',
      'best: 1h/on · would have saved $0.50 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start on: keepalive_default)',
    ])
  })

  test('a change over this session\'s pauses says so', () => {
    // Priced over the five pauses of this session, the saving is half of the $1.20 the ten recent ones give.
    expect(printed(adviceOf(inputs({ session: pauses(5, 30 * MIN), history: pauses(10, 30 * MIN) }), 'dollars'))[1]).toBe('best: 1h/off · would have saved $0.60 (5 pauses this session)')
  })

  test('a change of the TTL alone names only the promptCacheTtl setting, and going back to 5 m sets it to "5m"', () => {
    expect(printed(adviceOf(inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 50000) }), 'dollars'))).toEqual([
      'setup: 1h/off',
      'best: 5m/off · would have saved $1.25 (10 recent pauses)',
      'do: set "promptCacheTtl": "5m" in settings.json (new sessions start off: keepalive_default)',
    ])
  })

  test('a change of keepalive alone gives the command beside the click', () => {
    const result = adviceLine({ kind: 'change', from: { ttl: '5m', keepalive: false }, to: { ttl: '5m', keepalive: true }, savedUsd: 0.5, of: 3, source: 'recent', startsOn: false, run: { leadMs: 15 * S, pinned: null } }, 'dollars', 15 * S)
    expect(printed(result)).toEqual(['setup: 5m/off', 'best: 5m/on · would have saved $0.50 (3 recent pauses)', 'do: /keepalive on 15 or click pie on'])
  })

  test('a same-TTL change from keepalive on to off ends with the off command and the click', () => {
    const result = adviceLine({ kind: 'change', from: { ttl: '5m', keepalive: true }, to: { ttl: '5m', keepalive: false }, savedUsd: 0.5, of: 3, source: 'recent', startsOn: true, run: { leadMs: 20 * S, pinned: 3 } }, 'dollars', 20 * S)
    expect(printed(result).at(-1)).toBe('do: /keepalive off or click pie off')
  })

  test('the on-best block with keepalive on says what keepalive saves against having it off', () => {
    expect(printed(adviceOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }), 'dollars'))).toEqual([
      'setup: 5m/on (cheapest)',
      'saves ~$4.40 vs 5m/off (10 recent pauses)',
    ])
  })

  test('the on-best block with keepalive off says what the current TTL saves against the other', () => {
    expect(printed(adviceOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 20 * MIN, 2000) }), 'dollars'))).toEqual([
      'setup: 1h/off (cheapest)',
      'saves ~$4.74 vs 5m/off (10 recent pauses)',
    ])
  })

  test('a saving under a tenth of a cent is shown as "<$0.001", with no "~" before it', () => {
    expect(printed(adviceLine({ kind: 'best', setup: { ttl: '5m', keepalive: true }, savedUsd: 0.0001, of: 10, source: 'recent', near: null }, 'dollars', 15 * S))).toEqual([
      'setup: 5m/on (cheapest)',
      'saves <$0.001 vs 5m/off (10 recent pauses)',
    ])
  })

  test('about even, with no cheaper setup, says the cheapest and the other TTL or keepalive off cost about the same, with no figure', () => {
    expect(printed(adviceOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 2 * MIN) }), 'dollars'))).toEqual([
      'setup: 1h/off (cheapest)',
      '5m/off ≈ same cost (10 recent pauses)',
    ])
    expect(printed(adviceOf(inputs({ history: pauses(10, 2 * MIN) }), 'dollars'))).toEqual([
      'setup: 5m/on (cheapest)',
      '5m/off ≈ same cost (10 recent pauses)',
    ])
  })

  test('a cheaper setup under the change threshold, with a saving over the current one: the next-best row names it and its saving, and the setup is never called cheapest', () => {
    // 6-minute pauses at 5 m on with one ping pinned: 1 h off costs $0.048 a pause and 5 m on $0.050, a 4 % saving, so no change.
    const near = inputs({ rates: OPUS, pinned: 1, history: pauses(10, 6 * MIN, 6000) })
    const result = bestSetupOf(near)
    expect(result).toMatchObject({ kind: 'best', setup: { ttl: '5m', keepalive: true }, near: { setup: { ttl: '1h', keepalive: false } } })
    expect(result?.kind === 'best' && Math.abs(result.near!.savedUsd - 0.02)).toBeLessThan(1e-9)
    const rows = printed(adviceOf(near, 'dollars'))
    expect(rows).toEqual([
      'setup: 5m/on',
      'saves ~$4.60 vs 5m/off (10 recent pauses)',
      'next best: 1h/off · would have saved $0.02, too little to change',
    ])
    expect(rows.join(' ')).not.toContain('(cheapest)')
  })

  test('a cheaper setup under the change threshold that is the baseline: the next-best row names it, its saving and the pauses, and no row repeats or contradicts it', () => {
    // 6-minute pauses on 1 h off: 5 m off costs $0.70 a pause against $0.72, a 2.8 % saving, so no change; the baseline is that setup.
    const cheaper = inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 36000) })
    expect(bestSetupOf(cheaper)).toMatchObject({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near: { setup: { ttl: '5m', keepalive: false } } })
    expect(printed(adviceOf(cheaper, 'dollars'))).toEqual([
      'setup: 1h/off',
      'next best: 5m/off · would have saved $0.20 (10 recent pauses), too little to change',
    ])
  })

  test('a baseline cheaper by a cent or more, under the threshold, says it was a little cheaper, with no figure, never "same cost"', () => {
    const near = { setup: { ttl: '1h' as const, keepalive: false }, savedUsd: 5 }
    const on = adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 4, of: 10, source: 'recent' }, 'dollars', 15 * S)
    expect(printed(on)).toEqual([
      'setup: 5m/on',
      'next best: 1h/off · would have saved $5.00, too little to change',
      '5m/off a little cheaper (10 recent pauses), too little to change',
    ])
    expect(on.join(' ')).not.toContain('same cost')
    const off = adviceLine({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near: { setup: { ttl: '5m', keepalive: true }, savedUsd: 5 }, baselineSavedUsd: 4, of: 5, source: 'session' }, 'dollars', 15 * S)
    expect(printed(off)).toEqual([
      'setup: 1h/off',
      'next best: 5m/on · would have saved $5.00, too little to change',
      '5m/off a little cheaper (5 pauses this session), too little to change',
    ])
    expect(printed(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 4, of: 10, source: 'recent' }, 'tokens', 15 * S))).toEqual([
      'setup: 5m/on',
      'next best: 1h/off · would have saved money ($ only, /keepalive unit dollars), too little to change',
      '5m/off a little cheaper (10 recent pauses), too little to change',
    ])
  })

  test('in tokens a cheaper setup under the threshold that is the baseline holds the dollar pointer in its one parenthesis', () => {
    const near = { setup: { ttl: '5m' as const, keepalive: false }, savedUsd: 0.2 }
    expect(printed(adviceLine({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near, baselineSavedUsd: 0.2, of: 10, source: 'recent' }, 'tokens', 15 * S))).toEqual([
      'setup: 1h/off',
      'next best: 5m/off · would have saved money (10 recent pauses; $ only, /keepalive unit dollars), too little to change',
    ])
  })

  test('a baseline cheaper by less than half a cent reads as the same cost, in either unit, since both compare dollars', () => {
    const near = { setup: { ttl: '1h' as const, keepalive: false }, savedUsd: 0.5 }
    expect(printed(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 0.004, of: 10, source: 'recent' }, 'dollars', 15 * S))).toEqual([
      'setup: 5m/on',
      'next best: 1h/off · would have saved $0.50, too little to change',
      '5m/off ≈ same cost (10 recent pauses)',
    ])
    expect(printed(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 0.004, of: 10, source: 'recent' }, 'tokens', 15 * S))).toContain('5m/off ≈ same cost (10 recent pauses)')
    expect(printed(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 0.005, of: 10, source: 'recent' }, 'tokens', 15 * S))).toContain('5m/off a little cheaper (10 recent pauses), too little to change')
  })

  test('in tokens a block with a saving names the setup, states the saving as money with no dollar figure, and points to the dollar unit', () => {
    const change = printed(adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'tokens'))
    expect(change.join(' ')).not.toMatch(DOLLAR_FIGURE)
    expect(change).toEqual([
      'setup: 5m/on',
      'best: 1h/off · would have saved money (10 recent pauses; $ only, /keepalive unit dollars)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
    ])
    const best = printed(adviceOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }), 'tokens'))
    expect(best.join(' ')).not.toMatch(DOLLAR_FIGURE)
    expect(best).toEqual(['setup: 5m/on (cheapest)', 'saves money vs 5m/off (10 recent pauses; $ only, /keepalive unit dollars)'])
  })

  test('the pointer to the dollar unit stands once in a block, on the first row that states money, and nowhere in a block that states none', () => {
    const POINTER = '$ only, /keepalive unit dollars'
    const near = { setup: { ttl: '1h' as const, keepalive: false }, savedUsd: 5 }
    const nearBest = inputs({ rates: OPUS, pinned: 1, history: pauses(10, 6 * MIN, 6000) })
    const blocks: [string, string[], number][] = [
      ['a change: the best row', printed(adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'tokens')), 1],
      ['the on-best result: the saves row', printed(adviceOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }), 'tokens')), 1],
      ['the on-best result with a near setup: the saves row, not the next-best row', printed(adviceOf(nearBest, 'tokens')), 1],
      ['an even result whose near setup is the baseline: the next-best row', printed(adviceLine({ kind: 'even', setup: { ttl: '1h', keepalive: false }, near: { setup: { ttl: '5m', keepalive: false }, savedUsd: 0.2 }, baselineSavedUsd: 0.2, of: 10, source: 'recent' }, 'tokens', 15 * S)), 1],
      ['an even result with another near setup: the next-best row, not the row after it', printed(adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 4, of: 10, source: 'recent' }, 'tokens', 15 * S)), 1],
      ['an even result with no near setup states no money: no pointer', printed(adviceOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 2 * MIN) }), 'tokens')), -1],
    ]
    for (const [name, rows, at] of blocks) {
      const holding = rows.flatMap((row, i) => (row.includes(POINTER) ? [i] : []))
      expect({ name, holding }).toEqual({ name, holding: at === -1 ? [] : [at] })
    }
    expect(blocks.filter(([, , at]) => at !== -1)).toHaveLength(5)
  })

  test('the pointer is the balance producer\'s words, its command one span on both rows', () => {
    const balance = sessionBalanceLine({ netUsd: 0.15, pauses: 2 }, 'tokens')
    const pointer = balance.slice('balance vs other setting: '.length, balance.indexOf(' (2 pauses)'))
    expect(plain(pointer)).toBe('$ only, /keepalive unit dollars')
    const rows = adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'tokens')
    expect(rows.filter((row) => row.includes(pointer))).toHaveLength(1)
    expect(pointer).toContain(['/keepalive', 'unit', 'dollars'].join(SPAN_SPACE))
  })

  test('with no result the block is empty', () => {
    expect(adviceOf(inputs({ rates: { read: 0, write5m: 0, write1h: 0 }, history: pauses(10, 30 * MIN) }), 'dollars')).toEqual([])
  })

  test('no row of any block holds the old sentence\'s words or ends with a full stop, and every block opens with its setup row', () => {
    const near = { setup: { ttl: '1h' as const, keepalive: false }, savedUsd: 5 }
    const blocks = [
      adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'dollars'),
      adviceOf(inputs({ history: pauses(10, 30 * MIN), fresh: { on: true, leadMs: 15 * S, pinned: null } }), 'tokens'),
      adviceOf(inputs({ history: pauses(10, 10 * MIN, 1000000) }), 'dollars'),
      adviceOf(inputs({ current: { ttl: '1h', keepalive: false }, history: pauses(10, 2 * MIN) }), 'dollars'),
      adviceOf(inputs({ leadMs: 300 * S, current: { ttl: '5m', keepalive: true }, history: pauses(10, 2 * MIN) }), 'dollars'),
      adviceLine({ kind: 'even', setup: { ttl: '5m', keepalive: true }, near, baselineSavedUsd: 4, of: 10, source: 'recent' }, 'tokens', 15 * S),
      ttlLineOf(inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: false } })),
    ]
    for (const rows of blocks) {
      expect(rows.length).toBeGreaterThan(1)
      expect(printed(rows)[0]).toMatch(/^setup: \d[mh]\/(on|off|paused)/)
      for (const row of printed(rows)) expect(row).not.toMatch(/You're on|-minute cache|-hour cache|with keepalive|sending nothing|\.$/)
    }
  })
})

describe('adviceOf: the block names the setup you are on, paused where keepalive sends nothing, over every point of the grid', () => {
  const TTL_MS = { '5m': 300 * S, '1h': 3600 * S }
  // The setup as the setup row names it: keepalive on at a lead not below its TTL is paused, with the reason the Keepalive section gives.
  const tokenOf = (setup: { ttl: '5m' | '1h'; keepalive: boolean }, leadMs: number): string => {
    const ttl = TTL_MS[setup.ttl]
    const state = setup.keepalive ? (leadMs < ttl ? 'on' : `paused (lead ${leadMs / S}s ≥ ${ttl / S}s TTL)`) : 'off'
    return `${setup.ttl}/${state}`
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
    let pausedPoints = 0
    for (const current of currents)
      for (const leadMs of [15 * S, TTL_MS[current.ttl], TTL_MS[current.ttl] + 100 * S])
        for (const freshLead of [15 * S, 300 * S])
          for (const history of SPANS) {
            const run = { current, leadMs, history, fresh: { on: false, leadMs: freshLead, pinned: null } }
            const rows = printed(adviceOf(inputs(run), 'dollars'))
            const result = bestSetupOf(inputs(run))
            if (result === null) {
              expect(rows).toEqual([])
              continue
            }
            points++
            expect(rows.slice(1).join(' ')).not.toContain('/paused')
            // The setup row names the current setup, with its "(cheapest)" where the block says so, paused exactly where its run sends nothing.
            expect(rows[0]!.replace(/ \(cheapest\)$/, '')).toBe(`setup: ${tokenOf(current, leadMs)}`)
            const paused = current.keepalive && leadMs >= TTL_MS[current.ttl]
            expect(rows[0]!.includes('/paused')).toBe(paused)
            if (paused) pausedPoints++
            const runLeadOf = (setup: { ttl: '5m' | '1h' }) => (setup.ttl === current.ttl ? leadMs : freshLead)
            const others = result.kind === 'change' ? [result.to] : result.kind === 'best' || result.kind === 'even' ? (result.near ? [result.near.setup] : []) : []
            for (const setup of others) expect(setup.keepalive && runLeadOf(setup) >= TTL_MS[setup.ttl]).toBe(false)
          }
    // Every point of the grid gives a block, so none is skipped by the null guard, and the paused form is read at some of them.
    expect(points).toBe(currents.length * 3 * 2 * SPANS.length)
    expect(pausedPoints).toBeGreaterThan(0)
  })
})

describe('adviceOf: a current setup paused at a lead not below its TTL', () => {
  test('a change names the paused setup it leaves, with the Keepalive section\'s reason', () => {
    expect(printed(adviceOf(inputs({ leadMs: 300 * S, current: { ttl: '5m', keepalive: true }, history: pauses(10, 30 * MIN) }), 'dollars'))).toEqual([
      'setup: 5m/paused (lead 300s ≥ 300s TTL)',
      'best: 1h/off · would have saved $4.80 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
    ])
  })

  test('the cheapest-setup block names it paused, and states the baseline in full', () => {
    expect(printed(adviceOf(inputs({ leadMs: 300 * S, current: { ttl: '5m', keepalive: true }, history: pauses(10, 2 * MIN) }), 'dollars'))).toEqual([
      'setup: 5m/paused (lead 300s ≥ 300s TTL) (cheapest)',
      '5m/off ≈ same cost (10 recent pauses)',
    ])
  })

  test('a target or near setup is never named paused, though this session\'s lead is not below its TTL: the new session runs it at its own lead', () => {
    // On 1 h with keepalive on at a 400 s lead this session sends refreshes, and a new session runs a 5 m cache at its own 15 s lead.
    const change = { kind: 'change' as const, from: { ttl: '1h' as const, keepalive: true }, to: { ttl: '5m' as const, keepalive: true }, savedUsd: 0.5, of: 10, source: 'recent' as const, startsOn: false, run: { leadMs: 15 * S, pinned: null } }
    const rows = printed(adviceLine(change, 'dollars', 400 * S))
    expect(rows.slice(1).join(' ')).not.toContain('/paused')
    expect(rows.slice(0, 2)).toEqual(['setup: 1h/on', 'best: 5m/on · would have saved $0.50 (10 recent pauses)'])
    // The same lead names the 5 m setup paused where it is the one you are on.
    expect(printed(adviceLine({ ...change, from: change.to, to: change.from }, 'dollars', 400 * S))[0]).toBe('setup: 5m/paused (lead 400s ≥ 300s TTL)')
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

describe('newSessionClause: the words the TTL block and the best-setup change step share for what a switch of TTL leaves new sessions on', () => {
  test('it says the start mode and the option that decides it', () => {
    expect(newSessionClause(true)).toBe('new sessions start on: keepalive_default')
    expect(newSessionClause(false)).toBe('new sessions start off: keepalive_default')
  })
})

describe('ttlLineOf: the TTL block names the setup you are on, the setup it is priced against, and the keepalive state new sessions start with', () => {
  const back = inputs({ history: pauses(10, 2 * MIN, 50000), current: { ttl: '1h', keepalive: false }, fresh: { on: true, leadMs: 300 * S, pinned: null } })

  test('the target is a setup that sends nothing, named paused at the new session\'s lead, and the clause still says on', () => {
    const rows = printed(ttlLineOf(back))
    expect(rows.join(' ')).not.toContain('so run')
    expect(rows).toEqual([
      'setup: 1h/off',
      'other TTL: 5m/paused (lead 300s ≥ 300s TTL) · would have saved $1.50 (10 priced pauses, all sessions)',
      'do: set "promptCacheTtl": "5m" in settings.json (new sessions start on: keepalive_default)',
    ])
  })

  test('over one priced pause it says pause', () => {
    expect(printed(ttlLineOf({ ...back, history: back.history.slice(0, 1) }))[1]).toMatch(/\(1 priced pause, all sessions\)$/)
  })

  test('it names the target at the new session\'s lead, not this session\'s', () => {
    const slow = inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: false } })
    // This session at a 15 s lead, new sessions on at 300 s, switching back from 1 h: the 5m target reads paused.
    const rows = printed(ttlLineOf({ ...back, leadMs: 15 * S, current: { ttl: '1h', keepalive: true } }))
    expect(rows[0]).toBe('setup: 1h/on')
    expect(rows[1]).toMatch(/^other TTL: 5m\/paused \(lead 300s ≥ 300s TTL\) · would have saved/)
    // And at a 15 s new-session lead the same target reads on.
    expect(printed(ttlLineOf({ ...back, fresh: { ...back.fresh, leadMs: 15 * S } }))[1]).toMatch(/^other TTL: 5m\/on · would have saved/)
    expect(printed(ttlLineOf(slow))[1]).toMatch(/^other TTL: 1h\/off · would have saved \$4\.74 /)
  })

  test('it names a paused current setup with the reason, and the figure is dollars in either unit', () => {
    const rows = ttlLineOf({ ...inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: true } }), leadMs: 300 * S })
    expect(printed(rows)).toEqual([
      'setup: 5m/paused (lead 300s ≥ 300s TTL)',
      'other TTL: 1h/off · would have saved $4.74 (10 priced pauses, all sessions)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
    ])
  })

  test('the target names the keepalive state new sessions start with', () => {
    expect(printed(ttlLineOf(inputs({ history: pauses(10, 150 * MIN), current: { ttl: '5m', keepalive: false }, fresh: { on: true, leadMs: 15 * S, pinned: null } })))).toEqual([
      'setup: 5m/off',
      'other TTL: 1h/on · would have saved $4.40 (10 priced pauses, all sessions)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start on: keepalive_default)',
    ])
  })

  test('with nothing to price the block is empty', () => {
    expect(ttlLineOf(inputs({ history: pauses(10, 2 * MIN, 50000), current: { ttl: '5m', keepalive: false } }))).toEqual([])
    expect(ttlLineOf(inputs({ current: { ttl: '5m', keepalive: false } }))).toEqual([])
    expect(ttlLineOf(inputs({ current: { ttl: '5m', keepalive: false } }), true)).toEqual([])
  })

  test('the best-setup block and the TTL block open with the same setup row for the same setup and lead', () => {
    for (const current of [{ ttl: '5m' as const, keepalive: true }, { ttl: '5m' as const, keepalive: false }]) {
      for (const leadMs of [15 * S, 300 * S]) {
        const run = { current, leadMs, history: pauses(10, 30 * MIN, 2000) }
        const block = adviceOf(inputs(run), 'dollars')
        const ttl = ttlLineOf(inputs(run))
        expect(block).not.toEqual([])
        expect(ttl).not.toEqual([])
        expect(ttl[0]).toBe(block[0])
        expect(plain(ttl[0]!)).toMatch(/^setup: 5m\/(on|off|paused \(lead 300s ≥ 300s TTL\))$/)
      }
    }
  })

  test('with the best-setup block shown the TTL block leaves out its setup row, and nothing else', () => {
    const run = inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: false } })
    const alone = ttlLineOf(run)
    expect(alone).toHaveLength(3)
    expect(alone[0]).toBe('setup: 5m/off')
    expect(ttlLineOf(run, false)).toEqual(alone)
    expect(ttlLineOf(run, true)).toEqual(alone.slice(1))
    expect(ttlLineOf(run, true).some((row) => row.startsWith('setup:'))).toBe(false)
    const a = { better: '1h' as const, savedUsd: 4.74, of: 10 }
    expect(ttlLine(a, run, true)).toEqual(ttlLine(a, run).slice(1))
  })

  test('across current TTL, keepalive, new-session start and new-session lead, the block names the current setup first and the target second, and the clause says the start mode', () => {
    let blocks = 0
    let paused = 0
    for (const ttl of ['5m', '1h'] as const) {
      for (const keepalive of [true, false]) {
        for (const startOn of [true, false]) {
          for (const freshLead of [15 * S, 300 * S]) {
            // Pauses on which the other TTL wins: long and slowly growing from 5m, short and fast growing from 1h.
            const history = ttl === '5m' ? pauses(10, 20 * MIN, 2000) : pauses(10, 2 * MIN, 50000)
            const i = inputs({ history, current: { ttl, keepalive }, fresh: { on: startOn, leadMs: freshLead, pinned: null } })
            const rows = printed(ttlLineOf(i))
            if (rows.length === 0) continue
            blocks++
            const other = ttl === '5m' ? '1h' : '5m'
            const [current, target, step] = rows
            expect(rows).toHaveLength(3)
            // A setup is named with its keepalive state, never by its TTL alone.
            expect(rows.join(' ')).not.toMatch(/other TTL: (1h|5m) ·/)
            expect(current).toMatch(new RegExp(`^setup: ${ttl}/(on|off|paused \\(lead [^)]*\\))$`))
            expect(target).toMatch(new RegExp(`^other TTL: ${other}/(on|off|paused \\(lead [^)]*\\)) · would have saved \\$`))
            const clause = step!.match(/\(new sessions start (on|off): keepalive_default\)$/)![1]
            expect(clause).toBe(startOn ? 'on' : 'off')
            if (target!.includes('/paused')) {
              paused++
              expect(clause).toBe('on')
            } else expect(target!.startsWith(`other TTL: ${other}/${clause} ·`)).toBe(true)
          }
        }
      }
    }
    expect(blocks).toBeGreaterThan(0)
    expect(paused).toBeGreaterThan(0)
  })

  test('ttlLine words a result it is handed', () => {
    expect(printed(ttlLine({ better: '1h', savedUsd: 4.74, of: 10 }, inputs({ history: pauses(10, 20 * MIN, 2000), current: { ttl: '5m', keepalive: false } })))).toEqual([
      'setup: 5m/off',
      'other TTL: 1h/off · would have saved $4.74 (10 priced pauses, all sessions)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
    ])
  })

  test('the setup token of the setup row and of the other-TTL target are each one span, the paused form included', () => {
    // A paused 5 m setup, and new sessions that start on at a lead above the 1 h TTL, so the target is paused too.
    const rows = ttlLineOf(inputs({ history: pauses(10, 20 * MIN, 2000), leadMs: 300 * S, current: { ttl: '5m', keepalive: true }, fresh: { on: true, leadMs: 3700 * S, pinned: null } }))
    expect(rows[0]).toBe(`setup: ${['5m/paused', '(lead', '300s', '≥', '300s', 'TTL)'].join(SPAN_SPACE)}`)
    expect(rows[1]).toContain(`other TTL: ${['1h/paused', '(lead', '3700s', '≥', '3600s', 'TTL)'].join(SPAN_SPACE)} · would have saved`)
    // Laid out at 48 columns, each token is whole on one row.
    const laid = rows.flatMap((row) => wrapLine(row, 48))
    expect(laid.some((row) => row.includes('5m/paused (lead 300s ≥ 300s TTL)'))).toBe(true)
    expect(laid.some((row) => row.includes('1h/paused (lead 3700s ≥ 3600s TTL)'))).toBe(true)
  })
})

describe('a change step gives the /keepalive command beside each click, at the run the target was priced at', () => {
  const SLOW = pauses(10, 10 * MIN, 1000000)
  const LONG = pauses(10, 90 * MIN)
  const asked = (rows: string[]) => {
    const command = commandsOf(stepOf(rows)).at(-1) ?? ''
    return parseRequest(command.slice('/keepalive'.length))
  }

  test('at the same TTL, keepalive on names this session\'s lead, and its pinned count when there is one', () => {
    const base = { leadMs: 20 * S, current: { ttl: '5m' as const, keepalive: false }, history: SLOW }
    expect(bestSetupOf(inputs(base))).toMatchObject({ kind: 'change', to: { ttl: '5m', keepalive: true }, run: { leadMs: 20 * S, pinned: null } })
    expect(stepOf(adviceOf(inputs(base), 'dollars'))).toBe('/keepalive on 20 or click pie on')
    expect(stepOf(adviceOf(inputs({ ...base, pinned: 3 }), 'dollars'))).toBe('/keepalive on 20 3 or click pie on')
    expect(asked(adviceOf(inputs({ ...base, pinned: 3 }), 'dollars'))).toEqual({ kind: 'on', leadMs: 20 * S, count: 3 })
  })

  test('at the other TTL where the new session starts keepalive otherwise, the command is the new session\'s run, not this session\'s', () => {
    const base = { leadMs: 20 * S, pinned: 3, current: { ttl: '5m' as const, keepalive: true }, history: LONG, fresh: { on: false, leadMs: 15 * S, pinned: null } }
    expect(bestSetupOf(inputs(base))).toMatchObject({ kind: 'change', to: { ttl: '1h', keepalive: true }, startsOn: false, run: { leadMs: 15 * S, pinned: null } })
    const rows = adviceOf(inputs(base), 'dollars')
    expect(stepOf(rows)).toBe('set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default); then /keepalive default on before the new session, or in it /keepalive on 15 or click pie on')
    expect(commandsOf(stepOf(rows)).map((c) => parseRequest(c.slice('/keepalive'.length)))).toEqual([{ kind: 'default', mode: 'on' }, { kind: 'on', leadMs: 15 * S, count: null }])
    expect(asked(rows)).toEqual({ kind: 'on', leadMs: 15 * S, count: null })
  })

  test('a mismatch change of TTL to keepalive off gives the off command', () => {
    const rows = adviceOf(inputs({ history: pauses(10, 30 * MIN), fresh: { on: true, leadMs: 15 * S, pinned: null } }), 'dollars')
    expect(stepOf(rows)).toBe('set "promptCacheTtl": "1h" in settings.json (new sessions start on: keepalive_default); then /keepalive default off before the new session, or in it /keepalive off or click pie off')
    expect(asked(rows)).toEqual({ kind: 'off' })
    expect(stepOf(adviceOf(inputs({ history: pauses(10, 30 * MIN) }), 'dollars'))).toMatch(/ \(new sessions start off: keepalive_default\)$/)
  })

  test('the command is followed by " or ", never by punctuation, and the span is joined by the span space', () => {
    const rows = adviceOf(inputs({ leadMs: 20 * S, pinned: 3, current: { ttl: '5m', keepalive: false }, history: SLOW }), 'dollars')
    expect(rows.at(-1)).toBe(`do: ${['/keepalive', 'on', '20', '3'].join(SPAN_SPACE)} or click pie on`)
  })

  test('in tokens the block states no dollar figure, carries the dollar pointer once, and its step is as in dollars', () => {
    const base = inputs({ leadMs: 20 * S, current: { ttl: '5m', keepalive: false }, history: SLOW })
    const tokens = adviceOf(base, 'tokens')
    const joined = printed(tokens).join(' ')
    expect(joined).not.toMatch(DOLLAR_FIGURE)
    expect(joined.match(/\$ only, \/keepalive unit dollars/g)).toHaveLength(1)
    expect(stepOf(tokens)).toBe('/keepalive on 20 or click pie on')
    expect(stepOf(tokens)).toBe(stepOf(adviceOf(base, 'dollars')))
  })

  test('a pin on the new session\'s run is named in the command', () => {
    const rows = adviceOf(inputs({ current: { ttl: '5m', keepalive: false }, history: LONG, fresh: { on: false, leadMs: 15 * S, pinned: 2 } }), 'dollars')
    expect(bestSetupOf(inputs({ current: { ttl: '5m', keepalive: false }, history: LONG, fresh: { on: false, leadMs: 15 * S, pinned: 2 } }))).toMatchObject({ kind: 'change', to: { ttl: '1h', keepalive: true } })
    expect(stepOf(rows).endsWith('/keepalive on 15 2 or click pie on')).toBe(true)
  })
})

describe('a change of TTL where new sessions start keepalive on and the target has it off', () => {
  const PAUSED_START = [
    'setup: 1h/off',
    'best: 5m/off · would have saved $1.25 (10 recent pauses)',
    'do: set "promptCacheTtl": "5m" in settings.json (new sessions start on: keepalive_default, so run 5m/paused (lead 300s ≥ 300s TTL))',
  ]
  const MISMATCH = [
    'setup: 5m/on',
    'best: 1h/off · would have saved $1.20 (10 recent pauses)',
    'do: set "promptCacheTtl": "1h" in settings.json (new sessions start on: keepalive_default); then /keepalive default off before the new session, or in it /keepalive off or click pie off',
  ]
  const startsOn = { on: true, leadMs: 15 * S, pinned: null }
  const paused = (leadMs: number) =>
    inputs({ rates: UNIT, current: { ttl: '1h', keepalive: false }, history: pauses(10, 6 * MIN, 50000), fresh: { on: true, leadMs, pinned: null } })

  test('a start that sends nothing at the target TTL is named paused, with nothing more to do', () => {
    expect(bestSetupOf(paused(300 * S))).toMatchObject({ kind: 'change', to: { ttl: '5m', keepalive: false }, startsOn: true })
    expect(printed(adviceOf(paused(300 * S), 'dollars'))).toEqual(PAUSED_START)
  })

  test('the same fixture at a 299 s lead is a mismatch: the default and the click are named', () => {
    expect(stepOf(adviceOf(paused(299 * S), 'dollars'))).toBe(stepOf(MISMATCH).replace('"1h"', '"5m"'))
  })

  test('the mismatch block is exactly as pinned', () => {
    expect(printed(adviceOf(inputs({ history: pauses(10, 30 * MIN), fresh: startsOn }), 'dollars'))).toEqual(MISMATCH)
  })

  test('the blocks laid out at 48 columns have no wider row, each command whole on one row, and the paused setup whole', () => {
    for (const block of [adviceOf(paused(300 * S), 'dollars'), adviceOf(inputs({ history: pauses(10, 30 * MIN), fresh: startsOn }), 'dollars')]) {
      const rows = block.flatMap((row) => wrapLine(row, 48))
      expect(rows.every((row) => row.length <= 48)).toBe(true)
      for (const command of commandsOf(stepOf(block))) expect(rows.some((row) => row.includes(command))).toBe(true)
    }
    // The paused setup the step runs is one span, so it is whole on one row.
    expect(adviceOf(paused(300 * S), 'dollars').flatMap((row) => wrapLine(row, 48)).some((row) => row.includes('5m/paused (lead 300s ≥ 300s TTL)'))).toBe(true)
  })

  test('each command in a change step is followed by " or " or " before ", and the parser reads it', () => {
    const blocks = [
      adviceOf(inputs({ history: pauses(10, 30 * MIN), fresh: startsOn }), 'dollars'),
      adviceOf(inputs({ history: pauses(10, 30 * MIN), fresh: startsOn }), 'tokens'),
      adviceOf(inputs({ history: pauses(10, 90 * MIN) }), 'dollars'),
      adviceOf(paused(299 * S), 'dollars'),
    ]
    for (const block of blocks) {
      const step = stepOf(block)
      expect(commandsOf(step).length).toBeGreaterThan(0)
      for (const command of commandsOf(step)) {
        expect(step.includes(`${command} or `) || step.includes(`${command} before `)).toBe(true)
        expect(parseRequest(command.slice('/keepalive'.length)).kind).not.toBe('usage')
      }
    }
  })

  test('over the grid of setups, leads and spans no change targets keepalive on with a run that sends nothing, new sessions starting on at 3600 s', () => {
    const TTL = { '5m': 300 * S, '1h': 3600 * S }
    for (const ttl of ['5m', '1h'] as const)
      for (const keepalive of [false, true])
        for (const leadMs of [15 * S, TTL[ttl], TTL[ttl] + 100 * S])
          for (const minutes of [2, 6, 30, 150]) {
            const result = bestSetupOf(inputs({ current: { ttl, keepalive }, leadMs, history: pauses(10, minutes * MIN), fresh: { on: true, leadMs: 3600 * S, pinned: null } }))
            if (result?.kind === 'change' && result.to.keepalive) expect(result.run.leadMs).toBeLessThan(TTL[result.to.ttl])
          }
  })
})
