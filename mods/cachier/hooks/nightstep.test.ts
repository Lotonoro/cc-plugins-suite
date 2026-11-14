import { describe, expect, test } from 'claude-code/testing'
import { ACTION_PREFIX, nightAction, nightClean, nightLearn, nightRead, nightScan, nightState, nightStepped, STEP_PREFIX } from './nightstep'

const MIN = 60000
const H = 60 * MIN
const DAY = 24 * H
// The module reads no local field, so an instant in UTC serves.
const NOW = Date.parse('2026-01-14T03:00:00.000Z')
const PATH = '/home/test/.claude/projects/p/s1.jsonl'
const OTHER_PATH = '/home/test/.claude/projects/p/s2.jsonl'

// The engine's store, clock and debug log, as nightstep reads them. A read or a write of a key in a refusal set throws, and a read of a key with a hold waits for it.
const makeWorld = (seed: Record<string, unknown> = {}) => {
  const values = new Map<string, unknown>(Object.entries(seed))
  const calls: string[] = []
  const logs: string[] = []
  const refused = { get: new Set<string>(), set: new Set<string>(), delete: new Set<string>(), keys: false }
  const holds = new Map<string, Promise<void>>()
  const dollar = {
    store: {
      get: async (key: string) => {
        calls.push(`get ${key}`)
        await holds.get(key)
        if (refused.get.has(key)) throw new Error(`read of ${key} refused`)
        return values.get(key)
      },
      set: async (key: string, value: unknown) => {
        calls.push(`set ${key}`)
        if (refused.set.has(key)) throw new Error(`write of ${key} refused`)
        values.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string) => {
        calls.push(`delete ${key}`)
        if (refused.delete.has(key)) throw new Error(`delete of ${key} refused`)
        values.delete(key)
      },
      keys: async () => {
        calls.push('keys')
        if (refused.keys) throw new Error('keys refused')
        return [...values.keys()]
      },
    },
    clock: { now: async () => NOW },
    ui: { log: (text: string) => void logs.push(text) },
  }
  return { dollar: dollar as any, values, calls, logs, refused, holds }
}
const deferred = () => {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
// A learned session: its path taught and its own keys read.
const learned = async (w: ReturnType<typeof makeWorld>, path = PATH) => {
  const state = nightState()
  await nightLearn(w.dollar, state, path)
  return state
}

describe('a session\'s own keys: the step mark and the action time, each a plain number under the session\'s id', () => {
  test('a state starts with no session, nothing read, no time and no scan', () => {
    expect(nightState()).toMatchObject({ id: null, read: false, stepMs: null, actionMs: null, scan: { kind: 'none' } })
  })

  test('the families are named for the keys', () => {
    expect(STEP_PREFIX).toBe('overnight/')
    expect(ACTION_PREFIX).toBe('prompted/')
  })

  test('learning a path reads the session\'s own two keys, by the transcript\'s id, and no other key', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - 3 * H, 'prompted/s1': NOW - 2 * H, 'overnight/s2': NOW - H, 'prompted/s2': NOW - H, 'pauses/s1': [] })
    const state = await learned(w)
    expect(state).toMatchObject({ id: 's1', read: true, stepMs: NOW - 3 * H, actionMs: NOW - 2 * H })
    expect(w.calls.sort()).toEqual(['get overnight/s1', 'get prompted/s1'])
  })

  test('keys never written read as no times, and the read has still landed', async () => {
    const state = await learned(makeWorld())
    expect(state).toMatchObject({ read: true, stepMs: null, actionMs: null })
  })

  test('a mark written is read back by the next load of the session: its time and its action time round-trip', async () => {
    const w = makeWorld()
    const first = await learned(w)
    await nightStepped(w.dollar, first, NOW - 40 * MIN)
    await nightAction(w.dollar, first, NOW - 10 * MIN)
    expect(w.values.get('overnight/s1')).toBe(NOW - 40 * MIN)
    expect(w.values.get('prompted/s1')).toBe(NOW - 10 * MIN)
    const reloaded = await learned(w)
    expect(reloaded).toMatchObject({ read: true, stepMs: NOW - 40 * MIN, actionMs: NOW - 10 * MIN })
  })

  test('another session\'s keys are another session\'s: they are not this one\'s times', async () => {
    const w = makeWorld({ 'overnight/s2': NOW - H, 'prompted/s2': NOW - H })
    expect(await learned(w)).toMatchObject({ stepMs: null, actionMs: null })
  })

  test('a value of another shape reads as no time', async () => {
    for (const value of ['12', 'x', {}, [NOW - H], true, null, Number.NaN, [], { at: NOW - H }]) {
      const state = await learned(makeWorld({ 'overnight/s1': value, 'prompted/s1': value }))
      expect([value, state.read, state.stepMs, state.actionMs]).toEqual([value, true, null, null])
    }
  })

  test('a time later than now reads as no time, and one at now is a time', async () => {
    const w = makeWorld({ 'overnight/s1': NOW + 1, 'prompted/s1': NOW + H })
    expect(await learned(w)).toMatchObject({ read: true, stepMs: null, actionMs: null })
    expect(await learned(makeWorld({ 'overnight/s1': NOW, 'prompted/s1': NOW }))).toMatchObject({ stepMs: NOW, actionMs: NOW })
  })

  test('the same path taught again changes nothing and reads nothing', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - H })
    const state = await learned(w)
    w.calls.length = 0
    w.values.set('overnight/s1', NOW - 2 * H)
    await nightLearn(w.dollar, state, PATH)
    expect(w.calls).toEqual([])
    expect(state.stepMs).toBe(NOW - H)
  })

  test('a different path starts the session\'s own times over: the new id\'s are read, and the old id\'s are not kept', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - H, 'prompted/s1': NOW - H, 'overnight/s2': NOW - 5 * H })
    const state = await learned(w)
    await nightLearn(w.dollar, state, OTHER_PATH)
    expect(state).toMatchObject({ id: 's2', read: true, stepMs: NOW - 5 * H, actionMs: null })
  })

  test('a read that lands after the path moved on is not applied to the new session', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - H, 'prompted/s1': NOW - H, 'overnight/s2': NOW - 5 * H })
    const hold = deferred()
    w.holds.set('prompted/s1', hold.promise)
    const state = nightState()
    const slow = nightLearn(w.dollar, state, PATH)
    await nightLearn(w.dollar, state, OTHER_PATH)
    hold.release()
    await slow
    expect(state).toMatchObject({ id: 's2', read: true, stepMs: NOW - 5 * H, actionMs: null })
  })
})

describe('a failed read of the own keys: reported once while it keeps failing, and read again by the next call', () => {
  test('a refused read leaves the state unread and logs the error once; each retry reads again and logs nothing more', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - H })
    w.refused.get.add('prompted/s1')
    const state = await learned(w)
    expect(state).toMatchObject({ id: 's1', read: false, stepMs: null })
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('read of prompted/s1 refused')
    for (let i = 0; i < 3; i++) await nightRead(w.dollar, state)
    expect(state.read).toBe(false)
    expect(w.logs).toHaveLength(1)
    expect(w.calls.filter((call) => call === 'get prompted/s1')).toHaveLength(4)
  })

  test('the retry that lands reads both keys and has the state read; a later failure is reported again', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - H, 'prompted/s1': NOW - 30 * MIN })
    w.refused.get.add('overnight/s1')
    const state = await learned(w)
    w.refused.get.clear()
    await nightRead(w.dollar, state)
    expect(state).toMatchObject({ read: true, stepMs: NOW - H, actionMs: NOW - 30 * MIN })
    // A read that has landed is not made again.
    w.calls.length = 0
    await nightRead(w.dollar, state)
    expect(w.calls).toEqual([])
    // A new path whose read fails is reported, though the old path's failure was.
    w.refused.get.add('overnight/s2')
    await nightLearn(w.dollar, state, OTHER_PATH)
    expect(w.logs).toHaveLength(2)
  })

  test('a read is not made twice at once: a call while one is running does nothing', async () => {
    const w = makeWorld()
    const hold = deferred()
    w.holds.set('overnight/s1', hold.promise)
    const state = nightState()
    const first = nightLearn(w.dollar, state, PATH)
    await nightRead(w.dollar, state)
    expect(w.calls).toEqual(['get overnight/s1'])
    hold.release()
    await first
    expect(state.read).toBe(true)
  })

  test('a call before any path is taught reads nothing', async () => {
    const w = makeWorld()
    const state = nightState()
    await nightRead(w.dollar, state)
    expect(w.calls).toEqual([])
    expect(state.read).toBe(false)
  })

  test('a read that failed keeps what the session set in memory meanwhile, and a stored time does not lower it', async () => {
    const w = makeWorld({ 'prompted/s1': NOW - 3 * H })
    w.refused.get.add('overnight/s1')
    const state = await learned(w)
    await nightAction(w.dollar, state, NOW - 5 * MIN)
    w.refused.get.clear()
    await nightRead(w.dollar, state)
    expect(state).toMatchObject({ read: true, actionMs: NOW - 5 * MIN })
  })
})

describe('the action time: set in memory at once, written to the session\'s key without a read', () => {
  test('the time is in memory before the call returns control, and the write follows it', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.calls.length = 0
    const written = nightAction(w.dollar, state, NOW - MIN)
    expect(state.actionMs).toBe(NOW - MIN)
    await written
    expect(w.values.get('prompted/s1')).toBe(NOW - MIN)
    expect(w.calls).toEqual(['set prompted/s1'])
  })

  test('the write reads nothing first', async () => {
    const w = makeWorld({ 'prompted/s1': NOW - 5 * H })
    const state = await learned(w)
    w.calls.length = 0
    await nightAction(w.dollar, state, NOW - MIN)
    expect(w.calls.filter((call) => call.startsWith('get'))).toEqual([])
  })

  test('a time set before the session\'s path is learned is held, and written once the path is learned', async () => {
    const w = makeWorld()
    const state = nightState()
    await nightAction(w.dollar, state, NOW - 20 * MIN)
    expect(state.actionMs).toBe(NOW - 20 * MIN)
    expect(w.calls).toEqual([])
    await nightLearn(w.dollar, state, PATH)
    expect(w.values.get('prompted/s1')).toBe(NOW - 20 * MIN)
    expect(state).toMatchObject({ read: true, actionMs: NOW - 20 * MIN })
  })

  test('two times set before the path is learned write the later one, once', async () => {
    const w = makeWorld()
    const state = nightState()
    await nightAction(w.dollar, state, NOW - 20 * MIN)
    await nightAction(w.dollar, state, NOW - 10 * MIN)
    await nightLearn(w.dollar, state, PATH)
    expect(w.values.get('prompted/s1')).toBe(NOW - 10 * MIN)
    expect(w.calls.filter((call) => call.startsWith('set'))).toEqual(['set prompted/s1'])
  })

  test('a time set before the path is learned beats an older stored time', async () => {
    const w = makeWorld({ 'prompted/s1': NOW - 3 * H })
    const state = nightState()
    await nightAction(w.dollar, state, NOW - 10 * MIN)
    await nightLearn(w.dollar, state, PATH)
    expect(state.actionMs).toBe(NOW - 10 * MIN)
    expect(w.values.get('prompted/s1')).toBe(NOW - 10 * MIN)
  })

  test('a time set before the path is learned is written whether or not the own keys can be read', async () => {
    const w = makeWorld()
    w.refused.get.add('overnight/s1')
    const state = nightState()
    await nightAction(w.dollar, state, NOW - 10 * MIN)
    await nightLearn(w.dollar, state, PATH)
    expect(state.read).toBe(false)
    expect(w.values.get('prompted/s1')).toBe(NOW - 10 * MIN)
  })

  test('a write that throws is reported, and the time stays in memory: it is not written again', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.set.add('prompted/s1')
    await nightAction(w.dollar, state, NOW - MIN)
    expect(state.actionMs).toBe(NOW - MIN)
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('write of prompted/s1 refused')
    expect(w.values.has('prompted/s1')).toBe(false)
    w.calls.length = 0
    await nightRead(w.dollar, state)
    await nightLearn(w.dollar, state, PATH)
    expect(w.calls).toEqual([])
  })
})

describe('the step mark: set in memory as the step lands, then written under the session\'s key', () => {
  test('the time is in memory at once, and the key holds it once the write lands', async () => {
    const w = makeWorld()
    const state = await learned(w)
    const written = nightStepped(w.dollar, state, NOW - 40 * MIN)
    expect(state.stepMs).toBe(NOW - 40 * MIN)
    await written
    expect(w.values.get('overnight/s1')).toBe(NOW - 40 * MIN)
  })

  test('a write that throws is reported once, and the mark stays in memory', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.set.add('overnight/s1')
    await nightStepped(w.dollar, state, NOW - 40 * MIN)
    expect(state.stepMs).toBe(NOW - 40 * MIN)
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('write of overnight/s1 refused')
    expect(w.values.has('overnight/s1')).toBe(false)
  })

  test('the mark is not read before it is written', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - 5 * H })
    const state = await learned(w)
    w.calls.length = 0
    await nightStepped(w.dollar, state, NOW - 40 * MIN)
    expect(w.calls).toEqual(['set overnight/s1'])
  })
})

describe('the scan: the newest action time over every session\'s key', () => {
  test('it finds the newest of several sessions\' times, and records when it scanned', async () => {
    const w = makeWorld({ 'prompted/a': NOW - 3 * H, 'prompted/b': NOW - 20 * MIN, 'prompted/c': NOW - 5 * H })
    const state = nightState()
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW - 20 * MIN })
  })

  test('it reads the keys of its family one after another, and no key of another family', async () => {
    const w = makeWorld({
      'pauses/a': [],
      'prompted/a': NOW - H,
      'overnight/a': NOW - 10 * MIN,
      'prices': {},
      'prompted/b': NOW - 2 * H,
      'prompted': NOW - MIN,
      'notice/a': NOW - MIN,
    })
    const state = nightState()
    await nightScan(w.dollar, state, NOW)
    expect(w.calls).toEqual(['keys', 'get prompted/a', 'get prompted/b'])
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW - H })
  })

  test('no session\'s key is a clear scan with no newest time', async () => {
    const state = nightState()
    await nightScan(makeWorld({ 'overnight/a': NOW - MIN }).dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: null })
  })

  test('a value of another shape is no time, and does not hide an older time', async () => {
    const w = makeWorld({ 'prompted/a': 'x', 'prompted/b': { at: NOW }, 'prompted/c': null, 'prompted/d': NOW - 2 * H, 'prompted/e': [NOW - MIN] })
    const state = nightState()
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW - 2 * H })
  })

  test('a time later than now is no time, and does not hide an older one; one at now is the newest', async () => {
    const w = makeWorld({ 'prompted/a': NOW + 1, 'prompted/b': NOW + 5 * H, 'prompted/c': NOW - 3 * H })
    const state = nightState()
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW - 3 * H })
    w.values.set('prompted/d', NOW)
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW })
  })

  test('the scan reads live keys: the session\'s own action key is one of them', async () => {
    const w = makeWorld({ 'prompted/s1': NOW - 5 * MIN })
    const state = await learned(w)
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW - 5 * MIN })
  })

  test('a refused key list is a failed scan, reported once while scans keep failing', async () => {
    const w = makeWorld({ 'prompted/a': NOW - H })
    w.refused.keys = true
    const state = nightState()
    for (let i = 0; i < 3; i++) await nightScan(w.dollar, state, NOW + i * 1000)
    expect(state.scan).toEqual({ kind: 'failed' })
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('keys refused')
  })

  test('a refused read of one key is a failed scan too, with no time taken from the keys read before it', async () => {
    const w = makeWorld({ 'prompted/a': NOW - 10 * MIN, 'prompted/b': NOW - 20 * MIN })
    w.refused.get.add('prompted/b')
    const state = nightState()
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'failed' })
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('read of prompted/b refused')
  })

  test('a scan that lands replaces a failure, and a failure after it is reported again', async () => {
    const w = makeWorld({ 'prompted/a': NOW - H })
    w.refused.keys = true
    const state = nightState()
    await nightScan(w.dollar, state, NOW)
    w.refused.keys = false
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'done', atMs: NOW, newestMs: NOW - H })
    w.refused.keys = true
    await nightScan(w.dollar, state, NOW)
    expect(state.scan).toEqual({ kind: 'failed' })
    expect(w.logs).toHaveLength(2)
  })
})

describe('the clean-up of old keys: only the two families, only a key two days old or of another shape, never the session\'s own', () => {
  const all = (w: ReturnType<typeof makeWorld>) => [...w.values.keys()].sort()
  // A session that has learned its id, `known`, which no key under test carries, with the calls of its learn forgotten: a clean is asked of a session that has one.
  const known = async (w: ReturnType<typeof makeWorld>) => {
    const state = await learned(w, '/home/test/.claude/projects/p/known.jsonl')
    w.calls.length = 0
    return state
  }

  test('a key older than two days is deleted, in either family, and a key two days old or younger is kept', async () => {
    const w = makeWorld({
      'overnight/old': NOW - 2 * DAY - 1,
      'prompted/old': NOW - 2 * DAY - 1,
      'overnight/edge': NOW - 2 * DAY,
      'prompted/edge': NOW - 2 * DAY,
      'overnight/young': NOW - DAY,
      'prompted/young': NOW - MIN,
    })
    await nightClean(w.dollar, await known(w), [...w.values.keys()], NOW)
    expect(all(w)).toEqual(['overnight/edge', 'overnight/young', 'prompted/edge', 'prompted/young'])
  })

  test('a key whose value is of another shape is deleted, in either family', async () => {
    const w = makeWorld({ 'overnight/a': 'x', 'prompted/a': { at: NOW }, 'overnight/b': null, 'prompted/b': [NOW], 'overnight/c': true, 'prompted/c': Number.NaN, 'prompted/ok': NOW })
    await nightClean(w.dollar, await known(w), [...w.values.keys()], NOW)
    expect(all(w)).toEqual(['prompted/ok'])
  })

  test('a key dated in the future is kept: it is not old, and a clock set back must not cost another session its times', async () => {
    const w = makeWorld({ 'overnight/future': NOW + 3 * DAY, 'prompted/future': NOW + 1 })
    await nightClean(w.dollar, await known(w), [...w.values.keys()], NOW)
    expect(all(w)).toEqual(['overnight/future', 'prompted/future'])
  })

  test('the session\'s own keys are kept however old, and its neighbours\' are not', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - 9 * DAY, 'prompted/s1': NOW - 9 * DAY, 'overnight/s2': NOW - 9 * DAY, 'prompted/s2': NOW - 9 * DAY })
    const state = await learned(w)
    await nightClean(w.dollar, state, [...w.values.keys()], NOW)
    expect(all(w)).toEqual(['overnight/s1', 'prompted/s1'])
  })

  test('a key of any other family is neither read nor deleted, however old it is or whatever it holds', async () => {
    const w = makeWorld({
      'pauses/s9': [{ startMs: 1 }],
      'prices': 'x',
      'notice/overnight': 1,
      'overnight': 1,
      'prompted': 1,
      'prompted-s1': 1,
      'xovernight/a': 1,
      'overnight/old': NOW - 3 * DAY,
    })
    await nightClean(w.dollar, await known(w), [...w.values.keys()], NOW)
    expect(w.calls).toEqual(['get overnight/old', 'delete overnight/old'])
    expect(all(w)).toEqual(['notice/overnight', 'overnight', 'pauses/s9', 'prices', 'prompted', 'prompted-s1', 'xovernight/a'])
  })

  test('a key is read once, and deleted only when the read says it is old: a young key is not deleted, and the list is the one given', async () => {
    const w = makeWorld({ 'overnight/young': NOW - MIN, 'prompted/young': NOW - MIN, 'prompted/unlisted': NOW - 9 * DAY })
    await nightClean(w.dollar, await known(w), ['overnight/young', 'prompted/young'], NOW)
    expect(w.calls).toEqual(['get overnight/young', 'get prompted/young'])
    expect(w.values.has('prompted/unlisted')).toBe(true)
  })

  test('a refused delete is reported once, and the other keys are still tried', async () => {
    const w = makeWorld({ 'overnight/a': NOW - 3 * DAY, 'prompted/a': NOW - 3 * DAY, 'overnight/b': NOW - 3 * DAY, 'prompted/b': NOW - 3 * DAY })
    w.refused.delete.add('overnight/a')
    w.refused.delete.add('prompted/b')
    await nightClean(w.dollar, await known(w), [...w.values.keys()], NOW)
    expect(all(w)).toEqual(['overnight/a', 'prompted/b'])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('delete of overnight/a refused')
  })

  test('a refused read is reported once, leaves that key, and the other keys are still cleaned', async () => {
    const w = makeWorld({ 'overnight/a': NOW - 3 * DAY, 'prompted/a': NOW - 3 * DAY, 'overnight/b': NOW - 3 * DAY })
    w.refused.get.add('overnight/a')
    await nightClean(w.dollar, await known(w), [...w.values.keys()], NOW)
    expect(all(w)).toEqual(['overnight/a'])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('read of overnight/a refused')
  })

  test('an empty list reads and deletes nothing', async () => {
    const w = makeWorld({ 'overnight/old': NOW - 3 * DAY })
    await nightClean(w.dollar, await known(w), [], NOW)
    expect(w.calls).toEqual([])
  })

  test('a clean asked before the session\'s id is known reads and deletes nothing, and the learn then cleans the list as asked, the learned id\'s keys spared', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - 9 * DAY, 'prompted/s1': NOW - 9 * DAY, 'overnight/s2': NOW - 9 * DAY, 'prompted/s2': NOW - 9 * DAY, 'prompted/s3': NOW - MIN })
    const state = nightState()
    await nightClean(w.dollar, state, [...w.values.keys()], NOW)
    expect(w.calls).toEqual([])
    expect(all(w)).toEqual(['overnight/s1', 'overnight/s2', 'prompted/s1', 'prompted/s2', 'prompted/s3'])
    await nightLearn(w.dollar, state, PATH)
    expect(all(w)).toEqual(['overnight/s1', 'prompted/s1', 'prompted/s3'])
  })

  test('a clean waits for the first id only: the learn of another id later cleans nothing', async () => {
    const w = makeWorld({ 'overnight/old': NOW - 9 * DAY })
    const state = nightState()
    await nightClean(w.dollar, state, ['overnight/old'], NOW)
    await nightLearn(w.dollar, state, PATH)
    expect(all(w)).toEqual([])
    w.values.set('overnight/old', NOW - 9 * DAY)
    w.calls.length = 0
    await nightLearn(w.dollar, state, OTHER_PATH)
    expect(w.calls).toEqual(['get overnight/s2', 'get prompted/s2'])
    expect(all(w)).toEqual(['overnight/old'])
  })

  test('a clean asked twice before the id is known cleans, once it is learned, the list asked last', async () => {
    const w = makeWorld({ 'overnight/gone': NOW - 9 * DAY, 'overnight/s2': NOW - 9 * DAY })
    const state = nightState()
    await nightClean(w.dollar, state, ['overnight/gone', 'overnight/s2'], NOW)
    await nightClean(w.dollar, state, ['overnight/s2'], NOW)
    await nightLearn(w.dollar, state, PATH)
    expect(w.calls).toEqual(['get overnight/s1', 'get prompted/s1', 'get overnight/s2', 'delete overnight/s2'])
  })

  test('a clean asked once the id is known runs at once, and waits for nothing', async () => {
    const w = makeWorld({ 'overnight/s2': NOW - 9 * DAY })
    const state = await learned(w)
    w.calls.length = 0
    await nightClean(w.dollar, state, ['overnight/s2'], NOW)
    expect(w.calls).toEqual(['get overnight/s2', 'delete overnight/s2'])
  })
})
