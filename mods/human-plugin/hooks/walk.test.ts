import { expect, test } from 'claude-code/testing'
import { ALREADY_ASKING, NOTHING_OPEN } from './commands'
import { doneNotice, pointerText, type Form } from './done'
import { carryHeld, endTurn, handOver, offer, pending, reset, startTurn } from './turns'
import { endWalk, observeAsked, walk } from './walk'
import { pressAnswer, stopTicker } from './windows'
import type { Item, Store } from '../types'

// The walk driven with a hand-built `$`: the kit has no way to script a person's answer to `$.ui.ask`, so the `$` here answers each dialog from a script, and
// before a dialog returns it hands the plugin's own tool.call observer the call and a result, as the engine does (the observer's hook sees the result first).
// The state holds a real list, so the guarded write, its window and its tick run against it.

const WINDOW = 3000
const base: Item = {
  id: 0, title: '', detail: '', blocking: false, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false,
  options: [], answer: null, yesno: false, replied: false, doneLabel: null, thread: [], windowTurns: [], windowChanged: false,
}
const made = (id: number, extra: Partial<Item> = {}): Item => ({ ...base, id, title: `Item ${id}`, detail: `Brief ${id}.`, ...extra })
const SQLITE = { label: 'Use sqlite', description: '', recommended: false }
const POSTGRES = { label: 'Use postgres', description: 'Shared', recommended: true }
// A decision: in the pane's order its options are Use postgres (recommended), then Use sqlite.
const pick = (id: number, extra: Partial<Item> = {}): Item => made(id, { title: `Pick ${id}`, options: [SQLITE, POSTGRES], ...extra })

type Edit = (id: number, change: (item: Item) => Item) => void
type Values = { list: Store }
type Step = {
  // What the dialog gives back, or the message it is rejected with.
  gives: string | { rejects: string }
  // What the observer is handed before the dialog returns: the result of an answer (the default), an auto-continued one, one for another question, or nothing.
  seen?: 'answered' | 'auto' | 'other' | 'none'
  // The call (made from the question asked) and the result the observer is handed, in place of the ones the scripted answer makes.
  observed?: { call: (question: string) => unknown; result: unknown }
  // Runs while the dialog is open: the list changes as the agent or the person may change it.
  during?: (edit: Edit, values: Values) => void
  // The dialog stays open until this settles.
  wait?: Promise<void>
}
// A timer the mod started: its wait, and whether it is a one-shot (`after`), which runs once and is gone, or a tick (`every`).
type Tick = { fn: () => unknown; ms: number; once: boolean }
type Asked = { question: string; options: readonly string[]; header: string | undefined }

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

// Lets pending work run until `done` holds. The bound makes a walk that never gets there fail its test's next check instead of hanging it.
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 40 && !done(); i++) await settle()
}

const walkEnv = (items: Item[], steps: Step[]) => {
  const values: { list: Store; selection: null } = { list: { items, next: items.length + 1, term: null }, selection: null }
  const clock = { now: 0 }
  const timers: Tick[] = []
  const debug: string[] = []
  const shown: string[] = []
  const submitted: unknown[] = []
  const asked: Asked[] = []
  // A read of the list that throws once, when the list is as the predicate says (the predicate may have effects of its own).
  const breakGet: { when: ((list: Store) => boolean) | null } = { when: null }
  // The next read of the list waits for this to settle, and is answered with the list as it stands then: a read kept in flight while the test goes on.
  const slowGet: { until: Promise<void> | null } = { until: null }
  // What the host does besides the usual: the clock refuses to arm a one-shot timer, and the engine refuses (a drop) or fails (a throw) a prompt the mod submits.
  const refuse: { arm: Error | null; submit: { drop: string } | { throws: Error } | null } = { arm: null, submit: null }
  const stop = (timer: Tick): void => {
    const at = timers.indexOf(timer)
    if (at >= 0) timers.splice(at, 1)
  }
  const edit: Edit = (id, change) => {
    values.list = { ...values.list, items: values.list.items.map(it => (it.id === id ? change(it) : it)) }
  }
  const dollar: { ui: { ask: (question: string, options: { options: readonly string[]; header?: string }) => Promise<string> } & Record<string, unknown> } & Record<string, unknown> = {
    state: {
      get: async (ref: { key: string }) => {
        if (breakGet.when !== null && breakGet.when(values.list)) {
          breakGet.when = null
          throw new Error('list unreadable')
        }
        const held = slowGet.until
        if (held !== null) {
          slowGet.until = null
          await held
        }
        return { value: values[ref.key as 'list' | 'selection'], version: 1 }
      },
      set: async (ref: { key: string }, value: unknown) => {
        values[ref.key as 'list' | 'selection'] = value as never
        return { isSet: true, version: 2 }
      },
    },
    store: { get: async () => undefined, set: async () => {} },
    clock: {
      now: async () => clock.now,
      // A one-shot timer keeps its wait, runs once and is gone, and a cancel takes it out.
      after: (ms: number, fn: () => unknown) => {
        if (refuse.arm !== null) throw refuse.arm
        const timer: Tick = {
          ms,
          once: true,
          fn: () => {
            stop(timer)
            return fn()
          },
        }
        timers.push(timer)
        return { cancel: () => stop(timer) }
      },
      every: (ms: number, fn: () => unknown) => {
        const timer: Tick = { ms, once: false, fn }
        timers.push(timer)
        return { cancel: () => stop(timer) }
      },
    },
    ui: {
      invalidate: () => {},
      log: (text: string, options?: { to?: string }) => void (options?.to === 'debug' ? debug : shown).push(text),
      open: async () => ({ isPlaced: true }),
      close: async () => {},
      panes: async () => [],
      ask: async (question: string, options: { options: readonly string[]; header?: string }) => {
        const step = steps[asked.length]
        asked.push({ question, options: options.options, header: options.header })
        if (step === undefined) throw new Error('an ask nobody scripted')
        step.during?.(edit, values)
        await step.wait
        const rejects = typeof step.gives === 'object'
        const answer = typeof step.gives === 'string' ? step.gives : step.gives.rejects
        const seen = step.seen ?? 'answered'
        if (step.observed !== undefined) {
          observeAsked(dollar as never, step.observed.call(question), step.observed.result)
        } else if (seen !== 'none') {
          const carried = seen === 'other' ? `${question} (another)` : question
          const call = { tool: 'AskUserQuestion', questions: [{ question: carried, header: options.header, options: options.options.map(label => ({ label })), multiSelect: false }] }
          const result = rejects
            ? { ref: 'r', result: `Error: ${answer}`, text: `Error: ${answer}`, isError: true }
            : { ref: 'r', result: { questions: call.questions, answers: { [carried]: answer }, ...(seen === 'auto' ? { afkTimeoutMs: 20000 } : {}) }, text: answer, isReadOnly: true }
          observeAsked(dollar as never, call, result)
        }
        if (rejects) throw new Error(answer)
        return answer
      },
    },
    prompt: {
      submit: async (e: unknown) => {
        submitted.push(e)
        if (refuse.submit === null) return {}
        if ('throws' in refuse.submit) throw refuse.submit.throws
        return { drop: refuse.submit.drop }
      },
    },
  }
  return { env: dollar as never, values, clock, timers, debug, shown, submitted, asked, steps, breakGet, slowGet, refuse }
}

// A walk starts from nothing: the modules keep the walk's flag, the undo ticker and the turn's notices between tests.
const fresh = (): void => {
  endWalk()
  stopTicker()
  reset()
}

// The clock moves to `at`, and each timer the mod has started runs once there, in the order they were armed: a tick ends the undo windows whose time has run out,
// and a one-shot timer (the walk's release) runs and is gone. `only` runs the ticks or the one-shots alone, so a test can let the ticks settle before the release.
const tickAt = async (timers: Tick[], clock: { now: number }, at: number, only?: 'ticks' | 'one-shots'): Promise<void> => {
  clock.now = at
  for (const timer of [...timers]) if (only === undefined || timer.once === (only === 'one-shots')) await timer.fn()
  await settle()
}
// The waits of the one-shot timers pending: the walk's release, one at most.
const oneShots = (timers: Tick[]): number[] => timers.filter(timer => timer.once).map(timer => timer.ms)
// The append of a turn's read point, which keeps each row it is handed.
const appendTo = (into: string[]) => async (text: string): Promise<boolean> => {
  into.push(text)
  return true
}

const lines = (text: string): string[] => text.split('\n')
const itemOf = (values: Values, id: number): Item => values.list.items.find(it => it.id === id) as Item
// The walk's own debug lines: its records and its asks.
const walkLines = (debug: string[]): string[] => debug.filter(line => line.startsWith('human-plugin: walk '))
const without = (values: Values, id: number): void => void (values.list = { ...values.list, items: values.list.items.filter(it => it.id !== id) })

test('a walk asks about the first open item, blocking first: the summary and the position open the text, the header is the item\'s number and the labels follow', async () => {
  fresh()
  const { env, asked } = walkEnv([made(1), pick(2, { blocking: true }), made(3)], [{ gives: 'Stop' }])
  await walk(env, WINDOW)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.header).toBe('#2')
  expect(asked[0]?.options).toEqual(['Use postgres', 'Use sqlite', 'Stop', 'Skip'])
  expect(lines(asked[0]?.question ?? '').slice(0, 3)).toEqual([
    '1 blocking and 2 non-blocking items are open.',
    'They are asked one at a time, blocking first, and each answer is written to the list as you give it and reaches the agent when the walk ends. Stop, stop typed under Other, or closing the question ends the walk; Skip passes over an item. What you have not answered stays on the list.',
    '▶ 1 of 3 — #2 blocking: Pick 2',
  ])
})

test('the questions come blocking first and then by id, each opening with the previous item\'s outcome line', async () => {
  fresh()
  const { env, asked } = walkEnv([made(1), made(2), made(3, { blocking: true })], [{ gives: 'Skip' }, { gives: 'Skip' }, { gives: 'Skip' }])
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#3', '#1', '#2'])
  expect(lines(asked[1]?.question ?? '').slice(0, 2)).toEqual(['skipped #3', '▶ 2 of 3 — #1 non-blocking: Item 1'])
  expect(lines(asked[2]?.question ?? '').slice(0, 2)).toEqual(['skipped #1', '▶ 3 of 3 — #2 non-blocking: Item 2'])
  expect(text).toBe(
    [
      '  skipped #2',
      '  It asked about every open item.',
      '  The walk sent nothing; 3 items are still open. /todo answer asks about them again.',
    ].join('\n'),
  )
})

test('a question\'s position line is the only line that opens with the marker: the first question\'s summary and the skipped line that leads a later one carry none', async () => {
  fresh()
  const { env, asked } = walkEnv([made(1), made(2)], [{ gives: 'Skip' }, { gives: 'Skip' }])
  await walk(env, WINDOW)
  expect(asked).toHaveLength(2)
  const [first, second] = asked.map(a => lines(a.question))
  expect(first?.filter(line => line.startsWith('▶'))).toEqual(['▶ 1 of 2 — #1 non-blocking: Item 1'])
  expect(second?.[0]).toBe('skipped #1')
  expect(second?.filter(line => line.startsWith('▶'))).toEqual(['▶ 2 of 2 — #2 non-blocking: Item 2'])
})

test('with nothing open the walk asks nothing and says so', async () => {
  fresh()
  const { env, asked } = walkEnv([made(1, { state: 'done-pending', answer: 'done' }), made(2, { state: 'done-waiting', pressedAt: 0, answer: 'done' })], [])
  expect(await walk(env, WINDOW)).toBe(NOTHING_OPEN)
  expect(asked).toEqual([])
  expect(await walk(walkEnv([], []).env, WINDOW)).toBe(NOTHING_OPEN)
})

test('a second walk while one is asking says so and asks nothing; once the first ends, a new walk asks', async () => {
  fresh()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, asked, steps } = walkEnv([made(1)], [{ gives: 'Skip', wait: gate }])
  const first = walk(env, WINDOW)
  await settle()
  expect(asked).toHaveLength(1)
  expect(await walk(env, WINDOW)).toBe(ALREADY_ASKING)
  expect(asked).toHaveLength(1)
  release()
  expect(await first).toContain('It asked about every open item.')
  steps.push({ gives: 'Skip' })
  expect(await walk(env, WINDOW)).toContain('It asked about every open item.')
  expect(asked).toHaveLength(2)
})

test('a walk that fails before it asks anything lets the next walk start', async () => {
  fresh()
  const { env, breakGet, asked } = walkEnv([made(1)], [{ gives: 'Skip' }])
  breakGet.when = () => true
  expect(await walk(env, WINDOW)).toContain('It stopped on an error, which was logged.')
  expect(asked).toEqual([])
  expect(await walk(env, WINDOW)).toContain('It asked about every open item.')
  expect(asked).toHaveLength(1)
})

test('an item filed while the walk asks is asked in the band\'s order, one removed is not asked, and no item is asked twice', async () => {
  fresh()
  const { env, asked } = walkEnv(
    [made(1), made(2), made(3)],
    [
      { gives: 'Skip', during: (_edit, values) => void (values.list = { ...values.list, items: [...values.list.items.filter(it => it.id !== 3), made(4, { blocking: true })] }) },
      { gives: 'Skip' },
      { gives: 'Skip' },
    ],
  )
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1', '#4', '#2'])
  expect(lines(asked[1]?.question ?? '')[1]).toBe('▶ 2 of 3 — #4 blocking: Item 4')
  expect(text).toContain('It asked about every open item.')
})

test('an item whose write was refused is not asked a second time in the same walk, and the next walk asks it', async () => {
  fresh()
  const { env, asked, values, steps } = walkEnv(
    [made(1), made(2)],
    [{ gives: 'Done', during: edit => edit(1, it => ({ ...it, title: 'Retitled' })) }, { gives: 'Skip' }],
  )
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1', '#2'])
  expect(lines(asked[1]?.question ?? '')[0]).toBe('#1 changed while it was shown, so nothing was sent; /todo answer asks it again.')
  expect(text).toContain('The walk sent nothing; 2 items are still open.')
  expect(itemOf(values, 1)).toMatchObject({ state: 'open', title: 'Retitled' })
  steps.push({ gives: 'Skip' }, { gives: 'Skip' })
  await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1', '#2', '#1', '#2'])
})

test('an item the agent reopens after the walk answered it is not asked a second time in the same walk', async () => {
  fresh()
  const { env, asked, values } = walkEnv(
    [made(1), made(2)],
    [
      { gives: 'Done' },
      {
        gives: 'Skip',
        // The answer to #1 is sent and the agent answers back: the item is open again with the exchange in its thread.
        during: edit => edit(1, it => ({ ...it, state: 'open', pressedAt: null, answer: null, thread: [{ speaker: 'human', words: 'pressed done' }, { speaker: 'agent', words: 'Again?' }] })),
      },
    ],
  )
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1', '#2'])
  expect(itemOf(values, 1).state).toBe('open')
  expect(text).toContain('It asked about every open item.')
  expect(text).toContain('The walk sent 1 answer; 2 items are still open.')
})

test('each answer label writes its form through the path /todo <n> <form> takes: the same list and, a tick later, the same notice', async () => {
  const cases: [string, Item, Form, string][] = [
    ['an option', pick(3), { kind: 'option', n: 2 }, 'Use sqlite'],
    ['the recommended option', pick(3), { kind: 'option', n: 1 }, 'Use postgres'],
    ['a yes', made(3, { yesno: true }), { kind: 'yes' }, 'Yes'],
    ['a no', made(3, { yesno: true }), { kind: 'no' }, 'No'],
    ['a done', made(3), { kind: 'done' }, 'Done'],
    ['a labelled done', made(3, { doneLabel: 'Ship it' }), { kind: 'done' }, 'Ship it'],
    ['a reply', made(3), { kind: 'reply', text: 'Use sqlite\nnot postgres' }, '  Use sqlite\nnot postgres  '],
    ['an option typed by its number', pick(3), { kind: 'option', n: 2 }, '2'],
    ['a yes typed in lower case', made(3, { yesno: true }), { kind: 'yes' }, 'yes'],
  ]
  for (const [name, item, form, gives] of cases) {
    fresh()
    const typed = walkEnv([item], [])
    typed.clock.now = 1000
    await pressAnswer(typed.env, '3', form, WINDOW)
    await tickAt(typed.timers, typed.clock, 1000)

    fresh()
    const walked = walkEnv([item], [{ gives }])
    walked.clock.now = 1000
    await walk(walked.env, WINDOW)
    await tickAt(walked.timers, walked.clock, 1000)

    expect([name, walked.values.list]).toEqual([name, typed.values.list])
    expect([name, walked.submitted]).toEqual([name, typed.submitted])
    expect(walked.submitted).toHaveLength(1)
    expect(walked.values.list.items[0]).toMatchObject({ state: 'done-pending', unread: false })
  }
})

test('each answer waits for the first tick, with no window of its own, and has a notice of its own', async () => {
  fresh()
  const { env, values, clock, timers, submitted } = walkEnv([made(1), made(2)], [{ gives: 'Done' }, { gives: 'Done' }])
  clock.now = 1000
  await walk(env, WINDOW)
  expect(values.list.items.map(it => it.state)).toEqual(['done-waiting', 'done-waiting'])
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(values.list.items.map(it => it.state)).toEqual(['done-pending', 'done-pending'])
  // The first notice starts a turn of its own; the second waits for that turn's next read point.
  expect(submitted).toEqual([{ text: doneNotice(itemOf(values, 1)) }])
  expect(pending().waiting).toEqual([{ id: 2, text: doneNotice(itemOf(values, 2)) }])
})

test('showing an item clears its unread mark, and the marks of the items not shown stay', async () => {
  fresh()
  const both = walkEnv([made(1, { unread: true }), made(2, { unread: true })], [{ gives: 'Skip' }, { gives: 'Stop' }])
  await walk(both.env, WINDOW)
  expect(both.values.list.items.map(it => it.unread)).toEqual([false, false])
  fresh()
  const first = walkEnv([made(1, { unread: true }), made(2, { unread: true })], [{ gives: 'Stop' }])
  await walk(first.env, WINDOW)
  expect(first.values.list.items.map(it => it.unread)).toEqual([false, true])
})

test('a skip writes nothing and goes on; a blank answer skips', async () => {
  fresh()
  const { env, values, asked } = walkEnv([made(1), made(2)], [{ gives: 'Skip' }, { gives: '   ' }])
  const text = await walk(env, WINDOW)
  expect(asked).toHaveLength(2)
  expect(values.list.items.map(it => it.state)).toEqual(['open', 'open'])
  expect(text.startsWith('  skipped #2\n')).toBe(true)
  expect(text).toContain('The walk sent nothing; 2 items are still open.')
})

test('Stop ends the walk with its reason and the count of what was sent; the answers written before it stay', async () => {
  fresh()
  const { env, values, debug, asked } = walkEnv([pick(1, { blocking: true }), made(2), made(3)], [{ gives: 'Use sqlite' }, { gives: 'Skip' }, { gives: 'Stop' }])
  const text = await walk(env, WINDOW)
  expect(asked).toHaveLength(3)
  expect(text).toBe(['  It ended on Stop.', '  The walk sent 1 answer; 2 items are still open. /todo answer asks about them again.'].join('\n'))
  expect(itemOf(values, 1)).toMatchObject({ state: 'done-waiting', answer: 'Use sqlite' })
  expect(values.list.items.slice(1).map(it => it.state)).toEqual(['open', 'open'])
  expect(lines(asked[1]?.question ?? '')[0]).toBe('answered #1 with Use sqlite')
  expect(debug).toContain('human-plugin: walk ask #3: label "Stop"; record matched; stopped')
})

test('a stop typed under Other ends the walk too, in any case', async () => {
  fresh()
  const { env, values } = walkEnv([made(1)], [{ gives: ' STOP ' }])
  expect(await walk(env, WINDOW)).toContain('It ended on Stop.')
  expect(values.list.items[0]?.state).toBe('open')
})

test('a reply typed under Other is written as the reply form, trimmed; text that is one answer\'s label ignoring case writes that answer', async () => {
  fresh()
  const reply = walkEnv([made(1)], [{ gives: '  use sqlite, please  ' }])
  await walk(reply.env, WINDOW)
  expect(reply.values.list.items[0]).toMatchObject({ state: 'done-waiting', answer: 'use sqlite, please', replied: true })
  fresh()
  const label = walkEnv([made(1, { yesno: true })], [{ gives: 'YES' }])
  await walk(label.env, WINDOW)
  expect(label.values.list.items[0]).toMatchObject({ state: 'done-waiting', answer: 'yes', replied: false })
})

test('an item changed while its question was up takes no answer: nothing is written and the next question opens with the changed line', async () => {
  const changes: [string, Item, Step['during']][] = [
    ['a new title', made(1), edit => edit(1, it => ({ ...it, title: 'Something else' }))],
    ['a changed done label', made(1), edit => edit(1, it => ({ ...it, doneLabel: 'Ship it' }))],
    ['relabelled options', pick(1), edit => edit(1, it => ({ ...it, options: [SQLITE, { ...POSTGRES, label: 'Use mysql' }] }))],
    ['reordered options', pick(1), edit => edit(1, it => ({ ...it, options: [{ ...SQLITE, recommended: true }, { ...POSTGRES, recommended: false }] }))],
    ['an answer sent elsewhere', made(1), edit => edit(1, it => ({ ...it, state: 'done-pending', answer: 'done' }))],
    ['an agent append after an answer', made(1), edit => edit(1, it => ({ ...it, thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'Which version?' }] }))],
  ]
  for (const [name, item, during] of changes) {
    fresh()
    const label = item.options.length > 0 ? 'Use sqlite' : 'Done'
    const { env, values, asked, debug } = walkEnv([item, made(2)], [{ gives: label, during }, { gives: 'Stop' }])
    const text = await walk(env, WINDOW)
    expect([name, asked.map(a => a.header)]).toEqual([name, ['#1', '#2']])
    expect([name, lines(asked[1]?.question ?? '')[0]]).toEqual([name, '#1 changed while it was shown, so nothing was sent; /todo answer asks it again.'])
    expect([name, values.list.items.some(it => it.state === 'done-waiting')]).toEqual([name, false])
    expect([name, text.includes('The walk sent nothing;')]).toEqual([name, true])
    expect(debug).toContain(`human-plugin: walk ask #1: label "${label}"; record matched; refused as changed`)
  }
})

test('an item the agent removed while its question was up is reported as gone, and the next question opens with that line', async () => {
  fresh()
  const { env, debug, asked } = walkEnv([made(1), made(2)], [{ gives: 'Done', during: (_edit, values) => without(values, 1) }, { gives: 'Stop' }])
  await walk(env, WINDOW)
  expect(debug).toContain('human-plugin: walk ask #1: label "Done"; record matched; left the list')
  expect(lines(asked[1]?.question ?? '')[0]).toBe('#1 left the list while it was shown, so nothing was sent.')
})

test('a note edit, a brief edit and an agent append to an item never answered leave the answer written', async () => {
  fresh()
  const { env, values } = walkEnv(
    [made(1)],
    [{ gives: 'Done', during: edit => edit(1, it => ({ ...it, note: 'A new note', detail: `${it.detail}\n\nAppended by the agent`, unread: true })) }],
  )
  const text = await walk(env, WINDOW)
  expect(itemOf(values, 1)).toMatchObject({ state: 'done-waiting', note: 'A new note', unread: false })
  expect(text).toBe(
    ['  answered #1 with done', '  It asked about every open item.', '  The walk sent 1 answer; nothing is left open.'].join('\n'),
  )
})

test('a rejected dialog (closed, expired or refused) ends the walk: nothing is written for its item, the earlier answers stay, its message is logged, and the end text names the item', async () => {
  fresh()
  const { env, values, debug, asked } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: { rejects: 'The user dismissed the question' } }])
  const text = await walk(env, WINDOW)
  expect(asked).toHaveLength(2)
  expect(values.list.items.map(it => it.state)).toEqual(['done-waiting', 'open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question on #2 was closed, timed out or refused; nothing was sent for it. /todo 2 shows it, and /todo 2 <form> answers it.',
      '  The walk sent 1 answer; 2 items are still open. /todo answer asks about them again.',
    ].join('\n'),
  )
  expect(debug).toContain('human-plugin: walk ask #2: rejected: The user dismissed the question; record matched; closed')
})

test('a rejected dialog ends the walk: the answer before it is written and its notice released at the walk\'s end, the item is left open and unchanged but read, and no item after it is asked', async () => {
  fresh()
  const { env, values, clock, timers, submitted, asked } = walkEnv(
    [made(1), made(2, { unread: true }), made(3)],
    [{ gives: 'Done' }, { gives: { rejects: 'The user dismissed the question' } }],
  )
  clock.now = 1000
  await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1', '#2'])
  expect(values.list.items.map(it => it.state)).toEqual(['done-waiting', 'open', 'open'])
  // Nothing is written for the closed item: it is as it was, its unread mark aside, which showing its question cleared.
  expect(itemOf(values, 2)).toEqual(made(2))
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([{ text: doneNotice(itemOf(values, 1)) }])
  expect(pending()).toEqual({ held: [], waiting: [] })
})

test('a walk whose first dialog is rejected, whatever the message says, asks nothing more, writes nothing, owes no notice, and ends naming the item, the other items still open and unread', async () => {
  for (const message of ['The user dismissed the question', 'no answer (No response after 20s — the user may be away from keyboard.)', 'the dialog was closed or refused']) {
    fresh()
    const { env, values, clock, timers, submitted, debug, asked } = walkEnv(
      [made(1, { unread: true }), made(2, { unread: true }), made(3, { blocking: true, unread: true })],
      [{ gives: { rejects: message } }],
    )
    clock.now = 1000
    const text = await walk(env, WINDOW)
    expect([message, asked.map(a => a.header)]).toEqual([message, ['#3']])
    expect([message, text]).toEqual([
      message,
      [
        '  It ended when the question on #3 was closed, timed out or refused; nothing was sent for it. /todo 3 shows it, and /todo 3 <form> answers it.',
        '  The walk sent nothing; 3 items are still open. /todo answer asks about them again.',
      ].join('\n'),
    ])
    // The rejection's message is for the debug line alone.
    expect(text).not.toContain(message)
    expect([message, values.list.items.map(it => [it.state, it.unread])]).toEqual([message, [['open', true], ['open', true], ['open', false]]])
    expect(debug.filter(line => line.startsWith('human-plugin: walk ask '))).toEqual([`human-plugin: walk ask #3: rejected: ${message}; record matched; closed`])
    // Nothing was written, so no tick runs: the one timer is the walk's release, which finds nothing owed.
    expect(timers.map(timer => [timer.once, timer.ms])).toEqual([[true, 1000]])
    await tickAt(timers, clock, 1000)
    expect(submitted).toEqual([])
    expect(pending()).toEqual({ held: [], waiting: [] })
    expect(timers).toEqual([])
    expect(offer({ id: 9, text: 'after' })).toBe('submit')
  }
})

test('a skipped item, then a dialog that resolves with afkTimeoutMs: the walk ends with the auto-continue text, asks no item after it, and counts the skipped item as still open', async () => {
  fresh()
  const { env, values, asked } = walkEnv(
    [made(1), made(2), made(3), made(4)],
    [{ gives: 'Done' }, { gives: 'Skip' }, { gives: 'Done', seen: 'auto' }],
  )
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1', '#2', '#3'])
  expect(lines(asked[2]?.question ?? '')[0]).toBe('skipped #2')
  expect(values.list.items.map(it => it.state)).toEqual(['done-waiting', 'open', 'open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question auto-continued while you were away; nothing was sent for #3.',
      '  The walk sent 1 answer; 3 items are still open. /todo answer asks about them again.',
    ].join('\n'),
  )
})

test('a walk after a walk that ended on a rejected dialog asks that item again, in its place in the band\'s order', async () => {
  fresh()
  const { env, asked, steps } = walkEnv(
    [made(1), made(2, { blocking: true }), made(3)],
    [{ gives: { rejects: 'The user dismissed the question' } }],
  )
  await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#2'])
  steps.push({ gives: 'Skip' }, { gives: 'Skip' }, { gives: 'Skip' })
  await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#2', '#2', '#1', '#3'])
})

test('a result that carries afkTimeoutMs writes nothing and ends with the auto-continue text; its record line says present', async () => {
  fresh()
  const { env, values, debug } = walkEnv([made(1), made(2)], [{ gives: 'Done', seen: 'auto' }])
  const text = await walk(env, WINDOW)
  expect(values.list.items.map(it => it.state)).toEqual(['open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question auto-continued while you were away; nothing was sent for #1.',
      '  The walk sent nothing; 2 items are still open. /todo answer asks about them again.',
    ].join('\n'),
  )
  expect(debug).toEqual(['human-plugin: walk record for #1: afkTimeoutMs present', 'human-plugin: walk ask #1: label "Done"; record matched; not written'])
})

test('a rejected dialog whose record carries afkTimeoutMs writes nothing and ends the walk as closed like any rejection, not as auto-continued; its message is logged, and no item after it is asked', async () => {
  fresh()
  const message = 'no answer (No response after 20s — the user may be away from keyboard.)'
  const asking = (question: string): unknown => ({ questions: [{ question }] })
  const { env, values, debug, asked } = walkEnv(
    [made(1), made(2)],
    [{ gives: { rejects: message }, observed: { call: asking, result: { result: { afkTimeoutMs: 20000 } } } }],
  )
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#1'])
  expect(values.list.items.map(it => it.state)).toEqual(['open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question on #1 was closed, timed out or refused; nothing was sent for it. /todo 1 shows it, and /todo 1 <form> answers it.',
      '  The walk sent nothing; 2 items are still open. /todo answer asks about them again.',
    ].join('\n'),
  )
  expect(walkLines(debug)).toEqual(['human-plugin: walk record for #1: afkTimeoutMs present', `human-plugin: walk ask #1: rejected: ${message}; record matched; closed`])
})

// The walk reads a rejected dialog before it reads the record of the call, so the record decides nothing about a rejection: the observer saw none, or one for another question.
for (const [seen, state, what] of [
  ['none', 'missing', 'the observer made no record of it'],
  ['other', 'other question', "the observer's record is of another question"],
] as const) {
  test(`a rejected dialog ends the walk as closed when ${what}, not as one that cannot be confirmed: the ask line ends record ${state}; closed`, async () => {
    fresh()
    const message = 'The user dismissed the question'
    const { env, values, debug, asked } = walkEnv([made(1), made(2)], [{ gives: { rejects: message }, seen }])
    const text = await walk(env, WINDOW)
    expect(asked.map(a => a.header)).toEqual(['#1'])
    expect(values.list.items.map(it => it.state)).toEqual(['open', 'open'])
    expect(text).toBe(
      [
        '  It ended when the question on #1 was closed, timed out or refused; nothing was sent for it. /todo 1 shows it, and /todo 1 <form> answers it.',
        '  The walk sent nothing; 2 items are still open. /todo answer asks about them again.',
      ].join('\n'),
    )
    expect(debug).toContain(`human-plugin: walk ask #1: rejected: ${message}; record ${state}; closed`)
  })
}

test('an answer the observer saw no result for, or only a result for another question, writes nothing, ends as one that cannot be confirmed, and logs a line', async () => {
  for (const [seen, state] of [['none', 'missing'], ['other', 'other question']] as const) {
    fresh()
    const { env, values, debug } = walkEnv([made(1), made(2)], [{ gives: 'Done', seen }])
    const text = await walk(env, WINDOW)
    expect([seen, values.list.items.map(it => it.state)]).toEqual([seen, ['open', 'open']])
    expect(text).toBe(
      [
        '  It ended because the answer to #1 could not be confirmed as yours; nothing was sent, and this was logged.',
        '  The walk sent nothing; 2 items are still open. /todo answer asks about them again.',
      ].join('\n'),
    )
    expect(debug).toContain(`human-plugin: walk ask #1: label "Done"; record ${state}; not written`)
  }
})

test('the observer records nothing while no walk is asking', () => {
  fresh()
  const { env, debug } = walkEnv([], [])
  observeAsked(env, { questions: [{ question: 'Which?' }] }, { result: { answers: {} } })
  expect(debug).toEqual([])
})

test('the observer makes no record of a call it cannot read: the walk then cannot confirm the answer', async () => {
  const unreadable = [undefined, null, 'Which?', 7, {}, { questions: 'Which?' }, { questions: [] }, { questions: [null] }, { questions: [{ question: 7 }] }]
  for (const call of unreadable) {
    fresh()
    const { env, values, debug } = walkEnv([made(1)], [{ gives: 'Done', observed: { call: () => call, result: { result: { answers: {} } } } }])
    expect(await walk(env, WINDOW)).toContain('could not be confirmed as yours')
    expect(values.list.items[0]?.state).toBe('open')
    expect(debug.filter(line => line.includes('walk record'))).toEqual([])
  }
})

test('the observer reads afkTimeoutMs from an object result only: it is present when the result carries a value for it, absent otherwise', async () => {
  const asking = (question: string): unknown => ({ questions: [{ question }] })
  const absent = [undefined, null, 'Error: dismissed', { result: 'Error: dismissed' }, { result: { answers: {} } }, { result: { afkTimeoutMs: undefined } }]
  const present = [{ result: { afkTimeoutMs: 20000 } }, { result: { afkTimeoutMs: 0 } }, { result: { afkTimeoutMs: null } }]
  for (const result of absent) {
    fresh()
    const { env, values, debug } = walkEnv([made(1)], [{ gives: 'Done', observed: { call: asking, result } }])
    await walk(env, WINDOW)
    expect([result, values.list.items[0]?.state]).toEqual([result, 'done-waiting'])
    expect(debug).toContain('human-plugin: walk record for #1: afkTimeoutMs absent')
  }
  for (const result of present) {
    fresh()
    const { env, values, debug } = walkEnv([made(1)], [{ gives: 'Done', observed: { call: asking, result } }])
    expect(await walk(env, WINDOW)).toContain('It ended when the question auto-continued while you were away')
    expect([result, values.list.items[0]?.state]).toEqual([result, 'open'])
    expect(debug).toContain('human-plugin: walk record for #1: afkTimeoutMs present')
  }
})

test('a throw after an answer was written ends with the error reason, counts the written answer, and logs the error', async () => {
  fresh()
  const { env, values, shown, breakGet } = walkEnv([made(1), made(2)], [{ gives: 'Done' }])
  breakGet.when = list => list.items.some(it => it.state === 'done-waiting')
  const text = await walk(env, WINDOW)
  expect(text).toBe(
    [
      '  answered #1 with done',
      '  It stopped on an error, which was logged.',
      '  The walk sent 1 answer; 1 item is still open. /todo answer asks about it again.',
    ].join('\n'),
  )
  expect(itemOf(values, 1).state).toBe('done-waiting')
  expect(shown.filter(line => line.startsWith('human-plugin: the walk stopped on an error: '))).toHaveLength(1)
  expect(shown.join('\n')).toContain('list unreadable')
})

test('a throw from the read of the list for the end text, after an answer was written, ends with the error reason and the sent count, logs the error, and leaves the answer written', async () => {
  fresh()
  const { env, values, shown, breakGet } = walkEnv([made(1)], [{ gives: 'Done' }])
  // Two reads of the list follow the answer: the loop's, which finds nothing left to ask about, and the end text's, which throws.
  let reads = 0
  breakGet.when = list => list.items.some(it => it.state === 'done-waiting') && ++reads === 2
  const text = await walk(env, WINDOW)
  expect(text).toBe(
    [
      '  answered #1 with done',
      '  It stopped on an error, which was logged.',
      '  The walk sent 1 answer; /todo shows what is still open.',
    ].join('\n'),
  )
  expect(itemOf(values, 1).state).toBe('done-waiting')
  expect(shown.filter(line => line.startsWith('human-plugin: the walk stopped on an error: '))).toHaveLength(1)
  expect(shown.join('\n')).toContain('list unreadable')
})

test('a throw from the read of the list for the end text, after the last item was skipped or its question closed, ends with the error reason: the skipped line, if any, and the sent count stand, and /todo shows what is still open', async () => {
  const errored = ['  It stopped on an error, which was logged.', '  The walk sent nothing; /todo shows what is still open.']
  // After a Skip two reads of the list follow the dialog: the loop's, which finds nothing left to ask about, and the end text's, which throws. A rejection ends the walk at
  // once, so the end text's read is the only one.
  for (const [how, gives, reads, expected] of [
    ['a Skip', 'Skip', 2, ['  skipped #1', ...errored]],
    ['a rejected dialog', { rejects: 'The user dismissed the question' }, 1, errored],
  ] as const) {
    fresh()
    let armed = false
    let count = 0
    const { env, values, shown, breakGet } = walkEnv([made(1)], [{ gives, during: () => void (armed = true) }])
    breakGet.when = () => armed && ++count === reads
    const text = await walk(env, WINDOW)
    expect([how, text]).toEqual([how, expected.join('\n')])
    expect([how, itemOf(values, 1).state]).toEqual([how, 'open'])
    expect(shown.filter(line => line.startsWith('human-plugin: the walk stopped on an error: '))).toHaveLength(1)
  }
})

test('a walk whose session ended writes and asks nothing more, whatever its open dialog returns, and says so', async () => {
  for (const gives of ['Done', { rejects: 'The user dismissed the question' }, 'Stop'] as const) {
    fresh()
    let release = (): void => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const { env, values, asked, debug } = walkEnv([made(1), made(2)], [{ gives, wait: gate }])
    const running = walk(env, WINDOW)
    await settle()
    endWalk()
    // The new session's list: an item filed after the /clear takes the number the old walk's item had.
    values.list = { items: [made(1, { title: 'Filed after the clear' })], next: 2, term: null }
    release()
    const text = await running
    expect(asked).toHaveLength(1)
    expect(values.list.items).toEqual([made(1, { title: 'Filed after the clear' })])
    expect(lines(text)[0]).toBe('  It ended with its session; nothing more was asked or sent.')
    expect(walkLines(debug).pop()?.endsWith('; session ended')).toBe(true)
  }
})

test('a session that ends after the dialog returns and before the list update runs writes nothing, leaves the list as it was, and ends the walk with its session\'s reason line', async () => {
  fresh()
  const items = [made(1), made(2)]
  let armed = false
  const { env, values, timers, submitted, debug, breakGet } = walkEnv(items, [{ gives: 'Done', during: () => void (armed = true) }])
  // The first read of the list once the dialog has returned is the guarded write's own update, which the walk reaches after its last check of its session.
  breakGet.when = () => {
    if (!armed) return false
    armed = false
    endWalk()
    return false
  }
  const text = await walk(env, WINDOW)
  expect(values.list).toEqual({ items, next: 3, term: null })
  expect(timers).toEqual([])
  expect(submitted).toEqual([])
  expect(text).toBe(
    [
      '  It ended with its session; nothing more was asked or sent.',
      '  The walk sent nothing; 2 items are still open. /todo answer asks about them again.',
    ].join('\n'),
  )
  expect(debug).toContain('human-plugin: walk ask #1: label "Done"; record matched; session ended')
})

test('a write the guard refuses because the session ended starts no ticker: an earlier answer left in its undo window is not ended afterwards, and no notice is sent', async () => {
  fresh()
  let armed = false
  const { env, values, clock, timers, submitted, debug, breakGet } = walkEnv(
    [made(1), made(2)],
    [{ gives: 'Done' }, { gives: 'Done', during: () => void (armed = true) }],
  )
  clock.now = 1000
  // The session ends as its end hook ends it, stopping the ticker and releasing the walk's flag, at the first read of the list once the second dialog has returned,
  // which is the guarded write's own update. The first answer is by then in its undo window, and the first tick would end it.
  breakGet.when = () => {
    if (!armed) return false
    armed = false
    stopTicker()
    endWalk()
    return false
  }
  const text = await walk(env, WINDOW)
  expect(text).toBe(
    [
      '  It ended with its session; nothing more was asked or sent.',
      '  The walk sent 1 answer; 1 item is still open. /todo answer asks about it again.',
    ].join('\n'),
  )
  expect(debug).toContain('human-plugin: walk ask #2: label "Done"; record matched; session ended')
  expect(timers).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(values.list.items.map(it => it.state)).toEqual(['done-waiting', 'open'])
  expect(submitted).toEqual([])
})

test('a walk started after a session ended keeps its flag when the old walk settles, so a third walk is told one is asking', async () => {
  fresh()
  let releaseOld = (): void => {}
  let releaseNew = (): void => {}
  const gateOld = new Promise<void>(resolve => (releaseOld = resolve))
  const gateNew = new Promise<void>(resolve => (releaseNew = resolve))
  const { env, asked } = walkEnv([made(1)], [{ gives: 'Skip', wait: gateOld }, { gives: 'Skip', wait: gateNew }])
  const old = walk(env, WINDOW)
  await settle()
  endWalk()
  const newer = walk(env, WINDOW)
  await settle()
  expect(asked).toHaveLength(2)
  releaseOld()
  expect(await old).toContain('It ended with its session')
  expect(await walk(env, WINDOW)).toBe(ALREADY_ASKING)
  expect(asked).toHaveLength(2)
  releaseNew()
  expect(await newer).toContain('It asked about every open item.')
})

test('a session that ends between two questions ends the walk before it asks again, and the outcome of the last answer is in its text', async () => {
  fresh()
  let armed = false
  const { env, asked, breakGet } = walkEnv([made(1), made(2)], [{ gives: 'Skip', during: () => void (armed = true) }, { gives: 'Skip' }])
  // The read of the list that comes before the second question finds the session over.
  breakGet.when = () => {
    if (!armed) return false
    armed = false
    endWalk()
    return false
  }
  const text = await walk(env, WINDOW)
  expect(asked).toHaveLength(1)
  expect(lines(text).slice(0, 2)).toEqual(['  skipped #1', '  It ended with its session; nothing more was asked or sent.'])
})

test('the debug lines word every return and every outcome, and none holds a reply\'s text', async () => {
  fresh()
  const secret = 'a reply that must not be logged'
  const { env, debug } = walkEnv([made(1), pick(2), made(3), made(4)], [{ gives: 'Done' }, { gives: 'Use postgres' }, { gives: secret }, { gives: '' }])
  await walk(env, WINDOW)
  expect(walkLines(debug)).toEqual([
    'human-plugin: walk record for #1: afkTimeoutMs absent',
    'human-plugin: walk ask #1: label "Done"; record matched; written',
    'human-plugin: walk record for #2: afkTimeoutMs absent',
    'human-plugin: walk ask #2: label "Use postgres"; record matched; written',
    'human-plugin: walk record for #3: afkTimeoutMs absent',
    `human-plugin: walk ask #3: text of ${secret.length} characters; record matched; written`,
    'human-plugin: walk record for #4: afkTimeoutMs absent',
    'human-plugin: walk ask #4: blank; record matched; skipped',
  ])
  expect(debug.join('\n')).not.toContain(secret)
})

// While a walk asks, no submit is tried (turns.ts): the engine refuses one made while the walk's command hook is in flight. The walk switches that on in the step it
// claims its session. Its end arms a one-shot timer, the release, and the hold lasts until that timer has run: the submit is made once the walk's hook has settled.
test('a tick that ends an answer\'s window while the walk is still asking submits nothing: the notice waits, its debug line says so, and the walk\'s end submits nothing either: its release does, when its timer fires', async () => {
  fresh()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, values, clock, timers, submitted, debug, asked } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: 'Stop', wait: gate }])
  clock.now = 1000
  const running = walk(env, WINDOW)
  await until(() => asked.length === 2)
  await tickAt(timers, clock, 1000)
  expect(itemOf(values, 1).state).toBe('done-pending')
  expect(submitted).toEqual([])
  expect(pending()).toEqual({ held: [], waiting: [{ id: 1, text: doneNotice(itemOf(values, 1)) }] })
  expect(debug.filter(line => line.startsWith('human-plugin: sent #1 '))).toEqual([`human-plugin: sent #1 for press ${1000 - WINDOW} kept for the walk's release or the next turn`])
  // The session is idle: a second notice is kept too, not queued for a turn that is not running.
  expect(offer({ id: 2, text: 'while asking' })).toBe('walk')
  release()
  await running
  // The walk has returned and its release waits for its timer: the hold is still on, and nothing is submitted.
  expect(submitted).toEqual([])
  expect(offer({ id: 3, text: 'after the walk' })).toBe('walk')
  expect(oneShots(timers)).toEqual([1000])
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([{ text: [doneNotice(itemOf(values, 1)), 'while asking', 'after the walk'].join('\n\n') }])
  expect(pending()).toEqual({ held: [], waiting: [] })
  // The prompt is starting a turn: a notice offered after the release goes to that turn.
  expect(offer({ id: 3, text: 'later' })).toBe('queued')
})

test('with a turn running when the walk starts, a tick that ends an answer\'s window sends the notice to that turn\'s read point, as it does without a walk', async () => {
  fresh()
  startTurn()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, values, clock, timers, submitted, debug, asked } = walkEnv([made(1), made(2)], [{ gives: 'Done' }, { gives: 'Stop', wait: gate }])
  clock.now = 1000
  const running = walk(env, WINDOW)
  await until(() => asked.length === 2)
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(debug.filter(line => line.startsWith('human-plugin: sent #1 '))).toEqual([`human-plugin: sent #1 for press ${1000 - WINDOW} to the running turn`])
  const appended: string[] = []
  await handOver(
    async text => {
      appended.push(text)
      return true
    },
    async () => () => true,
  )
  expect(appended).toEqual([doneNotice(itemOf(values, 1))])
  release()
  await running
})

test('every way a walk ends arms the release: a notice offered while it asked or after it ended waits, and once the release has run the next one takes the idle path', async () => {
  const ends: [string, Item[], Step[], boolean][] = [
    ['Stop', [made(1)], [{ gives: 'Stop' }], false],
    ['every open item asked', [made(1)], [{ gives: 'Skip' }], false],
    ['an answer written', [made(1)], [{ gives: 'Done' }], false],
    ['a closed dialog', [made(1)], [{ gives: { rejects: 'The user dismissed the question' } }], false],
    ['an answer that cannot be confirmed', [made(1)], [{ gives: 'Done', seen: 'none' }], false],
    ['an auto-continued question', [made(1)], [{ gives: 'Done', seen: 'auto' }], false],
    ['nothing open', [], [], false],
    ['an error', [made(1)], [], true],
  ]
  for (const [name, items, steps, throws] of ends) {
    fresh()
    const { env, breakGet, clock, timers, submitted } = walkEnv(items, steps)
    // The walk's first read of the list comes after it has claimed its session, so a notice offered there is offered while it asks.
    const probed: string[] = []
    breakGet.when = () => {
      if (probed.length === 0) probed.push(offer({ id: 8, text: 'while asking' }))
      return throws
    }
    await walk(env, WINDOW)
    // The release waits for its one-second timer, and the hold is on until it has run. None of these notices is for an item on the list, so the release delivers none.
    const armed = oneShots(timers)
    const kept = offer({ id: 9, text: 'after the walk' })
    await tickAt(timers, clock, 0, 'one-shots')
    expect([name, probed, armed, kept, submitted, offer({ id: 10, text: 'after the release' })]).toEqual([name, ['walk'], [1000], 'walk', [], 'submit'])
  }
})

test('a walk told that one is already asking arms nothing and leaves the first walk\'s hold on: the first walk\'s end arms the release that ends it', async () => {
  fresh()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, asked, clock, timers } = walkEnv([made(1)], [{ gives: 'Skip', wait: gate }])
  const first = walk(env, WINDOW)
  await until(() => asked.length === 1)
  expect(await walk(env, WINDOW)).toBe(ALREADY_ASKING)
  expect(oneShots(timers)).toEqual([])
  expect(offer({ id: 8, text: 'while asking' })).toBe('walk')
  release()
  await first
  expect(oneShots(timers)).toEqual([1000])
  expect(offer({ id: 9, text: 'after' })).toBe('walk')
  await tickAt(timers, clock, 0, 'one-shots')
  expect(offer({ id: 10, text: 'after the release' })).toBe('submit')
})

test('a walk that settles after its session ended arms no release and leaves the hold of a newer walk on; the newer walk\'s end arms its release, which ends it', async () => {
  fresh()
  let releaseOld = (): void => {}
  let releaseNew = (): void => {}
  const gateOld = new Promise<void>(resolve => (releaseOld = resolve))
  const gateNew = new Promise<void>(resolve => (releaseNew = resolve))
  const { env, asked, clock, timers } = walkEnv([made(1)], [{ gives: 'Skip', wait: gateOld }, { gives: 'Skip', wait: gateNew }])
  const old = walk(env, WINDOW)
  await until(() => asked.length === 1)
  // The session's end, as its end hook makes it.
  reset()
  endWalk()
  const newer = walk(env, WINDOW)
  await until(() => asked.length === 2)
  releaseOld()
  expect(await old).toContain('It ended with its session')
  expect(oneShots(timers)).toEqual([])
  expect(offer({ id: 8, text: 'while the newer walk asks' })).toBe('walk')
  releaseNew()
  await newer
  expect(oneShots(timers)).toEqual([1000])
  expect(offer({ id: 9, text: 'after' })).toBe('walk')
  await tickAt(timers, clock, 0, 'one-shots')
  expect(offer({ id: 10, text: 'after the release' })).toBe('submit')
})

test('a walk that settles after its session ended clears neither the hold nor the release of a newer walk that has already ended', async () => {
  fresh()
  let releaseOld = (): void => {}
  const gateOld = new Promise<void>(resolve => (releaseOld = resolve))
  const { env, asked, clock, timers } = walkEnv([made(1)], [{ gives: 'Skip', wait: gateOld }, { gives: 'Skip' }])
  const old = walk(env, WINDOW)
  await until(() => asked.length === 1)
  reset()
  endWalk()
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  releaseOld()
  expect(await old).toContain('It ended with its session')
  expect(oneShots(timers)).toEqual([1000])
  expect(offer({ id: 8, text: 'after' })).toBe('walk')
  await tickAt(timers, clock, 0, 'one-shots')
  expect(offer({ id: 9, text: 'after the release' })).toBe('submit')
})

// The release: one second after a walk's end, once its hook has settled, a one-shot timer submits what the walk left owed as one prompt.
test('a walk that wrote answers arms one one-shot timer of one second at its end and submits nothing before it fires; it then submits one prompt carrying the notice of each written answer whose item is still on the list, each once', async () => {
  fresh()
  const { env, values, clock, timers, submitted, debug } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: 'Done' }, { gives: 'Done' }])
  clock.now = 1000
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  expect(submitted).toEqual([])
  // The tick ends the answers' windows while the hold is on, so their notices wait; the agent removes #2 before the release.
  await tickAt(timers, clock, 1000, 'ticks')
  await until(() => pending().waiting.length === 3)
  expect(submitted).toEqual([])
  // No walk is asking by then, and the debug line of each notice still says it is kept for the release.
  expect(debug.filter(line => line.startsWith('human-plugin: sent #')).map(line => line.replace(/ for press -?\d+/, ''))).toEqual(
    [1, 2, 3].map(id => `human-plugin: sent #${id} kept for the walk's release or the next turn`),
  )
  without(values, 2)
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: [1, 3].map(id => doneNotice(itemOf(values, id))).join('\n\n') }])
  expect(pending()).toEqual({ held: [], waiting: [] })
  expect(debug.filter(line => line.startsWith('human-plugin: released '))).toEqual(["human-plugin: released at the walk's end: notices for #1, #3"])
  expect(debug.filter(line => line.includes('via submit'))).toEqual([])
  // The release's prompt starts a turn: a notice offered after it goes to that turn.
  expect(offer({ id: 1, text: 'later' })).toBe('queued')
})

test('a walk that wrote an answer before a rejected question submits once at its end, the same wait: one prompt carrying the notice of the written answer, and none for the closed item or one after it', async () => {
  fresh()
  const { env, values, clock, timers, submitted } = walkEnv(
    [made(1), made(2), made(3)],
    [{ gives: 'Done' }, { gives: { rejects: 'The user dismissed the question' } }, { gives: 'Done' }],
  )
  clock.now = 1000
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  await tickAt(timers, clock, 1000, 'ticks')
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: doneNotice(itemOf(values, 1)) }])
})

test('a walk with nothing owed at its end submits nothing when its release fires, logs no release line, and ends the hold', async () => {
  fresh()
  const { env, clock, timers, submitted, debug } = walkEnv([made(1), made(2)], [{ gives: 'Skip' }, { gives: 'Stop' }])
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(debug.filter(line => line.startsWith('human-plugin: released '))).toEqual([])
  expect(offer({ id: 9, text: 'after' })).toBe('submit')
})

test('a walk that wrote nothing, started while a turn ran whose end came during it, submits once a second after its end: the pointer to the notices that turn appended, then the notices it left waiting', async () => {
  fresh()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(async () => true, async () => () => true)
  offer({ id: 2, text: '#2 is done: b' })
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, clock, timers, submitted, debug, asked } = walkEnv([made(1), made(2)], [{ gives: 'Stop', wait: gate }])
  const running = walk(env, WINDOW)
  await until(() => asked.length === 1)
  expect(endTurn('t1', false, () => true)).toBe(null)
  release()
  await running
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([{ text: `${pointerText([1])}\n\n#2 is done: b` }])
  expect(pending()).toEqual({ held: [], waiting: [] })
  expect(debug.filter(line => line.startsWith('human-plugin: released '))).toEqual(["human-plugin: released at the walk's end: a pointer to #1, then notices for #2"])
})

test('a walk whose one-shot timer cannot be armed returns the end text it would have returned, logs the failure as one row and ends the hold: a notice offered after it takes the idle path, and the next turn appends the walk\'s owed notices once each', async () => {
  fresh()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, values, clock, timers, submitted, shown, asked, refuse } = walkEnv(
    [made(1), made(2), made(3)],
    [{ gives: 'Done' }, { gives: 'Done' }, { gives: 'Stop', wait: gate }],
  )
  refuse.arm = new Error('the clock refuses it')
  clock.now = 1000
  const running = walk(env, WINDOW)
  await until(() => asked.length === 3)
  await tickAt(timers, clock, 1000)
  await until(() => pending().waiting.length === 2)
  release()
  expect(await running).toBe(['  It ended on Stop.', '  The walk sent 2 answers; 1 item is still open. /todo answer asks about it again.'].join('\n'))
  expect(shown).toHaveLength(1)
  expect(shown[0]).toContain("human-plugin: the notices the walk left could not be released at its end, so they wait for the next turn: Error: the clock refuses it")
  expect(oneShots(timers)).toEqual([])
  expect(submitted).toEqual([])
  expect(pending().waiting.map(notice => notice.id)).toEqual([1, 2])
  // The hold is off: a notice offered after the walk takes the idle path.
  expect(offer({ id: 3, text: 'after the walk' })).toBe('submit')
  // The next turn to start appends the walk's owed notices once each.
  startTurn()
  const appended: string[] = []
  await handOver(appendTo(appended), async () => () => true)
  await handOver(appendTo(appended), async () => () => true)
  expect(appended).toEqual([1, 2].map(id => doneNotice(itemOf(values, id))))
})

test('a walk whose release cannot be armed takes an earlier walk\'s pending release away and does not restore it: that walk\'s notices wait for the next turn, with the hold off', async () => {
  fresh()
  const { env, clock, timers, submitted, steps, refuse } = walkEnv([made(1), made(2)], [{ gives: 'Done' }, { gives: 'Stop' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  expect(oneShots(timers)).toEqual([1000])
  expect(pending().waiting.map(notice => notice.id)).toEqual([1])
  refuse.arm = new Error('the clock refuses it')
  steps.push({ gives: 'Stop' })
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([])
  expect(offer({ id: 2, text: 'after' })).toBe('submit')
  expect(submitted).toEqual([])
  expect(pending().waiting.map(notice => notice.id)).toEqual([1])
})

type Prompt = { origin: { kind: string }; context?: readonly string[] }
test('a release the engine refuses or that fails holds its notices for the human\'s next prompt, which carries each once, and the failure is logged as one row', async () => {
  for (const [how, refusal, row] of [
    ['a refusal', { drop: 'a hook refused it' }, 'human-plugin: a notice was not entered: a hook refused it'],
    ['a throw', { throws: new Error('the submit failed') }, 'human-plugin: Error: the submit failed'],
  ] as const) {
    fresh()
    const { env, values, clock, timers, submitted, shown, refuse } = walkEnv([made(1), made(2)], [{ gives: 'Done' }, { gives: 'Done' }])
    refuse.submit = refusal
    clock.now = 1000
    await walk(env, WINDOW)
    await tickAt(timers, clock, 1000, 'ticks')
    await tickAt(timers, clock, 1000, 'one-shots')
    const notices = [1, 2].map(id => ({ id, text: doneNotice(itemOf(values, id)) }))
    expect([how, submitted]).toEqual([how, [{ text: notices.map(notice => notice.text).join('\n\n') }]])
    expect([how, shown]).toEqual([how, [row]])
    expect([how, pending()]).toEqual([how, { held: notices, waiting: [] }])
    // The session is idle again, and the human's next prompt carries each notice once.
    const seen: (readonly string[] | undefined)[] = []
    const next = async (e: Prompt): Promise<{ drop?: unknown }> => {
      seen.push(e.context)
      return {}
    }
    await carryHeld<Prompt, { drop?: unknown }>({ origin: { kind: 'composer' } }, next, () => true)
    await carryHeld<Prompt, { drop?: unknown }>({ origin: { kind: 'composer' } }, next, () => true)
    expect([how, seen]).toEqual([how, [[notices.map(notice => notice.text).join('\n\n')], undefined]])
    expect([how, offer({ id: 9, text: 'after' })]).toEqual([how, 'submit'])
  }
})

test('a release whose list read fails ends the hold and delivers the owed notices unchecked, logging the failure; with nothing owed it delivers nothing, and a notice offered after it takes the idle path', async () => {
  fresh()
  const owed = walkEnv([made(1), made(2)], [{ gives: 'Done' }, { gives: 'Done' }])
  owed.clock.now = 1000
  await walk(owed.env, WINDOW)
  await tickAt(owed.timers, owed.clock, 1000, 'ticks')
  const texts = [1, 2].map(id => doneNotice(itemOf(owed.values, id)))
  // The agent removes #2, and the list cannot be read for the release: nothing checks the notice of #2, which is delivered with the other.
  without(owed.values, 2)
  owed.breakGet.when = () => true
  await tickAt(owed.timers, owed.clock, 1000, 'one-shots')
  expect(owed.submitted).toEqual([{ text: texts.join('\n\n') }])
  expect(owed.shown).toHaveLength(1)
  expect(owed.shown[0]).toContain("human-plugin: the list could not be read before the walk's notices were released, so they are released unchecked: Error: list unreadable")
  // The prompt starts a turn: a notice offered after the release goes to it.
  expect(offer({ id: 9, text: 'after' })).toBe('queued')

  fresh()
  const none = walkEnv([made(1)], [{ gives: 'Skip' }])
  await walk(none.env, WINDOW)
  none.breakGet.when = () => true
  await tickAt(none.timers, none.clock, 1000)
  expect(none.submitted).toEqual([])
  expect(none.shown).toHaveLength(1)
  expect(offer({ id: 9, text: 'after' })).toBe('submit')
})

test('a release that finds a turn running submits nothing: that turn takes the waiting notices, and its end submits what it leaves, a notice offered after the release among it', async () => {
  fresh()
  const { env, values, clock, timers, submitted } = walkEnv([made(1), made(2)], [{ gives: 'Done' }, { gives: 'Stop' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  expect(pending().waiting.map(notice => notice.id)).toEqual([1])
  // The human's prompt starts a turn before the release runs.
  startTurn()
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([])
  const appended: string[] = []
  await handOver(appendTo(appended), async () => () => true)
  expect(appended).toEqual([doneNotice(itemOf(values, 1))])
  expect(offer({ id: 2, text: 'after the release' })).toBe('queued')
  expect(endTurn('t1', false, () => true)?.text).toBe(`${pointerText([1])}\n\nafter the release`)
})

test('the notices an interrupt held, before the walk or during it, are not in the release\'s prompt, nor is a pointer to the interrupted turn\'s appended notices: the human\'s next prompt carries each once', async () => {
  fresh()
  // Held before the walk: a turn interrupted with a notice waiting.
  startTurn()
  offer({ id: 3, text: '#3 is done: before' })
  expect(endTurn('t0', true, () => true)).toBe(null)
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, values, clock, timers, submitted, asked } = walkEnv([made(1), made(2), made(3), made(4)], [{ gives: 'Done', wait: gate }, { gives: 'Stop' }])
  clock.now = 1000
  const running = walk(env, WINDOW)
  await until(() => asked.length === 1)
  // Held during the walk: a turn that appended a notice (whose pointer is dropped) and left another waiting is interrupted.
  startTurn()
  offer({ id: 4, text: '#4 is done: appended' })
  await handOver(async () => true, async () => () => true)
  offer({ id: 4, text: '#4 is done: during' })
  expect(endTurn('t1', true, () => true)).toBe(null)
  // The walk writes an answer after the interrupt, and its notice is released like any other.
  release()
  await running
  await tickAt(timers, clock, 1000, 'ticks')
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: doneNotice(itemOf(values, 1)) }])
  expect(pending().held).toEqual([{ id: 3, text: '#3 is done: before' }, { id: 4, text: '#4 is done: during' }])
  const seen: (readonly string[] | undefined)[] = []
  const next = async (e: Prompt): Promise<{ drop?: unknown }> => {
    seen.push(e.context)
    return {}
  }
  await carryHeld<Prompt, { drop?: unknown }>({ origin: { kind: 'composer' } }, next, () => true)
  await carryHeld<Prompt, { drop?: unknown }>({ origin: { kind: 'composer' } }, next, () => true)
  expect(seen).toEqual([['#3 is done: before\n\n#4 is done: during'], undefined])
})

test('a walk whose only owed notices are held ones submits nothing at its end, and they stay for the human\'s next prompt', async () => {
  fresh()
  startTurn()
  offer({ id: 1, text: '#1 is done: held' })
  expect(endTurn('t0', true, () => true)).toBe(null)
  const { env, clock, timers, submitted } = walkEnv([made(1)], [{ gives: 'Stop' }])
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(pending()).toEqual({ held: [{ id: 1, text: '#1 is done: held' }], waiting: [] })
})

test('a session that ends between a walk\'s end and its release cancels the release: nothing is submitted in either session, and the hold is gone', async () => {
  fresh()
  const { env, clock, timers, submitted } = walkEnv([made(1)], [{ gives: 'Done' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  expect(pending().waiting.map(notice => notice.id)).toEqual([1])
  // The session's end, as its end hook makes it.
  reset()
  stopTicker()
  endWalk()
  expect(oneShots(timers)).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(offer({ id: 2, text: 'in the new session' })).toBe('submit')
})

test('a session that ends while the release\'s list read is in flight leads to no submit, and leaves the new session as it is', async () => {
  fresh()
  const { env, clock, timers, submitted, breakGet } = walkEnv([made(1)], [{ gives: 'Done' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  expect(pending().waiting.map(notice => notice.id)).toEqual([1])
  // The release's read of the list is the next one: the session ends as that read is answered, too late for the timer's cancel.
  breakGet.when = () => {
    breakGet.when = null
    reset()
    endWalk()
    return false
  }
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([])
  expect(pending()).toEqual({ held: [], waiting: [] })
  expect(offer({ id: 2, text: 'in the new session' })).toBe('submit')
})

test('a newer walk asking when the older walk\'s release fires: nothing is submitted, the newer walk\'s hold stays on, and the newer walk\'s end releases both walks\' notices once', async () => {
  fresh()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, values, clock, timers, submitted, asked, steps } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: 'Stop' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  steps.push({ gives: 'Done', wait: gate }, { gives: 'Stop' })
  const second = walk(env, WINDOW)
  await until(() => asked.length === 3)
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([])
  expect(offer({ id: 3, text: 'while the newer walk asks' })).toBe('walk')
  release()
  await second
  await tickAt(timers, clock, 1000, 'ticks')
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: [doneNotice(itemOf(values, 1)), 'while the newer walk asks', doneNotice(itemOf(values, 2))].join('\n\n') }])
})

test('a walk started while an older release\'s list read is in flight: the older release submits nothing, the newer walk\'s hold stays on, and its end releases both walks\' notices once', async () => {
  fresh()
  let release = (): void => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const { env, values, clock, timers, submitted, steps, breakGet } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: 'Stop' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  steps.push({ gives: 'Done', wait: gate }, { gives: 'Stop' })
  let second: Promise<string> = Promise.resolve('')
  // The release's read of the list is the next one: the newer walk claims its session as that read is answered.
  breakGet.when = () => {
    breakGet.when = null
    second = walk(env, WINDOW)
    return false
  }
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([])
  expect(offer({ id: 3, text: 'while the newer walk asks' })).toBe('walk')
  release()
  await second
  await tickAt(timers, clock, 1000, 'ticks')
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: [doneNotice(itemOf(values, 1)), 'while the newer walk asks', doneNotice(itemOf(values, 2))].join('\n\n') }])
})

test('a walk started and ended while an older release\'s list read is in flight takes the older release\'s place: the older one submits nothing, and the newer walk\'s release carries both walks\' notices', async () => {
  fresh()
  let answer = (): void => {}
  const slow = new Promise<void>(resolve => (answer = resolve))
  const { env, values, clock, timers, submitted, steps, slowGet } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: 'Stop' }])
  clock.now = 1000
  await walk(env, WINDOW)
  await tickAt(timers, clock, 1000, 'ticks')
  steps.push({ gives: 'Done' }, { gives: 'Stop' })
  // The release's read of the list waits, and a newer walk asks and ends meanwhile.
  slowGet.until = slow
  await tickAt(timers, clock, 1000, 'one-shots')
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  answer()
  await settle()
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000, 'ticks')
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: [1, 2].map(id => doneNotice(itemOf(values, id))).join('\n\n') }])
})

test('two walks that end within a second arm one release between them: the second walk\'s end takes the first walk\'s timer away, and one prompt carries both walks\' notices', async () => {
  fresh()
  const { env, values, clock, timers, submitted, steps } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: 'Stop' }])
  clock.now = 1000
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  steps.push({ gives: 'Done' }, { gives: 'Stop' })
  await walk(env, WINDOW)
  expect(oneShots(timers)).toEqual([1000])
  await tickAt(timers, clock, 1000, 'ticks')
  await tickAt(timers, clock, 1000, 'one-shots')
  expect(submitted).toEqual([{ text: [1, 2].map(id => doneNotice(itemOf(values, id))).join('\n\n') }])
})
