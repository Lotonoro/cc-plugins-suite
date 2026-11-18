import type { CoreEngineInterface, FsEntry } from 'claude-code'
import { recordFailed, within } from './boundary'
import { canonicalOf, choicesOf, isNames } from './models'
import type { Choices } from './models'

// The one adapter for what the engine's `/model` offers: the model catalog it caches under its config home, and the `availableModels` setting that filters the picker. The plugin only reads both, so they sit apart from `store.ts`, which owns the keys the plugin writes; the cache is an engine internal that changes for the engine's reasons, so a release that moves or reshapes it touches this module, its test and the catalog fixtures (`fakes.ts`, `catalogfile.ts`) alone. Every failure answers "no catalog" or "no filter", recorded, and the caller falls back to the four aliases; every call is bounded (`within`). It takes `$` as an argument, so its tests use a fake, and its `$`-taking helpers are function declarations.

type Scope = Pick<CoreEngineInterface, 'env' | 'fs' | 'settings' | 'clock' | 'ui'>

// Where the engine keeps the catalog, under its config home, and the end of a file's name there.
const CATALOG_DIR = 'cache/model-catalog'
const CATALOG_SUFFIX = '-cc.json'
// A file over this many bytes is not read (the one measured held 16 KB), and no more ids than this are taken from one.
const MAX_FILE_BYTES = 256 * 1024
const MAX_IDS = 50
// The newest files read: a config home holds one file per account it served, and only the latest fetch counts, so a directory of many is not read whole.
const MAX_FILES = 8

// One file's ids and when it was fetched, as the file says; a file that says nothing sorts last.
type Catalog = { ids: string[]; fetchedAt: number }

const fieldsOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

// The catalog a file's text holds; throws the reason it holds none. The file holds `catalog.config.models`, a list of records, each with the `id` of a model: the catalog's ids are those that are full ids, one repeated in canonical form once, in the file's order. The file's alias targets (`catalog.config.provider_alias_targets`) are never read: they named a Fable the engine did not run.
const catalogOf = (text: string): Catalog => {
  const file = fieldsOf(JSON.parse(text))
  const models = fieldsOf(fieldsOf(file['catalog'])['config'])['models']
  if (!Array.isArray(models)) throw new Error('the file holds no list of models at catalog.config.models')
  const listed = models.map(model => fieldsOf(model)['id'])
  if (!isNames(listed)) throw new Error('a model in catalog.config.models has no id')
  const kept = new Set<string>()
  const ids: string[] = []
  for (const id of listed) {
    const canonical = canonicalOf(id)
    if (canonical === undefined || kept.has(canonical)) continue
    kept.add(canonical)
    ids.push(id)
    if (ids.length === MAX_IDS) break
  }
  if (ids.length === 0) throw new Error('no entry of the list is a full model id')
  const fetchedAt = file['fetchedAt']
  return { ids, fetchedAt: typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : -Infinity }
}

// The directory of the engine's catalog cache: under `CLAUDE_CONFIG_DIR` when that is set, else under `.claude` in the home directory. Undefined, recorded, where the read failed or neither is known.
async function catalogDir($: Scope): Promise<string | undefined> {
  const read = await within($, 'model catalog location', async () => ({ configured: await $.env.get('CLAUDE_CONFIG_DIR'), home: await $.env.get('HOME') }))
  if (read === undefined) return undefined
  const { configured, home } = read.value
  const base = configured !== undefined && configured !== '' ? configured : home !== undefined && home !== '' ? `${home}/.claude` : undefined
  if (base === undefined) {
    recordFailed($, 'model catalog location', new Error('neither CLAUDE_CONFIG_DIR nor HOME is set'))
    return undefined
  }
  return `${base.replace(/\/+$/, '')}/${CATALOG_DIR}`
}

// One file's catalog, or undefined with the reason recorded: too large to read, unread, late, or not a catalog.
async function readCatalogFile($: Scope, dir: string, file: FsEntry): Promise<Catalog | undefined> {
  const what = `model catalog file ${file.name}`
  if (file.size > MAX_FILE_BYTES) {
    recordFailed($, what, new Error(`the file is over ${MAX_FILE_BYTES} bytes`))
    return undefined
  }
  const read = await within($, what, () => $.fs.read(`${dir}/${file.name}`))
  if (read === undefined) return undefined
  try {
    return catalogOf(read.value)
  } catch (err) {
    recordFailed($, what, err)
    return undefined
  }
}

// The catalog's ids in its order, or undefined, recorded, where there is none: no directory, no file, or no file that holds a list of full ids. Of several valid files the one fetched last wins, so a config home that served two accounts still gives a list.
export async function readCatalog($: Scope): Promise<string[] | undefined> {
  const dir = await catalogDir($)
  if (dir === undefined) return undefined
  const listed = await within($, 'model catalog listing', () => $.fs.list(dir))
  if (listed === undefined) return undefined
  const files = listed.value.filter(file => file.kind === 'file' && file.name.endsWith(CATALOG_SUFFIX)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES)
  if (files.length === 0) {
    recordFailed($, 'model catalog listing', new Error(`no catalog file in ${dir}`))
    return undefined
  }
  let newest: Catalog | undefined
  for (const catalog of await Promise.all(files.map(file => readCatalogFile($, dir, file)))) {
    if (catalog !== undefined && (newest === undefined || catalog.fetchedAt > newest.fetchedAt)) newest = catalog
  }
  return newest?.ids
}

// The `availableModels` setting as a list of names, or undefined where it is not set, cannot be read, or is not a list of names, which counts as unset: the last two recorded.
export async function readAvailable($: Scope): Promise<string[] | undefined> {
  const read = await within($, 'availableModels read', () => $.settings.read({ key: 'availableModels' }))
  const value = read?.value
  if (value === undefined) return undefined
  if (isNames(value)) return value
  recordFailed($, 'availableModels read', new Error('the setting is not a list of names'))
  return undefined
}

// What `/auditor model` offers and a conversation takes from: the four aliases and the catalog's ids, filtered by `availableModels` when it is set. A catalog or a setting that could not be read leaves the choices as they stand without it, and a filter that leaves nothing is ignored, recorded.
export async function readChoices($: Scope): Promise<Choices> {
  const [catalog, available] = await Promise.all([readCatalog($), readAvailable($)])
  const choices = choicesOf(catalog, available)
  if (choices.filterIgnored) recordFailed($, 'availableModels filter', new Error('the setting leaves no choice, so it is ignored'))
  return choices
}
