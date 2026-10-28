import { describe, expect, test } from 'claude-code/testing'
import { PRICES, type Rates } from './prices'
import {
  dueAtMs,
  failedOf,
  isDue,
  landedOf,
  pricesOf,
  recordOf,
  stampedOf,
  type ModelPrice,
  type PriceRecord,
} from './pricelist'

const HOUR = 3600000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const T = Date.parse('2026-10-18T10:00:00.000Z')

const rates = (input: number, read = input / 10): Rates => ({ input, read, write5m: input * 1.25, write1h: input * 2, above: null })
const R1 = rates(4e-6, 0.2e-6)
const R2 = rates(8e-6, 0.4e-6)
const model = (r: Rates, changedMs: number | null = null, missingSinceMs: number | null = null): ModelPrice => ({ rates: r, changedMs, missingSinceMs })
const record = (models: Record<string, ModelPrice> = {}, o: Partial<PriceRecord> = {}): PriceRecord => ({
  models,
  lastSuccessMs: null,
  lastChangeMs: null,
  attempt: null,
  ...o,
})
const page = (id: string, r: Rates) => ({ [id]: r })

describe('the shared price record: what a read changes', () => {
  test('a known model at new rates takes the read as its change date; the same rates leave it', () => {
    const held = record({ m: model(R1, T - WEEK) })
    const changed = landedOf(held, page('m', R2), T, T)
    expect(changed.models.m!.changedMs).toBe(T)
    expect(changed.lastChangeMs).toBe(T)
    const same = landedOf(changed, page('m', R2), T + DAY, T + DAY)
    expect(same.models.m!.changedMs).toBe(T)
    expect(same.lastChangeMs).toBe(T)
  })

  test('the first read ever, and a model new to the page, record no change date', () => {
    const first = landedOf(null, page('m', R1), T, T)
    expect(first.models.m!.changedMs).toBeNull()
    const more = landedOf(first, page('n', R2), T + DAY, T + DAY)
    expect(more.models.n!.changedMs).toBeNull()
    expect(more.lastChangeMs).toBeNull()
  })

  test('a model the read drops keeps its rates and is marked missing; a later read lists it and clears the mark', () => {
    const held = landedOf(null, page('m', R1), T, T)
    const dropped = landedOf(held, {}, T + DAY, T + DAY)
    expect(dropped.models.m).toEqual({ rates: R1, changedMs: null, missingSinceMs: T + DAY })
    const back = landedOf(dropped, page('m', R1), T + WEEK, T + WEEK)
    expect(back.models.m).toEqual({ rates: R1, changedMs: null, missingSinceMs: null })
  })

  test('the newest success and the last change advance to each read that lands', () => {
    const next = landedOf(record({ m: model(R1) }, { lastSuccessMs: T }), page('m', R2), T + WEEK, T + WEEK)
    expect(next.lastSuccessMs).toBe(T + WEEK)
    expect(next.lastChangeMs).toBe(T + WEEK)
  })

  test('a stamp keeps the list as it read it and the previous outcome and failure count as history', () => {
    const held = record({ m: model(R1) }, { lastSuccessMs: T - WEEK, attempt: { stampMs: T - HOUR, outcome: 'unreachable', failures: 2, previous: 'success' } })
    const stamped = stampedOf(held, T)
    expect(stamped.models).toEqual(held.models)
    expect(stamped.attempt).toEqual({ stampMs: T, outcome: null, failures: 2, previous: 'unreachable' })
  })

  test('a stamp newer than this write is kept', () => {
    const held = record({}, { attempt: { stampMs: T + 1, outcome: null, failures: 0, previous: 'success' } })
    expect(stampedOf(held, T)).toEqual(held)
  })

  test('a read landing after a newer stamp keeps that stamp and still advances the newest success', () => {
    const held = record({ m: model(R1) }, {
      lastSuccessMs: T - WEEK,
      attempt: { stampMs: T + 5, outcome: null, failures: 0, previous: 'success' },
    })
    const landed = landedOf(held, page('m', R2), T + 10, T)
    expect(landed.attempt).toEqual(held.attempt)
    expect(landed.lastSuccessMs).toBe(T + 10)
    expect(landed.models.m!.rates).toEqual(R2)
  })

  test('a failed outcome records its kind and one more failure in the row, keeping the stamp', () => {
    const held = record({}, { lastSuccessMs: T, attempt: { stampMs: T + WEEK, outcome: null, failures: 1, previous: 'unreachable' } })
    expect(failedOf(held, 'unreachable', T + WEEK).attempt).toEqual({
      stampMs: T + WEEK,
      outcome: 'unreachable',
      failures: 2,
      previous: 'unreachable',
    })
  })
})

describe('the prices in force', () => {
  test('the built-in table prices a model only it lists, and a stored model its stored rates', () => {
    const list = pricesOf(record({ 'claude-opus-5-5': model(R2) }))
    expect(list['claude-opus-5-5']).toEqual(R2)
    expect(list['claude-haiku-4-5']).toEqual(PRICES['claude-haiku-4-5'])
  })

  test('a model the newest read dropped keeps its stored rates in force', () => {
    const held = landedOf(null, page('m', R1), T, T)
    const dropped = landedOf(held, {}, T + DAY, T + DAY)
    expect(pricesOf(dropped).m).toEqual(R1)
  })
})

describe('a stored value read by its structure, with no version', () => {
  test('anything that is not a record, or has no models, counts as no record', () => {
    expect(recordOf(undefined)).toBeNull()
    expect(recordOf(null)).toBeNull()
    expect(recordOf('record')).toBeNull()
    expect(recordOf([])).toBeNull()
    expect(recordOf({ lastSuccessMs: T })).toBeNull()
  })

  test('a model entry of another shape is skipped and the others are kept', () => {
    const held = {
      models: {
        good: model(R1),
        bad: { rates: { input: 1 }, changedMs: null, missingSinceMs: null },
        worse: 'no',
      },
      lastSuccessMs: T,
      lastChangeMs: T - DAY,
      attempt: null,
    }
    expect(recordOf(held)).toEqual(record({ good: model(R1) }, { lastSuccessMs: T, lastChangeMs: T - DAY }))
    expect(pricesOf(recordOf(held)).good).toEqual(R1)
  })

  test('an attempt of another shape counts as no attempt', () => {
    const held = { models: {}, lastSuccessMs: T, lastChangeMs: null, attempt: { stampMs: 'now', outcome: null } }
    expect(recordOf(held)!.attempt).toBeNull()
    expect(recordOf(held)!.lastSuccessMs).toBe(T)
  })

  test('a value that is not a record is replaced by the next successful read', () => {
    const next = landedOf(recordOf({ nonsense: true }), page('m', R1), T, T)
    expect(next.models.m).toEqual(model(R1))
    expect(next.lastSuccessMs).toBe(T)
  })
})

describe('when a read is due', () => {
  test('no record, or no success yet, is due at once', () => {
    expect(dueAtMs(null)).toBe(0)
    expect(isDue(null, T)).toBe(true)
    expect(isDue(record(), T)).toBe(true)
  })

  test('a success is due seven days later, not at six', () => {
    const held = record({}, { lastSuccessMs: T })
    expect(isDue(held, T + 6 * DAY)).toBe(false)
    expect(isDue(held, T + 7 * DAY)).toBe(true)
  })

  test('an unreachable failure waits an hour, then a day after each later one in the row', () => {
    const at = T + WEEK
    const failed = (failures: number) => record({}, {
      lastSuccessMs: T,
      attempt: { stampMs: at, outcome: 'unreachable', failures, previous: 'unreachable' },
    })
    expect(dueAtMs(failed(1))).toBe(at + HOUR)
    expect(dueAtMs(failed(2))).toBe(at + DAY)
    expect(dueAtMs(failed(3))).toBe(at + DAY)
  })

  test('a format failure waits for the weekly beat after it, counted from the last success', () => {
    const held = record({}, {
      lastSuccessMs: T,
      attempt: { stampMs: T + 9 * DAY, outcome: 'format', failures: 1, previous: 'success' },
    })
    expect(dueAtMs(held)).toBe(T + 14 * DAY)
  })

  test('a format failure with no success ever waits seven days from the failure', () => {
    const held = record({}, { attempt: { stampMs: T, outcome: 'format', failures: 1, previous: null } })
    expect(dueAtMs(held)).toBe(T + WEEK)
  })

  test('a stamp with no outcome is a pending unreachable failure, one hour after the stamp', () => {
    const held = record({}, {
      lastSuccessMs: T - WEEK,
      attempt: { stampMs: T, outcome: null, failures: 0, previous: 'success' },
    })
    expect(dueAtMs(held)).toBe(T + HOUR)
  })

  test('after two unreachable failures, a stamp with no outcome counts as the third and waits a day from the stamp', () => {
    const held = record({}, {
      lastSuccessMs: T - WEEK,
      attempt: { stampMs: T, outcome: null, failures: 2, previous: 'unreachable' },
    })
    expect(dueAtMs(held)).toBe(T + DAY)
  })

  test('after a format failure, a stamp with no outcome leaves the weekly beat from the last success', () => {
    const held = record({}, {
      lastSuccessMs: T,
      attempt: { stampMs: T + 9 * DAY, outcome: null, failures: 1, previous: 'format' },
    })
    expect(dueAtMs(held)).toBe(T + 14 * DAY)
  })

  test('an attempt stamped before the newest success is history and counts for nothing', () => {
    const held = record({}, {
      lastSuccessMs: T,
      attempt: { stampMs: T - DAY, outcome: 'unreachable', failures: 2, previous: 'unreachable' },
    })
    expect(dueAtMs(held)).toBe(T + WEEK)
  })
})
