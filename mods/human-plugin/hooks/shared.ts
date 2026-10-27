import { atom, read, update, type EngineInterface } from 'claude-code'
import type { Store } from '../types'
import { EMPTY, carryNext, normalizeStore } from './items'

// The list lives in $.state (a hot reload keeps it). Its reference is declared here, with literal plugin and key, where the
// engine's scan of the state calls can read it.
const LIST = { plugin: 'human-plugin', key: 'list' } as const
const list = atom(LIST, EMPTY)

// The one door to the list. A stored list may hold items an older release wrote (see normalizeItem), so every read and update goes
// through the normalizer here. A read's copy is in memory only, so a draw can read it; an update writes what it returns.
// Every helper that takes $ is a function declaration, not an arrow: past an import the engine follows $ only into a declaration.
export async function readList($: EngineInterface): Promise<Store> {
  return normalizeStore(await read($, list))
}
export function updateList($: EngineInterface, change: (store: Store) => Store) {
  return update($, list, raw => change(normalizeStore(raw)))
}

// Work nothing awaits (a press's, a rebuild, a submit at a turn's end): a failure is shown in the log rather than lost.
export function inBackground($: EngineInterface, work: Promise<unknown>): void {
  void work.catch((err: unknown) => $.ui.log(`human-plugin: ${String(err)}`))
}

// The list written whole, for a /clear whose carry failed: it is emptied, and the counter the store kept is carried (session.end). The write
// is here, beside LIST, since the engine reads a state write's reference from the file that makes the write.
export async function emptyList($: EngineInterface, saved: unknown): Promise<void> {
  await $.state.set(LIST, carryNext(EMPTY, saved))
}
