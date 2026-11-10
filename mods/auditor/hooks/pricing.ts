import type { ModelUsage } from 'claude-code'

// What the auditor's spend costs at API list prices, as pure functions: it knows nothing of the conversation or the engine.

// The one model priced: the reviewer's pin (`REVIEWER_MODEL` in register.ts).
export const PRICED_MODEL = 'claude-haiku-5-5'

// Haiku 5.5 list prices in dollars per million tokens, from the claude-api skill's model table (cached 2026-10-06) and checked on 2026-11-09 (engine 2.1.311) against the session ledger: over a reviewer-only stretch, one past 100,000 tokens of prompt and one with three compactions, the ledger grew by exactly the sum these rates give. The prompt is the uncached input, the cache reads and the cache writes; a response whose prompt is over TIER_PROMPT_TOKENS is priced whole, output included, at the `large` set. Every cache write prices as a 5-minute write: the engine's usage gives one write count with no lifetime split, and the reviewer writes the 5-minute cache.
const RATES = {
  standard: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  large: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
}
export const TIER_PROMPT_TOKENS = 100_000
const PER_TOKEN = 1_000_000

// The pinned id, bare or with a date suffix (`-YYYYMMDD`, `@YYYYMMDD`); an alias, another model or a partner-prefixed form is not priced.
const PRICED_ID = new RegExp(`^${PRICED_MODEL}(?:[-@]\\d{8})?$`)

export const isPriced = (model: string): boolean => PRICED_ID.test(model)

// The dollars one response cost, judged on its own prompt size.
export const priceOf = (usage: ModelUsage): number => {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rates = prompt > TIER_PROMPT_TOKENS ? RATES.large : RATES.standard
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
