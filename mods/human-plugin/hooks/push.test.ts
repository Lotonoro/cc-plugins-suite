import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { TOOL } from './items'

const SOUND = '/System/Library/Sounds/Glass.aiff'
const RAN = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PUSH = { tool: 'PushNotification' } as const

// The push calls the mod makes, in order, each answered by `answer(n, message)` (the n-th call from 1): by default the push is sent. The
// messages are what the calls pushed. The permission check is allowed, as the mod's own check is.
const pushes = (on: On, answer: (n: number, message: string) => Promise<Record<string, unknown>> | Record<string, unknown> = () => ({ pushSent: true })) => {
  const messages: string[] = []
  on('tool.check', PUSH, () => ({ decision: 'allow' }))
  on('tool.call', PUSH, async (_$, e) => {
    messages.push(e.message)
    return { result: { message: e.message, ...(await answer(messages.length, e.message)) } }
  })
  return messages
}

// The sounds the mod plays: each afplay's argv.
const chimes = (on: On) => {
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return RAN
  })
  return runs
}

// The lines the mod logs, with the level each goes to.
const logs = (on: On) => {
  const lines: { text: string; to: string | undefined }[] = []
  on('ui.log', (_$, e, next) => {
    lines.push({ text: e.text, to: e.to })
    return next(e)
  })
  return lines
}

// A transcript that holds one blocking item, #1, that the agent filed: the rebuild on resume reads it.
const MAIN = '/projects/p/s1.jsonl'
const transcript = (title: string) =>
  [
    { uuid: 'u0', parentUuid: null, timestamp: '2026-10-20T10:00:00.000Z', type: 'user', message: { role: 'user', content: 'go' } },
    { uuid: 'a1', parentUuid: 'u0', timestamp: '2026-10-20T10:00:01.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: TOOL, input: { action: 'add', title, blocking: true } }] } },
    { uuid: 'r1', parentUuid: 'a1', timestamp: '2026-10-20T10:00:02.000Z', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'added #1' }] } },
  ]
    .map(row => `${JSON.stringify(row)}\n`)
    .join('')

// A transcript file the rebuild reads: `cat` streams it, and nothing else exists.
const hostTranscript = (on: On, text: string) => {
  on('classic.SessionStart', () => ({}))
  on('fs.exists', (_$, e) => ({ value: e.path === MAIN }))
  on('fs.list', () => ({ value: [] }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text }
    return { value: { code: 0, signal: null } }
  })
}

test('a blocking filing pushes one line that names the item, and plays the chime', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  const runs = chimes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  expect(runs).toEqual([['afplay', SOUND]])
})

test('a non-blocking filing pushes nothing', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Plain ask' })
  await clock.settle()
  expect(messages).toEqual([])
})

test('an update that makes an open item blocking pushes once, and plays the chime', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  const runs = chimes(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  expect(runs).toEqual([['afplay', SOUND]])
})

test('an update to an open blocking item that leaves it blocking pushes nothing more', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, title: 'Pick a database' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

test('an append that reopens a blocking item the human answered pushes once, and plays no chime', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  const runs = chimes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'The sqlite file is in data/.' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a db'])
  expect(runs).toEqual([['afplay', SOUND]])
})

test('an update that reopens a sent blocking item pushes once, and so does one that reopens a sent item by turning it blocking', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  const runs = chimes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, title: 'Pick a database' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a database'])
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Plain ask' })
  await ui.press({ key: 'done-2' })
  await clock.advance(3000)
  await $.tool.call({ tool: TOOL, action: 'update', id: 2, blocking: true })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a database', 'Blocking: #2 Plain ask'])
  expect(runs).toEqual([['afplay', SOUND]])
})

test('reopening a non-blocking item pushes nothing', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Plain ask' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'More context.' })
  await clock.settle()
  expect(messages).toEqual([])
})

test('a list rebuilt on resume pushes nothing, and the rebuilt blocking item is listed', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  hostTranscript(on, transcript('Pick a db'))
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await clock.settle()
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toContain('Pick a db')
  expect(messages).toEqual([])
})

test('the push is one line: a line break in the title is drawn as a space', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick\na db\r\nnow' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db now'])
})

test('a title too long for the push is cut to 180 characters in all, the ellipsis counted within them', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'b'.repeat(200) })
  await clock.settle()
  expect(messages).toEqual([`Blocking: #1 ${'b'.repeat(166)}…`])
  expect(messages[0]?.length).toBe(180)
})

test('a cut push never splits a surrogate pair: one that would is one unit shorter', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: `${'a'.repeat(165)}😀tail` })
  await clock.settle()
  expect(messages).toEqual([`Blocking: #1 ${'a'.repeat(165)}…`])
})

test('a title that fits the 180 characters with its prefix is pushed whole', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'b'.repeat(167) })
  await clock.settle()
  expect(messages).toEqual([`Blocking: #1 ${'b'.repeat(167)}`])
})
