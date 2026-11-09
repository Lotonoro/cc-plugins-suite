import { expect, test } from 'claude-code/testing'
import { register, wireHooks } from './register'
import { offer, reset, setOnChange, startTurn, takeHeld, endTurn } from './turns'
import { EMPTY, TOOL, act, normalizeStore } from './items'
import { NO_ETA, TODO_TOOL, fillTodo } from './todo'
import { REMINDER_TEXT } from './reminder'
import { TODO_SPEC, TOOL_SPEC } from './steering'
import { paneRows } from './ui'
import { correctionText } from './restatement'
import { ARG_HINT, CLAUDE_DESCRIPTION, CLAUDE_FAILED, CLAUDE_REBUILDING, CLAUDE_USAGE, DESCRIPTION, FAILED, PHONE_REBUILDING, REBUILDING, USAGE } from './commands'
import { resetRebuild, setForkedTranscript, startRestore } from './rebuild'
import { pressAnswer, pressDone, stopTicker } from './windows'
import type { Item } from '../types'

// The hook wiring, read off `register` with a recording `on`: each event's hook, and the `.catch` it was given. The kit can't
// make a plugin's own read throw (a hook beneath a failing call is skipped, not raised), so these tests drive the hook bodies
// and their handlers directly with a `$` whose state read rejects. The engine's routing of a throw or overrun to `.catch` is
// the types' contract (HookFailure, CatchHandler) and is not exercised here.
type Handler = (dollar: never, e: never, next: never) => unknown
type Next = ((e: unknown) => Promise<unknown>) & { called: boolean; error: { kind: string; message?: string; budget: number } }

type Load = (on: never) => unknown

// Loads the plugin the way the engine does, with no options: the undo window is the mod's own, not a setting.
const wire = (load: Load = on => register(on, {} as never)) => {
  const hooks: Record<string, Handler> = {}
  const catches: Record<string, Handler> = {}
  const on = (event: string, ...rest: unknown[]) => {
    const handler = rest[rest.length - 1] as Handler
    hooks[event] = handler
    // A filtered hook (`{ component }`, `{ requestId }`) is also kept under its filter, as two can share an event.
    if (rest.length === 2) hooks[`${event} ${JSON.stringify(rest[0])}`] = handler
    return {
      catch: (catchHandler: Handler) => {
        catches[event] = catchHandler
        if (rest.length === 2) catches[`${event} ${JSON.stringify(rest[0])}`] = catchHandler
      },
    }
  }
  load(on as never)
  return { hooks, catches }
}

// A `$` over a list of items, which records each ui.open it is asked for. The state is kept by key, as the engine keeps it.
const listEnv = (items: object[], opened: object[]) => {
  const values: Record<string, unknown> = { list: { items, next: 9 }, selection: null }
  return {
    state: {
      get: async (ref: { key: string }) => ({ value: values[ref.key], version: 1 }),
      set: async (ref: { key: string }, value: unknown) => {
        values[ref.key] = value
        return { isSet: true, version: 2 }
      },
    },
    clock: { now: async () => 0, after: () => ({ cancel: () => {} }), every: () => ({ cancel: () => {} }) },
    ui: {
      resolve: () => table,
      invalidate: () => {},
      log: () => {},
      open: async (args: object) => {
        opened.push(args)
        return { isPlaced: true }
      },
      close: async () => {},
      panes: async () => [],
    },
  }
}

const paneItem = (id: number, detail: string) => ({ id, title: `Item ${id}`, detail, blocking: true, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false, options: [], answer: null })

test('a switch while the pane is open re-opens it with the new item\'s rows, so a longer brief is not clipped', async () => {
  reset()
  const { hooks } = wire()
  const opened: { rows?: number }[] = []
  const short = paneItem(1, 'One line.')
  const long = paneItem(2, 'a\nb\nc\nd\ne')
  const env = listEnv([short, long], opened)
  await (hooks['ui.close'] as Handler)(env as never, { id: 'human-items', origin: { kind: 'person' } } as never, next(false) as never)
  const band = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const tree = await band(env as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  findButton(tree, 'title-1')?.onPress()
  await settle()
  const again = await band(env as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  findButton(again, 'title-2')?.onPress()
  await settle()
  // The pane's rows are its item alone: a header, a control, the reply field's row and its one line; then the long item's five lines.
  expect(opened.map(o => o.rows)).toEqual([1 + 1 + 1 + 1, 1 + 1 + 1 + 5])
})

// A `$` whose state read rejects (an unreadable list), and which records the log, the prompts it submits, and the store.
const broken = (logs: string[], submits: unknown[], stored: Record<string, unknown> = {}, writes: unknown[] = []) => ({
  state: {
    get: async () => {
      throw new Error('list unreadable')
    },
    set: async (_ref: unknown, value: unknown) => {
      writes.push(value)
      return { isSet: true, version: 1 }
    },
  },
  store: {
    get: async (key: string) => stored[key],
    set: async (key: string, value: unknown) => {
      stored[key] = value
    },
  },
  ui: { log: (text: string) => void logs.push(text) },
  prompt: {
    submit: async (e: unknown) => {
      submits.push(e)
      return {}
    },
  },
})

const next = (called: boolean, message = 'list unreadable'): Next => {
  const pass = (async (e: unknown) => ({ passed: e })) as Next
  pass.called = called
  pass.error = { kind: 'throw', message, budget: 1000 }
  return pass
}

test('each of the three hooks has a .catch handler; a removed one is missing here', () => {
  const { catches } = wire()
  for (const event of ['turn.complete', 'prompt.submit', 'session.end']) {
    expect(typeof catches[event]).toBe('function')
  }
})

test('a turn.complete whose list read throws still ends the turn: the notice it held is submitted, and the failure is logged', async () => {
  reset()
  const { hooks, catches } = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  const logs: string[] = []
  const submits: unknown[] = []
  const $ = broken(logs, submits)
  const e = { agentId: undefined, isAborted: false }
  expect(await Promise.resolve((hooks['turn.complete'] as Handler)($ as never, e as never, next(false) as never)).then(() => 'ran', err => String(err))).toContain('list unreadable')
  const answered = await (catches['turn.complete'] as Handler)($ as never, e as never, next(false) as never)
  expect(answered).toEqual({ passed: e })
  expect(submits).toEqual([{ text: '#1 is done: a' }])
  expect(logs).toEqual(['human-plugin: the turn.complete hook throw: list unreadable'])
})

test('a turn.complete failure after next was called answers with next and submits nothing more', async () => {
  reset()
  const { catches } = wire()
  const logs: string[] = []
  const submits: unknown[] = []
  const e = { agentId: undefined, isAborted: false }
  expect(await (catches['turn.complete'] as Handler)(broken(logs, submits) as never, e as never, next(true) as never)).toEqual({ passed: e })
  expect(submits).toEqual([])
})

test('a prompt.submit whose list read throws carries the held notices unchecked and gives them to the prompt once', async () => {
  reset()
  const { catches } = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, () => true)
  const logs: string[] = []
  const seen: unknown[] = []
  const passed = (async (e: unknown) => {
    seen.push(e)
    return { text: (e as { text: string }).text }
  }) as Next
  passed.called = false
  passed.error = { kind: 'throw', message: 'list unreadable', budget: 1000 }
  const answer = await (catches['prompt.submit'] as Handler)(broken(logs, []) as never, { origin: { kind: 'composer' }, text: 'hi' } as never, passed as never)
  expect(answer).toEqual({ text: 'hi' })
  expect(seen).toEqual([{ origin: { kind: 'composer' }, text: 'hi', context: ['#1 is done: a'] }])
  expect(takeHeld()).toEqual([])
  expect(logs).toEqual(['human-plugin: the prompt.submit hook throw: list unreadable', 'sent to Claude: #1 is done: a'])
})

// The prompt.submit hook run on `prompt`, with a `next` that records each prompt it passes on: one entry per prompt the hook entered.
const entered = async (hooks: Record<string, Handler>, env: object, prompt: object): Promise<{ context?: readonly string[] }[]> => {
  const seen: { context?: readonly string[] }[] = []
  const passed = (async (e: { context?: readonly string[] }) => {
    seen.push(e)
    return { text: 'hi' }
  }) as unknown as Next
  passed.called = false
  passed.error = { kind: 'throw', message: 'unused', budget: 1000 }
  await (hooks['prompt.submit'] as Handler)(env as never, prompt as never, passed as never)
  return seen
}

test('a prompt from the phone carries one block naming each open item as #<n> <title>, the blocking one first, and an answered one not at all', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { title: 'Pick a db' }), made(2, { title: 'Approve PR', blocking: true }), made(3, { title: 'Old', state: 'done-pending', answer: 'yes' })], [], null)
  const seen = await entered(hooks, env, { origin: { kind: 'bridge' }, text: 'hi' })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.context).toHaveLength(1)
  expect(seen[0]?.context?.[0]).toContain('  #2 Approve PR, #1 Pick a db')
  expect(seen[0]?.context?.[0]).not.toContain('Old')
})

test('a composer prompt, a prompt of another origin, a phone slash command and a phone prompt with nothing open carry no block, while a phone prompt with items open does', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { title: 'Pick a db' })], [], null)
  const text = { text: 'hi' }
  for (const prompt of [{ origin: { kind: 'composer' }, ...text }, { origin: { kind: 'sdk' }, ...text }, { origin: { kind: 'bridge' }, command: { name: 'asks', args: '' }, ...text }]) {
    expect(await entered(hooks, env, prompt)).toEqual([prompt])
  }
  const idle = memEnv([made(2, { state: 'done-pending', answer: 'yes' })], [], null).env
  expect(await entered(hooks, idle, { origin: { kind: 'bridge' }, ...text })).toEqual([{ origin: { kind: 'bridge' }, ...text }])
  expect((await entered(hooks, env, { origin: { kind: 'bridge' }, ...text }))[0]?.context).toHaveLength(1)
})

test('a prompt from the phone that also carries held notices carries the block, then the notices, and enters once', async () => {
  reset()
  const { hooks } = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: Item 1' })
  endTurn('t1', true, () => true)
  const { env } = memEnv([made(1, { detail: '' })], [], null)
  const seen = await entered(hooks, env, { origin: { kind: 'bridge' }, text: 'hi' })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.context).toHaveLength(2)
  expect(seen[0]?.context?.[0]).toContain('  #1 Item 1')
  expect(seen[0]?.context?.[1]).toBe('#1 is done: Item 1')
  expect(takeHeld()).toEqual([])
})

test('a reply that ends in the phone block\'s item line is not corrected: the line names the item by its id, and the same line without the id is corrected', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { title: 'Pick the db store, your call', detail: '' })], [], null)
  values.corrected = []
  const appended: string[] = []
  const $ = {
    ...env,
    session: {
      append: async (e: { message: { content: { text: string }[] } }) => {
        appended.push(e.message.content[0]?.text ?? '')
        return {}
      },
    },
  }
  const [block = ''] = (await entered(hooks, env, { origin: { kind: 'bridge' }, text: 'hi' }))[0]?.context ?? []
  expect(block).toContain('Pick the db store, your call')
  const itemLine = block.slice(block.lastIndexOf('\n') + 1)
  // Answers one turn's end, and returns the corrections appended by it.
  const endedWith = async (answer: string, turnId: string): Promise<string[]> => {
    const before = appended.length
    await (hooks['turn.complete'] as Handler)($ as never, { agentId: undefined, isAborted: false, turnId, reason: 'answer', answer } as never, next(false) as never)
    return appended.slice(before)
  }
  expect(await endedWith(`Here is where things stand.\n\n${itemLine}`, 't1')).toEqual([])
  expect(await endedWith(`Here is where things stand.\n\n${itemLine.replace('#1 ', '')}`, 't2')).toEqual([correctionText([1])])
})

test('a phone prompt sent while the list is being rebuilt waits for it, and its block names the rebuilt items; a composer prompt in the same rebuild waits for nothing', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    expect(await entered(wired.hooks, host, { origin: { kind: 'composer' }, text: 'hi' })).toEqual([{ origin: { kind: 'composer' }, text: 'hi' }])
    expect(timers).toEqual([])
    const phone = entered(wired.hooks, host, { origin: { kind: 'bridge' }, text: 'hi' })
    expect(timers).toHaveLength(1)
    finish()
    expect((await phone)[0]?.context?.[0]).toContain('  #1 Rebuilt ask')
  } finally {
    resetRebuild()
  }
})

test('a phone prompt whose wait for a rebuild runs out carries the rebuilding block, and names no item the list holds', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(2, { title: 'Live ask', detail: '' })], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const phone = entered(wired.hooks, host, { origin: { kind: 'bridge' }, text: 'hi' })
    await tickAt(timers, clock, 5000)
    expect((await phone)[0]?.context).toEqual([PHONE_REBUILDING])
  } finally {
    finish()
    resetRebuild()
  }
})

test('a phone prompt whose wait for a rebuild fails goes through with its live held notices and no block, and the failure is logged', async () => {
  freshModule()
  const wired = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: Item 1' })
  offer({ id: 2, text: '#2 is done: Live ask' })
  endTurn('t1', true, () => true)
  const logs: string[] = []
  // Item 1 is not on the list, so its notice is dropped; item 2 is, so its notice is carried.
  const { env } = memEnv([made(2, { title: 'Live ask', detail: '' })], [], null, [], [])
  const { host, finish } = rebuilding(env)
  // The wait for a rebuild arms a timer, and this host cannot arm one, so the wait fails and no block is built.
  const failure = new Error('no timer')
  const failing = {
    ...host,
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
    clock: { ...env.clock, after: () => { throw failure } },
  }
  startRestore(failing as never, '/sessions/s.jsonl')
  try {
    const e = { origin: { kind: 'bridge' }, text: 'hi' }
    const seen: { context?: readonly string[] }[] = []
    const passed = async (prompt: { context?: readonly string[] }) => {
      seen.push(prompt)
      return { text: 'hi' }
    }
    const outcome = await Promise.resolve((wired.hooks['prompt.submit'] as Handler)(failing as never, e as never, passed as never)).then(
      () => 'entered',
      () => 'failed',
    )
    expect(outcome).toBe('entered')
    expect(seen).toEqual([{ origin: { kind: 'bridge' }, text: 'hi', context: ['#2 is done: Live ask'] }])
    expect(logs).toEqual([`human-plugin: the prompt.submit hook throw: ${String(failure.stack)}`, 'sent to Claude: #2 is done: Live ask'])
  } finally {
    finish()
    resetRebuild()
  }
})

test('a session.end whose carry throws still empties the list, with the id counter the store holds', async () => {
  reset()
  const { catches } = wire()
  const logs: string[] = []
  const writes: unknown[] = []
  const stored = { next: 7 }
  const e = { reason: 'clear' }
  const answered = await (catches['session.end'] as Handler)(broken(logs, [], stored, writes) as never, e as never, next(false) as never)
  expect(answered).toEqual({ passed: e })
  expect(writes).toEqual([{ items: [], next: 7, term: null }, [], 0])
  expect(logs).toEqual(['human-plugin: the session.end hook throw: list unreadable'])
})

test('a session.end that is not a /clear empties nothing when its hook fails', async () => {
  reset()
  const { catches } = wire()
  const writes: unknown[] = []
  await (catches['session.end'] as Handler)(broken([], [], {}, writes) as never, { reason: 'exit' } as never, next(false) as never)
  expect(writes).toEqual([])
})

test('an add whose id counter cannot be saved is logged, and the reply still says the item was added', async () => {
  reset()
  const { hooks } = wire()
  // The pane flag outlives the test before this one, which leaves its pane open; a session's end clears it, as a fresh session starts closed.
  await (hooks['session.end'] as Handler)({} as never, { reason: 'exit' } as never, next(false) as never)
  const logs: string[] = []
  const $ = {
    ...broken(logs, []),
    state: {
      get: async () => ({ value: EMPTY, version: 0 }),
      set: async () => ({ isSet: true, version: 1 }),
    },
    clock: { now: async () => 0 },
    store: {
      get: async () => undefined,
      set: async () => {
        throw new Error('store full')
      },
    },
  }
  const answered = await (hooks['tool.call'] as Handler)($ as never, { tool: TOOL, action: 'add', title: 'Pick a db' } as never, next(false) as never)
  expect(answered).toEqual({ result: 'added #1' })
  expect(logs).toEqual(['human-plugin: the id counter was not saved: Error: store full'])
})

// The band's title buttons, pressed through the band's own drawing: a fake pane record, which the test may change as the person
// would by closing the pane (the engine raises ui.close for that).
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const table = {
  Box: (p: object) => ({ type: 'Box', ...p }),
  Text: (p: object) => ({ type: 'Text', ...p }),
  Button: (p: object) => ({ type: 'Button', ...p }),
  Markdown: (p: object) => ({ type: 'Markdown', ...p }),
}

// The table of a terminal or desktop surface: the mobile table above has no `Input`.
const fieldTable = { ...table, Input: (p: object) => ({ type: 'Input', ...p }) }
const findInput = (node: unknown, key: string): { onSubmit: (value: string, e: unknown) => void } | undefined => {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as { key?: unknown; onSubmit?: (value: string, e: unknown) => void; children?: unknown[] }
  if (n.key === key && n.onSubmit !== undefined) return { onSubmit: n.onSubmit }
  for (const child of n.children ?? []) {
    const found = findInput(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

const findButton = (node: unknown, key: string): { onPress: () => void } | undefined => {
  if (typeof node !== 'object' || node === null) return undefined
  const n = node as { key?: unknown; onPress?: () => void; children?: unknown[] }
  if (n.key === key && n.onPress !== undefined) return { onPress: n.onPress }
  for (const child of n.children ?? []) {
    const found = findButton(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

test('a press on the shown item\'s title opens the pane when it is shut, shuts it while it is open, and opens it again after the person has closed it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const values: Record<string, unknown> = { selection: null }
  const $ = {
    state: {
      get: async (ref: { key: string }) => ({ value: ref.key === 'selection' ? values.selection : { items: [{ id: 1, title: 'Pick a db', detail: 'Which store?\n\nMore context.', blocking: true, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false, options: [], answer: null }], next: 2 }, version: 1 }),
      set: async (ref: { key: string }, value: unknown) => {
        if (ref.key === 'selection') values.selection = value
        return { isSet: true, version: 2 }
      },
    },
    clock: { now: async () => 0 },
    ui: {
      resolve: () => table,
      open: async ({ id }: { id: string }) => {
        open.push(id)
        return { isPlaced: true }
      },
      close: async ({ id }: { id: string }) => {
        const at = open.indexOf(id)
        if (at >= 0) open.splice(at, 1)
      },
      panes: async () => open.map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isPlaced: true })),
      log: () => {},
    },
  }
  // The mod's flag of the pane outlives a test (it is the module's); the engine's ui.close for the pane being shut starts it here.
  await (hooks['ui.close'] as Handler)($ as never, { id: 'human-items', origin: { kind: 'person' } } as never, next(false) as never)
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const press = async (): Promise<void> => {
    const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
    findButton(tree, 'title-1')?.onPress()
    await settle()
  }
  await press()
  expect(open).toEqual(['human-items'])
  await press()
  expect(open).toEqual([])
  await press()
  expect(open).toEqual(['human-items'])
  // The person closes the pane by its own control: the engine raises ui.close with origin person, which the mod hears.
  open.length = 0
  await (hooks['ui.close'] as Handler)($ as never, { id: 'human-items', origin: { kind: 'person' } } as never, next(false) as never)
  await press()
  expect(open).toEqual(['human-items'])
  // The report of the mod's own earlier close arrives late, origin plugin, after the band was drawn and before its title is pressed: the
  // pane stays counted open, so the press closes it.
  const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  await (hooks['ui.close'] as Handler)($ as never, { id: 'human-items', origin: { kind: 'plugin' } } as never, next(false) as never)
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual([])
})

test('an empty list draws no band: the AbovePrompt render hands on, and an item brings the band back', async () => {
  reset()
  const { hooks } = wire()
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const e = { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } }
  const $ = (items: object[]) => ({
    state: { get: async () => ({ value: { items, next: items.length + 1 }, version: 1 }) },
    clock: { now: async () => 0 },
    ui: { resolve: () => table, panes: async () => [] },
  })
  const one = { id: 1, title: 'Pick a db', detail: '', blocking: true, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false, options: [], answer: null }
  expect(await render($([]) as never, e as never, next(false) as never)).toEqual({ passed: e })
  expect(JSON.stringify(await render($([one]) as never, e as never, next(false) as never))).toContain('To do for you')
})

test('a call to the mod\'s tool is drawn as one line, its result row empty; another tool\'s rows pass through', async () => {
  const { hooks } = wire()
  const $ = { ui: { resolve: () => table } }
  const call = hooks['ui.render {"component":"ToolUse"}'] as Handler
  const result = hooks['ui.render {"component":"ToolResult"}'] as Handler
  const row = await call($ as never, { props: { tool: TOOL, input: { action: 'add', title: 'Pick a db', blocking: true, detail: 'a\n\nb' }, output: 'added #1', isRunning: false, isErrored: false } } as never, next(false) as never)
  expect(row).toEqual({ type: 'Text', dimColor: true, wrap: 'truncate-end', children: ['human-plugin: added #1 Pick a db (blocking)'] })
  expect(await result($ as never, { props: { tool: TOOL, output: 'added #1', isErrored: false } } as never, next(false) as never)).toEqual({ type: 'Box', display: 'none' })
  const other = { props: { tool: 'Bash', input: { command: 'ls' }, output: undefined, isRunning: false, isErrored: false } }
  expect(await call($ as never, other as never, next(false) as never)).toEqual({ passed: other })
  const otherResult = { props: { tool: 'Bash', output: 'x', isErrored: false } }
  expect(await result($ as never, otherResult as never, next(false) as never)).toEqual({ passed: otherResult })
})

test('an add never lowers the id counter the store holds: a session behind the store saves the store\'s count', async () => {
  reset()
  const { hooks } = wire()
  const stored: Record<string, unknown> = { next: 11 }
  const $ = {
    ...broken([], []),
    state: {
      get: async () => ({ value: { items: [], next: 4 }, version: 0 }),
      set: async () => ({ isSet: true, version: 1 }),
    },
    clock: { now: async () => 0 },
    store: {
      get: async (key: string) => stored[key],
      set: async (key: string, value: unknown) => {
        stored[key] = value
      },
    },
  }
  expect(await (hooks['tool.call'] as Handler)($ as never, { tool: TOOL, action: 'add', title: 'Pick a db' } as never, next(false) as never)).toEqual({ result: 'added #4' })
  expect(stored.next).toBe(11)
})

test('a notice of two lines shows its sent line as one line', async () => {
  reset()
  const { hooks } = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: a\nThe human chose b on #1.' })
  const logs: string[] = []
  const $ = { ...broken(logs, []), session: { append: async () => ({}) } }
  await (hooks['turn.start'] as Handler)($ as never, { turnId: 't1' } as never, next(false) as never)
  expect(logs.filter(line => line.startsWith('sent to Claude: '))).toEqual(['sent to Claude: #1 is done: a The human chose b on #1.'])
})

test('a turn that starts with an unreadable list hands its notices over unchecked, and logs why', async () => {
  reset()
  const { hooks } = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  const logs: string[] = []
  const appended: string[] = []
  const $ = {
    ...broken(logs, []),
    session: {
      append: async (e: { message: { content: { text: string }[] } }) => {
        appended.push(e.message.content[0]?.text ?? '')
        return {}
      },
    },
  }
  await (hooks['turn.start'] as Handler)($ as never, { turnId: 't1' } as never, next(false) as never)
  expect(appended).toEqual(['#1 is done: a'])
  expect(logs).toEqual(['human-plugin: the list could not be read before a notice was appended: Error: list unreadable', 'sent to Claude: #1 is done: a'])
})

test('a refused append shows no sent line, and neither does a prompt that drops the notices it would carry', async () => {
  reset()
  const { hooks, catches } = wire()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  const logs: string[] = []
  const $ = { ...broken(logs, []), session: { append: async () => ({ deny: 'no' }) } }
  await (hooks['turn.start'] as Handler)($ as never, { turnId: 't1' } as never, next(false) as never)
  expect(logs.filter(line => line.startsWith('sent to Claude: '))).toEqual([])
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, () => true)
  const dropped = (async () => ({ drop: "no" })) as unknown as Next
  dropped.called = false
  dropped.error = { kind: 'throw', message: 'list unreadable', budget: 1000 }
  await (catches['prompt.submit'] as Handler)(broken(logs, []) as never, { origin: { kind: 'composer' }, text: 'hi' } as never, dropped as never)
  expect(logs.filter(line => line.startsWith('sent to Claude: '))).toEqual([])
})

// A `$` with a list holding one item, and a pane the test may drop as the engine would, with no ui.close the mod hears.
const paneEnv = (open: string[]) => {
  const values: Record<string, unknown> = { selection: null }
  return {
    state: {
      get: async (ref: { key: string }) => ({ value: ref.key === 'selection' ? values.selection : { items: [{ id: 1, title: 'Pick a db', detail: 'Which store?\n\nMore context.', blocking: true, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false, options: [], answer: null }], next: 2 }, version: 1 }),
      set: async (ref: { key: string }, value: unknown) => {
        if (ref.key === 'selection') values.selection = value
        return { isSet: true, version: 2 }
      },
    },
    store: { get: async () => undefined, set: async () => {} },
    clock: { now: async () => 0 },
    ui: {
      resolve: () => table,
      open: async ({ id }: { id: string }) => {
        open.push(id)
        return { isPlaced: true }
      },
      close: async ({ id }: { id: string }) => {
        const at = open.indexOf(id)
        if (at >= 0) open.splice(at, 1)
      },
      panes: async () => open.map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isPlaced: true })),
      log: () => {},
    },
  }
}

test('the pane opens with a usable height and asks for the keyboard', async () => {
  reset()
  const { hooks } = wire()
  const opened: object[] = []
  const one = { id: 1, title: 'Pick a db', detail: 'Which store?\n\nMore context.', blocking: true, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false, options: [], answer: null }
  const $ = {
    state: {
      get: async () => ({ value: { items: [one], next: 2 }, version: 1 }),
      set: async () => ({ isSet: true, version: 2 }),
    },
    clock: { now: async () => 0 },
    ui: {
      resolve: () => table,
      open: async (args: object) => {
        opened.push(args)
        return { isPlaced: true }
      },
      close: async () => {},
      panes: async () => [],
      log: () => {},
    },
  }
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(opened).toEqual([{ id: 'human-items', title: 'Items for you', rows: 6, focus: true }])
})

test('a /clear forgets that the pane was open: a title press made on a tree drawn before it opens the pane', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const $ = paneEnv(open)
  await (hooks['ui.close'] as Handler)($ as never, { id: 'human-items', origin: { kind: 'person' } } as never, next(false) as never)
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  open.length = 0
  await (hooks['session.end'] as Handler)($ as never, { reason: 'clear' } as never, next(false) as never)
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
})

test('a pane the engine dropped with no ui.close the mod hears is not counted as open: the next title press opens it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const $ = paneEnv(open)
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const press = async (): Promise<void> => {
    const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
    findButton(tree, 'title-1')?.onPress()
    await settle()
  }
  await press()
  expect(open).toEqual(['human-items'])
  open.length = 0
  await press()
  expect(open).toEqual(['human-items'])
})

test('a refused close keeps the pane counted open: the next title press closes it instead of opening it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const base = paneEnv(open)
  let refuse = false
  const $ = { ...base, ui: { ...base.ui, close: (e: { id: string }) => (refuse ? Promise.reject(new Error('close refused')) : base.ui.close(e)) } }
  await (hooks['ui.close'] as Handler)($ as never, { id: 'human-items', origin: { kind: 'person' } } as never, next(false) as never)
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const press = async (): Promise<void> => {
    const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
    findButton(tree, 'title-1')?.onPress()
    await settle()
  }
  await press()
  expect(open).toEqual(['human-items'])
  const tree = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  refuse = true
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  refuse = false
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual([])
})

test('a press counts the pane open the moment it is made: a second press before the open settles closes it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const $ = { ...paneEnv(open), ui: { ...paneEnv(open).ui, open: ({ id }: { id: string }) => {
    open.push(id)
    return new Promise(() => {})
  } } }
  await (hooks['session.end'] as Handler)($ as never, { reason: 'exit' } as never, next(false) as never)
  const render = hooks['ui.render {"component":"AbovePrompt"}'] as Handler
  const first = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  findButton(first, 'title-1')?.onPress()
  const second = await render($ as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never)
  findButton(second, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual([])
})

// An in-memory `$` for the list, the selection and the pane: the state holds what the hooks write, `open` is the pane's record,
// `submitted` the prompts the mod submits, and `timers` the clock's callbacks, which the test fires.
type Timer = { fn: () => unknown }
type Render = { drawing: boolean; writes: string[] }
const made = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Item ${id}`,
  detail: `Brief ${id}.`,
  blocking: false,
  createdAt: 0,
  state: 'open',
  pressedAt: null,
  note: null,
  agent: null,
  unread: false,
  options: [],
  answer: null,
  ...extra,
})
const memEnv = (items: unknown[], open: string[], selection: number | null, submitted: unknown[] = [], timers: Timer[] = []) => {
  const values: Record<string, unknown> = { list: { items, next: items.length + 1 }, selection }
  // The test moves the clock: a press is timed at it, and a tick (`tickAt`) runs at the time the test sets.
  const clock = { now: 0 }
  const render: Render = { drawing: false, writes: [] }
  const env = {
    render,
    state: {
      get: async (ref: { key: string }) => ({ value: values[ref.key], version: 1 }),
      set: async (ref: { key: string }, value: unknown) => {
        // The host refuses a write made while a ui.render hook draws ("state.set: denied ... while ui.render is being dispatched").
        if (render.drawing) {
          render.writes.push(ref.key)
          throw new Error('state.set: denied: it was made while ui.render is being dispatched')
        }
        values[ref.key] = value
        return { isSet: true, version: 2 }
      },
    },
    store: { get: async () => undefined, set: async () => {} },
    command: { register: async () => ({ value: undefined }) },
    clock: {
      now: async () => clock.now,
      after: (_ms: number, fn: () => unknown) => {
        timers.push({ fn })
        return { cancel: () => {} }
      },
      // The undo countdown's tick: kept in `timers` while it runs, so a test fires it, and a cancel takes it out.
      every: (_ms: number, fn: () => unknown) => {
        const timer: Timer = { fn }
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
      resolve: () => table,
      invalidate: () => {},
      open: async ({ id }: { id: string }) => {
        if (!open.includes(id)) open.push(id) // one pane per id: an open of an open id delivers its settings, never a second pane
        return { isPlaced: true }
      },
      close: async ({ id }: { id: string }) => {
        const at = open.indexOf(id)
        if (at >= 0) open.splice(at, 1)
      },
      panes: async () => open.map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isPlaced: true })),
      log: () => {},
    },
    prompt: {
      submit: async (e: unknown) => {
        submitted.push(e)
        return {}
      },
    },
  }
  return { env, values, clock }
}
// A draw may not write state: memEnv refuses a write made while one draws, and records its key. The draw is settled before the
// check, so a write its background work makes is caught too; the draw then fails, whatever the write's own log says.
const drawn = async (env: unknown, draw: () => unknown): Promise<unknown> => {
  const render = (env as { render: Render }).render
  render.drawing = true
  try {
    const tree = await draw()
    await settle()
    if (render.writes.length > 0) throw new Error(`state written while a ui.render hook draws: ${render.writes.join(', ')}`)
    return tree
  } finally {
    render.drawing = false
  }
}
const band = (hooks: Record<string, Handler>, env: unknown) =>
  drawn(env, () => hooks['ui.render {"component":"AbovePrompt"}']?.(env as never, { props: { hasSurvey: false, maxRows: 20, bodyColumns: 80 } } as never, next(false) as never))
const paneTree = (hooks: Record<string, Handler>, env: unknown) =>
  drawn(env, () => hooks['ui.render {"component":"Pane","requestId":"human-items"}']?.(env as never, { props: { bodyColumns: 80 } } as never, next(false) as never))

// The clock moves to `at`, and each tick the mod has started runs once there: a tick ends the undo windows whose time has run out.
const tickAt = async (timers: Timer[], clock: { now: number }, at: number): Promise<void> => {
  clock.now = at
  for (const timer of [...timers]) await timer.fn()
  await settle()
}

test('the undo window is 3 s with no options: a tick before that sends nothing, the first tick at or after it sends', async () => {
  reset()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 2999)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 3000)
  expect(submitted.length).toBe(1)
})

test('a window that ends while a later press opens another leaves the tick running for it, whatever order the writes are answered in', async () => {
  reset()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock, values } = memEnv([made(1, { detail: '' }), made(2, { detail: '' })], [], null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  // The write that ends #1's window lands at once, but its answer is held until after #2's press is answered.
  let release: () => void = () => {}
  let holding = true
  const set = env.state.set
  env.state.set = (async (ref: { key: string }, value: unknown) => {
    const result = await set(ref, value)
    if (ref.key !== 'list' || !holding) return result
    holding = false
    await new Promise<void>(done => (release = done))
    return result
  }) as typeof env.state.set
  clock.now = 3000
  for (const timer of [...timers]) void timer.fn()
  await settle()
  findButton(await band(hooks, env), 'done-2')?.onPress()
  await settle()
  release()
  await settle()
  await tickAt(timers, clock, 6000)
  const states = (values.list as { items: { id: number; state: string }[] }).items.map(it => [it.id, it.state])
  expect(states).toEqual([[1, 'done-pending'], [2, 'done-pending']])
})

test('a zero undo window sends at once, and leaves no tick running', async () => {
  reset()
  const { hooks } = wire((on: never) => wireHooks(on, 0))
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  expect(submitted.length).toBe(1)
  expect(timers.length).toBe(0)
})

test('a press on the summary row opens the pane on the first folded item, a blocking one first; a press on the shown item closes it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2, { blocking: true }), made(3, { blocking: true }), made(4)], open, null)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  // Three rows: the band keeps item 2 and folds 3 (blocking), 1 and 4, so the summary opens on 3.
  const drawnAt = (maxRows: number) => drawn(env, () => hooks['ui.render {"component":"AbovePrompt"}']?.(env as never, { props: { hasSurvey: false, maxRows, bodyColumns: 80 } } as never, next(false) as never))
  findButton(await drawnAt(3), 'band-more')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(open).toEqual([])
  // With no blocking item folded, the summary opens on the first folded item.
  const second: string[] = []
  const { env: plain, values: plainValues } = memEnv([made(1), made(2)], second, null)
  findButton(await drawn(plain, () => hooks['ui.render {"component":"AbovePrompt"}']?.(plain as never, { props: { hasSurvey: false, maxRows: 2, bodyColumns: 80 } } as never, next(false) as never)), 'band-more')?.onPress()
  await settle()
  expect(second).toEqual(['human-items'])
  expect(plainValues.selection).toBe(1)
})

test('a band title the pane does not show opens the pane on it, or switches to it; the title of the item it shows closes it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2), made(3)], open, 1)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(open).toEqual([])
})

test('a band title press opens the pane on that item; a press on the item it shows closes it, and a press after that opens it again', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1, { blocking: true }), made(2, { blocking: true })], open, null)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual([])
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
})

test('a band title press on the item the pane shows closes it, when the pane shows the first item by default', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = ['human-items']
  const { env } = memEnv([made(1, { blocking: true }), made(2, { blocking: true })], open, null)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  await band(hooks, env)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual([])
})

test('a band title press on an item the pane already shows reads it: its unread mark goes, the other item keeps its own', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = ['human-items']
  const { env, values } = memEnv([made(1, { blocking: true, unread: true }), made(2, { blocking: true, unread: true })], open, 1)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  expect(JSON.stringify(await band(hooks, env))).toContain('• #2')
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect((values.list as { items: { unread: boolean }[] }).items.map(it => it.unread)).toEqual([true, false])
  expect(values.selection).toBe(2)
})

test('removing the shown item moves the pane to the next item (higher id), with its rows, and the selection follows', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1), made(2), made(3)], open, null)
  const opened: { id: string; rows: number }[] = []
  const env = { ...plain, ui: { ...plain.ui, open: async (args: { id: string; rows: number }) => { opened.push({ id: args.id, rows: args.rows }); return plain.ui.open(args) } } }
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  // Item 3 is unread after the open, so only the switch to it can read it.
  const listOf = () => values.list as { items: (Item & { unread: boolean })[] }
  const shownNext = listOf().items.find(it => it.id === 3)
  if (shownNext) shownNext.unread = true
  opened.length = 0
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  const three = listOf().items.find(it => it.id === 3)
  expect(opened).toEqual([{ id: 'human-items', rows: paneRows(three) }])
  expect(values.selection).toBe(3)
  expect(three?.unread).toBe(false)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#3 non-blocking, open: Item 3')
  expect(shown).not.toContain('Item 1')
  expect(shown).not.toContain('Item 2')
})

test('removing the shown highest-id item moves the pane to the last remaining item', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2), made(3)], open, null)
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 3 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#2 non-blocking, open: Item 2')
  expect(shown).not.toContain('Item 3')
})

test('removing the last item closes the pane too', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env } = memEnv([made(1)], open, null)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(open).toEqual([])
})

test('a /clear with the pane open closes it, since the list it showed is gone', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env } = memEnv([made(1)], open, null)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  await settle()
  expect(open).toEqual([])
})

test('a press on the next title while the emptied list\'s close is in flight opens the pane on that item, and the close that settles later does not shut it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1)], open, null)
  const closes: string[] = []
  let settleClose: () => void = () => {}
  // The pane is dropped at once, and its close settles later.
  const env = { ...plain, ui: { ...plain.ui, close: ({ id }: { id: string }) => {
    closes.push(id)
    const at = open.indexOf(id)
    if (at >= 0) open.splice(at, 1)
    return new Promise<void>(resolve => {
      settleClose = resolve
    })
  } } }
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  // Removing the only item closes the pane; the close is still in flight when a tool call adds item 2.
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(closes).toEqual(['human-items'])
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'add', title: 'Later' } as never, next(false) as never)
  await settle()
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  settleClose()
  await settle()
  // The settled close did not clear the pane's flag: a press on the shown item closes it.
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(closes).toEqual(['human-items', 'human-items'])
  expect(values.selection).toBe(2)
})

test('a /clear closes the pane even when the list cannot be read: the pane goes before the failure', async () => {
  reset()
  const { hooks, catches } = wire()
  const open: string[] = []
  const { env } = memEnv([made(1)], open, null)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  const unreadable = { ...env, state: { ...env.state, get: async () => { throw new Error('list unreadable') } } }
  const e = { reason: 'clear' }
  // The engine runs the hook, sees it throw, then runs its .catch: the pane must already be closing when the hook throws.
  const thrown = await Promise.resolve((hooks['session.end'] as Handler)(unreadable as never, e as never, next(false) as never)).then(() => null, (err: Error) => err)
  expect(thrown?.message).toBe('list unreadable')
  await (catches['session.end'] as Handler)(unreadable as never, e as never, next(false) as never)
  await settle()
  expect(open).toEqual([])
})

test('removing a different item while the pane is open leaves the pane on its item: no re-open, and the same item is shown', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1, { detail: 'One line.' }), made(2, { detail: 'a\nb\nc\nd\ne' }), made(3, { detail: 'x' })], open, null)
  const opened: string[] = []
  const env = { ...plain, ui: { ...plain.ui, open: async (args: { id: string }) => { opened.push(args.id); return plain.ui.open(args) } } }
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(opened).toEqual(['human-items'])
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 3 } as never, next(false) as never)
  await settle()
  expect(opened).toEqual(['human-items'])
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#2 non-blocking, open: Item 2')
  expect(shown).not.toContain('Item 1')
})

test('an answer pressed in the pane is sent once, with its label, when its window ends; cancelling it sends nothing', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const decision = made(1, { detail: '', options: [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }] })
  const { env, clock } = memEnv([decision], open, 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await paneTree(hooks, env), 'answer-1-1')?.onPress()
  await settle()
  expect(timers.length).toBe(1)
  clock.now = 1000
  findButton(await paneTree(hooks, env), 'done-1')?.onPress()
  await settle()
  // The cancel leaves the tick to the next one, which finds no window and stops.
  await tickAt(timers, clock, 3000)
  expect(timers.length).toBe(0)
  expect(submitted).toEqual([])
  findButton(await paneTree(hooks, env), 'answer-1-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 5999)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 6000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human chose Use sqlite on #1. Act on that choice, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.' }])
})

test('a yes/no press is sent once, with its answer, when its window ends; cancelling it sends nothing', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '', yesno: true })], open, null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'no-1')?.onPress()
  await settle()
  expect(timers.length).toBe(1)
  clock.now = 1000
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([])
  findButton(await band(hooks, env), 'no-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 6000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human answered no on #1. Act on that answer, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.' }])
})

// The reply tests read the pane through a surface whose table has the field, from the list in memEnv.
const replyEnv = (items: unknown[], open: string[], selection: number | null, submitted: unknown[], timers: Timer[]) => {
  const made2 = memEnv(items, open, selection, submitted, timers)
  made2.env.ui.resolve = () => fieldTable
  return made2
}

test('a reply typed in the pane is sent once, through the undo window, with its text on one line', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = replyEnv([made(1, { detail: '' })], open, 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('  Use\nsqlite  ', {})
  await settle()
  expect(timers.length).toBe(1)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human replied on #1: Use sqlite\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #1; the item is then open for their next reply. Your own follow-up work never stays on the list.' }])
})

test('an agent append during a reply\'s undo window is a turn after the reply: the window runs on, and its end sends the reply and reopens the item with that turn after it', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: 'Brief 1.' })], open, null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  expect(timers.length).toBe(1)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 1, text: 'more' } as never, next(false) as never)
  await settle()
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({
    state: 'done-waiting', detail: 'Brief 1.', answer: 'Use sqlite', replied: true, windowTurns: [{ speaker: 'agent', words: 'more' }],
  })
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human replied on #1: Use sqlite\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #1; the item is then open for their next reply. Your own follow-up work never stays on the list.' }])
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({
    state: 'open', answer: null, replied: false, thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'more' }],
  })
})

test('an agent update during a reply\'s undo window leaves it running, and its end sends the reply once and reopens the item with the reply archived once', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: 'Brief 1.' })], open, 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'update', id: 1, detail: 'Brief 2.' } as never, next(false) as never)
  await settle()
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'done-waiting', detail: 'Brief 2.', answer: 'Use sqlite' })
  await tickAt(timers, clock, 3000)
  await tickAt(timers, clock, 4000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human replied on #1: Use sqlite\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #1; the item is then open for their next reply. Your own follow-up work never stays on the list.' }])
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({
    state: 'open', answer: null, replied: false, detail: 'Brief 2.', thread: [{ speaker: 'human', words: 'Use sqlite' }],
  })
})

test('a press on undo cancels a reply: nothing is sent, and the item is open with no reply', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: '' })], open, 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  findButton(await paneTree(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([])
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'open', answer: null, replied: false })
})

test('a reply typed in the pane is logged as a reply, a done press as a done press, each with the time it was pressed', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env: plain } = replyEnv([made(1, { detail: '' }), made(2, { detail: '' })], open, 1, [], timers)
  const logs: string[] = []
  const env = { ...plain, ui: { ...plain.ui, log: (text: string) => void logs.push(text) } }
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  findButton(await band(hooks, env), 'done-2')?.onPress()
  await settle()
  expect(logs.filter(line => /^human-plugin: (reply|done press) #/.test(line))).toEqual([
    'human-plugin: reply #1 at 0: open -> done-waiting',
    'human-plugin: done press #2 at 0: open -> done-waiting',
  ])
})

test('an empty or blank reply sends nothing and opens no undo window', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env } = replyEnv([made(1, { detail: '' })], open, 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  const field = findInput(await paneTree(hooks, env), 'reply-1')
  field?.onSubmit('', {})
  field?.onSubmit('   ', {})
  await settle()
  expect(timers.length).toBe(0)
  expect(submitted).toEqual([])
})

test('when the window ends on the item the pane shows, the pane moves to the next open item, skipping one already sent', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1), made(2, { state: 'done-pending' }), made(3)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#3 non-blocking, open: Item 3')
  expect(shown).not.toContain('Item 1')
})

test('when the window ends on the item the pane shows and no open item is left, the pane closes', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1), made(2, { state: 'done-pending' })], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(open).toEqual([])
})

test('the window ending on an item the pane does not show leaves the pane where it is', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1), made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-2')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
})

// The pane's open requests, recorded as memEnv's pane takes them.
const recordingOpens = <E extends { ui: { open: (args: { id: string; rows: number }) => Promise<unknown> } }>(plain: E, opened: { id: string; rows: number }[]) => ({
  ...plain,
  ui: { ...plain.ui, open: async (args: { id: string; rows: number }) => { opened.push({ id: args.id, rows: args.rows }); return plain.ui.open(args) } },
})

test('a reply\'s window ending moves the pane on to the next open item, as an option press\'s does: the selection follows, and the pane asks for that item\'s rows', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env: plain, values, clock } = replyEnv([made(1, { detail: '' }), made(2, { detail: 'a\nb\nc\nd\ne' })], open, null, [], timers)
  await (hooks['session.end'] as Handler)(plain as never, { reason: 'exit' } as never, next(false) as never)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  opened.length = 0
  await tickAt(timers, clock, 3000)
  const items = (values.list as { items: Item[] }).items
  expect(items.find(it => it.id === 1)).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  expect(opened).toEqual([{ id: 'human-items', rows: paneRows(items.find(it => it.id === 2)) }])
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#2 non-blocking, open: Item 2')
  expect(shown).not.toContain('Item 1')
})

test('a reply undone within its window leaves the pane on its item, open with its reply field, and the pane asks for nothing', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env: plain, values, clock } = replyEnv([made(1, { detail: '' }), made(2)], open, null, submitted, timers)
  await (hooks['session.end'] as Handler)(plain as never, { reason: 'exit' } as never, next(false) as never)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  opened.length = 0
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  findButton(await paneTree(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([])
  expect(opened).toEqual([])
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'open', answer: null, replied: false })
  const shown = await paneTree(hooks, env)
  expect(JSON.stringify(shown)).toContain('#1 non-blocking, open: Item 1')
  expect(findInput(shown, 'reply-1')).toBeDefined()
})

test('an option press\'s window ending moves the pane on to the next open item, as a done press\'s does', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const decision = made(1, { detail: '', options: [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }] })
  const { env, values, clock } = memEnv([decision, made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await paneTree(hooks, env), 'answer-1-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#2 non-blocking, open: Item 2')
})

test('a window that ends on the item the pane shows, with an agent append reopening it before the pane decides, leaves the pane on it, open', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' })], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  // The first read of the selection after the window's end is the pane's own, made once the end has written the item sent. It is held
  // until an agent append has reopened the item.
  let release: () => void = () => {}
  let holding = true
  const get = env.state.get
  env.state.get = (async (ref: { key: string }) => {
    if (ref.key === 'selection' && holding) {
      holding = false
      await new Promise<void>(done => (release = done))
    }
    return get(ref)
  }) as typeof env.state.get
  await tickAt(timers, clock, 3000)
  expect(holding).toBe(false)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 1, text: 'It needs a file.' } as never, next(false) as never)
  await settle()
  release()
  await settle()
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'open' })
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
})

test('removing the shown item moves the pane to the next open item, skipping one already sent', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2, { state: 'done-pending' }), made(3)], open, null)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
})

test('a sent item the person views is left alone by a tool call; a tool call that removes it moves the pane on', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2, { state: 'done-pending' })], open, null)
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(values.selection).toBe(2)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'add', title: 'Later' } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(values.selection).toBe(3)
})

test('an append that reopens the sent item the pane shows re-asks its rows with the reply field, and the item is not unread', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1), made(2, { state: 'done-pending', answer: 'Use sqlite', replied: true })], open, null)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(values.selection).toBe(2)
  opened.length = 0
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 2, text: 'more' } as never, next(false) as never)
  await settle()
  const two = (values.list as { items: Item[] }).items.find(it => it.id === 2) as Item
  expect(two).toMatchObject({ state: 'open', unread: false })
  expect(opened).toEqual([{ id: 'human-items', rows: paneRows(two) }])
  // The reply field's row and a bare press's 'pressed done' turn are one row each, so the open item and its done-waiting view ask for the same rows.
  expect(opened[0]?.rows).toBe(paneRows({ ...two, state: 'done-waiting' }))
  expect(values.selection).toBe(2)
})

test('an append that reopens an item the pane does not show leaves that item unread, and the pane\'s item and request alone', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1), made(2, { state: 'done-pending', answer: 'Use sqlite', replied: true })], open, null)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  opened.length = 0
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 2, text: 'more' } as never, next(false) as never)
  await settle()
  const two = (values.list as { items: Item[] }).items.find(it => it.id === 2)
  expect(two).toMatchObject({ state: 'open', unread: true })
  expect(opened).toEqual([])
  expect(values.selection).toBe(1)
})

test('an update of the brief to the open item the pane shows re-asks its rows though nothing reopens: the rows follow the brief\'s length', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1, { detail: 'One line.' })], open, null)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  opened.length = 0
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'update', id: 1, detail: 'a\nb\nc\nd\ne' } as never, next(false) as never)
  await settle()
  const one = (values.list as { items: Item[] }).items[0] as Item
  expect(one).toMatchObject({ state: 'open', unread: false })
  expect(opened).toEqual([{ id: 'human-items', rows: paneRows(one) }])
  expect(paneRows(one)).toBeGreaterThan(paneRows({ ...one, detail: 'One line.' }))
  expect(values.selection).toBe(1)
})

// A reload leaves the mod with no record of its pane (paneOpen starts empty) while the engine keeps the pane open and the
// selection. The kit cannot load the module afresh (its static analysis refuses a dynamic import in a hooks module), so this ends
// the session instead, which clears the same record (session.end): the engine's pane is kept, the record is empty, and the band's
// first draw resyncs paneOpen from the engine, as after a reload.
const reloaded = async (open: string[], items: unknown[], selection: number | null, submitted: unknown[] = [], timers: Timer[] = []) => {
  const { hooks } = wire()
  const { env, values, clock } = memEnv(items, open, selection, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  await band(hooks, env)
  return { hooks, env, values, clock }
}

test('after a reload, removing the shown item moves the pane to the next open item, the selection following', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2), made(3)], 2)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#3 non-blocking, open: Item 3')
  expect(shown).not.toContain('Item 2')
})

test('after a reload, removing the last item closes the pane', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1)], 1)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(open).toEqual([])
})

test('after a reload, the expiry of a press on the shown item moves the pane on to the next open item', async () => {
  const open = ['human-items']
  const timers: Timer[] = []
  const { hooks, env, values, clock } = await reloaded(open, [made(1), made(2), made(3)], 2, [], timers)
  findButton(await band(hooks, env), 'done-2')?.onPress()
  await settle()
  expect(timers.length).toBe(1)
  await tickAt(timers, clock, 3000)
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#3 non-blocking, open: Item 3')
})

test('with no selection the open pane shows the first item, so removing that item moves the pane on to the next', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = ['human-items']
  const { env, values } = memEnv([made(1), made(2), made(3)], open, null)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  await band(hooks, env)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#2 non-blocking, open: Item 2')
})

test('a press whose selection write is still in flight holds the pane on the pressed item when the item shown before it is removed', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2), made(3)], 1)
  const writes: Array<() => void> = []
  const set = env.state.set
  env.state.set = (ref, value) => (ref.key === 'selection' ? new Promise<{ isSet: boolean; version: number }>(done => writes.push(() => done(set(ref, value)))) : set(ref, value))
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#3 non-blocking, open: Item 3')
  writes.forEach(write => write())
  await settle()
  expect(values.selection).toBe(3)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#3 non-blocking, open: Item 3')
})

test('while a press\'s selection write is still in flight, the band counts the pressed item as shown: a second press on its title closes the pane', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1), made(2), made(3)], 1)
  const writes: Array<() => void> = []
  const set = env.state.set
  env.state.set = (ref, value) => (ref.key === 'selection' ? new Promise<{ isSet: boolean; version: number }>(done => writes.push(() => done(set(ref, value)))) : set(ref, value))
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(open).toEqual([])
  writes.forEach(write => write())
  await settle()
})

test('a press whose selection write is refused leaves the pane drawing the stored selection, not the pressed item', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2), made(3)], 1)
  const set = env.state.set
  env.state.set = (ref, value) => (ref.key === 'selection' ? Promise.reject(new Error('selection write refused')) : set(ref, value))
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(values.selection).toBe(1)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
})

test('two presses whose selection writes are both refused leave the pane on the stored selection', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2), made(3)], 1)
  const refusals: Array<() => void> = []
  const set = env.state.set
  env.state.set = (ref, value) => (ref.key === 'selection' ? new Promise<never>((_, reject) => refusals.push(() => reject(new Error('selection write refused')))) : set(ref, value))
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  refusals.forEach(refuse => refuse())
  await settle()
  expect(values.selection).toBe(1)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
})

test('two quick presses whose writes land out of order save the later press: the retried write saves the item shown now', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2), made(3)], 1)
  // The selection kept at a version, as the host keeps it: a write given `ifVersion` that another write beat is not set, and update tries again.
  let version = 1
  const writes: Array<() => void> = []
  const get = env.state.get
  const set = env.state.set
  env.state.get = async ref => (ref.key === 'selection' ? { value: values.selection, version } : get(ref))
  env.state.set = ((ref: { key: string }, value: unknown, options?: { ifVersion?: number }) => {
    if (ref.key !== 'selection') return set(ref, value)
    return new Promise<{ isSet: boolean; version: number }>(done =>
      writes.push(() => {
        if (options?.ifVersion !== undefined && options.ifVersion !== version) return done({ isSet: false, version })
        values.selection = value
        version++
        done({ isSet: true, version })
      }),
    )
  }) as typeof env.state.set
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  // Item 3's write lands first, then item 2's misses and is retried.
  writes.splice(1, 1)[0]?.()
  await settle()
  while (writes.length > 0) {
    writes.shift()?.()
    await settle()
  }
  expect(values.selection).toBe(3)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#3 non-blocking, open: Item 3')
})

test('after a press, the band and the pane still read the stored selection, so a selection write that lands draws them again', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1), made(2), made(3)], 1)
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  const reads: string[] = []
  const get = env.state.get
  env.state.get = ref => (reads.push(ref.key), get(ref))
  await band(hooks, env)
  await paneTree(hooks, env)
  expect(reads.filter(key => key === 'selection').length).toBe(2)
})

test('a press whose selection write is refused asks for a redraw, so the surfaces drawn on the pressed item go back to the stored one', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1), made(2), made(3)], 1)
  const set = env.state.set
  env.state.set = (ref, value) => (ref.key === 'selection' ? Promise.reject(new Error('selection write refused')) : set(ref, value))
  const asked: string[] = []
  ;(env.ui as { invalidate: (event: string) => void }).invalidate = event => void asked.push(event)
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(asked).toContain('ui.render')
})

// An item as release 0.1 wrote it: a stored list from before the fields added since holds these, and no others.
const legacy = { id: 1, title: 'Pick a db', detail: 'Which store?', blocking: true, createdAt: 0, state: 'open' }

test('the band draws a 0.1-shaped item with its title and its [✓], and writes nothing', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([legacy], [], null)
  const tree = await band(hooks, env)
  expect(JSON.stringify(tree)).toContain('Pick a db')
  expect(JSON.stringify(tree)).toContain('"label":"[✓]"')
})

test('the restatement check runs on a 0.1-shaped item: the answer that restates it is corrected, and nothing is logged as failed', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([legacy], [], null)
  values.corrected = []
  const appended: string[] = []
  const logs: string[] = []
  const $ = {
    ...env,
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
    session: {
      append: async (e: { message: { content: { text: string }[] } }) => {
        appended.push(e.message.content[0]?.text ?? '')
        return {}
      },
    },
  }
  // The first block is off the item's topic, so the check reads its options (the line the live failure named); the second restates it.
  const e = { agentId: undefined, isAborted: false, turnId: 't1', reason: 'answer', answer: 'Which engine do you want?\n\nPick db: which store? Your call.' }
  await (hooks['turn.complete'] as Handler)($ as never, e as never, next(false) as never)
  expect(appended).toEqual([correctionText([1])])
  expect(logs.filter(text => text.includes('restatement check failed'))).toEqual([])
})

test('the tool lists and removes a 0.1-shaped item, and drops a garbage item from the list', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([{ title: 'garbage' }, legacy], [], null)
  expect(await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'list' } as never, next(false) as never)).toEqual({
    result: '#1 blocking, open: Pick a db - Which store?',
  })
  expect(await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)).toEqual({
    result: 'removed #1',
  })
  expect(values.list).toEqual({ items: [], next: 3, term: null })
})

test('the band shows no garbage item, and draws the one beside it', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([{ title: 'garbage' }, legacy], [], null)
  const text = JSON.stringify(await band(hooks, env))
  expect(text).toContain('Pick a db')
  expect(text).not.toContain('garbage')
})

// The mod's tool called as the model calls it: from the main agent, or as a subagent when the input names its `agentId`.
const runTool = (hooks: Record<string, Handler>, env: unknown, input: Record<string, unknown>) =>
  (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, ...input } as never, next(false) as never)

test('an add from the main agent with a term draws the chip with it, and its reply names the term', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  expect(await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })).toEqual({ result: 'added #1 (term set to "owner")' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for owner')
})

test('a term is drawn as one line with single spaces; a blank one returns the chip to To do for you, and its add still lands', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  expect(await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'Team\n   lead' })).toEqual({ result: 'added #1 (term set to "Team lead")' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for Team lead')
  expect(await runTool(hooks, env, { action: 'add', title: 'Second', term: '  ' })).toEqual({ result: 'added #2 (term cleared)' })
  const drawn = JSON.stringify(await band(hooks, env))
  expect(drawn).toContain('To do for you')
  expect(drawn).toContain('2 open')
  expect(drawn).not.toContain('Team lead')
})

test('a later term changes the chip; a call with no term leaves it, and a term-only update sets it at once', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  await runTool(hooks, env, { action: 'add', title: 'Second' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for owner')
  expect(await runTool(hooks, env, { action: 'update', id: 2, term: 'lead' })).toEqual({ result: 'no change to #2 (term set to "lead")' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for lead')
  await runTool(hooks, env, { action: 'update', id: 2, note: 'recheck' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for lead')
})

test('a subagent\'s term is not used: its add adds the item, and the chip keeps the term the main agent set', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  expect(await runTool(hooks, env, { action: 'add', title: 'Sub ask', term: 'the user', agentId: 'sub-1' })).toEqual({
    result: 'added #2 (term not used: only the main agent sets it)',
  })
  expect(await runTool(hooks, env, { action: 'add', title: 'Long ask', term: 'x'.repeat(21), agentId: 'sub-1' })).toEqual({
    result: 'added #3 (term not used: only the main agent sets it)',
  })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for owner')
})

test('an over-long term refuses the add or the update: no item is added or changed, and the chip keeps its term', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  const reason = 'term must be at most 20 columns: give the short word or name you use for the human'
  const tooLong = 'x'.repeat(21)
  expect(await runTool(hooks, env, { action: 'add', title: 'Second', term: tooLong })).toEqual({ deny: reason })
  expect(await runTool(hooks, env, { action: 'update', id: 1, title: 'Renamed', term: tooLong })).toEqual({ deny: reason })
  expect(await runTool(hooks, env, { action: 'update', id: 1, term: tooLong })).toEqual({ deny: reason })
  expect(values.list).toMatchObject({ items: [{ id: 1, title: 'Pick a db' }], term: 'owner' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for owner')
})

test('a term-only update naming an item no one has is refused, and the chip keeps its term', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  expect(await runTool(hooks, env, { action: 'update', id: 9, term: 'lead' })).toEqual({ deny: 'no item #9' })
  expect(JSON.stringify(await band(hooks, env))).toContain('To do for owner')
})

test('after a /clear the band reads To do for you until a term is stated again', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  expect(values.list).toEqual({ items: [], next: 2, term: null })
  expect(await runTool(hooks, env, { action: 'add', title: 'Next ask' })).toEqual({ result: 'added #2' })
  const drawn = JSON.stringify(await band(hooks, env))
  expect(drawn).toContain('To do for you')
  expect(drawn).not.toContain('owner')
})

test('a reload restarts the undo countdown: its first tick sends each window that has run out, once, and a later tick the rest', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { state: 'done-waiting', pressedAt: 0 }), made(2, { state: 'done-waiting', pressedAt: 2000 })], open, null, submitted, timers)
  // A tick a test before this one left running is cancelled by a session's end, so the count below is this reload's alone.
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  // The reloaded module's clock reads 3500 ms: item 1's window (3 s from its press at 0) has run out, item 2's has 1500 ms left.
  clock.now = 3500
  await (hooks['session.start'] as Handler)({ ...env, tool: { register: async () => ({ isRegistered: true }) } } as never, {} as never, next(false) as never)
  await settle()
  expect(timers.length).toBe(1)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 3500)
  expect(submitted.length).toBe(1)
  await tickAt(timers, clock, 3500)
  expect(submitted.length).toBe(1)
  // The first send holds the session busy until its turn ends, so the second notice waits for that end, and goes with it.
  await tickAt(timers, clock, 5000)
  expect(submitted.length).toBe(1)
  await (hooks['turn.complete'] as Handler)(env as never, { agentId: undefined, isAborted: false, turnId: 't1' } as never, next(false) as never)
  await settle()
  expect(submitted.length).toBe(2)
  expect((values.list as { items: Item[] }).items.map(it => it.state)).toEqual(['done-pending', 'done-pending'])
})

// The env with a clock whose every() counts the redraw ticks it starts and cancels, so a test can tell whether one is left running. A tick is
// kept in `timers`, as memEnv keeps one, so a test can fire it.
const counting = <E extends { clock: object }>(env: E, ticks: { started: number; cancelled: number }, timers: Timer[] = []) => ({
  ...env,
  clock: {
    ...env.clock,
    every: (_ms: number, fn: () => unknown) => {
      ticks.started += 1
      const timer: Timer = { fn }
      timers.push(timer)
      return {
        cancel: () => {
          ticks.cancelled += 1
          const at = timers.indexOf(timer)
          if (at >= 0) timers.splice(at, 1)
        },
      }
    },
  },
})

test('a session end cancels the one-second redraw of the undo countdown, so no tick is left to redraw the band', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env } = memEnv([made(1, { detail: '' })], open, null)
  const ticks = { started: 0, cancelled: 0 }
  const ticking = counting(env, ticks)
  // A tick a test before this one left running is cancelled by this end, so the counts below are this press's alone.
  await (hooks['session.end'] as Handler)(ticking as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, ticking), 'done-1')?.onPress()
  await settle()
  expect(ticks.started).toBe(1)
  await (hooks['session.end'] as Handler)(ticking as never, { reason: 'clear' } as never, next(false) as never)
  expect(ticks.cancelled).toBe(1)
})

test('a window that ends for an item removed meanwhile stops the redraw once no window is left', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], open, null, submitted, timers)
  const ticks = { started: 0, cancelled: 0 }
  const ticking = counting(env, ticks, timers)
  await (hooks['session.end'] as Handler)(ticking as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, ticking), 'done-1')?.onPress()
  await settle()
  expect(ticks.started).toBe(1)
  await (hooks['tool.call'] as Handler)(ticking as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([])
  expect(ticks.cancelled).toBe(1)
})

test('a subagent\'s turn start leaves the main loop idle: a done notice after it is submitted at once, not queued for a turn that is not running', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], open, null, submitted, timers)
  await (hooks['turn.start'] as Handler)(env as never, { turnId: 'sub-turn', text: '', agentId: 'sub-1' } as never, next(false) as never)
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human marked it done. If the item proposed something or carried a recommendation, that is a go-ahead for it. Check that it is finished, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.' }])
})

// A reload: the module's variables start over (reset stands in for the new module), while the state keeps what it held. The callback
// that writes the state is cut first, so reset's own write does not clear the state the reload keeps.
const freshModule = (): void => {
  setOnChange(() => {})
  reset()
}

// The session starts, as a reload starts it again: the mod registers its tool, then re-offers what its state kept.
const started = (wired: { hooks: Record<string, Handler> }, env: object) =>
  (wired.hooks['session.start'] as Handler)({ ...env, tool: { register: async () => ({ isRegistered: true }) } } as never, {} as never, next(false) as never)

test('a notice waiting at a reload is re-delivered once: the reloaded session submits it, and the state no longer holds it', async () => {
  freshModule()
  const before = wire()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null, submitted)
  await started(before, env)
  await (before.hooks['turn.start'] as Handler)(env as never, { turnId: 't1' } as never, next(false) as never)
  offer({ id: 1, text: '#1 is done: Item 1' })
  await settle()
  expect(values.notices).toEqual({ held: [], waiting: [{ id: 1, text: '#1 is done: Item 1' }] })
  freshModule()
  await started(wire(), env)
  await settle()
  expect(submitted).toEqual([{ text: '#1 is done: Item 1' }])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('a held notice stays held across a reload: no turn starts, and the human\'s next prompt carries it once', async () => {
  freshModule()
  const before = wire()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null, submitted)
  await started(before, env)
  await (before.hooks['turn.start'] as Handler)(env as never, { turnId: 't1' } as never, next(false) as never)
  offer({ id: 1, text: '#1 is done: Item 1' })
  await (before.hooks['turn.complete'] as Handler)(env as never, { agentId: undefined, isAborted: true, turnId: 't1' } as never, next(false) as never)
  await settle()
  expect(values.notices).toEqual({ held: [{ id: 1, text: '#1 is done: Item 1' }], waiting: [] })
  freshModule()
  const after = wire()
  await started(after, env)
  await settle()
  expect(submitted).toEqual([])
  const seen: unknown[] = []
  const passed = (async (e: unknown) => {
    seen.push(e)
    return { text: 'hi' }
  }) as unknown as Next
  await (after.hooks['prompt.submit'] as Handler)(env as never, { origin: { kind: 'composer' }, text: 'hi' } as never, passed as never)
  await settle()
  expect(seen).toEqual([{ origin: { kind: 'composer' }, text: 'hi', context: ['#1 is done: Item 1'] }])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('a stored notice whose item the agent has removed is not re-delivered, and the state is cleared', async () => {
  freshModule()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(2, { detail: '' })], [], null, submitted)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: Item 1' }] }
  await started(wire(), env)
  await settle()
  expect(submitted).toEqual([])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('restored notices wait for a turn that is running, and its end submits them together, once', async () => {
  freshModule()
  startTurn()
  const wired = wire()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' }), made(2, { detail: '' })], [], null, submitted)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: a' }, { id: 2, text: '#2 is done: b' }] }
  await started(wired, env)
  await settle()
  expect(submitted).toEqual([])
  await (wired.hooks['turn.complete'] as Handler)(env as never, { agentId: undefined, isAborted: false, turnId: 't1' } as never, next(false) as never)
  await settle()
  expect(submitted).toEqual([{ text: '#1 is done: a\n\n#2 is done: b' }])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('a turn that ends while a reload\'s session.start is still under way does not wipe the notices the reload is owed', async () => {
  freshModule()
  startTurn()
  const wired = wire()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null, submitted)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: a' }] }
  let registered: () => void = () => {}
  const registering = new Promise<void>(done => (registered = done))
  const starting = (wired.hooks['session.start'] as Handler)(
    { ...env, tool: { register: () => registering.then(() => ({ isRegistered: true })) } } as never,
    {} as never,
    next(false) as never,
  )
  await settle()
  await (wired.hooks['turn.complete'] as Handler)(env as never, { agentId: undefined, isAborted: false, turnId: 't1' } as never, next(false) as never)
  await settle()
  registered()
  await starting
  await settle()
  expect(submitted).toEqual([{ text: '#1 is done: a' }])
})

test('a reload whose list read fails while it restores the owed notices still re-offers them, unchecked, and logs why', async () => {
  freshModule()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null, submitted)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: a' }] }
  const logs: string[] = []
  // The undo windows' re-timing reads the list first; the restore's read, the second, fails.
  let listReads = 0
  const get = env.state.get
  const failing = {
    ...env,
    ui: { ...(env as { ui: object }).ui, log: (text: string) => void logs.push(text) },
    state: {
      ...env.state,
      get: async (ref: { key: string }) => {
        if (ref.key === 'list' && ++listReads === 2) throw new Error('list unreadable')
        return get(ref)
      },
    },
  }
  await started(wire(), failing)
  await settle()
  expect(submitted).toEqual([{ text: '#1 is done: a' }])
  expect(logs).toContain('human-plugin: the list could not be read to check the owed notices, so they are re-offered unchecked: Error: list unreadable')
})

test('a restored prompt the engine refuses holds its notices, and the state keeps them for the next human prompt', async () => {
  freshModule()
  const refused: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: Item 1' }] }
  const refusing = {
    ...env,
    prompt: {
      submit: async (e: unknown) => {
        refused.push(e)
        return { drop: 'no' }
      },
    },
  }
  await started(wire(), refusing)
  await settle()
  expect(refused).toEqual([{ text: '#1 is done: Item 1' }])
  expect(values.notices).toEqual({ held: [{ id: 1, text: '#1 is done: Item 1' }], waiting: [] })
})

test('notices an older release stored as one list are re-offered as waiting ones', async () => {
  freshModule()
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null, submitted)
  values.notices = [{ id: 1, text: '#1 is done: Item 1' }]
  await started(wire(), env)
  await settle()
  expect(submitted).toEqual([{ text: '#1 is done: Item 1' }])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('a failed write of the notices is logged, not dropped', async () => {
  freshModule()
  const logs: string[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: Item 1' }] }
  const failing = {
    ...env,
    state: {
      ...env.state,
      set: async () => {
        throw new Error('state full')
      },
    },
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
  }
  await started(wire(), failing)
  await settle()
  expect(logs).toEqual(['human-plugin: the notices were not saved: Error: state full'])
})

test('a session end drops the stored notices with the module\'s own', async () => {
  freshModule()
  startTurn()
  const wired = wire()
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  values.notices = { held: [], waiting: [] }
  await started(wired, env)
  offer({ id: 1, text: '#1 is done: Item 1' })
  await settle()
  expect(values.notices).toEqual({ held: [], waiting: [{ id: 1, text: '#1 is done: Item 1' }] })
  await (wired.hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  await settle()
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

// The `/asks` command: registered at session start, answered by its command hook, and waiting for a rebuild as the tool does.
const asksOf = (hooks: Record<string, Handler>): Handler => hooks['command.run {"command":"asks"}'] as Handler
const claudeTodoOf = (hooks: Record<string, Handler>): Handler => hooks['command.run {"command":"claude-todo"}'] as Handler

test('/asks is registered at session start with the flag that runs it mid-turn, under the name its hook\'s matcher spells out', async () => {
  freshModule()
  const wired = wire()
  const { env } = memEnv([], [], null)
  const registered: Record<string, unknown>[] = []
  await started(wired, { ...env, command: { register: async (spec: Record<string, unknown>) => void registered.push(spec) } })
  expect(registered).toContainEqual({ name: 'asks', description: DESCRIPTION, argumentHint: ARG_HINT, immediate: true })
  expect(typeof asksOf(wired.hooks)).toBe('function')
})

test('/claude-todo is registered at session start with the flag that runs it mid-turn and no argument hint, under the name its hook\'s matcher spells out', async () => {
  freshModule()
  const wired = wire()
  const { env } = memEnv([], [], null)
  const registered: Record<string, unknown>[] = []
  await started(wired, { ...env, command: { register: async (spec: Record<string, unknown>) => void registered.push(spec) } })
  expect(registered).toEqual([
    { name: 'asks', description: DESCRIPTION, argumentHint: ARG_HINT, immediate: true },
    { name: 'claude-todo', description: CLAUDE_DESCRIPTION, immediate: true },
  ])
  expect(typeof claudeTodoOf(wired.hooks)).toBe('function')
})

test('a failed /asks registration is logged, and the rest of the session start still delivers an owed notice', async () => {
  freshModule()
  const logs: string[] = []
  const submitted: unknown[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null, submitted)
  values.notices = { held: [], waiting: [{ id: 1, text: '#1 is done: Item 1' }] }
  const failing = {
    ...env,
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
    command: {
      register: async () => {
        throw new Error('no room for the command')
      },
    },
  }
  await started(wire(), failing)
  await settle()
  expect(logs).toEqual([
    'human-plugin: the /asks command was not registered: Error: no room for the command',
    'human-plugin: the /claude-todo command was not registered: Error: no room for the command',
  ])
  expect(submitted).toEqual([{ text: '#1 is done: Item 1' }])
})

test('a failed registration of one command leaves the other registered: /asks failing keeps /claude-todo, and the reverse', async () => {
  for (const failing of ['asks', 'claude-todo']) {
    freshModule()
    const logs: string[] = []
    const registered: string[] = []
    const { env } = memEnv([], [], null)
    await started(wire(), {
      ...env,
      ui: { ...env.ui, log: (text: string) => void logs.push(text) },
      command: {
        register: async (spec: { name: string }) => {
          if (spec.name === failing) throw new Error('no room for the command')
          registered.push(spec.name)
        },
      },
    })
    await settle()
    expect(registered).toEqual([failing === 'asks' ? 'claude-todo' : 'asks'])
    expect(logs).toEqual([`human-plugin: the /${failing} command was not registered: Error: no room for the command`])
  }
})

test('a failed /asks registration leaves an undo window to be restored at session start: its tick sends the answer once the window has run', async () => {
  freshModule()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '', state: 'done-waiting', pressedAt: 1000 })], [], null, submitted, timers)
  const failing = {
    ...env,
    command: {
      register: async () => {
        throw new Error('no room for the command')
      },
    },
  }
  await started(wire(), failing)
  await tickAt(timers, clock, 3999)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 4000)
  expect(submitted.length).toBe(1)
})

test('/asks prints the list through its command, /asks <n> prints that item whole, and a number no item has, or a usage, answers so', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { title: 'Pick a db', blocking: true, detail: 'postgres or sqlite' }), made(2, { detail: '' })], [], null)
  const ask = asksOf(hooks)
  expect(await ask(env as never, { args: '' } as never, next(false) as never)).toEqual({ text: '  #1 blocking: Pick a db\n  #2 non-blocking: Item 2' })
  expect(await ask(env as never, { args: '1' } as never, next(false) as never)).toEqual({
    text: '  #1 blocking: Pick a db\n  brief:\n  postgres or sqlite\n  /asks 1 done\n  /asks 1 reply <text>',
  })
  expect(await ask(env as never, { args: ' 001 ' } as never, next(false) as never)).toEqual({
    text: '  #1 blocking: Pick a db\n  brief:\n  postgres or sqlite\n  /asks 1 done\n  /asks 1 reply <text>',
  })
  expect(await ask(env as never, { args: '3' } as never, next(false) as never)).toEqual({ text: '  There is no such item.' })
  expect(await ask(env as never, { args: '3.5' } as never, next(false) as never)).toEqual({ text: USAGE })
})

test('/asks <n> clears the unread mark of the one item it shows, and /asks alone clears none', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { unread: true }), made(2, { unread: true })], [], null)
  const ask = asksOf(hooks)
  await ask(env as never, { args: '' } as never, next(false) as never)
  const both = JSON.stringify(await band(hooks, env))
  expect(both).toContain('• #1 ')
  expect(both).toContain('• #2 ')
  await ask(env as never, { args: '2' } as never, next(false) as never)
  const afterShow = JSON.stringify(await band(hooks, env))
  expect(afterShow).toContain('• #1 ')
  expect(afterShow).not.toContain('• #2 ')
})

test('/asks <n> keeps the unread mark an agent turn raised after it read the item: the turn is not in the text the read printed', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { state: 'done-pending', answer: 'Use sqlite' })], [], null)
  // The agent appends a turn to #1 between /asks's read of the list and its clear of the mark: the first read returns the list as it was.
  const getState = env.state.get
  let appended = false
  env.state.get = async ref => {
    const got = await getState(ref)
    if (ref.key === 'list' && !appended) {
      appended = true
      const out = act(normalizeStore(values.list), { action: 'append', id: 1, text: 'A later turn.' }, { agent: null, now: 0 })
      if ('store' in out) values.list = out.store
    }
    return got
  }
  expect(await asksOf(hooks)(env as never, { args: '1' } as never, next(false) as never)).toEqual({
    text: '  #1 non-blocking: Item 1\n  brief:\n  Brief 1.\n  thread:\n  you:\n  Use sqlite',
  })
  expect(values.list).toMatchObject({
    items: [{ state: 'open', unread: true, thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'A later turn.' }] }],
  })
  expect(JSON.stringify(await band(hooks, env))).toContain('• #1 ')
})

// A host whose list rebuild waits for `finish`: the transcript the rebuild reads holds one item, 'Rebuilt ask'.
const rebuilding = (env: object, extra: Record<string, unknown>[] = []) => {
  let finish = (): void => {}
  const gate = new Promise<void>(resolve => {
    finish = resolve
  })
  const transcript = [
    { type: 'assistant', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: TOOL, input: { action: 'add', title: 'Rebuilt ask' } }] } },
    { type: 'user', timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'added #1' }] } },
    ...extra,
  ]
    .map(row => `${JSON.stringify(row)}\n`)
    .join('')
  // The transcript's `cat` holds its output until the test lets it finish.
  const child = {
    async *[Symbol.asyncIterator]() {
      await gate
      yield { stream: 'stdout', text: transcript }
    },
    result: gate.then(() => ({ code: 0 })),
  }
  return { host: { ...env, fs: { exists: async () => true, list: async () => [] }, process: { spawn: () => child } }, finish }
}

test('/asks answers that the list is being rebuilt while the rebuild runs past its wait, and lists the rebuilt items once it has finished', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  const ask = asksOf(wired.hooks)
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const waiting = ask(host as never, { args: '' } as never, next(false) as never)
    await tickAt(timers, clock, 5000)
    expect(await waiting).toEqual({ text: REBUILDING })
    finish()
    expect(await ask(host as never, { args: '' } as never, next(false) as never)).toEqual({ text: '  #1 non-blocking: Rebuilt ask' })
  } finally {
    resetRebuild()
  }
})

test('a /asks whose list read throws answers one error line, logs the failure, and writes no list', async () => {
  freshModule()
  const { hooks, catches } = wire()
  const logs: string[] = []
  const submits: unknown[] = []
  const writes: unknown[] = []
  let thrown: unknown = null
  try {
    await asksOf(hooks)(broken(logs, submits, {}, writes) as never, { args: '' } as never, next(false) as never)
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('list unreadable')
  const answer = await (catches['command.run {"command":"asks"}'] as Handler)(broken(logs, submits, {}, writes) as never, { args: '' } as never, next(false) as never)
  expect(answer).toEqual({ text: FAILED })
  expect(logs).toEqual(['human-plugin: the command.run hook throw: list unreadable'])
  expect(writes).toEqual([])
})

test('/asks <n> still returns the item when its unread mark cannot be cleared: the failed write is logged, and the mark stays', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { unread: true })], [], null)
  const logs: string[] = []
  // The write to the list is refused; the reads and every other write are memEnv's.
  const refusing = {
    ...env,
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
    state: {
      ...env.state,
      set: async (ref: { key: string }, value: unknown) => {
        if (ref.key === 'list') throw new Error('list write refused')
        return env.state.set(ref, value)
      },
    },
  }
  expect(await asksOf(hooks)(refusing as never, { args: '1' } as never, next(false) as never)).toEqual({
    text: '  #1 non-blocking: Item 1\n  brief:\n  Brief 1.\n  /asks 1 done\n  /asks 1 reply <text>',
  })
  expect(logs).toEqual(['human-plugin: the unread mark of #1 was not cleared: Error: list write refused'])
  expect(values.list).toMatchObject({ items: [{ id: 1, unread: true }] })
})

// An answer form's write, called as the hook calls it: the undo window it leaves, what the ticker sends, and what happens after the write.
test('an answer form writes its window in the write and submits nothing there: the first tick after it submits the notice', async () => {
  reset()
  stopTicker()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  clock.now = 1000
  expect(await pressAnswer(env as never, '1', { kind: 'done' }, 3000)).toMatchObject({ kind: 'applied', answer: 'done' })
  // The window counts from one window back, so it is due at the write: the list shows it waiting, and the ticker is running for it.
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting', pressedAt: -2000 }] })
  expect(timers.length).toBe(1)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 999)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted.length).toBe(1)
  expect((submitted[0] as { text: string }).text.startsWith('#1 is done: Item 1\nThe human marked it done.')).toBe(true)
})

test('an answer form never ends its window inside the write, whatever the window: a zero window waits for the first tick as well', async () => {
  reset()
  stopTicker()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  expect(await pressAnswer(env as never, '1', { kind: 'done' }, 0)).toMatchObject({ kind: 'applied' })
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 0)
  expect(submitted.length).toBe(1)
})

test('a refused answer form, or a number no item has, changes no item and starts no tick, since no window waits', async () => {
  reset()
  stopTicker()
  const timers: Timer[] = []
  const { env, values } = memEnv([made(1, { detail: '', state: 'done-pending' })], [], null, [], timers)
  expect(await pressAnswer(env as never, '1', { kind: 'done' }, 3000)).toMatchObject({ kind: 'sent' })
  expect(await pressAnswer(env as never, '9', { kind: 'done' }, 3000)).toMatchObject({ kind: 'missing' })
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-pending' }] })
  expect(timers.length).toBe(0)
})

test('a failure after an answer form\'s write is logged and contained: the answer stands, and its outcome is returned', async () => {
  reset()
  stopTicker()
  const logs: string[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  const failing = { ...env, clock: { ...env.clock, every: () => { throw new Error('no clock') } }, ui: { ...env.ui, log: (text: string) => void logs.push(text) } }
  expect(await pressAnswer(failing as never, '1', { kind: 'done' }, 3000)).toMatchObject({ kind: 'applied', answer: 'done' })
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting' }] })
  expect(logs.filter(line => line.includes('no clock'))).toEqual(['human-plugin: /asks #1 was written; a step after the write failed: Error: no clock'])
})

test('a send that fails once a zero undo window has ended a press is logged as a step after the write, and the press stands', async () => {
  reset()
  stopTicker()
  const logs: string[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  const refused = { ...env, prompt: { submit: async () => { throw new Error('prompt refused') } }, ui: { ...env.ui, log: (text: string) => void logs.push(text) } }
  await pressDone(refused as never, 1, null, 0)
  expect(logs.filter(line => line.includes('prompt refused'))).toEqual(['human-plugin: done press #1 was written; a step after the write failed: Error: prompt refused'])
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-pending' }] })
})

test('a failure before an answer form\'s write rejects, and the list is not written', async () => {
  reset()
  stopTicker()
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  const unreadable = { ...env, state: { ...env.state, get: async () => { throw new Error('list unreadable') } } }
  let thrown: unknown = null
  try {
    await pressAnswer(unreadable as never, '1', { kind: 'done' }, 3000)
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('list unreadable')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open' }] })
})

// The answer forms through `/asks`: the command's write, the ticker's notice, and the pane's controls, which send the same answers.
type Control = (hooks: Record<string, Handler>, env: unknown) => Promise<void>

// The text `/asks` answers with, as its hook returns it.
const askText = async (hooks: Record<string, Handler>, env: object, args: string): Promise<string> =>
  ((await asksOf(hooks)(env as never, { args } as never, next(false) as never)) as { text: string }).text

// An item answered by `/asks <n> <form>` at clock 1000: the text it answers, the item once the first tick at 1000 has run, and the notices sent.
const answeredByCommand = async (item: object, args: string) => {
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([{ ...item }], [], 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  clock.now = 1000
  const text = await askText(hooks, env, args)
  await tickAt(timers, clock, 1000)
  return { text, item: (values.list as { items: Item[] }).items[0] as Item, submitted }
}

// The same answer made by the pane's control that sends it, at clock 1000: the item once the window that press opened has ended, by the tick at 4000.
const answeredByControl = async (item: object, control: Control) => {
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([{ ...item }], [], 1, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  clock.now = 1000
  await control(hooks, env)
  await settle()
  await tickAt(timers, clock, 4000)
  return { item: (values.list as { items: Item[] }).items[0] as Item, submitted }
}

test('each answer form ends as the pane control that sends the same answer does: the same item once its window has ended and the same notice, and only the unread mark differs', async () => {
  const options = [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: false },
    { label: 'Use mysql', description: '', recommended: true },
  ]
  const cases: [object, string, string, Control][] = [
    [made(1, { detail: '', unread: true, doneLabel: 'Ship it' }), '1 done', '  answered #1 with Ship it', async (hooks, env) => {
      findButton(await band(hooks, env), 'done-1')?.onPress()
    }],
    [made(1, { detail: '', unread: true }), '1 DONE', '  answered #1 with done', async (hooks, env) => {
      findButton(await band(hooks, env), 'done-1')?.onPress()
    }],
    [made(1, { detail: '', unread: true, yesno: true }), '1 yes', '  answered #1 with yes', async (hooks, env) => {
      findButton(await band(hooks, env), 'yes-1')?.onPress()
    }],
    [made(1, { detail: '', unread: true, yesno: true }), '1 No', '  answered #1 with no', async (hooks, env) => {
      findButton(await band(hooks, env), 'no-1')?.onPress()
    }],
    [made(1, { detail: '', unread: true, options }), '1 2', '  answered #1 with Use sqlite', async (hooks, env) => {
      findButton(await paneTree(hooks, env), 'answer-1-1')?.onPress()
    }],
    [made(1, { detail: '', unread: true }), '1 reply Use  sqlite', '  answered #1 with Use  sqlite', async (hooks, env) => {
      findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use  sqlite', {})
    }],
  ]
  for (const [item, args, confirmation, control] of cases) {
    const byCommand = await answeredByCommand(item, args)
    const byControl = await answeredByControl(item, control)
    expect(byCommand.text).toBe(confirmation)
    expect(byCommand.submitted.length).toBe(1)
    expect(byCommand.submitted).toEqual(byControl.submitted)
    const { unread: unreadByCommand, ...commandItem } = byCommand.item
    const { unread: unreadByControl, ...controlItem } = byControl.item
    expect(commandItem).toEqual(controlItem)
    expect([unreadByCommand, unreadByControl]).toEqual([false, true])
  }
})

test('an answer form writes its undo window in the command, and submits nothing there: the first tick after the write submits the notice', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  clock.now = 1000
  expect(await askText(hooks, env, '1 done')).toBe('  answered #1 with done')
  // The window counts from one window back, so the write leaves it due: the list shows it waiting, and the ticker runs for it.
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting', pressedAt: -2000 }] })
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 999)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted.length).toBe(1)
  expect((submitted[0] as { text: string }).text.startsWith('#1 is done: Item 1\nThe human marked it done.')).toBe(true)
})

test('a zero undo window does not end an answer form inside its write: the first tick ends it', async () => {
  reset()
  stopTicker()
  const { hooks } = wire((on: never) => wireHooks(on, 0))
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  clock.now = 1000
  expect(await askText(hooks, env, '1 done')).toBe('  answered #1 with done')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting' }] })
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted.length).toBe(1)
})

test('a reload after an answer form\'s write, before its first tick, delivers the notice at the first tick after the reload', async () => {
  reset()
  stopTicker()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  clock.now = 1000
  expect(await askText(wire().hooks, env, '1 done')).toBe('  answered #1 with done')
  // The reload ends the old module's ticker, and the new session's start re-arms the window that is still waiting.
  stopTicker()
  freshModule()
  await started(wire(), env)
  await tickAt(timers, clock, 999)
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted.length).toBe(1)
})

test('with a turn running, an answer form\'s notice is queued for the turn\'s end, and submitted there once', async () => {
  reset()
  stopTicker()
  startTurn()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  clock.now = 1000
  expect(await askText(hooks, env, '1 done')).toBe('  answered #1 with done')
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  await (hooks['turn.complete'] as Handler)(env as never, { agentId: undefined, isAborted: false, turnId: 't1' } as never, next(false) as never)
  await settle()
  expect(submitted.length).toBe(1)
  expect((submitted[0] as { text: string }).text.startsWith('#1 is done: Item 1\nThe human marked it done.')).toBe(true)
})

test('a terminal undo press on an item the command has just answered cancels the answer: nothing is sent, and the item is open', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: '' })], [], 1, submitted, timers)
  clock.now = 1000
  expect(await askText(hooks, env, '1 done')).toBe('  answered #1 with done')
  // The undo button the band draws for the window the command opened: a press on it is the terminal's undo.
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open', pressedAt: null, answer: null }] })
})

test('an item in its terminal undo window stays in it: /asks <n> done answers that it is not open, and the window still sends the press once', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: '' })], [], 1, submitted, timers)
  clock.now = 1000
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  expect(await askText(hooks, env, '1 done')).toBe('  #1 is not open: its undo window is running.')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting', pressedAt: 1000 }] })
  await tickAt(timers, clock, 4000)
  expect(submitted.length).toBe(1)
  expect((submitted[0] as { text: string }).text.startsWith('#1 is done: Item 1\nThe human marked it done.')).toBe(true)
})

test('a form on a sent item answers that it is sent and changes nothing, unread or not', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { detail: '', state: 'done-pending', answer: 'yes', yesno: true, unread: true })], [], null)
  for (const args of ['1 done', '1 yes', '1 reply hello', '1 1']) expect(await askText(hooks, env, args)).toBe('  #1 is already sent.')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-pending', answer: 'yes', unread: true }] })
})

test('a form the item\'s kind does not take answers the forms it takes, and changes nothing; so does an option number out of range, and a number no item has', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const options = [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: false },
  ]
  const { env, values } = memEnv([made(1, { detail: '', options }), made(2, { detail: '' })], [], null)
  const takes = '  #1 takes these answers:\n  /asks 1 1-2\n  /asks 1 reply <text>'
  expect(await askText(hooks, env, '1 done')).toBe(takes)
  for (const args of ['1 0', '1 3', '1 99999999999999999999']) expect(await askText(hooks, env, args)).toBe(takes)
  expect(await askText(hooks, env, '2 yes')).toBe('  #2 takes these answers:\n  /asks 2 done\n  /asks 2 reply <text>')
  expect(await askText(hooks, env, '9 done')).toBe('  There is no such item.')
  expect(await askText(hooks, env, '99999999999999999999 done')).toBe('  There is no such item.')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open', answer: null }, { id: 2, state: 'open', answer: null }] })
})

test('an answer form while the list is being rebuilt answers the rebuilding line and changes nothing; a malformed one answers the usage at once', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const waiting = askText(wired.hooks, host, '1 done')
    await tickAt(timers, clock, 5000)
    expect(await waiting).toBe(REBUILDING)
    expect(await askText(wired.hooks, host, '1 x')).toBe(USAGE)
    finish()
    expect(await askText(wired.hooks, host, '1')).toBe('  #1 non-blocking: Rebuilt ask\n  /asks 1 done\n  /asks 1 reply <text>')
  } finally {
    resetRebuild()
  }
})

test('a malformed answer answers the usage at once, whether or not its item exists, and reads no list', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const logs: string[] = []
  const writes: unknown[] = []
  const nbsp = String.fromCharCode(0xa0)
  for (const args of ['1 reply', `1 reply ${nbsp}`, '1 done x', '1 x', '1 -1', '9 reply']) {
    expect(await askText(hooks, broken(logs, [], {}, writes), args)).toBe(USAGE)
  }
  expect(writes).toEqual([])
  expect(logs).toEqual([])
})

test('an answer form whose list read throws answers one error line, logs the failure, and writes no list', async () => {
  reset()
  stopTicker()
  const { hooks, catches } = wire()
  const logs: string[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  const unreadable = { ...env, state: { ...env.state, get: async () => { throw new Error('list unreadable') } }, ui: { ...env.ui, log: (text: string) => void logs.push(text) } }
  let thrown: unknown = null
  try {
    await asksOf(hooks)(unreadable as never, { args: '1 done' } as never, next(false) as never)
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('list unreadable')
  expect(await (catches['command.run {"command":"asks"}'] as Handler)(unreadable as never, { args: '1 done' } as never, next(false) as never)).toEqual({ text: FAILED })
  expect(logs).toEqual(['human-plugin: the command.run hook throw: list unreadable'])
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open' }] })
})

test('a failure after an answer form\'s write leaves the item answered, and the command answers its confirmation', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const logs: string[] = []
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  const failing = { ...env, clock: { ...env.clock, every: () => { throw new Error('no clock') } }, ui: { ...env.ui, log: (text: string) => void logs.push(text) } }
  expect(await askText(hooks, failing, '1 done')).toBe('  answered #1 with done')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting' }] })
  expect(logs.filter(line => line.includes('no clock')).length).toBe(1)
})

test('with the pane open on the item, a phone reply moves the pane on to the next open item once its window has ended, as a reply from the pane does', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: '' }), made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  clock.now = 1000
  expect(await askText(hooks, env, '1 reply Use sqlite')).toBe('  answered #1 with Use sqlite')
  await tickAt(timers, clock, 1000)
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#2 non-blocking, open: Item 2')
  expect(shown).not.toContain('Item 1')
})

test('a reply sent by /asks leaves a human turn with its words on the item once the agent reopens it, under the reply notice', async () => {
  reset()
  stopTicker()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = replyEnv([made(1, { detail: 'Brief 1.' })], [], null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  clock.now = 1000
  await askText(hooks, env, '1 reply Use sqlite')
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([{ text: '#1 is done: Item 1\nThe human replied on #1: Use sqlite\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #1; the item is then open for their next reply. Your own follow-up work never stays on the list.' }])
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'done-pending', replied: true, answer: 'Use sqlite' })
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 1, text: 'more' } as never, next(false) as never)
  await settle()
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({
    state: 'open', answer: null, replied: false, thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'more' }],
  })
})

test('every form an open item\'s foot names is accepted by the command: a range names each of its numbers, and a reply\'s placeholder is given sample text', async () => {
  const options = [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: false },
  ]
  // The arguments that answer a foot's word: a range is each of its numbers, and a reply's placeholder is given sample text.
  const argsOf = (word: string): string[] =>
    word.startsWith('1-') ? Array.from({ length: Number(word.slice(2)) }, (_, k) => `1 ${k + 1}`) : [`1 ${word.replace('<text>', 'text')}`]
  for (const item of [made(1, { detail: '' }), made(1, { detail: '', yesno: true }), made(1, { detail: '', options })]) {
    reset()
    stopTicker()
    const { hooks } = wire()
    const { env } = memEnv([{ ...item }], [], null)
    const words = (await askText(hooks, env, '1')).split('\n').filter(line => line.startsWith('  /asks 1 ')).map(line => line.slice('  /asks 1 '.length))
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) {
      for (const args of argsOf(word)) {
        const { env: fresh } = memEnv([{ ...item }], [], null)
        expect(await askText(hooks, fresh, args)).toMatch(/^  answered #1 with /)
      }
    }
  }
})

// The Claude TODO list's hooks, filtered on the tool: each is kept under its filter, as the human tool's are under their own events.
const todoHook = (hooks: Record<string, Handler>, event: string): Handler => hooks[`${event} ${JSON.stringify({ tool: TODO_TOOL })}`] as Handler
const runTodo = (hooks: Record<string, Handler>, env: unknown, input: Record<string, unknown>) =>
  todoHook(hooks, 'tool.call')(env as never, { tool: TODO_TOOL, ...input } as never, next(false) as never)
const entry = (title: string, state: string, eta = NO_ETA) => ({ title, state, eta })

test('session.start registers both tools, neither deferred: the human list\'s and the Claude list\'s', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  const registered: unknown[] = []
  await (hooks['session.start'] as Handler)({ ...env, tool: { register: async (spec: unknown) => void registered.push(spec) } } as never, {} as never, next(false) as never)
  expect(registered).toEqual([TOOL_SPEC, TODO_SPEC])
  expect(TODO_SPEC.isDeferred).toBe(false)
})

test('the permission check allows the Claude list\'s tool without asking the person', async () => {
  const { hooks } = wire()
  expect(await todoHook(hooks, 'tool.check')({} as never, { tool: TODO_TOOL, input: {} } as never, next(false) as never)).toEqual({ decision: 'allow' })
})

test('a write stores the queued and in-flight entries in the order given and none of the done ones, and answers with the counts', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  const entries = [entry('Queued first', 'queued'), entry('Finished', 'done'), entry('Running', 'in_flight'), entry('Queued last', 'queued')]
  expect(await runTodo(hooks, env, { entries })).toEqual({
    result: ['Claude TODO: 1 in flight, 2 queued', '- queued: Queued first (ETA: no ETA)', '- in_flight: Running (ETA: no ETA)', '- queued: Queued last (ETA: no ETA)'].join('\n'),
  })
  expect(values.todo).toEqual([entry('Queued first', 'queued'), entry('Running', 'in_flight'), entry('Queued last', 'queued')])
})

test('a call with an empty array empties the list, and one with no array leaves it as it is and lists the entries with their states in written order', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Queued first', 'queued'), entry('Running', 'in_flight')] })
  const before = values.todo
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Claude TODO: 1 in flight, 1 queued\n- queued: Queued first (ETA: no ETA)\n- in_flight: Running (ETA: no ETA)' })
  expect(values.todo).toEqual(before)
  expect(await runTodo(hooks, env, { entries: [] })).toEqual({ result: 'Claude TODO: 0 in flight, 0 queued' })
  expect(values.todo).toEqual([])
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Claude TODO: 0 in flight, 0 queued' })
})

test('a title of 81 units, a title with a line break, an empty title and an unknown state are each refused with a reason, and the list is unchanged', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Keep me', 'in_flight')] })
  const kept = [entry('Keep me', 'in_flight')]
  for (const [bad, reason] of [
    [entry('x'.repeat(81), 'queued'), '80'],
    [entry('two\nlines', 'queued'), 'one line'],
    [entry('  ', 'queued'), 'empty'],
    [entry('Fine', 'paused'), 'queued, in_flight or done'],
  ] as const) {
    const out = (await runTodo(hooks, env, { entries: [entry('Would replace', 'queued'), bad] })) as { deny: string }
    expect(out.deny).toContain('claude_todo: entry 2')
    expect(out.deny).toContain(reason)
    expect(values.todo).toEqual(kept)
  }
})

test('a subagent\'s call, a write or a read, is refused with the reason that only the main agent keeps the list, and changes nothing', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Keep me', 'in_flight')] })
  for (const input of [{ entries: [entry('Sub plan', 'queued')] }, { entries: [] }, {}]) {
    expect(await runTodo(hooks, env, { ...input, agentId: 'sub-1' })).toEqual({ deny: 'claude_todo: only the main agent keeps the Claude TODO list' })
  }
  expect(values.todo).toEqual([entry('Keep me', 'in_flight')])
})

test('a write to the Claude list leaves the human list as it was, and a human tool call leaves the Claude list as it was', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Build', 'in_flight')] })
  expect(values.list).toEqual({ items: [], next: 1 })
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'add', title: 'Pick a db' } as never, next(false) as never)
  expect(values.todo).toEqual([entry('Build', 'in_flight')])
})

test('a throw in the Claude list\'s tool is answered with a refusal that changes nothing', async () => {
  const { catches } = wire()
  const answered = await (catches[`tool.call ${JSON.stringify({ tool: TODO_TOOL })}`] as Handler)({} as never, { tool: TODO_TOOL } as never, next(false) as never)
  expect(answered).toEqual({ deny: 'claude_todo: the mod failed to answer the call' })
  const passed = { tool: TODO_TOOL }
  expect(await (catches[`tool.call ${JSON.stringify({ tool: TODO_TOOL })}`] as Handler)({} as never, passed as never, next(true) as never)).toEqual({ passed })
})

test('a call to the Claude list\'s tool is drawn as one line, its result row empty; the human tool\'s and another tool\'s rows are as before', async () => {
  const { hooks } = wire()
  const $ = { ui: { resolve: () => table } }
  const callRow = hooks['ui.render {"component":"ToolUse"}'] as Handler
  const resultRow = hooks['ui.render {"component":"ToolResult"}'] as Handler
  const line = (props: object) => callRow($ as never, { props } as never, next(false) as never)
  const dim = (text: string) => ({ type: 'Text', dimColor: true, wrap: 'truncate-end', children: [text] })
  const entries = [entry('Build', 'in_flight'), entry('Ship', 'queued')]
  expect(await line({ tool: TODO_TOOL, input: { entries }, isRunning: true, isErrored: false })).toEqual(dim('human-plugin: writing the Claude TODO list…'))
  expect(await line({ tool: TODO_TOOL, input: {}, isRunning: true, isErrored: false })).toEqual(dim('human-plugin: reading the Claude TODO list…'))
  expect(await line({ tool: TODO_TOOL, input: { entries }, output: 'Claude TODO: 1 in flight, 1 queued', isRunning: false, isErrored: false })).toEqual(dim('human-plugin: Claude TODO 1 in flight, 1 queued'))
  expect(await line({ tool: TODO_TOOL, input: { entries: [entry('', 'queued')] }, output: 'x', isRunning: false, isErrored: true })).toEqual(dim('human-plugin: entry 1: the title is empty'))
  expect(await line({ tool: TODO_TOOL, input: { entries }, output: 'claude_todo: only the main agent keeps the Claude TODO list', isRunning: false, isErrored: true })).toEqual(dim('human-plugin: claude_todo: only the main agent keeps the Claude TODO list'))
  expect(await line({ tool: TODO_TOOL, input: { entries }, output: '', isRunning: false, isErrored: true })).toEqual(dim('human-plugin: failed'))
  expect(await resultRow($ as never, { props: { tool: TODO_TOOL, output: 'Claude TODO: 1 in flight, 1 queued', isErrored: false } } as never, next(false) as never)).toEqual({ type: 'Box', display: 'none' })
  expect(await line({ tool: TOOL, input: { action: 'remove', id: 2 }, output: 'removed #2', isRunning: false, isErrored: false })).toEqual(dim('human-plugin: removed #2'))
  const other = { props: { tool: 'Bash', input: { command: 'ls' }, output: undefined, isRunning: false, isErrored: false } }
  expect(await callRow($ as never, other as never, next(false) as never)).toEqual({ passed: other })
  const otherResult = { props: { tool: 'Bash', output: 'x', isErrored: false } }
  expect(await resultRow($ as never, otherResult as never, next(false) as never)).toEqual({ passed: otherResult })
})

test('a /clear leaves the Claude list empty, and a session end that is not a /clear leaves it', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Build', 'in_flight')] })
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  expect(values.todo).toEqual([entry('Build', 'in_flight')])
  await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  expect(values.todo).toEqual([])
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Claude TODO: 0 in flight, 0 queued' })
})

test('a /clear whose session.end hook fails part-way still empties the Claude list', async () => {
  reset()
  const { catches } = wire()
  const writes: unknown[] = []
  await (catches['session.end'] as Handler)(broken([], [], { next: 3 }, writes) as never, { reason: 'clear' } as never, next(false) as never)
  expect(writes).toContainEqual([])
})

test('two writes whose first one is slower apply in the order the calls arrived: the later call\'s list is the one left, and a read after them sees it', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  // The first write to land waits for the test; the second call is made while it waits.
  const gate: { release: () => void } = { release: () => undefined }
  const held = new Promise<void>(resolve => (gate.release = resolve))
  let writes = 0
  const slow = {
    ...env,
    state: {
      ...env.state,
      set: async (ref: { key: string }, value: unknown) => {
        if (++writes === 1) await held
        return env.state.set(ref, value)
      },
    },
  }
  const first = runTodo(hooks, slow, { entries: [entry('First', 'queued')] })
  const second = runTodo(hooks, slow, { entries: [entry('Second', 'in_flight')] })
  const read = runTodo(hooks, slow, {})
  await settle()
  gate.release()
  expect(await first).toEqual({ result: 'Claude TODO: 0 in flight, 1 queued\n- queued: First (ETA: no ETA)' })
  expect(await second).toEqual({ result: 'Claude TODO: 1 in flight, 0 queued\n- in_flight: Second (ETA: no ETA)' })
  expect(await read).toEqual({ result: 'Claude TODO: 1 in flight, 0 queued\n- in_flight: Second (ETA: no ETA)' })
  expect(values.todo).toEqual([entry('Second', 'in_flight')])
})

// The `/claude-todo` command: the Claude TODO list printed as text, registered to run mid-turn, waiting for a rebuild as `/asks` does.
const claudeTodo = (hooks: Record<string, Handler>, env: unknown, args = '') => claudeTodoOf(hooks)(env as never, { args } as never, next(false) as never)

test('/claude-todo prints the Claude list the tool keeps: the in-flight items, then the queued ones, each in written order', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Queued first', 'queued'), entry('Running', 'in_flight'), entry('Queued last', 'queued')] })
  expect(await claudeTodo(hooks, env)).toEqual({
    text: '  Claude TODO: 1 in flight, 2 queued\n  in flight:\n    ◐ Running · no ETA\n  queued:\n    ○ Queued first · no ETA\n    ○ Queued last · no ETA',
  })
  await runTodo(hooks, env, { entries: [] })
  expect(await claudeTodo(hooks, env)).toEqual({ text: '  The Claude TODO list is empty.' })
})

test('/claude-todo with an argument prints its usage, reads no list and writes none', async () => {
  freshModule()
  const { hooks } = wire()
  const writes: unknown[] = []
  expect(await claudeTodo(hooks, broken([], [], {}, writes), 'x')).toEqual({ text: CLAUDE_USAGE })
  expect(await claudeTodo(hooks, broken([], [], {}, writes), ' 1 ')).toEqual({ text: CLAUDE_USAGE })
  expect(writes).toEqual([])
})

// A transcript holding one Claude TODO write, for a rebuild that gives the list its step 'Rebuilt step'.
const REBUILT_STEP = [
  {
    type: 'assistant',
    timestamp: '2026-10-20T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: TODO_TOOL, input: { entries: [entry('Rebuilt step', 'in_flight')] } }] },
  },
  {
    type: 'user',
    timestamp: '2026-10-20T10:00:03.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w', content: 'Claude TODO: 1 in flight, 0 queued' }] },
  },
]
const REBUILT_TEXT = '  Claude TODO: 1 in flight, 0 queued\n  in flight:\n    ◐ Rebuilt step · no ETA'

test('/claude-todo prints the rebuilt list once a rebuild has finished, and its rebuilding line while the rebuild runs past its wait', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env, REBUILT_STEP)
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const waiting = claudeTodo(wired.hooks, host)
    await tickAt(timers, clock, 5000)
    expect(await waiting).toEqual({ text: CLAUDE_REBUILDING })
    finish()
    expect(await claudeTodo(wired.hooks, host)).toEqual({ text: REBUILT_TEXT })
  } finally {
    resetRebuild()
  }
})

test('a /claude-todo run during a rebuild that ends inside its wait prints the rebuilt list, not its rebuilding line', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env, REBUILT_STEP)
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const waiting = claudeTodo(wired.hooks, host)
    await settle()
    finish()
    expect(await waiting).toEqual({ text: REBUILT_TEXT })
  } finally {
    resetRebuild()
  }
})

test('a /claude-todo whose list read throws answers its failure line, logs the failure, and writes no list', async () => {
  freshModule()
  const { hooks, catches } = wire()
  const logs: string[] = []
  const writes: unknown[] = []
  let thrown: unknown = null
  try {
    await claudeTodoOf(hooks)(broken(logs, [], {}, writes) as never, { args: '' } as never, next(false) as never)
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('list unreadable')
  const handler = catches['command.run {"command":"claude-todo"}'] as Handler
  expect(await handler(broken(logs, [], {}, writes) as never, { args: '' } as never, next(false) as never)).toEqual({ text: CLAUDE_FAILED })
  expect(logs).toEqual(['human-plugin: the command.run hook throw: list unreadable'])
  expect(writes).toEqual([])
})

test('/claude-todo changes neither list: the human list and the Claude list are as they were after it prints', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  await runTodo(hooks, env, { entries: [entry('Build', 'in_flight')] })
  const before = JSON.stringify(values)
  await claudeTodo(hooks, env)
  await claudeTodo(hooks, env, 'x')
  expect(JSON.stringify(values)).toBe(before)
})

// The band with the Claude column: the AbovePrompt hook reads the Claude list beside the human one and draws both at the band's `bodyColumns`.
type Tree = { type?: string; width?: number; children?: Tree[]; [k: string]: unknown }
// `viewport`: the terminal's size and whether it is fullscreen, as a draw might carry them, on the event and in its props. The band reads neither.
const bandAt = (hooks: Record<string, Handler>, env: unknown, bodyColumns: number, extra: Record<string, unknown> = {}, surface = 'terminal', viewport?: object) =>
  drawn(env, () =>
    hooks['ui.render {"component":"AbovePrompt"}']?.(
      env as never,
      { surface, ...(viewport === undefined ? {} : { viewport }), props: { hasSurvey: false, maxRows: 20, bodyColumns, ...(viewport === undefined ? {} : { viewport }), ...extra } } as never,
      next(false) as never,
    ),
  ) as Promise<Tree>
// Trees are compared as JSON: a press handler is a fresh closure on every draw.
const flat = (node: unknown): string => JSON.stringify(node)
const sameTree = flat

test('with two human items and no Claude items the band is the one drawn today at 120 columns and at 90; one queued item brings the column at 120', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1), made(2)], [], null)
  const today = await bandAt(hooks, env, 80)
  expect(sameTree(await bandAt(hooks, env, 120))).toBe(sameTree(today))
  expect(sameTree(await bandAt(hooks, env, 90))).toBe(sameTree(today))
  values.todo = [entry('Write the tests', 'queued')]
  const wide = await bandAt(hooks, env, 120)
  expect(wide.width).toBe(120)
  expect(wide.children?.map(c => c.width)).toEqual([80, 40])
  expect(flat(wide.children?.[1])).toContain('○ Write the tests')
  expect(sameTree(await bandAt(hooks, env, 90))).toBe(sameTree(today))
})

// Where the pane stands: the Pane hook is raised on every surface, and its props say how that surface seated the pane. The band draws the Claude column
// beside this plugin's pane once a draw of it on the band's own surface has reported a dock since the pane was opened from closed: from 52 columns,
// and elsewhere from 96.
const paneAt = (hooks: Record<string, Handler>, env: unknown, placement: 'dock' | 'inline', surface = 'terminal') =>
  drawn(env, () => hooks['ui.render {"component":"Pane","requestId":"human-items"}']?.(env as never, { surface, props: { bodyColumns: 48, placement } } as never, next(false) as never))
// The `$` with its `ui.invalidate` counted: what the mod asked the engine to draw again.
const asking = (env: ReturnType<typeof memEnv>['env']) => {
  const asked: string[] = []
  return { $: { ...env, ui: { ...env.ui, invalidate: (event: string) => void asked.push(event) } }, asked }
}
// A band on `surface`: whether it draws the Claude column beside the human list. The width beside a docked pane is 52 columns and a pane docked at 110
// columns leaves the band 56, so a band of each width is drawn, and they must agree.
const columnDrawn = async (hooks: Record<string, Handler>, env: unknown, surface = 'terminal'): Promise<boolean> => {
  const at52 = flat(await bandAt(hooks, env, 52, {}, surface)).includes('Claude TODO')
  expect(flat(await bandAt(hooks, env, 56, {}, surface)).includes('Claude TODO'), `a band of 56 columns on ${surface} agrees with one of 52`).toBe(at52)
  return at52
}
const endSession = (hooks: Record<string, Handler>, env: unknown) => (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
const personCloses = async (hooks: Record<string, Handler>, env: unknown, open: string[]): Promise<void> => {
  open.length = 0
  await (hooks['ui.close'] as Handler)(env as never, { id: 'human-items', origin: { kind: 'person' } } as never, next(false) as never)
}
// The mod's records of docks outlive a close and reset when the pane is opened from closed, so a test starts from a pane opened and shut again: no
// pane, no record, and no redraw asked yet.
const freshDock = async (hooks: Record<string, Handler>, env: unknown, open: string[], asked: string[]): Promise<void> => {
  await endSession(hooks, env)
  findButton(await bandAt(hooks, env, 80), 'title-1')?.onPress()
  await settle()
  await personCloses(hooks, env, open)
  asked.length = 0
}

test('a band of 52 and one of 56 draw both lists once the pane is open and its surface has drawn it as a dock, and the dock\'s first draw asks for the redraw; no later pane draw asks for another', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await freshDock(hooks, $, open, asked)
  // The pane is shut: a draw of it, whatever it says, changes nothing the band draws, and asks for nothing.
  await paneAt(hooks, $, 'inline')
  expect(await columnDrawn(hooks, $)).toBe(false)
  expect(asked).toEqual([])
  // The pane is open inline and has not been drawn as a dock: the human list alone, full width.
  open.push('human-items')
  expect(await columnDrawn(hooks, $)).toBe(false)
  expect((await bandAt(hooks, $, 56)).width).toBeUndefined()
  // The band is drawn at the narrower width first, then the pane is drawn as a dock: the draw asks for the band, with no other event.
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
  const docked = await bandAt(hooks, $, 52)
  expect(docked.width).toBe(52)
  expect(docked.children?.map(c => c.width)).toEqual([20, 32])
  expect(flat(docked.children?.[1])).toContain('◐ Running')
  const wider = await bandAt(hooks, $, 56)
  expect(wider.children?.map(c => c.width)).toEqual([24, 32])
  // A later pane draw on the surface, docked or in another placement, asks for nothing, and the band still shows both lists.
  await paneAt(hooks, $, 'dock')
  await paneAt(hooks, $, 'inline')
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
})

// What a draw's viewport can say: none, a terminal of 110 columns that is not fullscreen, a fullscreen one of 61 columns (the dock's transcript column
// at 110) and a fullscreen one of 110.
const VIEWPORTS: (object | undefined)[] = [undefined, { columns: 110, rows: 45, isFullscreen: false }, { columns: 61, rows: 70, isFullscreen: true }, { columns: 110, rows: 70, isFullscreen: true }]

test('at a band of 52 and one of 56 the mod\'s pane state and its surface\'s dock alone decide the Claude column, whatever viewport the draw carries', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await freshDock(hooks, $, open, asked)
  const hasColumn = (tree: Tree): boolean => flat(tree).includes('Claude TODO')
  const check = async (expected: boolean, name: string): Promise<void> => {
    for (const columns of [52, 56]) {
      const without = await bandAt(hooks, $, columns)
      expect(hasColumn(without), `${name}, ${columns} columns`).toBe(expected)
      if (expected) expect(without.children?.map(c => c.width), `${name}, ${columns} columns`).toEqual([columns - 32, 32])
      for (const viewport of VIEWPORTS) {
        const tree = await bandAt(hooks, $, columns, {}, 'terminal', viewport)
        expect(hasColumn(tree), `${name}, ${columns} columns, ${JSON.stringify(viewport)}`).toBe(expected)
        expect(sameTree(tree), `${name}, ${columns} columns, ${JSON.stringify(viewport)}`).toBe(sameTree(without))
      }
    }
  }
  // Another plugin's dock: this plugin's pane is not open.
  await check(false, 'the pane is shut')
  open.push('human-items')
  await paneAt(hooks, $, 'inline')
  await check(false, 'the pane is inline')
  await paneAt(hooks, $, 'dock')
  await check(true, 'the pane is docked')
})

test('each surface keeps its own answer: a pane docked on the terminal and inline on the desktop gives the terminal band the Claude column and the desktop band none, and a draw on one never changes the other', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await freshDock(hooks, $, open, asked)
  open.push('human-items')
  await bandAt(hooks, $, 52, {}, 'terminal')
  await paneAt(hooks, $, 'dock', 'terminal')
  await paneAt(hooks, $, 'inline', 'desktop')
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $, 'terminal')).toBe(true)
  expect(await columnDrawn(hooks, $, 'desktop')).toBe(false)
  // The desktop docks it too: a change for the desktop alone, and the terminal's answer is as it was.
  await paneAt(hooks, $, 'dock', 'desktop')
  expect(asked).toEqual(['ui.render', 'ui.render'])
  expect(await columnDrawn(hooks, $, 'desktop')).toBe(true)
  expect(await columnDrawn(hooks, $, 'terminal')).toBe(true)
  // A band drawn on a surface no pane has drawn on has no dock.
  expect(await columnDrawn(hooks, $, 'vscode')).toBe(false)
  // A pane drawn inline on one surface leaves the other's answer as it was, and a band drawn there again shows what it showed.
  const before = flat(await bandAt(hooks, $, 56, {}, 'desktop'))
  await paneAt(hooks, $, 'inline', 'terminal')
  expect(flat(await bandAt(hooks, $, 56, {}, 'desktop'))).toBe(before)
  expect(asked).toEqual(['ui.render', 'ui.render'])
})

test('two clients of one surface kind whose pane draws report dock and inline in turn ask for one redraw after the pane is opened, and the band shows both lists after the first dock', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await freshDock(hooks, $, open, asked)
  findButton(await bandAt(hooks, $, 52), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  const drawsOf = async (sequence: ('dock' | 'inline')[]): Promise<void> => {
    for (const placement of sequence) await paneAt(hooks, $, placement)
  }
  await drawsOf(['inline', 'inline'])
  expect(asked).toEqual([])
  await drawsOf(['dock', 'inline', 'dock', 'inline', 'inline', 'dock', 'inline'])
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
})

test('a pane opened from closed forgets the docks it was seen in: the band is the human list alone until the new pane has drawn as a dock, and that draw asks for the band', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await freshDock(hooks, $, open, asked)
  const press = async (): Promise<void> => {
    findButton(await bandAt(hooks, $, 52), 'title-1')?.onPress()
    await settle()
  }
  await press()
  expect(open).toEqual(['human-items'])
  await paneAt(hooks, $, 'dock')
  expect(await columnDrawn(hooks, $)).toBe(true)
  // The second press, on the item the pane shows, shuts it. The shut pane has no dock.
  await press()
  expect(open).toEqual([])
  expect(await columnDrawn(hooks, $)).toBe(false)
  // The third opens it again, and it may be seated elsewhere: until it draws, the old dock is not read.
  await press()
  expect(open).toEqual(['human-items'])
  expect(await columnDrawn(hooks, $)).toBe(false)
  asked.length = 0
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
})

// The pane open as a dock on the terminal, as a press opens it and its draw seats it.
const dockedPane = async (hooks: Record<string, Handler>, env: unknown, open: string[], asked: string[]): Promise<void> => {
  await freshDock(hooks, env, open, asked)
  findButton(await bandAt(hooks, env, 52), 'title-1')?.onPress()
  await settle()
  await paneAt(hooks, env, 'dock')
  expect(open).toEqual(['human-items'])
  expect(await columnDrawn(hooks, env)).toBe(true)
}

// Each way the pane stops being open: the dock ends with it, and a pane opened from closed again is not docked until it has drawn as a dock.
const ENDS: [string, (hooks: Record<string, Handler>, env: unknown, open: string[]) => Promise<void>][] = [
  ['the person closes it', (hooks, env, open) => personCloses(hooks, env, open)],
  [
    'the mod closes it, by a press on the item it shows',
    async (hooks, env) => {
      findButton(await bandAt(hooks, env, 52), 'title-1')?.onPress()
      await settle()
    },
  ],
  [
    'a /clear ends the session',
    async (hooks, env) => {
      await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
      await settle()
    },
  ],
  [
    'the engine\'s pane list no longer shows it, as after an unload, with no close the mod hears',
    async (_hooks, _env, open) => {
      open.length = 0
    },
  ],
]
for (const [ending, end] of ENDS) {
  test(`when ${ending}, the band of 52 and of 56 is the human list alone, and a pane opened again is not read as docked until its draw reports a dock`, async () => {
    reset()
    const { hooks } = wire()
    const open: string[] = []
    const { env, values } = memEnv([made(1), made(2)], open, null)
    const { $, asked } = asking(env)
    values.todo = [entry('Running', 'in_flight')]
    await dockedPane(hooks, $, open, asked)
    await end(hooks, $, open)
    expect(open).toEqual([])
    values.list = { items: [made(1), made(2)], next: 3 }
    values.todo = [entry('Running', 'in_flight')]
    expect(await columnDrawn(hooks, $)).toBe(false)
    findButton(await bandAt(hooks, $, 52), 'title-1')?.onPress()
    await settle()
    expect(open).toEqual(['human-items'])
    expect(await columnDrawn(hooks, $)).toBe(false)
    asked.length = 0
    await paneAt(hooks, $, 'dock')
    expect(asked).toEqual(['ui.render'])
    expect(await columnDrawn(hooks, $)).toBe(true)
  })
}

test('a session end other than /clear that leaves the pane in the engine\'s list leaves the dock; a press that opens the pane from closed before any band draw resyncs it narrows the band until the pane draws as a dock again, which asks for the band', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await dockedPane(hooks, $, open, asked)
  await endSession(hooks, $)
  expect(await columnDrawn(hooks, $)).toBe(true)
  // The session ends again, and a press made on the band drawn before it opens the pane from closed with no band draw between.
  const tree = await bandAt(hooks, $, 52)
  await endSession(hooks, $)
  findButton(tree, 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(await columnDrawn(hooks, $)).toBe(false)
  asked.length = 0
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
})

// A pane whose close another plugin refuses. With `state.refuse` on, the engine's list has no pane while the close is pending, `state.during` runs then
// (a band drawn in that window), and the list has the pane again when the call rejects.
const refusing = (env: ReturnType<typeof memEnv>['env'], open: string[]) => {
  const { $: counted, asked } = asking(env)
  const state = { refuse: false, during: async (): Promise<void> => {} }
  const close = async (e: { id: string }): Promise<void> => {
    if (!state.refuse) return counted.ui.close(e)
    open.splice(open.indexOf(e.id), 1)
    await state.during()
    open.push(e.id)
    throw new Error('close refused')
  }
  return { $: { ...counted, ui: { ...counted.ui, close } }, asked, state }
}

test('a close another plugin refuses leaves the pane open and docked: the band drawn alone while it was pending is asked for again, and draws the Claude column', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked, state } = refusing(env, open)
  values.todo = [entry('Running', 'in_flight')]
  await dockedPane(hooks, $, open, asked)
  asked.length = 0
  const tree = await bandAt(hooks, $, 52)
  let inFlight: Tree | undefined
  state.refuse = true
  state.during = async () => {
    inFlight = await bandAt(hooks, $, 52)
  }
  findButton(tree, 'title-1')?.onPress()
  await settle()
  await settle()
  // The list lacked the pane when the band was drawn in the window, so that draw had no column; the refusal asks for the draw again.
  expect(inFlight).toBeDefined()
  expect(flat(inFlight)).not.toContain('Claude TODO')
  expect(open).toEqual(['human-items'])
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
})

test('a close another plugin refuses asks for no redraw when the pane was never drawn as a dock: the band had no dock to lose', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2)], open, null)
  const { $, asked, state } = refusing(env, open)
  values.todo = [entry('Running', 'in_flight')]
  await freshDock(hooks, $, open, asked)
  findButton(await bandAt(hooks, $, 52), 'title-1')?.onPress()
  await settle()
  await paneAt(hooks, $, 'inline')
  const tree = await bandAt(hooks, $, 52)
  state.refuse = true
  state.during = async () => {
    await bandAt(hooks, $, 52)
  }
  findButton(tree, 'title-1')?.onPress()
  await settle()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(asked).toEqual([])
})

test('switching the pane to another item, and an item the agent removes from under it, leave the band docked with nothing asked, before the pane draws again', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env, values } = memEnv([made(1), made(2), made(3)], open, null)
  const { $, asked } = asking(env)
  values.todo = [entry('Running', 'in_flight')]
  await dockedPane(hooks, $, open, asked)
  asked.length = 0
  // A press on another item's title switches the open pane to it: the pane is opened again with that item's rows.
  const opens: object[] = []
  const switching = { ...$, ui: { ...$.ui, open: (args: object) => (opens.push(args), $.ui.open(args as never)) } }
  findButton(await bandAt(hooks, switching, 52), 'title-2')?.onPress()
  await settle()
  expect(opens.length).toBe(1)
  expect(await columnDrawn(hooks, $)).toBe(true)
  // The agent removes the item the pane shows: the pane moves on to the next one.
  await runTool(hooks, switching, { action: 'remove', id: 2 })
  await settle()
  expect(opens.length).toBe(2)
  expect(await columnDrawn(hooks, $)).toBe(true)
  expect(asked).toEqual([])
})

test('with no human items an item in flight draws the column alone, 40 wide, and nothing in flight hands on', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  const e = { props: { hasSurvey: false, maxRows: 20, bodyColumns: 120 } }
  values.todo = [entry('Only queued', 'queued')]
  expect(await (hooks['ui.render {"component":"AbovePrompt"}'] as Handler)(env as never, e as never, next(false) as never)).toEqual({ passed: e })
  values.todo = [entry('Running', 'in_flight'), entry('Later', 'queued')]
  const tree = await bandAt(hooks, env, 120)
  expect(tree.children?.map(c => c.width)).toEqual([40])
  expect(flat(tree)).toContain('◐ Running')
  expect(flat(tree)).not.toContain('Later')
  values.todo = []
  expect(await (hooks['ui.render {"component":"AbovePrompt"}'] as Handler)(env as never, e as never, next(false) as never)).toEqual({ passed: e })
})

test('while a survey holds the band the mod yields it, the Claude list or not', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1)], [], null)
  values.todo = [entry('Running', 'in_flight')]
  const e = { props: { hasSurvey: true, maxRows: 20, bodyColumns: 120 } }
  expect(await (hooks['ui.render {"component":"AbovePrompt"}'] as Handler)(env as never, e as never, next(false) as never)).toEqual({ passed: e })
})

test('under a subagent\'s view the band is the one drawn under the main conversation\'s', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1)], [], null)
  values.todo = [entry('Running', 'in_flight'), entry('Later', 'queued')]
  const main = await bandAt(hooks, env, 120, { view: {} })
  expect(sameTree(await bandAt(hooks, env, 120, { view: { agentId: 'sub-1' } }))).toBe(sameTree(main))
})

test('a list the agent writes through the tool is drawn: the column follows the tool\'s writes and the removal of the last item', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([made(1)], [], null)
  expect(flat(await bandAt(hooks, env, 120))).not.toContain('Claude TODO')
  await runTodo(hooks, env, { entries: [entry('Build', 'in_flight'), entry('Test', 'queued')] })
  const wide = await bandAt(hooks, env, 120)
  expect(flat(wide)).toContain('Claude TODO 1 active, 1 queued')
  expect(flat(wide)).toContain('◐ Build')
  await runTodo(hooks, env, { entries: [] })
  expect(flat(await bandAt(hooks, env, 120))).not.toContain('Claude TODO')
})

test('a write that is stored sets the reminder count to zero, and a refused write leaves it', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  values.reminder = 42
  await runTodo(hooks, env, { entries: [entry('', 'queued')] })
  await runTodo(hooks, env, {})
  expect(values.reminder).toBe(42)
  await runTodo(hooks, env, { entries: [entry('Build', 'in_flight')] })
  expect(values.reminder).toBe(0)
})

test('a reminder count that cannot be reset is logged, and the write is stored and answered as without the failure', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  const logs: string[] = []
  const set = env.state.set
  const failing = {
    ...env,
    state: {
      ...env.state,
      set: async (ref: { key: string }, value: unknown) => {
        if (ref.key === 'reminder') throw new Error('count unwritable')
        return set(ref, value)
      },
    },
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
  }
  expect(await runTodo(hooks, failing, { entries: [entry('Build', 'in_flight')] })).toEqual({ result: 'Claude TODO: 1 in flight, 0 queued\n- in_flight: Build (ETA: no ETA)' })
  expect(values.todo).toEqual([entry('Build', 'in_flight')])
  expect(logs.some(line => line.includes('count unwritable'))).toBe(true)
})

test('a /clear sets the reminder count to zero through session.end\'s hook and through its failure handler, the latter with emptying the human list throwing', async () => {
  reset()
  const { hooks, catches } = wire()
  const { env, values } = memEnv([], [], null)
  values.reminder = 42
  await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  expect(values.reminder).toBe(0)
  values.reminder = 42
  const set = env.state.set
  const failing = {
    ...env,
    state: {
      ...env.state,
      set: async (ref: { key: string }, value: unknown) => {
        if (ref.key === 'list') throw new Error('list unwritable')
        return set(ref, value)
      },
    },
  }
  await Promise.resolve((catches['session.end'] as Handler)(failing as never, { reason: 'clear' } as never, next(false) as never)).catch(() => undefined)
  expect(values.reminder).toBe(0)
})

test('a session end that is not a /clear leaves the reminder count', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  values.reminder = 42
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  expect(values.reminder).toBe(42)
})

// The batch end over a fake engine: one notice owed to the main turn, whose item is on the list, and the rows the mod appends for it.
const batchEnd = async (env: Record<string, unknown>, tools: number, agent?: string) => {
  reset()
  const { hooks } = wire()
  const rows: unknown[] = []
  const e = { tool_calls: Array.from({ length: tools }, (_, i) => ({ tool_name: 'Read', tool_input: {}, tool_use_id: `r${i}` })), ...(agent === undefined ? {} : { agent_id: agent }) }
  startTurn()
  offer({ id: 1, text: '#1 is done: Live ask' })
  const $ = { ...env, session: { append: async (row: unknown) => (rows.push(row), {}) } }
  return { rows, out: await (hooks['classic.PostToolBatch'] as Handler)($ as never, e as never, next(false) as never), e }
}

test('a batch end that takes the count past 50 returns the rest of the chain\'s result with the reminder in its context, and a subagent\'s returns it unchanged', async () => {
  const { env } = memEnv([made(1, { title: 'Live ask', detail: '' })], [], null)
  const main = await batchEnd(env, 50)
  expect(main.out).toEqual({ passed: main.e, additionalContext: [REMINDER_TEXT] })
  expect(main.rows).toHaveLength(1)
  const { env: other } = memEnv([made(1, { title: 'Live ask', detail: '' })], [], null)
  const sub = await batchEnd(other, 60, 'sub-1')
  expect(sub.out).toEqual({ passed: sub.e })
})

test('a batch end whose count cannot be read logs it, carries no reminder and still hands over the notice', async () => {
  const { env } = memEnv([made(1, { title: 'Live ask', detail: '' })], [], null)
  const logs: string[] = []
  const get = env.state.get
  const failing = {
    ...env,
    state: {
      ...env.state,
      get: async (ref: { key: string }) => {
        if (ref.key === 'reminder') throw new Error('count unreadable')
        return get(ref)
      },
    },
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
  }
  const { out, rows, e } = await batchEnd(failing, 60)
  expect(out).toEqual({ passed: e })
  expect(rows).toHaveLength(1)
  expect(logs.some(line => line.includes('count unreadable'))).toBe(true)
})

test('a reload of the mod keeps the reminder count: the hooks wired again over the same state give the reminder once, not a second one', async () => {
  const { env, values } = memEnv([made(1, { title: 'Live ask', detail: '' })], [], null)
  values.reminder = 49
  const first = await batchEnd(env, 1)
  expect(first.out).toEqual({ passed: first.e, additionalContext: [REMINDER_TEXT] })
  const reloaded = await batchEnd(env, 1)
  expect(reloaded.out).toEqual({ passed: reloaded.e })
  expect(values.reminder).toBe(51)
})

test('a rebuild from a transcript fills the Claude list and leaves the reminder count as it was', async () => {
  const { env, values } = memEnv([], [], null)
  values.reminder = 7
  await fillTodo(env as never, [{ title: 'Rebuilt step', state: 'in_flight', eta: NO_ETA }])
  expect(values.todo).toEqual([entry('Rebuilt step', 'in_flight')])
  expect(values.reminder).toBe(7)
})

test('a /clear whose reminder reset fails logs it, and the human list and the Claude list are still emptied', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { title: 'Live ask', detail: '' })], [], null)
  const logs: string[] = []
  const set = env.state.set
  const failing = {
    ...env,
    state: {
      ...env.state,
      set: async (ref: { key: string }, value: unknown) => {
        if (ref.key === 'reminder') throw new Error('count unwritable')
        return set(ref, value)
      },
    },
    ui: { ...env.ui, log: (text: string) => void logs.push(text) },
  }
  values.todo = [entry('Build', 'in_flight')]
  const e = { reason: 'clear' }
  expect(await (hooks['session.end'] as Handler)(failing as never, e as never, next(false) as never)).toEqual({ passed: e })
  expect(values.todo).toEqual([])
  expect((values.list as { items: unknown[] }).items).toEqual([])
  expect(logs.some(line => line.includes('count unwritable'))).toBe(true)
})
