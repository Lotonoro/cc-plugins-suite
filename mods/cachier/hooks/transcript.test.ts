import { describe, expect, test } from 'claude-code/testing'
import { assistant, hostOver, lines, user, CHUNK_BYTES } from './fixture'
import { CHUNK_BYTES as BLOCK, lookupRows, readCache, walkBackward, type Host, type StampEnding, type Unread, type Visit, type Walk } from './transcript'

const T0 = '2026-10-18T10:00:00.000Z'
const T1 = '2026-10-18T10:03:00.000Z'
const T2 = '2026-10-18T10:04:00.000Z'
const ms = (iso: string) => Date.parse(iso)
const FIVE = { five: 18551, one: 0 }
const BOTH = { five: 100, one: 200 }
const ONE = { five: 0, one: 300 }

// The cache reading alone: most tests here are about the view.
const readView = async (host: Parameters<typeof readCache>[0], path: string) => (await readCache(host, path)).view

const walk = (text: string, stopAt?: string) => {
  const seen: string[] = []
  return walkBackward(hostOver(text), '/t.jsonl', (line) => {
    const uuid = JSON.parse(line).uuid as string
    seen.push(uuid)
    return uuid === stopAt ? 'stop' : 'more'
  }).then((status) => ({ status, seen }))
}

describe('walkBackward', () => {
  test('visits rows newest first, across more than one 1 MiB block', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((u) => user({ uuid: u, parent: null, ts: T0, pad: CHUNK_BYTES / 2 }))
    const { status, seen } = await walk(lines(rows))
    expect(status).toBe('covered')
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a'])
  })

  test('stops at the row the visitor names, leaving older rows unvisited', async () => {
    const rows = ['a', 'b', 'c'].map((u) => user({ uuid: u, parent: null, ts: T0 }))
    const { status, seen } = await walk(lines(rows), 'b')
    expect(status).toBe('stop')
    expect(seen).toEqual(['c', 'b'])
  })

  test('an empty file is covered with nothing visited', async () => {
    const { status, seen } = await walk('')
    expect(status).toBe('covered')
    expect(seen).toEqual([])
  })

  test('a row longer than 4 MiB cannot be read whole and the walk says unread', async () => {
    const big = user({ uuid: 'big', parent: null, ts: T0, pad: 4194304 + 10 })
    const { status } = await walk(lines([big, user({ uuid: 'small', parent: null, ts: T0 })]))
    expect(status).toBe('unread')
  })

  test('a row of 3 MiB is read whole', async () => {
    const row = user({ uuid: 'mid', parent: null, ts: T0, pad: 3 * 1048576 })
    const { status, seen } = await walk(lines([row]))
    expect(status).toBe('covered')
    expect(seen).toEqual(['mid'])
  })

  test('an oversized row is reported unread without reading the file back to its start', async () => {
    const text = lines([user({ uuid: 'big', parent: null, ts: T0, pad: 12 * CHUNK_BYTES }), user({ uuid: 'small', parent: null, ts: T0 })])
    const host = hostOver(text)
    let runs = 0
    const counted = { size: host.size, run: async (argv: readonly string[]) => (runs++, host.run(argv)) }
    expect(await walkBackward(counted, '/t.jsonl', () => 'more')).toBe('unread')
    expect(runs).toBeLessThanOrEqual(6)
  })

  test('a failed read is unread, not an empty transcript', async () => {
    const failing = { size: async () => 10, run: async () => ({ exitCode: 1, stdout: '', isStdoutTruncated: false }) }
    expect(await walkBackward(failing, '/t.jsonl', () => 'more')).toBe('unread')
  })

  test('a read whose stdout was truncated is unread', async () => {
    const cut = { size: async () => 10, run: async () => ({ exitCode: 0, stdout: 'x', isStdoutTruncated: true }) }
    expect(await walkBackward(cut, '/t.jsonl', () => 'more')).toBe('unread')
  })
})

describe('readCache', () => {
  test("the view carries the output tokens of the reply row its prefix comes from", async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 18551, tags: FIVE, out: 700 }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', promptTokens: 18559, outputTokens: 700 })
  })

  test('a later reply with no cache use leaves the cache-touching reply\'s output on the view', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 18551, tags: FIVE, out: 700 }),
      user({ uuid: 'u2', parent: 'a1', ts: T1 }),
      assistant({ uuid: 'a2', parent: 'u2', ts: T1, out: 9000 }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', promptTokens: 18559, outputTokens: 700 })
  })

  test('the touch is the time of the row the request answered, not the reply row time (a reply that took minutes)', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T0), ttlMs: 300000, ttlLabel: '5m', promptTokens: 18559, outputTokens: 20, model: null, speed: null })
  })

  test('a newer main-thread response with a cache read and no write moves the touch, the TTL still from the newest write', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 18551, tags: FIVE }),
      user({ uuid: 'u2', parent: 'a1', ts: T1 }),
      assistant({ uuid: 'a2', parent: 'u2', ts: T2, read: 14361 }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T1), ttlMs: 300000, ttlLabel: '5m', promptTokens: 14369, outputTokens: 20, model: null, speed: null })
  })

  test('the prompt size is the touching request\'s uncached input plus its cache read and write, the figure a keepalive ping reads', async () => {
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 }), assistant({ uuid: 'a1', parent: 'u1', ts: T0, read: 100, write: 50, tags: FIVE })])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', promptTokens: 158, outputTokens: 20 })
  })

  test('a write carrying both tags reads the shorter TTL', async () => {
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 }), assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 5, tags: BOTH })])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', ttlMs: 300000, ttlLabel: '5m' })
  })

  test('the view names the model and speed of the touching reply, the price a ping on that cache pays', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 18551, tags: FIVE, model: 'claude-opus-5-5', speed: 'standard' }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', model: 'claude-opus-5-5', speed: 'standard' })
  })

  test('each response carries its model and speed, and its write split by TTL; a write with no split is a 5 m write', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 300, tags: { five: 100, one: 200 }, model: 'claude-sonnet-5-5', speed: 'fast' }),
      user({ uuid: 'u2', parent: 'a1', ts: T1 }),
      assistant({ uuid: 'a2', parent: 'u2', ts: T1, write: 40 }),
    ])
    const out = await readCache(hostOver(text), '/t.jsonl', 'none')
    expect(out.history?.responses.map((r) => [r.model, r.speed, r.write5m, r.write1h])).toEqual([
      ['claude-sonnet-5-5', 'fast', 100, 200],
      [null, null, 40, 0],
    ])
  })

  test('a write carrying only the 1h tag is a 1h TTL', async () => {
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 }), assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 5, tags: ONE })])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', ttlMs: 3600000, ttlLabel: '1h' })
  })

  test('a write with no readable tag is TTL unknown', async () => {
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 }), assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 5 })])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'ttl-unknown' })
  })

  test('a transcript with no cache activity is no cache', async () => {
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 })])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'no-cache' })
  })

  test('a newer subagent or sidechain usage row leaves the countdown unchanged', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 5, tags: FIVE }),
      user({ uuid: 'u2', parent: 'a1', ts: T1 }),
      assistant({ uuid: 's1', parent: 'u2', ts: T2, read: 9, sidechain: true }),
      assistant({ uuid: 'g1', parent: 'u2', ts: T2, read: 9, agentId: 'sub7' }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T0), ttlMs: 300000, ttlLabel: '5m', promptTokens: 13, outputTokens: 20, model: null, speed: null })
  })

  test('a transcript over 4 MiB with its newest write at the start is read block by block to that write', async () => {
    const filler = Array.from({ length: 6 }, (_, i) => user({ uuid: `f${i}`, parent: null, ts: T0, pad: CHUNK_BYTES }))
    const text = lines([
      user({ uuid: 'u0', parent: null, ts: T0 }),
      assistant({ uuid: 'a0', parent: 'u0', ts: T0, write: 5, tags: FIVE }),
      ...filler,
    ])
    expect(text.length).toBeGreaterThan(4 * CHUNK_BYTES)
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T0), ttlMs: 300000, ttlLabel: '5m', promptTokens: 13, outputTokens: 20, model: null, speed: null })
  })

  test('a newest write near the tail is found even when older rows exceed 4 MiB', async () => {
    const big = user({ uuid: 'big', parent: null, ts: T0, pad: 5 * CHUNK_BYTES })
    const text = lines([big, user({ uuid: 'u1', parent: null, ts: T1 }), assistant({ uuid: 'a1', parent: 'u1', ts: T2, write: 7, tags: ONE })])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T1), ttlMs: 3600000, ttlLabel: '1h', promptTokens: 15, outputTokens: 20, model: null, speed: null })
  })

  test('a row over 4 MiB newer than the newest write shows TTL unread', async () => {
    const text = lines([
      user({ uuid: 'u0', parent: null, ts: T0 }),
      assistant({ uuid: 'a0', parent: 'u0', ts: T0, write: 5, tags: FIVE }),
      user({ uuid: 'big', parent: 'a0', ts: T1, pad: 4194304 + 10 }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'unread' })
  })

  test('a touch whose parent row is not in the transcript is unread', async () => {
    const text = lines([assistant({ uuid: 'a1', parent: 'missing', ts: T0, write: 5, tags: FIVE })])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'unread' })
  })

  test('a partly written last row is skipped; the reading comes from the rows before it', async () => {
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 }), assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 5, tags: FIVE })]) + '{"type":"assis'
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T0), ttlMs: 300000, ttlLabel: '5m', promptTokens: 13, outputTokens: 20, model: null, speed: null })
  })

  test('a file whose only row is partly written has no cache activity', async () => {
    expect(await readView(hostOver('{"type":"assis'), '/t.jsonl')).toEqual({ kind: 'no-cache' })
  })

  test('a reply written as several blocks is timed from the row its first block answered, not from a later block', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'b1', parent: 'u1', ts: T1, msg: 'M', write: 18551, tags: FIVE }),
      assistant({ uuid: 'b2', parent: 'b1', ts: T2, msg: 'M', write: 18551, tags: FIVE }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'known', touchMs: ms(T0), ttlMs: 300000, ttlLabel: '5m', promptTokens: 18559, outputTokens: 20, model: null, speed: null })
  })

  test('a three-block reply after a tool result is timed from the tool result row', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'b0', parent: 'u1', ts: T0, msg: 'M0', read: 1 }),
      user({ uuid: 'tr', parent: 'b0', ts: T1 }),
      assistant({ uuid: 'b1', parent: 'tr', ts: T1, msg: 'M1', write: 18551, tags: FIVE }),
      assistant({ uuid: 'b2', parent: 'b1', ts: T2, msg: 'M1', write: 18551, tags: FIVE }),
      assistant({ uuid: 'b3', parent: 'b2', ts: T2, msg: 'M1', write: 18551, tags: FIVE }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', touchMs: ms(T1) })
  })

  test('a parent chain that loops back on itself is unread, not walked forever', async () => {
    const text = lines([
      assistant({ uuid: 'b1', parent: 'b2', ts: T0, msg: 'M', write: 5, tags: FIVE }),
      assistant({ uuid: 'b2', parent: 'b1', ts: T0, msg: 'M', write: 5, tags: FIVE }),
    ])
    expect(await readView(hostOver(text), '/t.jsonl')).toEqual({ kind: 'unread' })
  })
})

describe('lookupRows', () => {
  test('finds each key by its own uuid, not a row that names it as parent', async () => {
    const text = lines([user({ uuid: 'k', parent: null, ts: T0 }), user({ uuid: 'z', parent: 'k', ts: T2 })])
    const found = await lookupRows(hostOver(text), '/t.jsonl', ['k'])
    expect(found.get('k')).toMatchObject({ uuid: 'k', timestampMs: ms(T0) })
  })

  test('a key with no row has no entry', async () => {
    const found = await lookupRows(hostOver(lines([user({ uuid: 'k', parent: null, ts: T0 })])), '/t.jsonl', ['nope'])
    expect(found.get('nope')).toBeUndefined()
  })

  test('a nested field holding the key as a uuid does not match the row', async () => {
    const nested = JSON.stringify({ type: 'user', uuid: 'z', parentUuid: 'k', timestamp: T2, toolUseResult: { uuid: 'k' }, message: { role: 'user', content: 'x' } })
    const text = lines([user({ uuid: 'k', parent: null, ts: T0 }), nested])
    expect((await lookupRows(hostOver(text), '/t.jsonl', ['k'])).get('k')).toMatchObject({ uuid: 'k', timestampMs: ms(T0) })
  })

  test('a key found in the newest block ends the pass there, without reading the rest of the transcript', async () => {
    const text = lines([user({ uuid: 'a', parent: null, ts: T0, pad: CHUNK_BYTES }), user({ uuid: 'b', parent: null, ts: T1, pad: CHUNK_BYTES }), user({ uuid: 'c', parent: null, ts: T2 })])
    const host = hostOver(text)
    let runs = 0
    const counted = { size: host.size, run: async (argv: readonly string[]) => (runs++, host.run(argv)) }
    expect((await lookupRows(counted, '/t.jsonl', ['c'])).get('c')).toBeDefined()
    expect(runs).toBe(1)
  })

  test('several keys are found in one backward pass over the transcript', async () => {
    const text = lines([user({ uuid: 'a', parent: null, ts: T0, pad: CHUNK_BYTES }), user({ uuid: 'b', parent: null, ts: T1, pad: CHUNK_BYTES }), user({ uuid: 'c', parent: null, ts: T2 })])
    const host = hostOver(text)
    let runs = 0
    const counted = { size: host.size, run: async (argv: readonly string[]) => (runs++, host.run(argv)) }
    const found = await lookupRows(counted, '/t.jsonl', ['a', 'c', 'nope'])
    expect(found.get('a')).toBeDefined()
    expect(found.get('c')).toBeDefined()
    expect(found.get('nope')).toBeUndefined()
    expect(runs).toBe(Math.ceil(text.length / CHUNK_BYTES))
  })
})

describe('transcript edges', () => {
  test('an unterminated last row that began in an earlier block is skipped, its head included', async () => {
    const open = '{"type":"user","uuid":"big","x":"' + 'x'.repeat(BLOCK + 100)
    const text = lines([user({ uuid: 'u1', parent: null, ts: T0 })]) + open
    expect((await lookupRows(hostOver(text), '/t.jsonl', ['big'])).get('big')).toBeUndefined()
    expect((await lookupRows(hostOver(text), '/t.jsonl', ['u1'])).get('u1')).toBeDefined()
  })

  test('a reading is not lost to an unterminated row that spans blocks', async () => {
    const open = '{"type":"user","uuid":"big","x":"' + 'x'.repeat(BLOCK + 100)
    const text = lines([user({ uuid: 'u0', parent: null, ts: T0 }), assistant({ uuid: 'a0', parent: 'u0', ts: T0, write: 5, tags: FIVE })]) + open
    expect(await readView(hostOver(text), '/t.jsonl')).toMatchObject({ kind: 'known', touchMs: ms(T0) })
  })

  test('a reply chain several blocks deep is followed in one backward pass over the transcript', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      user({ uuid: 'pad1', parent: 'u1', ts: T0, pad: BLOCK }),
      user({ uuid: 'pad2', parent: 'pad1', ts: T0, pad: BLOCK }),
      assistant({ uuid: 'b1', parent: 'pad2', ts: T1, msg: 'M', read: 9 }),
      assistant({ uuid: 'b2', parent: 'b1', ts: T1, msg: 'M', read: 9 }),
      assistant({ uuid: 'b3', parent: 'b2', ts: T1, msg: 'M', read: 9 }),
      assistant({ uuid: 'b4', parent: 'b3', ts: T2, msg: 'M', write: 18551, tags: FIVE }),
    ])
    const host = hostOver(text)
    let runs = 0
    const counted = { size: host.size, run: async (argv: readonly string[]) => (runs++, host.run(argv)) }
    expect(await readView(counted, '/t.jsonl')).toMatchObject({ kind: 'known', touchMs: ms(T0) })
    expect(runs).toBeLessThanOrEqual(Math.ceil(text.length / BLOCK) + 1)
  })
})


describe('readCache: the same pass also yields the main-thread responses, for the stats', () => {
  test('a first read stops at the newest write and reads no older block', async () => {
    const text = lines([
      user({ uuid: 'big', parent: null, ts: T0, pad: CHUNK_BYTES }),
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
    ])
    const whole = hostOver(text)
    const reads: string[] = []
    const counted = { size: whole.size, run: async (argv: readonly string[]) => (reads.push(argv.join(' ')), whole.run(argv)) }
    await readCache(counted, '/t.jsonl', null)
    expect(reads.some((r) => r.includes('skip=0'))).toBe(false)
  })

  test('a block the walk cannot read, reached after the reading has settled, leaves the reading known', async () => {
    const text = lines([
      user({ uuid: 'big', parent: null, ts: T0, pad: CHUNK_BYTES }),
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
    ])
    const whole = hostOver(text)
    const oldBlockFails = { size: whole.size, run: async (argv: readonly string[]) => (argv.includes('skip=0') ? { exitCode: 1, stdout: '', isStdoutTruncated: false } : whole.run(argv)) }
    // The cursor is not in the file, so the pass goes on past the view's stop, to the block that cannot be read.
    const { view } = await readCache(oldBlockFails, '/t.jsonl', 'zz')
    expect(view.kind).toBe('known')
  })

  test('a first read takes only the newest response, and says the history starts there', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
      assistant({ uuid: 'a2', parent: 'a1', ts: T2, read: 18551, write: 10, tags: FIVE, msg: 'm2' }),
    ])
    const { history } = await readCache(hostOver(text), '/t.jsonl', null)
    expect(history?.recount).toBe(true)
    expect(history?.responses.map((r) => [r.messageId, r.read, r.write])).toEqual([['m2', 18551, 10]])
    expect(history?.responses[0]?.timestampMs).toBe(ms(T2))
    expect(history?.responses[0]?.ttlMs).toBe(300000)
  })

  test('a cursor stops the same pass at the response it already counted, so only newer responses come back', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
      assistant({ uuid: 'a2', parent: 'a1', ts: T2, read: 18551, write: 10, tags: FIVE, msg: 'm2' }),
    ])
    const { history, view } = await readCache(hostOver(text), '/t.jsonl', 'm1')
    expect(history?.recount).toBe(false)
    expect(history?.responses.map((r) => r.messageId)).toEqual(['m2'])
    expect(view.kind).toBe('known')
  })

  test('the message its rows share is one response: its usage is taken once', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
      assistant({ uuid: 'a2', parent: 'a1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
    ])
    const { history } = await readCache(hostOver(text), '/t.jsonl', 'zz')
    expect(history?.responses).toHaveLength(1)
  })

  test('an unparsable row between the cursor and the newest response does not restart the counts', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T0, write: 18551, tags: FIVE, msg: 'm1' }),
      'not a json row',
      assistant({ uuid: 'a2', parent: 'a1', ts: T1, read: 18551, write: 10, tags: FIVE, msg: 'm2' }),
    ])
    const { history } = await readCache(hostOver(text), '/t.jsonl', 'm1')
    expect(history?.recount).toBe(false)
    expect(history?.responses.map((r) => r.messageId)).toEqual(['m2'])
  })

  test('a first read keeps the newest response alone, even when a read-only reply came after the newest write', async () => {
    const text = lines([
      user({ uuid: 'u1', parent: null, ts: T0 }),
      assistant({ uuid: 'a1', parent: 'u1', ts: T1, write: 18551, tags: FIVE, msg: 'm1' }),
      assistant({ uuid: 'a2', parent: 'a1', ts: T2, read: 18551, write: 0, msg: 'm2' }),
    ])
    const { history } = await readCache(hostOver(text), '/t.jsonl', null)
    expect(history?.responses.map((r) => r.messageId)).toEqual(['m2'])
  })
})

// How a walk ends, as the observer the walk and the stamp lookup take tells it. Each unread ending has a transcript built to end it that way.
const CAP = 4194304
const FAILED = { exitCode: 1, isStdoutTruncated: false }
const CUT = { exitCode: 0, isStdoutTruncated: true }

// A user row of exactly `bytes` bytes: its text is ASCII, so a character is a byte.
const userOf = (uuid: string, bytes: number) => user({ uuid, parent: null, ts: T0, pad: bytes - user({ uuid, parent: null, ts: T0, pad: 0 }).length })
// A row that names `uuid` and is cut off before it closes, so it does not parse.
const unparsable = (uuid: string) => `{"type":"user","uuid":"${uuid}","note":"cut`
// Rows a, b and c over three blocks, c the newest: the first read holds c and the tail of b.
const spread = () => hostOver(lines([user({ uuid: 'a', parent: null, ts: T0, pad: BLOCK }), user({ uuid: 'b', parent: null, ts: T1, pad: BLOCK }), user({ uuid: 'c', parent: null, ts: T2 })]))
// The host of rows a, b and c, but its read of block 1 is answered with `answer` and no output: the walk's second read.
const refusedAtSecondRead = (answer: { exitCode: number; isStdoutTruncated: boolean }): Host => {
  const whole = spread()
  return { size: whole.size, run: async (argv) => (argv.includes('skip=1') ? { ...answer, stdout: '' } : whole.run(argv)) }
}
const small = () => user({ uuid: 'small', parent: null, ts: T1 })
// A row of 5 MiB and a little, older than a small one. The walk carries it back a block at a time and ends past the cap in its 5th read, before the file's start.
const carriedPastCap = () => hostOver(lines([userOf('big', 5 * BLOCK + 1000), small()]))
// The same row last in the file and not yet terminated, as Claude Code is still writing it.
const openPastCap = () => hostOver(lines([small()]) + userOf('big', 5 * BLOCK + 1000))
// A row of one byte over the cap that starts 100 bytes before a block boundary: the carry never passes the cap, and the row is met whole, as a line, in the walk's 6th read.
const lineOverCap = () => hostOver(lines([userOf('first', BLOCK - 101), userOf('big', CAP + 1), small()]))
// A row naming `bad` that does not parse, with an older row before it and a padded row after it that puts it in the older of two blocks, then a newer row.
const unparsedMid = () => hostOver(lines([user({ uuid: 'first', parent: null, ts: T0 }), unparsable('bad'), user({ uuid: 'pad', parent: null, ts: T0, pad: BLOCK }), user({ uuid: 'newer', parent: null, ts: T1 })]))
// The same row as the first of the file, which the walk meets last, as the row left in its carry.
const unparsedFirst = () => hostOver(lines([unparsable('bad'), user({ uuid: 'pad', parent: null, ts: T0, pad: BLOCK }), user({ uuid: 'newer', parent: null, ts: T1 })]))

const more = (): Visit => 'more'
const answersUnreadAtBad = (line: string): Visit => (line.includes('"uuid":"bad"') ? 'unread' : 'more')
const stopsAtC = (line: string): Visit => (line.includes('"uuid":"c"') ? 'stop' : 'more')

describe('walkBackward: the observer is told why a walk ended unread, once, and nothing when it did not', () => {
  const cases: [name: string, host: () => Host, visit: (line: string) => Visit, status: Walk, why: Unread | null][] = [
    ['a block read that exits nonzero', () => refusedAtSecondRead(FAILED), more, 'unread', 'read-failed'],
    ['a block read whose stdout is truncated', () => refusedAtSecondRead(CUT), more, 'unread', 'read-truncated'],
    ['a row carried past the cap', carriedPastCap, more, 'unread', 'row-over-cap'],
    ['an unterminated last row carried past the cap', openPastCap, more, 'unread', 'row-over-cap'],
    ['a line over the cap, met whole after the carry check passed it', lineOverCap, more, 'unread', 'row-over-cap'],
    ['a visit answering unread, mid-file', unparsedMid, answersUnreadAtBad, 'unread', 'visitor-unread'],
    ['a visit answering unread at the first row of the file', unparsedFirst, answersUnreadAtBad, 'unread', 'visitor-unread'],
    ['a visit that stops the walk', spread, stopsAtC, 'stop', null],
    ['a file covered to its start', spread, more, 'covered', null],
    ['an empty file', () => hostOver(''), more, 'covered', null],
  ]
  for (const [name, host, visit, status, why] of cases) {
    test(`${name}: the walk is ${status} with or without an observer, which is told ${why === null ? 'nothing' : why}`, async () => {
      const told: Unread[] = []
      expect(await walkBackward(host(), '/t.jsonl', visit)).toBe(status)
      expect(await walkBackward(host(), '/t.jsonl', visit, (reason) => told.push(reason))).toBe(status)
      expect(told).toEqual(why === null ? [] : [why])
    })
  }
})

describe('lookupRows: a stamp lookup reports how its walk ended, and the block reads it started', () => {
  const cases: [name: string, host: () => Host, keys: string[], ending: StampEnding, found: string[]][] = [
    ['whose block read exits nonzero', () => refusedAtSecondRead(FAILED), ['c', 'a'], { reason: 'read-failed', blocksRead: 2 }, ['c']],
    ['whose block read is truncated', () => refusedAtSecondRead(CUT), ['c', 'a'], { reason: 'read-truncated', blocksRead: 2 }, ['c']],
    ['that meets a row over 4 MiB carried back block by block', carriedPastCap, ['small', 'big'], { reason: 'row-over-cap', blocksRead: 5 }, ['small']],
    ['that meets an unterminated last row over 4 MiB', openPastCap, ['small'], { reason: 'row-over-cap', blocksRead: 5 }, []],
    ['that meets a row over 4 MiB as a line the carry check passed', lineOverCap, ['small', 'first'], { reason: 'row-over-cap', blocksRead: 6 }, ['small']],
    ['that meets a row naming a wanted id that is not valid JSON', unparsedMid, ['newer', 'bad', 'first'], { reason: 'row-unparsed', blocksRead: 2 }, ['newer']],
    ['that meets such a row as the first of the file', unparsedFirst, ['newer', 'bad'], { reason: 'row-unparsed', blocksRead: 2 }, ['newer']],
    ['that stops with every id found', spread, ['c'], { reason: null, blocksRead: 1 }, ['c']],
    ['that covers the file with an id missing', spread, ['a', 'nope'], { reason: null, blocksRead: 3 }, ['a']],
    ['over an empty file', () => hostOver(''), ['k'], { reason: null, blocksRead: 0 }, []],
  ]
  for (const [name, host, keys, ending, found] of cases) {
    test(`a lookup ${name} reports one ending, ${ending.reason ?? 'with no reason'}, and finds the same rows with or without an observer`, async () => {
      const endings: StampEnding[] = []
      const rows = await lookupRows(host(), '/t.jsonl', keys, (e) => endings.push(e))
      expect(endings).toEqual([ending])
      expect([...rows.keys()].sort()).toEqual(found)
      expect([...rows]).toEqual([...(await lookupRows(host(), '/t.jsonl', keys))])
    })
  }

  test('a lookup whose host read throws reports no ending', async () => {
    const endings: StampEnding[] = []
    const throwing: Host = { size: async () => 10, run: async () => Promise.reject(new Error('read refused')) }
    await expect(lookupRows(throwing, '/t.jsonl', ['k'], (e) => endings.push(e))).rejects.toThrow('read refused')
    expect(endings).toEqual([])
  })
})
