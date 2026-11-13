import { describe, expect, test } from 'claude-code/testing'
import { percentileOf } from './rank'

// 1 to `n`, largest first, so a percentile that took the values in the order given would show. A value is then its own rank.
const downFrom = (n: number): number[] => Array.from({ length: n }, (_, i) => n - i)

describe('percentileOf: the nearest rank, the ceil(p·n/100)-th smallest', () => {
  // The sizes where the 10th and 90th ranks move: one value, under ten, exactly ten (where 0.9·n is a whole rank, so the 90th is not the largest), over ten,
  // and two sizes where both ranks are whole.
  const CASES: [values: number, p10: number, p90: number][] = [
    [1, 1, 1],
    [9, 1, 9],
    [10, 1, 9],
    [11, 2, 10],
    [20, 2, 18],
    [100, 10, 90],
  ]
  for (const [n, p10, p90] of CASES) {
    test(`over 1 to ${n}: the 10th percentile is ${p10} and the 90th is ${p90}`, () => {
      expect(percentileOf(downFrom(n), 10)).toBe(p10)
      expect(percentileOf(downFrom(n), 90)).toBe(p90)
    })
  }

  test('the values are taken as they are: unsorted, with repeats, and the caller\'s array is left in its order', () => {
    const given = [9, 1, 5, 5, 3]
    expect(percentileOf(given, 90)).toBe(9)
    expect(percentileOf(given, 10)).toBe(1)
    expect(percentileOf([4, 4, 4], 10)).toBe(4)
    expect(given).toEqual([9, 1, 5, 5, 3])
  })

  test('no values give 0', () => {
    expect(percentileOf([], 90)).toBe(0)
    expect(percentileOf([], 10)).toBe(0)
  })
})
