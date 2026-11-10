// Anthropic's list prices, and every figure worded from them: a spend counted in tokens and in dollars, and how either is
// shown. A figure with no price keeps its tokens and says why it has no dollars.
import type { Kinds, Spend, TtlLabel, Unit } from '../types'

// A model's per-token rates, and the higher ones a prompt above `threshold` tokens pays, where the model has them.
export type Rates = Kinds & { above: (Kinds & { threshold: number }) | null }

// Rates by model.
export type PriceList = Record<string, Rates>

// What figures are worded with: the unit, the price list, and the model, speed and TTL of the cache a ping would read.
export type Money = { unit: Unit; list: PriceList; model: string | null; speed: string | null; ttl: TtlLabel }

export const NO_KINDS: Kinds = { input: 0, read: 0, write5m: 0, write1h: 0 }
export const NO_SPEND: Spend = { ...NO_KINDS, usd: 0, why: null }

// A 5 m write costs 1.25 inputs and a 1 h write 2, on every model.
export const kindsOf = (inputPerM: number, readPerM: number): Kinds => ({
  input: inputPerM / 1e6,
  read: readPerM / 1e6,
  write5m: (inputPerM * 1.25) / 1e6,
  write1h: (inputPerM * 2) / 1e6,
})
const ratesOf = (inputPerM: number, readPerM: number, above: Rates['above'] = null): Rates => ({ ...kindsOf(inputPerM, readPerM), above })

// The parser's sanity order: a read costs no more than an input, which costs no more than a 5 m write, which costs no more
// than a 1 h write.
export const inOrder = (k: Kinds): boolean => k.read <= k.input && k.input <= k.write5m && k.write5m <= k.write1h

// What is priced until the page has been read, and when it cannot be: per million tokens, input then cache read, as the
// pricing page lists them. A model the list lacks is shown in tokens, not guessed at.
export const PRICES: PriceList = {
  'claude-fable-5-1': ratesOf(10, 0.25),
  'claude-mythos-5-1': ratesOf(10, 0.25),
  'claude-fable-5': ratesOf(10, 1),
  'claude-mythos-5': ratesOf(10, 1),
  'claude-opus-5-5': ratesOf(4, 0.2),
  'claude-opus-5': ratesOf(5, 0.5),
  'claude-opus-4-8': ratesOf(5, 0.5),
  'claude-opus-4-7': ratesOf(5, 0.5),
  'claude-opus-4-6': ratesOf(5, 0.5),
  'claude-opus-4-5': ratesOf(5, 0.5),
  'claude-opus-4-1': ratesOf(15, 1.5),
  'claude-opus-4': ratesOf(15, 1.5),
  'claude-sonnet-5-5': ratesOf(2, 0.1),
  'claude-sonnet-5': ratesOf(2, 0.2),
  'claude-sonnet-4-6': ratesOf(3, 0.3),
  'claude-sonnet-4-5': ratesOf(3, 0.3),
  'claude-sonnet-4': ratesOf(3, 0.3),
  'claude-haiku-5-5': ratesOf(0.1, 0.01, { ...kindsOf(0.5, 0.05), threshold: 100000 }),
  'claude-haiku-4-5': ratesOf(1, 0.1),
  'claude-haiku-3-5': ratesOf(0.8, 0.08),
}

// Figures in tokens, as a session that was switched to tokens words them.
export const TOKENS: Money = { unit: 'tokens', list: PRICES, model: null, speed: null, ttl: '5m' }

export const unitOf = (option: unknown): Unit => (option === 'tokens' ? 'tokens' : 'dollars')

// The official pricing page, in the markdown it serves: its "Model pricing" table lists each model's input, 5 m write, 1 h
// write and cache read per million tokens. A model priced differently over a prompt size has a second row for it.
export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'

const CELL_RATE = /^\$([\d,]*\.?\d+)\s*\/\s*MTok/
const MODEL_NAME = /^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)?)\s*(?:\((.*)\))?$/
// The table's columns after the model's, as its header names them: the rates are read by position, so a page that adds or
// reorders a column is refused rather than misread.
const COLUMNS = [/input/i, /5m/i, /1h/i, /cache hits|read/i]
const OVER = /over ([\d,]+) tokens/

// Reads the "Model pricing" table into rates. Rows it cannot read are left out, so their models are shown in tokens; null when
// the page has no such table, or none of its rows could be read.
export const parsePricing = (markdown: string): PriceList | null => {
  const start = markdown.search(/^## Model pricing\s*$/m)
  if (start < 0) return null
  const rows = markdown.slice(start).split('\n').slice(1)
  const list: PriceList = {}
  const tiers: { id: string; threshold: number; kinds: Kinds }[] = []
  let inTable = false
  for (const line of rows) {
    if (!line.startsWith('|')) {
      if (inTable) break
      continue
    }
    if (!inTable && !COLUMNS.every((re, i) => re.test(line.split('|')[i + 2] ?? ''))) return null
    inTable = true
    const cells = line.split('|').slice(1, -1).map((c) => c.trim().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<sup>.*?<\/sup>/g, '').trim())
    const name = MODEL_NAME.exec(cells[0] ?? '')
    const rates = cells.slice(1, 5).map((c) => CELL_RATE.exec(c)?.[1]).map((v) => (v === undefined ? NaN : Number(v.replace(/,/g, '')) / 1e6))
    if (name === null || rates.length < 4 || !rates.every((r) => Number.isFinite(r) && r >= 0)) continue
    const [input, write5m, write1h, read] = rates as [number, number, number, number]
    if (!inOrder({ input, read, write5m, write1h })) continue
    const id = `claude-${name[1]!.toLowerCase()}-${name[2]!.replace('.', '-')}`
    const over = OVER.exec(name[3] ?? '')
    if (over === null) list[id] = { input, read, write5m, write1h, above: null }
    else tiers.push({ id, threshold: Number(over[1]!.replace(/,/g, '')), kinds: { input, read, write5m, write1h } })
  }
  for (const t of tiers) if (t.id in list) list[t.id]!.above = { ...t.kinds, threshold: t.threshold }
  return Object.keys(list).length === 0 ? null : list
}

// A model id as the list names it. A transcript names a model with or without a date (`claude-haiku-4-5-20251001`), and the
// partner platforms wrap it: Bedrock as `[region.]anthropic.claude-opus-4-1-20250805-v1[:0]` (the region of a cross-region
// inference profile, matched as a short lowercase label so a new region needs no change here), Vertex as
// `claude-opus-4-1@20250805`. Matching the list model only, never an id that merely contains one. The `-v1[:0]` version is
// Bedrock's alone: only an `anthropic.`-prefixed id loses it.
const normalised = (model: string): string => {
  const bedrock = /^(?:[a-z][a-z-]{0,9}\.)?anthropic\./.exec(model)
  const bare = bedrock === null ? model : model.slice(bedrock[0].length).replace(/-v\d+(?::\d+)?$/, '')
  return bare.replace(/@\d{8}$/, '').replace(/-\d{8}$/, '')
}

// An entry the list holds itself: `list[id]` alone would reach Object.prototype for `constructor`, `toString` or `__proto__`.
const ownRates = (list: PriceList, id: string): Rates | null => (Object.hasOwn(list, id) ? list[id]! : null)

// The id exactly as given first, so a price kept for a partner id wins over its list model's; then its normalised form.
export const ratesFor = (list: PriceList, model: string | null): Rates | null => (model === null ? null : (ownRates(list, model) ?? ownRates(list, normalised(model))))

// A cache lifetime in words, as every surface that names a TTL words it.
export const TTL_WORDS: Record<TtlLabel, string> = { '5m': '5-minute', '1h': '1-hour' }
// A cache lifetime in milliseconds.
export const TTL_MS: Record<TtlLabel, number> = { '5m': 300_000, '1h': 3_600_000 }

// What a cache write costs in reads at the model's rates; null with no price.
export const writeReadRatio = (list: PriceList, model: string | null, ttl: TtlLabel): number | null => {
  const rates = ratesFor(list, model)
  return rates === null ? null : (ttl === '1h' ? rates.write1h : rates.write5m) / rates.read
}

const unpriced = (kinds: Kinds, why: string): Spend => ({ ...kinds, usd: null, why })

// Whether a request at this speed has a price: the list prices standard mode only.
export const pricedSpeed = (speed: string | null): boolean => speed === null || speed === 'standard'

// The rates a prompt of `size` tokens pays: the model's higher rates when it is over their threshold.
export const tierOf = (rates: Rates, size: number): Kinds => (rates.above !== null && size > rates.above.threshold ? rates.above : rates)

// Prices `kinds` for a prompt of `total` tokens (their sum when not given): at the model's higher rates when the prompt is
// over its threshold. A fast-mode request or a model the list lacks has no dollars, and says why.
export const spendOf = (list: PriceList, model: string | null, speed: string | null, kinds: Kinds, total?: number): Spend => {
  if (model === null) return unpriced(kinds, 'no price for an unnamed model')
  if (!pricedSpeed(speed)) return unpriced(kinds, `no price for ${speed} mode`)
  const rates = ratesFor(list, model)
  if (rates === null) return unpriced(kinds, `no price for ${model}`)
  const at = tierOf(rates, total ?? kinds.input + kinds.read + kinds.write5m + kinds.write1h)
  const usd = kinds.input * at.input + kinds.read * at.read + kinds.write5m * at.write5m + kinds.write1h * at.write1h
  return { ...kinds, usd, why: null }
}

export const addSpend = (a: Spend, b: Spend): Spend => ({
  input: a.input + b.input,
  read: a.read + b.read,
  write5m: a.write5m + b.write5m,
  write1h: a.write1h + b.write1h,
  usd: a.usd === null || b.usd === null ? null : a.usd + b.usd,
  why: a.usd === null ? a.why : b.usd === null ? b.why : null,
})

// Dollars to the cent from five cents up, to a tenth of a cent below it (`$0.016`, `$0.004`, and `$0.01` for exactly a cent).
export const dollars = (usd: number): string => {
  if (usd >= 0.05) return `$${usd.toFixed(2)}`
  if (usd === 0) return '$0.00'
  if (usd < 0.0005) return '<$0.001'
  return `$${usd.toFixed(3).replace(/(\.\d\d)0$/, '$1')}`
}

export const kTokens = (n: number): string => (n === 0 ? '0' : n < 1000 ? '<1k' : `~${Math.round(n / 1000)}k`)

// A count of tokens read from the cache, or written to it, with the verb in place of the word tokens.
export const readOf = (n: number): string => `${kTokens(n)} read`
// The tokens a refresh reads from the warm cache: `cached` tells them from the tokens a rebuild writes.
export const cachedOf = (n: number): string => `${kTokens(n)} cached`
export const writtenOf = (n: number): string => `${kTokens(n)} written`

// A spend in the unit shown: its dollars, or its tokens by what the cache did with them. A spend with no price is in tokens.
export const figureOf = (spend: Spend, unit: Unit): string => {
  if (unit === 'dollars' && spend.usd !== null) return dollars(spend.usd)
  const written = spend.write5m + spend.write1h
  const parts = [
    ...(spend.input > 0 ? [`${kTokens(spend.input)} input tokens`] : []),
    ...(spend.read > 0 || written === 0 ? [readOf(spend.read)] : []),
    ...(written > 0 ? [writtenOf(written)] : []),
  ]
  return parts.join(', ')
}

// What a rewrite cost, for a line that goes on to say `rewritten`: dollars, or the tokens written.
export const rewriteOf = (spend: Spend, unit: Unit): string =>
  unit === 'dollars' && spend.usd !== null ? dollars(spend.usd) : `${kTokens(spend.write5m + spend.write1h)} tokens`

// What the next prompt pays to write an expired cache again, for the pie's rebuild figure: dollars when the unit is
// dollars and the model priced, else the tokens written. A figure under $0.0005 is `<$0.001` (see `dollars`), which takes no tilde.
export const uponOf = (spend: Spend, unit: Unit): string => {
  if (unit === 'dollars' && spend.usd !== null) {
    const figure = dollars(spend.usd)
    return figure.startsWith('<') ? figure : `~${figure}`
  }
  return `${kTokens(spend.write5m + spend.write1h)} tokens`
}
