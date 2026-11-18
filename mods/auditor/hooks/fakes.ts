// A hand-made engine for the tests of the modules that take `$` as an argument (`boundary.ts`, `store.ts`, `catalog.ts`): the nouns a test gives, the debug log and the timers its calls leave. The test engine cannot make a hook's call reject or hang, so these tests call the module with this object.

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
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}
