import { describe, expect, test } from 'claude-code/testing'
import { notBelowTtl, refreshIntervalMs, SECONDS_SUFFIX, secs, secsTerse, setupToken } from './setup'

const S = 1000

describe('setupToken: a setup named by its TTL and keepalive state, paused where keepalive sends nothing', () => {
  test('a setup with keepalive on or off names its TTL and its keepalive state', () => {
    expect(setupToken({ ttl: '5m', keepalive: true }, 15 * S)).toBe('5m/on')
    expect(setupToken({ ttl: '1h', keepalive: false }, 15 * S)).toBe('1h/off')
  })

  test('keepalive on at a lead not below the TTL is named paused, with the reason', () => {
    expect(setupToken({ ttl: '5m', keepalive: true }, 300 * S)).toBe('5m/paused (lead 300s ≥ 300s TTL)')
    expect(setupToken({ ttl: '1h', keepalive: true }, 3700 * S)).toBe('1h/paused (lead 3700s ≥ 3600s TTL)')
  })

  test('keepalive off at a lead not below the TTL is off, not paused', () => {
    expect(setupToken({ ttl: '5m', keepalive: false }, 300 * S)).toBe('5m/off')
  })
})

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
    expect(notBelowTtl(300 * S, 300 * S)).toBe('lead 300s ≥ 300s TTL')
  })
})

describe('secs: a duration in seconds, as the figures write it', () => {
  test('whole seconds print without a decimal, and a half second keeps its decimal', () => {
    expect(secs(300 * S)).toBe('300 s')
    expect(secs(15_500)).toBe('15.5 s')
  })
})

describe('secsTerse: a duration in seconds with no space before its s', () => {
  test('whole seconds print without a decimal, a half second keeps its decimal, and a 1 h TTL reads in seconds', () => {
    expect(secsTerse(300 * S)).toBe('300s')
    expect(secsTerse(15_500)).toBe('15.5s')
    expect(secsTerse(3600 * S)).toBe('3600s')
    expect(SECONDS_SUFFIX).toBe('s')
  })
})
