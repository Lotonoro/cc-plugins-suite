import { describe, expect, test } from 'claude-code/testing'
import { dollars, figureOf, kTokens, NO_KINDS, NO_SPEND, parsePricing, PRICES, ratesFor, rewriteOf, spendOf, uponOf, writeReadRatio } from './prices'

describe('the price table', () => {
  test('a 5 m write costs 1.25 inputs and a 1 h write 2, so on Opus 5.5 they are 25 and 40 reads', () => {
    expect(Math.round(writeReadRatio(PRICES, 'claude-opus-5-5', '5m')!)).toBe(25)
    expect(Math.round(writeReadRatio(PRICES, 'claude-opus-5-5', '1h')!)).toBe(40)
  })

  test('a dated model name finds its undated entry', () => {
    expect(ratesFor(PRICES, 'claude-haiku-4-5-20251001')).toBe(PRICES['claude-haiku-4-5'])
  })

  test('a spend is priced by kind, and a model the table lacks, fast mode or no model has no dollars and says why', () => {
    const kinds = { ...NO_KINDS, read: 1_000_000, write5m: 1_000_000 }
    expect(Math.round(spendOf(PRICES, 'claude-opus-5-5', 'standard', kinds).usd! * 1e6)).toBe(5200000)
    expect(Math.round(spendOf(PRICES, 'claude-opus-5-5', null, kinds).usd! * 1e6)).toBe(5200000)
    expect(spendOf(PRICES, 'claude-opus-5-5', 'fast', kinds)).toMatchObject({ usd: null, why: 'no price for fast mode', read: 1_000_000 })
    expect(spendOf(PRICES, 'claude-nonesuch-1', 'standard', kinds)).toMatchObject({ usd: null, why: 'no price for claude-nonesuch-1' })
    expect(spendOf(PRICES, null, null, kinds)).toMatchObject({ usd: null, why: 'no price for an unnamed model' })
  })
})

describe('the wording of a figure', () => {
  test('dollars: a cent from five cents up, a tenth of a cent below, and a floor', () => {
    expect([dollars(4.74), dollars(0.0852), dollars(0.016), dollars(0.0076), dollars(0.01), dollars(0.0001), dollars(0)]).toEqual(['$4.74', '$0.09', '$0.016', '$0.008', '$0.01', '<$0.001', '$0.00'])
  })

  test('tokens: 0, under a thousand, and whole thousands', () => {
    expect([kTokens(0), kTokens(999), kTokens(1500)]).toEqual(['0', '<1k', '~2k'])
  })
})

// Rows as the official pricing page serves them, with its links, footnote marks and the over-100k row.
const PAGE = [
  'This page provides detailed pricing information.',
  '',
  '## Model pricing',
  '',
  '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
  '| :--- | :--- | :--- | :--- | :--- | :--- |',
  '| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |',
  '| Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/14604842)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |',
  '| Claude Opus 4 ([retired, except on Claude Models on Google Cloud (Google managed)](https://x.test/d)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |',
  '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
  '| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |',
  '| Claude Something Odd | n/a | n/a | n/a | n/a | n/a |',
  '',
  '## Cloud platform pricing',
  '',
  '| Claude Opus 5.5 | $99 / MTok | $99 / MTok | $99 / MTok | $99 / MTok | $99 / MTok |',
].join('\n')

describe('parsePricing: the official pricing page', () => {
  test('each row of the model table is a model id with its four rates per token', () => {
    const list = parsePricing(PAGE)!
    expect(Object.keys(list)).toEqual(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-4', 'claude-haiku-5-5'])
    expect(list['claude-fable-5-1']).toEqual({ input: 10e-6, write5m: 12.5e-6, write1h: 20e-6, read: 0.25e-6, above: null })
    expect(list['claude-opus-4']!.write5m).toBe(18.75e-6)
  })

  test('a row for prompts over a size is that model\'s higher tier, and a prompt over it is priced there', () => {
    const list = parsePricing(PAGE)!
    expect(Math.round(list['claude-haiku-5-5']!.input * 1e9)).toBe(100)
    const { threshold, ...tier } = list['claude-haiku-5-5']!.above!
    expect([threshold, ...Object.values(tier).map((v) => Math.round(v * 1e9))]).toEqual([100000, 500, 50, 625, 1000])
    const read = (total: number) => spendOf(list, 'claude-haiku-5-5', null, { ...NO_KINDS, read: total }, total).usd!
    expect(Math.round(read(100000) * 1e6)).toBe(1000)
    expect(Math.round(read(100001) * 1e6)).toBe(5000)
  })

  test('only the model table is read; a page without it, or with no readable row, is null', () => {
    expect(parsePricing(PAGE)!['claude-opus-5-5']).toBeUndefined()
    expect(parsePricing('# Not the page')).toBeNull()
    expect(parsePricing('## Model pricing\n\n| Claude Opus 5.5 | n/a | n/a | n/a | n/a | n/a |')).toBeNull()
  })

  test('the built-in table agrees with the page on what it holds for the same models', () => {
    const list = parsePricing(PAGE)!
    expect(PRICES['claude-fable-5-1']).toEqual(list['claude-fable-5-1'])
    expect(PRICES['claude-haiku-5-5']).toEqual(list['claude-haiku-5-5'])
  })
})

describe('the figures in the unit shown: dollars, or tokens with the word tokens after each count', () => {
  const priced = { input: 0, read: 0, write5m: 0, write1h: 0, usd: 0.02, why: null }

  test('a spend in tokens names each kind it holds, with its count of tokens', () => {
    expect(figureOf({ input: 5000, read: 33000, write5m: 0, write1h: 0, usd: null, why: 'no price' }, 'tokens')).toBe('~5k input tokens, ~33k tokens read')
    expect(figureOf({ input: 0, read: 0, write5m: 50000, write1h: 0, usd: 0.3, why: null }, 'tokens')).toBe('~50k tokens written')
    expect(figureOf(NO_SPEND, 'tokens')).toBe('0 tokens read')
  })

  test('a priced spend reads as dollars in dollars, and an unpriced one falls back to tokens', () => {
    expect(figureOf(priced, 'dollars')).toBe('$0.02')
    expect(figureOf({ ...priced, usd: null, read: 33000, why: 'no price for claude-nonesuch-1' }, 'dollars')).toBe('~33k tokens read')
  })

  test('a rewrite is its dollars, or the tokens written with the word tokens', () => {
    expect(rewriteOf({ input: 0, read: 0, write5m: 20000, write1h: 0, usd: 0.1, why: null }, 'dollars')).toBe('$0.10')
    expect(rewriteOf({ input: 0, read: 0, write5m: 20000, write1h: 0, usd: 0.1, why: null }, 'tokens')).toBe('~20k tokens')
    expect(rewriteOf({ input: 0, read: 0, write5m: 20000, write1h: 0, usd: null, why: 'no price' }, 'dollars')).toBe('~20k tokens')
  })

  test('the next prompt\'s rewrite is tilded in dollars, but a figure under $0.0005 is not', () => {
    expect(uponOf({ input: 0, read: 0, write5m: 0, write1h: 29000, usd: 0.42, why: null }, 'dollars')).toBe('~$0.42')
    expect(uponOf({ input: 0, read: 0, write5m: 100, write1h: 0, usd: 0.0001, why: null }, 'dollars')).toBe('<$0.001')
  })

  test('the next prompt\'s rewrite is in tokens when the unit is tokens, or the model has no price', () => {
    expect(uponOf({ input: 0, read: 0, write5m: 29000, write1h: 0, usd: 0.42, why: null }, 'tokens')).toBe('~29k tokens')
    expect(uponOf({ input: 0, read: 0, write5m: 29000, write1h: 0, usd: null, why: 'no price for claude-nonesuch-1' }, 'dollars')).toBe('~29k tokens')
  })
})
