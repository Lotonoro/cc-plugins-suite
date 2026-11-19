import type { ModelUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import { CATALOG_IDS } from './fakes'
import { canonicalOf } from './models'
import { centsOf, entryOf, percentOf, priceOf, shareOf, wholeOf } from './pricing'
import type { Entry } from './pricing'

const counts = (over: Partial<ModelUsage> = {}): ModelUsage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over })

// Whether two dollar figures agree to half the smallest step a ledger figure shows (nine decimals), so a rate one step off fails: the kit's expect has no toBeCloseTo.
const closeTo = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 5e-10

// The entry an id has. A test that needs one fails here, naming the id, where the table has none.
const entryFor = (id: string): Entry => {
  const entry = entryOf(id)
  if (entry === undefined) throw new Error(`the table has no entry for ${id}`)
  return entry
}

const HAIKU_5_5 = 'claude-haiku-5-5'

describe('priceOf for Haiku 5.5, whose price steps up past 100,000 tokens of prompt', () => {
  const price = (usage: ModelUsage): number => priceOf(entryFor(HAIKU_5_5), usage)

  test('a response under the tier is priced at the standard rates, each token kind at its own', () => {
    expect(closeTo(price(counts({ input_tokens: 100_000 })), 0.01)).toBe(true)
    expect(closeTo(price(counts({ output_tokens: 1_000_000 })), 0.5)).toBe(true)
    expect(closeTo(price(counts({ cache_read_input_tokens: 100_000 })), 0.001)).toBe(true)
    expect(closeTo(price(counts({ cache_creation_input_tokens: 100_000 })), 0.0125)).toBe(true)
  })

  test('a response measured live is priced to the figure the ledger grew by', () => {
    // A reviewer response measured live on 2026-11-09: the session ledger moved from 0.1548464 to 0.15780685.
    expect(closeTo(price(counts({ input_tokens: 2, output_tokens: 146, cache_read_input_tokens: 0, cache_creation_input_tokens: 23_098 })), 0.00296045)).toBe(true)
  })

  test('a response whose prompt is over 100,000 tokens is priced whole at the higher rates, output included', () => {
    const big = counts({ input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 2_000_000 })
    expect(closeTo(price(big), (1 * 0.5 + 100_000 * 0.05 + 2_000_000 * 2.5) / 1_000_000)).toBe(true)
  })

  test('the prompt is input, cache reads and cache writes together, and 100,000 exactly is still under the tier', () => {
    expect(closeTo(price(counts({ input_tokens: 50_000, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 25_000 })), (50_000 * 0.1 + 25_000 * 0.01 + 25_000 * 0.125) / 1_000_000)).toBe(true)
    expect(closeTo(price(counts({ input_tokens: 50_000, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 25_001 })), (50_000 * 0.5 + 25_000 * 0.05 + 25_001 * 0.625) / 1_000_000)).toBe(true)
  })

  test('a large output does not push a small prompt into the higher tier', () => {
    expect(closeTo(price(counts({ input_tokens: 10, output_tokens: 500_000 })), (10 * 0.1 + 500_000 * 0.5) / 1_000_000)).toBe(true)
  })

  test('no tokens cost nothing', () => {
    expect(price(counts())).toBe(0)
  })
})

// One response of a measured run: the id its run reported, its four token counts, and the dollars it prices at.
type Row = { id: string; input: number; output: number; cacheRead: number; cacheWrite: number; dollars: number }

// Two responses of each of 13 runs, one run on each of the 12 priced models and a second on Haiku 5.5, measured on engine 2.1.311 on 2026-11-15 and copied here on 2026-11-18. The dollars are what the session ledger grew by across the response, read to nine decimals just before it and just after.
const LEDGER: readonly Row[] = [
  { id: 'claude-haiku-5-5', input: 2, output: 371, cacheRead: 18103, cacheWrite: 6604, dollars: 0.00119223 },
  { id: 'claude-haiku-5-5', input: 4, output: 14, cacheRead: 24707, cacheWrite: 552, dollars: 0.00032347 },
  { id: 'claude-sonnet-5-5', input: 2, output: 13, cacheRead: 0, cacheWrite: 24712, dollars: 0.061914 },
  { id: 'claude-sonnet-5-5', input: 4, output: 13, cacheRead: 24151, cacheWrite: 751, dollars: 0.0044306 },
  { id: 'claude-haiku-5-5', input: 2, output: 347, cacheRead: 18103, cacheWrite: 6617, dollars: 0.001181855 },
  { id: 'claude-haiku-5-5', input: 4, output: 14, cacheRead: 24720, cacheWrite: 526, dollars: 0.00032035 },
  { id: 'claude-opus-5-5', input: 2, output: 136, cacheRead: 0, cacheWrite: 24721, dollars: 0.126333 },
  { id: 'claude-opus-5-5', input: 4, output: 13, cacheRead: 24721, cacheWrite: 314, dollars: 0.0067902 },
  { id: 'claude-fable-5-1', input: 2, output: 13, cacheRead: 0, cacheWrite: 24727, dollars: 0.3097575 },
  { id: 'claude-fable-5-1', input: 4, output: 13, cacheRead: 24170, cacheWrite: 747, dollars: 0.01607 },
  { id: 'claude-haiku-4-5-20251001', input: 10, output: 113, cacheRead: 0, cacheWrite: 19059, dollars: 0.02439875 },
  { id: 'claude-haiku-4-5-20251001', input: 10, output: 76, cacheRead: 19059, cacheWrite: 263, dollars: 0.00262465 },
  { id: 'claude-sonnet-5', input: 2, output: 13, cacheRead: 0, cacheWrite: 25314, dollars: 0.063419 },
  { id: 'claude-sonnet-5', input: 2, output: 13, cacheRead: 25314, cacheWrite: 191, dollars: 0.0056743 },
  { id: 'claude-sonnet-4-6', input: 3, output: 12, cacheRead: 0, cacheWrite: 18815, dollars: 0.07074525 },
  { id: 'claude-sonnet-4-6', input: 3, output: 12, cacheRead: 18815, cacheWrite: 154, dollars: 0.006411 },
  { id: 'claude-opus-5', input: 2, output: 13, cacheRead: 0, cacheWrite: 24746, dollars: 0.1549975 },
  { id: 'claude-opus-5', input: 2, output: 13, cacheRead: 24746, cacheWrite: 191, dollars: 0.01390175 },
  { id: 'claude-opus-4-8', input: 2, output: 13, cacheRead: 0, cacheWrite: 24760, dollars: 0.155085 },
  { id: 'claude-opus-4-8', input: 2, output: 13, cacheRead: 24760, cacheWrite: 190, dollars: 0.0139025 },
  { id: 'claude-opus-4-7', input: 6, output: 15, cacheRead: 0, cacheWrite: 25651, dollars: 0.16072375 },
  { id: 'claude-opus-4-7', input: 6, output: 15, cacheRead: 25651, cacheWrite: 196, dollars: 0.0144555 },
  { id: 'claude-opus-4-6', input: 3, output: 13, cacheRead: 0, cacheWrite: 18921, dollars: 0.11859625 },
  { id: 'claude-opus-4-6', input: 3, output: 12, cacheRead: 18921, cacheWrite: 154, dollars: 0.010738 },
  { id: 'claude-fable-5', input: 2, output: 13, cacheRead: 0, cacheWrite: 24774, dollars: 0.310345 },
  { id: 'claude-fable-5', input: 2, output: 13, cacheRead: 24774, cacheWrite: 190, dollars: 0.027819 },
]

const usageOf = (row: Row): ModelUsage => counts({ input_tokens: row.input, output_tokens: row.output, cache_read_input_tokens: row.cacheRead, cache_creation_input_tokens: row.cacheWrite })

// The ids the catalog offers that the skill's model table names no price for.
const NO_LIST_PRICE = ['claude-fable-5-2']

// The one priced model whose price steps up with the prompt, and the prompt size above which it does.
const BOUNDARIES: Readonly<Record<string, number>> = { [HAIKU_5_5]: 100_000 }

describe('the price table', () => {
  test('every measured response prices to the figure the ledger grew by', () => {
    expect(LEDGER).toHaveLength(26)
    const off = LEDGER.filter(row => !closeTo(priceOf(entryFor(row.id), usageOf(row)), row.dollars)).map(row => ({ ...row, priced: priceOf(entryFor(row.id), usageOf(row)) }))
    expect(off).toEqual([])
  })

  test('every id the catalog offers is priced and has a measured response, or has no list price and reads unpriced', () => {
    const withListPrice = CATALOG_IDS.filter(id => !NO_LIST_PRICE.includes(id))
    expect({
      // offered with a list price, and no entry
      noEntry: withListPrice.filter(id => entryOf(id) === undefined),
      // offered with a list price, and no measured response to pin its rates
      noResponse: withListPrice.filter(id => !LEDGER.some(row => canonicalOf(row.id) === canonicalOf(id))),
      // offered with no list price, and an entry all the same
      pricedAnyway: NO_LIST_PRICE.filter(id => entryOf(id) !== undefined),
      // in the set of ids with no list price without being offered
      notOffered: NO_LIST_PRICE.filter(id => !CATALOG_IDS.includes(id)),
    }).toEqual({ noEntry: [], noResponse: [], pricedAnyway: [], notOffered: [] })
  })

  test('only Haiku 5.5 has a boundary, and it is 100,000 tokens of prompt: every other priced model has none', () => {
    const wrong = CATALOG_IDS.filter(id => {
      const entry = entryOf(id)
      return entry !== undefined && entry.boundary !== (BOUNDARIES[id] ?? null)
    })
    expect(wrong).toEqual([])
    expect(entryFor(HAIKU_5_5).boundary).toBe(100_000)
  })

  test('a model with no boundary prices a 500,000-token prompt at its one rate set: five times a 100,000-token prompt of the same mix', () => {
    const small = counts({ input_tokens: 10_000, output_tokens: 3_000, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 20_000 })
    const big = counts({ input_tokens: 50_000, output_tokens: 15_000, cache_read_input_tokens: 350_000, cache_creation_input_tokens: 100_000 })
    const untiered = CATALOG_IDS.filter(id => entryOf(id)?.boundary === null)
    expect(untiered.length).toBeGreaterThan(0)
    expect(untiered.filter(id => !closeTo(priceOf(entryFor(id), big), 5 * priceOf(entryFor(id), small)))).toEqual([])
  })
})

describe('entryOf', () => {
  test('an id with a date suffix after a dash or an at sign is priced as its canonical id, Haiku 4.5\'s catalog id among them', () => {
    for (const id of [HAIKU_5_5, 'claude-opus-4-6', 'claude-haiku-4-5']) {
      expect(entryOf(`${id}-20261001`)).toBe(entryFor(id))
      expect(entryOf(`${id}@20261001`)).toBe(entryFor(id))
    }
    expect(entryOf('claude-haiku-4-5-20251001')).toBe(entryFor('claude-haiku-4-5'))
  })

  test('a context-suffixed id has no entry while its base id has one', () => {
    expect(entryOf('claude-opus-4-6')).toBeDefined()
    expect(entryOf('claude-opus-4-6[1m]')).toBeUndefined()
    expect(entryOf('claude-opus-4-6-20261001[1m]')).toBeUndefined()
  })

  test('any other name is unpriced: an alias, a model outside the table, a partner prefix, a malformed suffix', () => {
    for (const name of ['haiku', 'sonnet', 'claude-unpriced-1-1', `anthropic.${HAIKU_5_5}`, `us.anthropic.${HAIKU_5_5}-v1:0`, `${HAIKU_5_5}-2026100`, `${HAIKU_5_5}-latest`, `${HAIKU_5_5}x`, '', `x${HAIKU_5_5}`, 'Claude-Haiku-5-5']) {
      expect(entryOf(name)).toBeUndefined()
    }
  })
})

describe('shareOf', () => {
  test('the share is the tally over the total, as a percentage', () => {
    expect(shareOf(50, 100)).toBe(50)
    expect(shareOf(3, 100)).toBe(3)
  })

  test('a tally over the total is clamped to 100', () => {
    expect(shareOf(150, 100)).toBe(100)
  })

  test('an unknown, zero, negative or non-finite total has no share', () => {
    for (const total of [undefined, 0, -5, Number.NaN, Infinity]) {
      expect(shareOf(10, total)).toBeUndefined()
    }
  })

  test('a negative tally has a share of zero', () => {
    expect(shareOf(-1, 100)).toBe(0)
  })
})

describe('the money formatters', () => {
  test('whole dollars from $10, to the cent below, and <$0.01 under a cent', () => {
    expect(wholeOf(12.4)).toBe('$12')
    expect(wholeOf(10)).toBe('$10')
    expect(wholeOf(9.996)).toBe('$10')
    expect(wholeOf(9.99)).toBe('$9.99')
    expect(wholeOf(3.4)).toBe('$3.40')
    expect(wholeOf(0.42)).toBe('$0.42')
    expect(wholeOf(0.01)).toBe('$0.01')
    expect(wholeOf(0.004)).toBe('<$0.01')
    expect(wholeOf(1234.5)).toBe('$1235')
  })

  test('the popup figure is to the cent at every size, and <$0.01 under a cent', () => {
    expect(centsOf(12.4)).toBe('$12.40')
    expect(centsOf(410.274)).toBe('$410.27')
    expect(centsOf(0.5)).toBe('$0.50')
    expect(centsOf(0.0049)).toBe('<$0.01')
  })

  test('nothing spent reads as $0.00 to the cent', () => {
    expect(centsOf(0)).toBe('$0.00')
    expect(wholeOf(0)).toBe('$0.00')
  })

  test('the share is whole from 1%, one decimal below, and <0.1% under that', () => {
    expect(percentOf(3)).toBe('3%')
    expect(percentOf(3.4)).toBe('3%')
    expect(percentOf(1)).toBe('1%')
    expect(percentOf(0.96)).toBe('1%')
    expect(percentOf(0.4)).toBe('0.4%')
    expect(percentOf(0.1)).toBe('0.1%')
    expect(percentOf(0.04)).toBe('<0.1%')
    expect(percentOf(0)).toBe('<0.1%')
    expect(percentOf(100)).toBe('100%')
  })
})
