// The shared price record: the rates a page read last supplied for each model, when each last changed, what the newest
// read dropped, the newest success, and the last attempt. Pure: the store and the page are `pricesync.ts`'s.
import type { Kinds } from '../types'
import { PRICES, type PriceList, type Rates } from './prices'

// The store key, outside the pause history's `pauses/` prefix, so its trim never reads or deletes the record.
export const PRICE_KEY = 'prices'

// How a read ended. A stamp holds no outcome while its read is in flight.
export type PriceOutcome = 'success' | 'unreachable' | 'format'

// The last attempt at a read, and the outcome before it. A pending attempt's `previous` is the last completed outcome.
export type PriceAttempt = {
  stampMs: number
  outcome: PriceOutcome | null
  failures: number
  previous: PriceOutcome | null
}

// One model's rates, the first read that saw them change, and the first read that dropped it since.
export type ModelPrice = { rates: Rates; changedMs: number | null; missingSinceMs: number | null }

export type PriceRecord = {
  models: Record<string, ModelPrice>
  lastSuccessMs: number | null
  lastChangeMs: number | null
  attempt: PriceAttempt | null
}

export const EMPTY_RECORD: PriceRecord = { models: {}, lastSuccessMs: null, lastChangeMs: null, attempt: null }

const HOUR = 3600000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isKinds = (v: unknown): v is Kinds =>
  isObject(v) &&
  ['input', 'read', 'write5m', 'write1h'].every((k) => isNumber(v[k]) && (v[k] as number) >= 0)

const isRates = (v: unknown): v is Rates => {
  if (!isKinds(v)) return false
  const above = (v as Record<string, unknown>).above
  if (above === null) return true
  return isKinds(above) && isNumber((above as unknown as { threshold: unknown }).threshold) && (above as unknown as { threshold: number }).threshold >= 0
}

const isModelPrice = (v: unknown): v is ModelPrice =>
  isObject(v) &&
  isRates(v.rates) &&
  (v.changedMs === null || isNumber(v.changedMs)) &&
  (v.missingSinceMs === null || isNumber(v.missingSinceMs))

const isOutcome = (v: unknown): v is PriceOutcome => v === 'success' || v === 'unreachable' || v === 'format'

const isAttempt = (v: unknown): v is PriceAttempt =>
  isObject(v) &&
  isNumber(v.stampMs) &&
  (v.outcome === null || isOutcome(v.outcome)) &&
  isNumber(v.failures) &&
  v.failures >= 0 &&
  (v.previous === null || isOutcome(v.previous))

// A stored value as its structure says it is. A value that is not a record is none; a model entry or an attempt of
// another shape is skipped, and the rest stand. Extra fields, from a newer read, are ignored.
export const recordOf = (held: unknown): PriceRecord | null => {
  if (!isObject(held) || !isObject(held.models)) return null
  const models: Record<string, ModelPrice> = {}
  for (const [id, entry] of Object.entries(held.models)) {
    if (isModelPrice(entry)) models[id] = { rates: entry.rates, changedMs: entry.changedMs, missingSinceMs: entry.missingSinceMs }
  }
  return {
    models,
    lastSuccessMs: isNumber(held.lastSuccessMs) ? held.lastSuccessMs : null,
    lastChangeMs: isNumber(held.lastChangeMs) ? held.lastChangeMs : null,
    attempt: isAttempt(held.attempt) ? held.attempt : null,
  }
}

const sameKinds = (a: Kinds, b: Kinds): boolean =>
  a.input === b.input && a.read === b.read && a.write5m === b.write5m && a.write1h === b.write1h

const sameRates = (a: Rates, b: Rates): boolean =>
  sameKinds(a, b) &&
  (a.above === null
    ? b.above === null
    : b.above !== null && a.above.threshold === b.above.threshold && sameKinds(a.above, b.above))

// The last completed outcome before this attempt: a pending attempt carries its own history.
const historyOf = (attempt: PriceAttempt | null): PriceOutcome | null =>
  attempt === null ? null : attempt.outcome ?? attempt.previous

// A stamp for a read about to start: the list as the fresh read gave it, the previous outcome and failure count kept as
// history. A stamp newer than this write stands.
export const stampedOf = (held: PriceRecord | null, stampMs: number): PriceRecord => {
  const base = held ?? EMPTY_RECORD
  if (base.attempt !== null && base.attempt.stampMs > stampMs) return base
  return {
    ...base,
    attempt: {
      stampMs,
      outcome: null,
      failures: base.attempt?.failures ?? 0,
      previous: historyOf(base.attempt),
    },
  }
}

// A page read merged onto the record as it is stored now, and its success stamped. Rates that differ set the model's
// change date; a first sighting does not. A model the page dropped keeps its rates and is marked missing. A newer stamp
// still stands, and the success still advances.
export const landedOf = (held: PriceRecord | null, page: PriceList, readMs: number, stampMs: number): PriceRecord => {
  const base = held ?? EMPTY_RECORD
  const models: Record<string, ModelPrice> = {}
  for (const [id, model] of Object.entries(base.models)) models[id] = { ...model }
  let changed = false
  for (const [id, rates] of Object.entries(page)) {
    const before = base.models[id]
    if (before === undefined) models[id] = { rates, changedMs: null, missingSinceMs: null }
    else if (sameRates(before.rates, rates)) models[id] = { rates: before.rates, changedMs: before.changedMs, missingSinceMs: null }
    else {
      models[id] = { rates, changedMs: readMs, missingSinceMs: null }
      changed = true
    }
  }
  for (const [id, model] of Object.entries(base.models)) {
    if (!(id in page)) models[id] = { ...model, missingSinceMs: model.missingSinceMs ?? readMs }
  }
  const newer = base.attempt !== null && base.attempt.stampMs > stampMs
  return {
    models,
    lastSuccessMs: base.lastSuccessMs === null ? readMs : Math.max(base.lastSuccessMs, readMs),
    lastChangeMs: changed ? readMs : base.lastChangeMs,
    attempt: newer
      ? base.attempt
      : { stampMs, outcome: 'success', failures: 0, previous: historyOf(base.attempt) },
  }
}

// A read that ended without a list: its outcome and one more failure in the row. A newer stamp than this write stands.
export const failedOf = (
  held: PriceRecord | null,
  outcome: Exclude<PriceOutcome, 'success'>,
  stampMs: number,
): PriceRecord => {
  const base = held ?? EMPTY_RECORD
  if (base.attempt !== null && base.attempt.stampMs > stampMs) return base
  return {
    ...base,
    attempt: { stampMs, outcome, failures: (base.attempt?.failures ?? 0) + 1, previous: historyOf(base.attempt) },
  }
}

// The first weekly mark after a format failure, counted from the newest success: 7 days after the failure when none ever
// landed.
const weeklyAfter = (successMs: number | null, failureMs: number): number => {
  if (successMs === null) return failureMs + WEEK
  return successMs + (Math.floor((failureMs - successMs) / WEEK) + 1) * WEEK
}

// When the next read is due. Only the newest success and attempts stamped after it count. A pending stamp is the next
// unreachable failure, unless the last failure was a format one, whose weekly beat still governs.
export const dueAtMs = (record: PriceRecord | null): number => {
  const successMs = record?.lastSuccessMs ?? null
  const attempt = record?.attempt ?? null
  if (attempt !== null && (successMs === null || attempt.stampMs > successMs)) {
    if (attempt.outcome === null) {
      if (attempt.previous === 'format') return weeklyAfter(successMs, attempt.stampMs)
      return attempt.stampMs + (attempt.failures + 1 >= 2 ? DAY : HOUR)
    }
    if (attempt.outcome === 'unreachable') return attempt.stampMs + (attempt.failures >= 2 ? DAY : HOUR)
    if (attempt.outcome === 'format') return weeklyAfter(successMs, attempt.stampMs)
  }
  return successMs === null ? 0 : successMs + WEEK
}

export const isDue = (record: PriceRecord | null, nowMs: number): boolean => nowMs >= dueAtMs(record)

// The prices in force in every session: the built-in table with the stored rates over it, a model the page dropped
// included, at the rates the read last gave it.
export const pricesOf = (record: PriceRecord | null): PriceList => {
  const list: PriceList = { ...PRICES }
  if (record !== null) for (const [id, model] of Object.entries(record.models)) list[id] = model.rates
  return list
}
