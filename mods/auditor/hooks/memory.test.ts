import { describe, expect, test } from 'claude-code/testing'
import type { MemoryEntry } from '../types/index'
import { ENTRY_CHARS, MAX_AGE, MEMORY_CHARS, MEMORY_LOG_CHARS, bounded, printMemory, renderMemory, withNote } from './memory'

const entry = (number: number, text = `a.ts:${number} note.`): MemoryEntry => ({ number, text })
// An entry whose text is `chars` code points long.
const sized = (number: number, chars: number): MemoryEntry => ({ number, text: 'x'.repeat(chars) })
const points = (text: string): number => Array.from(text).length

describe('the limits', () => {
  test('an entry holds 2,000 characters, an entry survives 30 reviews, the memory holds 12,000 characters and a debug line quotes 180', () => {
    expect([ENTRY_CHARS, MAX_AGE, MEMORY_CHARS, MEMORY_LOG_CHARS]).toEqual([2_000, 30, 12_000, 180])
  })
})

describe('withNote', () => {
  test('adds one entry after the others, holding the body under the review number', () => {
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

  test('a heading that says the notes were delivered to the worker, are the reviewer\'s own memory and are never sent to the worker, then each entry with its review number and text', () => {
    const rendered = renderMemory([entry(3, 'a.ts:3 first.'), entry(5, 'b.ts:5 second.\nMore.')])
    const [heading = '', ...rest] = rendered.split('\n\n')
    expect(heading).toContain('notes earlier reviews delivered to the worker')
    expect(heading).toContain('your own memory')
    expect(heading).toContain('never sent to the worker')
    expect(rest).toEqual(['Review 3: a.ts:3 first.', 'Review 5: b.ts:5 second.\nMore.'])
  })
})

describe('bounded', () => {
  test('drops an entry more than 30 below the new review\'s number and keeps one exactly 30 below', () => {
    const result = bounded([entry(1), entry(2), entry(31)], 32)
    expect(result.memory).toEqual([entry(2), entry(31)])
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

  test('evicts oldest first, by review number, until the rendering holds at most 12,000 code points', () => {
    const memory = [20, 21, 22, 23, 24, 25, 26, 27].map(n => sized(n, 2_000))
    const result = bounded(memory, 28)
    expect(result.memory.map(e => e.number)).toEqual([23, 24, 25, 26, 27])
    expect(result.evicted).toBe(3)
    expect(points(renderMemory(result.memory))).toBeLessThanOrEqual(MEMORY_CHARS)
  })

  test('evicts the lowest review number first even when the list is not in order, and only as many as the cap needs', () => {
    const memory = [sized(25, 2_000), sized(21, 2_000), sized(24, 2_000), sized(22, 2_000), sized(26, 2_000), sized(23, 2_000)]
    expect(bounded(memory, 27).memory.map(e => e.number)).toEqual([25, 24, 22, 26, 23])
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

describe('printMemory', () => {
  test('says the memory is empty when it is', () => {
    expect(printMemory([])).toBe('auditor memory is empty')
  })

  test('opens with the entry count, then states each entry with its review number and text', () => {
    expect(printMemory([entry(3, 'a.ts:3 first.')])).toBe('auditor memory holds 1 entry:\n\nReview 3: a.ts:3 first.')
    expect(printMemory([entry(3, 'a.ts:3 first.'), entry(5, 'b.ts:5 second.')])).toBe('auditor memory holds 2 entries:\n\nReview 3: a.ts:3 first.\n\nReview 5: b.ts:5 second.')
  })
})
