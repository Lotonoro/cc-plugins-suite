import { describe, expect, test } from 'claude-code/testing'
import { PRICED_MODEL, centsOf, isPriced, percentOf, priceOf, shareOf, wholeOf } from './pricing'

const counts = (over: Partial<Parameters<typeof priceOf>[0]> = {}): Parameters<typeof priceOf>[0] => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over })

// Whether two dollar figures agree to a billionth: the kit's expect has no toBeCloseTo.
const closeTo = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9

describe('priceOf', () => {
  test('a response under the tier is priced at the standard rates, each token kind at its own', () => {
    expect(closeTo(priceOf(counts({ input_tokens: 100_000 })), 0.01)).toBe(true)
    expect(closeTo(priceOf(counts({ output_tokens: 1_000_000 })), 0.5)).toBe(true)
    expect(closeTo(priceOf(counts({ cache_read_input_tokens: 100_000 })), 0.001)).toBe(true)
    expect(closeTo(priceOf(counts({ cache_creation_input_tokens: 100_000 })), 0.0125)).toBe(true)
  })

  test('a response measured live is priced to the figure the ledger grew by', () => {
    // A reviewer response measured live on 2026-11-09: the session ledger moved from 0.1548464 to 0.15780685.
    expect(closeTo(priceOf(counts({ input_tokens: 2, output_tokens: 146, cache_read_input_tokens: 0, cache_creation_input_tokens: 23_098 })), 0.00296045)).toBe(true)
  })

  test('a response whose prompt is over 100,000 tokens is priced whole at the higher rates, output included', () => {
    const big = counts({ input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 2_000_000 })
    expect(closeTo(priceOf(big), (1 * 0.5 + 100_000 * 0.05 + 2_000_000 * 2.5) / 1_000_000)).toBe(true)
  })

  test('the prompt is input, cache reads and cache writes together, and 100,000 exactly is still under the tier', () => {
    expect(closeTo(priceOf(counts({ input_tokens: 50_000, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 25_000 })), (50_000 * 0.1 + 25_000 * 0.01 + 25_000 * 0.125) / 1_000_000)).toBe(true)
    expect(closeTo(priceOf(counts({ input_tokens: 50_000, cache_read_input_tokens: 25_000, cache_creation_input_tokens: 25_001 })), (50_000 * 0.5 + 25_000 * 0.05 + 25_001 * 0.625) / 1_000_000)).toBe(true)
  })

  test('a large output does not push a small prompt into the higher tier', () => {
    expect(closeTo(priceOf(counts({ input_tokens: 10, output_tokens: 500_000 })), (10 * 0.1 + 500_000 * 0.5) / 1_000_000)).toBe(true)
  })

  test('no tokens cost nothing', () => {
    expect(priceOf(counts())).toBe(0)
  })
})

describe('isPriced', () => {
  test('the pinned id is priced, bare or with a date suffix after a dash or an at sign', () => {
    expect(isPriced(PRICED_MODEL)).toBe(true)
    expect(isPriced(`${PRICED_MODEL}-20261001`)).toBe(true)
    expect(isPriced(`${PRICED_MODEL}@20261001`)).toBe(true)
  })

  test('any other id is not: an alias, another model, a partner prefix, a malformed suffix', () => {
    for (const id of ['haiku', 'claude-sonnet-5-5', `anthropic.${PRICED_MODEL}`, `us.anthropic.${PRICED_MODEL}-v1:0`, `${PRICED_MODEL}-2026100`, `${PRICED_MODEL}-latest`, `${PRICED_MODEL}x`, '', `x${PRICED_MODEL}`]) {
      expect(isPriced(id)).toBe(false)
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
