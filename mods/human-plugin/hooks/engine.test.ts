import type { On, PromptComposeInput, SessionAppendInput, UiPane } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { STEERING } from './steering'
import { TOOL, displayColumns } from './items'
import { wrapText } from './layout'
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

// The band's rows as the terminal's element table gives them: nodes of `{ type, props, children }`, a Text's children its strings.
type El = { type?: string; props?: { key?: string; width?: number; flexShrink?: number; paddingLeft?: number; paddingRight?: number; flexDirection?: string; label?: string }; children?: (El | string)[] }
const elementsOf = (node: El | string | undefined, type: string): El[] =>
  node === undefined || typeof node === 'string' ? [] : [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(child => elementsOf(child, type))]
// What a subtree shows: its text and its buttons' labels, in drawing order.
const shownOf = (node: El | string | undefined): string =>
  node === undefined ? '' : typeof node === 'string' ? node : node.type === 'Button' ? String(node.props?.label) : (node.children ?? []).map(shownOf).join('')
const rowElement = (tree: unknown, id: number): El | undefined => elementsOf(tree as El, 'Box').find(box => box.props?.key === `item-${id}`)
// A row's cells: its title's line (the row itself, or its first cell when the control sits under the title) and, under the title, the control's cell.
const cellsOf = (row: El): { line: (El | string)[]; under: El | undefined } =>
  row.props?.flexDirection === 'column' ? { line: (row.children?.[0] as El).children ?? [], under: row.children?.[1] as El } : { line: row.children ?? [], under: undefined }

// A row the sweep checks: its id, its title as drawn, its open control, and the control as it reads in the state the row is in (none for a decision still
// open, which draws no control in the band).
type SweepRow = { id: number; title: string; open: string; control: string }

// Each row of a band drawn through the terminal's table at `layout` columns of room: the title whole and set in a box of the room it wraps in when it
// wraps there or is wider than it (the button itself otherwise), the control whole on the line the open control's room gives it (beside the title while the
// title keeps ten columns there, and under it otherwise; a state whose own control would leave the title no column goes under it), a pressed control's words
// under the title in the box the undo button leaves them, and the row's pieces within the list.
const checkSweepRows = (tree: unknown, layout: number, rows: SweepRow[], where: string): void => {
  for (const { id, title, open, control } of rows) {
    const name = `${where}, #${id}`
    const row = rowElement(tree, id)
    expect(row, name).toBeDefined()
    const { line, under } = cellsOf(row as El)
    const [prefix, titleCell, ...rest] = line
    const prefixColumns = displayColumns(shownOf(prefix))
    expect(prefixColumns, name).toBe(String(id).length + 4)
    const room = (text: string): number => layout - prefixColumns - (text === '' ? 0 : 1 + displayColumns(text))
    // The title is whole.
    expect(shownOf(titleCell), name).toBe(title)
    if (control === '') {
      expect(rest, name).toEqual([])
      expect(under, name).toBeUndefined()
    } else {
      const wantBeside = room(open) >= 10 && room(control) >= 1
      expect(under === undefined, name).toBe(wantBeside)
      // The control is whole: after its space at the end of the title's line, or alone under the title, indented to the title's start.
      if (wantBeside) expect(shownOf(rest[0]), name).toBe(` ${control}`)
      else {
        expect(rest, name).toEqual([])
        expect(under?.props?.paddingLeft, name).toBe(prefixColumns)
        expect(shownOf(under), name).toBe(control)
        const words = control.replace(/\[↶ \d+s\]$/, '')
        if (words !== control) {
          // A pressed control's words wrap beside the undo button in a box of the room it leaves them, and are bare when they fit.
          const wide = layout - prefixColumns - displayColumns('[↶ 3s]')
          const wrapped = wrapText(words, wide).length > 1
          const wordsCell = ((under?.children?.[0] as El).children?.[0] ?? undefined) as El | undefined
          if (wrapped) expect(wordsCell?.props, name).toMatchObject({ width: wide, flexShrink: 0 })
          else expect(wordsCell?.type, name).toBe('Text')
        }
      }
    }
    // The title wraps in the room beside its control, or in the line under it or with none: a box of that room when it wraps there or is wider than it.
    const beside = control !== '' && under === undefined
    const titleRoom = beside ? room(control) : layout - prefixColumns
    const [first = '', ...more] = wrapText(title, titleRoom)
    if (more.length > 0 || displayColumns(first) > titleRoom) expect(titleCell, name).toMatchObject({ type: 'Box', props: { width: titleRoom, flexShrink: 0 } })
    else expect(titleCell, name).toMatchObject({ type: 'Button' })
  }
}

// An id's four kinds of row as the sweep adds them, the decision first (the pane shows the first item), then a plain to-do, a to-do labelled at the maximum
// width and a yes/no, each with a title that wraps in any list.
const SWEEP_TITLE = 'Review the deliberately long wrapping title of the first plain to-do item here and then some more words so that it wraps'
const SWEEP_LABEL = 'Go with sqlite for cache'
const SWEEP_OPTION = 'Use sqlite for the cache'

// Ids up to `to` taken by items that are then removed, so the next add gets id `to`.
const skipIds = async ($: Engine, from: number, to: number): Promise<void> => {
  for (let id = from; id < to; id++) await $.tool.call({ tool: TOOL, action: 'add', title: 'skipped' })
  for (let id = from; id < to; id++) await $.tool.call({ tool: TOOL, action: 'remove', id })
}

test('the band drawn through the terminal\'s table, with every kind of control at an id of one to three digits, open, pressed, replied and sent, sets each box at the width the width rule gives and each row as the layout places it, in lists of 20 to 155 columns', async ($, on) => {
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight' }, { title: 'Test it', state: 'queued' }] })
  const tall = { ...BAND_PROPS, maxRows: 400, scroll: { offset: 0, bodyRows: 400 } }
  const band = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: tall })
  const pane = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'Pane', requestId: 'human-items', props: { title: 'Items for you', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  const widths = [20, 21, 22, 23, 24, 31, 40, 52, 56, 63, 64, 70, 95, 96, 97, 105, 120, 155]
  let next = 1
  for (const first of [1, 10, 100]) {
    await skipIds($, next, first)
    const [decision, plain, labelled, yesno] = [first, first + 1, first + 2, first + 3] as const
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, options: [{ label: SWEEP_OPTION, recommended: true }, { label: 'Use postgres' }] })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, done: SWEEP_LABEL })
    await $.tool.call({ tool: TOOL, action: 'add', title: SWEEP_TITLE, yesno: true })
    next = first + 4
    const rows = (controls: [string, string, string, string]): SweepRow[] =>
      [
        { id: decision, title: `${SWEEP_TITLE} […]`, open: '', control: controls[0] },
        { id: plain, title: SWEEP_TITLE, open: '[✓]', control: controls[1] },
        { id: labelled, title: SWEEP_TITLE, open: `[✓ ${SWEEP_LABEL}]`, control: controls[2] },
        { id: yesno, title: SWEEP_TITLE, open: '[✓] [✗]', control: controls[3] },
      ]
    const check = async (phase: string, controls: [string, string, string, string]): Promise<void> => {
      for (const columns of widths) {
        await band.redraw({ ...tall, bodyColumns: columns })
        const tree = await band.drawn()
        const where = `${phase}, ids from ${first}, band of ${columns}`
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
        checkSweepRows(tree, twoLists ? columns - column - 1 : columns, rows(controls), where)
      }
    }
    const UNDO3 = '[↶ 3s]'
    await check('open', ['', '[✓]', `[✓ ${SWEEP_LABEL}]`, '[✓] [✗]'])
    // The three band controls pressed, and the decision's option pressed in the pane: each says its answer in full beside its undo button.
    await band.press({ key: `done-${plain}` })
    await band.press({ key: `done-${labelled}` })
    await band.press({ key: `yes-${yesno}` })
    await pane.press({ key: `answer-${decision}-0` })
    await check('pressed', [`✓ ${SWEEP_OPTION} ${UNDO3}`, `✓ ${UNDO3}`, `✓ ${SWEEP_LABEL} ${UNDO3}`, `✓ yes ${UNDO3}`])
    // The decision's press undone and replaced by a reply typed in the pane, which a pressed control names as `✓ replied`.
    await band.press({ key: `done-${decision}` })
    await pane.input({ key: `reply-${decision}`, text: 'Not yet' })
    await check('replied', [`✓ replied ${UNDO3}`, `✓ ${UNDO3}`, `✓ ${SWEEP_LABEL} ${UNDO3}`, `✓ yes ${UNDO3}`])
    // The windows end: every press is sent.
    await clock.advance(3000)
    await check('sent', ['✓ sent', '✓ sent', '✓ sent', '✓ sent'])
    for (let id = first; id < next; id++) await $.tool.call({ tool: TOOL, action: 'remove', id })
  }
})

test('a band mounted at 105 columns lays its rows out in the 69 columns its list of 70 keeps: a title that wraps beside its control is a box of the room the id and the control leave, and a press narrows it', async ($, on) => {
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
  const titleBox = async (id: number): Promise<El | string | undefined> => cellsOf(rowElement(await band.drawn(), id) as El).line[1]
  const tree = await band.drawn()
  expect(boxes(tree).human?.props).toMatchObject({ width: 70, paddingRight: 1 })
  expect(boxes(tree).column?.props).toMatchObject({ width: 35, paddingLeft: 1 })
  // #1: the unread mark and the id take 5 and `[✓]` with its space 4, leaving the title 60 of the 69. #2: `[✓ Approve the migration ok]` and its space take 29,
  // leaving 35. #3 and #4 fit their lines: the buttons themselves.
  expect(await titleBox(1)).toMatchObject({ type: 'Box', props: { width: 60, flexShrink: 0 } })
  expect(await titleBox(2)).toMatchObject({ type: 'Box', props: { width: 35, flexShrink: 0 } })
  expect(await titleBox(3)).toMatchObject({ type: 'Button', props: { key: 'title-3' } })
  expect(await titleBox(4)).toMatchObject({ type: 'Button', props: { key: 'title-4' } })
  // Pressed, #2's control names its label beside the undo button (`✓ Approve the migration ok [↶ 3s]` and its space take 34), leaving its title 30.
  await band.press({ key: 'done-2' })
  expect(await titleBox(2)).toMatchObject({ type: 'Box', props: { width: 30, flexShrink: 0 } })
  expect(shownOf(rowElement(await band.drawn(), 2))).toContain('✓ Approve the migration ok [↶ 3s]')
})
