import { describe, expect, test } from 'claude-code/testing'
import { notBelowTtl, refreshIntervalMs, secs } from './setup'

const S = 1000

describe('refreshIntervalMs: the TTL less the lead, or none where the run sends nothing', () => {
  test('at the 5-minute and the 1-hour TTL, a lead equal to the TTL or above it gives no interval', () => {
    for (const ttl of [300 * S, 3600 * S]) {
      expect(refreshIntervalMs(ttl, ttl)).toBeNull()
      expect(refreshIntervalMs(ttl + S, ttl)).toBeNull()
    }
  })

  test('a lead one second below the TTL gives an interval of exactly one second', () => {
    expect(refreshIntervalMs(299 * S, 300 * S)).toBe(S)
    expect(refreshIntervalMs(3599 * S, 3600 * S)).toBe(S)
  })

  test('the interval is the TTL less the lead', () => {
    expect(refreshIntervalMs(15 * S, 300 * S)).toBe(285 * S)
  })
})

describe('notBelowTtl: the words a paused keepalive gives its reason', () => {
  test('a 300 s lead on a 300 s TTL reads as the lead is not below the TTL', () => {
    expect(notBelowTtl(300 * S, 300 * S)).toBe('lead 300 s is not below the 300 s TTL')
  })
})

describe('secs: a duration in seconds, as the figures write it', () => {
  test('whole seconds print without a decimal, and a half second keeps its decimal', () => {
    expect(secs(300 * S)).toBe('300 s')
    expect(secs(15_500)).toBe('15.5 s')
  })
})
