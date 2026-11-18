// A hand-made engine for the tests of the modules that take `$` as an argument (`boundary.ts`, `store.ts`, `catalog.ts`): the nouns a test gives, the debug log and the timers its calls leave. The test engine cannot make a hook's call reject or hang, so these tests call the module with this object. The model catalog fixture at the end is shared with the register tests, and `catalogfile.ts` holds the engine's own catalog file.

export type FakeTimer = { ms: number; fire: () => void; cancelled: boolean }
export type Fake = { $: any; logs: string[]; timers: FakeTimer[] }

// `nouns` replace the defaults: a `clock` of the test's own, say, one that throws.
export const fakeEngine = (nouns: Record<string, unknown> = {}): Fake => {
  const logs: string[] = []
  const timers: FakeTimer[] = []
  const $ = {
    ui: {
      log: (text: string): void => {
        logs.push(text)
      },
    },
    // A timer fires only when a test fires it; cancelling one marks it.
    clock: {
      after: (ms: number, fire: () => void): { cancel: () => void } => {
        const timer: FakeTimer = { ms, fire, cancelled: false }
        timers.push(timer)
        return {
          cancel: () => {
            timer.cancelled = true
          },
        }
      },
    },
    ...nouns,
  }
  return { $, logs, timers }
}

// A call no one answers.
export const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

// Lets what is waiting on already-settled promises run.
export const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve()
}

// The ids of the engine's model catalog cache as it was read once: 13, in the picker's order, which are the `id` of each model of `catalog.config.models` in the file `catalogfile.ts` holds.
export const CATALOG_IDS: readonly string[] = ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']

// A catalog file in the engine's shape, with a model for each of `ids`, each holding its id alone, and the alias targets, which are present and never read. `over` sets keys at the top of the file, and a key set to undefined leaves it out of the text: `{ fetchedAt: undefined }` is a file that does not say when it was fetched.
export const catalogFile = (ids: readonly string[] = CATALOG_IDS, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 2,
    fetchedAt: 1_794_728_996_752,
    staleAt: 1_794_731_126_951,
    catalog: { surface: 'cc', config: { id: 'cc', models: ids.map(id => ({ id })), provider_alias_targets: { fable: { default: 'claude-fable-5-2' }, haiku: { default: 'claude-haiku-5-5' } } } },
    ...over,
  })
