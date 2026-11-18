import { describe, expect, test } from 'claude-code/testing'
import type { Conversation } from '../types/index'
import { PRICED_MODEL, priceOf } from './pricing'
import { UNKNOWN_MODEL, purged, withNoteGiven, withReviewDone, withCompaction, withResponse } from './tally'

// A conversation holding only what the tally reads.
const conversation = (over: Partial<Conversation> = {}): Conversation => ({ off: false, spent: 0, unpriced: null, reviews: 0, notes: 0, ...over }) as unknown as Conversation
const response = (over: Partial<Parameters<typeof withResponse>[1]> = {}): Parameters<typeof withResponse>[1] => ({ input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 5_000, model: PRICED_MODEL, ...over })

// Whether two dollar figures agree to a billionth: the kit's expect has no toBeCloseTo.
const closeTo = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9

describe('withResponse', () => {
  test('a response adds its price at the constants, output included', () => {
    const r = response()
    expect(closeTo(withResponse(conversation(), r).spent, priceOf(r))).toBe(true)
  })

  test('responses sum, each priced alone', () => {
    const a = response()
    const b = response({ input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 200 })
    expect(closeTo(withResponse(withResponse(conversation(), a), b).spent, priceOf(a) + priceOf(b))).toBe(true)
  })

  test('a response over the tier prices whole at the higher rates, and one under it with a large output does not', () => {
    const over = response({ cache_read_input_tokens: 100_000, output_tokens: 1_000 })
    const under = response({ cache_read_input_tokens: 99_000, output_tokens: 90_000, input_tokens: 10, cache_creation_input_tokens: 0 })
    expect(closeTo(withResponse(conversation(), over).spent, (10 * 0.5 + 100_000 * 0.05 + 1_000 * 2.5 + 5_000 * 0.625) / 1_000_000)).toBe(true)
    expect(closeTo(withResponse(conversation(), under).spent, (10 * 0.1 + 99_000 * 0.01 + 90_000 * 0.5) / 1_000_000)).toBe(true)
  })

  test('a response with a missing count adds nothing, and the tally stays a number', () => {
    const broken = response({ cache_read_input_tokens: undefined as unknown as number })
    const after = withResponse(withResponse(conversation(), response()), broken)
    expect(closeTo(after.spent, priceOf(response()))).toBe(true)
    expect(withResponse(after, response()).unpriced).toBe(null)
  })

  test('a response reporting the pinned id with a date suffix is priced as the pinned model', () => {
    const r = response({ model: `${PRICED_MODEL}-20261001` })
    expect(withResponse(conversation(), r)).toMatchObject({ unpriced: null })
    expect(closeTo(withResponse(conversation(), r).spent, priceOf(r))).toBe(true)
  })

  test('a response reporting any other id leaves the cost unknown, naming the model, and later responses do not make it known again', () => {
    const odd = withResponse(conversation({ spent: 0.5 }), response({ model: 'haiku' }))
    expect(odd.unpriced).toBe('haiku')
    const later = withResponse(odd, response())
    expect(later.unpriced).toBe('haiku')
    expect(later.spent).toBe(odd.spent)
  })

  test('a response landing while the auditor is off adds nothing', () => {
    const off = conversation({ off: true })
    expect(withResponse(off, response())).toBe(off)
    expect(withResponse(off, response({ model: 'haiku' }))).toBe(off)
  })
})

describe('withCompaction', () => {
  const counts = { input_tokens: 1000, output_tokens: 800, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000 }

  test('a compaction with usage adds it, priced at the model its caller names', () => {
    expect(closeTo(withCompaction(conversation(), counts, PRICED_MODEL).spent, priceOf(counts))).toBe(true)
  })

  test('the model is the caller\'s, whatever the conversation\'s reviewer is', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' } })
    expect(withCompaction(c, counts, PRICED_MODEL).unpriced).toBe(null)
  })

  test('a model that is not priced leaves the cost unknown, naming it', () => {
    expect(withCompaction(conversation(), counts, 'claude-opus-4-6')).toMatchObject({ spent: 0, unpriced: 'claude-opus-4-6' })
  })

  test('no model at all leaves the cost unknown for a named model, not a blank', () => {
    for (const none of [undefined, '']) {
      const after = withCompaction(conversation(), counts, none)
      expect(after).toMatchObject({ spent: 0, unpriced: UNKNOWN_MODEL })
      expect(UNKNOWN_MODEL).not.toBe('')
    }
  })

  test('a compaction without usage leaves the conversation unchanged', () => {
    const c = conversation({ spent: 0.25 })
    expect(withCompaction(c, undefined, PRICED_MODEL)).toBe(c)
  })

  test('a compaction landing while the auditor is off adds nothing', () => {
    const off = conversation({ off: true })
    expect(withCompaction(off, counts, PRICED_MODEL)).toBe(off)
  })
})

describe('purged', () => {
  test('empties the tally and forgets the model that made it unknown', () => {
    expect(purged(conversation({ spent: 3, unpriced: 'haiku' }))).toMatchObject({ spent: 0, unpriced: null })
  })

  test('empties the review counters and the last review', () => {
    const after = purged(conversation({ reviews: 4, notes: 2, last: { at: 5, note: true } }))
    expect(after).toMatchObject({ reviews: 0, notes: 0 })
    expect(after.last).toBeUndefined()
  })
})

describe('withReviewDone', () => {
  test('a completed review adds one and becomes the last review, with the time it closed and whether it gave a note', () => {
    const one = withReviewDone(conversation(), 100, false)
    expect(one).toMatchObject({ reviews: 1, last: { at: 100, note: false } })
    expect(withReviewDone(one, 200, true)).toMatchObject({ reviews: 2, last: { at: 200, note: true } })
  })

  test('a review closing while the auditor is off adds nothing', () => {
    const off = conversation({ off: true })
    expect(withReviewDone(off, 100, true)).toBe(off)
  })
})

describe('withNoteGiven', () => {
  test('a note adds one to the notes given', () => {
    expect(withNoteGiven(withNoteGiven(conversation())).notes).toBe(2)
  })

  test('a note booked while the auditor is off adds nothing', () => {
    const off = conversation({ off: true })
    expect(withNoteGiven(off)).toBe(off)
  })
})
