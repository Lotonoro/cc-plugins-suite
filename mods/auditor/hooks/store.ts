import type { CoreEngineInterface } from 'claude-code'
import { recordFailed, within } from './boundary'
import { isFullId, keepsPair } from './models'
import type { ModelIds } from './models'

// The one adapter for the plugin's own `$.store`: it owns the keys, and turns each stored value, which the engine types as unknown, into a typed one. A value of the wrong shape reads as absent, and is recorded. One policy for every call (`within`, bounded): a failed or late read reads as absent, so the take falls back to the default; a failed or late write is recorded and leaves the state as the caller decided. It takes `$` as an argument, so its tests use a fake; a change callback in register.ts is synchronous, so register.ts calls these before it and passes the values in.

type Scope = Pick<CoreEngineInterface, 'store' | 'clock' | 'ui'>

// The last model set, by any session: new sessions follow it.
const LAST_MODEL = 'lastModel'
// What each alias last resolved to, as a spawn result named it: the choice, and the full id.
const MODEL_IDS = 'modelIds'

// The last model set, or undefined where none is stored, the read failed or the value is not a model name.
export async function readLastModel($: Scope): Promise<string | undefined> {
  const read = await within($, 'store read of the last model set', () => $.store.get(LAST_MODEL))
  const value = read?.value
  if (value === undefined) return undefined
  if (typeof value === 'string' && value !== '') return value
  recordFailed($, 'store read of the last model set', new Error('the stored value is not a model name'))
  return undefined
}

// Stores `name` as the last model set. A failed write is recorded.
export async function writeLastModel($: Scope, name: string): Promise<void> {
  await within($, 'store write of the last model set', () => $.store.set(LAST_MODEL, name))
}

// The pairs of a stored table whose id is a full id, and whether the value held nothing else.
const pairsOf = (value: unknown): { ids: Record<string, string>; wellFormed: boolean } => {
  if (value === undefined) return { ids: {}, wellFormed: true }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ids: {}, wellFormed: false }
  const entries = Object.entries(value)
  const ids = Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string' && isFullId(entry[1])))
  return { ids, wellFormed: Object.keys(ids).length === entries.length }
}

// The table, or undefined where the read failed (recorded), which a caller that writes it back must tell from an empty one.
async function readTable($: Scope): Promise<Record<string, string> | undefined> {
  const read = await within($, 'store read of the model ids', () => $.store.get(MODEL_IDS))
  if (read === undefined) return undefined
  const { ids, wellFormed } = pairsOf(read.value)
  if (!wellFormed) recordFailed($, 'store read of the model ids', new Error('the stored value is not a table of full ids'))
  return ids
}

// Each choice with the full id a spawn last resolved it to. A failed read, a value of the wrong shape or nothing stored reads as no pairs.
export async function readModelIds($: Scope): Promise<ModelIds> {
  return (await readTable($)) ?? {}
}

// Stores the full id a spawn result named for `choice`, where `keepsPair` keeps the pair. A table already holding the pair is not written again, and one that could not be read is not written over, so the pairs it held are not lost. Two sessions writing at once can lose a pair, which the next spawn result restores.
export async function storeModelId($: Scope, choice: string, id: string): Promise<void> {
  if (!keepsPair(choice, id)) return
  const ids = await readTable($)
  if (ids === undefined || ids[choice] === id) return
  await within($, 'store write of the model ids', () => $.store.set(MODEL_IDS, { ...ids, [choice]: id }))
}
