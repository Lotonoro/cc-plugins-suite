import type { ModelUsage } from 'claude-code'
import { canonicalOf } from './models'

// What the auditor's spend costs at API list prices, as pure functions: it knows nothing of the conversation or the engine.

// One set of rates, in dollars per million tokens.
export type RateSet = { input: number; output: number; cacheRead: number; cacheWrite: number }

// What a priced model costs. A model whose price steps up with the prompt has a boundary, the prompt size in tokens above which a response is priced whole at the higher set; a model with none has one set.
export type Entry = { boundary: null; standard: RateSet } | { boundary: number; standard: RateSet; higher: RateSet }

// Each priced model's rates, keyed by canonical id (`canonicalOf` in models.ts: the date suffix dropped and the context suffix kept, so a `[1m]` variant has no entry until its own rates are taken). True of every entry: the prompt is the uncached input, the cache reads and the cache writes; a response whose prompt is over the entry's boundary is priced whole, output included, at its higher set; every cache write is priced as a 5-minute write, since the engine's usage gives one write count with no lifetime split and the reviewer writes the 5-minute cache.
// Where the rates come from, read on 2026-11-18: input and output from the skill's model table (cached 2026-10-06); the cache write at 1.25 times the input rate, as the skill states for a 5-minute write; the cache read at the figure the skill's text gives where it gives one (Fable 5 $1, Fable 5.1 $0.25, Opus 5.5 $0.20) and at a tenth of the input rate where it does not; each boundary from the pricing page. The session ledger grew by exactly these sums across all 26 responses measured on engine 2.1.311 on 2026-11-15.
// The exceptions. Sonnet 5.5's cache read is $0.10, the pricing page's figure and the ledger's; the skill's text gives $0.20. Sonnet 5's $0.20 is implied by the skill's saying Sonnet 5.5 has Sonnet 5's prices. Haiku 5.5's higher set, past 100,000 tokens of prompt, is the skill's $0.50 / $2.50 with its cache rates derived from that input rate; no measured response reached it, but on 2026-11-09 (engine 2.1.311) the ledger grew by exactly its sums over a reviewer-only stretch past 100,000 tokens of prompt and one with three compactions.
const TABLE: Readonly<Record<string, Entry>> = {
  'claude-fable-5-1': { boundary: null, standard: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  'claude-fable-5': { boundary: null, standard: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  'claude-opus-5-5': { boundary: null, standard: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  'claude-opus-5': { boundary: null, standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'claude-opus-4-8': { boundary: null, standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'claude-opus-4-7': { boundary: null, standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'claude-opus-4-6': { boundary: null, standard: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'claude-sonnet-5-5': { boundary: null, standard: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
  'claude-sonnet-5': { boundary: null, standard: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  'claude-sonnet-4-6': { boundary: null, standard: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  'claude-haiku-5-5': { boundary: 100_000, standard: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, higher: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  'claude-haiku-4-5': { boundary: null, standard: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
}
const PER_TOKEN = 1_000_000

// The entry a name is priced at, or undefined where it is unpriced. The name is whatever a caller holds: a response's reported model with or without a date suffix, a compaction's model, a choice's id. A name that is not a full id is unpriced: an alias, a partner-prefixed form, the tally's `UNKNOWN_MODEL`.
export const entryOf = (name: string): Entry | undefined => {
  const id = canonicalOf(name)
  return id === undefined ? undefined : TABLE[id]
}

// The dollars one response cost at an entry, judged on its own prompt size.
export const priceOf = (entry: Entry, usage: ModelUsage): number => {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rates = entry.boundary !== null && prompt > entry.boundary ? entry.higher : entry.standard
  return (usage.input_tokens * rates.input + usage.output_tokens * rates.output + usage.cache_read_input_tokens * rates.cacheRead + usage.cache_creation_input_tokens * rates.cacheWrite) / PER_TOKEN
}

// The tally as a percentage of the session total, clamped to 0-100; undefined when the total is unknown, zero or not a number.
export const shareOf = (spent: number, total: number | undefined): number | undefined => {
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined
  return Math.min(100, Math.max(0, (spent / total) * 100))
}

// The label's dollars: whole from $10, to the cent below, `<$0.01` under a cent.
export const wholeOf = (dollars: number): string => {
  const cents = Math.round(dollars * 100)
  if (dollars > 0 && cents < 1) return '<$0.01'
  return cents >= 1000 ? `$${Math.round(cents / 100)}` : `$${(cents / 100).toFixed(2)}`
}

// The popup's dollars: to the cent at every size, `<$0.01` under a cent.
export const centsOf = (dollars: number): string => {
  const cents = Math.round(dollars * 100)
  return dollars > 0 && cents < 1 ? '<$0.01' : `$${(cents / 100).toFixed(2)}`
}

// The share: whole from 1%, one decimal below, `<0.1%` under that.
export const percentOf = (percent: number): string => {
  if (percent < 0.05) return '<0.1%'
  const tenths = Math.round(percent * 10) / 10
  return tenths >= 1 ? `${Math.round(percent)}%` : `${tenths}%`
}
