import { expect, test } from 'claude-code/testing'
import { register, wireHooks } from './register'
import { offer, reset, setOnChange, startTurn, takeHeld, endTurn } from './turns'
import { EMPTY, TOOL } from './items'
import { paneRows } from './ui'
import { correctionText } from './restatement'
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

test('a session.end whose carry throws still empties the list, with the id counter the store holds', async () => {
  reset()
  const { catches } = wire()
  const logs: string[] = []
  const writes: unknown[] = []
  const stored = { next: 7 }
  const e = { reason: 'clear' }
  const answered = await (catches['session.end'] as Handler)(broken(logs, [], stored, writes) as never, e as never, next(false) as never)
  expect(answered).toEqual({ passed: e })
  expect(writes).toEqual([{ items: [], next: 7 }])
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

// The pane's open requests, recorded as memEnv's pane takes them.
const recordingOpens = <E extends { ui: { open: (args: { id: string; rows: number }) => Promise<unknown> } }>(plain: E, opened: { id: string; rows: number }[]) => ({
  ...plain,
  ui: { ...plain.ui, open: async (args: { id: string; rows: number }) => { opened.push({ id: args.id, rows: args.rows }); return plain.ui.open(args) } },
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
  expect(values.list).toEqual({ items: [], next: 3 })
})

test('the band shows no garbage item, and draws the one beside it', async () => {
  reset()
  const { hooks } = wire()
  const { env } = memEnv([{ title: 'garbage' }, legacy], [], null)
  const text = JSON.stringify(await band(hooks, env))
  expect(text).toContain('Pick a db')
  expect(text).not.toContain('garbage')
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
