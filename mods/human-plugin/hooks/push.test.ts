import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { TOOL } from './items'

const SOUND = '/System/Library/Sounds/Glass.aiff'
const RAN = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PUSH = { tool: 'PushNotification' } as const

// A push call's answer as the tool gives it: the result's fields, with the message the call pushed.
const answering = (fields: Record<string, unknown>) => (_n: number, message: string) => ({ result: { message, ...fields } })
const sent = answering({ pushSent: true })
const userPresent = answering({ pushSent: false, disabledReason: 'user_present' })

// The push calls the mod makes, in order, each answered by `answer(n, message)` (the n-th call from 1) with the whole answer the call gets:
// by default the push is sent. The messages are what the calls pushed. The permission check is allowed, as the mod's own check is.
const pushes = (on: On, answer: (n: number, message: string) => unknown = sent) => {
  const messages: string[] = []
  on('tool.check', PUSH, () => ({ decision: 'allow' }))
  on('tool.call', PUSH, async (_$, e) => {
    messages.push(e.message)
    return answer(messages.length, e.message) as never
  })
  return messages
}

// The clock, the store, the pane and the chime a filing plays, for a test that files a blocking item.
const kit = (on: On) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  chimes(on)
  return clock
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

test('a push refused as user_present is tried again a minute after its answer, with the title the item has now, until one is sent', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, (n, message) => (n === 1 ? userPresent(n, message) : sent(n, message)))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, title: 'Pick a database' })
  await clock.advance(59000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  await clock.advance(1000)
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a database'])
  await clock.advance(600000)
  expect(messages.length).toBe(2)
})

test('a retry stops once the human has answered the item and its undo window has passed', async ($, on) => {
  const clock = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await clock.advance(60000)
  expect(messages.length).toBe(1)
})

test('a retry stops once the item is removed', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, action: 'remove', id: 1 })
  await clock.advance(60000)
  expect(messages.length).toBe(1)
})

test('a retry stops once the item is no longer blocking', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: false })
  await clock.advance(60000)
  expect(messages.length).toBe(1)
})

test('a refused push is tried again each minute until an hour after the first try, and then no more', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.advance(3540000)
  expect(messages.length).toBe(60)
  await clock.advance(600000)
  expect(messages.length).toBe(60)
})

test('a push refused as config_off is not tried again, and is logged once, at debug only', async ($, on) => {
  const clock = kit(on)
  const lines = logs(on)
  const messages = pushes(on, answering({ pushSent: false, disabledReason: 'config_off' }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.advance(120000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  const pushLog = lines.filter(line => line.text.includes('the push for #1'))
  expect(pushLog).toEqual([{ text: 'human-plugin: the push for #1 was not sent: config_off', to: 'debug' }])
})

test('a push refused as no_transport is not tried again, and is logged once, at debug only', async ($, on) => {
  const clock = kit(on)
  const lines = logs(on)
  const messages = pushes(on, answering({ pushSent: false, disabledReason: 'no_transport' }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.advance(120000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  const pushLog = lines.filter(line => line.text.includes('the push for #1'))
  expect(pushLog).toEqual([{ text: 'human-plugin: the push for #1 was not sent: no_transport', to: 'debug' }])
})

// A push that ends its item's tries at once: each kind of answer, what the transcript says of it, and the item left as it was.
const ENDED: [string, (n: number, message: string) => unknown, string][] = [
  ['denied', () => ({ deny: 'refused by the test' }), 'was denied: refused by the test'],
  ['failed', (_n, message) => ({ result: { message }, isError: true, text: 'no network' }), 'failed: no network'],
  ['threw', () => { throw new Error('the channel broke') }, 'threw'],
  ['gave no outcome', answering({}), 'gave no outcome'],
]
for (const [kind, answer, said] of ENDED) {
  test(`a push that ${kind} is not tried again, is logged once in the transcript, and leaves the item blocking`, async ($, on) => {
    const clock = kit(on)
    const lines = logs(on)
    const messages = pushes(on, answer)
    await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
    await clock.advance(180000)
    expect(messages).toEqual(['Blocking: #1 Pick a db'])
    const pushLog = lines.filter(line => line.text.includes('the push for #1'))
    expect(pushLog.length).toBe(1)
    expect(pushLog[0]?.text).toContain(`the push for #1 ${said}`)
    expect(pushLog[0]?.to).toBe('transcript')
    expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toContain('#1 blocking, open: Pick a db')
  })
}

test('a push unanswered after 10 seconds ends its item\'s tries: it is logged once in the transcript and not tried again', async ($, on) => {
  const clock = kit(on)
  const lines = logs(on)
  const messages = pushes(on, () => new Promise(() => {}))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await clock.advance(9999)
  expect(lines.filter(line => line.text.includes('the push for #1'))).toEqual([])
  await clock.advance(1)
  await clock.advance(120000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  expect(lines.filter(line => line.text.includes('the push for #1'))).toEqual([{ text: 'human-plugin: the push for #1 was not answered in 10 seconds', to: 'transcript' }])
})

test('a reopen makes its own push when the item\'s earlier push went unanswered', async ($, on) => {
  const clock = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on, (n, message) => (n === 1 ? new Promise(() => {}) : sent(n, message)))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await clock.advance(10000)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'The sqlite file is in data/.' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a db'])
})

test('the first push call of a session logs its whole answer at debug, and no later call does', async ($, on) => {
  const clock = kit(on)
  const lines = logs(on)
  const messages = pushes(on, (_n, message) => ({ result: { message, pushSent: true, sentAt: '2026-10-25T10:00:00.000Z' }, text: 'pushed' }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Second' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #2 Second'])
  const whole = lines.filter(line => line.text.includes('first push call'))
  expect(whole.length).toBe(1)
  expect(whole[0]?.to).toBe('debug')
  expect(whole[0]?.text).toContain('"sentAt":"2026-10-25T10:00:00.000Z"')
  expect(whole[0]?.text).toContain('"text":"pushed"')
  expect(lines.filter(line => line.text.includes('"pushSent":true')).length).toBe(1)
})

test('a push answered user_present after its 10 seconds have passed schedules no retry', async ($, on) => {
  const clock = kit(on)
  let answerLate: () => void = () => undefined
  const messages = pushes(on, (_n, message) => new Promise(resolve => {
    answerLate = () => resolve({ result: { message, pushSent: false, disabledReason: 'user_present' } })
  }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await clock.advance(10000)
  answerLate()
  await clock.advance(120000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

test('a clear ends the retries of the items filed before it: none is tried again', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(3600000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

test('a resume ends the retries of the items filed before it, and the list it rebuilds pushes nothing', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, userPresent)
  hostTranscript(on, transcript('Pick a db'))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  await clock.settle()
  await clock.advance(600000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

test('a retry from before a resume pushes nothing after it, and an item filed after the resume is pushed by its own chain alone', async ($, on) => {
  const clock = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Old' })
  await clock.settle()
  await clock.advance(30000)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'New' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Old', 'Blocking: #2 New'])
  await clock.advance(30000)
  expect(messages).toEqual(['Blocking: #1 Old', 'Blocking: #2 New'])
  await clock.advance(30000)
  expect(messages).toEqual(['Blocking: #1 Old', 'Blocking: #2 New', 'Blocking: #2 New'])
})

test('a session end whose later steps throw still ends every pending retry', async ($, on) => {
  const clock = mock.clock(on)
  on('ui.panes', () => ({ value: [] }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  chimes(on)
  on('store.get', () => {
    throw new Error('store unreadable')
  })
  on('store.set', () => ({ value: undefined }))
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } }).catch(() => undefined)
  await clock.advance(600000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

test('a push in flight at a session end that is answered user_present afterwards pushes nothing and schedules no retry', async ($, on) => {
  const clock = kit(on)
  let answerLate: () => void = () => undefined
  const messages = pushes(on, (_n, message) => new Promise(resolve => {
    answerLate = () => resolve({ result: { message, pushSent: false, disabledReason: 'user_present' } })
  }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  answerLate()
  await clock.advance(600000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

test('a new session\'s first push call logs its whole answer at debug, as the first of that session', async ($, on) => {
  const clock = kit(on)
  const lines = logs(on)
  const messages = pushes(on, (_n, message) => ({ result: { message, pushSent: true } }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Next' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #2 Next'])
  expect(lines.filter(line => line.text.includes('first push call')).length).toBe(2)
})
