import { describe, expect, test } from 'claude-code/testing'
import { BOUND_MS } from './boundary'
import { fakeEngine, never, settled } from './fakes'
import { readLastModel, readModelIds, storeModelId, writeLastModel } from './store'

// A store in memory with the engine's own contract: a value is read back as JSON.
const memory = (entries: Record<string, unknown> = {}) => {
  const held: Record<string, unknown> = { ...entries }
  const calls: string[] = []
  return {
    held,
    calls,
    store: {
      get: async (key: string) => (calls.push(`get ${key}`), held[key]),
      set: async (key: string, value: unknown) => {
        calls.push(`set ${key}`)
        held[key] = JSON.parse(JSON.stringify(value))
      },
    },
  }
}

describe('readLastModel', () => {
  test('reads the name stored as the last model set', async () => {
    const { store } = memory({ lastModel: 'claude-opus-4-6' })
    const { $, logs } = fakeEngine({ store })
    expect(await readLastModel($)).toBe('claude-opus-4-6')
    expect(logs).toEqual([])
  })

  test('reads nothing as absent, with nothing recorded', async () => {
    const { $, logs } = fakeEngine({ store: memory().store })
    expect(await readLastModel($)).toBeUndefined()
    expect(logs).toEqual([])
  })

  test('reads a value that is not a model name as absent, and records it', async () => {
    for (const bad of [7, '', { name: 'haiku' }, ['haiku'], null, true]) {
      const { $, logs } = fakeEngine({ store: memory({ lastModel: bad }).store })
      expect(await readLastModel($)).toBeUndefined()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('store read of the last model set failed')
    }
  })

  test('reads a failed read as absent, and records it', async () => {
    const { $, logs } = fakeEngine({
      store: {
        get: () => Promise.reject(new Error('store unreadable')),
      },
    })
    expect(await readLastModel($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('store read of the last model set failed: Error: store unreadable')
  })

  test('a read that never answers is absent within the bound, and is recorded as late', async () => {
    const { $, logs, timers } = fakeEngine({ store: { get: () => never() } })
    const pending = readLastModel($)
    expect(timers.map(t => t.ms)).toEqual([BOUND_MS])
    timers[0]?.fire()
    expect(await pending).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`store read of the last model set failed: Error: no answer within ${BOUND_MS} ms`)
  })
})

describe('writeLastModel', () => {
  test('stores the name', async () => {
    const { held, store } = memory()
    const { $, logs } = fakeEngine({ store })
    await writeLastModel($, 'claude-opus-4-6')
    expect(held['lastModel']).toBe('claude-opus-4-6')
    expect(logs).toEqual([])
  })

  test('a failed write is recorded and nothing is thrown', async () => {
    const { $, logs } = fakeEngine({ store: { set: () => Promise.reject(new Error('store full')) } })
    await writeLastModel($, 'opus')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('store write of the last model set failed: Error: store full')
  })

  test('a write that never answers is recorded as failed within the bound', async () => {
    const { $, logs, timers } = fakeEngine({ store: { set: () => never() } })
    const pending = writeLastModel($, 'opus')
    timers[0]?.fire()
    await pending
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`store write of the last model set failed: Error: no answer within ${BOUND_MS} ms`)
  })
})

describe('readModelIds', () => {
  test('reads the pairs stored, each choice with the full id it resolved to', async () => {
    const { $, logs } = fakeEngine({ store: memory({ modelIds: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5-20261001' } }).store })
    expect(await readModelIds($)).toEqual({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5-20261001' })
    expect(logs).toEqual([])
  })

  test('reads nothing stored as no pairs, with nothing recorded', async () => {
    const { $, logs } = fakeEngine({ store: memory().store })
    expect(await readModelIds($)).toEqual({})
    expect(logs).toEqual([])
  })

  test('reads a value of the wrong shape as no pairs, and records it', async () => {
    for (const bad of ['haiku', 3, null, ['claude-haiku-5-5'], true]) {
      const { $, logs } = fakeEngine({ store: memory({ modelIds: bad }).store })
      expect(await readModelIds($)).toEqual({})
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('store read of the model ids failed')
    }
  })

  test('drops a pair whose id is not a full id, keeps the others, and records the drop', async () => {
    const { $, logs } = fakeEngine({ store: memory({ modelIds: { haiku: 'claude-haiku-5-5', sonnet: 'opus', opus: 7 } }).store })
    expect(await readModelIds($)).toEqual({ haiku: 'claude-haiku-5-5' })
    expect(logs).toHaveLength(1)
  })

  test('reads a failed read, and one that never answers, as no pairs, and records each', async () => {
    const failed = fakeEngine({ store: { get: () => Promise.reject(new Error('store unreadable')) } })
    expect(await readModelIds(failed.$)).toEqual({})
    expect(failed.logs).toHaveLength(1)

    const hung = fakeEngine({ store: { get: () => never() } })
    const pending = readModelIds(hung.$)
    hung.timers[0]?.fire()
    expect(await pending).toEqual({})
    expect(hung.logs).toHaveLength(1)
  })
})

describe('storeModelId', () => {
  test('a result naming a full id for an alias stores that pair, beside the others', async () => {
    const { held, store } = memory({ modelIds: { sonnet: 'claude-sonnet-5-5' } })
    const { $, logs } = fakeEngine({ store })
    await storeModelId($, 'haiku', 'claude-haiku-5-5')
    expect(held['modelIds']).toEqual({ sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' })
    expect(logs).toEqual([])
  })

  test('a pair that moved is replaced', async () => {
    const { held, store } = memory({ modelIds: { haiku: 'claude-haiku-5-5' } })
    await storeModelId(fakeEngine({ store }).$, 'haiku', 'claude-haiku-6')
    expect(held['modelIds']).toEqual({ haiku: 'claude-haiku-6' })
  })

  test('a result naming an alias, or anything that is not a full id, leaves the store as it was and is not even read', async () => {
    const { held, calls, store } = memory({ modelIds: { haiku: 'claude-haiku-5-5' } })
    const { $ } = fakeEngine({ store })
    for (const named of ['haiku', 'sonnet', 'm', '']) await storeModelId($, 'haiku', named)
    expect(held['modelIds']).toEqual({ haiku: 'claude-haiku-5-5' })
    expect(calls).toEqual([])
  })

  test('a full-id choice is its own id, so nothing is stored for it', async () => {
    const { calls, store } = memory()
    await storeModelId(fakeEngine({ store }).$, 'claude-opus-4-6', 'claude-opus-4-6[1m]')
    expect(calls).toEqual([])
  })

  test('a pair already stored is not written again', async () => {
    const { calls, store } = memory({ modelIds: { haiku: 'claude-haiku-5-5' } })
    await storeModelId(fakeEngine({ store }).$, 'haiku', 'claude-haiku-5-5')
    expect(calls).toEqual(['get modelIds'])
  })

  test('a failed read of the table writes nothing, so the pairs held are not lost, and is recorded', async () => {
    const sets: unknown[] = []
    const { $, logs } = fakeEngine({
      store: {
        get: () => Promise.reject(new Error('store unreadable')),
        set: async (_key: string, value: unknown) => sets.push(value),
      },
    })
    await storeModelId($, 'haiku', 'claude-haiku-5-5')
    expect(sets).toEqual([])
    expect(logs).toHaveLength(1)
  })

  test('a failed write is recorded, and nothing is thrown', async () => {
    const { $, logs } = fakeEngine({
      store: {
        get: async () => undefined,
        set: () => Promise.reject(new Error('store full')),
      },
    })
    await storeModelId($, 'haiku', 'claude-haiku-5-5')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('store write of the model ids failed: Error: store full')
  })

  test('a write that never answers is recorded as failed within the bound', async () => {
    const { $, logs, timers } = fakeEngine({ store: { get: async () => undefined, set: () => never() } })
    const pending = storeModelId($, 'haiku', 'claude-haiku-5-5')
    // The read answers first, and the write sets its own timer.
    await settled()
    expect(timers).toHaveLength(2)
    timers[1]?.fire()
    await pending
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`store write of the model ids failed: Error: no answer within ${BOUND_MS} ms`)
  })
})
