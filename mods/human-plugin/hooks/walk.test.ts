import { expect, test } from 'claude-code/testing'
import { ALREADY_ASKING, NOTHING_OPEN } from './commands'
import { doneNotice, type Form } from './done'
import { pending, reset } from './turns'
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
type Tick = { fn: () => unknown }
type Asked = { question: string; options: readonly string[]; header: string | undefined }

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
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
      after: (_ms: number, fn: () => unknown) => {
        timers.push({ fn })
        return { cancel: () => {} }
      },
      every: (_ms: number, fn: () => unknown) => {
        const timer: Tick = { fn }
        timers.push(timer)
        return {
          cancel: () => {
            const at = timers.indexOf(timer)
            if (at >= 0) timers.splice(at, 1)
          },
        }
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
        return {}
      },
    },
  }
  return { env: dollar as never, values, clock, timers, debug, shown, submitted, asked, steps, breakGet }
}

// A walk starts from nothing: the modules keep the walk's flag, the undo ticker and the turn's notices between tests.
const fresh = (): void => {
  endWalk()
  stopTicker()
  reset()
}

// The clock moves to `at`, and each tick the mod has started runs once there: a tick ends the undo windows whose time has run out.
const tickAt = async (timers: Tick[], clock: { now: number }, at: number): Promise<void> => {
  clock.now = at
  for (const timer of [...timers]) await timer.fn()
  await settle()
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
    'They are asked one at a time, blocking first, and each answer is written to the list as you give it and reaches the agent by your next prompt. Stop, or stop typed under Other, or closing the question ends this; what you have not answered stays on the list.',
    '1 of 3 — #2 blocking: Pick 2',
  ])
})

test('the questions come blocking first and then by id, each opening with the previous item\'s outcome line', async () => {
  fresh()
  const { env, asked } = walkEnv([made(1), made(2), made(3, { blocking: true })], [{ gives: 'Skip' }, { gives: 'Skip' }, { gives: 'Skip' }])
  const text = await walk(env, WINDOW)
  expect(asked.map(a => a.header)).toEqual(['#3', '#1', '#2'])
  expect(lines(asked[1]?.question ?? '').slice(0, 2)).toEqual(['skipped #3', '2 of 3 — #1 non-blocking: Item 1'])
  expect(lines(asked[2]?.question ?? '').slice(0, 2)).toEqual(['skipped #1', '3 of 3 — #2 non-blocking: Item 2'])
  expect(text).toBe(
    [
      '  skipped #2',
      '  It asked about every open item.',
      '  The walk sent nothing; 3 items are still open. /asks answer asks about them again.',
    ].join('\n'),
  )
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
  expect(lines(asked[1]?.question ?? '')[1]).toBe('2 of 3 — #4 blocking: Item 4')
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
  expect(lines(asked[1]?.question ?? '')[0]).toBe('#1 changed while it was shown, so nothing was sent; /asks answer asks it again.')
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

test('each answer label writes its form through the path /asks <n> <form> takes: the same list and, a tick later, the same notice', async () => {
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
  expect(text).toBe(['  It ended on Stop.', '  The walk sent 1 answer; 2 items are still open. /asks answer asks about them again.'].join('\n'))
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
    expect([name, lines(asked[1]?.question ?? '')[0]]).toEqual([name, '#1 changed while it was shown, so nothing was sent; /asks answer asks it again.'])
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

test('a rejected dialog (closed, expired or refused) writes nothing for its item, keeps the earlier answers, logs the message, and ends naming the item', async () => {
  fresh()
  const { env, values, debug, asked } = walkEnv([made(1), made(2), made(3)], [{ gives: 'Done' }, { gives: { rejects: 'The user dismissed the question' } }])
  const text = await walk(env, WINDOW)
  expect(asked).toHaveLength(2)
  expect(values.list.items.map(it => it.state)).toEqual(['done-waiting', 'open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question on #2 was closed, timed out or refused; nothing was sent for it. /asks 2 shows it, and /asks 2 <form> answers it.',
      '  The walk sent 1 answer; 2 items are still open. /asks answer asks about them again.',
    ].join('\n'),
  )
  expect(debug).toContain('human-plugin: walk ask #2: rejected: The user dismissed the question; record matched; not written')
})

test('a result that carries afkTimeoutMs writes nothing and ends with the auto-continue text; its record line says present', async () => {
  fresh()
  const { env, values, debug } = walkEnv([made(1), made(2)], [{ gives: 'Done', seen: 'auto' }])
  const text = await walk(env, WINDOW)
  expect(values.list.items.map(it => it.state)).toEqual(['open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question auto-continued while you were away; nothing was sent for #1.',
      '  The walk sent nothing; 2 items are still open. /asks answer asks about them again.',
    ].join('\n'),
  )
  expect(debug).toEqual(['human-plugin: walk record for #1: afkTimeoutMs present', 'human-plugin: walk ask #1: label "Done"; record matched; not written'])
})

test('a rejected dialog whose record carries afkTimeoutMs writes nothing and ends with the rejection text, not the auto-continue text; its message is logged', async () => {
  fresh()
  const message = 'no answer (No response after 20s — the user may be away from keyboard.)'
  const asking = (question: string): unknown => ({ questions: [{ question }] })
  const { env, values, debug } = walkEnv([made(1), made(2)], [{ gives: { rejects: message }, observed: { call: asking, result: { result: { afkTimeoutMs: 20000 } } } }])
  const text = await walk(env, WINDOW)
  expect(values.list.items.map(it => it.state)).toEqual(['open', 'open'])
  expect(text).toBe(
    [
      '  It ended when the question on #1 was closed, timed out or refused; nothing was sent for it. /asks 1 shows it, and /asks 1 <form> answers it.',
      '  The walk sent nothing; 2 items are still open. /asks answer asks about them again.',
    ].join('\n'),
  )
  expect(debug).toEqual(['human-plugin: walk record for #1: afkTimeoutMs present', `human-plugin: walk ask #1: rejected: ${message}; record matched; not written`])
})

test('an answer the observer saw no result for, or only a result for another question, writes nothing, ends as one that cannot be confirmed, and logs a line', async () => {
  for (const [seen, state] of [['none', 'missing'], ['other', 'other question']] as const) {
    fresh()
    const { env, values, debug } = walkEnv([made(1), made(2)], [{ gives: 'Done', seen }])
    const text = await walk(env, WINDOW)
    expect([seen, values.list.items.map(it => it.state)]).toEqual([seen, ['open', 'open']])
    expect(text).toBe(
      [
        '  It ended because the answer to #1 could not be confirmed as yours; nothing was sent, and this was logged.',
        '  The walk sent nothing; 2 items are still open. /asks answer asks about them again.',
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
      '  The walk sent 1 answer; 1 item is still open. /asks answer asks about it again.',
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
      '  The walk sent 1 answer; /asks shows what is still open.',
    ].join('\n'),
  )
  expect(itemOf(values, 1).state).toBe('done-waiting')
  expect(shown.filter(line => line.startsWith('human-plugin: the walk stopped on an error: '))).toHaveLength(1)
  expect(shown.join('\n')).toContain('list unreadable')
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
      '  The walk sent nothing; 2 items are still open. /asks answer asks about them again.',
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
      '  The walk sent 1 answer; 1 item is still open. /asks answer asks about it again.',
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
