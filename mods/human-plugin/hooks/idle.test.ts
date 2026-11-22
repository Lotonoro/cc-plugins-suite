import type { On } from 'claude-code'
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'
import { readAgents } from './agents'
import { TOOL } from './items'

// The idle rule through the test engine, with the plugin loaded: a main-agent Stop, and the world beneath it. The base case is two open non-blocking items, and a
// Stop that is not a re-prompt, has no task and no wake-up in flight, follows no message to an agent and finds no agent working. Each test changes one thing.
// Items are filed and changed through the tool and read back through the list, never built as whole values.

const RAN = { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PUSH = { tool: 'PushNotification' } as const
const ASK = { tool: 'AskUserQuestion' } as const
const DO = { command: 'do', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const
const MAIN = '/projects/p/s1.jsonl'
// The prefix of the rule's own debug lines.
const RULE = 'human-plugin: idle rule:'
const STOP = { stop_hook_active: false, background_tasks: [], session_crons: [] }
// The time the read of the engine agent list is given.
const READ_BOUND_MS = 2000

type Seen = { text: string; to: string | undefined }
type Wait = { ms: number; aborted: boolean; settled: boolean }
type Call = { tool_name: string; tool_input: unknown; tool_use_id: string }

// The engine agent list as the typings give an entry, with `extra` over the fields.
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, description: `work of ${id}`, type: 'general-purpose', status: 'idle', ...extra })
// A background task as Stop lists it, and a scheduled wake-up.
const task = (id: string, type: string) => ({ id, type, status: 'running', description: `${type} ${id}` })
const cron = { id: 'c1', schedule: '0 9 * * *', recurring: false, prompt: 'check in' }

// What the test hooks stand in for beneath the plugin. `agents` answers the engine agent list, with the clock to wait on; `below` answers the Stop chain beneath the
// plugin. `asked` counts the agent list's reads, `seen` the log's lines, `waits` the timers the plugin set with `clock.after`: whether each ran its course or was cancelled.
const world = (on: On, options: { agents?: (clock: MockClock) => unknown; below?: () => object } = {}) => {
  // Registered ahead of the clock's own hook, so it sits above it: it sees the read's timer, and the clock answers it.
  const waits: Wait[] = []
  on('clock.after', { ms: READ_BOUND_MS }, (_$, e, next) => {
    const wait: Wait = { ms: e.ms, aborted: false, settled: false }
    waits.push(wait)
    next.signal.addEventListener('abort', () => {
      wait.aborted = true
    })
    const answer = next(e)
    // Notes that the wait ended; the answer itself, whichever way it went, is what the hook returns.
    const ended = () => {
      wait.settled = true
    }
    answer.then(ended, ended)
    return answer
  })
  const clock = mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('process.run', () => RAN)
  on('tool.check', PUSH, () => ({ decision: 'allow' }))
  on('tool.call', PUSH, () => ({ result: { pushSent: true } }) as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('classic.PostToolBatch', () => ({}))
  on('classic.Stop', () => options.below?.() ?? {})
  const asked = { count: 0 }
  on('agent.list', () => {
    asked.count++
    return (options.agents?.(clock) ?? { value: [] }) as never
  })
  const seen: Seen[] = []
  on('ui.log', (_$, e) => {
    seen.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  return { clock, asked, seen, waits }
}

type World = ReturnType<typeof world>

// The rule's own debug lines, and every line the plugin wrote to the transcript.
const ruleLines = (seen: Seen[]): string[] => seen.filter(line => line.text.startsWith(RULE) && line.to === 'debug').map(line => line.text)
const transcript = (seen: Seen[]): string[] => seen.filter(line => line.to !== 'debug').map(line => line.text)
// The read's timers that neither ran their course nor were cancelled.
const pendingReads = (waits: Wait[]): Wait[] => waits.filter(wait => !wait.settled && !wait.aborted)

const file = async ($: Engine, ...titles: string[]): Promise<void> => {
  for (const title of titles) await $.tool.call({ tool: TOOL, action: 'add', title })
}
const base = async ($: Engine): Promise<void> => file($, 'First ask', 'Second ask')
const mark = (id: number, blocking: boolean) => ({ tool: TOOL, action: 'update', id, blocking }) as const
// The list as the tool prints it, for the states a test's premise needs.
const listed = async ($: Engine): Promise<string> => String((await $.tool.call({ tool: TOOL, action: 'list' })).result)

// A press of the done button on an item, which opens its undo window.
const press = async ($: Engine, id: number): Promise<void> => {
  const ui = await $.ui.mount({ plugin: 'human-plugin', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: `done-${id}` })
}
const startTurn = (n = 1) => ({ text: 'work', turnId: `t${n}` })
const end = ($: Engine, reason: 'answer' | 'aborted') => $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })
const step = async ($: Engine, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 })
  for await (const _chunk of stream) continue
  return stream.result
}
// A SendMessage call as a batch lists it, and the batch.
const sent = (input: unknown) => ({ tool_name: 'SendMessage', tool_input: input, tool_use_id: 'u1' })
const batch = ($: Engine, ...calls: Call[]) => $.classic.PostToolBatch({ tool_calls: calls })
const ended = ($: Engine, reason: 'resume' | 'clear') => $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } })

// ---- The steer, and what withholds it

test('a turn that ends with two open items and none blocking is blocked once with a steer that names both numbers, never a title, and one debug line says so', async ($, on) => {
  const { asked, seen, waits } = world(on)
  await base($)
  const answered = await $.classic.Stop(STOP)
  const text = answered.block ?? ''
  expect(text).toContain('#1')
  expect(text).toContain('#2')
  expect(text).toContain('blocking')
  expect(text).not.toContain('First ask')
  expect(text).not.toContain('Second ask')
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('steered')
  expect(lines[0]).toContain('#1')
  expect(lines[0]).toContain('#2')
  expect(transcript(seen)).toEqual([])
  expect(asked.count).toBe(1)
  expect(waits, 'the read set its timer').toHaveLength(1)
  expect(pendingReads(waits), 'and left none pending').toEqual([])
})

test('the steer keeps whatever the chain beneath answered', async ($, on) => {
  world(on, { below: () => ({ additionalContext: ['kept'] }) })
  await base($)
  const answered = await $.classic.Stop(STOP)
  expect(answered.additionalContext).toEqual(['kept'])
  expect(answered.block).toContain('#1')
})

test('with one item blocking, or with no item on the list, the turn ends with no steer and the engine agent list is never read', async ($, on) => {
  const { asked, seen } = world(on)
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen)).toEqual([`${RULE} withheld: no item is open`])
  await base($)
  await $.tool.call(mark(2, true))
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen)).toEqual([`${RULE} withheld: no item is open`, `${RULE} withheld: an open item is blocking`])
  expect(asked.count).toBe(0)
})

// A change to the base case that withholds the steer: the state the list must show for it to be the change meant, and the reason the one debug line names.
const withheldRows: [string, string, string, ($: Engine, w: World) => Promise<void>][] = [
  [
    'a third item in its undo window',
    '#3 non-blocking, done-waiting',
    'an answer on its way',
    async $ => {
      await file($, 'Third ask')
      await press($, 3)
    },
  ],
  [
    "a done notice waiting for the turn's end",
    '#3 non-blocking, done-pending',
    'an answer on its way',
    async ($, { clock }) => {
      await file($, 'Third ask')
      await $.turn.start(startTurn())
      await press($, 3)
      await clock.advance(5000)
    },
  ],
]
for (const [change, state, reason, set] of withheldRows) {
  test(`${change} withholds the steer, and the debug line says ${reason}`, async ($, on) => {
    const w = world(on)
    await base($)
    await set($, w)
    expect(await listed($)).toContain(state)
    expect((await $.classic.Stop(STOP)).block).toBe(undefined)
    const lines = ruleLines(w.seen)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(reason)
    expect(w.asked.count).toBe(0)
  })
}

test('a walk asking withholds the steer, and the debug line says a walk asking', async ($, on) => {
  const { clock, asked, seen } = world(on)
  const open: { release: () => void } = { release: () => undefined }
  const held = new Promise<void>(resolve => (open.release = resolve))
  on('tool.call', ASK, async () => {
    await held
    return { deny: 'closed by the test' } as never
  })
  await base($)
  const walking = $.command.run(DO)
  await clock.settle()
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('a walk asking')
  expect(asked.count).toBe(0)
  open.release()
  await walking
})

test('a walk that has ended but whose release is still to come withholds the steer; once the release has run, it steers', async ($, on) => {
  const { clock, seen } = world(on)
  on('tool.call', ASK, () => ({ deny: 'closed by the test' }) as never)
  await base($)
  await $.command.run(DO)
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen)).toEqual([`${RULE} withheld: a walk asking`])
  await clock.advance(5000)
  expect((await $.classic.Stop(STOP)).block).toContain('#1')
})

test('a rebuild held open withholds the steer at once, without waiting for it, and the debug line says a rebuild running', async ($, on) => {
  const { clock, asked, seen } = world(on)
  const open: { release: () => void } = { release: () => undefined }
  const held = new Promise<void>(resolve => (open.release = resolve))
  on('classic.SessionStart', () => ({}))
  on('fs.exists', (_$, e) => ({ value: e.path === MAIN }))
  on('fs.list', () => ({ value: [] }))
  on('process.spawn', async function* () {
    await held
    return { value: { code: 0, signal: null } }
  })
  await base($)
  await $.classic.SessionStart({ source: 'resume', transcript_path: MAIN })
  let answered = false
  const stopping = $.classic.Stop(STOP).then(result => {
    answered = true
    return result
  })
  await clock.settle()
  expect(answered, 'the Stop answers before the test clock is advanced').toBe(true)
  expect((await stopping).block).toBe(undefined)
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('a rebuild running')
  expect(asked.count).toBe(0)
  open.release()
  await clock.settle()
})

test('a notice already delivered to the agent does not withhold the steer', async ($, on) => {
  const { clock } = world(on)
  await base($)
  await file($, 'Third ask')
  await $.turn.start(startTurn())
  await press($, 3)
  await clock.advance(5000)
  // The batch's read point appends the notice, and the next request carries it: it has been delivered.
  await batch($)
  await step($, 1)
  expect(await listed($)).toContain('#3 non-blocking, done-pending')
  expect((await $.classic.Stop(STOP)).block).toContain('#2')
})

test("a notice an interrupt held for the human's next prompt does not withhold the steer", async ($, on) => {
  const { clock } = world(on)
  await base($)
  await file($, 'Third ask')
  await $.turn.start(startTurn())
  await press($, 3)
  await clock.advance(5000)
  await end($, 'aborted')
  await $.turn.start(startTurn(2))
  expect(await listed($)).toContain('#3 non-blocking, done-pending')
  expect((await $.classic.Stop(STOP)).block).toContain('#2')
})

test('a notice appended at a read point that no request has read yet withholds the steer', async ($, on) => {
  const { clock, asked, seen } = world(on)
  await base($)
  await file($, 'Third ask')
  await $.turn.start(startTurn())
  await press($, 3)
  await clock.advance(5000)
  await batch($)
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen)).toHaveLength(1)
  expect(ruleLines(seen)[0]).toContain('an answer on its way')
  expect(asked.count).toBe(0)
})

// A change to the Stop's input on the base case, with the reason the debug line names (null: the Stop is not the rule's, and nothing is written), and how many times
// the engine agent list is read: a task of the engine's other kinds is told from an agent's only by that list.
const stopRows: [string, object, string | null, number][] = [
  ['stop_hook_active true', { stop_hook_active: true }, null, 0],
  ['agent_id set', { agent_id: 'sub-1' }, null, 0],
  ['background_tasks absent', { background_tasks: undefined }, 'task list unknown', 0],
  ['session_crons absent', { session_crons: undefined }, 'cron list unknown', 0],
  ['a shell task listed', { background_tasks: [task('t9', 'shell')] }, 't9', 1],
  ['a monitor task listed', { background_tasks: [task('m3', 'monitor')] }, 'm3', 1],
  ['one cron listed', { session_crons: [cron] }, 'a scheduled wake-up', 0],
]
for (const [change, input, reason, read] of stopRows) {
  test(`${change} ends the turn with no steer, and ${reason === null ? 'writes no line' : `the debug line says ${reason}`}`, async ($, on) => {
    const { asked, seen } = world(on)
    await base($)
    expect((await $.classic.Stop({ ...STOP, ...input })).block).toBe(undefined)
    const lines = ruleLines(seen)
    if (reason === null) expect(lines).toEqual([])
    else {
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(reason)
    }
    expect(transcript(seen)).toEqual([])
    expect(asked.count).toBe(read)
  })
}

test('a block a hook beneath already gave is passed on unchanged, and the debug line says another hook blocked', async ($, on) => {
  const { asked, seen } = world(on, { below: () => ({ block: 'from beneath' }) })
  await base($)
  expect((await $.classic.Stop(STOP)).block).toBe('from beneath')
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('another hook blocked')
  expect(asked.count).toBe(0)
})

// ---- What the agents and the turn's messages say is in flight

// A change to the agents or the turn that withholds the steer: the agents listed, the calls of the turn's batch, and the id the one debug line names.
const agentRows: [string, unknown[], Call[], string][] = [
  ['an agent listed running with no spawnedBy', [agent('a1', { status: 'running' })], [], 'a1'],
  ['an agent listed pending with no spawnedBy', [agent('a1', { status: 'pending' })], [], 'a1'],
  ['an agent listed waiting with no spawnedBy', [agent('a1', { status: 'waiting' })], [], 'a1'],
  ['an agent listed idle that the main agent sent a message to in this turn', [agent('a1')], [sent({ to: 'a1', message: 'go on' })], 'a1'],
  ['an agent listed completed that the main agent sent a message to in this turn', [agent('a1', { status: 'completed' })], [sent({ to: 'a1', message: 'go on' })], 'a1'],
  ['an agent listed idle named mate that the main agent sent a message to as mate [a1b2c3] in this turn', [agent('a7', { name: 'mate' })], [sent({ to: 'mate [a1b2c3]', message: 'go on' })], 'a7'],
  ['an agent listed idle with a team address that the main agent sent a message to by it in this turn', [agent('a8', { teammateId: 'mate@team' })], [sent({ to: 'mate@team', message: 'go on' })], 'a8'],
]
for (const [change, agents, calls, reason] of agentRows) {
  test(`${change} withholds the steer, and the debug line names the agent's id`, async ($, on) => {
    const { asked, seen } = world(on, { agents: () => ({ value: agents }) })
    await base($)
    await $.turn.start(startTurn())
    await batch($, ...calls)
    expect((await $.classic.Stop(STOP)).block).toBe(undefined)
    const lines = ruleLines(seen)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(reason)
    expect(asked.count).toBe(1)
  })
}

test('a message to every agent in this turn withholds the steer, and the debug line says a broadcast, with the agent list unread', async ($, on) => {
  const { asked, seen } = world(on)
  await base($)
  await $.turn.start(startTurn())
  await batch($, sent({ to: '*', message: 'all hands' }))
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('a broadcast')
  expect(asked.count).toBe(0)
})

test("an engine agent list that throws withholds the steer, the debug line carries the error's message, and the read's timer is cancelled", async ($, on) => {
  const { seen, waits } = world(on, { agents: () => ({ deny: 'engine says no' }) })
  await base($)
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('engine says no')
  expect(waits).toHaveLength(1)
  expect(pendingReads(waits)).toEqual([])
})

test('an engine agent list that has not answered within 2 s withholds the steer then, its late answer changes nothing, and no timer of the read is left pending', async ($, on) => {
  const { clock, asked, seen, waits } = world(on, {
    agents: waiting =>
      (async () => {
        await waiting.sleep(60_000)
        return { value: [agent('a1', { status: 'running' })] }
      })(),
  })
  await base($)
  let answered: { block?: string } | null = null
  const stopping = $.classic.Stop(STOP).then(result => (answered = result))
  await clock.advance(READ_BOUND_MS - 1)
  expect(answered, 'the Stop waits for the bound').toBe(null)
  await clock.advance(1)
  expect(answered, 'the Stop answers once the bound has passed').not.toBe(null)
  const result = await stopping
  expect(result.block).toBe(undefined)
  expect(asked.count).toBe(1)
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('no answer within 2 s')
  await clock.advance(60_000)
  expect(ruleLines(seen)).toEqual(lines)
  expect(transcript(seen)).toEqual([])
  expect(waits).toHaveLength(1)
  expect(pendingReads(waits)).toEqual([])
})

// An entry the typings do not allow makes the whole read unread: the steer is withheld, with the reason.
const shapeRows: [string, unknown][] = [
  ['an engine agent list entry with no string id', [{ status: 'running' }]],
  ['an engine agent list entry whose id is a number', [agent('a1', { id: 7 })]],
  ['an engine agent list entry with status paused', [agent('a1', { status: 'paused' })]],
  ['an engine agent list entry with no status', [{ id: 'a1' }]],
  ['an engine agent list entry whose spawnedBy is not a string', [agent('a1', { spawnedBy: 7 })]],
  ['an engine agent list that is not a list', { agents: [] }],
]
for (const [change, answer] of shapeRows) {
  test(`${change} withholds the steer, and the debug line says unexpected shape`, async ($, on) => {
    const { seen } = world(on, { agents: () => ({ value: answer }) })
    await base($)
    expect((await $.classic.Stop(STOP)).block).toBe(undefined)
    const lines = ruleLines(seen)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('unexpected shape')
  })
}

test('a teammate task whose agent is idle, an agent another plugin spawned, a message sent in the previous turn, and calls with no string address do not withhold the steer', async ($, on) => {
  const { seen } = world(on, {
    agents: () => ({
      value: [agent('mate-id', { name: 'mate', teammateId: 'mate@team' }), agent('rev1', { status: 'running', spawnedBy: 'auditor', name: 'auditor-reviewer' })],
    }),
  })
  await base($)
  await $.turn.start(startTurn())
  await batch($, sent({ to: 'mate', message: 'go on' }))
  await $.turn.start(startTurn(2))
  await batch($, sent({ message: 'no address' }), sent({ to: 7 }), sent(null), sent('to mate'))
  const answered = await $.classic.Stop({ ...STOP, background_tasks: [task('t5', 'teammate'), task('s2', 'subagent')] })
  expect(answered.block).toContain('#2')
  const lines = ruleLines(seen)
  const aside = lines.filter(line => line.includes('set aside'))
  expect(aside).toHaveLength(1)
  expect(aside[0]).toContain('rev1')
  expect(aside[0]).toContain('auditor')
  expect(aside[0]).toContain('running')
  expect(lines).toHaveLength(2)
})

test('a task that carries a listed agent id is that agent, whatever label its type has', async ($, on) => {
  world(on, { agents: () => ({ value: [agent('a1')] }) })
  await base($)
  expect((await $.classic.Stop({ ...STOP, background_tasks: [task('a1', 'local_agent')] })).block).toContain('#2')
})

test('a task of another kind and an agent still working are both named in the one reason line', async ($, on) => {
  const { seen } = world(on, { agents: () => ({ value: [agent('a1', { status: 'running' })] }) })
  await base($)
  expect((await $.classic.Stop({ ...STOP, background_tasks: [task('t9', 'shell')] })).block).toBe(undefined)
  const lines = ruleLines(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('t9')
  expect(lines[0]).toContain('a1')
})

test('a message to an agent another plugin spawned does not withhold the steer', async ($, on) => {
  world(on, { agents: () => ({ value: [agent('rev1', { spawnedBy: 'auditor', name: 'auditor-reviewer' })] }) })
  await base($)
  await $.turn.start(startTurn())
  await batch($, sent({ to: 'auditor-reviewer', message: 'go on' }))
  expect((await $.classic.Stop(STOP)).block).toContain('#2')
})

test("a call of another tool addresses no one, and a malformed message call does not stop the batch's other calls from being recorded", async ($, on) => {
  const { seen } = world(on, { agents: () => ({ value: [agent('a7', { name: 'mate' })] }) })
  await base($)
  await $.turn.start(startTurn())
  await batch($, { tool_name: 'Bash', tool_input: { to: 'mate' }, tool_use_id: 'u0' })
  expect((await $.classic.Stop(STOP)).block).toContain('#2')
  await batch($, sent({ message: 'no address' }), sent(null), sent({ to: 'mate' }))
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen).at(-1)).toContain('a7')
})

test("a subagent's batch is not the main agent's: a message in it neither withholds the steer nor is recorded", async ($, on) => {
  world(on)
  await base($)
  await $.turn.start(startTurn())
  await $.classic.PostToolBatch({ tool_calls: [sent({ to: '*', message: 'all hands' })], agent_id: 'sub-1' })
  expect((await $.classic.Stop(STOP)).block).toContain('#2')
})

test("a subagent's turn start does not clear the main turn's messages", async ($, on) => {
  const { seen } = world(on, { agents: () => ({ value: [agent('a7', { name: 'mate' })] }) })
  await base($)
  await $.turn.start(startTurn())
  await batch($, sent({ to: 'mate', message: 'go on' }))
  await $.turn.start({ ...startTurn(2), agentId: 'sub-1' })
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen)[0]).toContain('a7')
})

test("a session end that is not a /clear clears the messages the turn recorded, so the next turn's end is not held by them", async ($, on) => {
  const { seen } = world(on, { agents: () => ({ value: [agent('a7', { name: 'mate' })] }) })
  await base($)
  await $.turn.start(startTurn())
  await batch($, sent({ to: 'mate', message: 'go on' }))
  expect((await $.classic.Stop(STOP)).block).toBe(undefined)
  expect(ruleLines(seen)[0]).toContain('a7')
  await ended($, 'resume')
  expect((await $.classic.Stop(STOP)).block).toContain('#2')
})

// ---- What the steer names

test('twelve open items: the steer names the first ten numbers in the band\'s order and then says "and 2 more"', async ($, on) => {
  world(on)
  await file($, ...Array.from({ length: 12 }, (_, n) => `Ask ${n + 1}`))
  const text = (await $.classic.Stop(STOP)).block ?? ''
  expect(text).toContain('#1, #2, #3, #4, #5, #6, #7, #8, #9, #10, and 2 more')
  expect(text).not.toContain('#11')
  expect(text).not.toContain('#12')
})

test('ten open items are all named, with no count of more', async ($, on) => {
  world(on)
  await file($, ...Array.from({ length: 10 }, (_, n) => `Ask ${n + 1}`))
  const text = (await $.classic.Stop(STOP)).block ?? ''
  expect(text).toContain('#1, #2, #3, #4, #5, #6, #7, #8, #9, #10.')
  expect(text).not.toContain('more')
})

test("an item a walk has shown ranks below the rest in the steer, as it does in the band", async ($, on) => {
  const { clock } = world(on)
  on('tool.call', ASK, () => ({ deny: 'closed by the test' }) as never)
  await file($, 'First ask', 'Second ask', 'Third ask')
  await $.command.run(DO)
  await clock.advance(5000)
  expect((await $.classic.Stop(STOP)).block).toContain('#2, #3, #1')
})

// ---- A failure of the hook

test("a Stop whose human list read throws answers no block, writes one transcript line naming the Stop hook, and passes the chain's result on", async ($, on) => {
  const { seen } = world(on, { below: () => ({ additionalContext: ['from beneath'] }) })
  const failing = { read: false }
  on('state.get', (_$, e, next) => (failing.read ? ({ deny: 'list unreadable' } as never) : next(e)))
  await base($)
  failing.read = true
  const answered = await $.classic.Stop(STOP)
  expect(answered.block).toBe(undefined)
  expect(answered.additionalContext).toEqual(['from beneath'])
  const lines = transcript(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('classic.Stop')
  expect(lines[0]).toContain('list unreadable')
  expect(ruleLines(seen)).toEqual([])
})

// ---- A steered turn that ends the same way

test('after a steer, the next Stop with stop_hook_active gets no block and one transcript line naming both open items', async ($, on) => {
  const { seen } = world(on)
  await base($)
  expect((await $.classic.Stop(STOP)).block).toContain('#1')
  expect(transcript(seen)).toEqual([])
  const again = await $.classic.Stop({ ...STOP, stop_hook_active: true })
  expect(again.block).toBe(undefined)
  const lines = transcript(seen)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('#1')
  expect(lines[0]).toContain('#2')
})

test('after a steer, an item marked blocking before the next Stop writes no such line', async ($, on) => {
  const { seen } = world(on)
  await base($)
  expect((await $.classic.Stop(STOP)).block).toContain('#1')
  await $.tool.call(mark(1, true))
  expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBe(undefined)
  expect(transcript(seen)).toEqual([])
})

test('a Stop with stop_hook_active that follows no steer of this rule writes no such line', async ($, on) => {
  const { asked, seen } = world(on)
  await base($)
  expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBe(undefined)
  expect(transcript(seen)).toEqual([])
  expect(ruleLines(seen)).toEqual([])
  expect(asked.count).toBe(0)
})

test('the line is said once: a third Stop with stop_hook_active writes none', async ($, on) => {
  const { seen } = world(on)
  await base($)
  await $.classic.Stop(STOP)
  await $.classic.Stop({ ...STOP, stop_hook_active: true })
  await $.classic.Stop({ ...STOP, stop_hook_active: true })
  expect(transcript(seen)).toHaveLength(1)
})

test('a turn start, a session end and a Stop that was not steered each clear the mark of a steer', async ($, on) => {
  const { seen } = world(on)
  await base($)
  for (const clear of [() => $.turn.start(startTurn()), () => ended($, 'resume'), () => $.classic.Stop({ ...STOP, session_crons: [cron] })]) {
    expect((await $.classic.Stop(STOP)).block).toContain('#1')
    await clear()
    expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBe(undefined)
  }
  expect(transcript(seen)).toEqual([])
})

test("a subagent's Stop between a steer and the next Stop leaves the mark: the line is still said", async ($, on) => {
  const { seen } = world(on)
  await base($)
  await $.classic.Stop(STOP)
  await $.classic.Stop({ ...STOP, agent_id: 'sub-1', stop_hook_active: true })
  await $.classic.Stop({ ...STOP, stop_hook_active: true })
  expect(transcript(seen)).toHaveLength(1)
})

test('a Stop with stop_hook_active that another hook blocked, after a steer, writes no line and passes the block on', async ($, on) => {
  const blocked = { below: false }
  const { seen } = world(on, { below: () => (blocked.below ? { block: 'from beneath' } : {}) })
  await base($)
  await $.classic.Stop(STOP)
  blocked.below = true
  expect((await $.classic.Stop({ ...STOP, stop_hook_active: true })).block).toBe('from beneath')
  expect(transcript(seen)).toEqual([])
})

// ---- The engine agent list's boundary, called as the engine would with a `$` that records the timer

type Armed = { ms: number; fire: () => void; cancelled: boolean }

// A `$` with the two nouns the read uses. A timer fires only when a test fires it; cancelling one marks it. The test engine cannot make a call hang or a timer fail to arm.
const fake = (list: () => Promise<unknown>, arm: () => void = () => undefined) => {
  const timers: Armed[] = []
  const calls = { list: 0 }
  const $ = {
    agent: {
      list: () => {
        calls.list++
        return list()
      },
    },
    clock: {
      after: (ms: number, fire: () => void) => {
        arm()
        const timer: Armed = { ms, fire, cancelled: false }
        timers.push(timer)
        return { cancel: () => void (timer.cancelled = true) }
      },
    },
  }
  return { $: $ as never, timers, calls }
}

test('a list that answers in time is read as plain entries, with the 2 s timer set and cancelled', async () => {
  const entries = [
    agent('a1', { name: 'mate', teammateId: 'mate@team' }),
    agent('a2', { status: 'running', spawnedBy: 'auditor' }),
    agent('a3', { status: 'waiting', name: 7, teammateId: null }),
  ]
  const { $, timers } = fake(async () => entries)
  expect(await readAgents($)).toEqual({
    kind: 'read',
    agents: [
      { id: 'a1', status: 'idle', addresses: ['a1', 'mate', 'mate@team'], spawnedBy: null },
      { id: 'a2', status: 'running', addresses: ['a2'], spawnedBy: 'auditor' },
      { id: 'a3', status: 'waiting', addresses: ['a3'], spawnedBy: null },
    ],
  })
  expect(timers.map(timer => [timer.ms, timer.cancelled])).toEqual([[READ_BOUND_MS, true]])
})

test("a call that rejects is unread with the error's message, and its timer is cancelled", async () => {
  const { $, timers } = fake(async () => {
    throw new Error('engine says no')
  })
  expect(await readAgents($)).toEqual({ kind: 'unread', reason: 'engine says no' })
  expect(timers.map(timer => timer.cancelled)).toEqual([true])
})

test('a rejection that is no error is unread with its text', async () => {
  const { $ } = fake(() => Promise.reject('plain text'))
  expect(await readAgents($)).toEqual({ kind: 'unread', reason: 'plain text' })
})

test('a call that throws before it returns a promise is unread with the error, and its timer is cancelled', async () => {
  const { $, timers } = fake(() => {
    throw new Error('thrown at once')
  })
  expect(await readAgents($)).toEqual({ kind: 'unread', reason: 'thrown at once' })
  expect(timers.map(timer => timer.cancelled)).toEqual([true])
})

for (const [change, answer] of [
  ['an answer that is not a list', { agents: [] }],
  ['an entry that is not an object', ['a1']],
  ['an entry that is null', [null]],
  ['an entry with no string id', [{ status: 'idle' }]],
  ['an entry with a status the typings do not list', [{ id: 'a1', status: 'paused' }]],
  ['an entry whose spawnedBy is present and not a string', [{ id: 'a1', status: 'idle', spawnedBy: null }]],
  ['one bad entry among good ones', [agent('a1'), { id: 'a2', status: 'sleeping' }]],
] as const) {
  test(`${change} is unread as an unexpected shape, and its timer is cancelled`, async () => {
    const { $, timers } = fake(async () => answer)
    expect(await readAgents($)).toEqual({ kind: 'unread', reason: 'unexpected shape' })
    expect(timers.map(timer => timer.cancelled)).toEqual([true])
  })
}

test('an empty list is read, with no agent', async () => {
  const { $ } = fake(async () => [])
  expect(await readAgents($)).toEqual({ kind: 'read', agents: [] })
})

test('a call that does not answer when the bound fires is unread, and an answer or a rejection after it is ignored', async () => {
  for (const later of ['answers', 'rejects'] as const) {
    const gate: { answer: () => void; reject: () => void } = { answer: () => undefined, reject: () => undefined }
    const { $, timers } = fake(
      () =>
        new Promise<unknown>((resolve, reject) => {
          gate.answer = () => resolve([agent('a1', { status: 'running' })])
          gate.reject = () => reject(new Error('late failure'))
        }),
    )
    const reading = readAgents($)
    expect(timers).toHaveLength(1)
    timers[0]?.fire()
    expect(await reading).toEqual({ kind: 'unread', reason: 'no answer within 2 s' })
    expect(timers.map(timer => timer.cancelled)).toEqual([true])
    if (later === 'answers') gate.answer()
    else gate.reject()
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }
})

test('a timer that cannot be set is unread with the error, and the call is never made', async () => {
  const { $, calls, timers } = fake(
    async () => [],
    () => {
      throw new Error('no timer')
    },
  )
  expect(await readAgents($)).toEqual({ kind: 'unread', reason: 'no timer' })
  expect(calls.list).toBe(0)
  expect(timers).toEqual([])
})
