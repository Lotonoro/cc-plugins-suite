import { describe, expect, test } from 'claude-code/testing'
import { ACTION_PREFIX, nightAction, nightClean, nightCompact, nightLearn, nightNotice, nightRead, nightScan, nightState, nightStepped, NOTICES_KEY, noticeOpen, STEP_PREFIX } from './nightstep'

const MIN = 60000
const H = 60 * MIN
const DAY = 24 * H
// The module reads no local field, so an instant in UTC serves.
const NOW = Date.parse('2026-01-14T03:00:00.000Z')
const PATH = '/home/test/.claude/projects/p/s1.jsonl'
const OTHER_PATH = '/home/test/.claude/projects/p/s2.jsonl'

// The engine's store, clock, debug log and compaction, as nightstep reads them. A read or a write of a key in a refusal set throws, and a read or a write of a key with a hold waits for it.
// `compactions` keeps the arguments of each call to the compaction, and `engine.answer` is what a call does: gives an answer, or throws.
const makeWorld = (seed: Record<string, unknown> = {}) => {
  const values = new Map<string, unknown>(Object.entries(seed))
  const calls: string[] = []
  const logs: string[] = []
  const compactions: unknown[][] = []
  const engine = { answer: (): unknown => ({ messages: [] }) }
  const refused = { get: new Set<string>(), set: new Set<string>(), delete: new Set<string>(), keys: false }
  const holds = new Map<string, Promise<void>>()
  const setHolds = new Map<string, Promise<void>>()
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
        await setHolds.get(key)
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
    session: {
      compact: (...args: unknown[]) => {
        calls.push('compact')
        compactions.push(args)
        return engine.answer()
      },
    },
  }
  return { dollar: dollar as any, values, calls, logs, refused, holds, setHolds, compactions, engine }
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

  test('learning a path reads the session\'s own two keys, by the transcript\'s id, and the install\'s notice record, and no other key', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - 3 * H, 'prompted/s1': NOW - 2 * H, 'overnight/s2': NOW - H, 'prompted/s2': NOW - H, 'pauses/s1': [] })
    const state = await learned(w)
    expect(state).toMatchObject({ id: 's1', read: true, stepMs: NOW - 3 * H, actionMs: NOW - 2 * H })
    expect(w.calls.sort()).toEqual([`get ${NOTICES_KEY}`, 'get overnight/s1', 'get prompted/s1'])
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
  test('the time is in memory at once, and the key holds it once the write lands, which the answer says', async () => {
    const w = makeWorld()
    const state = await learned(w)
    const written = nightStepped(w.dollar, state, NOW - 40 * MIN)
    expect(state.stepMs).toBe(NOW - 40 * MIN)
    expect(await written).toBe(true)
    expect(w.values.get('overnight/s1')).toBe(NOW - 40 * MIN)
  })

  test('a write that throws is reported once, the mark stays in memory, and the answer says it did not land', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.set.add('overnight/s1')
    expect(await nightStepped(w.dollar, state, NOW - 40 * MIN)).toBe(false)
    expect(state.stepMs).toBe(NOW - 40 * MIN)
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain('write of overnight/s1 refused')
    expect(w.values.has('overnight/s1')).toBe(false)
  })

  test('before the session\'s path is known no mark is written, and the answer says so', async () => {
    const w = makeWorld()
    const state = nightState()
    expect(await nightStepped(w.dollar, state, NOW - 40 * MIN)).toBe(false)
    expect(state.stepMs).toBe(NOW - 40 * MIN)
    expect(w.calls).toEqual([])
  })

  test('the mark is not read before it is written', async () => {
    const w = makeWorld({ 'overnight/s1': NOW - 5 * H })
    const state = await learned(w)
    w.calls.length = 0
    await nightStepped(w.dollar, state, NOW - 40 * MIN)
    expect(w.calls).toEqual(['set overnight/s1'])
  })
})

describe('the notice record: one key for the install, read when the path is learned, and written once for each notice', () => {
  const UNTOLD = { window: false, step: false }

  test("the key is named, differs from the first build's, and sits outside the two families the clean-up scans", () => {
    expect(NOTICES_KEY).toBe('notices-v2')
    expect(NOTICES_KEY).not.toBe('notices')
    expect(NOTICES_KEY.startsWith(STEP_PREFIX) || NOTICES_KEY.startsWith(ACTION_PREFIX)).toBe(false)
  })

  test("a record the first build wrote under its own key is neither read nor written: the install is told each rewritten line once, and the old record stays as it was", async () => {
    const w = makeWorld({ notices: { window: true, step: false } })
    const state = await learned(w)
    expect(state.notices).toEqual(UNTOLD)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    expect(w.values.get('notices')).toEqual({ window: true, step: false })
    expect(w.calls.filter((call) => call.endsWith(' notices'))).toEqual([])
    const later = await learned(w)
    expect(later.notices).toEqual({ window: true, step: true })
    expect(await nightNotice(w.dollar, later, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, later, 'step')).toBe(false)
  })

  test('a state starts with the record unread, and a notice asked of an unread record is not to be written', async () => {
    const w = makeWorld()
    const state = nightState()
    expect(state.notices).toBeNull()
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(w.calls).toEqual([])
  })

  test('a record never written reads as nothing told', async () => {
    expect((await learned(makeWorld())).notices).toEqual(UNTOLD)
  })

  test('the record round-trips: each notice asked is to be written and is spent in the key, and the next load reads them as told', async () => {
    const w = makeWorld()
    const first = await learned(w)
    expect(await nightNotice(w.dollar, first, 'window')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: false })
    expect(await nightNotice(w.dollar, first, 'step')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    const later = await learned(w)
    expect(later.notices).toEqual({ window: true, step: true })
    w.calls.length = 0
    expect(await nightNotice(w.dollar, later, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, later, 'step')).toBe(false)
    expect(w.calls).toEqual([])
  })

  test('one notice spent leaves the other to be written, in this load and in the next', async () => {
    const w = makeWorld()
    const first = await learned(w)
    expect(await nightNotice(w.dollar, first, 'step')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: false, step: true })
    expect(await nightNotice(w.dollar, first, 'window')).toBe(true)
    const w2 = makeWorld({ [NOTICES_KEY]: { window: true, step: false } })
    const later = await learned(w2)
    expect(await nightNotice(w2.dollar, later, 'window')).toBe(false)
    expect(await nightNotice(w2.dollar, later, 'step')).toBe(true)
  })

  test('a notice asked a second time is not to be written, and the key is not written again', async () => {
    const w = makeWorld()
    const state = await learned(w)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    w.calls.length = 0
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(w.calls).toEqual([])
  })

  test('the record is the install\'s, read once: a path taught later reads that session\'s keys and not the record, and a spent notice stays spent', async () => {
    const w = makeWorld()
    const state = await learned(w)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    w.calls.length = 0
    await nightLearn(w.dollar, state, OTHER_PATH)
    expect(w.calls).toEqual(['get overnight/s2', 'get prompted/s2'])
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test('a value of another shape reads as nothing told, and a field is told only when it is exactly true', async () => {
    for (const value of ['x', 12, true, null, [], [true], 'window', { window: 1 }, { window: 'true', step: 'true' }, { window: null, step: {} }, {}]) {
      const state = await learned(makeWorld({ [NOTICES_KEY]: value }))
      expect([value, state.notices]).toEqual([value, UNTOLD])
    }
    expect((await learned(makeWorld({ [NOTICES_KEY]: { window: true } }))).notices).toEqual({ window: true, step: false })
    expect((await learned(makeWorld({ [NOTICES_KEY]: { step: true, other: 1 } }))).notices).toEqual({ window: false, step: true })
    expect((await learned(makeWorld({ [NOTICES_KEY]: { window: true, step: true } }))).notices).toEqual({ window: true, step: true })
  })

  test('a value of another shape is replaced whole by the next write', async () => {
    const w = makeWorld({ [NOTICES_KEY]: 'x' })
    const state = await learned(w)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('the notice is spent in memory before its write is awaited, and a yes comes only once the write has landed', async () => {
    const w = makeWorld()
    const state = await learned(w)
    const hold = deferred()
    w.setHolds.set(NOTICES_KEY, hold.promise)
    let said: boolean | undefined
    const asked = nightNotice(w.dollar, state, 'window').then((yes) => {
      said = yes
    })
    expect(state.notices).toEqual({ window: true, step: false })
    // A second ask while the first write is waiting is a no: the notice is not written twice.
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(said).toBeUndefined()
    expect(w.values.has(NOTICES_KEY)).toBe(false)
    hold.release()
    await asked
    expect(said).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('a write that throws says no and is reported once; the notice stays spent in this load and is not asked of the store again, and a later load reads it unspent', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.set.add(NOTICES_KEY)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain(`write of ${NOTICES_KEY} refused`)
    expect(w.values.has(NOTICES_KEY)).toBe(false)
    w.calls.length = 0
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(w.calls).toEqual([])
    expect(w.logs).toHaveLength(1)
    w.refused.set.clear()
    const later = await learned(w)
    expect(await nightNotice(w.dollar, later, 'window')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('the record is read fresh just before each write, and a notice spent in memory asks the store nothing', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.calls.length = 0
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`, `set ${NOTICES_KEY}`])
    expect(await nightNotice(w.dollar, state, 'step')).toBe(true)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`, `set ${NOTICES_KEY}`, `get ${NOTICES_KEY}`, `set ${NOTICES_KEY}`])
    w.calls.length = 0
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(w.calls).toEqual([])
  })

  test('a notice another session spent since this load read the record is not written again, and the record is left as it is', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.values.set(NOTICES_KEY, { window: true, step: true })
    w.calls.length = 0
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`, `get ${NOTICES_KEY}`])
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    // Spent in the store, the notice is spent in this load: it is not read for again.
    w.calls.length = 0
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(w.calls).toEqual([])
  })

  test('a notice written after another session spent the other one keeps that flag: the record written is the record as it stands with the one notice added', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.values.set(NOTICES_KEY, { window: false, step: true })
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    const w2 = makeWorld()
    const state2 = await learned(w2)
    w2.values.set(NOTICES_KEY, { window: true, step: false })
    expect(await nightNotice(w2.dollar, state2, 'step')).toBe(true)
    expect(w2.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test('the record written is the one just read with the one notice added, not this load\'s own flags: a notice whose write was refused stays unwritten for a later load', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.set.add(NOTICES_KEY)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    w.refused.set.clear()
    expect(await nightNotice(w.dollar, state, 'step')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: false, step: true })
    const later = await learned(w)
    expect(await nightNotice(w.dollar, later, 'window')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test('a second ask while the fresh read is running says no, and the store is read and written once', async () => {
    const w = makeWorld()
    const state = await learned(w)
    const hold = deferred()
    w.holds.set(NOTICES_KEY, hold.promise)
    w.calls.length = 0
    const first = nightNotice(w.dollar, state, 'window')
    expect(state.notices).toEqual({ window: true, step: false })
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`])
    hold.release()
    expect(await first).toBe(true)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`, `set ${NOTICES_KEY}`])
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('a notice is open exactly while asking it reaches the store: the record read and the notice not spent in this load, by this load, by another session or by a refused write', async () => {
    const w = makeWorld()
    const state = nightState()
    const reachesStore = async (which: 'window' | 'step') => {
      const open = noticeOpen(state, which)
      w.calls.length = 0
      await nightNotice(w.dollar, state, which)
      expect([which, w.calls.length > 0]).toEqual([which, open])
      return open
    }
    // An unread record opens nothing.
    expect([noticeOpen(state, 'window'), noticeOpen(state, 'step')]).toEqual([false, false])
    expect(await reachesStore('window')).toBe(false)
    await nightLearn(w.dollar, state, PATH)
    expect([noticeOpen(state, 'window'), noticeOpen(state, 'step')]).toEqual([true, true])
    // A refused fresh read gives the notice back: it is open again.
    w.refused.get.add(NOTICES_KEY)
    expect(await reachesStore('window')).toBe(true)
    expect(noticeOpen(state, 'window')).toBe(true)
    w.refused.get.clear()
    // Written, it is spent, and the other stays open.
    expect(await reachesStore('window')).toBe(true)
    expect([noticeOpen(state, 'window'), noticeOpen(state, 'step')]).toEqual([false, true])
    expect(await reachesStore('window')).toBe(false)
    // Found spent by another session, it is spent in this load too.
    w.values.set(NOTICES_KEY, { window: true, step: true })
    expect(await reachesStore('step')).toBe(true)
    expect([noticeOpen(state, 'window'), noticeOpen(state, 'step')]).toEqual([false, false])
    // A refused write spends it in this load.
    const w2 = makeWorld()
    const refusing = await learned(w2)
    w2.refused.set.add(NOTICES_KEY)
    await nightNotice(w2.dollar, refusing, 'window')
    expect([noticeOpen(refusing, 'window'), noticeOpen(refusing, 'step')]).toEqual([false, true])
  })
})

describe('a refused fresh read of the notice record, before a write: nothing is written, the error is reported once while reads keep failing, and the notice is asked again', () => {
  test('each ask reads again and says no, the notice is given back, and the first read that lands writes it', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.get.add(NOTICES_KEY)
    w.calls.length = 0
    for (let i = 0; i < 3; i++) expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`, `get ${NOTICES_KEY}`, `get ${NOTICES_KEY}`])
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain(`read of ${NOTICES_KEY} refused`)
    expect(w.values.has(NOTICES_KEY)).toBe(false)
    expect(state.notices).toEqual({ window: false, step: false })
    w.refused.get.clear()
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: false })
    expect(w.logs).toHaveLength(1)
  })

  test('a refusal after a read that landed is reported again', async () => {
    const w = makeWorld()
    const state = await learned(w)
    w.refused.get.add(NOTICES_KEY)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    w.refused.get.clear()
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    w.refused.get.add(NOTICES_KEY)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(w.logs).toHaveLength(2)
  })

  test('a notice given back leaves the other as it was, and the one spent by another session meanwhile is read as spent', async () => {
    const w = makeWorld({ [NOTICES_KEY]: { window: true, step: false } })
    const state = await learned(w)
    w.refused.get.add(NOTICES_KEY)
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(state.notices).toEqual({ window: true, step: false })
    w.refused.get.clear()
    w.values.set(NOTICES_KEY, { window: true, step: true })
    expect(await nightNotice(w.dollar, state, 'step')).toBe(false)
    expect(w.values.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })
})

describe('a failed read of the notice record: reported once while it keeps failing, read again by the next call, and no notice is written meanwhile', () => {
  test('a refused read leaves the record unread and logs the error once; each retry reads again and logs nothing more; the retry that lands lets a notice be written', async () => {
    const w = makeWorld()
    w.refused.get.add(NOTICES_KEY)
    const state = await learned(w)
    expect(state.notices).toBeNull()
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toContain(`read of ${NOTICES_KEY} refused`)
    expect(await nightNotice(w.dollar, state, 'window')).toBe(false)
    expect(w.values.has(NOTICES_KEY)).toBe(false)
    for (let i = 0; i < 3; i++) await nightRead(w.dollar, state)
    expect(state.notices).toBeNull()
    expect(w.logs).toHaveLength(1)
    expect(w.calls.filter((call) => call === `get ${NOTICES_KEY}`)).toHaveLength(4)
    w.refused.get.clear()
    await nightRead(w.dollar, state)
    expect(state.notices).toEqual({ window: false, step: false })
    expect(await nightNotice(w.dollar, state, 'window')).toBe(true)
    // A read that has landed is not made again.
    w.calls.length = 0
    await nightRead(w.dollar, state)
    expect(w.calls).toEqual([])
  })

  test('a retry is not made twice at once: a call while one is running does nothing', async () => {
    const w = makeWorld()
    w.refused.get.add(NOTICES_KEY)
    const state = await learned(w)
    const hold = deferred()
    w.holds.set(NOTICES_KEY, hold.promise)
    w.calls.length = 0
    const retry = nightRead(w.dollar, state)
    await nightRead(w.dollar, state)
    expect(w.calls).toEqual([`get ${NOTICES_KEY}`])
    w.refused.get.clear()
    hold.release()
    await retry
    expect(state.notices).toEqual({ window: false, step: false })
  })

  test('the record\'s read and the own keys\' are independent: a refused record leaves the step mark read, and a refused own key leaves the record read', async () => {
    const a = makeWorld({ 'overnight/s1': NOW - H })
    a.refused.get.add(NOTICES_KEY)
    expect(await learned(a)).toMatchObject({ read: true, stepMs: NOW - H, notices: null })
    const b = makeWorld()
    b.refused.get.add('prompted/s1')
    expect(await learned(b)).toMatchObject({ read: false, notices: { window: false, step: false } })
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
    expect(w.calls).toEqual(['get overnight/s1', 'get prompted/s1', `get ${NOTICES_KEY}`, 'get overnight/s2', 'delete overnight/s2'])
  })

  test('a clean asked once the id is known runs at once, and waits for nothing', async () => {
    const w = makeWorld({ 'overnight/s2': NOW - 9 * DAY })
    const state = await learned(w)
    w.calls.length = 0
    await nightClean(w.dollar, state, ['overnight/s2'], NOW)
    expect(w.calls).toEqual(['get overnight/s2', 'delete overnight/s2'])
  })

  test("the notice record, and the first build's under its own key, are left alone: not read, not deleted, however odd their value, and the scan does not read them either", async () => {
    const w = makeWorld({ [NOTICES_KEY]: 'x', notices: 'y', 'overnight/old': NOW - 3 * DAY, 'prompted/young': NOW - MIN })
    const state = await known(w)
    await nightClean(w.dollar, state, [...w.values.keys()], NOW)
    expect(w.calls).toEqual(['get overnight/old', 'delete overnight/old', 'get prompted/young'])
    expect(all(w)).toEqual(['notices', NOTICES_KEY, 'prompted/young'].sort())
    w.calls.length = 0
    await nightScan(w.dollar, state, NOW)
    expect(w.calls).toEqual(['keys', 'get prompted/young'])
  })
})

// What the engine answers a compaction with when it stood: the conversation as it reads afterwards, which holds the user's words and must reach no log, the sizes before and after, and
// the summarizer's usage. Figures from a measured compaction.
const SECRET = 'a sentence the user typed'
const stood = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  messages: [{ role: 'user', text: SECRET, toolUses: [] }],
  tokensBefore: 59140,
  tokensAfter: 1364,
  usage: { input_tokens: 52707, output_tokens: 917, cache_read_input_tokens: 8124, cache_creation_input_tokens: 301 },
  ...over,
})
const without = (...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(stood()).filter(([key]) => !keys.includes(key)))
const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : []

// The compaction of the step taken at STEP, by a session whose user has not acted since unless a test says it has.
const STEP = NOW
const compact = (w: ReturnType<typeof makeWorld>, state = nightState()) => nightCompact(w.dollar, state, STEP)

describe('the compaction: one call to the engine with no instructions, and its outcome handed back as the debug line records it', () => {
  test('it asks the engine once, with no argument at all', async () => {
    const w = makeWorld()
    w.engine.answer = () => stood()
    await compact(w)
    expect(w.compactions).toEqual([[]])
    expect(w.calls).toEqual(['compact'])
  })

  test("a compaction that stood gives the sizes before and after and the summarizer's usage", async () => {
    const w = makeWorld()
    w.engine.answer = async () => stood()
    expect(await compact(w)).toEqual({
      kind: 'stood',
      size_before: 59140,
      size_after: 1364,
      summarizer: { in: 52707, out: 917, cache_read: 8124, cache_write: 301 },
    })
  })

  test('a compaction that stood with its sizes absent, or its usage absent, says null for what the engine did not record', async () => {
    const w = makeWorld()
    const summarizer = { in: 52707, out: 917, cache_read: 8124, cache_write: 301 }
    w.engine.answer = async () => without('tokensBefore', 'tokensAfter')
    expect(await compact(w)).toEqual({ kind: 'stood', size_before: null, size_after: null, summarizer })
    w.engine.answer = async () => without('usage')
    expect(await compact(w)).toEqual({ kind: 'stood', size_before: 59140, size_after: 1364, summarizer: null })
    w.engine.answer = async () => without('tokensAfter', 'usage')
    expect(await compact(w)).toEqual({ kind: 'stood', size_before: 59140, size_after: null, summarizer: null })
    w.engine.answer = async () => ({ messages: [] })
    expect(await compact(w)).toEqual({ kind: 'stood', size_before: null, size_after: null, summarizer: null })
  })

  test('a size or a count of another shape is null, and one count short of the four leaves no usage', async () => {
    const w = makeWorld()
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '59140', null, {}]) {
      w.engine.answer = async () => stood({ tokensBefore: bad, tokensAfter: bad })
      expect(await compact(w)).toMatchObject({ kind: 'stood', size_before: null, size_after: null })
    }
    for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      const usage = { ...(stood().usage as object), [field]: undefined }
      w.engine.answer = async () => stood({ usage })
      expect(await compact(w)).toMatchObject({ kind: 'stood', summarizer: null })
    }
    w.engine.answer = async () => stood({ usage: 'x' })
    expect(await compact(w)).toMatchObject({ kind: 'stood', summarizer: null })
  })

  test("a compaction another plugin vetoed is skipped, with a reason of the mod's own and the length of the veto's words, which are not stated", async () => {
    const w = makeWorld()
    w.engine.answer = async () => ({ skip: SECRET })
    expect(await compact(w)).toEqual({ kind: 'skipped', reason: 'a hook vetoed it', reason_chars: SECRET.length })
    w.engine.answer = async () => ({ skip: '' })
    expect(await compact(w)).toEqual({ kind: 'skipped', reason: 'a hook vetoed it', reason_chars: 0 })
  })

  test("a call the engine rejects, as it does while a turn runs, is refused, with the length of the error's words and none of them", async () => {
    const w = makeWorld()
    w.engine.answer = () => Promise.reject(new Error(SECRET))
    expect(await compact(w)).toEqual({ kind: 'refused', error_chars: SECRET.length })
    w.engine.answer = () => Promise.reject(SECRET)
    expect(await compact(w)).toEqual({ kind: 'refused', error_chars: SECRET.length })
    // A rejection with no words, or with words in a field the mod does not read, counts none.
    for (const reason of [undefined, 7, { message: SECRET }]) {
      w.engine.answer = () => Promise.reject(reason)
      expect(await compact(w)).toEqual({ kind: 'refused', error_chars: 0 })
    }
  })

  test('a call that throws is thrown, with the length of its words and none of them', async () => {
    const w = makeWorld()
    w.engine.answer = () => {
      throw new Error(SECRET)
    }
    expect(await compact(w)).toEqual({ kind: 'thrown', reason: 'the call threw', error_chars: SECRET.length })
  })

  test("an answer that is neither a compaction nor a skip is thrown, with a reason of the mod's own", async () => {
    const w = makeWorld()
    for (const answer of [undefined, null, 'x', 7, {}, { skip: 5 }, { messages: 'x' }, { skip: undefined, messages: undefined }]) {
      w.engine.answer = async () => answer
      expect(await compact(w)).toEqual({ kind: 'thrown', reason: 'the engine answered a compaction with neither a conversation nor a skip' })
    }
  })

  test("a user who acted after the step is left alone: the engine is not asked, and the outcome says why in words of the mod's own", async () => {
    const w = makeWorld()
    w.engine.answer = () => stood()
    for (const actionMs of [STEP + 1, STEP, STEP + H]) {
      const state = nightState()
      await nightAction(w.dollar, state, actionMs)
      expect(await compact(w, state)).toEqual({ kind: 'skipped', reason: 'the user acted after the step' })
    }
    expect(w.compactions).toEqual([])
    expect(w.calls).toEqual([])
  })

  test('an action before the step, or none, leaves the engine asked', async () => {
    const w = makeWorld()
    w.engine.answer = () => stood()
    for (const actionMs of [STEP - 1, STEP - 3 * H, null]) {
      const state = nightState()
      if (actionMs !== null) await nightAction(w.dollar, state, actionMs)
      expect(await compact(w, state)).toMatchObject({ kind: 'stood' })
    }
    expect(w.compactions).toHaveLength(3)
  })

  test('the action is read in the run that calls the engine: one noted the moment after the call is asked for comes too late to stop it', async () => {
    const w = makeWorld()
    w.engine.answer = () => stood()
    const state = nightState()
    const outcome = compact(w, state)
    await nightAction(w.dollar, state, STEP + 1)
    expect(await outcome).toMatchObject({ kind: 'stood' })
    expect(w.compactions).toHaveLength(1)
  })

  test('it never throws, whatever the engine does', async () => {
    const w = makeWorld()
    for (const answer of [() => stood(), () => ({ skip: 'x' }), () => Promise.reject(new Error('x')), () => Promise.reject(undefined), () => Promise.reject(Object.create(null)), () => { throw 'x' }, () => undefined]) {
      w.engine.answer = answer
      await expect(compact(w)).resolves.toBeDefined()
    }
  })

  test("the outcome holds none of the conversation or of anyone's words, whatever shape the answer takes, and no key with token in its name, which the engine redacts", async () => {
    const w = makeWorld()
    const answers = [
      () => stood(),
      () => stood({ skip: SECRET }),
      () => stood({ summary: SECRET, extra: { text: SECRET } }),
      () => ({ skip: SECRET, messages: [{ role: 'user', text: SECRET, toolUses: [] }] }),
      () => without('usage'),
      () => ({ skip: SECRET }),
      () => Promise.reject(new Error(SECRET)),
      () => Promise.reject(SECRET),
      () => {
        throw new Error(SECRET)
      },
    ]
    for (const answer of answers) {
      w.engine.answer = answer
      const outcome = await compact(w)
      expect(JSON.stringify(outcome)).not.toContain(SECRET)
      expect(keysOf(outcome).filter((key) => /token/i.test(key))).toEqual([])
    }
    w.engine.answer = async () => stood()
    expect(keysOf(await compact(w))).toEqual(['kind', 'size_before', 'size_after', 'summarizer', 'in', 'out', 'cache_read', 'cache_write'])
  })
})
