import { expect, test } from 'claude-code/testing'
import { ETA_MAX, GLYPH, HEADING, NO_ETA, STATES, TITLE_MAX, TODO_NAME, TODO_TOOL, bandCountsText, countsText, etaTail, inDisplayOrder, normalizeTodo, parseTodo, todoLine, todoReply } from './todo'
import type { TodoItem } from '../types'

const write = (entries: unknown): TodoItem[] | null => {
  const parsed = parseTodo({ entries })
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value
}
const refusal = (raw: unknown): string => {
  const parsed = parseTodo(raw)
  if (parsed.ok) throw new Error('the input was accepted')
  return parsed.reason
}
const LIST: TodoItem[] = [
  { title: 'Write tests', state: 'queued', eta: 'after tests' },
  { title: 'Build', state: 'in_flight', eta: '~10 min' },
  { title: 'Ship', state: 'queued', eta: NO_ETA },
]

test('the tool is named claude_todo and its states are queued, in_flight and done', () => {
  expect(TODO_TOOL).toBe(`mcp__human-plugin__${TODO_NAME}`)
  expect(TODO_NAME).toBe('claude_todo')
  expect([...STATES]).toEqual(['queued', 'in_flight', 'done'])
  expect(TITLE_MAX).toBe(80)
})

test('a write keeps the queued and in-flight entries in the order given, and drops the done ones', () => {
  expect(
    write([
      { title: 'Shipped', state: 'done' },
      { title: 'Queued first', state: 'queued' },
      { title: 'Running', state: 'in_flight' },
      { title: 'Queued last', state: 'queued' },
    ]),
  ).toEqual([
    { title: 'Queued first', state: 'queued', eta: NO_ETA },
    { title: 'Running', state: 'in_flight', eta: NO_ETA },
    { title: 'Queued last', state: 'queued', eta: NO_ETA },
  ])
})

test('an empty array is a write of the empty list, and an input with no array is a read', () => {
  expect(write([])).toEqual([])
  expect(parseTodo({})).toEqual({ ok: true, value: null })
  expect(parseTodo({ tool: TODO_TOOL, agentId: 'sub-1' })).toEqual({ ok: true, value: null })
})

test('a title is trimmed, and a title of exactly 80 UTF-16 units is accepted', () => {
  expect(write([{ title: '  Build it  ', state: 'queued' }])).toEqual([{ title: 'Build it', state: 'queued', eta: NO_ETA }])
  const longest = 'x'.repeat(80)
  expect(write([{ title: longest, state: 'queued' }])).toEqual([{ title: longest, state: 'queued', eta: NO_ETA }])
})

test('a title of 81 UTF-16 units is refused with the limit named; a surrogate pair counts as two units', () => {
  expect(refusal({ entries: [{ title: 'x'.repeat(81), state: 'queued' }] })).toContain('80')
  expect(parseTodo({ entries: [{ title: '😀'.repeat(40), state: 'queued' }] }).ok).toBe(true)
  expect(parseTodo({ entries: [{ title: '😀'.repeat(41), state: 'queued' }] }).ok).toBe(false)
  expect(parseTodo({ entries: [{ title: `${' '.repeat(5)}${'x'.repeat(80)}${' '.repeat(5)}`, state: 'queued' }] }).ok).toBe(true)
})

test('an empty title, a title with a line break and an unknown state are each refused with a reason that names the entry', () => {
  expect(refusal({ entries: [{ title: 'Fine', state: 'queued' }, { title: '   ', state: 'queued' }] })).toBe('entry 2: the title is empty')
  // A line break is the one the repo's LINE_BREAK names (items.ts): a line feed, a carriage return, a CRLF pair, or a Unicode line or paragraph separator.
  for (const title of ['two\nlines', 'two\r\nlines', 'two\rlines', 'two\u2028lines', 'two\u2029lines']) {
    expect(refusal({ entries: [{ title, state: 'queued' }] })).toBe('entry 1: the title must be on one line')
  }
  expect(refusal({ entries: [{ title: 'Fine', state: 'blocked' }] })).toBe('entry 1: the state must be queued, in_flight or done')
  expect(refusal({ entries: [{ title: 'Fine' }] })).toBe('entry 1: the state must be queued, in_flight or done')
})

test('a title that is not text, an entry that is not an object and entries that are no array are refused', () => {
  expect(refusal({ entries: [{ title: 3, state: 'queued' }] })).toBe('entry 1: the title must be text')
  expect(refusal({ entries: ['Build'] })).toBe('entry 1 must be an object with a title and a state')
  expect(refusal({ entries: [null] })).toBe('entry 1 must be an object with a title and a state')
  expect(refusal({ entries: 'Build' })).toBe('entries must be a list of entries, each with a title and a state')
  expect(refusal({ entries: null })).toBe('entries must be a list of entries, each with a title and a state')
  expect(refusal(null)).toBe('the input must be an object')
  expect(refusal('x')).toBe('the input must be an object')
})

test('a stored list keeps an entry whose title is text and whose state is known, in order, and does not re-check the title', () => {
  const long = 'x'.repeat(200)
  expect(
    normalizeTodo([
      { title: 'Build', state: 'in_flight', eta: '~5 min' },
      { title: 3, state: 'queued' },
      { title: 'Ghost', state: 'done' },
      { title: 'Odd', state: 'weird' },
      'junk',
      null,
      { title: long, state: 'queued' },
    ]),
  ).toEqual([
    { title: 'Build', state: 'in_flight', eta: '~5 min' },
    { title: long, state: 'queued', eta: NO_ETA },
  ])
})

test('a stored value that is no list is a list not yet written, and an empty list is a written one', () => {
  for (const raw of [undefined, null, 'x', 3, {}]) expect(normalizeTodo(raw)).toBe(null)
  expect(normalizeTodo([])).toEqual([])
})

test('the display order puts in-flight entries ahead of queued ones, each in written order, and leaves its input as it was', () => {
  expect(inDisplayOrder(LIST).map(it => it.title)).toEqual(['Build', 'Write tests', 'Ship'])
  expect(LIST.map(it => it.title)).toEqual(['Write tests', 'Build', 'Ship'])
  expect(inDisplayOrder([])).toEqual([])
})

test('the counts read N in flight, M queued, with both numbers always', () => {
  expect(countsText(LIST)).toBe('1 in flight, 2 queued')
  expect(countsText([])).toBe('0 in flight, 0 queued')
  expect(countsText([{ title: 'a', state: 'in_flight', eta: NO_ETA }, { title: 'b', state: 'in_flight', eta: NO_ETA }])).toBe('2 in flight, 0 queued')
})

test('a write and a read answer the counting line, then each entry in written order as its state, title and ETA; an empty list answers the counting line alone', () => {
  expect(todoReply(LIST)).toBe(
    ['Claude TODO: 1 in flight, 2 queued', '- queued: Write tests (ETA: after tests)', '- in_flight: Build (ETA: ~10 min)', '- queued: Ship (ETA: no ETA)'].join('\n'),
  )
  expect(todoReply([])).toBe('Claude TODO: 0 in flight, 0 queued')
})

test('the ETA is stored as written, trimmed', () => {
  expect(write([{ title: 'Build', state: 'queued', eta: '  ~10 min ' }])).toEqual([{ title: 'Build', state: 'queued', eta: '~10 min' }])
})

test('a missing, null, non-text or blank ETA is accepted and stored as no ETA', () => {
  expect(NO_ETA).toBe('no ETA')
  for (const eta of [undefined, null, 3, true, {}, '', '   ', '\n \t']) {
    expect(write([{ title: 'Build', state: 'queued', eta }])).toEqual([{ title: 'Build', state: 'queued', eta: NO_ETA }])
  }
  expect(write([{ title: 'Build', state: 'queued' }])).toEqual([{ title: 'Build', state: 'queued', eta: NO_ETA }])
})

test('a line break in an ETA becomes a space', () => {
  expect(write([{ title: 'Build', state: 'queued', eta: 'after\ntests' }])?.[0]?.eta).toBe('after tests')
  expect(write([{ title: 'Build', state: 'queued', eta: 'after\r\ntests' }])?.[0]?.eta).toBe('after tests')
})

test('an ETA over 30 UTF-16 units is cut to 30, the ellipsis inside the 30; one of exactly 30 is kept', () => {
  expect(ETA_MAX).toBe(30)
  const exact = 'y'.repeat(30)
  expect(write([{ title: 'Build', state: 'queued', eta: exact }])?.[0]?.eta).toBe(exact)
  const cut = write([{ title: 'Build', state: 'queued', eta: 'y'.repeat(31) }])?.[0]?.eta
  expect(cut).toBe(`${'y'.repeat(29)}…`)
  expect(cut?.length).toBe(30)
  expect(todoReply(write([{ title: 'Build', state: 'queued', eta: 'y'.repeat(60) }]) ?? [])).toContain(`(ETA: ${'y'.repeat(29)}…)`)
})

test('a stored entry with no ETA, or one that is not text, reads back as no ETA; a stored one is normalised as a write would', () => {
  expect(normalizeTodo([{ title: 'Old', state: 'queued' }, { title: 'Odd', state: 'queued', eta: 5 }, { title: 'Two', state: 'queued', eta: 'a\nb' }])).toEqual([
    { title: 'Old', state: 'queued', eta: NO_ETA },
    { title: 'Odd', state: 'queued', eta: NO_ETA },
    { title: 'Two', state: 'queued', eta: 'a b' },
  ])
})

test('an entry\'s ETA tail, what follows its title where a person reads the list, is a middle dot between spaces and then its stored ETA, no ETA included', () => {
  expect(LIST.map(it => etaTail(it))).toEqual([' · after tests', ' · ~10 min', ' · no ETA'])
})

const call = (input: unknown, output: unknown, isRunning = false, isErrored = false) => todoLine({ input, output, isRunning, isErrored })

test('the transcript line says the list is being written while a write runs, and being read while a read runs', () => {
  expect(call({ entries: [{ title: 'Build', state: 'queued' }] }, undefined, true)).toBe('human-plugin: writing the Claude TODO list…')
  expect(call({}, undefined, true)).toBe('human-plugin: reading the Claude TODO list…')
  expect(call({ entries: [] }, undefined, true)).toBe('human-plugin: writing the Claude TODO list…')
})

test('the transcript line gives the counts once a call succeeds, for a write and for a read alike', () => {
  expect(call({ entries: LIST }, 'Claude TODO: 1 in flight, 2 queued')).toBe('human-plugin: Claude TODO 1 in flight, 2 queued')
  expect(call({}, todoReply(LIST))).toBe('human-plugin: Claude TODO 1 in flight, 2 queued')
  expect(call({ entries: [] }, 'Claude TODO: 0 in flight, 0 queued')).toBe('human-plugin: Claude TODO 0 in flight, 0 queued')
})

test('the transcript line gives the check\'s reason for an input the check refuses, and the reply of an errored or refused call, or failed when it has none', () => {
  expect(call({ entries: [{ title: '', state: 'queued' }] }, 'ignored', false, true)).toBe('human-plugin: entry 1: the title is empty')
  expect(call({ entries: [{ title: '', state: 'queued' }] }, undefined, true)).toBe('human-plugin: entry 1: the title is empty')
  expect(call({ entries: [] }, 'claude_todo: only the main agent keeps the Claude TODO list', false, true)).toBe('human-plugin: claude_todo: only the main agent keeps the Claude TODO list')
  expect(call({ entries: [] }, '', false, true)).toBe('human-plugin: failed')
  expect(call({ entries: [] }, undefined, false, true)).toBe('human-plugin: failed')
})

test('the transcript line is one line, whatever the title or the reply holds', () => {
  expect(call({ entries: [] }, 'one\ntwo   three', false, true)).toBe('human-plugin: one two three')
})

test('each state has one glyph: a half-filled circle in flight, an empty one queued, and done has none', () => {
  expect(GLYPH).toEqual({ in_flight: '◐', queued: '○' })
  expect(HEADING).toBe('Claude TODO')
})

test('the band\'s short counts word the same counts as the long form: active for in flight', () => {
  expect(bandCountsText(LIST)).toBe('1 active, 2 queued')
  expect(bandCountsText([])).toBe('0 active, 0 queued')
  expect(bandCountsText([{ title: 'a', state: 'in_flight', eta: NO_ETA }, { title: 'b', state: 'in_flight', eta: NO_ETA }])).toBe('2 active, 0 queued')
  expect(`${HEADING} ${bandCountsText(LIST)}`).toBe('Claude TODO 1 active, 2 queued')
})
