import type { On, PromptComposeInput, SessionAppendInput, UiPane } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { STEERING } from './steering'
import { TOOL } from './items'
import { TODO_TOOL } from './todo'
import { correctionText } from './restatement'

const FACTS: PromptComposeInput = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
}

test('the tool allows itself and answers add, list and remove', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  expect((await $.tool.check({ tool: TOOL, input: { action: 'list' } })).decision).toBe('allow')
  const added = await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db', blocking: true })
  expect(added.result).toBe('added #1')
  const listed = await $.tool.call({ tool: TOOL, action: 'list' })
  expect(String(listed.result)).toContain('Pick a db')
  const removed = await $.tool.call({ tool: TOOL, action: 'remove', id: 1 })
  expect(removed.result).toBe('removed #1')
})

test('append adds a section to a brief and answers with the id; a no-change update says so', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db', detail: 'the question' })
  const appended = await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'the options' })
  expect(appended.result).toBe('appended to #1')
  const same = await $.tool.call({ tool: TOOL, action: 'update', id: 1, title: 'Pick a db' })
  expect(same.result).toBe('no change to #1')
})

test('a malformed call is refused, and the steering section is the same before and after list changes', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [] }))
  const refused = await $.tool.call({ tool: TOOL, action: 'add' })
  expect(refused.deny).toContain('add needs a title')
  const before = (await $.prompt.compose(FACTS)).sections.find(s => s.id === STEERING.id)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Another ask' })
  const after = (await $.prompt.compose(FACTS)).sections.find(s => s.id === STEERING.id)
  expect(after?.text).toBe(before?.text)
  expect(after?.scope).toBe('session')
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }

test('a done press waits out the undo window and sends once; a second press inside the window sends nothing', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db', detail: 'pg' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(2000)
  expect(sent).toEqual([])
  await ui.press({ key: 'done-1' })
  await clock.advance(10000)
  expect(sent).toEqual([])
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('#1 is done: Pick a db')
  await clock.advance(10000)
  expect(sent.length).toBe(1)
})

test('each notice names the press that sent it, and a reopened item needs a new press to send again', async ($, on) => {
  const { submitted: sent } = turnEngine(on)
  const lines: string[] = []
  const shown: string[] = []
  on('ui.log', (_$, e, next) => {
    lines.push(e.text)
    if (e.to !== 'debug') shown.push(e.text)
    return next(e)
  })
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('process.run', () => RAN)
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => ({ result: { message: e.message, pushSent: true } }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  await runAndEndTurn($)
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, note: 'recheck' })
  await clock.advance(60000)
  expect(sent.length).toBe(1)
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  await runAndEndTurn($)
  expect(sent.length).toBe(2)
  const pressTokens = lines
    .filter(l => l.endsWith('open -> done-waiting'))
    .map(l => /at (\d+)/.exec(l)?.[1])
  const sendTokens = lines.filter(l => l.includes('sent #1 for press ')).map(l => /press (\d+)/.exec(l)?.[1])
  expect(sendTokens).toEqual(pressTokens)
  expect(new Set(sendTokens).size).toBe(2)
  expect(shown).toEqual([])
})

const SOUND = '/System/Library/Sounds/Glass.aiff'
const RAN = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }

test('a subagent call carries its agent id to the item: only the agent that filed an item removes it', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Sub ask', agentId: 'sub-1' })
  const other = await $.tool.call({ tool: TOOL, action: 'remove', id: 1, agentId: 'sub-2' })
  expect(String(other.deny)).toContain('filed by another agent')
  const own = await $.tool.call({ tool: TOOL, action: 'remove', id: 1, agentId: 'sub-1' })
  expect(own.result).toBe('removed #1')
})

test('every add saves the id counter to the plugin store, so a /clear whose carry fails still finds it', async ($, on) => {
  mock.clock(on)
  const saved: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_$, e) => {
    if (e.key === 'next') saved.push(e.value)
    return { value: undefined }
  })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'One' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Two' })
  expect(saved).toEqual([2, 3])
})

test('a blocking add plays the sound and raises no toast; a non-blocking add raises neither', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const toasts: string[] = []
  const runs: string[][] = []
  on('ui.toast', (_$, e, next) => {
    toasts.push(e.text)
    return next(e)
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return RAN
  })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Plain ask' })
  expect(toasts).toEqual([])
  expect(runs).toEqual([])
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db', blocking: true })
  expect(toasts).toEqual([])
  expect(runs).toEqual([['afplay', SOUND]])
})

test('an update that makes an open item blocking plays the sound once; an unmark, a no-op and a flip on a sent item play nothing', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  const runs: string[][] = []
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    return RAN
  })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  expect(runs).toEqual([['afplay', SOUND]])
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: false })
  expect(runs).toEqual([['afplay', SOUND]])
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  expect(await $.tool.call({ tool: TOOL, action: 'list' })).toMatchObject({ result: '#1 non-blocking, done-pending: Pick a db\n  you: pressed done' })
  await $.tool.call({ tool: TOOL, action: 'update', id: 1, blocking: true })
  expect(runs).toEqual([['afplay', SOUND]])
})

test('a new item is unread until its title is pressed or the pane opens', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'First' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(JSON.stringify(await ui.drawn())).toContain('• #1')
  await ui.press({ key: 'title-1' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Second' })
  const afterAdd = JSON.stringify(await ui.drawn())
  expect(afterAdd).toContain('• #2')
  expect(afterAdd).not.toContain('• #1')
  await ui.press({ key: 'title-2' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('• #2')
})

test('no trace line reaches the band: press, sent and sound all go to the debug log', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('process.run', () => RAN)
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => ({ result: { message: e.message, pushSent: true } }))
  const lines: string[] = []
  const shown: string[] = []
  on('ui.log', (_$, e, next) => {
    lines.push(e.text)
    if (e.to !== 'debug') shown.push(e.text)
    return next(e)
  })
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db', blocking: true })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  expect(sent.length).toBe(1)
  for (const trace of ['done press #1 at', 'sent #1 for press', 'afplay exit 0']) {
    expect(lines.some(line => line.includes(trace))).toBe(true)
  }
  expect(shown).toEqual([])
})

// The session's rows, all refused beneath the plugins: nothing is kept, and the plugin's append comes back as a refusal.
const refusedRows = (on: On): { appended: () => readonly SessionAppendInput[] } => {
  on('session.append', () => ({ deny: 'refused by the test' }))
  return { appended: () => [] }
}

// A main-loop turn, with the test's hooks standing for the engine beneath the plugin. `submitted` the prompts the plugin
// submits, `rows` the rows the plugin appends.
// `refuse(n)` answers whether the plugin's n-th submit (counted from 1) is refused beneath it, as a settings block would.
// `appendFails` puts a refusal beneath the plugin's rows instead, so no row is kept.
const turnEngine = (on: On, refuse: (n: number) => boolean = () => false, appendFails = false) => {
  const submitted: string[] = []
  const rows = appendFails ? refusedRows(on) : mock.session(on)
  // The plugin's rows appended before each submit, so an order is checkable.
  const appendedAtSubmit: number[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    appendedAtSubmit.push(rows.appended().length)
    return refuse(submitted.length) ? { drop: 'refused by the test' } : { text: e.text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.PostToolBatch', () => ({}))
  on('classic.Stop', () => ({}))
  return { submitted, rows, appendedAtSubmit }
}

// One model request of the main turn, read to its end through the plugins' turn.step hooks.
const step = async ($: Engine, index: number, agentId?: string) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })
  for await (const _chunk of stream) continue
  return stream.result
}
const end = ($: Engine, reason: 'answer' | 'aborted' = 'answer', answer = '') =>
  $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })

// A done press on #1 whose undo window passes while the turn runs.
const pressedMidTurn = async ($: Engine, clock: { advance: (ms: number) => Promise<unknown> }) => {
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db', detail: 'pg' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
}
// The turn an entered submit starts, and its end: what the engine does after the plugin's prompt.submit enters.
const runAndEndTurn = async ($: Engine) => {
  await $.turn.start({ text: '', turnId: 't1' })
  await end($)
}
const notices = (rows: { appended: () => readonly SessionAppendInput[] }) =>
  rows.appended().filter(r => JSON.stringify(r.message.content).includes('#1 is done: Pick a db'))

test('a press whose window ends during the final step is submitted once, as a turn of its own after the turn ends: the stop is not held', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  await step($, 0)
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(undefined)
  expect(notices(rows).length).toBe(0)
  await end($)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('#1 is done: Pick a db')
  await end($)
  expect(submitted.length).toBe(1)
})

test('a press whose window ends while tools run is appended when the batch ends, before the next request, and only once', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  expect(notices(rows).length).toBe(0)
  await $.classic.PostToolBatch({ tool_calls: [] })
  expect(notices(rows).length).toBe(1)
  await step($, 1)
  await $.classic.PostToolBatch({ tool_calls: [] })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBe(undefined)
  await end($)
  expect(submitted).toEqual([])
  expect(notices(rows).length).toBe(1)
})

test('an interrupt starts no turn: a notice pending at it is held, and nothing is submitted', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  await end($, 'aborted')
  expect(submitted).toEqual([])
  expect(notices(rows).length).toBe(0)
})

test('a notice appended before an interrupt is not sent again: its row is the one copy, and no turn starts', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  await $.classic.PostToolBatch({ tool_calls: [] })
  await end($, 'aborted')
  expect(submitted).toEqual([])
  expect(notices(rows).length).toBe(1)
})

test('a subagent\'s batch end and step are not read points of the main turn', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  await $.classic.PostToolBatch({ tool_calls: [], agent_id: 'sub-1' })
  expect(notices(rows).length).toBe(0)
  await $.classic.PostToolBatch({ tool_calls: [] })
  await step($, 2, 'sub-1')
  expect((await $.classic.Stop({ stop_hook_active: false, agent_id: 'sub-1' })).block).toBe(undefined)
  await end($, 'aborted')
  expect(submitted).toEqual([])
  expect(notices(rows).length).toBe(1)
})

test('a band title press opens the pane on that item, and never expands the band: a one-line detail is read in the pane', async ($, on) => {
  const opened: string[] = []
  const shown = new Set<string>()
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    shown.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [...shown].map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isFocused: false, isPlaced: true }) as UiPane) }))
  mock.clock(on)
  mock.store(on)
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db', detail: 'Which store?\n\nMore context, read in the pane.' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Short one', detail: 'One line.' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'title-1' })
  expect(opened).toEqual(['human-items'])
  await ui.press({ key: 'title-2' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('One line.')
  // The switch re-opens the pane with the new item's rows, and the band still does not grow.
  expect(opened).toEqual(['human-items', 'human-items'])
})

const rowsWith = (rows: { appended: () => readonly SessionAppendInput[] }, text: string) =>
  rows.appended().filter(r => JSON.stringify(r.message.content).includes(text))

test('two idle expiries before the turn starts make one turn: the first is submitted, the second rides that turn, each read once', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a cache' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await ui.press({ key: 'done-2' })
  await clock.advance(5000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('#1 is done: Pick a db')
  expect(rowsWith(rows, '#2 is done: Pick a cache').length).toBe(0)
  await $.turn.start({ text: '', turnId: 't1' })
  await step($, 0)
  await end($)
  expect(submitted.length).toBe(1)
  expect(rowsWith(rows, '#1 is done: Pick a db').length).toBe(0)
  expect(rowsWith(rows, '#2 is done: Pick a cache').length).toBe(1)
})

test('a queued notice whose item the agent removed before the turn ends starts no turn', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  await $.tool.call({ tool: TOOL, action: 'remove', id: 1 })
  await end($)
  expect(submitted).toEqual([])
  expect(notices(rows).length).toBe(0)
})

test('a turn-end submit that does not enter holds its notice, and the session is idle: the next press submits', async ($, on) => {
  const { submitted } = turnEngine(on, n => n === 1)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a cache' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: '', turnId: 't1' })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  await end($)
  expect(submitted.length).toBe(1)
  await ui.press({ key: 'done-2' })
  await clock.advance(5000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('#2 is done: Pick a cache')
})

test('the undo window defaults to 3 seconds: a press shows a 3 s countdown when no option is given', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  expect(JSON.stringify(await ui.drawn())).toContain('[↶ 3s]')
})

test('a to-do with a brief shows no […] on its title; a decision with options does, since its answers are in the pane alone', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Approve the PR', detail: 'One line.' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db', options: [{ label: 'Use sqlite' }, { label: 'Use postgres', recommended: true }] })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Approve the PR"')
  expect(drawn).not.toContain('Approve the PR […]')
  expect(drawn).toContain('Pick a db […]')
  expect(drawn).not.toContain('"key":"details"')
})

test('a notice the agent removes before its row is appended is not appended: press, the window ends mid-turn, remove, then the batch ends', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  await $.tool.call({ tool: TOOL, action: 'remove', id: 1 })
  await $.classic.PostToolBatch({ tool_calls: [] })
  expect(notices(rows).length).toBe(0)
  await end($)
  expect(submitted).toEqual([])
})

test('an append that reopens an item whose notice is still owed neither drops nor repeats it, and the reply sent from the reopened item is delivered after it', async ($, on) => {
  const { rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await pressedMidTurn($, clock)
  expect((await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'one more thing' })).result).toBe('appended to #1')
  await $.classic.PostToolBatch({ tool_calls: [] })
  expect(notices(rows).length).toBe(1)
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: { title: 'Items for you', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  await pane.input({ key: 'reply-1', text: 'use sqlite' })
  await clock.advance(5000)
  await $.classic.PostToolBatch({ tool_calls: [] })
  const texts = notices(rows).map(textOf)
  expect(texts.length).toBe(2)
  expect(texts[0]).toContain('The human marked it done.')
  expect(texts[1]).toContain('The human replied on #1: use sqlite')
})

test('a notice queued while a turn starts is dropped when its item is removed before the turn\'s first request', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a cache' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  expect(submitted.length).toBe(1)
  await ui.press({ key: 'done-2' })
  await clock.advance(5000)
  await $.tool.call({ tool: TOOL, action: 'remove', id: 2 })
  await $.turn.start({ text: '', turnId: 't1' })
  expect(rowsWith(rows, '#2 is done: Pick a cache').length).toBe(0)
})

// The corrections the restatement check appends: each names the ids it corrects, and no other row does.
const RETRY = 'Set the retry limit for the sync-client retry policy'
const CACHE = 'Cache store for the reader'
const RETRY_TBD = "Retry limit: I left it as TBD, with a note not to ship the policy until it's set.\n\nAdded #1: what the retry limit should be."
const CACHE_UNDECIDED = 'Cache store for the reader is undecided, please pick one.'
const textOf = (row: SessionAppendInput) => row.message.content.flatMap(block => ('text' in block ? [block.text] : [])).join('')
const corrections = (rows: { appended: () => readonly SessionAppendInput[] }) => rows.appended().filter(row => textOf(row).includes('restated'))

test('a turn that ends restating an open item appends one short correction naming it, and leaves the system prompt alone', async ($, on) => {
  const { submitted, rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  const before = (await $.prompt.compose(FACTS)).sections.find(s => s.id === STEERING.id)
  await end($, 'answer', RETRY_TBD)
  expect(corrections(rows).length).toBe(1)
  const text = textOf(corrections(rows)[0] as SessionAppendInput)
  expect(text).toContain('#1')
  expect(text.split(/\s+/).length).toBeLessThanOrEqual(30)
  expect(text).not.toMatch(/#\d+ is done:/)
  expect(text).not.toMatch(/The human chose .+ on #\d+\./)
  expect(submitted).toEqual([])
  const after = (await $.prompt.compose(FACTS)).sections.find(s => s.id === STEERING.id)
  expect(after?.text).toBe(before?.text)
})

// The cued paragraph that names the item by its id: the pointer, not the cue, is what excuses it.
const COMPLIANT = 'Retry limit: I left it as TBD, with a note not to ship the policy until it is set. Added #1 for it.'

test('a compliant answer, one whose cued paragraph names the item by its id, appends nothing', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await end($, 'answer', COMPLIANT)
  expect(corrections(rows).length).toBe(0)
})

test('a correction the engine refuses is not recorded: the next turn restating the item is corrected', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  let refuseNext = true
  // A plugin's own rows carry the door `note`; a second session.append hook needs a matcher (the kit's mock.session has the first).
  on('session.append', { door: 'note' }, (_$, e, next) => {
    if (refuseNext && textOf(e as SessionAppendInput).includes('restated')) {
      refuseNext = false
      return { deny: 'refused by the test' }
    }
    return next(e)
  })
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await end($, 'answer', RETRY_TBD)
  expect(corrections(rows).length).toBe(0)
  await end($, 'answer', RETRY_TBD)
  expect(corrections(rows).length).toBe(1)
})

test('a subagent turn appends no correction', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await $.turn.complete({ answer: RETRY_TBD, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'sub-1' })
  expect(corrections(rows).length).toBe(0)
})

test('an interrupted turn appends no correction', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await end($, 'aborted', RETRY_TBD)
  expect(corrections(rows).length).toBe(0)
})

test('a turn ending in an error appends no correction', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await $.turn.complete({ answer: RETRY_TBD, durationMs: 1, isAborted: false, turnId: 't1', reason: 'error' })
  expect(corrections(rows).length).toBe(0)
})

test('a turn ending in a refusal appends no correction', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await $.turn.complete({ answer: RETRY_TBD, durationMs: 1, isAborted: false, turnId: 't1', reason: 'refusal', refusal: { category: null, explanation: null } })
  expect(corrections(rows).length).toBe(0)
})

test('a turn with an empty answer appends no correction', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await end($, 'answer', '')
  expect(corrections(rows).length).toBe(0)
})

test('an item is corrected once per conversation: a later turn restating it appends nothing, and one restating it with a new item names the new item alone', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await $.tool.call({ tool: TOOL, action: 'add', title: CACHE })
  await end($, 'answer', RETRY_TBD)
  expect(corrections(rows).length).toBe(1)
  await end($, 'answer', RETRY_TBD)
  expect(corrections(rows).length).toBe(1)
  await end($, 'answer', `${RETRY_TBD}\n\n${CACHE_UNDECIDED}`)
  expect(corrections(rows).length).toBe(2)
  const last = textOf(corrections(rows)[1] as SessionAppendInput)
  expect(last).toContain('#2')
  expect(last).not.toContain('#1')
})

test('a done press whose undo window ends mid-turn, then a turn end restating another open item: the correction is appended before the one submit, which carries the done notice', async ($, on) => {
  const { submitted, rows, appendedAtSubmit } = turnEngine(on)
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: CACHE })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  expect(submitted).toEqual([])
  await end($, 'answer', CACHE_UNDECIDED)
  expect(corrections(rows).length).toBe(1)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('#1 is done: Pick a db')
  expect(appendedAtSubmit).toEqual([1])
  await end($, 'answer', CACHE_UNDECIDED)
  expect(submitted.length).toBe(1)
  expect(corrections(rows).length).toBe(1)
})

test('a correction the engine refuses is logged, and the turn end still submits the done notice', async ($, on) => {
  const { submitted } = turnEngine(on, () => false, true)
  const clock = mock.clock(on)
  mock.store(on)
  const logs: string[] = []
  on('ui.log', (_$, e, next) => {
    logs.push(e.text)
    return next(e)
  })
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', blocking: true, title: CACHE })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: 'work', turnId: 't1' })
  await ui.press({ key: 'done-1' })
  await clock.advance(5000)
  await end($, 'answer', CACHE_UNDECIDED)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('#1 is done: Pick a db')
  expect(logs.some(line => line.includes('a notice was refused') && line.includes('refused by the test'))).toBe(true)
})

test('a reply typed in the pane keeps the pane on its item once sent, and the agent\'s next append brings the reply field back', async ($, on) => {
  const opened: string[] = []
  const shown = new Set<string>()
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    shown.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [...shown].map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isFocused: false, isPlaced: true }) as UiPane) }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  mock.store(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a cache' })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await band.press({ key: 'title-1' })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: { title: 'Items for you', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  await pane.input({ key: 'reply-1', text: 'Use sqlite' })
  opened.length = 0
  await clock.advance(5000)
  const sent = JSON.stringify(await pane.drawn())
  expect(sent).toContain('#1 non-blocking, done-pending: Pick a db')
  expect(sent).toContain('✓ sent')
  expect(sent).not.toContain('reply-1')
  expect(opened).toEqual(['human-items'])
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'more' })
  expect(JSON.stringify(await pane.drawn())).toContain('reply-1')
  expect(opened).toEqual(['human-items', 'human-items'])
})

test('a reply typed into the terminal pane is sent through the undo window, and the agent is told it', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: { title: 'Items for you', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  await ui.input({ key: 'reply-1', text: 'Use sqlite' })
  await clock.advance(5000)
  expect(sent).toEqual([
    '#1 is done: Pick a db\nThe human replied on #1: Use sqlite\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #1; the item is then open for their next reply. Your own follow-up work never stays on the list.',
  ])
})

// The restatement check reads the closing reply alone, and never sees the Claude list's writes. The write carries an open human item's topic
// and asks the human; only the reply decides whether the turn restated the item.
const CLAUDE_WRITE = [{ title: `Ask the human: ${RETRY}`, state: 'queued' }]

test('a turn whose Claude list write carries an open item\'s topic and whose closing reply neither carries it nor names the item raises no correction', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await $.tool.call({ tool: TODO_TOOL, entries: CLAUDE_WRITE })
  await end($, 'answer', 'The sync client is wired up and its tests pass.')
  expect(corrections(rows).length).toBe(0)
})

test('the same turn with a closing reply that restates the item\'s topic as an ask, without naming its id, raises the correction it raises with no Claude list write', async ($, on) => {
  const { rows } = turnEngine(on)
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: RETRY })
  await $.tool.call({ tool: TODO_TOOL, entries: CLAUDE_WRITE })
  const restating = `${RETRY} is undecided, please pick one.`
  await end($, 'answer', restating)
  expect(corrections(rows).length).toBe(1)
  expect(textOf(corrections(rows)[0] as SessionAppendInput)).toBe(correctionText([1]))
})

test('a band mounted at 120 columns draws the Claude column beside the human list once the agent writes the list, and drops it when the list is emptied', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  expect(JSON.stringify(await ui.drawn())).not.toContain('Claude TODO')
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }, { title: 'Test it', state: 'queued' }] })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Claude TODO 1 active, 1 queued')
  expect(drawn).toContain('◐ Build it')
  expect(drawn).toContain('"width":40')
  await $.tool.call({ tool: TODO_TOOL, entries: [] })
  expect(JSON.stringify(await ui.drawn())).not.toContain('Claude TODO')
})
