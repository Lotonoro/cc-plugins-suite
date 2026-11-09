import type { On, PromptComposeInput, SessionAppendInput, UiPane } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { STEERING } from './steering'
import { TOOL, displayColumns } from './items'
import { headerLines, rowLayout, type Control, type RowLayout, type RowTexts } from './layout'
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

test('the steering section is byte-identical with an empty Claude list, one entry with an ETA, and several entries some with no ETA', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [] }))
  const steering = async () => (await $.prompt.compose(FACTS)).sections.find(s => s.id === STEERING.id)?.text
  const empty = await steering()
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }] })
  expect(await steering()).toBe(empty)
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }, { title: 'Test it', state: 'queued' }, { title: 'Ship', state: 'queued', eta: 'no ETA' }] })
  expect(await steering()).toBe(empty)
  expect(empty).toBe(STEERING.text)
})

test('the band\'s Claude column draws each row as its glyph and title, and no ETA', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }, { title: 'Test it', state: 'queued', eta: 'after tests' }] })
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('◐ Build it')
  expect(drawn).not.toContain('ETA')
  expect(drawn).not.toContain('~10 min')
  expect(drawn).not.toContain('after tests')
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

test('a reply typed in the pane moves the pane on to the next open item once sent, and the agent\'s next append to the reply\'s item leaves the pane there, the item open and unread', async ($, on) => {
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
  const moved = JSON.stringify(await pane.drawn())
  expect(moved).toContain('#2 non-blocking, open: Pick a cache')
  expect(moved).not.toContain('Pick a db')
  expect(opened).toEqual(['human-items'])
  await $.tool.call({ tool: TOOL, action: 'append', id: 1, text: 'more' })
  const after = JSON.stringify(await pane.drawn())
  expect(after).toContain('#2 non-blocking, open: Pick a cache')
  expect(after).not.toContain('Pick a db')
  expect(String((await $.tool.call({ tool: TOOL, action: 'list' })).result)).toContain('#1 non-blocking, open: Pick a db')
  expect(JSON.stringify(await band.drawn())).toContain('• #1')
  expect(opened).toEqual(['human-items'])
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

// A drawn tree, as `drawn()` gives it, and the boxes a band lays side by side: the human list's, then the Claude column's.
type Drawn = { type: string; props?: { key?: string; width?: number; flexShrink?: number; paddingLeft?: number; paddingRight?: number; flexDirection?: string; label?: string }; children?: Drawn[] }
const boxes = (tree: unknown): { human: Drawn | undefined; column: Drawn | undefined } => {
  const [human, column] = (tree as Drawn).children ?? []
  return { human, column }
}

test('a band mounted at 96, 120 and 155 columns sets the human list\'s box and the Claude column\'s at the width rule\'s widths, the human box padded one column on its right and the Claude box one on its left; a list drawn alone has no padding', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }, { title: 'Test it', state: 'queued' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 96 } })
  for (const [columns, human, claude] of [[96, 64, 32], [120, 80, 40], [155, 104, 51]] as const) {
    await band.redraw({ ...BAND_PROPS, bodyColumns: columns })
    const tree = await band.drawn()
    expect((tree as Drawn).props?.width, `${columns}`).toBe(columns)
    const { human: left, column } = boxes(tree)
    expect(left?.props, `${columns}`).toMatchObject({ width: human, paddingRight: 1 })
    expect(left?.props?.paddingLeft, `${columns}`).toBeUndefined()
    expect(column?.props, `${columns}`).toMatchObject({ width: claude, paddingLeft: 1 })
    expect(column?.props?.paddingRight, `${columns}`).toBeUndefined()
  }
  // Under 96 columns the Claude column hides and the human list is drawn alone: no padding on any box.
  await band.redraw({ ...BAND_PROPS, bodyColumns: 90 })
  expect(JSON.stringify(await band.drawn())).not.toContain('padding')
})

test('the Claude column drawn alone, with no human items, keeps its whole box: 40 wide at 120 columns and 32 at 40, with no padding', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  for (const [columns, claude] of [[120, 40], [40, 32]] as const) {
    await band.redraw({ ...BAND_PROPS, bodyColumns: columns })
    const tree = await band.drawn()
    expect((tree as Drawn).children, `${columns}`).toHaveLength(1)
    expect((tree as Drawn).children?.[0]?.props, `${columns}`).toMatchObject({ width: claude })
    expect(JSON.stringify(tree), `${columns}`).not.toContain('padding')
  }
})

// The mod's pane as the engine keeps it: opened by the mod, listed by `ui.panes` while it is in the set, and dropped by the test as the engine would. The
// Pane drawing a test mounts says where the surface seated it.
const paneRecord = (on: On) => {
  const shown = new Set<string>()
  on('ui.open', (_$, e) => {
    shown.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [...shown].map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isFocused: false, isPlaced: true }) as UiPane) }))
  return shown
}
const PANE_PROPS = { title: 'Items for you', isFocused: true, bodyColumns: 48, placement: 'dock' as 'dock' | 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
const within = (node: Drawn | undefined, text: string): boolean => JSON.stringify(node).includes(text)

test('a band of 52 columns draws the human list 20 wide beside the Claude column 32 wide once the mod\'s pane is open and its surface has drawn it as a dock, with no other event, and drops it when the engine no longer lists the pane', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const shown = paneRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Ship' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 52 } })
  expect(JSON.stringify(await band.drawn())).not.toContain('Claude TODO')
  // The press opens the pane. Until its drawing says where it sits, the band has no dock.
  await band.press({ key: 'title-1' })
  expect(JSON.stringify(await band.drawn())).not.toContain('Claude TODO')
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: PANE_PROPS })
  const { human, column } = boxes(await band.drawn())
  expect(human?.props?.width).toBe(20)
  expect(within(human, 'Ship')).toBe(true)
  expect(within(human, 'Claude TODO')).toBe(false)
  expect(column?.props?.width).toBe(32)
  expect(within(column, 'Claude TODO 1 active, 0 queued')).toBe(true)
  // The pane seen as a dock stays one while it is open, drawn in another placement or not.
  await pane.redraw({ ...PANE_PROPS, placement: 'inline' })
  expect(within(boxes(await band.drawn()).column, 'Claude TODO')).toBe(true)
  // The engine drops the pane with no close the mod hears, and the band is drawn again at the width that gives.
  shown.clear()
  await band.redraw()
  expect(JSON.stringify(await band.drawn())).not.toContain('Claude TODO')
})

test('a close another plugin refuses leaves the pane docked: a band drawn alone while the close was in flight draws both lists again, with no other event', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const shown = paneRecord(on)
  let redraw: () => Promise<void> = async () => {}
  on('ui.close', async () => {
    // The engine's list does not show the pane while the close runs, and the band is drawn then.
    shown.delete('human-items')
    await redraw()
    shown.add('human-items')
    return { deny: 'kept open by another plugin' }
  })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 52 } })
  redraw = () => band.redraw()
  await band.press({ key: 'title-1' })
  await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: PANE_PROPS })
  expect(within(boxes(await band.drawn()).column, 'Claude TODO')).toBe(true)
  // A second press, on the item the pane shows, asks to close it.
  await band.press({ key: 'title-1' })
  expect(within(boxes(await band.drawn()).column, 'Claude TODO')).toBe(true)
})

// The band's rows as the terminal's element table gives them: nodes of `{ type, props, children }`, a Text's children its strings.
type El = { type?: string; props?: { key?: string; width?: number; flexShrink?: number; paddingLeft?: number; paddingRight?: number; flexDirection?: string; label?: string; backgroundColor?: string; wrap?: string; dimColor?: boolean; plain?: boolean }; children?: (El | string)[] }
const elementsOf = (node: El | string | undefined, type: string): El[] =>
  node === undefined || typeof node === 'string' ? [] : [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(child => elementsOf(child, type))]
// What a subtree shows: its text and its buttons' labels, in drawing order.
const shownOf = (node: El | string | undefined): string =>
  node === undefined ? '' : typeof node === 'string' ? node : node.type === 'Button' ? String(node.props?.label) : (node.children ?? []).map(shownOf).join('')
const rowElement = (tree: unknown, id: number): El | undefined => elementsOf(tree as El, 'Box').find(box => box.props?.key === `item-${id}`)
// A row is one line: its cells are its prefix, its title and its control, side by side.
const cellsOf = (row: El): El[] => (row.children ?? []).filter((cell): cell is El => typeof cell !== 'string')

const UNDO3 = '[↶ 3s]'
const control = (before: string, answer = '', after = ''): Control => ({ before, answer, after })
// A pressed control as the band says it: its mark, the answer, and its undo button after a space when there is an answer.
const said = (answer: string, mark = '✓'): Control => control(`${mark} `, answer, answer === '' ? UNDO3 : ` ${UNDO3}`)
const REPLIED = control('✓ replied ', '', UNDO3)

// An id's five kinds of row as the sweep adds them, the decision first (the pane shows the first item), then a plain to-do, a to-do labelled at the maximum
// width, a yes/no, and a plain to-do whose title holds a line break, each with a title longer than the narrowest lists.
const SWEEP_TITLE = 'Review the deliberately long wrapping title of the first plain to-do item here and then some more words so that it is cut'
const SWEEP_BROKEN = 'Ask the owner first\nthen the one who wrote the long title that is cut in a narrow list'
const SWEEP_LABEL = 'Go with sqlite for cache'
const SWEEP_OPTION = 'Use sqlite for the cache'

// A kind of row: the title it is added with, its marker after the title, its open control, the controls its press can say, the index of the one the
// sweep presses, and whether the sweep then replaces that press with a reply.
type SweepKind = { name: string; title: string; marker: string; open: Control; pressed: Control[]; answered: number; replies: boolean }
const SWEEP_KINDS: SweepKind[] = [
  { name: 'a decision', title: SWEEP_TITLE, marker: ' […]', open: control(''), pressed: [said(SWEEP_OPTION), said('Use postgres'), REPLIED], answered: 0, replies: true },
  { name: 'a plain to-do', title: SWEEP_TITLE, marker: '', open: control('[✓]'), pressed: [said(''), REPLIED], answered: 0, replies: false },
  { name: 'a labelled to-do', title: SWEEP_TITLE, marker: '', open: control('[✓ ', SWEEP_LABEL, ']'), pressed: [said(SWEEP_LABEL), REPLIED], answered: 0, replies: false },
  { name: 'a yes/no', title: SWEEP_TITLE, marker: '', open: control('[✓] [✗]'), pressed: [said('yes'), said('no', '✗'), REPLIED], answered: 0, replies: false },
  { name: 'a plain to-do with a line break in its title', title: SWEEP_BROKEN, marker: '', open: control('[✓]'), pressed: [said(''), REPLIED], answered: 0, replies: false },
]
type Phase = 'open' | 'pressed' | 'replied' | 'sent'

// The row's texts for the layout, from the kind and the digits of its id: the line break in a title is one space.
const textsOf = (kind: SweepKind, id: number): RowTexts => ({
  prefix: `  #${id} `,
  title: kind.title.replace(/\s*\n\s*/g, ' '),
  marker: kind.marker,
  open: kind.open,
  pressed: kind.pressed,
  squeezed: `✓ ${UNDO3}`,
  sent: '✓ sent',
})

// A title cut by hand at its room, ASCII: whole, or the start that leaves a column for the ellipsis, a decision's marker kept whole after it where the room
// holds both.
const labelBy = (title: string, marker: string, room: number): string => {
  if (title.length + marker.length <= room) return title + marker
  if (marker !== '' && room >= marker.length + 1) return `${title.slice(0, room - marker.length - 1)}…${marker}`
  return `${title}${marker}`.slice(0, room - 1) + '…'
}

// What the control shows after its space in a phase: the open control, a pressed one with its answer cut to the layout's answer box (the squeezed `✓ [↶ 3s]`
// where the layout squeezes), the reply, or `✓ sent`.
const controlShows = (kind: SweepKind, phase: Phase, laid: RowLayout): string => {
  if (phase === 'sent') return '✓ sent'
  if (phase === 'open') return `${kind.open.before}${laid.open.text}${kind.open.after}`
  if (laid.rung === 3) return `✓ ${UNDO3}`
  const at = phase === 'replied' && kind.replies ? kind.pressed.indexOf(REPLIED) : kind.answered
  const one = kind.pressed[at] as Control
  return `${one.before}${laid.pressed[at]?.text}${one.after}`
}

// What a row drew in its open phase, which every later phase draws again: a press, an undo and the window's end move neither the title's label nor the
// control cell's width. Keyed by the drawing (the ids and the band) and the row's id.
type Drawing = Map<string, { label: string; control: number }>

// Each row of a band drawn through the terminal's table at `layout` columns of room, as one line of three cells: the prefix, the title's button in a box that
// shrinks, and the control's cell of the layout's width at its start; and the pieces add up to the layout. `rungs` collects the rung of the ladder each row drew at.
// `squeezed`: the list is a squeezed one, whose rows start the ladder at its third rung.
const checkSweepRows = (tree: unknown, layout: number, ids: Record<string, number>, phase: Phase, drawing: string, first: Drawing, rungs: Set<number>, squeezed = false): void => {
  const where = `${phase}, ${drawing}`
  for (const button of elementsOf(tree as El, 'Button')) expect(elementsOf(button, 'Text'), `${where}: a button holding a text`).toEqual([])
  for (const kind of SWEEP_KINDS) {
    const id = ids[kind.name] as number
    const name = `${where}, ${kind.name} #${id}`
    const row = rowElement(tree, id)
    expect(row, name).toBeDefined()
    expect(row?.props?.flexDirection, name).toBeUndefined()
    const cells = cellsOf(row as El)
    expect(cells.map(cell => cell.type), name).toEqual(['Box', 'Box', 'Box'])
    const [prefix, titleCell, controlCell] = cells as [El, El, El]
    const prefixColumns = displayColumns(shownOf(prefix))
    expect(prefix.props, name).toMatchObject({ flexShrink: 0 })
    expect(prefixColumns, name).toBe(String(id).length + 4)
    const texts = textsOf(kind, id)
    const laid = rowLayout(texts, layout, squeezed)
    rungs.add(laid.rung)
    // The title: its button in a box that shrinks, the button's label the one-line title cut to the room the prefix and the control cell leave it.
    expect(titleCell.props, name).toMatchObject({ flexShrink: 1 })
    expect((titleCell.children ?? []).map(child => (typeof child === 'string' ? child : child.type)), name).toEqual(['Button'])
    const label = shownOf(titleCell)
    expect(elementsOf(titleCell, 'Button')[0]?.props?.key, name).toBe(`title-${id}`)
    expect(label, name).toBe(laid.title)
    expect(label, name).toBe(labelBy(texts.title, texts.marker, laid.room))
    expect(displayColumns(label), name).toBeLessThanOrEqual(laid.room)
    // The control cell: the layout's width, never shrunk; the pieces add up to the list's layout width.
    expect(controlCell.props, name).toMatchObject({ flexShrink: 0, width: laid.control })
    expect(prefixColumns + laid.room + Number(controlCell.props?.width), name).toBe(layout)
    if (phase === 'open') first.set(`${drawing}, #${id}`, { label, control: laid.control })
    else expect(first.get(`${drawing}, #${id}`), name).toEqual({ label, control: laid.control })
    // The state's control after one space at the cell's start; a decision still open draws none.
    const want = controlShows(kind, phase, laid)
    const kids = controlCell.children ?? []
    if (want === '') {
      expect(kids, name).toEqual([])
    } else {
      expect(shownOf(kids[0]), name).toBe(' ')
      expect(shownOf(controlCell), name).toBe(` ${want}`)
      expect(displayColumns(shownOf(controlCell)), name).toBeLessThanOrEqual(laid.control)
    }
    // An open labelled to-do is one button, its label `[✓ `, the cut label and `]`.
    if (phase === 'open' && kind.open.answer !== '') {
      const buttons = elementsOf(controlCell, 'Button')
      expect(buttons.map(button => button.props?.label), name).toEqual([`${kind.open.before}${laid.open.text}${kind.open.after}`])
    }
    // A pressed answer sits in a box of the layout's answer width holding the cut answer; the squeezed control, a reply and `✓ sent` have none.
    const at = phase === 'replied' && kind.replies ? kind.pressed.indexOf(REPLIED) : kind.answered
    const answered = phase === 'pressed' || phase === 'replied' ? (kind.pressed[at] as Control).answer !== '' && laid.rung !== 3 : false
    const answerBoxes = elementsOf(controlCell, 'Box').filter(box => box !== controlCell && box.props?.width !== undefined)
    if (answered) {
      expect(answerBoxes.length, name).toBe(1)
      expect(answerBoxes[0]?.props, name).toMatchObject({ width: laid.pressed[at]?.box, flexShrink: 0 })
      expect(shownOf(answerBoxes[0]), name).toBe(laid.pressed[at]?.text)
    } else {
      expect(answerBoxes, name).toEqual([])
    }
  }
}

// Ids up to `to` taken by items that are then removed, so the next add gets id `to`.
const skipIds = async ($: Engine, from: number, to: number): Promise<void> => {
  for (let id = from; id < to; id++) await $.tool.call({ tool: TOOL, action: 'add', title: 'skipped' })
  for (let id = from; id < to; id++) await $.tool.call({ tool: TOOL, action: 'remove', id })
}

test('the band drawn through the terminal\'s table, with every kind of control at an id of one to three digits, open, pressed, replied and sent, draws each row as one line of its prefix, its title cut to its room and a control cell of one width in every state, in lists of 20 to 155 columns', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }, { title: 'Test it', state: 'queued' }] })
  const tall = { ...BAND_PROPS, maxRows: 400, scroll: { offset: 0, bodyRows: 400 } }
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: tall })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: { title: 'Items for you', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  const widths = [20, 21, 22, 23, 24, 31, 40, 52, 56, 63, 64, 70, 95, 96, 97, 105, 120, 155]
  const firstDrawn: Drawing = new Map()
  const rungs = new Set<number>()
  let next = 1
  for (const first of [1, 10, 100]) {
    await skipIds($, next, first)
    const ids = Object.fromEntries(SWEEP_KINDS.map((kind, k) => [kind.name, first + k]))
    const [decision, plain, labelled, yesno, broken] = SWEEP_KINDS.map(kind => ids[kind.name] as number) as [number, number, number, number, number]
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, options: [{ label: SWEEP_OPTION, recommended: true }, { label: 'Use postgres' }] })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, done: SWEEP_LABEL })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, yesno: true })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_BROKEN })
    next = first + SWEEP_KINDS.length
    const check = async (phase: Phase): Promise<void> => {
      for (const columns of widths) {
        await band.redraw({ ...tall, bodyColumns: columns })
        const tree = await band.drawn()
        const drawing = `ids from ${first}, band of ${columns}`
        const where = `${phase}, ${drawing}`
        // Two lists from 96 columns, each box at the width rule's, the human one padded on its right and the Claude one on its left; below that the human
        // list alone, with no width and no padding of its own.
        const column = Math.max(32, Math.floor(columns / 3))
        const twoLists = columns >= 96
        if (twoLists) {
          const { human, column: claude } = boxes(tree)
          expect((tree as Drawn).props?.width, where).toBe(columns)
          expect(human?.props, where).toMatchObject({ width: columns - column, paddingRight: 1 })
          expect(claude?.props, where).toMatchObject({ width: column, paddingLeft: 1 })
        } else {
          expect((tree as Drawn).props?.width, where).toBeUndefined()
          expect((tree as Drawn).props?.paddingRight, where).toBeUndefined()
        }
        checkSweepRows(tree, twoLists ? columns - column - 1 : columns, ids, phase, drawing, firstDrawn, rungs)
      }
    }
    await check('open')
    // The three band controls pressed, and the decision's option pressed in the pane: each says its answer beside its undo button.
    await band.press({ key: `done-${plain}` })
    await band.press({ key: `done-${labelled}` })
    await band.press({ key: `yes-${yesno}` })
    await band.press({ key: `done-${broken}` })
    await pane.press({ key: `answer-${decision}-0` })
    await check('pressed')
    // The decision's press undone and replaced by a reply typed in the pane, which a pressed control names as `✓ replied`.
    await band.press({ key: `done-${decision}` })
    await pane.input({ key: `reply-${decision}`, text: 'Not yet' })
    await check('replied')
    // The windows end: every press is sent.
    await clock.advance(3000)
    await check('sent')
    for (let id = first; id < next; id++) await $.tool.call({ tool: TOOL, action: 'remove', id })
  }
  // The lists run from rows that keep every control whole to rows squeezed to the mark and the undo button.
  expect([...rungs].sort()).toEqual([1, 2, 3])
})

test('the summary row drawn through the terminal\'s table is one line cut at the list\'s layout width with an ellipsis, in its warning box, with the count of what the rows left folded', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  for (let k = 1; k <= 8; k++) await $.tool.call({ tool: TOOL, action: 'add', title: `Blocking ask ${k}`, blocking: true })
  for (let k = 1; k <= 3; k++) await $.tool.call({ tool: TOOL, action: 'add', title: `Other ask ${k}` })
  const props = { ...BAND_PROPS, maxRows: 6 }
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props })
  for (const columns of [20, 22, 23, 24, 25, 26, 30, 40, 80, 120]) {
    await band.redraw({ ...props, bodyColumns: columns })
    const tree = await band.drawn()
    const where = `band of ${columns}`
    // The header takes the lines its count wraps to beside the chip, the summary one: the rest of the 6 rows are items, the blocking ones first.
    const shown = elementsOf(tree as El, 'Box').filter(box => String(box.props?.key).startsWith('item-')).length
    expect(shown, where).toBe(6 - headerLines(' To do for you ', ' 11 open ', columns) - 1)
    expect(shown, where).toBeGreaterThanOrEqual(3)
    const more = elementsOf(tree as El, 'Button').find(button => button.props?.key === 'band-more')
    const summary = `+${8 - shown} blocking · +3 more […]`
    const label = more?.props?.label
    expect(label, where).toBe(summary.length <= columns ? summary : `${summary.slice(0, columns - 1)}…`)
    expect(displayColumns(String(label)), where).toBeLessThanOrEqual(columns)
    const holder = elementsOf(tree as El, 'Box').find(box => (box.children ?? []).some(child => typeof child !== 'string' && child.props?.key === 'band-more'))
    expect(holder?.props?.backgroundColor, where).toBe('warning')
    expect(elementsOf(more, 'Text'), where).toEqual([])
  }
})

test('a band mounted at 105 columns draws each row as one line in the 69 columns its list of 70 keeps: the prefix, a title cut to the room the control column leaves it, and the control cell, and a press moves neither', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TOOL, action: 'add', term: 'Mr Longest Term Ever', title: 'Review the deliberately long wrapping title of the first plain to-do item here' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Second to-do with a labelled control and a wrapping title too', done: 'Approve the migration ok' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Is the third item a yes or no question that wraps', yesno: true })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a decision with options that wraps as well', options: [{ label: 'Alpha', recommended: true }, { label: 'Beta' }] })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Writing the probe step', state: 'in_flight' }, { title: 'Second step in flight', state: 'in_flight' }, { title: 'Queued one', state: 'queued' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 105 } })
  const cells = async (id: number): Promise<El[]> => cellsOf(rowElement(await band.drawn(), id) as El)
  const tree = await band.drawn()
  expect(boxes(tree).human?.props).toMatchObject({ width: 70, paddingRight: 1 })
  expect(boxes(tree).column?.props).toMatchObject({ width: 35, paddingLeft: 1 })
  // The unread mark and the id take 5. #1, #3 and #4 have a control column of 17 (the reply's `✓ replied [↶ 3s]` and the space before it), leaving their
  // titles 47 of the 69. #2's label of 24 columns makes its pressed control `✓ Approve the migration ok [↶ 3s]`, so 34 with the space, leaving its title 30.
  const want: [number, number, string][] = [
    [1, 17, 'Review the deliberately long wrapping title of…'],
    [2, 34, 'Second to-do with a labelled …'],
    [3, 17, 'Is the third item a yes or no question that wr…'],
    [4, 17, 'Pick a decision with options that wraps as… […]'],
  ]
  for (const [id, controlColumn, label] of want) {
    const [prefix, title, controlCell] = (await cells(id)) as [El, El, El]
    expect(displayColumns(shownOf(prefix)), `#${id}`).toBe(5)
    expect(controlCell.props?.width, `#${id}`).toBe(controlColumn)
    expect(shownOf(title), `#${id}`).toBe(label)
    expect(5 + displayColumns(label) + controlColumn, `#${id}`).toBe(69)
  }
  expect(shownOf((await cells(2))[2])).toBe(' [✓ Approve the migration ok]')
  // Pressed, #2's control names its label beside the undo button; its title and its control cell are as they were.
  await band.press({ key: 'done-2' })
  const pressed = (await cells(2)) as [El, El, El]
  expect(shownOf(pressed[1])).toBe('Second to-do with a labelled …')
  expect(pressed[2].props?.width).toBe(34)
  expect(shownOf(pressed[2])).toBe(' ✓ Approve the migration ok [↶ 3s]')
})

test('beside the docked pane the band drawn through the terminal\'s table in bands of 52 to 95 columns squeezes the human list: every kind of control at an id of one to three digits, open, pressed, replied and sent, draws each row as one line of its prefix, its title cut to its room and a control cell of one width in every state, every pressed control its mark and undo button, under a header of two lines; at 96 the same rows are not squeezed', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  mock.store(on)
  paneRecord(on)
  // An item that stays open, so the pane has an item to move on to as the sweep's windows end and its items are removed, and so stays open in the dock.
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Anchor' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }, { title: 'Test it', state: 'queued' }] })
  const tall = { ...BAND_PROPS, maxRows: 400, scroll: { offset: 0, bodyRows: 400 } }
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...tall, bodyColumns: 52 } })
  // The press opens the pane, and the pane's drawing as a dock is what lets the band draw both lists at 52.
  await band.press({ key: 'title-1' })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: PANE_PROPS })
  const widths = [52, 53, 56, 63, 64, 70, 95, 96]
  const firstDrawn: Drawing = new Map()
  const squeezedRungs = new Set<number>()
  const otherRungs = new Set<number>()
  let next = 2
  for (const first of [2, 10, 100]) {
    await skipIds($, next, first)
    const ids = Object.fromEntries(SWEEP_KINDS.map((kind, k) => [kind.name, first + k]))
    const [decision, plain, labelled, yesno, broken] = SWEEP_KINDS.map(kind => ids[kind.name] as number) as [number, number, number, number, number]
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, options: [{ label: SWEEP_OPTION, recommended: true }, { label: 'Use postgres' }] })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, done: SWEEP_LABEL })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, yesno: true })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_BROKEN })
    next = first + SWEEP_KINDS.length
    const check = async (phase: Phase): Promise<void> => {
      for (const columns of widths) {
        await band.redraw({ ...tall, bodyColumns: columns })
        const tree = await band.drawn()
        const drawing = `ids from ${first}, band of ${columns}`
        const where = `${phase}, ${drawing}`
        // Both lists at every width here, the pane being docked: each box at the width rule's, the human one padded on its right and the Claude one on its left.
        const column = Math.max(32, Math.floor(columns / 3))
        const { human, column: claude } = boxes(tree)
        expect((tree as Drawn).props?.width, where).toBe(columns)
        expect(human?.props, where).toMatchObject({ width: columns - column, paddingRight: 1 })
        expect(claude?.props, where).toMatchObject({ width: column, paddingLeft: 1 })
        // Under 96 the human list is squeezed, and its header is the chip on one line and the count under it, each set to cut at its end.
        const squeezed = columns < 96
        const header = human?.children?.[0]
        if (squeezed) {
          expect(header?.props?.flexDirection, where).toBe('column')
          expect(header?.children, where).toHaveLength(2)
          expect(shownOf(header?.children?.[0]), where).toBe(' To do for you ')
          expect(shownOf(header?.children?.[1]), where).toMatch(/^ \d+ open/)
          for (const line of header?.children ?? []) expect(JSON.stringify(line), where).toContain('"wrap":"truncate-end"')
        } else {
          expect(header?.props?.flexDirection, where).toBeUndefined()
          expect(JSON.stringify(header), where).not.toContain('"wrap"')
        }
        checkSweepRows(tree, columns - column - 1, ids, phase, drawing, firstDrawn, squeezed ? squeezedRungs : otherRungs, squeezed)
      }
    }
    await check('open')
    // Pressed, the decision's option in the pane (the band's title opens the decision there first), and replied, as the sweep above does.
    await band.press({ key: `title-${decision}` })
    await band.press({ key: `done-${plain}` })
    await band.press({ key: `done-${labelled}` })
    await band.press({ key: `yes-${yesno}` })
    await band.press({ key: `done-${broken}` })
    await pane.press({ key: `answer-${decision}-0` })
    await check('pressed')
    await band.press({ key: `done-${decision}` })
    await pane.input({ key: `reply-${decision}`, text: 'Not yet' })
    await check('replied')
    await clock.advance(3000)
    await check('sent')
    for (let id = first; id < next; id++) await $.tool.call({ tool: TOOL, action: 'remove', id })
  }
  // Every row of a band under 96 is at the ladder's third rung, and the rows at 96 are not.
  expect([...squeezedRungs]).toEqual([3])
  expect(otherRungs.has(3)).toBe(false)
})

test('beside the docked pane a band the engine gives 3, 2 or 1 rows draws its header as two lines and the summary row, as the chip alone and the summary row on its warning fill, or as the chip alone', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  paneRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Ship the cache layer for everyone', blocking: true })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }] })
  const props = { ...BAND_PROPS, bodyColumns: 52 }
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props })
  await band.press({ key: 'title-1' })
  await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: PANE_PROPS })
  for (const [maxRows, lines, hasSummary] of [[3, 2, true], [2, 1, true], [1, 1, false]] as const) {
    await band.redraw({ ...props, maxRows })
    const tree = await band.drawn()
    const where = `maxRows ${maxRows}`
    const { human } = boxes(tree)
    expect(human?.props?.width, where).toBe(20)
    expect(human?.children?.[0]?.children, where).toHaveLength(lines)
    expect(human?.children?.length, where).toBe(hasSummary ? 2 : 1)
    expect(elementsOf(tree as El, 'Button').filter(button => String(button.props?.key).startsWith('title-')), where).toEqual([])
    const more = elementsOf(tree as El, 'Button').find(button => button.props?.key === 'band-more')
    expect(more?.props?.label, where).toBe(hasSummary ? '+1 blocking · +1 m…' : undefined)
    const holder = elementsOf(tree as El, 'Box').find(box => (box.children ?? []).some(child => typeof child !== 'string' && child.props?.key === 'band-more'))
    expect(holder?.props?.backgroundColor, where).toBe(hasSummary ? 'warning' : undefined)
  }
})

// The mod's pane as the engine keeps it, with every open request the mod makes kept whole and every close: the Claude list's view is the one pane id again, with another
// title and rows.
type Asked = { id: string; title?: string; rows?: number; focus?: true }
const backlogRecord = (on: On) => {
  const shown = new Set<string>()
  const opens: Asked[] = []
  const closes: string[] = []
  on('ui.open', (_$, e) => {
    opens.push({ id: e.id, title: e.title, rows: e.rows, focus: e.focus })
    shown.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    closes.push(e.id)
    shown.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...shown].map(id => ({ id, title: id, isShown: true, hasKeyboard: false, isFocused: false, isPlaced: true }) as UiPane) }))
  return { shown, opens, closes }
}
const CLAUDE_PANE = { ...PANE_PROPS, title: 'Claude TODO', bodyColumns: 48 }
// A backlog item's row as the Pane draws it, part by part: whether the part shrinks, and its texts with their wrap and dim. The head gives way and is set to cut at its end; the ETA tail is dim and does not shrink.
const partsOf = (row: El): unknown[] => (row.children as El[]).map(part => [part.props?.flexShrink, elementsOf(part, 'Text').map(text => [shownOf(text), text.props?.wrap, text.props?.dimColor])])
const backlogRow = (head: string, tail: string): unknown[] => [[1, [[head, 'truncate-end', undefined]]], [0, [[tail, undefined, true]]]]

test('a press on the band\'s Claude header, a Claude row and +N queued each opens the pane on the Claude list, titled Claude TODO, with a row for the header and one for each item, and the keyboard; the Pane drawn through the terminal\'s table is a header line and a row for each item, a head set to cut at its end and its dim ETA tail, and no control', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { shown, opens } = backlogRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a cache' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }, ...[1, 2, 3, 4, 5].map(k => ({ title: `Queued ${k}`, state: 'queued' }))] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  for (const key of ['claude-header', 'claude-row-0', 'claude-queued']) {
    await band.press({ key })
    expect(opens, key).toEqual([{ id: 'human-items', title: 'Claude TODO', rows: 7, focus: true }])
    // The engine drops the pane with no close the mod hears, and the band is drawn again: the next press opens it afresh.
    shown.clear()
    opens.length = 0
    await band.redraw()
  }
  await band.press({ key: 'claude-header' })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: CLAUDE_PANE })
  const tree = (await pane.drawn()) as El
  const [header, ...rows] = (tree.children ?? []) as El[]
  expect([shownOf(header), header?.props?.wrap]).toEqual(['Claude TODO 1 in flight, 5 queued', 'truncate-end'])
  expect(rows.map(partsOf)).toEqual([backlogRow('◐ Build it', ' · ~10 min'), ...[1, 2, 3, 4, 5].map(k => backlogRow(`○ Queued ${k}`, ' · no ETA'))])
  expect(elementsOf(tree, 'Button')).toEqual([])
  expect(elementsOf(tree, 'Input')).toEqual([])
})

test('the Pane cuts a backlog row\'s ETA tail to the body it is given and leaves a long ETA whole in a wide body', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  backlogRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Long title '.repeat(7), state: 'in_flight', eta: '漢'.repeat(30) }, { title: 'Long title '.repeat(7), state: 'queued', eta: '~10 min' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  await band.press({ key: 'claude-header' })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: CLAUDE_PANE })
  const tails = async (): Promise<string[][]> => (((await pane.drawn()) as El).children as El[]).slice(1).map(row => elementsOf(row, 'Text').filter(text => text.props?.dimColor === true).map(text => shownOf(text)))
  expect(await tails()).toEqual([[` · ${'漢'.repeat(16)}…`], [' · ~10 min']])
  await pane.redraw({ ...CLAUDE_PANE, bodyColumns: 97 })
  expect(await tails()).toEqual([[` · ${'漢'.repeat(30)}`], [' · ~10 min']])
  await pane.redraw({ ...CLAUDE_PANE, bodyColumns: 14 })
  expect(await tails()).toEqual([[], []])
})

test('with the pane open on the Claude list the Pane draws each ETA and the band\'s Claude column still draws each row as its glyph and title, and no ETA', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  backlogRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }, { title: 'Test it', state: 'queued', eta: 'after tests' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  await band.press({ key: 'claude-header' })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: CLAUDE_PANE })
  const inPane = JSON.stringify(await pane.drawn())
  expect(inPane).toContain('~10 min')
  expect(inPane).toContain('after tests')
  await band.redraw()
  const column = JSON.stringify(boxes(await band.drawn()).column)
  expect(column).toContain('◐ Build it')
  for (const eta of ['ETA', '~10 min', 'after tests']) expect(column, eta).not.toContain(eta)
})

test('the band\'s Claude column is a button for its header and one for each row, addressed by its place in the column, so two rows with one title are two buttons; a long title is cut with an ellipsis within the column, and +N queued is dim', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  backlogRecord(on)
  // Four human items: the column's header and three in-flight rows leave it one line for its queued rows, which are two, so `+2 queued` draws.
  for (const title of ['Pick a db', 'Pick a cache', 'Pick a queue', 'Pick a host']) await $.tool.call({ tool: TOOL, action: 'add', title })
  const long = 'x'.repeat(60)
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Same title', state: 'in_flight' }, { title: 'Same title', state: 'in_flight' }, { title: long, state: 'in_flight' }, { title: 'Later', state: 'queued' }, { title: 'Latest', state: 'queued' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 96 } })
  const buttons = elementsOf((await band.drawn()) as El, 'Button').filter(button => String(button.props?.key).startsWith('claude-'))
  expect(buttons.map(button => button.props?.key)).toEqual(['claude-header', 'claude-row-0', 'claude-row-1', 'claude-row-2', 'claude-queued'])
  // The column is 32 wide with one column kept empty: 31 columns of text.
  expect(buttons.map(button => button.props?.label)).toEqual(['Claude TODO 3 active, 2 queued', '◐ Same title', '◐ Same title', `◐ ${'x'.repeat(28)}…`, '+2 queued'])
  expect(buttons.map(button => button.props?.dimColor)).toEqual([undefined, undefined, undefined, undefined, true])
  expect((await band.find({ key: 'claude-row-1' }))?.text).toBe('◐ Same title')
})

test('one pane serves the human item and the Claude list: a press on the Claude column while the pane shows an item, and a press on a human title while it shows the list, each switch it in place, and the engine lists one pane', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { shown, opens, closes } = backlogRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a cache' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Same title', state: 'in_flight' }, { title: 'Same title', state: 'in_flight' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  await band.press({ key: 'title-1' })
  await band.press({ key: 'claude-row-1' })
  await band.press({ key: 'title-2' })
  await band.press({ key: 'claude-header' })
  expect(opens.map(o => o.title)).toEqual(['Items for you', 'Claude TODO', 'Items for you', 'Claude TODO'])
  expect(opens.map(o => o.id)).toEqual(['human-items', 'human-items', 'human-items', 'human-items'])
  expect([...shown]).toEqual(['human-items'])
  expect(closes).toEqual([])
  // A press on the Claude column while the pane shows the Claude list closes it.
  await band.press({ key: 'claude-row-0' })
  expect(closes).toEqual(['human-items'])
  expect([...shown]).toEqual([])
})

test('with the pane on the Claude list, a write that adds items asks again for the rows and the Pane drawn follows it, one that keeps the number of items asks nothing, and one that empties the list closes the pane', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const { shown, opens, closes } = backlogRecord(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }, { title: 'Test it', state: 'queued' }] })
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND_PROPS, bodyColumns: 120 } })
  await band.press({ key: 'claude-header' })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: CLAUDE_PANE })
  // Each line is the text of a child of the pane's root: the header, or an item's head and its tail.
  const lines = async (): Promise<string[]> => (((await pane.drawn()) as El).children ?? []).map(line => shownOf(line))
  expect(opens.map(o => o.rows)).toEqual([3])
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }, { title: 'Test it', state: 'queued' }, { title: 'Ship it', state: 'queued' }, { title: 'Tell them', state: 'queued' }] })
  expect(opens.map(o => o.rows)).toEqual([3, 5])
  expect(await lines()).toEqual(['Claude TODO 1 in flight, 3 queued', '◐ Build it · ~10 min', '○ Test it · no ETA', '○ Ship it · no ETA', '○ Tell them · no ETA'])
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }, { title: 'Test it', state: 'in_flight', eta: 'after tests' }, { title: 'Ship it', state: 'queued' }, { title: 'Tell them', state: 'queued' }] })
  expect(opens).toHaveLength(2)
  expect(await lines()).toEqual(['Claude TODO 2 in flight, 2 queued', '◐ Build it · ~10 min', '◐ Test it · after tests', '○ Ship it · no ETA', '○ Tell them · no ETA'])
  await $.tool.call({ tool: TODO_TOOL, entries: [] })
  expect(closes).toEqual(['human-items'])
  expect([...shown]).toEqual([])
})
