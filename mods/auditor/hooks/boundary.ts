import type { CoreEngineInterface } from 'claude-code'

// How the plugin treats a call it makes across the engine's edge: a failure is recorded and never thrown at the worker, and a call that does not answer in time counts as failed. These take `$` as an argument, and are function declarations, since a hooks module's `$` is followed past an import only into one.

export const PLUGIN = 'auditor'

// How long a call to the session's cost ledger, the plugin's own store, the engine's model catalog or the settings may take to answer before it counts as failed: a local read that answers at all answers well within it, and each is one engine call on the redraw or start path.
export const BOUND_MS = 1000

// A failed call must not fail the worker's turn or re-run its call: log it with its stack. Nothing is shown: only an escalation and a failing reviewer (the footer label) reach the user.
export function recordFailed($: Pick<CoreEngineInterface, 'ui'>, what: string, err: unknown): void {
  $.ui.log(`${PLUGIN}: ${what} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: 'debug' })
}

// Makes `call` and waits for its answer for at most BOUND_MS: the answer, wrapped since it may itself be undefined, or undefined when the call rejected, the timer could not be set or nothing answered in time, each recorded under `what` (the last as late). A call that never answers is left to finish or hang, its late answer or rejection ignored.
export async function within<T>($: Pick<CoreEngineInterface, 'clock' | 'ui'>, what: string, call: () => Promise<T>): Promise<{ value: T } | undefined> {
  let late: () => void = () => undefined
  const timeout = new Promise<null>(resolve => {
    late = () => resolve(null)
  })
  let timer: { cancel: () => void } | undefined
  try {
    timer = $.clock.after(BOUND_MS, late)
    const answer = await Promise.race([call().then(value => ({ value })), timeout])
    if (answer === null) {
      recordFailed($, what, new Error(`no answer within ${BOUND_MS} ms`))
      return undefined
    }
    return answer
  } catch (err) {
    recordFailed($, what, err)
    return undefined
  } finally {
    timer?.cancel()
  }
}
