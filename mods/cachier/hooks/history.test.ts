import { describe, expect, test } from 'claude-code/testing'
import { appended, HISTORY_BOUND, idOf, keyOf, KEY_PREFIX, merged, recordOf, recordsOf, staleKeys, type PauseRecord } from './history'

const MIN = 60000
// A Tuesday, 9:30 local time.
const T = new Date(2026, 9, 20, 9, 30).getTime()
const rec = (startMs: number, pausedMs = 10 * MIN): PauseRecord => recordOf(startMs, startMs + pausedMs, 24, 300000, 50000, [])

describe('the pause record: timing and price metadata, keyed by session', () => {
  test("a record holds the pause's start, length, local hour and weekday at its start, the ratio and the TTL", () => {
    expect(recordOf(T, T + 12 * MIN, 24, 300000, 50000, [])).toEqual({
      startMs: T,
      pausedMs: 12 * MIN,
      hour: 9,
      weekday: 2,
      ratio: 24,
      ttlMs: 300000,
      contextTokens: 50000,
      grownTokens: 50000,
    })
    expect(recordOf(T, T + MIN, null, 3600000, 50000, []).ratio).toBeNull()
    expect(recordOf(T, T + MIN, 24.000000000000004, 300000, 50000, []).ratio).toBe(24)
  })

  test("the growth is the context's since this session's previous pause, none when it shrank, all of it for the first", () => {
    const first = recordOf(T, T + MIN, 24, 300000, 50000, [])
    expect(recordOf(T + 2 * MIN, T + 3 * MIN, 24, 300000, 53000, [first]).grownTokens).toBe(3000)
    expect(recordOf(T + 2 * MIN, T + 3 * MIN, 24, 300000, 20000, [first]).grownTokens).toBe(0)
    // A record from before the context was kept grows the whole context.
    const old: PauseRecord = { startMs: T, pausedMs: MIN, hour: 9, weekday: 2, ratio: 24, ttlMs: 300000 }
    expect(recordOf(T + 2 * MIN, T + 3 * MIN, 24, 300000, 53000, [old]).grownTokens).toBe(53000)
  })

  test("a session's key is its transcript's id", () => {
    expect(keyOf('/home/u/.claude/projects/p/5566de46-eb71.jsonl')).toBe('pauses/5566de46-eb71')
    expect(keyOf('plain')).toBe('pauses/plain')
  })

  test('a transcript\'s pause key is the key it was before the id was exported, for every shape of path', () => {
    const keys: [path: string, key: string][] = [
      ['/home/u/.claude/projects/p/5566de46-eb71.jsonl', 'pauses/5566de46-eb71'],
      ['5566de46-eb71.jsonl', 'pauses/5566de46-eb71'],
      ['plain', 'pauses/plain'],
      ['/a/b/plain', 'pauses/plain'],
      ['/a/b/notes.json', 'pauses/notes.json'],
      ['/a/b/x.jsonl.jsonl', 'pauses/x.jsonl'],
      ['/a/b/x.jsonlx', 'pauses/x.jsonlx'],
      ['/a/b.jsonl/c', 'pauses/c'],
      ['/a/b/.jsonl', 'pauses/'],
      ['', 'pauses/'],
    ]
    for (const [path, key] of keys) expect([path, keyOf(path)]).toEqual([path, key])
  })

  test('the id is the transcript\'s file name without its extension, the one rule the three key families share', () => {
    expect(idOf('/home/u/.claude/projects/p/5566de46-eb71.jsonl')).toBe('5566de46-eb71')
    expect(idOf('plain')).toBe('plain')
    expect(idOf('/a/b/x.jsonl.jsonl')).toBe('x.jsonl')
    for (const path of ['/a/b/c.jsonl', 'c', '/a/b/notes.json', '']) expect([path, keyOf(path)]).toEqual([path, `${KEY_PREFIX}${idOf(path)}`])
  })

  test('a stored value of another shape reads as no records, and a malformed record is skipped', () => {
    expect(recordsOf(undefined)).toEqual([])
    expect(recordsOf({ startMs: 1 })).toEqual([])
    expect(recordsOf([rec(T), { startMs: 'x' }, null, { ...rec(T), ratio: 'none' }])).toEqual([rec(T)])
  })

  test("a merge adds the held records the read lacks: a pause is the same only in its start, length, context and TTL", () => {
    const own = rec(T)
    // Another session's pause that started at the same moment, of another length and context.
    const other: PauseRecord = { ...rec(T, 3 * MIN), contextTokens: 20000 }
    expect(merged([other], [own])).toEqual([other, own])
    // The same pause, read back from the store, is held once.
    expect(merged([{ ...own }], [own])).toEqual([own])
  })

  test('an append keeps the newest records up to the bound, dropping the oldest', () => {
    expect(appended(undefined, rec(T))).toEqual([rec(T)])
    const full = Array.from({ length: HISTORY_BOUND }, (_, i) => rec(T + i * MIN))
    const next = appended(full, rec(T + HISTORY_BOUND * MIN))
    expect(next.length).toBe(HISTORY_BOUND)
    expect(next[0]).toEqual(rec(T + MIN))
    expect(next[HISTORY_BOUND - 1]).toEqual(rec(T + HISTORY_BOUND * MIN))
  })
})

describe('staleKeys: the trim over every session', () => {
  test('within the bound nothing is deleted', () => {
    expect(staleKeys({ 'pauses/a': [rec(T)], 'pauses/b': [rec(T + MIN)] })).toEqual([])
  })

  test('past the bound, a key holding only pauses older than the newest kept is deleted; one straddling the cut is kept whole', () => {
    const newest = Array.from({ length: HISTORY_BOUND - 1 }, (_, i) => rec(T + (i + 10) * MIN))
    const keys = {
      'pauses/old': [rec(T), rec(T + MIN)],
      'pauses/straddle': [rec(T + 2 * MIN), rec(T + 5 * MIN)],
      'pauses/new': newest,
      'pauses/junk': 'not a list',
    }
    expect(staleKeys(keys)).toEqual(['pauses/old', 'pauses/junk'])
  })
})
