import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { REMINDER_TEXT, THRESHOLD } from './reminder'
import { TODO_TOOL } from './todo'
import { TOOL } from './items'

// The mod's batch-end hook over a base that answers `base` as the rest of the chain's context, with the list's engine stand-ins.
const session = (on: On, base: string[] | undefined = undefined) => {
  mock.clock(on)
  mock.store(on)
  on('ui.panes', () => ({ value: [] }))
  on('classic.PostToolBatch', () => (base === undefined ? {} : { additionalContext: base }))
  const logs: string[] = []
  on('ui.log', (_$, e, next) => {
    logs.push(e.text)
    return next(e)
  })
  return logs
}

const calls = (n: number, name = 'Read') => Array.from({ length: n }, (_, i) => ({ tool_name: name, tool_input: {}, tool_use_id: `${name}-${i}` }))
const batch = async ($: Engine, n: number, extra: { tool_name: string; tool_input: unknown; tool_use_id: string }[] = [], agent?: string) =>
  (await $.classic.PostToolBatch({ tool_calls: [...calls(n), ...extra], ...(agent === undefined ? {} : { agent_id: agent }) })).additionalContext ?? []
const write = ($: Engine) => $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Build it', state: 'in_flight', eta: '~10 min' }] })
const todoCall = (entries?: unknown) => ({ tool_name: TODO_TOOL, tool_input: entries === undefined ? {} : { entries }, tool_use_id: 'todo' })

test('the reminder asks for the list to be brought up to date with an ETA on every entry, and names no item and no entry', () => {
  expect(THRESHOLD).toBe(50)
  expect(REMINDER_TEXT).toBe(
    'Reminder: your Claude TODO list has not been written for 50 or more tool calls. If your steps have moved since, bring it up to date with claude_todo, an ETA on every entry.',
  )
  expect(REMINDER_TEXT).not.toMatch(/#\d|is done|replied|pressed/)
})

test('49 calls carry no reminder, the batch that takes the count to 50 carries it, and the batch\'s notices hand over as before', async ($, on) => {
  session(on)
  await $.tool.call({ tool: TOOL, action: 'add', title: 'Pick a db' })
  expect(await batch($, 49)).toEqual([])
  expect(await batch($, 1)).toEqual([REMINDER_TEXT])
})

test('a batch that takes the count from 48 to 52 carries exactly one reminder', async ($, on) => {
  session(on)
  expect(await batch($, 48)).toEqual([])
  expect(await batch($, 4)).toEqual([REMINDER_TEXT])
})

test('after the reminder, 100 more calls with no write carry no reminder', async ($, on) => {
  session(on)
  expect(await batch($, 50)).toEqual([REMINDER_TEXT])
  for (const n of [30, 30, 40]) expect(await batch($, n)).toEqual([])
})

test('after a batch holding only a successful write, 49 further calls carry no reminder and the 50th call\'s batch carries one', async ($, on) => {
  session(on)
  expect(await batch($, 50)).toEqual([REMINDER_TEXT])
  await write($)
  expect(await batch($, 0, [todoCall([{ title: 'Build it', state: 'in_flight' }])])).toEqual([])
  expect(await batch($, 49)).toEqual([])
  expect(await batch($, 1)).toEqual([REMINDER_TEXT])
})

test('a batch holding a successful write and 50 other calls carries the reminder', async ($, on) => {
  session(on)
  await write($)
  expect(await batch($, 50, [todoCall([{ title: 'Build it', state: 'in_flight' }])])).toEqual([REMINDER_TEXT])
})

test('a refused write and a read of the list neither reset the count nor add to it', async ($, on) => {
  session(on)
  expect(await batch($, 49)).toEqual([])
  expect((await $.tool.call({ tool: TODO_TOOL, entries: [{ title: '', state: 'queued' }] })).deny).toContain('the title is empty')
  expect((await $.tool.call({ tool: TODO_TOOL, entries: [{ title: 'Sub step', state: 'queued' }], agentId: 'sub-1' })).deny).toContain('only the main agent')
  await $.tool.call({ tool: TODO_TOOL })
  expect(await batch($, 0, [todoCall(), todoCall([{ title: '', state: 'queued' }])])).toEqual([])
  expect(await batch($, 1)).toEqual([REMINDER_TEXT])
})

test('a session that never writes the list is reminded once its batches reach 50 calls', async ($, on) => {
  session(on)
  const seen: string[][] = []
  for (let i = 0; i < 12; i++) seen.push(await batch($, 5))
  expect(seen.filter(context => context.length > 0)).toEqual([[REMINDER_TEXT]])
  expect(seen[9]).toEqual([REMINDER_TEXT])
})

test('a subagent\'s batches neither count nor carry the reminder', async ($, on) => {
  session(on)
  expect(await batch($, 60, [], 'sub-1')).toEqual([])
  expect(await batch($, 49)).toEqual([])
  expect(await batch($, 1)).toEqual([REMINDER_TEXT])
})

test('the context the rest of the chain gives the batch is kept, and the reminder follows it', async ($, on) => {
  session(on, ['another plugin\'s context'])
  expect(await batch($, 10)).toEqual(['another plugin\'s context'])
  expect(await batch($, 40)).toEqual(['another plugin\'s context', REMINDER_TEXT])
})

test('after a /clear the count starts at zero', async ($, on) => {
  session(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  expect(await batch($, 49)).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(await batch($, 49)).toEqual([])
  expect(await batch($, 1)).toEqual([REMINDER_TEXT])
})

test('no reminder draws a sent-to-Claude line', async ($, on) => {
  const logs = session(on)
  expect(await batch($, 50)).toEqual([REMINDER_TEXT])
  expect(logs.filter(line => line.startsWith('sent to Claude'))).toEqual([])
  expect(logs.some(line => line.includes('Reminder'))).toBe(false)
})
