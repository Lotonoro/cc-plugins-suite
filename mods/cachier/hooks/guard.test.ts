import { describe, expect, test } from 'claude-code/testing'
import { singleFlight } from './guard'

// A work item that waits until the test releases it; `calls` counts how many times it started.
const gated = () => {
  const releases: (() => void)[] = []
  const counts = { calls: 0 }
  const work = () => {
    counts.calls++
    return new Promise<void>((resolve) => {
      releases.push(resolve)
    })
  }
  return { work, counts, release: () => releases.forEach((r) => r()) }
}

describe('singleFlight', () => {
  test('a call that overlaps a running job is skipped, not queued behind it', async () => {
    const g = gated()
    const run = singleFlight()
    const first = run(g.work)
    await run(g.work)
    expect(g.counts.calls).toBe(1)
    g.release()
    await first
  })

  test('a call after the running job finishes runs again', async () => {
    const g = gated()
    const run = singleFlight()
    const first = run(g.work)
    g.release()
    await first
    const second = run(g.work)
    expect(g.counts.calls).toBe(2)
    g.release()
    await second
  })

  test('a failing job frees the runner, and its failure reaches the caller', async () => {
    let calls = 0
    const work = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
    }
    const run = singleFlight()
    let failure: unknown
    try {
      await run(work)
    } catch (err) {
      failure = err
    }
    expect(failure).toBeInstanceOf(Error)
    await run(work)
    expect(calls).toBe(2)
  })
})
