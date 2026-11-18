import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { TOOL } from './items'
import { NO_ETA, TODO_TOOL } from './todo'

// The rebuild through the session's own hooks: classic.SessionStart (or, for a fork, session.start and the first turn)
// starts it, `cat` streams each transcript, and the tool waits for it. The test's hooks stand for the host beneath.
const DIR = '/projects/p'
const MAIN = `${DIR}/s1.jsonl`
const FORK = `${DIR}/s2.jsonl`
const SUBS = `${DIR}/s1/subagents`

const at = (s: number) => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`
const jsonl = (...rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row) + '\n').join('')
const prompt = (uuid: string, parent: string | null, s: number) =>
  ({ uuid, parentUuid: parent, timestamp: at(s), type: 'user', message: { role: 'user', content: `prompt ${uuid}` } })
const call = (uuid: string, parent: string, s: number, id: string, input: Record<string, unknown>) =>
  ({ uuid, parentUuid: parent, timestamp: at(s), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: TOOL, input }] } })
const reply = (uuid: string, parent: string, s: number, id: string, text: string) =>
  ({ uuid, parentUuid: parent, timestamp: at(s), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

// #1 and #3 are open on the live branch, #2 was removed there, and #4 was added on a branch a /rewind abandoned.
const SESSION = jsonl(
  prompt('u0', null, 0),
  call('a1', 'u0', 1, 't1', { action: 'add', title: 'One' }),
  reply('r1', 'a1', 2, 't1', 'added #1'),
  call('a2', 'r1', 3, 't2', { action: 'add', title: 'Two' }),
  reply('r2', 'a2', 4, 't2', 'added #2'),
  call('a3', 'r2', 5, 't3', { action: 'add', title: 'Three' }),
  reply('r3', 'a3', 6, 't3', 'added #3'),
  call('a4', 'r3', 7, 't4', { action: 'remove', id: 2 }),
  reply('r4', 'a4', 8, 't4', 'removed #2'),
  prompt('p-old', 'r4', 9),
  call('a5', 'p-old', 10, 't5', { action: 'add', title: 'Rewound away' }),
  reply('r5', 'a5', 11, 't5', 'added #4'),
  prompt('p-new', 'r4', 12),
)
const SUB = (title: string, n: number) =>
  jsonl(call('sa', 'none', 3, `s${n}`, { action: 'add', title }), reply('sr', 'sa', 3, `s${n}`, `added #${n}`))

// The main agent names the human `owner` on its add; a subagent's later add names them `the user`, which the chip must not take. The band
// is drawn on a mounted surface, as engine.test.ts draws it.
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const TERMED = jsonl(
  prompt('u0', null, 0),
  call('a1', 'u0', 1, 't1', { action: 'add', title: 'One', term: 'owner' }),
  reply('r1', 'a1', 2, 't1', 'added #1 (term set to "owner")'),
)
const SUB_TERMED = jsonl(
  call('sa', 'none', 9, 's1', { action: 'add', title: 'Sub ask', term: 'the user' }),
  reply('sr', 'sa', 9, 's1', 'added #2 (term not used: only the main agent sets it)'),
)
// The main agent states a term, then clears it: the transcript ends on the clear.
const CLEARED = jsonl(
  prompt('u0', null, 0),
  call('a1', 'u0', 1, 't1', { action: 'add', title: 'One', term: 'owner' }),
  reply('r1', 'a1', 2, 't1', 'added #1 (term set to "owner")'),
  call('a2', 'r1', 3, 't2', { action: 'update', id: 1, term: '' }),
  reply('r2', 'a2', 4, 't2', 'no change to #1 (term cleared)'),
)

// The host's files and `cat`. `held` keeps every `cat` from answering until the test opens it; `failing` names files
// whose `cat` exits 1; `hidden` names files that do not exist until `appear`.
const host = (on: On, files: Record<string, string>, options: { held?: boolean; failing?: string[]; listed?: string[]; hidden?: string[] } = {}) => {
  const exists = new Set(Object.keys(files).filter(path => !(options.hidden ?? []).includes(path)))
  const read: string[] = []
  const gate: { open: () => void } = { open: () => undefined }
  const opened = options.held === true ? new Promise<void>(resolve => (gate.open = resolve)) : Promise.resolve()
  on('classic.SessionStart', () => ({}))
  on('fs.exists', (_$, e) => ({ value: exists.has(e.path) || (e.path === SUBS && (options.listed ?? []).length > 0) }))
  on('fs.list', () => ({ value: (options.listed ?? []).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('process.spawn', async function* (_$, e) {
    const path = e.argv[1] ?? ''
    read.push(path)
    await opened
    if ((options.failing ?? []).includes(path)) {
      yield { stream: 'stderr' as const, text: 'Permission denied' }
      return { value: { code: 1, signal: null } }
    }
    const text = files[path] ?? ''
    if (text !== '') yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
  return { read, gate, appear: (path: string) => exists.add(path) }
}

const titles = async ($: Engine) => String((await $.tool.call({ tool: TOOL, action: 'list' })).result)

test('a resumed session rebuilds the live branch, and an add made while the rebuild runs waits for it, then numbers past every id the transcript used', async ($, on) => {
  const clock = mock.clock(on)
  const files = host(on, { [MAIN]: SESSION }, { held: true })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const adding = $.tool.call({ tool: TOOL, action: 'add', title: 'Meanwhile' })
  await clock.settle()
  files.gate.open()
  expect((await adding).result).toBe('added #5')
  const listed = await titles($)
  expect(listed).toContain('#1 non-blocking, open: One')
  expect(listed).toContain('#3 non-blocking, open: Three')
  expect(listed).toContain('#5 non-blocking, open: Meanwhile')
  expect(listed.includes('Two')).toBe(false)
  expect(listed.includes('Rewound away')).toBe(false)
})

test('a rebuild joins the list as it stands: an item the transcript did not hand out stays, and ids go on past it', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: SESSION })
  for (const n of [1, 2, 3, 4, 5]) await $.tool.call({ tool: TOOL, action: 'add', title: `Live ${n}` })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const listed = await titles($)
  expect(listed).toBe('#1 non-blocking, open: One\n#3 non-blocking, open: Three\n#5 non-blocking, open: Live 5')
  expect((await $.tool.call({ tool: TOOL, action: 'add', title: 'Next' })).result).toBe('added #6')
})

test('a resumed session draws the chip with the term the main agent last stated, and a subagent\'s term is not used', async ($, on) => {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  host(on, { [MAIN]: TERMED, [`${SUBS}/agent-s1.jsonl`]: SUB_TERMED }, { listed: ['agent-s1.jsonl'] })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await titles($)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('owner TODO')
})

test('a rebuild keeps a term set live, where the transcript states another', async ($, on) => {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  host(on, { [MAIN]: TERMED })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Live', term: 'mine' })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await titles($)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('mine TODO')
})

test('a rebuild keeps a term cleared live, where the transcript states another', async ($, on) => {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  host(on, { [MAIN]: TERMED })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Live', term: '  ' })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await titles($)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('Human TODO')
})

test('a resume whose transcript ends on a clear draws Human TODO, not the term before the clear', async ($, on) => {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  host(on, { [MAIN]: CLEARED })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await titles($)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('Human TODO')
})

test('a call waits for the rebuild only so long, and is refused rather than answered against the unfilled list', async ($, on) => {
  const clock = mock.clock(on)
  const files = host(on, { [MAIN]: SESSION }, { held: true })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const adding = $.tool.call({ tool: TOOL, action: 'add', title: 'Too early' })
  await clock.settle()
  await clock.advance(5000)
  expect(String((await adding).deny)).toContain('still being rebuilt')
  files.gate.open()
  await clock.settle()
  expect(await titles($)).not.toContain('Too early')
  expect((await $.tool.call({ tool: TOOL, action: 'add', title: 'Later' })).result).toBe('added #5')
})

test('one unreadable subagent transcript leaves out that agent alone, and says so', async ($, on) => {
  mock.clock(on)
  const shown: string[] = []
  on('ui.log', (_$, e, next) => {
    if (e.to !== 'debug') shown.push(e.text)
    return next(e)
  })
  host(on, { [MAIN]: SESSION, [`${SUBS}/agent-bad.jsonl`]: SUB('Bad sub ask', 6), [`${SUBS}/agent-good.jsonl`]: SUB('Good sub ask', 7) }, {
    failing: [`${SUBS}/agent-bad.jsonl`],
    listed: ['agent-bad.jsonl', 'agent-good.jsonl'],
  })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const listed = await titles($)
  expect(listed).toContain('One')
  expect(listed).toContain('Good sub ask')
  expect(listed.includes('Bad sub ask')).toBe(false)
  expect(shown.some(line => line.includes('subagent bad') && line.includes('Permission denied'))).toBe(true)
})

test('a forked session is rebuilt once its transcript exists: at session.start, or else at the first turn', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const files = host(on, { [FORK]: SESSION }, { hidden: [FORK] })
  await $.classic.SessionStart({ source: 'fork', transcript_path: FORK })
  await $.session.start({ cwd: DIR, surface: 'terminal', isInteractive: true })
  expect(files.read).toEqual([])
  files.appear(FORK)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await clock.settle()
  expect(files.read).toEqual([FORK])
  expect(await titles($)).toContain('#3 non-blocking, open: Three')
})

for (const reason of ['clear', 'resume'] as const) {
  test(`a session's end (${reason}) while a rebuild runs keeps the old conversation's items out of the next list, and the tool does not wait for it`, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    const files = host(on, { [MAIN]: SESSION }, { held: true })
    await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    expect((await $.tool.call({ tool: TOOL, action: 'add', title: 'Fresh' })).result).toBe('added #1')
    files.gate.open()
    await clock.settle()
    expect(await titles($)).toBe('#1 non-blocking, open: Fresh')
  })
}

// The Claude TODO list, rebuilt beside the human list. Three writes on the live branch (the last gives the list), a read-only call, a write on a
// branch a /rewind abandoned, and an errored write.
const todoCall = (uuid: string, parent: string, s: number, id: string, input: Record<string, unknown>) =>
  ({ uuid, parentUuid: parent, timestamp: at(s), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: TODO_TOOL, input }] } })
const todoErrored = (uuid: string, parent: string, s: number, id: string, text: string) =>
  ({ uuid, parentUuid: parent, timestamp: at(s), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] } })
const entries = (...pairs: [string, string][]) => pairs.map(([title, state]) => ({ title, state, eta: NO_ETA }))
const TODO_SESSION = jsonl(
  prompt('u0', null, 0),
  todoCall('a1', 'u0', 1, 'w1', { entries: entries(['Plan one', 'in_flight']) }),
  reply('r1', 'a1', 2, 'w1', 'Claude TODO: 1 in flight, 0 queued'),
  todoCall('a2', 'r1', 3, 'w2', { entries: entries(['Plan one', 'done'], ['Plan two', 'in_flight'], ['Plan three', 'queued']) }),
  reply('r2', 'a2', 4, 'w2', 'Claude TODO: 1 in flight, 1 queued'),
  todoCall('a3', 'r2', 5, 'w3', { entries: entries(['Plan two', 'done'], ['Plan three', 'in_flight'], ['Plan four', 'queued']) }),
  reply('r3', 'a3', 6, 'w3', 'Claude TODO: 1 in flight, 1 queued'),
  todoCall('a4', 'r3', 7, 'w4', {}),
  reply('r4', 'a4', 8, 'w4', 'Claude TODO: 1 in flight, 1 queued\n- in_flight: Plan three (ETA: no ETA)\n- queued: Plan four (ETA: no ETA)'),
  todoCall('a5', 'r4', 9, 'w5', { entries: entries(['Errored', 'in_flight']) }),
  todoErrored('r5', 'a5', 10, 'w5', 'claude_todo: the mod failed to answer the call'),
  prompt('p-old', 'r5', 11),
  todoCall('a6', 'p-old', 12, 'w6', { entries: entries(['Rewound away', 'in_flight']) }),
  reply('r6', 'a6', 13, 'w6', 'Claude TODO: 1 in flight, 0 queued'),
  prompt('p-new', 'r5', 14),
)
const LAST_LIST = 'Agent TODO: 1 in flight, 1 queued\n- in_flight: Plan three (ETA: no ETA)\n- queued: Plan four (ETA: no ETA)'
// The same session with a human ask added on the live branch after the last prompt.
const BOTH = jsonl(...TODO_SESSION.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>), call('h1', 'p-new', 15, 'h', { action: 'add', title: 'An ask' }), reply('hr', 'h1', 16, 'h', 'added #1'))
const todoList = async ($: Engine) => String((await $.tool.call({ tool: TODO_TOOL })).result)

test('a resumed session shows the Claude list the last live write gave, done entries absent, and rebuilds the human list as before', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: BOTH })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe(LAST_LIST)
  expect(await titles($)).toBe('#1 non-blocking, open: An ask')
})

// Twenty a, a family of three ending on a joiner, then the ellipsis: an ETA a cut left split.
test('a rebuild over a stored split ETA restores it repaired', async ($, on) => {
  mock.clock(on)
  const split = `${'a'.repeat(20)}👨‍👩‍👧‍…`
  host(on, {
    [MAIN]: jsonl(
      prompt('u0', null, 0),
      todoCall('a1', 'u0', 1, 'w1', { entries: [{ title: 'Plan one', state: 'in_flight', eta: split }] }),
      reply('r1', 'a1', 2, 'w1', 'Claude TODO: 1 in flight, 0 queued'),
    ),
  })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe(`Agent TODO: 1 in flight, 0 queued\n- in_flight: Plan one (ETA: ${'a'.repeat(20)}…)`)
})

test('a transcript with no Claude list write rebuilds an empty Claude list', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: SESSION })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await titles($)).toContain('#1 non-blocking, open: One')
  expect(await todoList($)).toBe('Agent TODO: 0 in flight, 0 queued')
})

test('a Claude list call made during the rebuild waits for it, and sees the rebuilt list once the wait ends', async ($, on) => {
  const clock = mock.clock(on)
  const files = host(on, { [MAIN]: TODO_SESSION }, { held: true })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const reading = $.tool.call({ tool: TODO_TOOL })
  await clock.settle()
  files.gate.open()
  expect(String((await reading).result)).toBe(LAST_LIST)
})

test('a Claude list call waits for the rebuild only so long, and is refused with the list unchanged', async ($, on) => {
  const clock = mock.clock(on)
  const files = host(on, { [MAIN]: TODO_SESSION }, { held: true })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const writing = $.tool.call({ tool: TODO_TOOL, entries: entries(['Too early', 'queued']) })
  await clock.settle()
  await clock.advance(5000)
  expect(String((await writing).deny)).toContain('still being rebuilt')
  files.gate.open()
  await clock.settle()
  expect(await todoList($)).toBe(LAST_LIST)
  expect(await todoList($)).not.toContain('Too early')
})

test('a list written live before the rebuild stays as written, an emptied one included, and the rebuild leaves it unchanged', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: TODO_SESSION })
  await $.tool.call({ tool: TODO_TOOL, entries: entries(['Live', 'in_flight']) })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe('Agent TODO: 1 in flight, 0 queued\n- in_flight: Live (ETA: no ETA)')
})

test('a list emptied live before the rebuild stays empty', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: TODO_SESSION })
  await $.tool.call({ tool: TODO_TOOL, entries: [] })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe('Agent TODO: 0 in flight, 0 queued')
})

test('a forked session\'s Claude list is rebuilt once its transcript exists, at the same point as the human list\'s', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const files = host(on, { [FORK]: TODO_SESSION }, { hidden: [FORK] })
  await $.classic.SessionStart({ source: 'fork', transcript_path: FORK })
  await $.session.start({ cwd: DIR, surface: 'terminal', isInteractive: true })
  expect(files.read).toEqual([])
  files.appear(FORK)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await clock.settle()
  expect(await todoList($)).toBe(LAST_LIST)
})

test('a fork whose first live write lands before its rebuild starts keeps that write, where the transcript holds an older one', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const files = host(on, { [FORK]: TODO_SESSION }, { hidden: [FORK] })
  await $.classic.SessionStart({ source: 'fork', transcript_path: FORK })
  await $.session.start({ cwd: DIR, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TODO_TOOL, entries: entries(['Newer than the transcript', 'in_flight']) })
  files.appear(FORK)
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await clock.settle()
  expect(await todoList($)).toBe('Agent TODO: 1 in flight, 0 queued\n- in_flight: Newer than the transcript (ETA: no ETA)')
})

// A write to one key of the state that never lands: the version it checks against is always stale, so the update gives up. The kit answers the
// other keys.
const failingWrite = (on: On, key: string) => {
  on('state.set', (_$, e, next) => (e.key === key ? { value: { isSet: false, version: 999 } } : next(e)))
}
const shownLogs = (on: On) => {
  const shown: string[] = []
  on('ui.log', (_$, e, next) => {
    if (e.to !== 'debug') shown.push(e.text)
    return next(e)
  })
  return shown
}

test('a rebuild whose Claude list write fails logs the failure, leaves that list as it was, and rebuilds the human list as before', async ($, on) => {
  mock.clock(on)
  const shown = shownLogs(on)
  failingWrite(on, 'todo')
  host(on, { [MAIN]: BOTH })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await titles($)).toBe('#1 non-blocking, open: An ask')
  expect(shown.filter(line => line.includes('the Claude TODO list was not rebuilt')).length).toBeGreaterThan(0)
  expect(await todoList($)).toBe('Agent TODO: 0 in flight, 0 queued')
})

test('a rebuild whose human list write fails logs it and still rebuilds the Claude list', async ($, on) => {
  mock.clock(on)
  const shown = shownLogs(on)
  failingWrite(on, 'list')
  host(on, { [MAIN]: BOTH })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe(LAST_LIST)
  expect(shown.filter(line => line.includes('the list was not rebuilt')).length).toBeGreaterThan(0)
})

test('a session that ends between the rebuild\'s two writes does not get the old conversation\'s Claude list', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  host(on, { [MAIN]: BOTH })
  // The human list's write is held, so the session can end after the rebuild passed its first check and before it fills the Claude list.
  const held: { release: () => void; reached: () => void } = { release: () => undefined, reached: () => undefined }
  const gate = new Promise<void>(resolve => (held.release = resolve))
  const reached = new Promise<void>(resolve => (held.reached = resolve))
  on('state.set', async (_$, e, next) => {
    if (e.key === 'list') {
      held.reached()
      await gate
    }
    return next(e)
  })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await reached
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  held.release()
  await clock.settle()
  expect(await todoList($)).toBe('Agent TODO: 0 in flight, 0 queued')
})

// The name the agent states for its list, rebuilt in the same pass as the lists: Ada with a write, then Grace by a call with no entries, then a write with no name, and a name on a branch a /rewind abandoned.
const NAMED_SESSION = jsonl(
  prompt('u0', null, 0),
  todoCall('a1', 'u0', 1, 'w1', { name: 'Ada', entries: entries(['Plan one', 'in_flight']) }),
  reply('r1', 'a1', 2, 'w1', 'Ada TODO: 1 in flight, 0 queued'),
  todoCall('a2', 'r1', 3, 'w2', { name: 'Grace' }),
  reply('r2', 'a2', 4, 'w2', 'Grace TODO: 1 in flight, 0 queued\n- in_flight: Plan one (ETA: no ETA)'),
  todoCall('a3', 'r2', 5, 'w3', { entries: entries(['Plan two', 'queued']) }),
  reply('r3', 'a3', 6, 'w3', 'Grace TODO: 0 in flight, 1 queued'),
  todoCall('a4', 'r3', 7, 'w4', { name: 'Errored' }),
  todoErrored('r4', 'a4', 8, 'w4', 'claude_todo: the mod failed to answer the call'),
  prompt('p-old', 'r4', 9),
  todoCall('a5', 'p-old', 10, 'w5', { name: 'Rewound away' }),
  reply('r5', 'a5', 11, 'w5', 'Rewound away TODO: 0 in flight, 1 queued'),
  prompt('p-new', 'r4', 12),
)
const NAMED_LAST = 'Grace TODO: 0 in flight, 1 queued\n- queued: Plan two (ETA: no ETA)'
// The first line of the answer to a read of the Claude list: its heading and counts.
const headLine = async ($: Engine) => (await todoList($)).split('\n')[0]

test('a resumed session draws the name the main agent last stated, a name-only call included and a later call with no name leaving it, with the list the last write gave; an errored call, a rewound one and a call before them state none that counts', async ($, on) => {
  mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  host(on, { [MAIN]: NAMED_SESSION })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe(NAMED_LAST)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('Grace TODO ')
})

test('a resumed session whose last call that stated a name stated a blank one draws Agent TODO', async ($, on) => {
  mock.clock(on)
  host(on, {
    [MAIN]: jsonl(
      prompt('u0', null, 0),
      todoCall('a1', 'u0', 1, 'w1', { name: 'Ada', entries: entries(['Plan one', 'in_flight']) }),
      reply('r1', 'a1', 2, 'w1', 'Ada TODO: 1 in flight, 0 queued'),
      todoCall('a2', 'r1', 3, 'w2', { name: '  ' }),
      reply('r2', 'a2', 4, 'w2', 'Agent TODO: 1 in flight, 0 queued\n- in_flight: Plan one (ETA: no ETA)'),
    ),
  })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe('Agent TODO: 1 in flight, 0 queued\n- in_flight: Plan one (ETA: no ETA)')
})

test('a transcript whose calls state no name leaves the resumed session without one: its heading is Agent TODO', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: TODO_SESSION })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await headLine($)).toBe('Agent TODO: 1 in flight, 1 queued')
})

test('a name stated live before the rebuild is kept over the transcript\'s', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: NAMED_SESSION })
  await $.tool.call({ tool: TODO_TOOL, name: 'Mine' })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await headLine($)).toBe('Mine TODO: 0 in flight, 1 queued')
})

test('a name cleared live before the rebuild stays cleared: the next answer opens Agent TODO', async ($, on) => {
  mock.clock(on)
  host(on, { [MAIN]: NAMED_SESSION })
  await $.tool.call({ tool: TODO_TOOL, name: '  ' })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await headLine($)).toBe('Agent TODO: 0 in flight, 1 queued')
})

test('a call that states a name waits for the rebuild as the list\'s calls do, and then replaces the rebuilt name', async ($, on) => {
  const clock = mock.clock(on)
  const files = host(on, { [MAIN]: NAMED_SESSION }, { held: true })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  const renaming = $.tool.call({ tool: TODO_TOOL, name: 'Linus' })
  await clock.settle()
  files.gate.open()
  expect(String((await renaming).result).split('\n')[0]).toBe('Linus TODO: 0 in flight, 1 queued')
})

test('a rebuild whose list fill fails logs it and still sets the name', async ($, on) => {
  mock.clock(on)
  const shown = shownLogs(on)
  failingWrite(on, 'todo')
  host(on, { [MAIN]: NAMED_SESSION })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe('Grace TODO: 0 in flight, 0 queued')
  expect(shown.filter(line => line.includes('the Claude TODO list was not rebuilt')).length).toBeGreaterThan(0)
  expect(shown.filter(line => line.includes('the agent list\'s name was not rebuilt'))).toEqual([])
})

test('a rebuild whose name fill fails logs the failure naming the name, and leaves the rebuilt list in place under Agent TODO', async ($, on) => {
  mock.clock(on)
  const shown = shownLogs(on)
  failingWrite(on, 'todoName')
  host(on, { [MAIN]: NAMED_SESSION })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  expect(await todoList($)).toBe('Agent TODO: 0 in flight, 1 queued\n- queued: Plan two (ETA: no ETA)')
  const failed = shown.filter(line => line.startsWith('human-plugin: the agent list\'s name was not rebuilt: '))
  expect(failed).toHaveLength(1)
  expect(shown.filter(line => line.includes('the Claude TODO list was not rebuilt'))).toEqual([])
})

// A session's end during the rebuild, held where the rebuild fills the list: the first write to the list's key is held, so the session can end after the rebuild passed its checks and
// while its list fill is under way, and before the name's fill begins. Only the first write: a /clear writes the key again.
for (const reason of ['clear', 'resume'] as const) {
  test(`a session's end (${reason}) that lands while the rebuild's list fill is held leaves no name from that rebuild: the next answer opens Agent TODO`, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    host(on, { [MAIN]: NAMED_SESSION })
    const held: { release: () => void; reached: () => void } = { release: () => undefined, reached: () => undefined }
    const gate = new Promise<void>(resolve => (held.release = resolve))
    const reached = new Promise<void>(resolve => (held.reached = resolve))
    let first = true
    on('state.set', async (_$, e, next) => {
      if (e.key === 'todo' && first) {
        first = false
        held.reached()
        await gate
      }
      return next(e)
    })
    await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
    await reached
    await $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })
    held.release()
    await clock.settle()
    expect(await headLine($)).toMatch(/^Agent TODO: \d+ in flight, \d+ queued$/)
  })
}

test('a /clear writes the name as cleared: the heading reads Agent TODO, and a call that states a name after it sets it', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: TODO_TOOL, name: 'Ada', entries: entries(['Plan one', 'in_flight']) })
  expect(await headLine($)).toBe('Ada TODO: 1 in flight, 0 queued')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(await todoList($)).toBe('Agent TODO: 0 in flight, 0 queued')
  expect(String((await $.tool.call({ tool: TODO_TOOL, name: 'Ada' })).result)).toBe('Ada TODO: 0 in flight, 0 queued')
})

test('a session\'s end that is not a /clear leaves the name', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.tool.call({ tool: TODO_TOOL, name: 'Ada' })
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  expect(await headLine($)).toBe('Ada TODO: 0 in flight, 0 queued')
})

// A fork's transcript is the copy the engine makes: the original's live branch from its last compaction on. A name stated after that compaction is in it; one stated before it is not.
const FORK_NAMED = jsonl(
  { uuid: 'c0', parentUuid: null, timestamp: at(0), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'The conversation so far, summarised.' } },
  todoCall('a1', 'c0', 1, 'w1', { name: 'Ada', entries: entries(['Plan one', 'in_flight']) }),
  reply('r1', 'a1', 2, 'w1', 'Ada TODO: 1 in flight, 0 queued'),
)
const FORK_UNNAMED = jsonl(
  { uuid: 'c0', parentUuid: null, timestamp: at(0), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'The conversation so far, summarised. The agent had named itself Ada.' } },
  todoCall('a1', 'c0', 1, 'w1', { entries: entries(['Plan one', 'in_flight']) }),
  reply('r1', 'a1', 2, 'w1', 'Ada TODO: 1 in flight, 0 queued'),
)

for (const [what, text, want] of [
  ['stated after the original\'s last compaction draws it', FORK_NAMED, 'Ada TODO: 1 in flight, 0 queued\n- in_flight: Plan one (ETA: no ETA)'],
  ['stated only before it is not restored: the fork draws Agent TODO with the list the copied transcript\'s last write gave', FORK_UNNAMED, 'Agent TODO: 1 in flight, 0 queued\n- in_flight: Plan one (ETA: no ETA)'],
] as const) {
  test(`a fork's name ${what}`, async ($, on) => {
    const clock = mock.clock(on)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('tool.register', () => ({ value: { tool: TOOL } }))
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    const files = host(on, { [FORK]: text }, { hidden: [FORK] })
    await $.classic.SessionStart({ source: 'fork', transcript_path: FORK })
    await $.session.start({ cwd: DIR, surface: 'terminal', isInteractive: true })
    files.appear(FORK)
    await $.turn.start({ text: 'go on', turnId: 't1' })
    await clock.settle()
    expect(await todoList($)).toBe(want)
  })
}
