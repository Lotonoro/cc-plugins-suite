import { describe, expect, test } from 'claude-code/testing'
import { notBelowTtl, refreshIntervalMs, runSpanMs, SECONDS_SUFFIX, secs, secsTerse, setupToken } from './setup'

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

describe('runSpanMs: how long a run of refreshes keeps the cache warm from a pause\'s start, the TTL and one interval for each refresh', () => {
  test('at the 5-minute TTL and a 15 s lead, each refresh adds 4:45: 33:30 for six refreshes, 24:00 for four and 5:00 for none', () => {
    expect(runSpanMs(15 * S, 300 * S, 6)).toBe(2010 * S)
    expect(runSpanMs(15 * S, 300 * S, 4)).toBe(1440 * S)
    expect(runSpanMs(15 * S, 300 * S, 0)).toBe(300 * S)
  })

  test('a longer lead shortens each interval: 32:00 for six refreshes at a 30 s lead', () => {
    expect(runSpanMs(30 * S, 300 * S, 6)).toBe(1920 * S)
  })

  test('at the 1-hour TTL and a 15 s lead, three refreshes add three intervals of 59:45 to the hour', () => {
    expect(runSpanMs(15 * S, 3600 * S, 3)).toBe(3600 * S + 3 * 3585 * S)
  })

  test('a lead at or above the TTL sends no refresh, so the span is the TTL whatever the count', () => {
    for (const lead of [300 * S, 400 * S]) {
      for (const count of [0, 1, 6]) expect(runSpanMs(lead, 300 * S, count)).toBe(300 * S)
    }
  })

  test('the span is the TTL plus the count of the interval refreshIntervalMs gives', () => {
    for (const [lead, ttl] of [[15 * S, 300 * S], [60 * S, 300 * S], [15 * S, 3600 * S]] as const) {
      expect(runSpanMs(lead, ttl, 5)).toBe(ttl + 5 * refreshIntervalMs(lead, ttl)!)
    }
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
