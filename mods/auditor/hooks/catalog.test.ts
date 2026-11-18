import { describe, expect, test } from 'claude-code/testing'
import { BOUND_MS } from './boundary'
import { readAvailable, readCatalog, readChoices } from './catalog'
import { CATALOG_IDS, catalogFile, fakeEngine, never, settled } from './fakes'
import type { FakeTimer } from './fakes'

const DIR = '/home/test/.claude/cache/model-catalog'
const entry = (name: string, over: Record<string, unknown> = {}) => ({ name, kind: 'file', size: 16_000, mtimeMs: 1, isLink: false, ...over })

type Home = {
  // The environment the engine answers from.
  env?: Record<string, string | undefined>
  // The directory the listing answers for; any other path is missing.
  dir?: string
  // A file's size and modification time in the listing, where they are not its text's length and 1.
  sizes?: Record<string, number>
  mtimes?: Record<string, number>
  // Nouns of the test's own, in place of the engine's defaults.
  nouns?: Record<string, unknown>
}

// An engine whose catalog directory holds these files, by name, and the paths it was asked to read.
const home = (files: Record<string, string>, { env = { HOME: '/home/test' }, dir = DIR, sizes = {}, mtimes = {}, nouns = {} }: Home = {}) => {
  const reads: string[] = []
  const fake = fakeEngine({
    env: { get: async (name: string) => env[name] },
    fs: {
      list: async (path: string) => {
        if (path !== dir) throw new Error(`ENOENT: no such directory, ${path}`)
        return Object.keys(files).map(name => entry(name, { size: sizes[name] ?? files[name]?.length ?? 0, mtimeMs: mtimes[name] ?? 1 }))
      },
      read: async (path: string) => {
        reads.push(path)
        const text = files[path.slice(dir.length + 1)]
        if (text === undefined) throw new Error(`ENOENT: no such file, ${path}`)
        return text
      },
    },
    settings: { read: async () => undefined },
    ...nouns,
  })
  return { ...fake, reads }
}

// The timers a call left running: a bounded call that answered cancelled its own.
const waiting = (timers: FakeTimer[]): FakeTimer[] => timers.filter(timer => !timer.cancelled)

describe('readCatalog', () => {
  test('a cache file holding the 13 ids gives them in their order, read from the config home\'s catalog directory', async () => {
    const { $, logs, reads } = home({ 'a-cc.json': catalogFile() })
    expect(await readCatalog($)).toEqual(CATALOG_IDS)
    expect(reads).toEqual([`${DIR}/a-cc.json`])
    expect(logs).toEqual([])
  })

  test('with CLAUDE_CONFIG_DIR set the cache is looked for under it', async () => {
    const { $, logs, reads } = home({ 'a-cc.json': catalogFile() }, { env: { HOME: '/home/test', CLAUDE_CONFIG_DIR: '/elsewhere/claude' }, dir: '/elsewhere/claude/cache/model-catalog' })
    expect(await readCatalog($)).toEqual(CATALOG_IDS)
    expect(reads).toEqual(['/elsewhere/claude/cache/model-catalog/a-cc.json'])
    expect(logs).toEqual([])
  })

  test('a trailing slash on the config directory is not doubled', async () => {
    const { $, reads } = home({ 'a-cc.json': catalogFile() }, { env: { CLAUDE_CONFIG_DIR: '/elsewhere/claude//' }, dir: '/elsewhere/claude/cache/model-catalog' })
    expect(await readCatalog($)).toEqual(CATALOG_IDS)
    expect(reads).toEqual(['/elsewhere/claude/cache/model-catalog/a-cc.json'])
  })

  test('an empty CLAUDE_CONFIG_DIR counts as unset', async () => {
    const { $ } = home({ 'a-cc.json': catalogFile() }, { env: { HOME: '/home/test', CLAUDE_CONFIG_DIR: '' } })
    expect(await readCatalog($)).toEqual(CATALOG_IDS)
  })

  test('with neither CLAUDE_CONFIG_DIR nor HOME there is no catalog, recorded', async () => {
    const { $, logs } = home({ 'a-cc.json': catalogFile() }, { env: {} })
    expect(await readCatalog($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog location failed')
  })

  test('an environment read that fails gives no catalog, recorded', async () => {
    const { $, logs } = home({}, { nouns: { env: { get: () => Promise.reject(new Error('env unavailable')) } } })
    expect(await readCatalog($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog location failed')
    expect(logs[0]).toContain('env unavailable')
  })

  test('an environment read that never answers gives no catalog within the bound, recorded', async () => {
    const { $, logs, timers } = home({}, { nouns: { env: { get: () => never() } } })
    const pending = readCatalog($)
    await settled()
    expect(waiting(timers).map(timer => timer.ms)).toEqual([BOUND_MS])
    waiting(timers)[0]?.fire()
    expect(await pending).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`model catalog location failed: Error: no answer within ${BOUND_MS} ms`)
  })

  test('only files whose names end in -cc.json are read', async () => {
    const { $, reads } = home({ 'a-cc.json': catalogFile(), 'b.json': catalogFile({ modelIds: ['claude-opus-4-6'] }), 'c-cc.json.tmp': catalogFile({ modelIds: ['claude-opus-4-6'] }) })
    expect(await readCatalog($)).toEqual(CATALOG_IDS)
    expect(reads).toEqual([`${DIR}/a-cc.json`])
  })

  test('a directory or a link named like a catalog is not read', async () => {
    const reads: string[] = []
    const { $, logs } = home({}, {
      nouns: {
        fs: {
          list: async () => [entry('a-cc.json', { kind: 'dir' }), entry('b-cc.json', { kind: 'other', isLink: true })],
          read: async (path: string) => {
            reads.push(path)
            return catalogFile()
          },
        },
      },
    })
    expect(await readCatalog($)).toBeUndefined()
    expect(reads).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('no catalog file')
  })

  test('a missing directory gives no catalog, recorded', async () => {
    const { $, logs } = home({}, { dir: '/not/the/dir' })
    expect(await readCatalog($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog listing failed')
  })

  test('a directory with no catalog file gives no catalog, recorded', async () => {
    const { $, logs } = home({ 'notes.txt': 'x' })
    expect(await readCatalog($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('no catalog file')
  })

  test('a file over 256 KiB is not read, and gives no catalog, recorded', async () => {
    const { $, logs, reads } = home({ 'a-cc.json': catalogFile() }, { sizes: { 'a-cc.json': 256 * 1024 + 1 } })
    expect(await readCatalog($)).toBeUndefined()
    expect(reads).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog file a-cc.json failed')
  })

  test('a file of exactly 256 KiB is read', async () => {
    const { $, reads } = home({ 'a-cc.json': catalogFile() }, { sizes: { 'a-cc.json': 256 * 1024 } })
    expect(await readCatalog($)).toEqual(CATALOG_IDS)
    expect(reads).toHaveLength(1)
  })

  test('a file that does not parse, one with no id list, one whose list holds a non-string and one whose entries are all dropped each give no catalog, recorded', async () => {
    const texts = ['{ not json', 'null', '[]', '"modelIds"', JSON.stringify({}), JSON.stringify({ modelIds: 'claude-opus-4-6' }), JSON.stringify({ modelIds: ['claude-opus-4-6', 7] }), JSON.stringify({ modelIds: [] }), JSON.stringify({ modelIds: ['haiku', 'sonnet', 'default'] })]
    for (const text of texts) {
      const { $, logs } = home({ 'a-cc.json': text })
      expect(await readCatalog($)).toBeUndefined()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('model catalog file a-cc.json failed')
    }
  })

  test('an entry that is not a full id is dropped, a repeated id is kept once in its first spelling, and the others keep their order', async () => {
    const ids = ['haiku', 'claude-opus-4-6', 'claude-haiku-5-5', 'opusplan', 'claude-opus-4-6', 'claude-haiku-5-5-20261001', 'claude-opus-4-6[1m]', 'Claude-Sonnet-5-5']
    const { $, logs } = home({ 'a-cc.json': catalogFile({ modelIds: ids }) })
    expect(await readCatalog($)).toEqual(['claude-opus-4-6', 'claude-haiku-5-5', 'claude-opus-4-6[1m]'])
    expect(logs).toEqual([])
  })

  test('no more than 50 ids are taken, in the file\'s order', async () => {
    const ids = Array.from({ length: 70 }, (_, n) => `claude-model-${n + 1}`)
    const { $ } = home({ 'a-cc.json': catalogFile({ modelIds: ids }) })
    expect(await readCatalog($)).toEqual(ids.slice(0, 50))
  })

  test('of two valid files the one with the later fetch time is taken, whatever the order of the listing', async () => {
    const older = catalogFile({ modelIds: ['claude-opus-4-6'], fetchedAt: 100 })
    const newer = catalogFile({ modelIds: ['claude-opus-5-5'], fetchedAt: 200 })
    expect(await readCatalog(home({ 'a-cc.json': older, 'b-cc.json': newer }).$)).toEqual(['claude-opus-5-5'])
    expect(await readCatalog(home({ 'a-cc.json': newer, 'b-cc.json': older }).$)).toEqual(['claude-opus-5-5'])
  })

  test('a valid file with no fetch time loses to one with, and a file that is not valid does not count', async () => {
    const dated = catalogFile({ modelIds: ['claude-opus-4-6'], fetchedAt: 5 })
    const undated = JSON.stringify({ modelIds: ['claude-opus-5-5'] })
    const { $, logs } = home({ 'a-cc.json': undated, 'b-cc.json': dated, 'c-cc.json': '{ broken' })
    expect(await readCatalog($)).toEqual(['claude-opus-4-6'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog file c-cc.json failed')
  })

  test('a file that cannot be read is skipped, recorded, and the others still count', async () => {
    const good = catalogFile({ modelIds: ['claude-opus-4-6'], fetchedAt: 1 })
    const { $, logs } = home({}, {
      nouns: {
        fs: {
          list: async () => [entry('a-cc.json'), entry('b-cc.json')],
          read: async (path: string) => {
            if (path.endsWith('a-cc.json')) throw new Error('EACCES')
            return good
          },
        },
      },
    })
    expect(await readCatalog($)).toEqual(['claude-opus-4-6'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog file a-cc.json failed')
    expect(logs[0]).toContain('EACCES')
  })

  test('only the 8 newest files are read', async () => {
    const files: Record<string, string> = {}
    const mtimes: Record<string, number> = {}
    for (let n = 0; n < 12; n++) {
      files[`f${n}-cc.json`] = catalogFile({ modelIds: ['claude-opus-4-6'], fetchedAt: 1 })
      mtimes[`f${n}-cc.json`] = n
    }
    const { $, reads } = home(files, { mtimes })
    await readCatalog($)
    expect(reads.map(path => path.slice(path.lastIndexOf('/') + 1)).sort()).toEqual([4, 5, 6, 7, 8, 9, 10, 11].map(n => `f${n}-cc.json`).sort())
  })

  test('a listing that never answers gives no catalog within the bound, recorded', async () => {
    const { $, logs, timers } = home({}, { nouns: { fs: { list: () => never(), read: () => never() } } })
    const pending = readCatalog($)
    await settled()
    expect(waiting(timers).map(timer => timer.ms)).toEqual([BOUND_MS])
    waiting(timers)[0]?.fire()
    expect(await pending).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`model catalog listing failed: Error: no answer within ${BOUND_MS} ms`)
  })

  test('a file read that never answers gives no catalog within the bound, recorded', async () => {
    const { $, logs, timers } = home({}, { nouns: { fs: { list: async () => [entry('a-cc.json')], read: () => never() } } })
    const pending = readCatalog($)
    await settled()
    expect(waiting(timers).map(timer => timer.ms)).toEqual([BOUND_MS])
    waiting(timers)[0]?.fire()
    expect(await pending).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`model catalog file a-cc.json failed: Error: no answer within ${BOUND_MS} ms`)
  })

  test('a file read that never answers leaves the others to count', async () => {
    const good = catalogFile({ modelIds: ['claude-opus-4-6'] })
    const { $, logs, timers } = home({}, {
      nouns: {
        fs: {
          list: async () => [entry('a-cc.json'), entry('b-cc.json')],
          read: (path: string) => (path.endsWith('a-cc.json') ? never<string>() : Promise.resolve(good)),
        },
      },
    })
    const pending = readCatalog($)
    await settled()
    waiting(timers)[0]?.fire()
    expect(await pending).toEqual(['claude-opus-4-6'])
    expect(logs).toHaveLength(1)
  })
})

describe('readAvailable', () => {
  const withSetting = (read: (args: unknown) => Promise<unknown>) => fakeEngine({ settings: { read } })

  test('reads the availableModels setting by its key, as a list of names', async () => {
    const asked: unknown[] = []
    const { $, logs } = withSetting(async args => (asked.push(args), ['opus', 'claude-opus-4-6']))
    expect(await readAvailable($)).toEqual(['opus', 'claude-opus-4-6'])
    expect(asked).toEqual([{ key: 'availableModels' }])
    expect(logs).toEqual([])
  })

  test('a setting that is not set is none, with nothing recorded', async () => {
    const { $, logs } = withSetting(async () => undefined)
    expect(await readAvailable($)).toBeUndefined()
    expect(logs).toEqual([])
  })

  test('a value that is not a list of names counts as unset, and is recorded', async () => {
    for (const bad of ['opus', 3, { opus: true }, ['opus', 4], null]) {
      const { $, logs } = withSetting(async () => bad)
      expect(await readAvailable($)).toBeUndefined()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('availableModels read failed')
    }
  })

  test('a read that fails is none, recorded', async () => {
    const { $, logs } = withSetting(() => Promise.reject(new Error('settings unreadable')))
    expect(await readAvailable($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('availableModels read failed')
    expect(logs[0]).toContain('settings unreadable')
  })

  test('a read that never answers is none within the bound, recorded', async () => {
    const { $, logs, timers } = withSetting(() => never())
    const pending = readAvailable($)
    await settled()
    expect(waiting(timers).map(timer => timer.ms)).toEqual([BOUND_MS])
    waiting(timers)[0]?.fire()
    expect(await pending).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(`availableModels read failed: Error: no answer within ${BOUND_MS} ms`)
  })
})

describe('readChoices', () => {
  const engineWith = (files: Record<string, string>, available: unknown) => home(files, { nouns: { settings: { read: async () => available } } })

  test('with a catalog the choices are the four aliases followed by its ids', async () => {
    const { $, logs } = engineWith({ 'a-cc.json': catalogFile() }, undefined)
    expect((await readChoices($)).list).toEqual(['haiku', 'sonnet', 'opus', 'fable', ...CATALOG_IDS])
    expect(logs).toEqual([])
  })

  test('with no catalog they are the four aliases, and the missing catalog is recorded', async () => {
    const { $, logs } = engineWith({}, undefined)
    expect((await readChoices($)).list).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(logs).toHaveLength(1)
  })

  test('availableModels filters the list', async () => {
    const { $, logs } = engineWith({ 'a-cc.json': catalogFile() }, ['opus', 'claude-opus-4-6'])
    expect(await readChoices($)).toEqual({ list: ['opus', 'claude-opus-4-6'], defaultChoice: 'opus', filterIgnored: false })
    expect(logs).toEqual([])
  })

  test('a filter that leaves no choice is ignored, and recorded', async () => {
    const { $, logs } = engineWith({ 'a-cc.json': catalogFile() }, ['nosuch'])
    const choices = await readChoices($)
    expect(choices.list).toEqual(['haiku', 'sonnet', 'opus', 'fable', ...CATALOG_IDS])
    expect(choices.filterIgnored).toBe(true)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('availableModels filter failed')
  })

  test('a setting that cannot be read leaves the list whole, recorded', async () => {
    const { $, logs } = home({ 'a-cc.json': catalogFile() }, { nouns: { settings: { read: () => Promise.reject(new Error('settings unreadable')) } } })
    expect((await readChoices($)).list).toHaveLength(4 + CATALOG_IDS.length)
    expect(logs).toHaveLength(1)
  })
})
