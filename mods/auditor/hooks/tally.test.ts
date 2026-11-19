import type { ModelUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Conversation } from '../types/index'
import { UNKNOWN_MODEL, purged, withNoteGiven, withReviewDone, withCompaction, withResponse } from './tally'

const HAIKU_5_5 = 'claude-haiku-5-5'
const OPUS_4_6 = 'claude-opus-4-6'

// List prices in dollars per million tokens: input, output, cache read, cache write.
const HAIKU_RATES = [0.1, 0.5, 0.01, 0.125] as const
const OPUS_RATES = [5, 25, 0.5, 6.25] as const

// What a response costs by hand, at a model's list prices.
const worth = (usage: ModelUsage, [input, output, read, write]: readonly [number, number, number, number]): number =>
  (usage.input_tokens * input + usage.output_tokens * output + usage.cache_read_input_tokens * read + usage.cache_creation_input_tokens * write) / 1_000_000

// A conversation holding only what the tally reads.
const conversation = (over: Partial<Conversation> = {}): Conversation => ({ off: false, spent: 0, unpriced: null, reviews: 0, notes: 0, ...over }) as unknown as Conversation
const response = (over: Partial<Parameters<typeof withResponse>[1]> = {}): Parameters<typeof withResponse>[1] => ({ input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 5_000, model: HAIKU_5_5, ...over })

// Whether two dollar figures agree to a billionth: the kit's expect has no toBeCloseTo.
const closeTo = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9

describe('withResponse', () => {
  test('a response adds its price at its model\'s rates, each token kind at its own, output included', () => {
    const r = response()
    expect(closeTo(withResponse(conversation(), r).spent, worth(r, HAIKU_RATES))).toBe(true)
  })

  test('responses sum, each priced alone', () => {
    const a = response()
    const b = response({ input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 200 })
    expect(closeTo(withResponse(withResponse(conversation(), a), b).spent, worth(a, HAIKU_RATES) + worth(b, HAIKU_RATES))).toBe(true)
  })

  test('two responses on two priced models add up at each model\'s own rates', () => {
    const haiku = response()
    const opus = response({ model: OPUS_4_6, input_tokens: 3, output_tokens: 13, cache_read_input_tokens: 18_921, cache_creation_input_tokens: 154 })
    const after = withResponse(withResponse(conversation(), haiku), opus)
    expect(after.unpriced).toBe(null)
    expect(closeTo(after.spent, worth(haiku, HAIKU_RATES) + worth(opus, OPUS_RATES))).toBe(true)
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
    expect(closeTo(after.spent, worth(response(), HAIKU_RATES))).toBe(true)
    expect(withResponse(after, response()).unpriced).toBe(null)
  })

  test('a response reporting Haiku 5.5 with a date suffix is priced as Haiku 5.5', () => {
    const r = response({ model: `${HAIKU_5_5}-20261001` })
    expect(withResponse(conversation(), r)).toMatchObject({ unpriced: null })
    expect(closeTo(withResponse(conversation(), r).spent, worth(r, HAIKU_RATES))).toBe(true)
  })

  test('a response reporting any other name, an id outside the table or an alias, leaves the cost unknown, naming it, and later responses do not make it known again', () => {
    for (const name of ['claude-unpriced-1-1', 'haiku']) {
      const odd = withResponse(conversation({ spent: 0.5 }), response({ model: name }))
      expect(odd).toMatchObject({ spent: 0.5, unpriced: name })
      const later = withResponse(odd, response())
      expect(later.unpriced).toBe(name)
      expect(later.spent).toBe(odd.spent)
    }
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
    expect(closeTo(withCompaction(conversation(), counts, HAIKU_5_5).spent, worth(counts, HAIKU_RATES))).toBe(true)
    expect(closeTo(withCompaction(conversation(), counts, OPUS_4_6).spent, worth(counts, OPUS_RATES))).toBe(true)
  })

  test('the model is the caller\'s, whatever the conversation\'s reviewer is', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' } })
    expect(withCompaction(c, counts, HAIKU_5_5).unpriced).toBe(null)
  })

  test('a model that is not priced leaves the cost unknown, naming it', () => {
    expect(withCompaction(conversation(), counts, 'claude-unpriced-1-1')).toMatchObject({ spent: 0, unpriced: 'claude-unpriced-1-1' })
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
    expect(withCompaction(c, undefined, HAIKU_5_5)).toBe(c)
  })

  test('a compaction landing while the auditor is off adds nothing', () => {
    const off = conversation({ off: true })
    expect(withCompaction(off, counts, HAIKU_5_5)).toBe(off)
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
