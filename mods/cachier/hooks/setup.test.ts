import { describe, expect, test } from 'claude-code/testing'
import { notBelowTtl, refreshIntervalMs, secs, setupPhrase } from './setup'

const S = 1000

describe('setupPhrase: a setup named in the words every sentence uses, paused where keepalive sends nothing', () => {
  test('a setup with keepalive on or off names its TTL and its keepalive state', () => {
    expect(setupPhrase({ ttl: '5m', keepalive: true }, 15 * S)).toBe('a 5-minute cache with keepalive on')
    expect(setupPhrase({ ttl: '1h', keepalive: false }, 15 * S)).toBe('a 1-hour cache with keepalive off')
  })

  test('keepalive on at a lead not below the TTL is named paused, sending nothing, with the reason', () => {
    expect(setupPhrase({ ttl: '5m', keepalive: true }, 300 * S)).toBe('a 5-minute cache with keepalive paused, sending nothing (lead 300 s is not below the 300 s TTL)')
  })

  test('keepalive off at a lead not below the TTL is off, not paused', () => {
    expect(setupPhrase({ ttl: '5m', keepalive: false }, 300 * S)).toBe('a 5-minute cache with keepalive off')
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
    expect(notBelowTtl(300 * S, 300 * S)).toBe('lead 300 s is not below the 300 s TTL')
  })
})

describe('secs: a duration in seconds, as the figures write it', () => {
  test('whole seconds print without a decimal, and a half second keeps its decimal', () => {
    expect(secs(300 * S)).toBe('300 s')
    expect(secs(15_500)).toBe('15.5 s')
  })
})
