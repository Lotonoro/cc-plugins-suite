import { describe, expect, test } from 'claude-code/testing'
import type { CacheView, KeepaliveState } from '../types'
import {
  costOf as costWith,
  costText as costTextWith,
  forkSpend,
  defaultsOf,
  failureOf,
  enable,
  enabledStop,
  enableText as enableTextWith,
  gapOpen,
  INITIAL,
  isUserPrompt,
  lapsedReason,
  raisedLeadOf,
  raiseNote,
  countPing,
  INITIAL_TALLY,
  pastHalfTtl,
  pastHalfTtlStop,
  ZERO_TALLY,
  restartPause,
  off,
  parseRequest,
  pingLine,
  pressOf,
  promptDropped,
  promptSubmitted,
  rearm,
  reasonOf,
  reset,
  restored,
  step as stepWith,
  stopFor,
  turnBegun,
  turnEnded,
  offerOf as offerWith,
  coldBegun,
  coldLanded,
  modeOf,
  recount,
} from './keepalive'
import { expiredAt } from './countdown'
import { sessionLineOf } from './stats'
import { PRICES, TOKENS, type Money } from './prices'

const T = 1_000_000
const F = 'Next refresh: ~33k cached tokens read, every 4 min'
const REREAD = 'each refresh reads ~33k cached tokens'
const INTERVAL = 'One refresh every 4 min.'
const RESUMES = '; it resumes after your next prompt'
const known = { kind: 'known' as const, touchMs: T, ttlMs: 300000, ttlLabel: '5m' as const, promptTokens: 32884, outputTokens: 0, model: 'claude-opus-5-5', speed: 'standard' }
// The tests below word their figures in tokens, as a session with no price list does; the dollar wording has its own tests.
const step = (k: KeepaliveState, v: CacheView, live: number | null, gap: boolean, now: number) => stepWith(k, v, live, gap, now, TOKENS)
const costOf = (k: KeepaliveState, v: CacheView) => costWith(k, v, TOKENS)
const costText = (v: typeof known, lead: number, count: number) => costTextWith(v, lead, count, TOKENS)
const enableText = (v: CacheView, lead: number, count: number, stop: string | null) => enableTextWith(v, lead, count, stop, TOKENS)
// Opus 5.5 rates per token: input $4, 5 m write $5, 1 h write $8, read $0.20 per million.
const OPUS = PRICES
const DOLLARS: Money = { unit: 'dollars', list: OPUS, model: 'claude-opus-5-5', speed: 'standard', ttl: '5m' }
const on = (leadMs: number, count: number, extra: Partial<KeepaliveState> = {}): KeepaliveState => ({
  ...INITIAL,
  config: { leadMs, count },
  remaining: count,
  runCount: count,
  ...extra,
})
const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

describe('parseRequest', () => {
  test('a bare command reads the status; off and on are the two toggles', () => {
    expect(parseRequest('')).toEqual({ kind: 'status' })
    expect(parseRequest('off')).toEqual({ kind: 'off' })
    expect(parseRequest('on 60 3')).toEqual({ kind: 'on', leadMs: 60000, count: 3 })
  })

  test('enabling without a lead is refused, and without pings sends the break-even count', () => {
    expect(parseRequest('on 60')).toEqual({ kind: 'on', leadMs: 60000, count: null })
    for (const bad of ['on', 'on x 3', 'on -5 3', 'on 0 3', 'on 60 0', 'on 60 2.5', 'on 60 3 extra', 'bogus']) {
      expect(parseRequest(bad)).toEqual({ kind: 'usage' })
    }
  })

  test('default takes on or off, nothing else', () => {
    expect(parseRequest('default on')).toEqual({ kind: 'default', mode: 'on' })
    expect(parseRequest('default off')).toEqual({ kind: 'default', mode: 'off' })
    for (const bad of ['default', 'default auto', 'default on 3']) expect(parseRequest(bad)).toEqual({ kind: 'usage' })
  })

  test('unit takes dollars or tokens, nothing else', () => {
    expect(parseRequest('unit dollars')).toEqual({ kind: 'unit', unit: 'dollars' })
    expect(parseRequest('unit tokens')).toEqual({ kind: 'unit', unit: 'tokens' })
    for (const bad of ['unit', 'unit euros', 'unit Dollars', 'unit tokens 3', 'unit dollars extra']) expect(parseRequest(bad)).toEqual({ kind: 'usage' })
  })

  test('a lead is in seconds and may be fractional', () => {
    expect(parseRequest('on 1.5 2')).toEqual({ kind: 'on', leadMs: 1500, count: 2 })
  })
})

describe('the idle gap and turn bookkeeping', () => {
  test('the gap is a boolean: open at rest, closed by a turn starting or a prompt entering, reopened by a turn ending', () => {
    expect(gapOpen(INITIAL)).toBe(true)
    expect(gapOpen(turnBegun(INITIAL, 't1')!)).toBe(false)
    expect(gapOpen(turnEnded(turnBegun(INITIAL, 't1')!, 't1')!)).toBe(true)
    expect(gapOpen(promptSubmitted(INITIAL))).toBe(false)
  })

  test('a submitted prompt that is dropped reopens the gap, unless a turn is running', () => {
    expect(gapOpen(promptDropped(promptSubmitted(INITIAL)))).toBe(true)
    expect(gapOpen(promptDropped({ ...promptSubmitted(INITIAL), active: true }))).toBe(false)
  })

  test('a session reset starts a new pause epoch, so a fork sent in the old session counts into no pause of the new one', () => {
    expect(reset(on(60000, 2, { pauseEpoch: 4 })).pauseEpoch).toBe(5)
  })

  test('a reset is off, and moves neither the generation nor the sequence backwards', () => {
    expect(reset(on(60000, 2, { seq: 5, generation: 9 }))).toMatchObject({ config: null, seq: 5, generation: 10 })
  })

  test('a turn end for a turn already ended changes nothing', () => {
    const done = turnEnded(turnBegun(INITIAL, 't1')!, 't1')!
    expect(turnEnded(done, 't1')).toBeUndefined()
  })

  test('a cold mark is pending from its start until it lands, and each step moves the generation', () => {
    const begun = coldBegun(INITIAL)
    expect(begun).toMatchObject({ coldPending: true, generation: INITIAL.generation + 1 })
    expect(coldLanded(begun)).toMatchObject({ coldPending: false, generation: INITIAL.generation + 2 })
    expect(step(on(60000, 2, { coldPending: true }), known, null, true, T + 240000)).toMatchObject({ heading: 'paused', why: 'until the cache reset is recorded' })
  })

  test('off keeps the turn bookkeeping, drops the config, and bumps the generation', () => {
    const k = off({ ...on(60000, 2), active: true, lastTurn: 't9', seq: 4, generation: 7 })
    expect(k).toMatchObject({ config: null, remaining: 0, active: true, lastTurn: 't9', seq: 4, generation: 8 })
  })
})

describe('step', () => {
  test('off schedules nothing, reads off on the heading, and has no reason, no line and no last-refresh line', () => {
    expect(step(INITIAL, known, null, true, T + 240000)).toEqual({ kind: 'wait', heading: 'off', why: null, lines: [] })
    expect(step({ ...INITIAL, last: { read: 1, write: 2 } }, known, null, true, T)).toEqual({ kind: 'wait', heading: 'off', why: null, lines: [] })
  })

  test('with no known TTL there is nothing to count from, so nothing is scheduled, whatever the time', () => {
    for (const view of [{ kind: 'unread' }, { kind: 'ttl-unknown' }] as const) {
      expect(step(on(60000, 2), view, null, true, T + 999999999)).toEqual({
        kind: 'wait',
        heading: 'on, no count',
        why: null,
        lines: ['no live cache to count from, nothing scheduled'],
      })
    }
    expect(step(on(60000, 2), { kind: 'no-cache' }, null, true, T + 999999999)).toEqual({
      kind: 'wait',
      heading: 'on, no count',
      why: null,
      lines: ['no live cache to count from, nothing scheduled; there is no cache until the next reply'],
    })
  })

  test('a lead at the TTL pauses keepalive and says why, and so does a lead above it', () => {
    expect(step(on(300000, 2), known, null, true, T)).toEqual({
      kind: 'wait',
      heading: 'paused',
      why: 'lead 300 s is not below the 300 s TTL',
      lines: [],
    })
    expect(step(on(400000, 2), known, null, true, T)).toMatchObject({ heading: 'paused', why: 'lead 400 s is not below the 300 s TTL', lines: [] })
  })

  test('a due refresh is sent with no record of a cost shown: nothing holds it back once the lead has begun', () => {
    expect(step(on(60000, 2), known, null, true, T + 240000)).toEqual({ kind: 'ping', heading: 'on, refreshing', why: null, lines: [F] })
  })

  test('a ping is due the lead before the TTL after the last touch, and not before', () => {
    expect(step(on(60000, 2), known, null, true, T + 100000)).toEqual({ kind: 'wait', heading: 'on, refreshing', why: null, lines: [F, 'next refresh in 2:20, 2 left'] })
    expect(step(on(60000, 2), known, null, true, T + 239999)).toEqual({ kind: 'wait', heading: 'on, refreshing', why: null, lines: [F, 'next refresh in 0:01, 2 left'] })
    expect(step(on(60000, 2), known, null, true, T + 240000)).toEqual({ kind: 'ping', heading: 'on, refreshing', why: null, lines: [F] })
  })

  test('a due ping waits for the idle gap; outside it no fork is started', () => {
    expect(step(on(60000, 2), known, null, false, T + 240000)).toEqual({
      kind: 'wait',
      heading: 'on, refreshing',
      why: null,
      lines: [F, 'refresh due, waits for the turn to end'],
    })
  })

  test('at or past the TTL the cache has lapsed: keepalive is armed with expired and never pings', () => {
    expect(step(on(60000, 2), known, null, true, T + 300000)).toEqual({
      kind: 'stop',
      reason: 'cache expired',
      heading: 'paused',
      why: `the cache expired${RESUMES}`,
      lines: [REREAD, INTERVAL],
    })
  })

  test('when the count is used up, pings stop', () => {
    expect(step(on(60000, 2, { remaining: 0 }), known, null, true, T + 240000)).toEqual({
      kind: 'stop',
      reason: 'count used',
      heading: 'paused',
      why: `its refreshes for this pause are used up${RESUMES}`,
      lines: [REREAD, INTERVAL],
    })
  })

  test('a stopped keepalive shows its reason and never pings until a prompt re-arms it', () => {
    const stopped = on(60000, 2, { stop: 'nothing to fork yet' })
    expect(step(stopped, known, null, true, T + 240000)).toEqual({
      kind: 'wait',
      heading: 'stopped',
      why: 'nothing to fork yet; your next prompt restarts it',
      lines: [F],
    })
  })

  test('a learned count of none reads paused, with the running figure and the reason beneath it', () => {
    expect(step({ ...on(60000, 2), runCount: 0, remaining: 0 }, known, null, true, T + 100000)).toEqual({
      kind: 'wait',
      heading: 'paused',
      why: `no refreshes this pause: your pauses rarely outlast the cache${RESUMES}`,
      lines: [F],
    })
  })

  test('a live request start later than the transcript touch moves the due time; an earlier one does not', () => {
    expect(step(on(60000, 2), known, T + 100000, true, T + 240000).lines).toEqual([F, 'next refresh in 1:40, 2 left'])
    expect(step(on(60000, 2), known, T - 50000, true, T + 240000).kind).toBe('ping')
  })

  test('while keepalive runs, its figures follow the cost as it changes, and a stop names what a refresh reads', () => {
    const k = on(60000, 2)
    const grown = { ...known, promptTokens: 40000 }
    expect(step(k, grown, null, true, T + 100000).lines[0]).toBe('Next refresh: ~40k cached tokens read, every 4 min')
    expect(step({ ...k, stop: 'count used' }, known, null, true, T).lines).toEqual([REREAD, INTERVAL])
    expect(step(k, { kind: 'no-cache' }, null, true, T).lines).toEqual(['no live cache to count from, nothing scheduled; there is no cache until the next reply'])
  })

  test('the last ping is its own line after the figures, so a live session can check the served threshold', () => {
    const k = { ...on(60000, 2), last: { read: 14361, write: 18523 } }
    expect(step(k, known, null, true, T + 100000).lines).toEqual([F, 'next refresh in 2:20, 2 left', 'last refresh read 14361, wrote 18523'])
  })

  test('a stopped keepalive still names the last ping', () => {
    const k = { ...on(60000, 2, { stop: 'count used' }), last: { read: 0, write: 18000 } }
    expect(step(k, known, null, true, T)).toMatchObject({ why: `its refreshes for this pause are used up${RESUMES}`, lines: [REREAD, INTERVAL, 'last refresh read 0, wrote 18000'] })
  })

  // One row per branch of step, in its order: the heading word, the reason line and the lines, each branch with a last refresh sent.
  describe('the twelve branches, each with the heading word, the reason line and the lines it gives', () => {
    const last = { read: 14361, write: 18523 }
    const LAST = 'last refresh read 14361, wrote 18523'
    const run = (extra: Partial<KeepaliveState>, view: CacheView, gap: boolean, now: number, lead = 60000) =>
      step({ ...on(lead, 2, extra), last }, view, null, gap, now)
    const rows: [string, ReturnType<typeof step>, ReturnType<typeof step>][] = [
      ['off', step({ ...INITIAL, last }, known, null, true, T), { kind: 'wait', heading: 'off', why: null, lines: [] }],
      [
        'a recorded stop by design',
        run({ stop: 'count used' }, known, true, T),
        { kind: 'wait', heading: 'paused', why: `its refreshes for this pause are used up${RESUMES}`, lines: [REREAD, INTERVAL, LAST] },
      ],
      [
        'a recorded failure',
        run({ stop: 'API error 529 (overloaded)' }, known, true, T),
        { kind: 'wait', heading: 'stopped', why: 'API error 529 (overloaded); your next prompt restarts it', lines: [F, LAST] },
      ],
      [
        'a cold mark being written',
        run({ coldPending: true }, known, true, T + 100000),
        { kind: 'wait', heading: 'paused', why: 'until the cache reset is recorded', lines: [F, LAST] },
      ],
      [
        'a lead at or above the TTL',
        run({}, known, true, T, 300000),
        { kind: 'wait', heading: 'paused', why: 'lead 300 s is not below the 300 s TTL', lines: [LAST] },
      ],
      [
        'no live cache',
        run({}, { kind: 'no-cache' }, true, T),
        { kind: 'wait', heading: 'on, no count', why: null, lines: ['no live cache to count from, nothing scheduled; there is no cache until the next reply', LAST] },
      ],
      [
        'the cache expired',
        run({}, known, true, T + 300000),
        { kind: 'stop', reason: 'cache expired', heading: 'paused', why: `the cache expired${RESUMES}`, lines: [REREAD, INTERVAL, LAST] },
      ],
      [
        'a learned count of none',
        run({ runCount: 0, remaining: 0 }, known, true, T + 100000),
        { kind: 'wait', heading: 'paused', why: `no refreshes this pause: your pauses rarely outlast the cache${RESUMES}`, lines: [F, LAST] },
      ],
      [
        'the count used',
        run({ remaining: 0 }, known, true, T + 240000),
        { kind: 'stop', reason: 'count used', heading: 'paused', why: `its refreshes for this pause are used up${RESUMES}`, lines: [REREAD, INTERVAL, LAST] },
      ],
      [
        'a refresh scheduled',
        run({}, known, true, T + 100000),
        { kind: 'wait', heading: 'on, refreshing', why: null, lines: [F, 'next refresh in 2:20, 2 left', LAST] },
      ],
      [
        'a refresh due',
        run({}, known, false, T + 240000),
        { kind: 'wait', heading: 'on, refreshing', why: null, lines: [F, 'refresh due, waits for the turn to end', LAST] },
      ],
      ['a refresh sent now', run({}, known, true, T + 240000), { kind: 'ping', heading: 'on, refreshing', why: null, lines: [F, LAST] }],
    ]
    for (const [name, got, want] of rows) {
      test(name, () => expect(got).toEqual(want))
    }

    test('no line of any branch begins with a state word, alone or after keepalive', () => {
      for (const [, got] of rows) {
        for (const line of [...(got.why === null ? [] : [got.why]), ...got.lines]) {
          expect(line).not.toMatch(/^(keepalive |)(off|on|refreshing|paused|stopped|no count)\b/)
        }
      }
    })
  })
})

describe('enabledStop follows the cache\'s one expiry owner', () => {
  test('at a lead below the TTL it stops at exactly the expiry, and not one millisecond before, nor with a live start later than the reply\'s', () => {
    expect(enabledStop(known, 15000, null, T + 300000)).toBe('cache expired')
    expect(enabledStop(known, 15000, null, T + 299999)).toBeNull()
    expect(enabledStop(known, 15000, T + 5000, T + 300000)).toBeNull()
  })
  test('at a lead at or above the TTL it never stops, while the owner answers expired', () => {
    expect(expiredAt(known, null, T + 400000)).toBe(true)
    expect(enabledStop(known, 300000, null, T + 400000)).toBeNull()
  })
})

// While a cold mark's write is pending, the verdict is `paused` with the pending reason first, then the reason the settled verdict gives
// with no write pending when it has one, then its lines without the schedule line. Its kind is `wait`, so the tick sends nothing and records no stop.
describe('a pending cold-mark write keeps the lines the settled verdict gives, apart from its schedule line', () => {
  const last = { read: 14361, write: 18523 }
  const LAST = 'last refresh read 14361, wrote 18523'
  const PENDING = 'until the cache reset is recorded'
  const run = (extra: Partial<KeepaliveState>, view: CacheView, gap: boolean, now: number, lead = 60000) =>
    step({ ...on(lead, 2, { coldPending: true, ...extra }), last }, view, null, gap, now)
  const rows: [string, ReturnType<typeof step>, ReturnType<typeof step>][] = [
    ['a refresh scheduled', run({}, known, true, T + 100000), { kind: 'wait', heading: 'paused', why: PENDING, lines: [F, LAST] }],
    ['a refresh due with the turn running', run({}, known, false, T + 240000), { kind: 'wait', heading: 'paused', why: PENDING, lines: [F, LAST] }],
    ['a refresh due with the gap open', run({}, known, true, T + 240000), { kind: 'wait', heading: 'paused', why: PENDING, lines: [F, LAST] }],
    [
      'a learned count of none',
      run({ runCount: 0, remaining: 0 }, known, true, T + 100000),
      { kind: 'wait', heading: 'paused', why: PENDING, lines: [`no refreshes this pause: your pauses rarely outlast the cache${RESUMES}`, F, LAST] },
    ],
    [
      'a lead at or above the TTL',
      run({}, known, true, T, 300000),
      { kind: 'wait', heading: 'paused', why: PENDING, lines: ['lead 300 s is not below the 300 s TTL', LAST] },
    ],
    [
      'an expired cache with its stop unrecorded',
      run({}, known, true, T + 300000),
      { kind: 'wait', heading: 'paused', why: PENDING, lines: [`the cache expired${RESUMES}`, REREAD, INTERVAL, LAST] },
    ],
    [
      'a count used with its stop unrecorded',
      run({ remaining: 0 }, known, true, T + 240000),
      { kind: 'wait', heading: 'paused', why: PENDING, lines: [`its refreshes for this pause are used up${RESUMES}`, REREAD, INTERVAL, LAST] },
    ],
    [
      'a counted view of no cache',
      run({}, { kind: 'no-cache' }, true, T),
      { kind: 'wait', heading: 'paused', why: PENDING, lines: ['no live cache to count from, nothing scheduled; there is no cache until the next reply', LAST] },
    ],
    [
      'a TTL-unknown view',
      run({}, { kind: 'ttl-unknown' }, true, T),
      { kind: 'wait', heading: 'paused', why: PENDING, lines: ['no live cache to count from, nothing scheduled', LAST] },
    ],
  ]
  for (const [name, got, want] of rows) {
    test(name, () => expect(got).toEqual(want))
  }

  test('no line of the overlay is the schedule line, however the settled verdict reads', () => {
    for (const [, got] of rows) {
      for (const line of got.lines) expect(line).not.toMatch(/^(next refresh in |refresh due, waits)/)
    }
  })

  test('with keepalive off or a stop held, a pending write leaves the verdict as it is', () => {
    const held = (extra: Partial<KeepaliveState>) => step({ ...on(60000, 2, extra), last }, known, null, true, T)
    expect(step({ ...INITIAL, coldPending: true, last }, known, null, true, T)).toEqual({ kind: 'wait', heading: 'off', why: null, lines: [] })
    for (const stop of ['count used', 'cache expired', 'API error 529 (overloaded)']) {
      expect(held({ stop, coldPending: true })).toEqual(held({ stop }))
    }
  })

  test('a recorded stop is held first: the pending write adds nothing to it', () => {
    expect(run({ stop: 'count used' }, known, true, T)).toEqual({ kind: 'wait', heading: 'paused', why: `its refreshes for this pause are used up${RESUMES}`, lines: [REREAD, INTERVAL, LAST] })
  })
})

// A stop by design names how often a refresh would be sent wherever the figure of one refresh is given: the view known and the lead below
// its TTL. The twelve-branch rows above pin the unrecorded stops and a recorded count used.
describe('a stop by design names how often a refresh would be sent, wherever the lead is below the TTL', () => {
  const last = { read: 14361, write: 18523 }
  const LAST = 'last refresh read 14361, wrote 18523'

  test('a recorded stop of the cache expired gives the figure, the interval row and the last refresh, as its unrecorded stop does', () => {
    expect(step({ ...on(60000, 2, { stop: 'cache expired' }), last }, known, null, true, T)).toEqual({
      kind: 'wait',
      heading: 'paused',
      why: `the cache expired${RESUMES}`,
      lines: [REREAD, INTERVAL, LAST],
    })
  })

  test('recording a count-used stop changes neither the figure of what a refresh reads nor the interval row', () => {
    const unrecorded = step({ ...on(60000, 2, { remaining: 0 }), last }, known, null, true, T + 240000)
    expect(unrecorded.lines).toEqual([REREAD, INTERVAL, LAST])
    expect(step({ ...on(60000, 2, { remaining: 0, stop: 'count used' }), last }, known, null, true, T + 240000).lines).toEqual(unrecorded.lines)
  })

  test('a by-design stop with the lead at or above the TTL keeps the figure and gives no interval row, recorded or not', () => {
    for (const leadMs of [300000, 400000]) {
      for (const stop of ['count used', 'cache expired']) {
        expect(step(on(leadMs, 2, { stop }), known, null, true, T).lines).toEqual([REREAD])
      }
    }
  })

  test('a learned count of none whose cache expired gives the figure, the interval row and the last refresh, recorded or not', () => {
    const none = { ...on(60000, 2, { runCount: 0, remaining: 0 }), last }
    expect(step(none, known, null, true, T + 300000)).toEqual({
      kind: 'stop',
      reason: 'cache expired',
      heading: 'paused',
      why: `the cache expired${RESUMES}`,
      lines: [REREAD, INTERVAL, LAST],
    })
    expect(step({ ...none, stop: 'cache expired' }, known, null, true, T + 300000)).toEqual({
      kind: 'wait',
      heading: 'paused',
      why: `the cache expired${RESUMES}`,
      lines: [REREAD, INTERVAL, LAST],
    })
  })

  test('the interval row is the interval the figures line gives at the same lead', () => {
    expect(costOf(on(15000, 3), known)?.figures).toBe('One refresh every 4:45.')
    expect(step(on(15000, 3, { stop: 'count used' }), known, null, true, T).lines).toEqual([REREAD, 'One refresh every 4:45.'])
  })
})

describe('enable: a new run starts on, stopped only by its cache', () => {
  test('enabling with a known TTL starts the run with no stop', () => {
    expect(enable(INITIAL, 60000, 2, 2, known, null, T + 1000)).toMatchObject({ config: { leadMs: 60000, count: 2 }, stop: null })
  })

  test('enabling with the lead already begun starts the run with no stop, so its refresh is due at once', () => {
    const k = enable(INITIAL, 60000, 2, 2, known, null, T + 240000)
    expect(k.stop).toBeNull()
    expect(step(k, known, null, true, T + 240000).kind).toBe('ping')
  })

  test('enabling while the TTL is unknown or cold starts the run with no stop: it waits for a figure', () => {
    for (const view of [{ kind: 'no-cache' }, { kind: 'ttl-unknown' }, { kind: 'unread' }] as const) {
      expect(enable(INITIAL, 60000, 2, 2, view, null, T).stop).toBeNull()
    }
  })

  test('enabling with a cache already past its TTL leaves the run stopped: the cache expired', () => {
    expect(enable(INITIAL, 60000, 2, 2, known, null, T + 400000)).toMatchObject({ stop: 'cache expired' })
  })

  test('the cost line names the tokens each ping reads, how often, and that a first ping can write', () => {
    const text = costText(known, 60000, 3)
    expect(text).toContain('Next refresh: ~33k cached tokens read')
    expect(text).toContain('every 4 min')
    expect(text).toContain('5m TTL')
    expect(text).toContain("can also write that turn's new tokens")
    expect(text).toContain('write')
    expect(text).toContain('3 refreshes')
  })

  test('the toggle text shows the cost when it is known, a waiting message when not, and any stop reached', () => {
    expect(enableText(known, 60000, 3, null)).toContain('every 4 min')
    expect(enableText(known, 60000, 3, null).startsWith('keepalive on: lead 60 s, 3 refreshes.')).toBe(true)
    expect(enableText(known, 300000, 3, null)).toContain('Paused: lead 300 s is not below the 300 s TTL')
    expect(enableText({ kind: 'no-cache' }, 60000, 3, null)).toContain('nothing is scheduled until there is one')
    expect(enableText(known, 60000, 3, 'cache expired')).toContain('Paused: the cache expired; it resumes after your next prompt.')
  })

  test('the toggle text names a failure stop as given, and says the next prompt restarts it', () => {
    expect(enableText(known, 60000, 3, 'API error 529 (overloaded)')).toContain('Stopped: API error 529 (overloaded); your next prompt restarts it.')
  })

  test('a user prompt refills the count and clears the stop; a prompt when off changes nothing', () => {
    expect(rearm(on(60000, 3, { remaining: 0, stop: 'count used' }), 3)).toMatchObject({ remaining: 3, runCount: 3, stop: null, pauseEpoch: 1 })
    // The count is the one the caller resolved for this run: a break-even count can differ from the last run's.
    expect(rearm(on(60000, 3, { remaining: 0 }), 24)).toMatchObject({ remaining: 24, runCount: 24 })
    expect(rearm(INITIAL, 0)).toEqual({ ...INITIAL, pauseEpoch: 1 })
  })
})

describe('isUserPrompt', () => {
  test('the user\'s own prompts re-arm: typed, or sent through the phone bridge', () => {
    expect(isUserPrompt({ kind: 'composer' })).toBe(true)
    expect(isUserPrompt({ kind: 'bridge' })).toBe(true)
  })

  test('a peer session, a schedule, a notification or a plugin does not re-arm', () => {
    for (const kind of ['peer', 'scheduled-trigger', 'task-notification', 'plugin', 'unclassified']) {
      expect(isUserPrompt({ kind })).toBe(false)
    }
  })
})

describe('reasonOf and stopFor: how a ping\'s outcome stops keepalive', () => {
  test('an answered fork that read the cache has no stop reason', () => {
    expect(reasonOf({ isAnswered: true, text: 'ok', usage: { ...zero, cache_read_input_tokens: 1 } })).toBeNull()
  })

  test('each way a fork fails names itself', () => {
    expect(reasonOf({ isAnswered: false, reason: 'nothing-to-fork' })).toBe('nothing to fork yet')
    expect(reasonOf({ isAnswered: false, reason: 'empty-reply', usage: zero })).toBe('empty reply')
    expect(reasonOf({ isAnswered: false, reason: 'aborted', usage: zero })).toBe('aborted')
    expect(reasonOf({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: zero } as any)).toBe('API error 529 (overloaded)')
    expect(reasonOf({ isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: zero } as any)).toBe(
      'API error, no response (unknown)',
    )
  })

  test('a served answer within the lead stops nothing; an unserved one stops with its reason', () => {
    expect(stopFor({ isAnswered: true, text: 'ok', usage: { ...zero, cache_read_input_tokens: 14361 } })).toBeNull()
    expect(stopFor({ isAnswered: true, text: 'ok', usage: { ...zero, cache_creation_input_tokens: 18000 } })).toBe('reply not served from cache')
    expect(stopFor({ isAnswered: false, reason: 'empty-reply' } as any)).toBe('empty reply')
    expect(stopFor({ isAnswered: false, reason: 'empty-reply', usage: zero })).toBe('reply not served from cache')
    expect(stopFor({ isAnswered: false, reason: 'empty-reply', usage: { ...zero, cache_read_input_tokens: 336000 } })).toBeNull()
    expect(stopFor({ isAnswered: false, reason: 'aborted', usage: { ...zero, cache_read_input_tokens: 336000 } })).toBe('aborted')
  })

  test('a slow ping raises the lead to twice its round trip; a round trip at or under half the lead raises nothing', () => {
    expect(raisedLeadOf(15000, 7300)).toBe(15000)
    expect(raisedLeadOf(15000, 7500)).toBe(15000)
    expect(raisedLeadOf(15000, 8000)).toBe(16000)
  })

  test('a raise past half the TTL is one past it: exactly half is still raised, and the stop names the round trip and the lead it needs', () => {
    expect(pastHalfTtl(150000, 300000)).toBe(false)
    expect(pastHalfTtl(150001, 300000)).toBe(true)
    expect(pastHalfTtlStop(160000, 320000, 300000)).toBe('a 160.0 s round trip needs a 320 s lead, over half the 300 s TTL')
    expect(pastHalfTtlStop(75001, 151000, 300000)).toBe('a 75.1 s round trip needs a 151 s lead, over half the 300 s TTL')
  })

  test('a raised lead rounds up to whole seconds, so the pane and the debug log show a clean figure', () => {
    expect(raisedLeadOf(15000, 8010)).toBe(17000)
  })

  test('a count of 0 reads 0, under a thousand reads <1k, and the rest round to whole thousands', () => {
    expect(costOf(on(15000, 3), { ...known, promptTokens: 0 })?.label).toBe('0 read/refresh')
    expect(costOf(on(15000, 3), { ...known, promptTokens: 999 })?.label).toBe('<1k read/refresh')
    expect(costOf(on(15000, 3), { ...known, promptTokens: 1000 })?.label).toBe('~1k read/refresh')
    expect(costOf(on(15000, 3), { ...known, promptTokens: 1500 })?.label).toBe('~2k read/refresh')
  })

  test('the lead is never lowered: a faster ping after a raise leaves it where it is', () => {
    expect(raisedLeadOf(16000, 2000)).toBe(16000)
    expect(raisedLeadOf(16000, 8000)).toBe(16000)
    expect(raisedLeadOf(18000, 7000)).toBe(18000)
  })

  test('a reply after the TTL lapses says so, and the details pane names a raised lead in seconds', () => {
    expect(lapsedReason(300000)).toBe('round trip over 300 s TTL, no reply yet')
    expect(raiseNote(16000)).toBe('The lead was raised to 16 s after a slow refresh.')
  })
})

describe('the debug lines and the tallies', () => {
  test('a ping line carries time, lead, TTL, generation, round trip, usage, and outcome', () => {
    const r = pingLine({
      decidedMs: Date.parse('2026-10-18T10:00:00.000Z'),
      seq: 2,
      generation: 5,
      leadMs: 60000,
      ttlMs: 300000,
      roundTripMs: 1900,
      usage: { ...zero, input_tokens: 8, output_tokens: 18, cache_read_input_tokens: 14361, cache_creation_input_tokens: 18523 },
      outcome: 'answered',
      stale: false,
    })
    expect(r).toEqual({
      time: '2026-10-18T10:00:00.000Z',
      seq: 2,
      generation: 5,
      lead_s: 60,
      ttl_s: 300,
      round_trip_ms: 1900,
      usage: { read: 14361, write: 18523, input: 8, output: 18 },
      outcome: 'answered',
      stale: false,
    })
  })

  test('a ping with no usage logs null usage, and a stale one is marked', () => {
    const r = pingLine({ decidedMs: 0, seq: 1, generation: 1, leadMs: 1000, ttlMs: 300000, roundTripMs: 5, usage: null, outcome: 'aborted', stale: true })
    expect(r.usage).toBeNull()
    expect(r.stale).toBe(true)
  })

  // A fork's usage as the spend it adds, priced at Opus 5.5.
  const spent = (read: number, write = 0, ttl: '5m' | '1h' = '5m') =>
    forkSpend({ ...zero, cache_read_input_tokens: read, cache_creation_input_tokens: write }, { ...known, ttlLabel: ttl }, DOLLARS)
  const kinds = (t: { pings: number; spend: { read: number; write5m: number; write1h: number } }) => [t.pings, t.spend.read, t.spend.write5m, t.spend.write1h]

  test('every fork counts into both tallies by what it read and wrote, kept apart; one with no usage adds a ping and no tokens', () => {
    const once = countPing(INITIAL_TALLY, spent(14361, 18523), null, { late: false, pauseEpoch: 0 })
    expect(kinds(once.pause)).toEqual([1, 14361, 18523, 0])
    expect(kinds(once.session)).toEqual([1, 14361, 18523, 0])
    const twice = countPing(once, null, null, { late: false, pauseEpoch: 0 })
    expect(kinds(twice.session)).toEqual([2, 14361, 18523, 0])
  })

  test("a fork's write is priced at the TTL of the cache it was sent on, and its read at the cache read rate", () => {
    const usd = (s: { usd: number | null }) => (s.usd === null ? null : Math.round(s.usd * 1e9) / 1e9)
    expect(usd(spent(1_000_000))).toBe(0.2)
    expect(usd(spent(0, 1_000_000))).toBe(5)
    expect(spent(0, 1_000_000, '1h')).toMatchObject({ write5m: 0, write1h: 1_000_000 })
    expect(usd(spent(0, 1_000_000, '1h'))).toBe(8)
  })

  test('a fork that outlives the TTL counts once: its late reply adds its tokens and no ping', () => {
    const late = countPing(INITIAL_TALLY, spent(1000), null, { late: true, pauseEpoch: 0 })
    expect(kinds(late.session)).toEqual([0, 1000, 0, 0])
    expect(kinds(late.pause)).toEqual([0, 1000, 0, 0])
  })

  test('a fork sent before a prompt started a new pause adds to the session but not to that pause', () => {
    const counted = countPing(restartPause(INITIAL_TALLY, 1), spent(1000), null, { late: false, pauseEpoch: 0 })
    expect(counted.pause).toEqual(ZERO_TALLY)
    expect(kinds(counted.session)).toEqual([1, 1000, 0, 0])
  })

  test('a user prompt clears the pause and keeps the session; a raise is kept as the session raised lead', () => {
    const counted = countPing(INITIAL_TALLY, spent(1000), 16000, { late: false, pauseEpoch: 0 })
    expect(counted.raisedMs).toBe(16000)
    expect(restartPause(counted, 1)).toMatchObject({ pause: ZERO_TALLY, session: { pings: 1, spend: { read: 1000 } }, raisedMs: 16000 })
  })

  test('the details pane names this session in the unit shown, and no pause or raise', () => {
    const sent = { late: false, pauseEpoch: 0 }
    const t = countPing(countPing(INITIAL_TALLY, spent(32884), 16000, sent), null, null, sent)
    expect(sessionLineOf(t, TOKENS)).toBe('This session: 2 refreshes costing ~33k tokens read.')
    expect(sessionLineOf(t, DOLLARS)).toBe('This session: 2 refreshes costing $0.007.')
  })

  test('in dollars, the ping is priced on every surface; a model with no price is worded in tokens', () => {
    expect(costWith(on(60000, 3), known, DOLLARS)).toEqual({ label: '$0.007/refresh', explain: 'Next refresh: $0.007 (~33k cached tokens read).', figures: 'One refresh every 4 min.' })
    expect(stepWith(on(60000, 2), known, null, true, T + 100000, DOLLARS).lines).toEqual(['Next refresh: $0.007 (~33k cached tokens read), every 4 min', 'next refresh in 2:20, 2 left'])
    expect(stepWith(on(60000, 2, { remaining: 0 }), known, null, true, T + 240000, DOLLARS).lines).toEqual(['each refresh costs $0.007 (reads ~33k cached tokens)', INTERVAL])
    const fable = { ...known, model: 'claude-nonesuch-1' }
    expect(costWith(on(60000, 3), fable, DOLLARS)?.label).toBe('~33k read/refresh')
    expect(costTextWith(fable, 60000, 3, DOLLARS)).toContain('Next refresh: ~33k cached tokens read, every 4 min')
  })
})

describe('the footer line and the status line: what each shows', () => {
  test('costOf gives the context each ping reads and how often while keepalive runs, and nothing when it is off, stopped, or paused', () => {
    expect(costOf(INITIAL, known)).toBeNull()
    expect(costOf(on(60000, 3), known)).toEqual({
      label: '~33k read/refresh',
      explain: 'Next refresh: ~33k cached tokens read.',
      figures: 'One refresh every 4 min.',
    })
    // A run that learned no refreshes for this pause shows no figure: the line says it is paused.
    expect(costOf({ ...on(60000, 3), runCount: 0 }, known)).toBeNull()
    expect(costOf(on(60000, 3, { stop: 'count used' }), known)).toBeNull()
    expect(costOf(on(60000, 3, { stop: 'API error 529 (overloaded)' }), known)).toBeNull()
    expect(costOf(on(400000, 3), known)).toBeNull()
    expect(costOf(on(60000, 3), { kind: 'no-cache' })).toBeNull()
    expect(costOf(on(15000, 3), known)?.figures).toBe('One refresh every 4:45.')
  })

  test('offerOf is the figure of the run a press would start: one refresh at its lead, in the unit given; nothing where it sends no refresh or there is no known cache', () => {
    expect(offerWith(known, TOKENS, 15000, 3)).toEqual({ label: '~33k read/refresh', explain: 'Next refresh: ~33k cached tokens read.', figures: 'One refresh every 4:45.' })
    expect(offerWith(known, DOLLARS, 15000, 3)?.explain).toMatch(/^Next refresh: \$[\d.]+ \(~33k cached tokens read\)\.$/)
    expect(offerWith(known, TOKENS, 15000, 0)).toBeNull()
    expect(offerWith(known, TOKENS, 300000, 3)).toBeNull()
    expect(offerWith({ kind: 'no-cache' }, TOKENS, 15000, 3)).toBeNull()
  })

  test('the interval a run pings at is minutes and seconds when the seconds are not zero, whole minutes otherwise', () => {
    const at = (lead: number) => costOf(on(lead, 2), known)?.figures
    expect(at(15000)).toBe('One refresh every 4:45.')
    expect(at(60000)).toBe('One refresh every 4 min.')
    expect(at(235000)).toBe('One refresh every 1:05.')
  })

  test('failureOf names a stop that is not by design, or a lead at or above the TTL, in one clause; count used and cache expired are by design', () => {
    expect(failureOf(INITIAL, known)).toBeNull()
    expect(failureOf(on(60000, 3), known)).toBeNull()
    expect(failureOf(on(60000, 3, { stop: 'count used' }), known)).toBeNull()
    expect(failureOf(on(60000, 3, { stop: 'cache expired' }), known)).toBeNull()
    expect(failureOf(on(60000, 3, { stop: 'API error 529 (overloaded)' }), known)).toBe('keepalive stopped: API error 529 (overloaded)')
    expect(failureOf(on(60000, 3, { stop: 'a 160 s round trip needs a 320 s lead, over half the 300 s TTL' }), known)).toBe(
      'keepalive stopped: a 160 s round trip needs a 320 s lead, over half the 300 s TTL',
    )
    expect(failureOf(on(400000, 3), known)).toBe('keepalive paused: lead 400 s is not below the 300 s TTL')
  })
})

describe('the countdown press: the same toggle as the command, with the session values', () => {
  const defaults = { leadMs: 15000, count: null, cap: null }

  test('off turns on with the values last used this session, else the defaults', () => {
    expect(pressOf(INITIAL, defaults)).toEqual({ kind: 'on', leadMs: 15000, count: null })
    expect(pressOf({ ...INITIAL, lastUsed: { leadMs: 30000, count: 5 } }, defaults)).toEqual({
      kind: 'on',
      leadMs: 30000,
      count: 5,
    })
  })

  test('a click turns keepalive off whenever it is on, refreshing or not, and on when it is off', () => {
    expect(pressOf(on(60000, 3), defaults)).toEqual({ kind: 'off' })
    expect(pressOf(on(60000, 3, { stop: 'count used' }), defaults)).toEqual({ kind: 'off' })
    expect(pressOf(on(300000, 3), defaults)).toEqual({ kind: 'off' })
    expect(pressOf({ ...on(60000, 3), runCount: 0 }, defaults)).toEqual({ kind: 'off' })
    expect(pressOf(INITIAL, defaults)).toMatchObject({ kind: 'on' })
  })

})

describe('defaultsOf: the click values from the plugin options', () => {
  test('the lead is read in seconds, the count is never pinned, and the option caps it', () => {
    expect(defaultsOf({ keepalive_lead_s: 60, keepalive_count: 3 })).toEqual({ leadMs: 60000, count: null, cap: 3 })
    expect(defaultsOf({ keepalive_lead_s: 60 })).toEqual({ leadMs: 60000, count: null, cap: null })
    expect(defaultsOf({ keepalive_lead_s: 60, keepalive_count: '' })).toEqual({ leadMs: 60000, count: null, cap: null })
  })

  test('a lead that is not a positive number, or a count that is not a whole number above zero, is refused by name', () => {
    expect(() => defaultsOf({ keepalive_lead_s: 0, keepalive_count: 3 })).toThrow('keepalive_lead_s')
    expect(() => defaultsOf({ keepalive_lead_s: 'sixty', keepalive_count: 3 })).toThrow('keepalive_lead_s')
    expect(() => defaultsOf({ keepalive_lead_s: 60, keepalive_count: 2.5 })).toThrow('keepalive_count')
    expect(() => defaultsOf({ keepalive_lead_s: 60, keepalive_count: 0 })).toThrow('keepalive_count')
  })

  test('a paused keepalive\'s lines say what a refresh reads and how often: each by-design stop, the enable reply, and a lapsed enable', () => {
    const paused = (stop: string) => step(on(60000, 2, { stop }), known, null, true, T)
    expect(paused('cache expired')).toMatchObject({ heading: 'paused', why: `the cache expired${RESUMES}`, lines: [REREAD, INTERVAL] })
    expect(paused('count used')).toMatchObject({ heading: 'paused', why: `its refreshes for this pause are used up${RESUMES}`, lines: [REREAD, INTERVAL] })
    const lapsed = { ...known, touchMs: T - 400000 }
    expect(step(on(60000, 2), lapsed, null, true, T)).toMatchObject({ heading: 'paused', why: `the cache expired${RESUMES}` })
    const reply = enableText(lapsed, 60000, 2, 'cache expired')
    expect(reply).toContain('Each refresh reads ~33k cached tokens.')
    expect(reply).toContain('Paused: the cache expired; it resumes after your next prompt.')
    expect(reply).not.toContain('every')
  })

})

describe('lastUsed: the session remembers the lead and count it was last enabled with', () => {
  test('enable records them, and off keeps them while turning keepalive off', () => {
    const enabled = enable(INITIAL, 30000, 5, 5, known, null, T)
    expect(enabled.lastUsed).toEqual({ leadMs: 30000, count: 5 })
    expect(off(enabled)).toMatchObject({ config: null, lastUsed: { leadMs: 30000, count: 5 } })
  })

  test('a session reset forgets them', () => {
    const enabled = enable(INITIAL, 30000, 5, 5, known, null, T)
    expect(reset(enabled).lastUsed).toBeNull()
  })
})

describe('restored: keepalive state an earlier load left, in this version\'s shape', () => {
  test('a field of the right kind is kept, a nullable one of its shape too, and the generation moves on', () => {
    const held = { ...INITIAL, config: { leadMs: 20000, count: 4 }, remaining: 2, active: true, gap: false, lastTurn: 't7', generation: 5, seq: 9 }
    expect(restored(held)).toEqual({ ...held, generation: 6 })
  })

  test('a field the earlier version did not have takes the default, and one of another kind is replaced by it', () => {
    const { pauseEpoch: _gone, ...older } = { ...INITIAL, config: { leadMs: 15000, count: 3 }, generation: 2 }
    expect(restored({ ...older, remaining: 'three', extra: 1 })).toEqual({ ...INITIAL, config: { leadMs: 15000, count: 3 }, generation: 3 })
  })

  test('a nullable field is kept when null or of its shape, and takes the default otherwise', () => {
    const held = { ...INITIAL, config: { leadMs: 15000 }, lastUsed: { leadMs: 15000, count: 3 }, last: { read: 19000, write: 0 }, stop: 7, lastTurn: null }
    expect(restored(held)).toEqual({ ...INITIAL, lastUsed: { leadMs: 15000, count: 3 }, last: { read: 19000, write: 0 }, generation: 1 })
  })

  test('nothing held, or no object, is the default with the generation moved on', () => {
    expect(restored(undefined)).toEqual({ ...INITIAL, generation: 1 })
    expect(restored('x')).toEqual({ ...INITIAL, generation: 1 })
  })
})

describe('modeOf and recount: the mode a session starts in, and an unpinned count that follows the prices', () => {
  test('the default is off unless the option says on', () => {
    expect(modeOf('on')).toBe('on')
    for (const other of ['off', '', undefined, 'auto', true]) expect(modeOf(other)).toBe('off')
  })

  test('an unpinned run takes the new count until its first ping; a pinned run, a run that pinged, or keepalive off keep theirs', () => {
    const fresh = { ...on(60000, 3), config: { leadMs: 60000, count: null } }
    expect(recount(fresh, 24)).toMatchObject({ remaining: 24, runCount: 24 })
    expect(recount(fresh, 3)).toBe(fresh)
    const pinned = on(60000, 3)
    expect(recount(pinned, 24)).toBe(pinned)
    const pinged = { ...fresh, remaining: 2 }
    expect(recount(pinged, 24)).toBe(pinged)
    expect(recount(INITIAL, 24)).toBe(INITIAL)
  })
})
