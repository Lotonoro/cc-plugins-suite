import { describe, expect, test } from 'claude-code/testing'
import type { MemoryEntry } from '../types/index'
import { ENTRY_CHARS, MAX_AGE, MEMORY, MEMORY_ACTION, MEMORY_CHARS, MEMORY_FIELD, MEMORY_LOG_CHARS, REVIEW_ENDED, WHY_CHARS, bounded, changeMemory, printMemory, renderMemory, withNote } from './memory'

const entry = (number: number, text = `a.ts:${number} note.`): MemoryEntry => ({ number, text })
// A settled entry, touched at `touched`, with the reviewer's reason.
const settledAt = (number: number, touched: number, why = 'the worker showed a.ts:4 rethrows at line 9', text = `a.ts:${number} note.`): MemoryEntry => ({ number, text, kind: 'settled', touched, why })
// An entry whose text is `chars` code points long.
const sized = (number: number, chars: number): MemoryEntry => ({ number, text: 'x'.repeat(chars) })
const points = (text: string): number => Array.from(text).length
// A memory tool call as the reviewer writes it.
const call = (action: unknown, review: unknown, why: unknown) => ({ [MEMORY_FIELD.action]: action, [MEMORY_FIELD.review]: review, [MEMORY_FIELD.why]: why })
const SETTLE = MEMORY_ACTION.settle
const REMOVE = MEMORY_ACTION.remove

describe('the limits', () => {
  test('an entry holds 2,000 characters, an entry survives 30 reviews, the memory holds 12,000 characters, a debug line quotes 180 and a why holds 400', () => {
    expect([ENTRY_CHARS, MAX_AGE, MEMORY_CHARS, MEMORY_LOG_CHARS, WHY_CHARS]).toEqual([2_000, 30, 12_000, 180, 400])
  })
})

describe('the memory tool\'s names', () => {
  test('the tool is the auditor server\'s `memory`, its actions settle and remove, and its fields action, review and why', () => {
    expect(MEMORY).toBe('mcp__auditor__memory')
    expect(MEMORY_ACTION).toEqual({ settle: 'settle', remove: 'remove' })
    expect(MEMORY_FIELD).toEqual({ action: 'action', review: 'review', why: 'why' })
  })
})

describe('withNote', () => {
  test('adds one in-flight entry after the others, holding the body under the review number', () => {
    const memory = [entry(1)]
    expect(withNote(memory, 2, 'b.ts:2 swallows it.')).toEqual([entry(1), entry(2, 'b.ts:2 swallows it.')])
    expect(memory).toEqual([entry(1)])
  })

  test('clips the body to 2,000 code points, naming the count cut, and keeps a body of exactly 2,000', () => {
    expect(withNote([], 1, 'y'.repeat(2_000))).toEqual([entry(1, 'y'.repeat(2_000))])
    expect(withNote([], 1, 'y'.repeat(2_003))).toEqual([entry(1, `${'y'.repeat(2_000)} …+3 characters`)])
  })

  test('counts a character outside the basic plane as one, as clip does', () => {
    expect(withNote([], 1, '😀'.repeat(2_000))[0]?.text).toBe('😀'.repeat(2_000))
  })
})

describe('renderMemory', () => {
  test('an empty memory renders nothing', () => {
    expect(renderMemory([])).toBe('')
  })

  test('a heading that says the notes were delivered to the worker, are the reviewer\'s own memory and are never sent to the worker, then each entry with its kind, both review numbers and its text', () => {
    const rendered = renderMemory([entry(3, 'a.ts:3 first.'), entry(5, 'b.ts:5 second.\nMore.')])
    const [heading = '', ...rest] = rendered.split('\n\n')
    expect(heading).toContain('notes earlier reviews delivered to the worker')
    expect(heading).toContain('your own memory')
    expect(heading).toContain('never sent to the worker')
    expect(rest).toEqual(['Review 3 (in flight, last touched in review 3): a.ts:3 first.', 'Review 5 (in flight, last touched in review 5): b.ts:5 second.\nMore.'])
  })

  test('a settled entry shows its kind, both review numbers and its reason, after every in-flight entry', () => {
    const rendered = renderMemory([settledAt(2, 9, 'the worker showed the retry at line 40'), entry(6, 'c.ts:6 third.'), { ...entry(7, 'd.ts:7 fourth.'), touched: 7 }])
    expect(rendered.split('\n\n').slice(1)).toEqual([
      'Review 6 (in flight, last touched in review 6): c.ts:6 third.',
      'Review 7 (in flight, last touched in review 7): d.ts:7 fourth.',
      'Review 2 (settled, last touched in review 9; the reason: the worker showed the retry at line 40): a.ts:2 note.',
    ])
  })
})

describe('bounded', () => {
  test('drops an entry more than 30 below the new review\'s number and keeps one exactly 30 below', () => {
    const result = bounded([entry(1), entry(2), entry(31)], 32)
    expect(result.memory).toEqual([entry(2), entry(31)])
    expect(result).toMatchObject({ aged: 1, evicted: 0 })
  })

  test('ages an entry by its last touch: a settled entry touched within 30 reviews is kept though its key is older, and one touched more than 30 below is dropped', () => {
    const result = bounded([settledAt(1, 10), settledAt(2, 8), entry(12)], 40)
    expect(result.memory).toEqual([settledAt(1, 10), entry(12)])
    expect(result).toMatchObject({ aged: 1, evicted: 0 })
  })

  test('keeps every entry of a memory within the age and the cap, as the same values', () => {
    const memory = [entry(5), entry(6)]
    expect(bounded(memory, 7)).toEqual({ memory, aged: 0, evicted: 0 })
  })

  test('keeps a memory whose rendering is exactly 12,000 code points, and evicts the oldest entry when it is one over', () => {
    const overhead = points(renderMemory([sized(1, 0), sized(2, 0)]))
    const room = MEMORY_CHARS - overhead
    const atCap = [sized(1, room / 2), sized(2, room / 2)]
    expect(points(renderMemory(atCap))).toBe(MEMORY_CHARS)
    expect(bounded(atCap, 3)).toMatchObject({ aged: 0, evicted: 0 })
    const over = [sized(1, room / 2), sized(2, room / 2 + 1)]
    expect(bounded(over, 3)).toEqual({ memory: [over[1]], aged: 0, evicted: 1 })
  })

  test('evicts in-flight entries oldest-touched first, until the rendering holds at most 12,000 code points', () => {
    const memory = [20, 21, 22, 23, 24, 25, 26, 27].map(n => sized(n, 2_000))
    const result = bounded(memory, 28)
    expect(result.memory.map(e => e.number)).toEqual([23, 24, 25, 26, 27])
    expect(result.evicted).toBe(3)
    expect(points(renderMemory(result.memory))).toBeLessThanOrEqual(MEMORY_CHARS)
  })

  test('evicts the oldest-touched first even when the list is not in order, and only as many as the cap needs', () => {
    const memory = [sized(25, 2_000), sized(21, 2_000), sized(24, 2_000), sized(22, 2_000), sized(26, 2_000), sized(23, 2_000)]
    expect(bounded(memory, 27).memory.map(e => e.number)).toEqual([25, 24, 22, 26, 23])
  })

  test('evicts settled entries before in-flight ones, oldest-touched first, whatever their keys', () => {
    const big = (number: number, touched?: number): MemoryEntry => (touched === undefined ? sized(number, 2_000) : { ...sized(number, 2_000), kind: 'settled', touched, why: 'held' })
    // Two settled entries, the older-keyed touched last, and four in flight older than both touches.
    const memory = [big(20, 27), big(21, 26), big(22), big(23), big(24), big(25)]
    const result = bounded(memory, 28)
    expect(result.memory.map(e => e.number)).toEqual([20, 22, 23, 24, 25])
    expect(result.evicted).toBe(1)
    const more = bounded([...memory, big(26), big(27)], 28)
    expect(more.memory.map(e => e.number)).toEqual([23, 24, 25, 26, 27])
    expect(more.evicted).toBe(3)
  })

  test('ages out before it caps, and counts each drop under its own reason', () => {
    const memory = [sized(1, 2_000), sized(2, 2_000), ...[20, 21, 22, 23, 24, 25, 26, 27].map(n => sized(n, 2_000))]
    const result = bounded(memory, 33)
    expect(result).toMatchObject({ aged: 2, evicted: 3 })
    expect(result.memory.map(e => e.number)).toEqual([23, 24, 25, 26, 27])
  })

  test('leaves the memory it was given as it was', () => {
    const memory = [entry(1), entry(40)]
    bounded(memory, 41)
    expect(memory).toEqual([entry(1), entry(40)])
  })

  test('terminates on a memory that no longer fits: it ends empty', () => {
    expect(bounded([sized(1, 20_000)], 2)).toEqual({ memory: [], aged: 0, evicted: 1 })
  })
})

describe('changeMemory', () => {
  const memory = [entry(3, 'a.ts:3 first.'), settledAt(5, 6, 'the worker showed the guard at b.ts:12')]
  // The refusal a call gets against `memory` while review 9 is open.
  const refusalOf = (input: ReturnType<typeof call>): string => {
    const changed = changeMemory(memory, 9, input)
    expect('refusal' in changed).toBe(true)
    return 'refusal' in changed ? changed.refusal : ''
  }

  test('settle turns an in-flight entry settled with its reason, touched at the open review, and answers with its review number and new state', () => {
    const changed = changeMemory(memory, 9, call(SETTLE, 3, 'the worker countered at transcript line 88: the cache is per request'))
    expect(changed).toEqual({
      memory: [settledAt(3, 9, 'the worker countered at transcript line 88: the cache is per request', 'a.ts:3 first.'), memory[1]],
      answer: "Review 3's entry is now settled, with the reason: the worker countered at transcript line 88: the cache is per request",
      logged: 'memory entry for review 3 settled: the worker countered at transcript line 88: the cache is per request',
    })
  })

  test('settling a settled entry again replaces its reason and moves its last touch to the open review', () => {
    const changed = changeMemory(memory, 9, call(SETTLE, 5, 'met again; the counter at transcript line 40 still holds'))
    expect('memory' in changed && changed.memory).toEqual([memory[0], settledAt(5, 9, 'met again; the counter at transcript line 40 still holds')])
    expect('memory' in changed && bounded(changed.memory, 39).memory.map(e => e.number)).toEqual([5])
  })

  test('remove takes an entry of either kind out, and answers with its review number and that it is removed', () => {
    expect(changeMemory(memory, 9, call(REMOVE, 3, 'fixed: a.ts:3 now rethrows, read at line 14'))).toEqual({
      memory: [memory[1]],
      answer: "Review 3's entry is removed.",
      logged: 'memory entry for review 3 removed: a.ts:3 first.; why: fixed: a.ts:3 now rethrows, read at line 14',
    })
    expect(changeMemory(memory, 9, call(REMOVE, 5, 'new evidence: the test at c.test.ts:30 fails'))).toMatchObject({ memory: [memory[0]], answer: "Review 5's entry is removed." })
  })

  test('the debug line clips the why and the removed text to 180 characters each', () => {
    const long = [entry(3, 't'.repeat(300))]
    const settled = changeMemory(long, 9, call(SETTLE, 3, 'w'.repeat(400)))
    expect('logged' in settled && settled.logged).toBe(`memory entry for review 3 settled: ${'w'.repeat(180)} …+220 characters`)
    const removed = changeMemory(long, 9, call(REMOVE, 3, 'w'.repeat(200)))
    expect('logged' in removed && removed.logged).toBe(`memory entry for review 3 removed: ${'t'.repeat(180)} …+120 characters; why: ${'w'.repeat(180)} …+20 characters`)
  })

  test('refuses with no open review', () => {
    expect(changeMemory(memory, undefined, call(SETTLE, 3, 'ok'))).toEqual({ refusal: 'auditor has no review in progress for this reviewer, so the memory was not changed' })
  })

  test('refuses an unknown or missing action', () => {
    for (const action of ['reopen', undefined, 3]) expect(refusalOf(call(action, 3, 'ok'))).toBe('action must be settle or remove, so the memory was not changed')
  })

  test('refuses a missing, non-integer or unknown review number', () => {
    expect(refusalOf(call(SETTLE, undefined, 'ok'))).toBe('review is missing: give the review number of the entry to change, so the memory was not changed')
    for (const review of ['3', 3.5, Number.NaN, null]) expect(refusalOf(call(SETTLE, review, 'ok'))).toBe('review must be a whole review number, so the memory was not changed')
    expect(refusalOf(call(REMOVE, 4, 'ok'))).toBe('the memory holds no entry for review 4, so it was not changed')
  })

  test('refuses a missing or blank why, and one over 400 characters, and takes one of exactly 400', () => {
    for (const why of [undefined, '', '  \n ', 7]) expect(refusalOf(call(SETTLE, 3, why))).toBe('why is missing or blank, so the memory was not changed')
    expect(refusalOf(call(SETTLE, 3, 'w'.repeat(401)))).toBe('why is 401 characters, over the 400 allowed, so the memory was not changed')
    expect('memory' in changeMemory(memory, 9, call(SETTLE, 3, '😀'.repeat(400)))).toBe(true)
  })

  test('refuses a settle of the open review\'s own entry, which the worker has not answered, and leaves the memory as it was; a remove of that entry is accepted', () => {
    const own = [entry(9, 'a.ts:9 note.'), settledAt(5, 6, 'the worker showed the guard at b.ts:12')]
    const before = structuredClone(own)
    expect(changeMemory(own, 9, call(SETTLE, 9, 'countered at transcript line 3'))).toEqual({ refusal: "review 9 is this review's own entry, which the worker has not answered yet, and a settle needs the worker's counter, so the memory was not changed" })
    expect(own).toEqual(before)
    expect(changeMemory(own, 9, call(REMOVE, 9, 'fixed: a.ts:9 now rethrows, read at line 14'))).toEqual({
      memory: [own[1]],
      answer: "Review 9's entry is removed.",
      logged: 'memory entry for review 9 removed: a.ts:9 note.; why: fixed: a.ts:9 now rethrows, read at line 14',
    })
  })

  test('leaves the memory it was given as it was', () => {
    const before = structuredClone(memory)
    changeMemory(memory, 9, call(SETTLE, 3, 'ok'))
    changeMemory(memory, 9, call(REMOVE, 5, 'ok'))
    expect(memory).toEqual(before)
  })

  test('the review-ended text says the memory was not changed and to end the turn', () => {
    expect(REVIEW_ENDED).toBe("auditor's review ended before this change, so the memory was not changed; end your turn")
  })
})

describe('a memory stored before kinds', () => {
  test('reads every entry as in flight and touched at its key: it renders so, ages by its key, and settles', () => {
    const old = [entry(2), entry(4)]
    expect(renderMemory(old)).toContain('Review 2 (in flight, last touched in review 2): a.ts:2 note.')
    expect(bounded(old, 33).memory).toEqual([entry(4)])
    expect(changeMemory(old, 5, call(SETTLE, 2, 'ok'))).toMatchObject({ memory: [settledAt(2, 5, 'ok'), entry(4)] })
  })
})

describe('printMemory', () => {
  test('says the memory is empty when it is', () => {
    expect(printMemory([])).toBe('auditor memory is empty')
  })

  test('opens with the entry count by kind, then states each entry with its kind, both review numbers and a settled one\'s reason, in-flight entries first', () => {
    expect(printMemory([entry(3, 'a.ts:3 first.')])).toBe('auditor memory holds 1 entry, 1 in flight and 0 settled:\n\nReview 3 (in flight, last touched in review 3): a.ts:3 first.')
    expect(printMemory([settledAt(2, 4, 'countered at line 7', 'z.ts:2 zero.'), entry(3, 'a.ts:3 first.'), entry(5, 'b.ts:5 second.')])).toBe(
      'auditor memory holds 3 entries, 2 in flight and 1 settled:\n\nReview 3 (in flight, last touched in review 3): a.ts:3 first.\n\nReview 5 (in flight, last touched in review 5): b.ts:5 second.\n\nReview 2 (settled, last touched in review 4; the reason: countered at line 7): z.ts:2 zero.',
    )
  })
})
