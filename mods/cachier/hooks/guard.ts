// A single-flight runner: a call that finds a job running is skipped, not queued behind it. The running job is waited
// on, not timed out: each process run carries its own timeout.
export const singleFlight = () => {
  let running = false
  return async (work: () => Promise<void>): Promise<void> => {
    if (running) return
    running = true
    try {
      await work()
    } finally {
      running = false
    }
  }
}
