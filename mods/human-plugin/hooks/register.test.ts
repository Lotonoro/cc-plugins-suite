import { expect, test } from 'claude-code/testing'
import { register, wireHooks } from './register'
import { offer, reset, setOnChange, startTurn, takeHeld, endTurn } from './turns'
import { EMPTY, TOOL, act, normalizeStore } from './items'
import { NO_ETA, TODO_TOOL, fillTodo, readTodo } from './todo'
import { REMINDER_TEXT } from './reminder'
import { TODO_SPEC, TOOL_SPEC } from './steering'
import { paneRows } from './ui'
import { correctionText } from './restatement'
import {
  ALREADY_ASKING, ARG_HINT, CLAUDE_COMMAND, CLAUDE_DESCRIPTION, CLAUDE_FAILED, CLAUDE_REBUILDING, CLAUDE_USAGE, COMMAND, DESCRIPTION, DO_COMMAND, DO_DESCRIPTION, DO_FAILED, DO_REBUILDING,
  DO_USAGE, FAILED, NOTHING_OPEN, PHONE_REBUILDING, REBUILDING, USAGE,
} from './commands'
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
    // A filtered hook (`{ component }`, `{ requestId }`) is also kept under its filter, as two can share an event. The bare event key holds the last hook
    // registered for the event, so the bare `tool.call` is the mod's own tool's (registered after the AskUserQuestion hook, which is read by its filter).
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
  for (const prompt of [{ origin: { kind: 'composer' }, ...text }, { origin: { kind: 'sdk' }, ...text }, { origin: { kind: 'bridge' }, command: { name: 'todo', args: '' }, ...text }]) {
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
  // The human list emptied with the counter the store holds, then the Claude list, the reminder's count and the name the agent stated for the Claude list.
  expect(writes).toEqual([{ items: [], next: 7, term: null }, [], 0, ''])
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
  expect(JSON.stringify(await render($([one]) as never, e as never, next(false) as never))).toContain('Human TODO')
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
// A timer the mod started: its wait, and whether it is a one-shot (`after`), which runs once and is gone, or a tick (`every`).
type Timer = { fn: () => unknown; ms?: number; once?: boolean }
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
const memEnv = (items: unknown[], open: string[], selection: unknown, submitted: unknown[] = [], timers: Timer[] = []) => {
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
      // A one-shot timer keeps its wait, runs once and is gone, and a cancel takes it out.
      after: (ms: number, fn: () => unknown) => {
        const timer: Timer = {
          ms,
          once: true,
          fn: () => {
            const at = timers.indexOf(timer)
            if (at >= 0) timers.splice(at, 1)
            return fn()
          },
        }
        timers.push(timer)
        return {
          cancel: () => {
            const at = timers.indexOf(timer)
            if (at >= 0) timers.splice(at, 1)
          },
        }
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

// The clock moves to `at`, and each timer the mod has started runs once there, in the order they were armed: a tick ends the undo windows whose time has run
// out, and a one-shot timer (the walk's release) runs and is gone. `only` runs the ticks or the one-shots alone.
const tickAt = async (timers: Timer[], clock: { now: number }, at: number, only?: 'ticks' | 'one-shots'): Promise<void> => {
  clock.now = at
  for (const timer of [...timers]) if (only === undefined || (timer.once === true) === (only === 'one-shots')) await timer.fn()
  await settle()
}
// The waits of the one-shot timers pending: the walk's release, one at most.
const oneShotWaits = (timers: Timer[]): (number | undefined)[] => timers.filter(timer => timer.once === true).map(timer => timer.ms)

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

test('removing the shown item moves the pane to the first open item in the ranking, with its rows, and the selection follows', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env: plain, values } = memEnv([made(1), made(2), made(3)], open, null)
  const opened: { id: string; rows: number }[] = []
  const env = { ...plain, ui: { ...plain.ui, open: async (args: { id: string; rows: number }) => { opened.push({ id: args.id, rows: args.rows }); return plain.ui.open(args) } } }
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  // Item 1 is unread after the open, so only the switch to it can read it.
  const listOf = () => values.list as { items: (Item & { unread: boolean })[] }
  const shownNext = listOf().items.find(it => it.id === 1)
  if (shownNext) shownNext.unread = true
  opened.length = 0
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  const one = listOf().items.find(it => it.id === 1)
  expect(opened).toEqual([{ id: 'human-items', rows: paneRows(one) }])
  expect(values.selection).toBe(1)
  expect(one?.unread).toBe(false)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#1 non-blocking, open: Item 1')
  expect(shown).not.toContain('Item 2')
  expect(shown).not.toContain('Item 3')
})

test('removing the shown item moves the pane to a blocking open item before any other, whatever its number', async () => {
  for (const removed of [1, 2]) {
    reset()
    const { hooks } = wire()
    const open: string[] = []
    const { env, values } = memEnv([made(1), made(2), made(3, { blocking: true })], open, null)
    findButton(await band(hooks, env), `title-${removed}`)?.onPress()
    await settle()
    await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: removed } as never, next(false) as never)
    await settle()
    expect(open, `#${removed}`).toEqual(['human-items'])
    expect(values.selection, `#${removed}`).toBe(3)
    expect(JSON.stringify(await paneTree(hooks, env)), `#${removed}`).toContain('#3 blocking, open: Item 3')
  }
})

test('removing the shown highest-id item moves the pane to the first remaining item in the ranking', async () => {
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
  expect(values.selection).toBe(1)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#1 non-blocking, open: Item 1')
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

test('removing the shown item closes the pane when no open item is left, though sent items are', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { env } = memEnv([made(1), made(2, { state: 'done-pending' })], open, null)
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

test('when the window ends on the item the pane shows, the pane closes, whatever other items are open', async () => {
  const lists: [string, unknown[]][] = [
    ['another item open, one sent', [made(1), made(2, { state: 'done-pending' }), made(3)]],
    ['no other item open, one sent', [made(1), made(2, { state: 'done-pending' })]],
  ]
  for (const [name, items] of lists) {
    reset()
    const { hooks } = wire()
    const open: string[] = []
    const timers: Timer[] = []
    const { env, clock } = memEnv(items, open, null, [], timers)
    await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
    findButton(await band(hooks, env), 'title-1')?.onPress()
    await settle()
    expect(open, name).toEqual(['human-items'])
    findButton(await band(hooks, env), 'done-1')?.onPress()
    await settle()
    // The pane stays open through the undo window, and closes when it ends.
    expect(open, name).toEqual(['human-items'])
    await tickAt(timers, clock, 3000)
    expect(open, name).toEqual([])
  }
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

test('a reply\'s window ending closes the pane, as an option press\'s does, and the pane asks for no rows', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env: plain, values, clock } = replyEnv([made(1, { detail: '' }), made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(plain as never, { reason: 'exit' } as never, next(false) as never)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findInput(await paneTree(hooks, env), 'reply-1')?.onSubmit('Use sqlite', {})
  await settle()
  opened.length = 0
  await tickAt(timers, clock, 3000)
  expect((values.list as { items: Item[] }).items.find(it => it.id === 1)).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
  expect(open).toEqual([])
  expect(opened).toEqual([])
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

test('an option press\'s window ending closes the pane, as a done press\'s does', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const decision = made(1, { detail: '', options: [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }] })
  const { env, clock } = memEnv([decision, made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await paneTree(hooks, env), 'answer-1-1')?.onPress()
  await settle()
  await tickAt(timers, clock, 3000)
  expect(open).toEqual([])
})

test('a yes or no press on the item the pane shows closes the pane when its window ends', async () => {
  for (const key of ['yes-1', 'no-1']) {
    reset()
    const { hooks } = wire()
    const open: string[] = []
    const timers: Timer[] = []
    const { env, clock } = memEnv([made(1, { detail: '', yesno: true }), made(2)], open, null, [], timers)
    await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
    findButton(await band(hooks, env), 'title-1')?.onPress()
    await settle()
    findButton(await band(hooks, env), key)?.onPress()
    await settle()
    expect(open, key).toEqual(['human-items'])
    await tickAt(timers, clock, 3000)
    expect(open, key).toEqual([])
  }
})

// The first read of the selection after a window's end is the pane's own, made once the end has written the item sent. It is held, so that something can happen to the
// item between the end's write and the pane's decision: `reached` says the pane has made the read, and `release` lets it go on to read the list as it stands then.
const holdSelectionRead = (env: { state: { get: (ref: { key: string }) => Promise<unknown> } }) => {
  let release: () => void = () => {}
  let holding = true
  const get = env.state.get
  env.state.get = async (ref: { key: string }) => {
    if (ref.key === 'selection' && holding) {
      holding = false
      await new Promise<void>(done => (release = done))
    }
    return get(ref)
  }
  return { reached: () => !holding, release: () => release() }
}

test('a window that ends on the item the pane shows, with an agent append reopening it before the pane decides, leaves the pane on it, open, and asks for its rows again', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env: plain, values, clock } = memEnv([made(1, { detail: '' })], open, null, [], timers)
  await (hooks['session.end'] as Handler)(plain as never, { reason: 'exit' } as never, next(false) as never)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  const hold = holdSelectionRead(plain)
  opened.length = 0
  await tickAt(timers, clock, 3000)
  expect(hold.reached()).toBe(true)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 1, text: 'It needs a file.' } as never, next(false) as never)
  await settle()
  // The append's own follow-up has asked for the reopened item's rows; the window's end decides after the append, and asks once more.
  const appended = opened.length
  hold.release()
  await settle()
  const one = (values.list as { items: Item[] }).items[0] as Item
  expect(one).toMatchObject({ state: 'open' })
  expect(opened.slice(appended)).toEqual([{ id: 'human-items', rows: paneRows(one) }])
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
})

test('a window that ends on the item the pane shows, with the item removed before the pane reads the list, moves the pane on to the first open item in the ranking', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env: plain, values, clock } = memEnv([made(1, { detail: '' }), made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(plain as never, { reason: 'exit' } as never, next(false) as never)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  const hold = holdSelectionRead(plain)
  opened.length = 0
  await tickAt(timers, clock, 3000)
  expect(hold.reached()).toBe(true)
  // The item leaves the list in the state itself: a tool call that removes it would move the pane at once with its own follow-up, and the window's end would find the
  // pane already elsewhere. Here the window's end alone decides.
  const list = values.list as { items: { id: number }[] }
  values.list = { ...list, items: list.items.filter(it => it.id !== 1) }
  hold.release()
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(2)
  expect(opened).toEqual([{ id: 'human-items', rows: paneRows((values.list as { items: Item[] }).items.find(it => it.id === 2)) }])
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#2 non-blocking, open: Item 2')
})

test('a window that ends on the item the pane shows, with the item reopened and pressed again before the pane decides, leaves the pane as it is until that second window ends', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env: plain, values, clock } = memEnv([made(1, { detail: '' }), made(2)], open, null, [], timers)
  await (hooks['session.end'] as Handler)(plain as never, { reason: 'exit' } as never, next(false) as never)
  const opened: { id: string; rows: number }[] = []
  const env = recordingOpens(plain, opened)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  const hold = holdSelectionRead(plain)
  await tickAt(timers, clock, 3000)
  expect(hold.reached()).toBe(true)
  // The agent's append reopens the sent item, and a second press on it opens a new undo window.
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'append', id: 1, text: 'It needs a file.' } as never, next(false) as never)
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'done-waiting', pressedAt: 3000 })
  const asked = opened.length
  hold.release()
  await settle()
  expect(opened.length).toBe(asked)
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
  // The second window's end is the one that sends the item, and it closes the pane.
  await tickAt(timers, clock, 6000)
  expect((values.list as { items: Item[] }).items[0]).toMatchObject({ state: 'done-pending' })
  expect(open).toEqual([])
})

test('a zero undo window with the pane open on the pressed item closes the pane and sends the notice before the press returns, and leaves no tick running', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env } = memEnv([made(1, { detail: '' }), made(2)], open, null, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  await pressDone(env as never, 1, null, 0)
  expect(open).toEqual([])
  expect(submitted).toHaveLength(1)
  expect((submitted[0] as { text: string }).text.startsWith('#1 is done: Item 1\nThe human marked it done.')).toBe(true)
  expect(timers.length).toBe(0)
})

test('a close the window\'s end asks for and the pane refuses is logged and leaves the pane counted open, and the item\'s notice is still submitted', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const logs: string[] = []
  const { env: plain, clock } = memEnv([made(1, { detail: '' }), made(2)], open, null, submitted, timers)
  let refuse = false
  const env = { ...plain, ui: { ...plain.ui, log: (text: string) => void logs.push(text), close: (e: { id: string }) => (refuse ? Promise.reject(new Error('close refused')) : plain.ui.close(e)) } }
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  findButton(await band(hooks, env), 'done-1')?.onPress()
  await settle()
  refuse = true
  await tickAt(timers, clock, 3000)
  expect(logs.filter(line => line.includes('close refused'))).toEqual(['human-plugin: Error: close refused'])
  expect(open).toEqual(['human-items'])
  expect(submitted).toHaveLength(1)
  expect((submitted[0] as { text: string }).text.startsWith('#1 is done: Item 1\nThe human marked it done.')).toBe(true)
  // The pane is still counted open: a press on the title of the item it shows closes it, where a pane counted shut would open it again.
  refuse = false
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual([])
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

test('a sent item the person views is left alone by a tool call; a tool call that removes it moves the pane to the first open item in the ranking', async () => {
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
  // Items 1 and 3 are open: the ranking's first is 1, the lower number, not the next one above the removed item.
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(values.selection).toBe(1)
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
const reloaded = async (open: string[], items: unknown[], selection: unknown, submitted: unknown[] = [], timers: Timer[] = []) => {
  const { hooks } = wire()
  const { env, values, clock } = memEnv(items, open, selection, submitted, timers)
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  await band(hooks, env)
  return { hooks, env, values, clock }
}

test('after a reload, removing the shown item moves the pane to the first open item in the ranking, the selection following', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2), made(3)], 2)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#1 non-blocking, open: Item 1')
  expect(shown).not.toContain('Item 2')
})

test('after a reload, removing the last item closes the pane', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1)], 1)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 1 } as never, next(false) as never)
  await settle()
  expect(open).toEqual([])
})

test('after a reload, the expiry of a press on the shown item closes the pane', async () => {
  const open = ['human-items']
  const timers: Timer[] = []
  const { hooks, env, clock } = await reloaded(open, [made(1), made(2), made(3)], 2, [], timers)
  findButton(await band(hooks, env), 'done-2')?.onPress()
  await settle()
  expect(timers.length).toBe(1)
  await tickAt(timers, clock, 3000)
  expect(open).toEqual([])
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

test('with no selection the open pane draws the first item in the ranking, a blocking item filed after a non-blocking one', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1), made(2, { blocking: true })], null)
  const shown = JSON.stringify(await paneTree(hooks, env))
  expect(shown).toContain('#2 blocking, open: Item 2')
  expect(shown).not.toContain('Item 1')
})

test('with no selection a press on the title of the ranking\'s first item, a blocking one filed after a non-blocking one, closes the open pane: the pane shows that item', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1), made(2, { blocking: true })], null)
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(open).toEqual([])
})

test('with no selection the open pane shows the first item in the ranking, so removing that blocking item moves the pane on to the next one in the ranking', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, [made(1), made(2, { blocking: true }), made(3)], null)
  await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id: 2 } as never, next(false) as never)
  await settle()
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(1)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
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

test('while a press\'s selection write is still in flight, the pane\'s own record says the pressed item is shown: a second press on its title closes the pane', async () => {
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
  expect(JSON.stringify(await band(hooks, env))).toContain('owner TODO')
})

test('a term is drawn as one line with single spaces; a blank one returns the chip to Human TODO, and its add still lands', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  expect(await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'Team\n   lead' })).toEqual({ result: 'added #1 (term set to "Team lead")' })
  expect(JSON.stringify(await band(hooks, env))).toContain('Team lead TODO')
  expect(await runTool(hooks, env, { action: 'add', title: 'Second', term: '  ' })).toEqual({ result: 'added #2 (term cleared)' })
  const drawn = JSON.stringify(await band(hooks, env))
  expect(drawn).toContain('Human TODO')
  expect(drawn).toContain('2 open')
  expect(drawn).not.toContain('Team lead')
})

test('a later term changes the chip; a call with no term leaves it, and a term-only update sets it at once', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  await runTool(hooks, env, { action: 'add', title: 'Second' })
  expect(JSON.stringify(await band(hooks, env))).toContain('owner TODO')
  expect(await runTool(hooks, env, { action: 'update', id: 2, term: 'lead' })).toEqual({ result: 'no change to #2 (term set to "lead")' })
  expect(JSON.stringify(await band(hooks, env))).toContain('lead TODO')
  await runTool(hooks, env, { action: 'update', id: 2, note: 'recheck' })
  expect(JSON.stringify(await band(hooks, env))).toContain('lead TODO')
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
  expect(JSON.stringify(await band(hooks, env))).toContain('owner TODO')
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
  expect(JSON.stringify(await band(hooks, env))).toContain('owner TODO')
})

test('a term-only update naming an item no one has is refused, and the chip keeps its term', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  expect(await runTool(hooks, env, { action: 'update', id: 9, term: 'lead' })).toEqual({ deny: 'no item #9' })
  expect(JSON.stringify(await band(hooks, env))).toContain('owner TODO')
})

test('after a /clear the band reads Human TODO until a term is stated again', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTool(hooks, env, { action: 'add', title: 'Pick a db', term: 'owner' })
  await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  expect(values.list).toEqual({ items: [], next: 2, term: null })
  expect(await runTool(hooks, env, { action: 'add', title: 'Next ask' })).toEqual({ result: 'added #2' })
  const drawn = JSON.stringify(await band(hooks, env))
  expect(drawn).toContain('Human TODO')
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

// The key a command's hook is stored under: the event, then the matcher as JSON, which names the command.
const commandKey = (name: string): string => `command.run ${JSON.stringify({ command: name })}`
// The `/todo` command: registered at session start, answered by its command hook, and waiting for a rebuild as the tool does.
const todoOf = (hooks: Record<string, Handler>): Handler => hooks[commandKey(COMMAND)] as Handler
const claudeTodoOf = (hooks: Record<string, Handler>): Handler => hooks[commandKey(CLAUDE_COMMAND)] as Handler
const doOf = (hooks: Record<string, Handler>): Handler => hooks[commandKey(DO_COMMAND)] as Handler

test('/todo is registered at session start with the flag that runs it mid-turn, under the name its hook\'s matcher spells out', async () => {
  freshModule()
  const wired = wire()
  const { env } = memEnv([], [], null)
  const registered: Record<string, unknown>[] = []
  await started(wired, { ...env, command: { register: async (spec: Record<string, unknown>) => void registered.push(spec) } })
  expect(registered).toContainEqual({ name: COMMAND, description: DESCRIPTION, argumentHint: ARG_HINT, immediate: true })
  expect(typeof todoOf(wired.hooks)).toBe('function')
})

test('/claude-todo is registered at session start with the flag that runs it mid-turn and no argument hint, under the name its hook\'s matcher spells out', async () => {
  freshModule()
  const wired = wire()
  const { env } = memEnv([], [], null)
  const registered: Record<string, unknown>[] = []
  await started(wired, { ...env, command: { register: async (spec: Record<string, unknown>) => void registered.push(spec) } })
  expect(registered).toContainEqual({ name: CLAUDE_COMMAND, description: CLAUDE_DESCRIPTION, immediate: true })
  expect(typeof claudeTodoOf(wired.hooks)).toBe('function')
})

test('/do is registered at session start with the flag that runs it mid-turn and no argument hint, under the name its hook\'s matcher spells out', async () => {
  freshModule()
  const wired = wire()
  const { env } = memEnv([], [], null)
  const registered: Record<string, unknown>[] = []
  await started(wired, { ...env, command: { register: async (spec: Record<string, unknown>) => void registered.push(spec) } })
  expect(registered).toContainEqual({ name: DO_COMMAND, description: DO_DESCRIPTION, immediate: true })
  expect(typeof doOf(wired.hooks)).toBe('function')
})

test('the session start registers three commands and no other: /todo, /claude-todo and /do, each with its own spec', async () => {
  freshModule()
  const wired = wire()
  const { env } = memEnv([], [], null)
  const registered: Record<string, unknown>[] = []
  await started(wired, { ...env, command: { register: async (spec: Record<string, unknown>) => void registered.push(spec) } })
  expect(registered).toEqual([
    { name: COMMAND, description: DESCRIPTION, argumentHint: ARG_HINT, immediate: true },
    { name: CLAUDE_COMMAND, description: CLAUDE_DESCRIPTION, immediate: true },
    { name: DO_COMMAND, description: DO_DESCRIPTION, immediate: true },
  ])
})

test('a failed /todo registration is logged, and the rest of the session start still delivers an owed notice', async () => {
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
    'human-plugin: the /todo command was not registered: Error: no room for the command',
    'human-plugin: the /claude-todo command was not registered: Error: no room for the command',
    'human-plugin: the /do command was not registered: Error: no room for the command',
  ])
  expect(submitted).toEqual([{ text: '#1 is done: Item 1' }])
})

test('a failed registration of one command leaves the other two registered and logs only its own line, whichever of /todo, /claude-todo and /do fails', async () => {
  const names = [COMMAND, CLAUDE_COMMAND, DO_COMMAND]
  for (const failing of names) {
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
    expect([failing, registered]).toEqual([failing, names.filter(name => name !== failing)])
    expect([failing, logs]).toEqual([failing, [`human-plugin: the /${failing} command was not registered: Error: no room for the command`]])
  }
})

test('a failed /todo registration leaves an undo window to be restored at session start: its tick sends the answer once the window has run', async () => {
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

test('/todo prints the list through its command, /todo <n> prints that item whole, and a number no item has, or a usage, answers so', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { title: 'Pick a db', blocking: true, detail: 'postgres or sqlite' }), made(2, { detail: '' })], [], null)
  const ask = todoOf(hooks)
  expect(await ask(env as never, { args: '' } as never, next(false) as never)).toEqual({ text: '  #1 blocking: Pick a db\n  #2 non-blocking: Item 2' })
  expect(await ask(env as never, { args: '1' } as never, next(false) as never)).toEqual({
    text: '  #1 blocking: Pick a db\n  brief:\n  postgres or sqlite\n  /todo 1 done\n  /todo 1 reply <text>',
  })
  expect(await ask(env as never, { args: ' 001 ' } as never, next(false) as never)).toEqual({
    text: '  #1 blocking: Pick a db\n  brief:\n  postgres or sqlite\n  /todo 1 done\n  /todo 1 reply <text>',
  })
  expect(await ask(env as never, { args: '3' } as never, next(false) as never)).toEqual({ text: '  There is no such item.' })
  expect(await ask(env as never, { args: '3.5' } as never, next(false) as never)).toEqual({ text: USAGE })
})

test('/todo <n> clears the unread mark of the one item it shows, and /todo alone clears none', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { unread: true }), made(2, { unread: true })], [], null)
  const ask = todoOf(hooks)
  await ask(env as never, { args: '' } as never, next(false) as never)
  const both = JSON.stringify(await band(hooks, env))
  expect(both).toContain('• #1 ')
  expect(both).toContain('• #2 ')
  await ask(env as never, { args: '2' } as never, next(false) as never)
  const afterShow = JSON.stringify(await band(hooks, env))
  expect(afterShow).toContain('• #1 ')
  expect(afterShow).not.toContain('• #2 ')
})

test('/todo <n> keeps the unread mark an agent turn raised after it read the item: the turn is not in the text the read printed', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { state: 'done-pending', answer: 'Use sqlite' })], [], null)
  // The agent appends a turn to #1 between /todo's read of the list and its clear of the mark: the first read returns the list as it was.
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
  expect(await todoOf(hooks)(env as never, { args: '1' } as never, next(false) as never)).toEqual({
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

test('/todo answers that the list is being rebuilt while the rebuild runs past its wait, and lists the rebuilt items once it has finished', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  const ask = todoOf(wired.hooks)
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

test('a /todo whose list read throws answers one error line, logs the failure, and writes no list', async () => {
  freshModule()
  const { hooks, catches } = wire()
  const logs: string[] = []
  const submits: unknown[] = []
  const writes: unknown[] = []
  let thrown: unknown = null
  try {
    await todoOf(hooks)(broken(logs, submits, {}, writes) as never, { args: '' } as never, next(false) as never)
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('list unreadable')
  const answer = await (catches[commandKey(COMMAND)] as Handler)(broken(logs, submits, {}, writes) as never, { args: '' } as never, next(false) as never)
  expect(answer).toEqual({ text: FAILED })
  expect(logs).toEqual(['human-plugin: the command.run hook throw: list unreadable'])
  expect(writes).toEqual([])
})

test('/todo <n> still returns the item when its unread mark cannot be cleared: the failed write is logged, and the mark stays', async () => {
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
  expect(await todoOf(hooks)(refusing as never, { args: '1' } as never, next(false) as never)).toEqual({
    text: '  #1 non-blocking: Item 1\n  brief:\n  Brief 1.\n  /todo 1 done\n  /todo 1 reply <text>',
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
  expect(logs.filter(line => line.includes('no clock'))).toEqual(['human-plugin: /todo #1 was written; a step after the write failed: Error: no clock'])
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

// The answer forms through `/todo`: the command's write, the ticker's notice, and the pane's controls, which send the same answers.
type Control = (hooks: Record<string, Handler>, env: unknown) => Promise<void>

// The text `/todo` answers with, as its hook returns it.
const askText = async (hooks: Record<string, Handler>, env: object, args: string): Promise<string> =>
  ((await todoOf(hooks)(env as never, { args } as never, next(false) as never)) as { text: string }).text

// An item answered by `/todo <n> <form>` at clock 1000: the text it answers, the item once the first tick at 1000 has run, and the notices sent.
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

test('an item in its terminal undo window stays in it: /todo <n> done answers that it is not open, and the window still sends the press once', async () => {
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
  const takes = '  #1 takes these answers:\n  /todo 1 1-2\n  /todo 1 reply <text>'
  expect(await askText(hooks, env, '1 done')).toBe(takes)
  for (const args of ['1 0', '1 3', '1 99999999999999999999']) expect(await askText(hooks, env, args)).toBe(takes)
  expect(await askText(hooks, env, '2 yes')).toBe('  #2 takes these answers:\n  /todo 2 done\n  /todo 2 reply <text>')
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
    expect(await askText(wired.hooks, host, '1')).toBe('  #1 non-blocking: Rebuilt ask\n  /todo 1 done\n  /todo 1 reply <text>')
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
    await todoOf(hooks)(unreadable as never, { args: '1 done' } as never, next(false) as never)
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('list unreadable')
  expect(await (catches[commandKey(COMMAND)] as Handler)(unreadable as never, { args: '1 done' } as never, next(false) as never)).toEqual({ text: FAILED })
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

test('with the pane open on the item, a phone reply or done closes the pane once its window has ended, not when the command writes it, as a reply from the pane does', async () => {
  const forms: [string, string][] = [['1 reply Use sqlite', '  answered #1 with Use sqlite'], ['1 done', '  answered #1 with done']]
  for (const [args, confirmation] of forms) {
    reset()
    stopTicker()
    const { hooks } = wire()
    const open: string[] = []
    const timers: Timer[] = []
    const { env, clock } = replyEnv([made(1, { detail: '' }), made(2)], open, null, [], timers)
    await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
    findButton(await band(hooks, env), 'title-1')?.onPress()
    await settle()
    clock.now = 1000
    expect(await askText(hooks, env, args)).toBe(confirmation)
    expect(open, args).toEqual(['human-items'])
    await tickAt(timers, clock, 1000)
    expect(open, args).toEqual([])
  }
})

test('a reply sent by /todo leaves a human turn with its words on the item once the agent reopens it, under the reply notice', async () => {
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
    const words = (await askText(hooks, env, '1')).split('\n').filter(line => line.startsWith('  /todo 1 ')).map(line => line.slice('  /todo 1 '.length))
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
    result: ['Agent TODO: 1 in flight, 2 queued', '- queued: Queued first (ETA: no ETA)', '- in_flight: Running (ETA: no ETA)', '- queued: Queued last (ETA: no ETA)'].join('\n'),
  })
  expect(values.todo).toEqual([entry('Queued first', 'queued'), entry('Running', 'in_flight'), entry('Queued last', 'queued')])
})

test('a call with an empty array empties the list, and one with no array leaves it as it is and lists the entries with their states in written order', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Queued first', 'queued'), entry('Running', 'in_flight')] })
  const before = values.todo
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Agent TODO: 1 in flight, 1 queued\n- queued: Queued first (ETA: no ETA)\n- in_flight: Running (ETA: no ETA)' })
  expect(values.todo).toEqual(before)
  expect(await runTodo(hooks, env, { entries: [] })).toEqual({ result: 'Agent TODO: 0 in flight, 0 queued' })
  expect(values.todo).toEqual([])
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Agent TODO: 0 in flight, 0 queued' })
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

// The `$` with the key of each state write recorded in `keys`, in the order the writes are made.
const recording = (env: ReturnType<typeof memEnv>['env']) => {
  const keys: string[] = []
  const set = env.state.set
  const state = {
    ...env.state,
    set: async (ref: { key: string }, value: unknown) => {
      keys.push(ref.key)
      return set(ref, value)
    },
  }
  return { $: { ...env, state }, keys }
}
// The `$` whose write under `key` throws, every other write going through, and whose log lines are kept in `logs`.
const unwritable = <E extends { state: { set: (ref: { key: string }, value: unknown) => Promise<unknown> }; ui: object }>(env: E, key: string, logs: string[] = []) => ({
  ...env,
  state: {
    ...env.state,
    set: async (ref: { key: string }, value: unknown) => {
      if (ref.key === key) throw new Error(`${key} unwritable`)
      return env.state.set(ref, value)
    },
  },
  ui: { ...env.ui, log: (text: string) => void logs.push(text) },
})
// The first line of the tool's answer, which names the list by its heading and counts it.
const firstLine = (answer: unknown): string => String((answer as { result: string }).result).split('\n')[0] ?? ''

test('a call with a name and entries writes the list and sets the name, and its answer opens with the name and TODO; a name with a colon is kept whole', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  const entries = [entry('Build', 'in_flight'), entry('Ship', 'queued')]
  expect(await runTodo(hooks, env, { name: 'Cachier', entries })).toEqual({
    result: ['Cachier TODO: 1 in flight, 1 queued', '- in_flight: Build (ETA: no ETA)', '- queued: Ship (ETA: no ETA)'].join('\n'),
  })
  expect(values.todoName).toBe('Cachier')
  expect(values.todo).toEqual(entries)
  expect(firstLine(await runTodo(hooks, env, { name: 'Ada: backend', entries }))).toBe('Ada: backend TODO: 1 in flight, 1 queued')
  expect(values.todoName).toBe('Ada: backend')
})

test('a name is stored on one line and trimmed, with the runs of spaces inside it kept, and one of 200 columns is stored and answered whole', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  expect(firstLine(await runTodo(hooks, env, { name: '  Ada\n Lovelace ' }))).toBe('Ada Lovelace TODO: 0 in flight, 0 queued')
  expect(values.todoName).toBe('Ada Lovelace')
  expect(firstLine(await runTodo(hooks, env, { name: 'Ada  Lovelace' }))).toBe('Ada  Lovelace TODO: 0 in flight, 0 queued')
  expect(values.todoName).toBe('Ada  Lovelace')
  const long = 'x'.repeat(200)
  expect(firstLine(await runTodo(hooks, env, { name: long }))).toBe(`${long} TODO: 0 in flight, 0 queued`)
  expect(values.todoName).toBe(long)
})

test('a call with a blank name clears it, and the next answer opens Agent TODO; a call with no name leaves the stored one, whether it writes or reads', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  expect(firstLine(await runTodo(hooks, env, { name: 'Ada' }))).toBe('Ada TODO: 0 in flight, 0 queued')
  expect(firstLine(await runTodo(hooks, env, {}))).toBe('Ada TODO: 0 in flight, 0 queued')
  expect(firstLine(await runTodo(hooks, env, { entries: [entry('Build', 'in_flight')] }))).toBe('Ada TODO: 1 in flight, 0 queued')
  expect(firstLine(await runTodo(hooks, env, { entries: [] }))).toBe('Ada TODO: 0 in flight, 0 queued')
  expect(values.todoName).toBe('Ada')
  expect(firstLine(await runTodo(hooks, env, { name: ' \n ' }))).toBe('Agent TODO: 0 in flight, 0 queued')
  expect(values.todoName).toBe('')
  expect(firstLine(await runTodo(hooks, env, {}))).toBe('Agent TODO: 0 in flight, 0 queued')
  expect(firstLine(await runTodo(hooks, env, { name: 'Grace', entries: [entry('Build', 'in_flight')] }))).toBe('Grace TODO: 1 in flight, 0 queued')
  expect(firstLine(await runTodo(hooks, env, { name: '', entries: [entry('Build', 'in_flight')] }))).toBe('Agent TODO: 1 in flight, 0 queued')
})

test('a call with a name and no entries sets the name and is a read in every other way: the list and the reminder count are not written, and the answer lists the entries under the new name', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  const entries = [entry('Build', 'in_flight'), entry('Ship', 'queued')]
  await runTodo(hooks, env, { entries })
  values.reminder = 42
  const { $, keys } = recording(env)
  expect(await runTodo(hooks, $, { name: 'Ada' })).toEqual({
    result: ['Ada TODO: 1 in flight, 1 queued', '- in_flight: Build (ETA: no ETA)', '- queued: Ship (ETA: no ETA)'].join('\n'),
  })
  expect(keys).toEqual(['todoName'])
  expect(values.todo).toEqual(entries)
  expect(values.reminder).toBe(42)
})

test('a call with a name and entries writes the list before the name, and starts the reminder count over once', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  values.reminder = 42
  const { $, keys } = recording(env)
  await runTodo(hooks, $, { name: 'Ada', entries: [entry('Build', 'in_flight')] })
  expect(keys).toEqual(['todo', 'reminder', 'todoName'])
  expect(values.reminder).toBe(0)
})

test('a call whose name is not text is refused naming the field and applies neither its name nor its entries, and a subagent\'s call with a name is refused and changes nothing', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { name: 'Ada', entries: [entry('Keep me', 'in_flight')] })
  const { $, keys } = recording(env)
  for (const name of [null, 3, true, {}, ['Grace']]) {
    expect(await runTodo(hooks, $, { name, entries: [entry('Would replace', 'queued')] }), JSON.stringify(name)).toEqual({ deny: 'claude_todo: name must be text' })
  }
  const refusal = { deny: 'claude_todo: only the main agent keeps the Claude TODO list' }
  expect(await runTodo(hooks, $, { name: 'Sub', entries: [entry('Sub plan', 'queued')], agentId: 'sub-1' })).toEqual(refusal)
  expect(await runTodo(hooks, $, { name: 'Sub', agentId: 'sub-1' })).toEqual(refusal)
  expect(keys).toEqual([])
  expect(values.todoName).toBe('Ada')
  expect(values.todo).toEqual([entry('Keep me', 'in_flight')])
})

test('a call with a name and entries whose list write throws fails as a call, and neither the list nor the name changes; the next call is answered', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { name: 'Old', entries: [entry('Keep me', 'in_flight')] })
  let thrown: unknown = null
  try {
    await runTodo(hooks, unwritable(env, 'todo'), { name: 'New', entries: [entry('Would replace', 'queued')] })
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('todo unwritable')
  expect(values.todo).toEqual([entry('Keep me', 'in_flight')])
  expect(values.todoName).toBe('Old')
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Old TODO: 1 in flight, 0 queued\n- in_flight: Keep me (ETA: no ETA)' })
})

test('a call with a name and entries whose name write throws logs it, leaves the list as the call wrote it, and is answered, not as a failure, with the list under the name stored before the call', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { name: 'Old', entries: [entry('Keep me', 'in_flight')] })
  const logs: string[] = []
  const written = [entry('Build', 'in_flight'), entry('Ship', 'queued')]
  expect(await runTodo(hooks, unwritable(env, 'todoName', logs), { name: 'New', entries: written })).toEqual({
    result: ['Old TODO: 1 in flight, 1 queued', '- in_flight: Build (ETA: no ETA)', '- queued: Ship (ETA: no ETA)'].join('\n'),
  })
  expect(values.todo).toEqual(written)
  expect(values.todoName).toBe('Old')
  expect(logs).toEqual(["human-plugin: the agent list's name was not stored: Error: todoName unwritable"])
  // A call that states only a name is answered the same way, with the list as it was.
  logs.length = 0
  expect(firstLine(await runTodo(hooks, unwritable(env, 'todoName', logs), { name: 'Newer' }))).toBe('Old TODO: 1 in flight, 1 queued')
  expect(logs).toEqual(["human-plugin: the agent list's name was not stored: Error: todoName unwritable"])
})

test('a reload of the mod keeps the name: the hooks wired again over the same state answer under it', async () => {
  reset()
  const { env, values } = memEnv([], [], null)
  await runTodo(wire().hooks, env, { name: 'Ada', entries: [entry('Build', 'in_flight')] })
  expect(values.todoName).toBe('Ada')
  expect(await runTodo(wire().hooks, env, {})).toEqual({ result: 'Ada TODO: 1 in flight, 0 queued\n- in_flight: Build (ETA: no ETA)' })
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
  expect(await line({ tool: TODO_TOOL, input: { entries }, isRunning: true, isErrored: false })).toEqual(dim('human-plugin: writing the list…'))
  expect(await line({ tool: TODO_TOOL, input: {}, isRunning: true, isErrored: false })).toEqual(dim('human-plugin: reading the list…'))
  expect(await line({ tool: TODO_TOOL, input: { name: 'Ada' }, isRunning: true, isErrored: false })).toEqual(dim('human-plugin: reading the list…'))
  expect(await line({ tool: TODO_TOOL, input: { name: 'Ada: backend', entries }, output: 'Ada: backend TODO: 1 in flight, 1 queued', isRunning: false, isErrored: false })).toEqual(
    dim('human-plugin: Ada: backend TODO 1 in flight, 1 queued'),
  )
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
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Agent TODO: 0 in flight, 0 queued' })
})

test('a /clear whose session.end hook fails part-way still empties the Claude list', async () => {
  reset()
  const { catches } = wire()
  const writes: unknown[] = []
  await (catches['session.end'] as Handler)(broken([], [], { next: 3 }, writes) as never, { reason: 'clear' } as never, next(false) as never)
  expect(writes).toContainEqual([])
})

test('a /clear clears the name: the next answer opens Agent TODO, a call that states a name after it sets it, and a session end that is not a /clear leaves the name', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  await runTodo(hooks, env, { name: 'Ada', entries: [entry('Build', 'in_flight')] })
  await (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
  expect(values.todoName).toBe('Ada')
  await (hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  expect(values.todoName).toBe('')
  expect(await runTodo(hooks, env, {})).toEqual({ result: 'Agent TODO: 0 in flight, 0 queued' })
  expect(await runTodo(hooks, env, { name: 'Ada' })).toEqual({ result: 'Ada TODO: 0 in flight, 0 queued' })
  expect(values.todoName).toBe('Ada')
})

test('a /clear whose session.end hook fails part-way still clears the name', async () => {
  reset()
  const { catches } = wire()
  const writes: unknown[] = []
  await (catches['session.end'] as Handler)(broken([], [], { next: 3 }, writes) as never, { reason: 'clear' } as never, next(false) as never)
  expect(writes).toContainEqual('')
})

test('a /clear clears the name whichever of the two emptyings throws, the human list\'s or the Claude list\'s, once the hook and its failure handler have run, and the failure handler alone clears it too', async () => {
  for (const key of ['list', 'todo']) {
    reset()
    const { hooks, catches } = wire()
    const { env, values } = memEnv([made(1, { detail: '' })], [], null)
    values.todo = [entry('Build', 'in_flight')]
    const failing = unwritable(env, key)
    const attempt = async (run: () => unknown): Promise<void> => {
      await Promise.resolve()
        .then(run)
        .catch(() => undefined)
    }
    const clear = { reason: 'clear' }
    values.todoName = 'Ada'
    await attempt(() => (hooks['session.end'] as Handler)(failing as never, clear as never, next(false) as never))
    await attempt(() => (catches['session.end'] as Handler)(failing as never, clear as never, next(false) as never))
    expect(values.todoName, `${key}, the hook and its failure handler`).toBe('')
    expect(values.todo, `${key}, the Claude list`).toEqual(key === 'todo' ? [entry('Build', 'in_flight')] : [])
    expect((values.list as { items: unknown[] }).items, `${key}, the human list`).toEqual(key === 'list' ? [made(1, { detail: '' })] : [])
    values.todoName = 'Ada'
    await attempt(() => (catches['session.end'] as Handler)(failing as never, clear as never, next(false) as never))
    expect(values.todoName, `${key}, the failure handler alone`).toBe('')
  }
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
  expect(await first).toEqual({ result: 'Agent TODO: 0 in flight, 1 queued\n- queued: First (ETA: no ETA)' })
  expect(await second).toEqual({ result: 'Agent TODO: 1 in flight, 0 queued\n- in_flight: Second (ETA: no ETA)' })
  expect(await read).toEqual({ result: 'Agent TODO: 1 in flight, 0 queued\n- in_flight: Second (ETA: no ETA)' })
  expect(values.todo).toEqual([entry('Second', 'in_flight')])
})

// The `/claude-todo` command: the Claude TODO list printed as text, registered to run mid-turn, waiting for a rebuild as `/todo` does.
const claudeTodo = (hooks: Record<string, Handler>, env: unknown, args = '') => claudeTodoOf(hooks)(env as never, { args } as never, next(false) as never)

test('/claude-todo prints the Claude list the tool keeps: the in-flight items, then the queued ones, each in written order', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTodo(hooks, env, { entries: [entry('Queued first', 'queued'), entry('Running', 'in_flight'), entry('Queued last', 'queued')] })
  expect(await claudeTodo(hooks, env)).toEqual({
    text: '  Agent TODO: 1 in flight, 2 queued\n  in flight:\n    ◐ Running · no ETA\n  queued:\n    ○ Queued first · no ETA\n    ○ Queued last · no ETA',
  })
  await runTodo(hooks, env, { entries: [] })
  expect(await claudeTodo(hooks, env)).toEqual({ text: '  The Agent TODO list is empty.' })
})

test('/claude-todo prints the name the agent stated in its counting line and in its empty line, and Agent TODO with none stated or after a blank one', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([], [], null)
  await runTodo(hooks, env, { name: 'Ada', entries: [entry('Queued first', 'queued'), entry('Running', 'in_flight'), entry('Queued last', 'queued')] })
  expect(await claudeTodo(hooks, env)).toEqual({
    text: '  Ada TODO: 1 in flight, 2 queued\n  in flight:\n    ◐ Running · no ETA\n  queued:\n    ○ Queued first · no ETA\n    ○ Queued last · no ETA',
  })
  await runTodo(hooks, env, { entries: [] })
  expect(await claudeTodo(hooks, env)).toEqual({ text: '  The Ada TODO list is empty.' })
  await runTodo(hooks, env, { name: 'Ada: backend' })
  expect(await claudeTodo(hooks, env)).toEqual({ text: '  The Ada: backend TODO list is empty.' })
  await runTodo(hooks, env, { name: ' ' })
  expect(await claudeTodo(hooks, env)).toEqual({ text: '  The Agent TODO list is empty.' })
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
const REBUILT_TEXT = '  Agent TODO: 1 in flight, 0 queued\n  in flight:\n    ◐ Rebuilt step · no ETA'

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
// What a drawn subtree shows: its strings in drawing order. A step's glyph and its title are two texts, so a step reads through this and not through `flat`.
const textOf = (node: unknown): string => (typeof node === 'string' ? node : ((node as Tree).children ?? []).map(textOf).join(''))

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
  expect(wide.children?.map(c => c.width)).toEqual([64, 56])
  expect(textOf(wide.children?.[1])).toContain('○ Write the tests')
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
  const at52 = flat(await bandAt(hooks, env, 52, {}, surface)).includes('Agent TODO')
  expect(flat(await bandAt(hooks, env, 56, {}, surface)).includes('Agent TODO'), `a band of 56 columns on ${surface} agrees with one of 52`).toBe(at52)
  return at52
}
// The session's end that starts a test. The module keeps the pane's records from one test to the next, and a session's end closes a pane that shows the Claude list, so the last
// test's session ends first, on a `$` of its own, and the close it makes is not asked of this test's.
const endSession = async (hooks: Record<string, Handler>, env: unknown) => {
  const last = { ui: { close: async () => {}, log: () => {} } }
  await (hooks['session.end'] as Handler)(last as never, { reason: 'exit' } as never, next(false) as never)
  await settle()
  return (hooks['session.end'] as Handler)(env as never, { reason: 'exit' } as never, next(false) as never)
}
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
  expect(textOf(docked.children?.[1])).toContain('◐ Running')
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
  const hasColumn = (tree: Tree): boolean => flat(tree).includes('Agent TODO')
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
  expect(flat(inFlight)).not.toContain('Agent TODO')
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

test('with no human items a step in the agent\'s list, queued or in flight, draws the column alone, 56 wide, and an empty list hands on', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  const e = { props: { hasSurvey: false, maxRows: 20, bodyColumns: 120 } }
  values.todo = [entry('Only queued', 'queued')]
  const queuedOnly = await bandAt(hooks, env, 120)
  expect(queuedOnly.children?.map(c => c.width)).toEqual([56])
  expect(textOf(queuedOnly)).toContain('○ Only queued')
  values.todo = [entry('Running', 'in_flight'), entry('Later', 'queued')]
  const tree = await bandAt(hooks, env, 120)
  expect(tree.children?.map(c => c.width)).toEqual([56])
  expect(textOf(tree)).toContain('◐ Running')
  expect(textOf(tree)).toContain('○ Later')
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
  expect(flat(await bandAt(hooks, env, 120))).not.toContain('Agent TODO')
  await runTodo(hooks, env, { entries: [entry('Build', 'in_flight'), entry('Test', 'queued')] })
  const wide = await bandAt(hooks, env, 120)
  // The header is the heading as text, then the counts as a button.
  expect(flat(wide)).toContain('Agent TODO ')
  expect(flat(wide)).toContain('1 active, 1 queued')
  expect(textOf(wide)).toContain('◐ Build')
  await runTodo(hooks, env, { entries: [] })
  expect(flat(await bandAt(hooks, env, 120))).not.toContain('Agent TODO')
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
  expect(await runTodo(hooks, failing, { entries: [entry('Build', 'in_flight')] })).toEqual({ result: 'Agent TODO: 1 in flight, 0 queued\n- in_flight: Build (ETA: no ETA)' })
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

// The backlog pane: the Claude list, shown in the pane's one id in place of a human item. `backlogEnv` keeps every open request whole, every close and every redraw the
// mod asks for, over the in-memory list, selection and pane; `open` is the engine's list of panes, which a test may change as the engine would.
type OpenAsked = { id: string; title?: string; rows?: number; focus?: true }
const backlogEnv = (items: unknown[], open: string[], selection: unknown, todo: object[], timers: Timer[] = []) => {
  const { env, values, clock } = memEnv(items, open, selection, [], timers)
  values.todo = todo
  const opens: OpenAsked[] = []
  const closes: string[] = []
  const asked: string[] = []
  const $ = {
    ...env,
    ui: {
      ...env.ui,
      invalidate: (event: string) => void asked.push(event),
      open: async (args: OpenAsked) => {
        opens.push(args)
        return env.ui.open(args)
      },
      close: async (args: { id: string }) => {
        closes.push(args.id)
        return env.ui.close(args)
      },
    },
  }
  return { $, env, values, clock, opens, closes, asked, open }
}
// Presses the button keyed `key` on a drawn tree. A button that is not there fails the test, instead of a press that does nothing.
const pressKey = (tree: unknown, key: string): void => {
  const target = findButton(tree, key)
  if (target === undefined) throw new Error(`no button keyed ${key} in the tree`)
  target.onPress()
}
// One item in flight and five queued. A band of 120 columns beside two human items draws the column's header, the in-flight row and `+5 queued`.
const RUNNING = entry('Build the pane', 'in_flight')
const SIX = [RUNNING, ...[1, 2, 3, 4, 5].map(k => entry(`Queued ${k}`, 'queued'))]
// A drawn backlog's lines: each child of its root is a line, the header's text or an item's glyph, title and ETA tail in drawing order.
const linesOf = (tree: unknown): string[] => ((tree as Tree).children ?? []).map(textOf)
// An item's row is its glyph in a box that does not shrink, its title in a box that gives way, holding a text set to cut at its end, and an ETA tail that does not shrink, holding a dim text: each part's
// shrink, then its text's colour, wrap and dim. The glyph takes its state's colour, and the title is dim when the item is queued.
const shapeOf = (row: Tree): unknown[] => (row.children ?? []).map(part => [part.flexShrink, (part.children?.[0] as Tree).color, (part.children?.[0] as Tree).wrap, (part.children?.[0] as Tree).dimColor])
const FLYING_SHAPE = [[0, 'suggestion', undefined, undefined], [1, undefined, 'truncate-end', undefined], [0, undefined, undefined, true]]
const QUEUED_SHAPE = [[0, 'planMode', undefined, undefined], [1, undefined, 'truncate-end', true], [0, undefined, undefined, true]]
const ITEM_ONE = '#1 non-blocking, open: Item 1'

test('a press on the Claude counts and on +N queued each opens the pane on the Claude list within the press: one request, titled Agent TODO, with a row for the header and one for each item of the whole list, and the keyboard', async () => {
  for (const key of ['claude-header', 'claude-queued']) {
    reset()
    const { hooks } = wire()
    const { $, values, opens, open } = backlogEnv([made(1), made(2)], [], null, SIX)
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), key)
    // Before anything the press awaits: an open made after an await is not counted as asked.
    expect(opens, key).toEqual([{ id: 'human-items', title: 'Agent TODO', rows: 7, focus: true }])
    await settle()
    expect(open, key).toEqual(['human-items'])
    expect(values.selection, key).toBe('claude-todo')
  }
})

test('the pane on the Claude list draws a header line with the counts in the long form, then every item, in-flight first and each group in written order, each a glyph, a title set to cut at its end and its dim ETA tail; no control, and no state written', async () => {
  reset()
  const { hooks } = wire()
  const { $ } = backlogEnv([made(1)], [], 'claude-todo', [entry('Queued first', 'queued', 'after tests'), entry('Build', 'in_flight', '~10 min'), entry('Queued second', 'queued')])
  await endSession(hooks, $)
  const tree = await paneTree(hooks, $)
  expect(linesOf(tree)).toEqual(['Agent TODO 1 in flight, 2 queued', '◐ Build · ~10 min', '○ Queued first · after tests', '○ Queued second · no ETA'])
  const [header, ...rows] = (tree as Tree).children ?? []
  expect(header?.wrap).toBe('truncate-end')
  expect(rows.map(shapeOf)).toEqual([FLYING_SHAPE, QUEUED_SHAPE, QUEUED_SHAPE])
  expect(flat(tree)).not.toContain('"type":"Button"')
  expect(flat(tree)).not.toContain('"type":"Markdown"')
})

// A Claude list as an earlier cut stored it: two families, then 👨 U+200D 👩 U+200D and the ellipsis, 29 units under the cap of 30. Every read of the list is normalized (todo.ts), so each view
// shows the ETA repaired from the next read, and a write or a rebuild stores it so.
const ZWJ = String.fromCodePoint(0x200d)
const TWO_FAMILIES = ['👨', '👩', '👧', '👦'].join(ZWJ).repeat(2)
const SPLIT_ETA = `${TWO_FAMILIES}👨${ZWJ}👩${ZWJ}…`
const REPAIRED_ETA = `${TWO_FAMILIES}…`

test('a read of a Claude list stored with a split ETA returns the ETA repaired and stores nothing', async () => {
  const { env, values } = memEnv([], [], null)
  values.todo = [entry('Build', 'queued', SPLIT_ETA)]
  expect(await readTodo(env as never)).toEqual([entry('Build', 'queued', REPAIRED_ETA)])
  expect(values.todo).toEqual([entry('Build', 'queued', SPLIT_ETA)])
})

test('the tool\'s read of a Claude list stored with a split ETA answers the ETA repaired and stores nothing', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  values.todo = [entry('Build', 'queued', SPLIT_ETA)]
  expect(await runTodo(hooks, env, {})).toEqual({ result: `Agent TODO: 0 in flight, 1 queued\n- queued: Build (ETA: ${REPAIRED_ETA})` })
  expect(values.todo).toEqual([entry('Build', 'queued', SPLIT_ETA)])
})

test('a write that gives a split ETA verbatim stores the ETA repaired and answers it so', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  expect(await runTodo(hooks, env, { entries: [entry('Build', 'queued', SPLIT_ETA)] })).toEqual({ result: `Agent TODO: 0 in flight, 1 queued\n- queued: Build (ETA: ${REPAIRED_ETA})` })
  expect(values.todo).toEqual([entry('Build', 'queued', REPAIRED_ETA)])
})

test('/claude-todo over a Claude list stored with a split ETA prints the ETA repaired', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([], [], null)
  values.todo = [entry('Build', 'queued', SPLIT_ETA)]
  expect(await claudeTodo(hooks, env)).toEqual({ text: `  Agent TODO: 0 in flight, 1 queued\n  queued:\n    ○ Build · ${REPAIRED_ETA}` })
})

test('the pane on a Claude list stored with a split ETA draws the ETA repaired', async () => {
  reset()
  const { hooks } = wire()
  const { $ } = backlogEnv([made(1)], [], 'claude-todo', [entry('Build', 'queued', SPLIT_ETA)])
  await endSession(hooks, $)
  expect(linesOf(await paneTree(hooks, $))).toEqual(['Agent TODO 0 in flight, 1 queued', `○ Build · ${REPAIRED_ETA}`])
})

test('a rebuild over a Claude list stored with a split ETA stores that list with the ETA repaired, whatever the transcript gave', async () => {
  const { env, values } = memEnv([], [], null)
  values.todo = [entry('Build', 'queued', SPLIT_ETA)]
  await fillTodo(env as never, [{ title: 'From the transcript', state: 'in_flight', eta: NO_ETA }])
  expect(values.todo).toEqual([entry('Build', 'queued', REPAIRED_ETA)])
})

test('with no human items the band draws the Claude column\'s header, its in-flight rows and one +2 queued line for the queued items, and a press on its header opens the pane with the queued items too; a second press closes it', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([], [], null, [RUNNING, entry('Later', 'queued'), entry('Latest', 'queued')])
  await endSession(hooks, $)
  const tree = await bandAt(hooks, $, 120)
  expect(flat(tree)).not.toContain('Later')
  expect(flat(tree)).toContain('"label":"+2 queued"')
  pressKey(tree, 'claude-header')
  await settle()
  expect(opens).toEqual([{ id: 'human-items', title: 'Agent TODO', rows: 4, focus: true }])
  expect(linesOf(await paneTree(hooks, $))).toEqual(['Agent TODO 1 in flight, 2 queued', '◐ Build the pane · no ETA', '○ Later · no ETA', '○ Latest · no ETA'])
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('a press on +N queued in a column drawn alone opens the pane and a second press closes it, at 120 columns and at 11, where the header has no counts to press', async () => {
  for (const columns of [120, 11]) {
    reset()
    const { hooks } = wire()
    const { $, opens, closes, open } = backlogEnv([], [], null, [entry('Next', 'queued'), entry('Then', 'queued'), entry('Last', 'queued')])
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, columns), 'claude-queued')
    // Before anything the press awaits: an open made after an await is not counted as asked.
    expect(opens, `${columns}`).toEqual([{ id: 'human-items', title: 'Agent TODO', rows: 4, focus: true }])
    await settle()
    expect(open, `${columns}`).toEqual(['human-items'])
    pressKey(await bandAt(hooks, $, columns), 'claude-queued')
    await settle()
    expect(opens, `${columns}`).toHaveLength(1)
    expect(closes, `${columns}`).toEqual(['human-items'])
    expect(open, `${columns}`).toEqual([])
  }
})

test('a press on the Claude column while the pane shows the Claude list closes the pane, and the next one opens it again', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([made(1), made(2)], [], null, SIX)
  await endSession(hooks, $)
  for (const key of ['claude-header', 'claude-header', 'claude-header', 'claude-queued']) {
    pressKey(await bandAt(hooks, $, 120), key)
    await settle()
  }
  expect(opens).toHaveLength(2)
  expect(closes).toEqual(['human-items', 'human-items'])
  expect(open).toEqual([])
})

test('two presses on the Claude column before the band draws again, from a closed pane, open the pane and then close it', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([made(1), made(2)], [], null, SIX)
  await endSession(hooks, $)
  const tree = await bandAt(hooks, $, 120)
  pressKey(tree, 'claude-header')
  pressKey(tree, 'claude-header')
  await settle()
  expect(opens).toHaveLength(1)
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('from a pane on a human item, two presses on the Claude column before the band draws again switch it to the backlog and then close it', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([made(1), made(2)], [], null, SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  const tree = await bandAt(hooks, $, 120)
  pressKey(tree, 'claude-header')
  pressKey(tree, 'claude-queued')
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Items for you', 'Agent TODO'])
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('with the pane on item 3, a press on the Claude column and then one on item 3\'s title before the band draws again switch the pane to the backlog and then to item 3, and leave it open', async () => {
  reset()
  const { hooks } = wire()
  const { $, values, opens, closes, open } = backlogEnv([made(1), made(2), made(3)], [], null, SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'title-3')
  await settle()
  const tree = await bandAt(hooks, $, 120)
  pressKey(tree, 'claude-header')
  pressKey(tree, 'title-3')
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Items for you', 'Agent TODO', 'Items for you'])
  expect(closes).toEqual([])
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe(3)
  expect(flat(await paneTree(hooks, $))).toContain('#3 non-blocking, open: Item 3')
})

// A press opens the pane from the Claude list the band drew last, within the press. A write made since, with the pane not showing the list, asked the pane nothing, so the press looks at the
// stored list once its open has settled.
const THREE = [RUNNING, entry('Next', 'queued'), entry('Then', 'queued')]

test('a press on the Claude column made after a write changed the number of items and before the band draws again opens the pane within the press from the list drawn last, and then asks again for the rows of the list now', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens } = backlogEnv([made(1), made(2)], [], null, THREE)
  await endSession(hooks, $)
  const tree = await bandAt(hooks, $, 120)
  await runTodo(hooks, $, { entries: SIX })
  pressKey(tree, 'claude-header')
  expect(opens.map(o => o.rows)).toEqual([4])
  await settle()
  expect(opens.map(o => o.rows)).toEqual([4, 7])
  expect(linesOf(await paneTree(hooks, $))).toHaveLength(7)
})

test('the same press from a pane on a human item switches it within the press from the list drawn last, and then asks again for the rows of the list now', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens } = backlogEnv([made(1), made(2)], [], null, THREE)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  const tree = await bandAt(hooks, $, 120)
  await runTodo(hooks, $, { entries: SIX })
  pressKey(tree, 'claude-header')
  expect(opens.map(o => o.title)).toEqual(['Items for you', 'Agent TODO'])
  expect(opens.map(o => o.rows).slice(1)).toEqual([4])
  await settle()
  expect(opens.map(o => o.rows).slice(1)).toEqual([4, 7])
})

test('a press on the Claude column made after a write emptied the list and before the band draws again does not leave the pane open on its header line alone, from a closed pane or from a pane on a human item', async () => {
  for (const onItem of [false, true]) {
    reset()
    const { hooks } = wire()
    const { $, open } = backlogEnv([made(1), made(2)], [], null, THREE)
    await endSession(hooks, $)
    if (onItem) {
      pressKey(await bandAt(hooks, $, 120), 'title-1')
      await settle()
    }
    const tree = await bandAt(hooks, $, 120)
    await runTodo(hooks, $, { entries: [] })
    pressKey(tree, 'claude-header')
    await settle()
    expect(open, onItem ? 'on an item' : 'closed').toEqual([])
  }
})

test('a second press on the Claude column before the first has looked at the stored list closes the pane, and the first press then asks it nothing more', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([made(1), made(2)], [], null, THREE)
  await endSession(hooks, $)
  const tree = await bandAt(hooks, $, 120)
  await runTodo(hooks, $, { entries: SIX })
  pressKey(tree, 'claude-header')
  pressKey(tree, 'claude-header')
  await settle()
  expect(opens.map(o => o.rows)).toEqual([4])
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('with the pane on a human item a press on the Claude column shows the Claude list in the same pane; with it on the Claude list a press on a human title and on the summary row each switch it again: the engine lists one pane after each', async () => {
  reset()
  const { hooks } = wire()
  const { $, values, opens, closes } = backlogEnv([1, 2, 3, 4, 5, 6].map(id => made(id)), [], null, SIX)
  await endSession(hooks, $)
  const press = async (key: string, extra: Record<string, unknown> = {}): Promise<[string | undefined, unknown, string[]]> => {
    pressKey(await bandAt(hooks, $, 120, extra), key)
    await settle()
    return [opens[opens.length - 1]?.title, values.selection, (await $.ui.panes()).map(pane => pane.id)]
  }
  expect(await press('title-1')).toEqual(['Items for you', 1, ['human-items']])
  expect(await press('claude-header')).toEqual(['Agent TODO', 'claude-todo', ['human-items']])
  expect(await press('title-2')).toEqual(['Items for you', 2, ['human-items']])
  expect(await press('claude-header')).toEqual(['Agent TODO', 'claude-todo', ['human-items']])
  // The band given four rows folds the items from the third on, and its summary row opens the first of them.
  expect(await press('band-more', { maxRows: 4 })).toEqual(['Items for you', 3, ['human-items']])
  expect(closes).toEqual([])
})

test('a stored selection that is an item number opens on that item, claude-todo opens the Claude list, and any other stored value opens as no selection does: on the first item', async () => {
  const cases: [unknown, string][] = [
    [2, '#2 non-blocking, open: Item 2'],
    [null, ITEM_ONE],
    ['claude-todo', 'Agent TODO 1 in flight, 0 queued'],
    ['claude-list', ITEM_ONE],
    ['2', ITEM_ONE],
    [true, ITEM_ONE],
    [{ id: 2 }, ITEM_ONE],
    [[2], ITEM_ONE],
    [0, ITEM_ONE],
    [-2, ITEM_ONE],
    [1.5, ITEM_ONE],
  ]
  for (const [stored, shown] of cases) {
    reset()
    const { hooks } = wire()
    const { $ } = backlogEnv([made(1), made(2)], [], stored, [RUNNING])
    await endSession(hooks, $)
    expect(flat(await paneTree(hooks, $)), JSON.stringify(stored)).toContain(shown)
  }
})

test('a stored selection that is no item number and not claude-todo counts as none for a press too: with the pane open on the first item, a press on its title closes the pane', async () => {
  reset()
  const { hooks } = wire()
  const open = ['human-items']
  const { $, closes } = backlogEnv([made(1), made(2)], open, 'garbage', SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('with no selection stored the first human item counts as the shown one: with the pane open on it a press on its title closes the pane, and one on the Claude column switches it to the backlog', async () => {
  for (const [key, title] of [['title-1', undefined], ['claude-header', 'Agent TODO']] as const) {
    reset()
    const { hooks } = wire()
    const open = ['human-items']
    const { $, opens, closes } = backlogEnv([made(1), made(2)], open, null, SIX)
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), key)
    await settle()
    expect(opens.map(o => o.title), key).toEqual(title === undefined ? [] : [title])
    expect(closes, key).toEqual(title === undefined ? ['human-items'] : [])
    expect(open, key).toEqual(title === undefined ? [] : ['human-items'])
  }
})

test('after a reload with the backlog open and no press made since, a press on the Claude column closes the pane, and a press on a human title shows that item in the same pane', async () => {
  for (const [key, closed] of [['claude-header', true], ['claude-queued', true], ['title-1', false], ['title-2', false]] as const) {
    reset()
    const { hooks } = wire()
    const open = ['human-items']
    const { $, values, opens, closes } = backlogEnv([made(1), made(2)], open, 'claude-todo', SIX)
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), key)
    await settle()
    expect(closes, key).toEqual(closed ? ['human-items'] : [])
    expect(open, key).toEqual(closed ? [] : ['human-items'])
    expect(opens.map(o => o.title), key).toEqual(closed ? [] : ['Items for you'])
    expect(values.selection, key).toBe(closed ? 'claude-todo' : Number(key.slice(-1)))
  }
})

test('after a reload with the pane on item 2, a press on the Claude column switches it to the backlog and a press on item 2\'s title closes it', async () => {
  for (const [key, title] of [['claude-header', 'Agent TODO'], ['title-2', undefined]] as const) {
    reset()
    const { hooks } = wire()
    const open = ['human-items']
    const { $, opens, closes } = backlogEnv([made(1), made(2)], open, 2, SIX)
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), key)
    await settle()
    expect(opens.map(o => o.title), key).toEqual(title === undefined ? [] : [title])
    expect(closes, key).toEqual(title === undefined ? ['human-items'] : [])
  }
})

test('with the pane on the Claude list no band row of the human list is the shown item: a press on the first item\'s title shows it, where with no selection it would close the pane', async () => {
  reset()
  const { hooks } = wire()
  const { $, values, opens, closes } = backlogEnv([made(1), made(2)], [], null, SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Agent TODO', 'Items for you'])
  expect(closes).toEqual([])
  expect(values.selection).toBe(1)
})

test('opening the Claude list from a closed pane, and switching to it from an item, leave every human item\'s unread mark as it was; switching back to an item reads that item alone', async () => {
  reset()
  const { hooks } = wire()
  const unread = [made(1, { unread: true }), made(2, { unread: true })]
  const { $, values } = backlogEnv(unread, [], null, SIX)
  await endSession(hooks, $)
  const marks = (): boolean[] => (values.list as { items: { unread: boolean }[] }).items.map(it => it.unread)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(marks()).toEqual([true, true])
  // An item opened from closed reads every item (the pane's open does), and the marks are raised again for the switch to the backlog.
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  expect(marks()).toEqual([false, false])
  values.list = { items: [made(1, { unread: true }), made(2, { unread: true })], next: 3 }
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(marks()).toEqual([true, true])
  pressKey(await bandAt(hooks, $, 120), 'title-2')
  await settle()
  expect(marks()).toEqual([true, false])
})

test('a write that adds two items to the Claude list redraws the pane on it with them and asks again for two rows more, before the call answers', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3])
  await runTodo(hooks, $, { entries: [RUNNING, entry('Next', 'queued'), entry('Then', 'queued'), entry('Last', 'queued')] })
  expect(opens).toEqual([
    { id: 'human-items', title: 'Agent TODO', rows: 3, focus: true },
    { id: 'human-items', title: 'Agent TODO', rows: 5, focus: true },
  ])
  expect(linesOf(await paneTree(hooks, $))).toEqual(['Agent TODO 1 in flight, 3 queued', '◐ Build the pane · no ETA', '○ Next · no ETA', '○ Then · no ETA', '○ Last · no ETA'])
})

test('a write that changes an item\'s state and keeps the number of items makes no new open request, and the pane draws the new state', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued'), entry('Then', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  await runTodo(hooks, $, { entries: [RUNNING, entry('Next', 'in_flight'), entry('Then', 'queued')] })
  await runTodo(hooks, $, { entries: [RUNNING, entry('Renamed', 'in_flight', '~5 min'), entry('Then', 'queued')] })
  await settle()
  expect(opens).toHaveLength(1)
  expect(closes).toEqual([])
  expect(linesOf(await paneTree(hooks, $))).toEqual(['Agent TODO 2 in flight, 1 queued', '◐ Build the pane · no ETA', '◐ Renamed · ~5 min', '○ Then · no ETA'])
})

test('after an open the pane refuses, the next write with the count that open asked for asks again, and the failure is logged; once an open is taken, a write that keeps the count asks for nothing', async () => {
  reset()
  const { hooks } = wire()
  const { env, $: engine, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  const logs: string[] = []
  const $ = { ...engine, ui: { ...engine.ui, log: (text: string) => void logs.push(text) } }
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3])
  const four = [RUNNING, entry('A', 'queued'), entry('B', 'queued'), entry('C', 'queued')]
  const taken = env.ui.open
  env.ui.open = async () => {
    throw new Error('open refused')
  }
  await runTodo(hooks, $, { entries: four })
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3, 5])
  expect(logs.some(line => line.includes('open refused'))).toBe(true)
  env.ui.open = taken
  await runTodo(hooks, $, { entries: four })
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3, 5, 5])
  await runTodo(hooks, $, { entries: four })
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3, 5, 5])
})

test('a write made while the pane\'s last open is still in flight is compared with the rows that open asked for: one that brings the count back to the one before it asks again, so the request ends at the second write\'s rows', async () => {
  reset()
  const { hooks } = wire()
  const { env, $, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3])
  const taken = env.ui.open
  let release: () => void = () => {}
  env.ui.open = () => new Promise<{ isPlaced: boolean }>(resolve => (release = () => resolve({ isPlaced: true })))
  await runTodo(hooks, $, { entries: [RUNNING, entry('A', 'queued'), entry('B', 'queued'), entry('C', 'queued')] })
  await settle()
  env.ui.open = taken
  await runTodo(hooks, $, { entries: [RUNNING, entry('Next', 'queued')] })
  await settle()
  release()
  await settle()
  expect(opens.map(o => o.rows)).toEqual([3, 5, 3])
})

test('a write that empties the Claude list closes the pane on it', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([made(1)], [], null, SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  await runTodo(hooks, $, { entries: [] })
  await settle()
  expect(opens).toHaveLength(1)
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('two writes made back to back, the first held up in its follow-up, leave the pane\'s request at the second write\'s rows: each follow-up runs inside its call, in the calls\' order', async () => {
  reset()
  const { hooks } = wire()
  const { env, $, values, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  // The first call's follow-up reads the selection: hold that read until the second call has been made.
  let release: () => void = () => {}
  let held = false
  const get = env.state.get
  env.state.get = async ref => {
    if (ref.key === 'selection' && !held) {
      held = true
      await new Promise<void>(resolve => (release = resolve))
    }
    return get(ref)
  }
  const four = [RUNNING, entry('A', 'queued'), entry('B', 'queued'), entry('C', 'queued')]
  const six = [...four, entry('D', 'queued'), entry('E', 'queued')]
  const first = runTodo(hooks, $, { entries: four })
  const second = runTodo(hooks, $, { entries: six })
  await settle()
  // The second call has not started its write: the first is still inside its call.
  expect(values.todo).toEqual(four)
  release()
  await Promise.all([first, second])
  expect(opens.map(o => o.rows)).toEqual([3, 5, 7])
  expect(values.todo).toEqual(six)
})

// The headings a stored name gives: none stated and a name cleared (the empty text) both draw Agent TODO.
const STATED_HEADINGS = [[undefined, 'Agent TODO'], ['', 'Agent TODO'], ['Ada', 'Ada TODO'], ['Ada: backend', 'Ada: backend TODO']] as const

test('the column\'s header and the pane\'s header line read the name the agent stated as it is stored when they are drawn, and Agent TODO where none is stated or it was cleared', async () => {
  reset()
  const { hooks } = wire()
  const { $, values } = backlogEnv([made(1), made(2)], [], 'claude-todo', [RUNNING, entry('Later', 'queued'), entry('Latest', 'queued')])
  await endSession(hooks, $)
  for (const [stated, heading] of STATED_HEADINGS) {
    values.todoName = stated
    const drawnBand = flat(await bandAt(hooks, $, 120))
    expect(drawnBand, heading).toContain(`"children":["${heading} "]`)
    expect(drawnBand, heading).toContain('"label":"1 active, 2 queued"')
    expect(linesOf(await paneTree(hooks, $))[0], heading).toBe(`${heading} 1 in flight, 2 queued`)
  }
})

test('the column and the pane cut the name first where the width does not hold the whole heading, the counts staying whole and pressable in the column', async () => {
  reset()
  const { hooks } = wire()
  const { $, values } = backlogEnv([made(1), made(2)], [], 'claude-todo', [RUNNING, entry('Later', 'queued'), entry('Latest', 'queued')])
  await endSession(hooks, $)
  values.todoName = 'x'.repeat(60)
  // The band's 96 columns give the Claude column 31 to lay out in.
  const drawnBand = await bandAt(hooks, $, 96)
  expect(flat(drawnBand)).toContain('"children":["xxxxxx… TODO "]')
  expect(flat(drawnBand)).toContain('"label":"1 active, 2 queued"')
  expect(findButton(drawnBand, 'claude-header')).not.toBeUndefined()
  // The pane's header line is the whole 87 columns of the line in a body that holds them, and the name is cut to the 21 columns the words and counts leave it in a body of 48.
  const header = async (bodyColumns: number): Promise<Tree | undefined> => {
    const tree = (await drawn($, () => hooks['ui.render {"component":"Pane","requestId":"human-items"}']?.($ as never, { props: { bodyColumns } } as never, next(false) as never))) as Tree
    return tree.children?.[0]
  }
  expect((await header(100))?.wrap).toBe('truncate-end')
  expect(textOf(await header(100))).toBe(`${'x'.repeat(60)} TODO 1 in flight, 2 queued`)
  expect(textOf(await header(48))).toBe(`${'x'.repeat(20)}… TODO 1 in flight, 2 queued`)
})

test('a press on the column\'s counts opens the pane titled with the heading the band drew last, with the rows of the list it drew, before the press awaits anything', async () => {
  for (const [stated, heading] of STATED_HEADINGS) {
    reset()
    const { hooks } = wire()
    const { $, values, opens } = backlogEnv([made(1), made(2)], [], null, THREE)
    values.todoName = stated
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), 'claude-header')
    expect(opens, heading).toEqual([{ id: 'human-items', title: heading, rows: 4, focus: true }])
    await settle()
    expect(opens, heading).toHaveLength(1)
  }
})

test('a press on the Claude column opens the pane from the heading and the list the last draw of either the band or the pane\'s own Claude view read', async () => {
  for (const drawer of ['pane', 'band'] as const) {
    reset()
    const { hooks } = wire()
    const { $, values, opens } = backlogEnv([made(1), made(2)], [], 'claude-todo', THREE)
    values.todoName = 'Old'
    await endSession(hooks, $)
    const tree = await bandAt(hooks, $, 120)
    // The agent renames the list and gives it more steps, and one of the two views is drawn before the press, with the band's drawing in the tree the press is made on.
    values.todoName = 'Ada'
    values.todo = SIX
    if (drawer === 'pane') await paneTree(hooks, $)
    else await bandAt(hooks, $, 120)
    pressKey(tree, 'claude-header')
    expect(opens, drawer).toEqual([{ id: 'human-items', title: 'Ada TODO', rows: 7, focus: true }])
    await settle()
    expect(opens, drawer).toHaveLength(1)
  }
})

test('with the pane on the Claude list, a call that only names the list asks the pane again with the new name as its title and the rows it had, and one that states the same name asks nothing', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Agent TODO'])
  await runTodo(hooks, $, { name: 'Ada' })
  expect(opens).toEqual([
    { id: 'human-items', title: 'Agent TODO', rows: 3, focus: true },
    { id: 'human-items', title: 'Ada TODO', rows: 3, focus: true },
  ])
  expect(linesOf(await paneTree(hooks, $))[0]).toBe('Ada TODO 1 in flight, 1 queued')
  // The same name, in another spelling of it, and a write that restates the list under it, ask nothing.
  await runTodo(hooks, $, { name: 'Ada' })
  await runTodo(hooks, $, { name: '  Ada ' })
  await runTodo(hooks, $, { name: 'Ada', entries: [RUNNING, entry('Next', 'queued')] })
  await runTodo(hooks, $, { entries: [RUNNING, entry('Next', 'queued')] })
  await settle()
  expect(opens).toHaveLength(2)
  // A blank name clears it, and the title is the default again.
  await runTodo(hooks, $, { name: ' ' })
  expect(opens.map(o => o.title)).toEqual(['Agent TODO', 'Ada TODO', 'Agent TODO'])
  expect(linesOf(await paneTree(hooks, $))[0]).toBe('Agent TODO 1 in flight, 1 queued')
})

test('with the pane on the Claude list, a call with entries and a new name asks the pane once, with the new name as its title, whether the call keeps the count or changes it', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  await runTodo(hooks, $, { name: 'Ada', entries: [RUNNING, entry('Other', 'queued')] })
  expect(opens.map(o => [o.title, o.rows])).toEqual([['Agent TODO', 3], ['Ada TODO', 3]])
  await runTodo(hooks, $, { name: 'Grace', entries: [RUNNING, entry('Other', 'queued'), entry('More', 'queued')] })
  expect(opens.map(o => [o.title, o.rows])).toEqual([['Agent TODO', 3], ['Ada TODO', 3], ['Grace TODO', 4]])
  await settle()
  expect(opens).toHaveLength(3)
  // A write that keeps the name and changes the count asks once, as it did before names.
  await runTodo(hooks, $, { entries: [RUNNING] })
  expect(opens.map(o => [o.title, o.rows])).toEqual([['Agent TODO', 3], ['Ada TODO', 3], ['Grace TODO', 4], ['Grace TODO', 2]])
})

test('a call whose name write throws makes its follow with the name as stored: a changed count asks once under the stored name, and a kept count asks nothing', async () => {
  reset()
  const { hooks } = wire()
  const { $, values, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  values.todoName = 'Old'
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Old TODO'])
  const logs: string[] = []
  const failing = unwritable($, 'todoName', logs)
  await runTodo(hooks, failing, { name: 'New', entries: [RUNNING, entry('Other', 'queued')] })
  expect(opens).toHaveLength(1)
  await runTodo(hooks, failing, { name: 'New', entries: [RUNNING, entry('A', 'queued'), entry('B', 'queued')] })
  expect(opens.map(o => [o.title, o.rows])).toEqual([['Old TODO', 3], ['Old TODO', 4]])
  expect(values.todoName).toBe('Old')
  expect(logs).toHaveLength(2)
})

test('a plain read makes no follow: a name stored by another path is asked of the pane by the next call that writes the list or the name, and not before', async () => {
  reset()
  const { hooks } = wire()
  const { $, values, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  values.todoName = 'Rebuilt'
  await runTodo(hooks, $, {})
  await settle()
  expect(opens).toHaveLength(1)
  await runTodo(hooks, $, { entries: [RUNNING, entry('Next', 'queued')] })
  expect(opens.map(o => o.title)).toEqual(['Agent TODO', 'Rebuilt TODO'])
})

test('a call that names the list while the pane shows a human item, or is shut, asks the pane for nothing', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  await endSession(hooks, $)
  await runTodo(hooks, $, { name: 'Ada' })
  await settle()
  expect(opens).toEqual([])
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  await runTodo(hooks, $, { name: 'Grace' })
  await runTodo(hooks, $, { name: 'Grace', entries: [RUNNING] })
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Items for you'])
  expect(closes).toEqual([])
})

test('after an open the pane refuses, the next call that keeps the count and the name asks again, and a rename whose ask is refused is asked again by it', async () => {
  reset()
  const { hooks } = wire()
  const { env, $: engine, opens } = backlogEnv([made(1)], [], null, [RUNNING, entry('Next', 'queued')])
  const logs: string[] = []
  const $ = { ...engine, ui: { ...engine.ui, log: (text: string) => void logs.push(text) } }
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  const taken = env.ui.open
  env.ui.open = async () => {
    throw new Error('open refused')
  }
  await runTodo(hooks, $, { name: 'Ada' })
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Agent TODO', 'Ada TODO'])
  expect(logs.some(line => line.includes('open refused'))).toBe(true)
  env.ui.open = taken
  await runTodo(hooks, $, { name: 'Ada' })
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Agent TODO', 'Ada TODO', 'Ada TODO'])
  await runTodo(hooks, $, { name: 'Ada' })
  await settle()
  expect(opens).toHaveLength(3)
})

test('a write to the Claude list while the pane shows a human item, or is shut, asks the pane for nothing; one that empties the list leaves the item\'s pane open', async () => {
  reset()
  const { hooks } = wire()
  const { $, opens, closes, open } = backlogEnv([made(1)], [], null, [RUNNING])
  await endSession(hooks, $)
  await runTodo(hooks, $, { entries: SIX })
  await settle()
  expect(opens).toEqual([])
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  await runTodo(hooks, $, { entries: [RUNNING, entry('Next', 'queued')] })
  await runTodo(hooks, $, { entries: [] })
  await settle()
  expect(opens.map(o => o.title)).toEqual(['Items for you'])
  expect(closes).toEqual([])
  expect(open).toEqual(['human-items'])
})

test('with the pane on the Claude list, removing a human item, emptying the human list and the end of an undo window each leave the pane open on the Claude list', async () => {
  reset()
  const { hooks } = wire()
  const timers: Timer[] = []
  const { $, values, clock, opens, closes, open } = backlogEnv([made(1, { detail: '' }), made(2, { detail: '' }), made(3, { detail: '' })], [], null, SIX, timers)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  pressKey(await bandAt(hooks, $, 120), 'done-1')
  await settle()
  await tickAt(timers, clock, 3000)
  await runTool(hooks, $, { action: 'remove', id: 1 })
  await settle()
  await runTool(hooks, $, { action: 'remove', id: 2 })
  await runTool(hooks, $, { action: 'remove', id: 3 })
  await settle()
  expect(opens).toHaveLength(1)
  expect(closes).toEqual([])
  expect(open).toEqual(['human-items'])
  expect(values.selection).toBe('claude-todo')
  expect(linesOf(await paneTree(hooks, $))[0]).toBe('Agent TODO 1 in flight, 5 queued')
})

test('with the pane on the Claude list, a tool call that changes no item, a read of the Claude list and a write that restates it leave the pane on the Claude list', async () => {
  reset()
  const { hooks } = wire()
  const { $, values, opens, closes } = backlogEnv([made(1), made(2)], [], null, SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  // Each call is answered, none refused: a refused call never reaches the pane's follow-up.
  const answers = [
    await runTool(hooks, $, { action: 'list' }),
    await runTool(hooks, $, { action: 'update', id: 1, title: 'Item 1' }),
    await runTodo(hooks, $, {}),
    await runTodo(hooks, $, { entries: SIX }),
  ]
  expect(answers.map(answer => Object.keys(answer as object))).toEqual([['result'], ['result'], ['result'], ['result']])
  expect((answers[1] as { result: string }).result).toBe('no change to #1')
  await settle()
  expect(opens).toHaveLength(1)
  expect(closes).toEqual([])
  expect(values.selection).toBe('claude-todo')
})

test('a /clear with the pane on the Claude list closes it', async () => {
  reset()
  const { hooks } = wire()
  const { $, closes, open } = backlogEnv([made(1)], [], null, SIX)
  await endSession(hooks, $)
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  await (hooks['session.end'] as Handler)($ as never, { reason: 'clear' } as never, next(false) as never)
  await settle()
  expect(closes).toEqual(['human-items'])
  expect(open).toEqual([])
})

test('a session end of any reason closes the pane while it shows the Claude list, since a resume rebuilds that list from its transcript and the pane\'s rows would no longer match it', async () => {
  for (const reason of ['resume', 'prompt_input_exit', 'logout', 'other']) {
    reset()
    const { hooks } = wire()
    const { $, closes, open } = backlogEnv([made(1)], [], null, SIX)
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), 'claude-header')
    await settle()
    expect(open, reason).toEqual(['human-items'])
    await (hooks['session.end'] as Handler)($ as never, { reason } as never, next(false) as never)
    await settle()
    expect(closes, reason).toEqual(['human-items'])
    expect(open, reason).toEqual([])
  }
})

test('a session end that is not a /clear leaves a pane on a human item open, as it did', async () => {
  for (const reason of ['resume', 'prompt_input_exit']) {
    reset()
    const { hooks } = wire()
    const { $, closes, open } = backlogEnv([made(1), made(2)], [], null, SIX)
    await endSession(hooks, $)
    pressKey(await bandAt(hooks, $, 120), 'title-1')
    await settle()
    await (hooks['session.end'] as Handler)($ as never, { reason } as never, next(false) as never)
    await settle()
    expect(closes, reason).toEqual([])
    expect(open, reason).toEqual(['human-items'])
  }
})

test('a refused write of the Claude list\'s selection leaves the pane drawing the stored selection, and the band, drawn again, showing the stored selection\'s item as the shown one', async () => {
  reset()
  const { hooks } = wire()
  const open = ['human-items']
  const { env, $, values, closes, asked } = backlogEnv([made(1), made(2), made(3)], open, 1, SIX)
  await endSession(hooks, $)
  const set = env.state.set
  env.state.set = (ref, value) => (ref.key === 'selection' ? Promise.reject(new Error('selection write refused')) : set(ref, value))
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(values.selection).toBe(1)
  expect(asked).toContain('ui.render')
  expect(flat(await paneTree(hooks, $))).toContain(ITEM_ONE)
  // The record the press set is dropped: the band's first item is the shown one, so a press on its title closes the pane instead of switching to it.
  pressKey(await bandAt(hooks, $, 120), 'title-1')
  await settle()
  expect(closes).toEqual(['human-items'])
})

test('opening the backlog from a closed pane leaves a band drawn before the pane next draws without a dock beside it; the backlog\'s draw as a dock records that placement and asks for the band once', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { $, asked } = backlogEnv([made(1), made(2)], open, null, [RUNNING])
  await dockedPane(hooks, $, open, asked)
  // The mod closes the docked pane by a press on the item it shows, and opens the backlog from closed: the surface may seat the pane anew.
  pressKey(await bandAt(hooks, $, 52), 'title-1')
  await settle()
  expect(open).toEqual([])
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(open).toEqual(['human-items'])
  expect(await columnDrawn(hooks, $)).toBe(false)
  asked.length = 0
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
})

test('with the pane docked at a band of 52, switching it from a human item to the backlog and from the backlog to a human item before it draws again each leave the band showing both lists, and ask for no redraw', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { $, opens, asked } = backlogEnv([made(1), made(2)], open, null, [RUNNING])
  await dockedPane(hooks, $, open, asked)
  asked.length = 0
  const before = opens.length
  pressKey(await bandAt(hooks, $, 52), 'claude-header')
  await settle()
  expect(opens.slice(before).map(o => o.title)).toEqual(['Agent TODO'])
  expect(await columnDrawn(hooks, $)).toBe(true)
  pressKey(await bandAt(hooks, $, 52), 'title-2')
  await settle()
  expect(opens.slice(before).map(o => o.title)).toEqual(['Agent TODO', 'Items for you'])
  expect(await columnDrawn(hooks, $)).toBe(true)
  pressKey(await bandAt(hooks, $, 56), 'claude-header')
  await settle()
  expect(opens.slice(before).map(o => o.title)).toEqual(['Agent TODO', 'Items for you', 'Agent TODO'])
  expect(await columnDrawn(hooks, $)).toBe(true)
  expect(asked).toEqual([])
})

test('the backlog\'s draw reported as a dock records that placement when the pane was switched to it from an item drawn inline: a band drawn after it shows both lists, and that draw asks for the band once', async () => {
  reset()
  const { hooks } = wire()
  const open: string[] = []
  const { $, asked } = backlogEnv([made(1), made(2)], open, null, [RUNNING])
  await freshDock(hooks, $, open, asked)
  pressKey(await bandAt(hooks, $, 80), 'title-1')
  await settle()
  await paneAt(hooks, $, 'inline')
  pressKey(await bandAt(hooks, $, 120), 'claude-header')
  await settle()
  expect(await columnDrawn(hooks, $)).toBe(false)
  expect(asked).toEqual([])
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
  expect(await columnDrawn(hooks, $)).toBe(true)
  await paneAt(hooks, $, 'dock')
  expect(asked).toEqual(['ui.render'])
})

// `/todo answer` through the hooks: the command, the AskUserQuestion hook that sees the walk's dialogs, and the session's end. The walk's own behaviour is
// walk.test.ts's; these tests drive the wiring, with a `$.ui.ask` that goes through the registered AskUserQuestion hook as the engine's does.
const ASKED = 'tool.call {"tool":"AskUserQuestion"}'
type CalledBy = Next & { origin: { plugin: string; tier: string } }

// A `next` that answers an AskUserQuestion call with `result`, as the engine's dialog does beneath the hook, for a call a hook of `plugin` made.
const nextFrom = (result: unknown, plugin: string): CalledBy => {
  const pass = (async (_e: unknown) => result) as CalledBy
  pass.called = false
  pass.error = { kind: 'throw', message: 'unused', budget: 1000 }
  pass.origin = { plugin, tier: 'append' }
  return pass
}

// What a scripted dialog gives back: the person's answer, or a dismissal with its message.
type Given = string | { rejects: string }
// What a scripted host records or does besides: the questions asked, every log line, whether the hook handed each result back as it got it, the plugin whose
// hook makes the call, a promise that keeps every dialog open until it settles, the start of a log line that throws instead, and a step that runs while the
// dialog of a given position (0 for the first) is open.
type Scripted = { asked?: string[]; logs?: string[]; through?: boolean[]; plugin?: string; hold?: Promise<void>; refuseLog?: string; during?: (position: number) => Promise<void> }

// `env` with a `$.ui.ask` that answers each dialog from `given`, as the engine answers one a hook raises: the call and its result go through the registered
// AskUserQuestion hook, made by a hook of `plugin`, before the dialog returns.
const askingHost = (hooks: Record<string, Handler>, env: object, given: Given[], scripted: Scripted = {}) => {
  const { asked = [], logs = [], through = [], plugin = 'human-plugin', hold, refuseLog, during } = scripted
  let n = 0
  const host: { ui: object } & Record<string, unknown> = {
    ...env,
    ui: {
      ...(env as { ui: object }).ui,
      log: (text: string) => {
        if (refuseLog !== undefined && text.startsWith(refuseLog)) throw new Error('log refused')
        logs.push(text)
      },
      ask: async (question: string, options: { options: string[]; header: string }) => {
        const position = n++
        const answer = given[position]
        asked.push(question)
        if (answer === undefined) throw new Error('a dialog nobody scripted')
        await hold
        await during?.(position)
        const said = typeof answer === 'string' ? answer : answer.rejects
        const questions = [{ question, header: options.header, options: options.options.map(label => ({ label })), multiSelect: false }]
        const result =
          typeof answer === 'string'
            ? { ref: 'r', result: { questions, answers: { [question]: said } }, text: said, isReadOnly: true }
            : { ref: 'r', result: `Error: ${said}`, text: `Error: ${said}`, isError: true }
        through.push((await (hooks[ASKED] as Handler)(host as never, { tool: 'AskUserQuestion', questions } as never, nextFrom(result, plugin) as never)) === result)
        if (typeof answer !== 'string') throw new Error(said)
        return said
      },
    },
  }
  return host
}

// Lets pending work run until `done` holds. The bound makes a walk that never asks fail its test's next check instead of hanging it.
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 40 && !done(); i++) await settle()
}

test('the AskUserQuestion hook is registered with the tool\'s name spelled out in its matcher, and it has no .catch, which would pass a dismissed dialog on again', () => {
  const { hooks, catches } = wire()
  expect(typeof hooks[ASKED]).toBe('function')
  expect(catches[ASKED]).toBeUndefined()
})

test('/todo answer asks about each open item through the hooks, blocking first, writes the answer it is given, and returns the walk\'s end text as the command\'s output', async () => {
  freshModule()
  const { hooks } = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' }), made(2, { detail: '', blocking: true })], [], null, submitted, timers)
  await endSession(hooks, env)
  const asked: string[] = []
  const through: boolean[] = []
  clock.now = 1000
  const answered = await todoOf(hooks)(askingHost(hooks, env, ['Done', 'Skip'], { asked, through }) as never, { args: ' Answer ' } as never, next(false) as never)
  expect(asked).toHaveLength(2)
  expect(asked[0]?.split('\n')[2]).toBe('▶ 1 of 2 — #2 blocking: Item 2')
  expect(asked[1]?.split('\n').slice(0, 2)).toEqual(['answered #2 with done', '▶ 2 of 2 — #1 non-blocking: Item 1'])
  expect(through).toEqual([true, true])
  expect(answered).toEqual({
    text: ['  skipped #1', '  It asked about every open item.', '  The walk sent 1 answer; 1 item is still open. /todo answer asks about it again.'].join('\n'),
  })
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open' }, { id: 2, state: 'done-waiting' }] })
  expect(submitted).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted).toHaveLength(1)
  expect((submitted[0] as { text: string }).text.startsWith('#2 is done: Item 2')).toBe(true)
})

test('/todo answer\'s answer to the item the open pane shows closes the pane once its window has ended, not when the walk writes it', async () => {
  freshModule()
  const { hooks } = wire()
  const open: string[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' }), made(2, { detail: '' })], open, null, [], timers)
  await endSession(hooks, env)
  findButton(await band(hooks, env), 'title-1')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  clock.now = 1000
  // The walk asks #1, the first in the ranking and the item the pane shows, and writes its answer; it skips #2.
  await todoOf(hooks)(askingHost(hooks, env, ['Done', 'Skip']) as never, { args: ' Answer ' } as never, next(false) as never)
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting' }, { id: 2, state: 'open' }] })
  expect(open).toEqual(['human-items'])
  await tickAt(timers, clock, 1000)
  expect(open).toEqual([])
})

test('/todo answer with anything after it answers the usage and asks nothing', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { detail: '' })], [], null)
  await endSession(hooks, env)
  const asked: string[] = []
  expect(await askText(hooks, askingHost(hooks, env, ['Done'], { asked }), 'answer now')).toBe(USAGE)
  expect(asked).toEqual([])
})

test('/todo answer while the list is being rebuilt answers the rebuilding line and asks nothing', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  const asked: string[] = []
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const waiting = askText(wired.hooks, askingHost(wired.hooks, host, ['Done'], { asked }), 'answer')
    await tickAt(timers, clock, 5000)
    expect(await waiting).toBe(REBUILDING)
    expect(asked).toEqual([])
    finish()
  } finally {
    resetRebuild()
  }
})

test('/todo answer with nothing open says so and asks nothing, and one started while a walk is asking is told so and asks nothing', async () => {
  freshModule()
  const { hooks } = wire()
  const none = memEnv([made(1, { state: 'done-pending', answer: 'done' })], [], null)
  await endSession(hooks, none.env)
  const asked: string[] = []
  expect(await askText(hooks, askingHost(hooks, none.env, ['Done'], { asked }), 'answer')).toBe(NOTHING_OPEN)
  expect(asked).toEqual([])

  const { env } = memEnv([made(1, { detail: '' })], [], null)
  let release = (): void => {}
  const hold = new Promise<void>(resolve => (release = resolve))
  const first = askText(hooks, askingHost(hooks, env, ['Skip'], { asked, hold }), 'answer')
  await until(() => asked.length === 1)
  expect(asked).toHaveLength(1)
  expect(await askText(hooks, askingHost(hooks, env, ['Skip'], { asked }), 'answer')).toBe(ALREADY_ASKING)
  expect(asked).toHaveLength(1)
  release()
  expect(await first).toContain('It asked about every open item.')
})

// `/do` through the hooks: the same walk as `/todo answer`, started by a command of its own with its own usage, rebuilding and failure lines. The walk is walk.test.ts's and the `/todo answer`
// tests' above; these drive what `/do` adds: its argument check, its wait for a rebuild, the one walk the two commands share, its failure line, and the source its walks' writes are logged by.

// The text `/do` answers with, as its hook returns it.
const doText = async (hooks: Record<string, Handler>, env: object, args = ''): Promise<string> =>
  ((await doOf(hooks)(env as never, { args } as never, next(false) as never)) as { text: string }).text

// The two commands that start the walk, each run as its hook runs it.
const starters = {
  '/do': (hooks: Record<string, Handler>, env: object): Promise<string> => doText(hooks, env),
  '/todo answer': (hooks: Record<string, Handler>, env: object): Promise<string> => askText(hooks, env, 'answer'),
}

test('/do asks the questions /todo answer asks about the same list, writes the answer it is given, and returns the walk\'s end text, which still points to /todo answer', async () => {
  const ran: { asked: string[]; text: string; list: unknown }[] = []
  for (const start of Object.values(starters)) {
    freshModule()
    const { hooks } = wire()
    const { env, values, clock } = memEnv([made(1, { detail: '' }), made(2, { detail: '', blocking: true })], [], null)
    await endSession(hooks, env)
    const asked: string[] = []
    clock.now = 1000
    const text = await start(hooks, askingHost(hooks, env, ['Done', 'Skip'], { asked }))
    ran.push({ asked, text, list: values.list })
  }
  const [byDo, byTodo] = ran
  expect(byDo).toEqual(byTodo)
  expect(byDo?.asked).toHaveLength(2)
  expect(byDo?.asked[0]?.split('\n')[2]).toBe('▶ 1 of 2 — #2 blocking: Item 2')
  expect(byDo?.asked[1]?.split('\n').slice(0, 2)).toEqual(['answered #2 with done', '▶ 2 of 2 — #1 non-blocking: Item 1'])
  expect(byDo?.text).toBe(['  skipped #1', '  It asked about every open item.', '  The walk sent 1 answer; 1 item is still open. /todo answer asks about it again.'].join('\n'))
  expect(byDo?.list).toMatchObject({ items: [{ id: 1, state: 'open' }, { id: 2, state: 'done-waiting' }] })
})

test('/do with anything after it answers its usage and asks nothing, and blanks alone are no argument: each starts the walk', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  await endSession(hooks, env)
  const asked: string[] = []
  for (const args of ['x', '3', 'answer', ' Answer ', '3 done', String.fromCodePoint(0xa0)]) {
    expect([args, await doText(hooks, askingHost(hooks, env, ['Done'], { asked }), args)]).toEqual([args, DO_USAGE])
  }
  expect(asked).toEqual([])
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open' }] })
  for (const args of [' ', '\t', ' \t ']) {
    expect([args, (await doText(hooks, askingHost(hooks, env, ['Skip'], { asked }), args)).includes('It asked about every open item.')]).toEqual([args, true])
  }
  expect(asked).toHaveLength(3)
})

test('/do with nothing open says so and asks nothing', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { state: 'done-pending', answer: 'done' })], [], null)
  await endSession(hooks, env)
  const asked: string[] = []
  expect(await doText(hooks, askingHost(hooks, env, ['Done'], { asked }))).toBe(NOTHING_OPEN)
  expect(asked).toEqual([])
})

test('/do while a /todo answer walk asks, and /todo answer while a /do walk asks, are each told a walk is already asking and ask nothing', async () => {
  for (const [first, second] of [['/do', '/todo answer'], ['/todo answer', '/do']] as const) {
    freshModule()
    const { hooks } = wire()
    const { env } = memEnv([made(1, { detail: '' })], [], null)
    await endSession(hooks, env)
    const asked: string[] = []
    let release = (): void => {}
    const hold = new Promise<void>(resolve => (release = resolve))
    const running = starters[first](hooks, askingHost(hooks, env, ['Skip'], { asked, hold }))
    await until(() => asked.length === 1)
    expect(asked, first).toHaveLength(1)
    expect([first, await starters[second](hooks, askingHost(hooks, env, ['Skip'], { asked }))]).toEqual([first, ALREADY_ASKING])
    expect(asked, first).toHaveLength(1)
    release()
    expect([first, (await running).includes('It asked about every open item.')]).toEqual([first, true])
  }
})

test('/do while the list is being rebuilt answers its own rebuilding line, which names /do, and asks nothing; once the rebuild has finished it starts the walk', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env, clock } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  const asked: string[] = []
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    const waiting = doText(wired.hooks, askingHost(wired.hooks, host, ['Skip'], { asked }))
    await tickAt(timers, clock, 5000)
    expect(await waiting).toBe(DO_REBUILDING)
    expect(asked).toEqual([])
    finish()
    expect(await doText(wired.hooks, askingHost(wired.hooks, host, ['Skip'], { asked }))).toContain('It asked about every open item.')
    expect(asked).toHaveLength(1)
  } finally {
    resetRebuild()
  }
})

test('a /do whose hook throws answers its failure line and logs the throw', async () => {
  freshModule()
  const wired = wire()
  const timers: Timer[] = []
  const { env } = memEnv([], [], null, [], timers)
  const { host, finish } = rebuilding(env)
  // The host refuses the timer the wait for the rebuild arms, so the hook throws before the walk starts.
  const refusing = {
    ...host,
    clock: {
      ...env.clock,
      after: () => {
        throw new Error('no timer')
      },
    },
  }
  setForkedTranscript('/sessions/s.jsonl')
  try {
    await started(wired, host)
    let thrown: unknown = null
    try {
      await doOf(wired.hooks)(refusing as never, { args: '' } as never, next(false) as never)
    } catch (err) {
      thrown = err
    }
    expect(String(thrown)).toContain('no timer')
    const logs: string[] = []
    const handler = wired.catches[commandKey(DO_COMMAND)] as Handler
    expect(await handler({ ui: { log: (text: string) => void logs.push(text) } } as never, { args: '' } as never, next(false, 'no timer') as never)).toEqual({ text: DO_FAILED })
    expect(logs).toEqual(['human-plugin: the command.run hook throw: no timer'])
    finish()
  } finally {
    resetRebuild()
  }
})

test('a walk\'s applied answer logs its window as a dialog answer, whichever command started the walk and with no command named, and a /todo <n> <form> answer logs it as /todo', async () => {
  const cases = [
    ['/do', 'dialog answer', starters['/do']],
    ['/todo answer', 'dialog answer', starters['/todo answer']],
    ['/todo 1 done', '/todo', (hooks: Record<string, Handler>, env: object) => askText(hooks, env, '1 done')],
  ] as const
  for (const [command, source, run] of cases) {
    freshModule()
    const { hooks } = wire()
    const { env, clock } = memEnv([made(1, { detail: '' })], [], null)
    await endSession(hooks, env)
    clock.now = 1000
    const logs: string[] = []
    await run(hooks, askingHost(hooks, env, ['Done'], { logs }))
    // A walk's and a command's write count from one window back (3000 ms), so the window it leaves is due at once.
    expect([command, logs.filter(line => / #1 at /.test(line))]).toEqual([command, [`human-plugin: ${source} #1 at -2000: open -> done-waiting`]])
  }
})

test('the session\'s end releases the walk that is asking: the next /todo answer asks while the old dialog is still open, and the old walk ends with its session when that dialog returns', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  await endSession(hooks, env)
  const asked: string[] = []
  let release = (): void => {}
  const hold = new Promise<void>(resolve => (release = resolve))
  const old = askText(hooks, askingHost(hooks, env, ['Done'], { asked, hold }), 'answer')
  await until(() => asked.length === 1)
  expect(asked).toHaveLength(1)
  await endSession(hooks, env)
  expect(await askText(hooks, askingHost(hooks, env, ['Skip'], { asked }), 'answer')).toContain('It asked about every open item.')
  expect(asked).toHaveLength(2)
  release()
  expect(await old).toBe(['  It ended with its session; nothing more was asked or sent.', '  The walk sent nothing; 1 item is still open. /todo answer asks about it again.'].join('\n'))
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open' }] })
})

test('the AskUserQuestion hook hands every result back as it got it, whoever made the call, and a walk whose dialog another plugin or the engine made cannot confirm its answer', async () => {
  freshModule()
  const { hooks } = wire()
  const hook = hooks[ASKED] as Handler
  const { env: quiet } = memEnv([], [], null)
  const call = { tool: 'AskUserQuestion', questions: [{ question: 'Which?', header: 'h', options: [], multiSelect: false }] }
  const answered = { ref: 'r', result: { answers: {} }, text: 'x', isReadOnly: true }
  const dismissed = { ref: 'r', result: 'Error: dismissed', text: 'Error: dismissed', isError: true }
  for (const plugin of ['human-plugin', 'auditor', 'engine']) {
    for (const result of [answered, dismissed]) {
      expect(await hook(quiet as never, call as never, nextFrom(result, plugin) as never)).toBe(result)
    }
  }

  for (const plugin of ['auditor', 'engine']) {
    const { env, values } = memEnv([made(1, { detail: '' })], [], null)
    await endSession(hooks, env)
    const logs: string[] = []
    const through: boolean[] = []
    const text = await askText(hooks, askingHost(hooks, env, ['Done'], { logs, through, plugin }), 'answer')
    expect([plugin, text.split('\n')[0]]).toEqual([plugin, '  It ended because the answer to #1 could not be confirmed as yours; nothing was sent, and this was logged.'])
    expect(through).toEqual([true])
    expect(values.list).toMatchObject({ items: [{ id: 1, state: 'open' }] })
    expect(logs).toContain('human-plugin: walk ask #1: label "Done"; record missing; not written')
  }
})

test('a throw inside the AskUserQuestion hook\'s record is logged and leaves the result as it was, and the record the walk already had stands', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { detail: '' })], [], null)
  await endSession(hooks, env)
  const logs: string[] = []
  const through: boolean[] = []
  // The record's own debug line is the throwing call: the observer has made the record by then.
  const text = await askText(hooks, askingHost(hooks, env, ['Done'], { logs, through, refuseLog: 'human-plugin: walk record' }), 'answer')
  expect(logs.some(line => line.startsWith("human-plugin: the record of a walk's question failed: Error: log refused"))).toBe(true)
  expect(through).toEqual([true])
  expect(text.split('\n')[0]).toBe('  answered #1 with done')
  expect(values.list).toMatchObject({ items: [{ id: 1, state: 'done-waiting' }] })
})

// While a walk asks, no submit is tried: the engine refuses one made while the walk's command hook is in flight. A notice that would have started a turn waits, saved as
// waiting, for the walk's release or the next turn to start. The person's pause over a question is where the undo ticker's tick falls, so the walks below run the tick while a dialog is open.

// The rows a turn that starts appends: its start hook appends each notice waiting then, one row each, which this records.
const turnStartRows = async (hooks: Record<string, Handler>, env: object, turnId: string): Promise<string[]> => {
  const rows: string[] = []
  const $ = {
    ...env,
    session: {
      append: async (e: { message: { content: { text: string }[] } }) => {
        rows.push(e.message.content[0]?.text ?? '')
        return {}
      },
    },
  }
  await (hooks['turn.start'] as Handler)($ as never, { turnId } as never, next(false) as never)
  await settle()
  return rows
}
const waitingIds = (saved: unknown): number[] => (saved as { waiting: { id: number }[] }).waiting.map(notice => notice.id)

test('/todo answer in an idle session tries no submit while it asks: each answer\'s notice waits, saved as waiting; its end submits nothing, and its release, a second later, submits the earlier answers\' notices as one prompt, the last answer\'s tick, which falls after it, going to the turn that prompt starts', async () => {
  freshModule()
  const wired = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' }), made(2, { detail: '' }), made(3, { detail: '' })], [], null, submitted, timers)
  await endSession(wired.hooks, env)
  await started(wired, env)
  clock.now = 1000
  const logs: string[] = []
  const between: { submits: number; saved: unknown }[] = []
  const pause = async (position: number): Promise<void> => {
    if (position === 0) return
    await tickAt(timers, clock, 1000)
    between.push({ submits: submitted.length, saved: values.notices })
  }
  const text = await askText(wired.hooks, askingHost(wired.hooks, env, ['Done', 'Done', 'Done'], { logs, during: pause }), 'answer')
  expect(text).toContain('The walk sent 3 answers; nothing is left open.')
  expect(between.map(seen => seen.submits)).toEqual([0, 0])
  expect(between.map(seen => waitingIds(seen.saved))).toEqual([[1], [1, 2]])
  expect(submitted).toEqual([])
  expect(oneShotWaits(timers)).toEqual([1000])
  await tickAt(timers, clock, 1000)
  expect(submitted).toHaveLength(1)
  const prompt = (submitted[0] as { text: string }).text
  expect(prompt.startsWith('#1 is done: Item 1')).toBe(true)
  expect(prompt).toContain('\n\n#2 is done: Item 2')
  expect(prompt).not.toContain('#3 is done')
  expect(logs.filter(line => line.startsWith('human-plugin: sent #')).map(line => line.replace(/ for press -?\d+/, ''))).toEqual([
    "human-plugin: sent #1 kept for the walk's release or the next turn",
    "human-plugin: sent #2 kept for the walk's release or the next turn",
    'human-plugin: sent #3 to the running turn',
  ])
  expect(logs).toContain("human-plugin: released at the walk's end: notices for #1, #2")
  expect((await turnStartRows(wired.hooks, env, 't1')).map(row => row.split('\n')[0])).toEqual(['#3 is done: Item 3'])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('/todo answer that ends on Stop in an idle session submits nothing at its end: its release, a second later, submits the notices whose items are still on the list as one prompt', async () => {
  freshModule()
  const wired = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' }), made(2, { detail: '' }), made(3, { detail: '' })], [], null, submitted, timers)
  await endSession(wired.hooks, env)
  await started(wired, env)
  clock.now = 1000
  const pause = async (position: number): Promise<void> => {
    if (position > 0) await tickAt(timers, clock, 1000)
  }
  const text = await askText(wired.hooks, askingHost(wired.hooks, env, ['Done', 'Done', 'Stop'], { during: pause }), 'answer')
  expect(text).toContain('It ended on Stop.')
  await settle()
  expect(submitted).toEqual([])
  expect(waitingIds(values.notices)).toEqual([1, 2])
  // The agent removes #1 before the release runs.
  const list = values.list as { items: { id: number }[] }
  values.list = { ...list, items: list.items.filter(it => it.id !== 1) }
  await tickAt(timers, clock, 1000)
  expect(submitted).toHaveLength(1)
  const prompt = (submitted[0] as { text: string }).text
  expect(prompt.startsWith('#2 is done: Item 2')).toBe(true)
  expect(prompt).not.toContain('#1 is done')
  expect(values.notices).toEqual({ held: [], waiting: [] })
  // The notices were delivered: the human's prompt carries no context, and the turn that starts appends nothing.
  expect((await entered(wired.hooks, env, { origin: { kind: 'composer' }, text: 'hi' }))[0]?.context).toBeUndefined()
  expect(await turnStartRows(wired.hooks, env, 't1')).toEqual([])
})

test('a turn that starts after the walk\'s end and before its release takes the waiting notices at its first read point, and the release then submits nothing', async () => {
  freshModule()
  const wired = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, values, clock } = memEnv([made(1, { detail: '' }), made(2, { detail: '' })], [], null, submitted, timers)
  await endSession(wired.hooks, env)
  await started(wired, env)
  clock.now = 1000
  const pause = async (position: number): Promise<void> => {
    if (position > 0) await tickAt(timers, clock, 1000)
  }
  await askText(wired.hooks, askingHost(wired.hooks, env, ['Done', 'Stop'], { during: pause }), 'answer')
  expect(oneShotWaits(timers)).toEqual([1000])
  expect((await turnStartRows(wired.hooks, env, 't1')).map(row => row.split('\n')[0])).toEqual(['#1 is done: Item 1'])
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(values.notices).toEqual({ held: [], waiting: [] })
})

test('the session\'s end cancels the release a walk\'s end armed: nothing is submitted in either session, and a notice in the new session takes the idle path', async () => {
  freshModule()
  const wired = wire()
  const submitted: unknown[] = []
  const timers: Timer[] = []
  const { env, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
  await endSession(wired.hooks, env)
  await started(wired, env)
  clock.now = 1000
  await askText(wired.hooks, askingHost(wired.hooks, env, ['Done'], {}), 'answer')
  await tickAt(timers, clock, 1000, 'ticks')
  expect(oneShotWaits(timers)).toEqual([1000])
  await endSession(wired.hooks, env)
  expect(oneShotWaits(timers)).toEqual([])
  await tickAt(timers, clock, 1000)
  expect(submitted).toEqual([])
  expect(offer({ id: 2, text: '#2 is done: in the new session' })).toBe('submit')
})

test('the session\'s end releases the hold of the walk that is asking: a notice in the new session takes the idle path while the old dialog is still open', async () => {
  freshModule()
  const { hooks } = wire()
  const { env } = memEnv([made(1, { detail: '' })], [], null)
  await endSession(hooks, env)
  const asked: string[] = []
  let release = (): void => {}
  const hold = new Promise<void>(resolve => (release = resolve))
  const old = askText(hooks, askingHost(hooks, env, ['Skip'], { asked, hold }), 'answer')
  await until(() => asked.length === 1)
  expect(offer({ id: 8, text: '#8 is done: while the walk asked' })).toBe('walk')
  await endSession(hooks, env)
  expect(offer({ id: 9, text: '#9 is done: in the new session' })).toBe('submit')
  release()
  await old
})

test('a turn that ends while a walk is asking submits nothing and leaves its notice waiting, saved as waiting; the walk\'s release submits it, and a turn that was interrupted holds it for the human\'s next prompt, which the release leaves alone', async () => {
  const notice = { id: 1, text: '#1 is done: Item 1' }
  for (const aborted of [false, true]) {
    freshModule()
    const wired = wire()
    const submitted: unknown[] = []
    const timers: Timer[] = []
    const { env, values, clock } = memEnv([made(1, { detail: '' })], [], null, submitted, timers)
    await endSession(wired.hooks, env)
    await started(wired, env)
    await (wired.hooks['turn.start'] as Handler)(env as never, { turnId: 't1' } as never, next(false) as never)
    const asked: string[] = []
    let release = (): void => {}
    const hold = new Promise<void>(resolve => (release = resolve))
    const running = askText(wired.hooks, askingHost(wired.hooks, env, ['Skip'], { asked, hold }), 'answer')
    await until(() => asked.length === 1)
    offer(notice)
    await (wired.hooks['turn.complete'] as Handler)(env as never, { agentId: undefined, isAborted: aborted, turnId: 't1' } as never, next(false) as never)
    await settle()
    expect([aborted, submitted]).toEqual([aborted, []])
    expect([aborted, values.notices]).toEqual([aborted, aborted ? { held: [notice], waiting: [] } : { held: [], waiting: [notice] }])
    release()
    await running
    expect([aborted, submitted]).toEqual([aborted, []])
    await tickAt(timers, clock, 1000)
    expect([aborted, submitted]).toEqual([aborted, aborted ? [] : [{ text: notice.text }]])
    expect([aborted, values.notices]).toEqual([aborted, aborted ? { held: [notice], waiting: [] } : { held: [], waiting: [] }])
  }
})

// The posed flag: a walk has shown the person an item's question since the agent last changed it, and such an item ranks below those no walk has shown. One open item of each
// of the four kinds, the numbers running against the ranking: shown non-blocking, shown blocking, not shown non-blocking, not shown blocking.
const FOUR = (): Record<string, unknown>[] => [made(1, { posed: true }), made(2, { posed: true, blocking: true }), made(3), made(4, { blocking: true })]
// The numbers of the title buttons a drawn tree holds, in the order the tree draws them.
const titleOrder = (tree: unknown): number[] => [...JSON.stringify(tree).matchAll(/"key":"title-(\d+)"/g)].map(match => Number(match[1]))
// The posed flags the list holds, in list order, as the mod reads them.
const posedFlags = (values: Record<string, unknown>): boolean[] => normalizeStore(values.list).items.map(it => it.posed)
// The position line of a walk's question.
const positionOf = (question: string): string => question.split('\n').find(line => line.startsWith('▶')) ?? ''

test('the band, the pane\'s default item, /todo and the phone block put the items no walk has shown first, blocking first within each group, whatever the numbers', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, FOUR(), null)
  expect(titleOrder(await band(hooks, env))).toEqual([4, 3, 2, 1])
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#4 blocking, open: Item 4')
  expect(await askText(hooks, env, '')).toBe(['  #4 blocking: Item 4', '  #3 non-blocking: Item 3', '  #2 blocking: Item 2', '  #1 non-blocking: Item 1'].join('\n'))
  const [block = ''] = (await entered(hooks, env, { origin: { kind: 'bridge' }, text: 'hi' }))[0]?.context ?? []
  expect(block).toContain('  #4 Item 4, #3 Item 3, #2 Item 2, #1 Item 1')
})

test('with no selection the pane moves on, as each item it shows is removed, to the first open item left in the ranking, the items no walk has shown first', async () => {
  const open = ['human-items']
  const { hooks, env, values } = await reloaded(open, FOUR(), null)
  const moves: unknown[] = []
  for (const id of [4, 3, 2]) {
    await (hooks['tool.call'] as Handler)(env as never, { tool: TOOL, action: 'remove', id } as never, next(false) as never)
    await settle()
    moves.push(values.selection)
  }
  expect(moves).toEqual([3, 2, 1])
  expect(open).toEqual(['human-items'])
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
})

test('with no selection the pane draws an item answered from the pane, which no walk showed, before an open item a walk showed that has a lower number, and the band\'s first row is that item', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1, { posed: true }), made(2, { state: 'done-pending', answer: 'Use sqlite' })], null)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#2 non-blocking, done-pending: Item 2')
  expect(titleOrder(await band(hooks, env))).toEqual([2, 1])
})

test('/todo <n>, an answer form, opening the pane and switching it to another item leave every item\'s posed flag as it was', async () => {
  const open: string[] = []
  const { hooks, env, values } = await reloaded(open, [made(1, { posed: true, unread: true }), made(2, { unread: true }), made(3, { posed: true })], null)
  expect(posedFlags(values)).toEqual([true, false, true])
  await askText(hooks, env, '1')
  expect(posedFlags(values)).toEqual([true, false, true])
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(open).toEqual(['human-items'])
  findButton(await band(hooks, env), 'title-2')?.onPress()
  await settle()
  expect(values.selection).toBe(2)
  expect(posedFlags(values)).toEqual([true, false, true])
  await askText(hooks, env, '3 done')
  expect(normalizeStore(values.list).items.map(it => [it.state, it.posed])).toEqual([['open', true], ['open', false], ['done-waiting', true]])
})

test('/todo <n> clears the unread mark of an item a walk marked posed after the read that printed it, since the mark is no change to what was printed', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { unread: true })], [], null)
  // A walk's mark lands between /todo's read of the list and its clear of the unread mark: the first read returns the list as it was.
  const getState = env.state.get
  let marked = false
  env.state.get = async ref => {
    const got = await getState(ref)
    if (ref.key === 'list' && !marked) {
      marked = true
      const stored = normalizeStore(values.list)
      values.list = { ...stored, items: stored.items.map(it => ({ ...it, posed: true })) }
    }
    return got
  }
  expect(await askText(hooks, env, '1')).toBe('  #1 non-blocking: Item 1\n  brief:\n  Brief 1.\n  /todo 1 done\n  /todo 1 reply <text>')
  expect(values.list).toMatchObject({ items: [{ id: 1, unread: false, posed: true }] })
})

test('an agent\'s append or update through the tool leaves the item unposed, while an update that changes nothing and a term-only one leave it posed', async () => {
  reset()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { posed: true }), made(2, { posed: true }), made(3, { posed: true }), made(4, { posed: true })], [], null)
  expect(await runTool(hooks, env, { action: 'append', id: 1, text: 'Which version?' })).toEqual({ result: 'appended to #1' })
  expect(await runTool(hooks, env, { action: 'update', id: 2, title: 'Retitled' })).toEqual({ result: 'updated #2' })
  expect(await runTool(hooks, env, { action: 'update', id: 3, title: 'Item 3' })).toEqual({ result: 'no change to #3' })
  expect(await runTool(hooks, env, { action: 'update', id: 4, term: 'Boss' })).toEqual({ result: 'no change to #4 (term set to "Boss")' })
  expect(posedFlags(values)).toEqual([false, false, true, true])
})

test('a hot reload keeps every item\'s posed flag, so the band keeps its order, and a /clear leaves no item to carry one', async () => {
  freshModule()
  const before = wire()
  const { env, values } = memEnv(FOUR(), [], null)
  await started(before, env)
  expect(titleOrder(await band(before.hooks, env))).toEqual([4, 3, 2, 1])
  // The reload: the module's variables start over, and the state keeps what it held.
  freshModule()
  const after = wire()
  await started(after, env)
  await settle()
  expect(posedFlags(values)).toEqual([true, true, false, false])
  expect(titleOrder(await band(after.hooks, env))).toEqual([4, 3, 2, 1])
  await (after.hooks['session.end'] as Handler)(env as never, { reason: 'clear' } as never, next(false) as never)
  expect(normalizeStore(values.list).items).toEqual([])
})

test('/todo answer through the hooks marks each item whose question it showed, the one the person closed included, and the next walk asks every item it did not reach before them', async () => {
  freshModule()
  const { hooks } = wire()
  const { env, values } = memEnv([made(1, { blocking: true }), made(2), made(3), made(4, { blocking: true })], [], null)
  await endSession(hooks, env)
  const asked: string[] = []
  await askText(hooks, askingHost(hooks, env, ['Skip', { rejects: 'The user dismissed the question' }], { asked }), 'answer')
  expect(asked.map(positionOf)).toEqual(['▶ 1 of 4 — #1 blocking: Item 1', '▶ 2 of 4 — #4 blocking: Item 4'])
  expect(posedFlags(values)).toEqual([true, false, false, true])
  asked.length = 0
  await askText(hooks, askingHost(hooks, env, ['Skip', 'Skip', 'Skip', 'Skip'], { asked }), 'answer')
  expect(asked.map(positionOf)).toEqual([
    '▶ 1 of 4 — #2 non-blocking: Item 2',
    '▶ 2 of 4 — #3 non-blocking: Item 3',
    '▶ 3 of 4 — #1 blocking: Item 1',
    '▶ 4 of 4 — #4 blocking: Item 4',
  ])
  expect(posedFlags(values)).toEqual([true, true, true, true])
})

test('a walk that shows the item the open pane draws by default moves the pane to the next item in the ranking, and one the pane was opened on by a press stays where it is', async () => {
  const open = ['human-items']
  const { hooks, env } = await reloaded(open, [made(1), made(2), made(3)], null)
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#1 non-blocking, open: Item 1')
  await askText(hooks, askingHost(hooks, env, ['Stop']), 'answer')
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#2 non-blocking, open: Item 2')
  findButton(await band(hooks, env), 'title-3')?.onPress()
  await settle()
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#3 non-blocking, open: Item 3')
  await askText(hooks, askingHost(hooks, env, ['Stop']), 'answer')
  expect(JSON.stringify(await paneTree(hooks, env))).toContain('#3 non-blocking, open: Item 3')
})
