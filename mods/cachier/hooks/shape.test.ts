import { describe, expect, test } from 'claude-code/testing'
import type { PluginState } from 'claude-code'
import type { CacheView } from '../types'
import { INITIAL, INITIAL_TALLY } from './keepalive'
import { STATE_SHAPE } from './register'
import { INITIAL_STATS } from './stats'
import { NO_JUDGED } from './verdict'

// A reload keeps the session's state, and restoreState resets it only when STATE_SHAPE moves. This guard makes a change to
// a state type fail until it does:
// - SAMPLE fills every field of the state, so `tsc` refuses it once a state type changes, until the sample is updated.
// - Its fingerprint, with the defaults' (a field added to INITIAL fails here without `tsc`), is recorded per shape. An
//   updated sample fails here until STATE_SHAPE is bumped and its fingerprint is added to SHAPES.
// It sees keys and value kinds, not literal unions (a new Unit or Verdict value): bump by hand for those.
const SAMPLE = {
  shape: 4,
  transcript: '/t.jsonl',
  view: { kind: 'known', touchMs: 1, ttlMs: 300000, ttlLabel: '5m', promptTokens: 1, outputTokens: 0, model: 'm', speed: 's' },
  cold: { reason: 'cleared', atMs: 1 },
  touch: 1,
  keepalive: {
    config: { leadMs: 1, count: 1 },
    remaining: 1,
    stop: 's',
    last: { read: 1, write: 1 },
    seq: 1,
    active: true,
    gap: true,
    coldPending: true,
    lastTurn: 't',
    generation: 1,
    lastUsed: { leadMs: 1, count: 1 },
    pauseEpoch: 1,
    runCount: 1,
  },
  hint: {
    reading: { words: 'w', state: 'warm', quarter: 1, warn: 'quarter' },
    cost: { label: 'l', explain: 'e', figures: 'f' },
    offer: { label: 'l', explain: 'e', figures: 'f' },
    paused: 'p',
    warmth: 'w',
    breakEven: 'b',
  },
  tally: {
    pause: { pings: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
    session: { pings: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
    raisedMs: 1,
    epoch: 1,
  },
  judged: { netUsd: 1, pauses: 1 },
  stats: {
    transcript: 't',
    cursor: 'c',
    lastAtMs: 1,
    lastTotal: 1,
    lastTtlMs: 1,
    coldSince: [1],
    misses: {
      lapse: { count: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
      cold: { count: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
      unexplained: { count: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
    },
    overlap: 1,
    saved: {
      count: 1,
      spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' },
      avoided: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' },
    },
    ranOut: { count: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
    notNeeded: { count: 1, spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' } },
    pending: { spend: { input: 1, read: 1, write5m: 1, write1h: 1, usd: 1, why: 'w' }, touchMs: 1, ttlMs: 1, promptMs: 1 },
    longCount: 1,
    maxMs: 1,
    longGaps: [1],
  },
  unit: 'dollars',
} satisfies PluginState['cachier']

// The view's other variants, which SAMPLE's one cannot show.
const VIEWS = [{ kind: 'ttl-unknown' }, { kind: 'no-cache' }, { kind: 'unread' }] satisfies CacheView[]

// A value's keys and kinds, sorted, with no values: what a reload's reader depends on.
const shapeOf = (v: unknown): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(shapeOf).join('|')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${k}:${shapeOf(o[k])}`).join(',')}}`
  }
  return typeof v
}

// FNV-1a, 32 bits, in hex: a short fingerprint to record.
const fnv = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

const fingerprint = () => fnv(shapeOf({ sample: SAMPLE, views: VIEWS, defaults: [INITIAL, INITIAL_TALLY, INITIAL_STATS, NO_JUDGED] }))

// One fingerprint per STATE_SHAPE. Append one when bumping; never edit a recorded one, which a reload under it still reads.
// Shape 1 (0.4.2 to 0.5.x) predates this guard, 2 added the hint's break-even line, and 3 let keepalive's count be unpinned
// and added the run's count, 4 dropped the fetched price list, and 5 wrote the footer line's state as its reading, its paused
// reason and its pane sentences, and dropped the view's both-tags flag, and 6 added the offer a press would turn keepalive on at,
// and 7 gave the reading its quarter step and warning in place of the bar's amber flag, and renamed the pane's bar sentence to the pie's,
// and 8 kept the details' first line in the stored hint as its warmth, and dropped the history sentences, the unit notes, the marker and the bar from it,
// and 9 dropped the keepalive generation from the stored hint, which nothing read, and 10 kept in keepalive's state whether its cost was stated,
// and 11 gave keepalive a run id that only an enable advances, so a run's cost is stated once for that run, and 12 dropped
// keepalive's record of a cost shown (its disclosed and stated flags and the run id), with the gate that held a refresh until then, and 13 added the output tokens of the reply the view's prefix comes from.
const SHAPES: Record<number, string> = {
  2: 'd13a40b8',
  3: 'ce6161ac',
  4: '95ad9e5c',
  5: 'd3a2ba3c',
  6: '3002f38f',
  7: '1ab8b8e5',
  8: '05083c88',
  9: '65ab1b99',
  10: 'ca14d30f',
  11: 'f67817dd',
  12: '684c6cf5',
  13: 'ba479bff',
}

describe('the state shape: a change to a state type moves STATE_SHAPE', () => {
  test("the state's keys and kinds are the ones recorded for the current shape", () => {
    expect(fingerprint()).toBe(SHAPES[STATE_SHAPE])
  })

  test('each recorded shape has its own fingerprint, and the current shape is the newest', () => {
    const recorded = Object.values(SHAPES)
    expect(new Set(recorded).size).toBe(recorded.length)
    expect(Math.max(...Object.keys(SHAPES).map(Number))).toBe(STATE_SHAPE)
  })
})
