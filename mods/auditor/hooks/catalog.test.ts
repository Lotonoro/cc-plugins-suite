import { describe, expect, test } from 'claude-code/testing'
import { BOUND_MS } from './boundary'
import { readAvailable, readCatalog, readChoices } from './catalog'
import { ENGINE_CATALOG_FILE } from './catalogfile'
import { CATALOG_IDS, CATALOG_NAMES, catalogFile, fakeEngine, never, settled } from './fakes'
import type { FakeTimer } from './fakes'
import { canonicalOf } from './models'

const DIR = '/home/test/.claude/cache/model-catalog'
const entry = (name: string, over: Record<string, unknown> = {}) => ({ name, kind: 'file', size: 16_000, mtimeMs: 1, isLink: false, ...over })
// A file whose list of models is `list`, whatever it holds, fetched at `fetchedAt` when that is given.
const models = (list: unknown, fetchedAt?: number): string => JSON.stringify({ fetchedAt, catalog: { config: { models: list } } })

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

  test('a copy of the file the engine wrote, less its per-user state block, gives its 13 ids in their order, with nothing recorded', async () => {
    expect(JSON.parse(ENGINE_CATALOG_FILE).catalog.state).toBeUndefined()
    const { $, logs } = home({ 'a-cc.json': ENGINE_CATALOG_FILE })
    const ids = await readCatalog($)
    expect(ids).toHaveLength(13)
    expect(ids).toEqual(CATALOG_IDS)
    expect(logs).toEqual([])
  })

  test('the ids are the models of catalog.config alone: a list of ids at the top of the file, where the engine does not keep one, gives no catalog, recorded', async () => {
    const { $, logs } = home({ 'a-cc.json': JSON.stringify({ modelIds: CATALOG_IDS, fetchedAt: 1 }) })
    expect(await readCatalog($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog file a-cc.json failed')
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
    const { $, reads } = home({ 'a-cc.json': catalogFile(), 'b.json': catalogFile(['claude-opus-4-6']), 'c-cc.json.tmp': catalogFile(['claude-opus-4-6']) })
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

  test('a file that does not parse, one with no list of models and one whose list leaves no full model id once its entries with no id are skipped each give no catalog, recorded', async () => {
    const texts = [
      '{ not json',
      'null',
      '[]',
      '"catalog"',
      JSON.stringify({}),
      JSON.stringify({ catalog: 'models' }),
      JSON.stringify({ catalog: { config: {} } }),
      models('claude-opus-4-6'),
      models({ id: 'claude-opus-4-6' }),
      models([{ name: 'Opus 5.5' }]),
      models([null, 'claude-opus-5-5', { id: 7 }]),
      models([{ name: 'Opus 5.5' }, { id: 'haiku' }]),
      catalogFile([]),
      catalogFile(['haiku', 'sonnet', 'default']),
    ]
    for (const text of texts) {
      const { $, logs } = home({ 'a-cc.json': text })
      expect(await readCatalog($)).toBeUndefined()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('model catalog file a-cc.json failed')
    }
  })

  test('an entry with no string id is skipped, and recorded once for its file: the others still give the catalog, in their order', async () => {
    for (const bad of ['claude-opus-5-5', null, 7, [], ['claude-opus-5-5'], {}, { name: 'Opus 5.5' }, { id: 7 }, { id: null }, { id: ['claude-opus-5-5'] }]) {
      const { $, logs } = home({ 'a-cc.json': models([{ id: 'claude-opus-4-6' }, bad, { id: 'claude-haiku-5-5' }]) })
      expect(await readCatalog($)).toEqual(['claude-opus-4-6', 'claude-haiku-5-5'])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('model catalog file a-cc.json failed')
      expect(logs[0]).toContain('dropped for having no id: 1')
    }
  })

  test('several entries with no id are one record for their file, and each file is recorded for its own', async () => {
    const { $, logs } = home({
      'a-cc.json': models([{ id: 'claude-opus-4-6' }, null, { name: 'Opus 5.5' }, 7], 100),
      'b-cc.json': models([{ id: 'claude-opus-5-5' }, {}], 200),
    })
    expect(await readCatalog($)).toEqual(['claude-opus-5-5'])
    expect(logs).toHaveLength(2)
    expect(logs.find(log => log.includes('a-cc.json'))).toContain('dropped for having no id: 3')
    expect(logs.find(log => log.includes('b-cc.json'))).toContain('dropped for having no id: 1')
  })

  test('an entry that is not a full id is dropped, a repeated id is kept once in its first spelling, and the others keep their order', async () => {
    const ids = ['haiku', 'claude-opus-4-6', 'claude-haiku-5-5', 'opusplan', 'claude-opus-4-6', 'claude-haiku-5-5-20261001', 'claude-opus-4-6[1m]', 'Claude-Sonnet-5-5']
    const { $, logs } = home({ 'a-cc.json': catalogFile(ids) })
    expect(await readCatalog($)).toEqual(['claude-opus-4-6', 'claude-haiku-5-5', 'claude-opus-4-6[1m]'])
    expect(logs).toEqual([])
  })

  test('no more than 50 ids are taken, in the file\'s order', async () => {
    const ids = Array.from({ length: 70 }, (_, n) => `claude-model-${n + 1}`)
    const { $ } = home({ 'a-cc.json': catalogFile(ids) })
    expect(await readCatalog($)).toEqual(ids.slice(0, 50))
  })

  test('of two valid files the one with the later fetch time is taken, whatever the order of the listing', async () => {
    const older = catalogFile(['claude-opus-4-6'], { fetchedAt: 100 })
    const newer = catalogFile(['claude-opus-5-5'], { fetchedAt: 200 })
    expect(await readCatalog(home({ 'a-cc.json': older, 'b-cc.json': newer }).$)).toEqual(['claude-opus-5-5'])
    expect(await readCatalog(home({ 'a-cc.json': newer, 'b-cc.json': older }).$)).toEqual(['claude-opus-5-5'])
  })

  test('a valid file with no fetch time loses to one with, and a file that is not valid does not count', async () => {
    const dated = catalogFile(['claude-opus-4-6'], { fetchedAt: 5 })
    const undated = catalogFile(['claude-opus-5-5'], { fetchedAt: undefined })
    const { $, logs } = home({ 'a-cc.json': undated, 'b-cc.json': dated, 'c-cc.json': '{ broken' })
    expect(await readCatalog($)).toEqual(['claude-opus-4-6'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog file c-cc.json failed')
  })

  test('a file that cannot be read is skipped, recorded, and the others still count', async () => {
    const good = catalogFile(['claude-opus-4-6'], { fetchedAt: 1 })
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
      files[`f${n}-cc.json`] = catalogFile(['claude-opus-4-6'], { fetchedAt: 1 })
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
    const good = catalogFile(['claude-opus-4-6'])
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
    expect(await readChoices($)).toEqual({ list: ['opus', 'claude-opus-4-6'], defaultChoice: 'opus', filterIgnored: false, names: {} })
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

  test('a catalog with an entry that has no id still gives its other ids, and the entry is recorded', async () => {
    const { $, logs } = engineWith({ 'a-cc.json': models([{ id: 'claude-opus-4-6' }, { name: 'Opus 5.5' }]) }, undefined)
    expect((await readChoices($)).list).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'claude-opus-4-6'])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('model catalog file a-cc.json failed')
  })

  describe('the names', () => {
    test('the engine\'s own file gives each of its 13 ids its name, a date-suffixed id included, with nothing recorded', async () => {
      const { $, logs } = engineWith({ 'a-cc.json': ENGINE_CATALOG_FILE }, undefined)
      const { names } = await readChoices($)
      expect(names).toEqual(Object.fromEntries(CATALOG_IDS.map(id => [canonicalOf(id) ?? id, CATALOG_NAMES[id]])))
      expect(Object.keys(names)).toHaveLength(13)
      expect(names['claude-haiku-5-5']).toBe('Haiku 5.5')
      expect(names[canonicalOf('claude-haiku-4-5-20251001') ?? '']).toBe('Haiku 4.5')
      expect(logs).toEqual([])
    })

    test('an entry whose name is missing or not a string keeps its id, in its place, with no name and nothing recorded; the file\'s other names stand', async () => {
      const records = [{ id: 'claude-opus-4-6', name: 'Opus 4.6' }, { id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5', name: 7 }, { id: 'claude-sonnet-5-5', name: null }, { id: 'claude-fable-5-2', name: ['Fable 5.2'] }, { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }]
      const { $, logs } = engineWith({ 'a-cc.json': models(records) }, undefined)
      const choices = await readChoices($)
      expect(choices.list.slice(4)).toEqual(records.map(record => record.id))
      expect(choices.names).toEqual({ 'claude-opus-4-6': 'Opus 4.6', 'claude-sonnet-4-6': 'Sonnet 4.6' })
      expect(logs).toEqual([])
    })

    test('a record\'s name is the one beside its id, whatever order the file lists them in, and a record with no id gives none', async () => {
      const { $, logs } = engineWith({ 'a-cc.json': models([{ name: 'Ghost' }, { name: 'Opus 4.6', id: 'claude-opus-4-6' }, { id: 'claude-haiku-5-5', name: 'Haiku 5.5' }]) }, undefined)
      expect((await readChoices($)).names).toEqual({ 'claude-opus-4-6': 'Opus 4.6', 'claude-haiku-5-5': 'Haiku 5.5' })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('dropped for having no id: 1')
    })

    test('the name of an id is read from its own model record: an option nested under a record names nothing, so the id of a record with no name keeps none', async () => {
      const records = [
        { id: 'claude-haiku-5-5', name: 'Haiku 5.5', thinking: { effort_options: [{ id: 'claude-opus-4-6', name: 'Nested' }] }, fast_mode: { options: [{ id: 'claude-opus-4-6', name: 'Nested' }] } },
        { id: 'claude-opus-4-6' },
      ]
      const { $, logs } = engineWith({ 'a-cc.json': models(records) }, undefined)
      expect((await readChoices($)).names).toEqual({ 'claude-haiku-5-5': 'Haiku 5.5' })
      expect(logs).toEqual([])
    })

    test('the names are those of the ids the parse kept: in a file of 51 records whose 51st shares the first\'s name, the first keeps its name', async () => {
      const records = Array.from({ length: 51 }, (_, n) => ({ id: `claude-model-${n + 1}`, name: n === 50 ? 'Model 1' : `Model ${n + 1}` }))
      const { $ } = engineWith({ 'a-cc.json': models(records) }, undefined)
      const { list, names } = await readChoices($)
      expect(list).toHaveLength(4 + 50)
      expect(Object.keys(names)).toHaveLength(50)
      expect(names['claude-model-1']).toBe('Model 1')
    })

    test('a repeated id keeps the name of its first record', async () => {
      const { $ } = engineWith({ 'a-cc.json': models([{ id: 'claude-opus-4-6', name: 'Opus 4.6' }, { id: 'claude-opus-4-6-20261001', name: 'Opus 4.6 (dated)' }]) }, undefined)
      expect((await readChoices($)).names).toEqual({ 'claude-opus-4-6': 'Opus 4.6' })
    })

    test('availableModels filters the list and not the names: a model the filter removed keeps its name', async () => {
      const { $ } = engineWith({ 'a-cc.json': catalogFile(CATALOG_IDS, {}, CATALOG_NAMES) }, ['opus', 'claude-opus-4-6'])
      const choices = await readChoices($)
      expect(choices.list).toEqual(['opus', 'claude-opus-4-6'])
      expect(choices.names['claude-haiku-5-5']).toBe('Haiku 5.5')
      expect(Object.keys(choices.names)).toHaveLength(13)
    })

    test('a catalog that no file gives has no names', async () => {
      const { $ } = engineWith({}, undefined)
      expect((await readChoices($)).names).toEqual({})
    })
  })
})
