import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { EMPTY, TOOL } from './items'

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

// The clock, the store, the pane, the session's end and the chime a filing plays, for a test that files a blocking item. The chime's
// record comes back with the clock.
const kit = (on: On) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  const runs = chimes(on)
  return { clock, runs }
}

// The state the mod keeps, held by the test: the kit gives a test no `$.state` to write the list with, so every reference's reads and writes
// are answered from this map, in the `{ value }` form the engine's hooks answer with, and a test may replace the list.
const stateHeld = (on: On) => {
  const held = new Map<string, { value: unknown; version: number }>()
  const keyOf = (ref: { plugin: string; key: string; id?: string }) => [ref.plugin, ref.key, ref.id ?? ''].join('\u0000')
  const read = (ref: { plugin: string; key: string; id?: string }) => held.get(keyOf(ref)) ?? { value: undefined, version: 0 }
  on('state.get', (_$, e) => ({ value: read(e) }))
  on('state.set', (_$, e) => {
    const cur = read(e)
    if (e.ifVersion !== undefined && e.ifVersion !== cur.version) return { value: { isSet: false, version: cur.version } }
    held.set(keyOf(e), { value: e.value, version: cur.version + 1 })
    return { value: { isSet: true, version: cur.version + 1 } }
  })
  const listRef = { plugin: 'human-plugin', key: 'list' }
  return {
    list: () => read(listRef).value,
    replaceList: (store: unknown): void => {
      held.set(keyOf(listRef), { value: store, version: read(listRef).version + 1 })
    },
  }
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, action: 'remove', id: 1 })
  await clock.advance(60000)
  expect(messages.length).toBe(1)
})

test('a retry stops once the item is no longer blocking', async ($, on) => {
  const { clock } = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: false })
  await clock.advance(60000)
  expect(messages.length).toBe(1)
})

test('a refused push is tried again each minute until an hour after the first try, and then no more', async ($, on) => {
  const { clock } = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.advance(3540000)
  expect(messages.length).toBe(60)
  await clock.advance(600000)
  expect(messages.length).toBe(60)
})

test('a push refused as config_off is not tried again, and is logged once, at debug only', async ($, on) => {
  const { clock } = kit(on)
  const lines = logs(on)
  const messages = pushes(on, answering({ pushSent: false, disabledReason: 'config_off' }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.advance(120000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  const pushLog = lines.filter(line => line.text.includes('the push for #1'))
  expect(pushLog).toEqual([{ text: 'human-plugin: the push for #1 was not sent: config_off', to: 'debug' }])
})

test('a push refused as no_transport is not tried again, and is logged once, at debug only', async ($, on) => {
  const { clock } = kit(on)
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
    const { clock } = kit(on)
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
  const list = stateHeld(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  const listed = list.list()
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  // The clear empties the list, and a retry that finds its item gone ends anyway: the list is put back, so only the chain's end stops it.
  list.replaceList(listed)
  await clock.advance(3600000)
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
})

// The list is replaced with the empty one a resumed session starts from, numbering from 1, so the new item takes the id the refused item had.
// The new item is refused too, so its chain still holds that id when the old chain's retry falls due: the old chain must not push in its place.
test('a new item that takes the id of an item refused before a session end is pushed by its own chain alone: the old chain pushes nothing, logs nothing and schedules nothing', async ($, on) => {
  const { clock } = kit(on)
  const lines = logs(on)
  const messages = pushes(on, (n, message) => (n <= 2 ? userPresent(n, message) : sent(n, message)))
  const list = stateHeld(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Old' })
  await clock.settle()
  await clock.advance(10000)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's1' } })
  list.replaceList(EMPTY)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'New' })
  await clock.settle()
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toContain('#1 blocking, open: New')
  await clock.advance(50000)
  expect(messages).toEqual(['Blocking: #1 Old', 'Blocking: #1 New'])
  await clock.advance(3600000)
  expect(messages).toEqual(['Blocking: #1 Old', 'Blocking: #1 New', 'Blocking: #1 New'])
  expect(lines.filter(line => line.text.includes('the push for #1'))).toEqual([])
})

test('a resume ends the retries of the items filed before it, and the list it rebuilds pushes nothing', async ($, on) => {
  const { clock } = kit(on)
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
  const { clock } = kit(on)
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
  const { clock } = kit(on)
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

test('an item answered and reopened within a minute of its refused push has one chain: its push a minute after the reopen is the only retry', async ($, on) => {
  const { clock } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(10000)
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'The sqlite file is in data/.' })
  await clock.settle()
  expect(messages.length).toBe(2)
  await clock.advance(50000)
  expect(messages.length).toBe(2)
  await clock.advance(10000)
  expect(messages.length).toBe(3)
})

test('an item turned non-blocking and blocking again within a minute of its refused push has one chain', async ($, on) => {
  const { clock } = kit(on)
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await clock.advance(10000)
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: false })
  await clock.advance(10000)
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  await clock.settle()
  expect(messages.length).toBe(2)
  await clock.advance(40000)
  expect(messages.length).toBe(2)
  await clock.advance(20000)
  expect(messages.length).toBe(3)
})

test('an item answered and reopened while its first push call is in flight: the replaced call logs and schedules nothing, even when it is refused late', async ($, on) => {
  const { clock } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const lines = logs(on)
  let refuseFirst: () => void = () => undefined
  const messages = pushes(on, (n, message) => (n === 1
    ? new Promise(resolve => {
      refuseFirst = () => resolve({ result: { message, pushSent: false, disabledReason: 'user_present' } })
    })
    : userPresent(n, message)))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'The sqlite file is in data/.' })
  await clock.settle()
  expect(messages.length).toBe(2)
  await clock.advance(8000)
  refuseFirst()
  await clock.settle()
  expect(messages.length).toBe(2)
  expect(lines.filter(line => line.text.includes('the push for #1'))).toEqual([])
  await clock.advance(52000)
  expect(messages.length).toBe(3)
  await clock.advance(8000)
  expect(messages.length).toBe(3)
})

test('a new session\'s first push call logs its whole answer at debug, as the first of that session', async ($, on) => {
  const { clock } = kit(on)
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

// The undo window is 3 seconds. Its end is what reopens an item the agent changed inside the window, so that end is the push's moment: the
// call that made the change pushes nothing, and neither does an undo or a window the agent left alone.
test('an update to blocking inside the undo window pushes nothing at the call, and one push when the window reopens the item, with no chime', async ($, on) => {
  const { clock, runs } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(1000)
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  await clock.settle()
  expect(messages).toEqual([])
  expect(runs).toEqual([])
  await clock.advance(2000)
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  expect(runs).toEqual([])
})

test('an agent turn the undo window takes pushes once when the window reopens the item, and plays no chime', async ($, on) => {
  const { clock, runs } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(1000)
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'The sqlite file is in data/.' })
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  await clock.advance(2000)
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a db'])
  expect(runs.length).toBe(1)
})

test('a window the agent changed nothing in pushes nothing when it ends', async ($, on) => {
  const { clock, runs } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(3000)
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  expect(runs.length).toBe(1)
})

test('an undo pushes nothing, and the item stays open and blocking', async ($, on) => {
  const { clock, runs } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(1000)
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  await clock.settle()
  expect(messages).toEqual(['Blocking: #1 Pick a db'])
  expect(runs.length).toBe(1)
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toContain('#1 blocking, open: Pick a db')
})

test('a retry that fires inside the undo window pushes nothing and waits a minute; an undo leaves the next retry to push', async ($, on) => {
  const { clock } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on, (n, message) => (n === 1 ? userPresent(n, message) : sent(n, message)))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await clock.advance(59000)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(1000)
  expect(messages.length).toBe(1)
  await clock.advance(1000)
  await ui.press({ key: 'done-1' })
  await clock.advance(59000)
  expect(messages).toEqual(['Blocking: #1 Pick a db', 'Blocking: #1 Pick a db'])
})

test('a retry inside the undo window, with the window then ending unchanged, leaves no retry to push', async ($, on) => {
  const { clock } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const messages = pushes(on, userPresent)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await clock.settle()
  await clock.advance(59000)
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(63000)
  expect(messages.length).toBe(1)
})

// Both windows end in the same tick, the first's by a reopen whose push hangs: the second's send is checked before the next tick, which would
// send it whatever the first did.
test('a push hung at one window\'s end does not hold back another item\'s send that ends in the same tick', async ($, on) => {
  const { clock } = kit(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const lines = logs(on)
  const messages = pushes(on, () => new Promise(() => {}))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Plain ask' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Second' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await ui.press({ key: 'done-2' })
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  await clock.advance(3000)
  expect(lines.filter(line => line.text.includes('sent #2 for press')).length).toBe(1)
  expect(messages).toEqual(['Blocking: #1 Plain ask'])
})
