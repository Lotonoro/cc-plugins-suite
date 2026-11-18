import { describe, expect, test } from 'claude-code/testing'
import { BOUND_MS, recordFailed, within } from './boundary'
import { fakeEngine, never, settled } from './fakes'

describe('recordFailed', () => {
  test('logs the failure under the plugin\'s name with its stack, to the debug log', () => {
    const logged: { text: string; options: unknown }[] = []
    const err = new Error('disk full')
    recordFailed({ ui: { log: (text: string, options: unknown) => logged.push({ text, options }) } } as any, 'review log', err)
    expect(logged).toEqual([{ text: `auditor: review log failed: ${err.stack}`, options: { to: 'debug' } }])
  })

  test('logs a thrown value that is not an error as its text', () => {
    const logged: string[] = []
    recordFailed({ ui: { log: (text: string) => logged.push(text) } } as any, 'review log', 'plain words')
    expect(logged).toEqual(['auditor: review log failed: plain words'])
  })
})

describe('within', () => {
  test('answers with the call\'s answer, which may itself be undefined, and cancels its timer', async () => {
    const { $, logs, timers } = fakeEngine()
    expect(await within($, 'a read', async () => 7)).toEqual({ value: 7 })
    expect(await within($, 'a read', async () => undefined)).toEqual({ value: undefined })
    expect(timers.map(t => [t.ms, t.cancelled])).toEqual([[BOUND_MS, true], [BOUND_MS, true]])
    expect(logs).toEqual([])
  })

  test('the bound is one second', () => {
    expect(BOUND_MS).toBe(1000)
  })

  test('a rejected call answers nothing and is recorded with its stack', async () => {
    const { $, logs, timers } = fakeEngine()
    expect(await within($, 'a read', () => Promise.reject(new Error('no disk')))).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.startsWith('auditor: a read failed: Error: no disk')).toBe(true)
    expect(timers[0]?.cancelled).toBe(true)
  })

  test('a call that throws before it returns a promise is recorded the same way', async () => {
    const { $, logs } = fakeEngine()
    expect(
      await within($, 'a read', () => {
        throw new Error('bad call')
      }),
    ).toBeUndefined()
    expect(logs[0]?.startsWith('auditor: a read failed: Error: bad call')).toBe(true)
  })

  test('a call that never answers answers nothing once the bound passes, and is recorded as late', async () => {
    const { $, logs, timers } = fakeEngine()
    const pending = within($, 'a read', () => never<number>())
    expect(timers.map(t => t.ms)).toEqual([BOUND_MS])
    timers[0]?.fire()
    expect(await pending).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.startsWith(`auditor: a read failed: Error: no answer within ${BOUND_MS} ms`)).toBe(true)
    expect(timers[0]?.cancelled).toBe(true)
  })

  test('an answer or a rejection that comes after the bound changes nothing and leaves nothing unhandled', async () => {
    const { $, logs, timers } = fakeEngine()
    let reject: (err: Error) => void = () => undefined
    const pending = within($, 'a read', () => new Promise<number>((_, no) => (reject = no)))
    timers[0]?.fire()
    expect(await pending).toBeUndefined()
    reject(new Error('too late'))
    await settled()
    expect(logs).toHaveLength(1)
  })

  test('a clock that cannot set the timer answers nothing, is recorded, and makes no call', async () => {
    let called = false
    const { $, logs } = fakeEngine({
      clock: {
        after: () => {
          throw new Error('clock unavailable')
        },
      },
    })
    expect(
      await within($, 'a read', async () => {
        called = true
        return 1
      }),
    ).toBeUndefined()
    expect(called).toBe(false)
    expect(logs[0]?.startsWith('auditor: a read failed: Error: clock unavailable')).toBe(true)
  })
})
