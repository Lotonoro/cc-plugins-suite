import { atom, read, update, type EngineInterface } from 'claude-code'
import type { TodoItem } from '../types'
import { LINE_BREAK } from './items'
import type { ToolCall } from './ui'

export const TODO_NAME = 'claude_todo'
export const TODO_TOOL = `mcp__human-plugin__${TODO_NAME}`

// The states an entry may be written with. `done` is accepted and never stored: a finished step leaves the list at once.
export const STATES = ['queued', 'in_flight', 'done'] as const
type WrittenState = (typeof STATES)[number]
const isState = (raw: unknown): raw is WrittenState => STATES.some(state => state === raw)
const STATE_LIST = `${STATES.slice(0, -1).join(', ')} or ${STATES[STATES.length - 1]}`

// The longest title, in UTF-16 units: the unit the length of a JavaScript string is, and the one /asks's bounds are counted in.
export const TITLE_MAX = 80

export const HEADING = 'Claude TODO'

// The list lives in $.state under its own key (a hot reload keeps it), and is null until it is first written in a session: that tells a list
// not written yet from an emptied one (fillTodo). The reference is declared here, with literal plugin and key, where the engine's scan of the
// state calls can read it, and every helper that takes $ is a function declaration (see shared.ts).
const TODO = { plugin: 'human-plugin', key: 'todo' } as const
const todo = atom(TODO, null as TodoItem[] | null)

// A stored list, or null when none was written. A stored entry is kept when its title is text and its state is known; its title's length is not
// re-checked, so a hand-edited list can hold a longer one.
export const normalizeTodo = (raw: unknown): TodoItem[] | null => {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((entry: unknown): TodoItem[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const { title, state } = entry as Record<string, unknown>
    return typeof title === 'string' && (state === 'queued' || state === 'in_flight') ? [{ title, state }] : []
  })
}

export async function readTodo($: EngineInterface): Promise<TodoItem[]> {
  return normalizeTodo(await read($, todo)) ?? []
}

export async function writeTodo($: EngineInterface, items: TodoItem[]): Promise<void> {
  await $.state.set(TODO, items)
}

// A rebuild fills the list only while nothing has written it in this session: a write made live is newer than any the transcript can hold.
export async function fillTodo($: EngineInterface, items: TodoItem[]): Promise<void> {
  await update($, todo, raw => normalizeTodo(raw) ?? items)
}

// A /clear: the list is written empty (session.end).
export async function emptyTodo($: EngineInterface): Promise<void> {
  await $.state.set(TODO, [])
}

// What a call gives: the whole list to store (the done entries already gone, the rest in the order given), or null for a call that gives no
// array and only reads.
export type TodoParsed = { ok: true; value: TodoItem[] | null } | { ok: false; reason: string }

const SHAPE = 'each with a title and a state'

// The model's tool input is external data: it is checked here once, and the rest of the mod sees only a list. A refusal names the entry.
export const parseTodo = (raw: unknown): TodoParsed => {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'the input must be an object' }
  const entries = (raw as Record<string, unknown>).entries
  if (entries === undefined) return { ok: true, value: null }
  if (!Array.isArray(entries)) return { ok: false, reason: `entries must be a list of entries, ${SHAPE}` }
  const kept: TodoItem[] = []
  for (let k = 0; k < entries.length; k++) {
    const at = `entry ${k + 1}`
    const entry: unknown = entries[k]
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: `${at} must be an object with a title and a state` }
    const { title: given, state } = entry as Record<string, unknown>
    if (typeof given !== 'string') return { ok: false, reason: `${at}: the title must be text` }
    const title = given.trim()
    if (title === '') return { ok: false, reason: `${at}: the title is empty` }
    if (LINE_BREAK.test(title)) return { ok: false, reason: `${at}: the title must be on one line` }
    if (title.length > TITLE_MAX) return { ok: false, reason: `${at}: the title is over ${TITLE_MAX} characters` }
    if (!isState(state)) return { ok: false, reason: `${at}: the state must be ${STATE_LIST}` }
    if (state !== 'done') kept.push({ title, state })
  }
  return { ok: true, value: kept }
}

// The order the list is drawn and printed in: in-flight entries first, then queued ones, each in written order. The stored order is the written
// one alone.
export const inDisplayOrder = (items: readonly TodoItem[]): TodoItem[] => [
  ...items.filter(it => it.state === 'in_flight'),
  ...items.filter(it => it.state === 'queued'),
]

// The glyph each state is drawn with, wherever the list is shown. A done entry is never stored, so done has none.
export const GLYPH = { in_flight: '◐', queued: '○' } as const satisfies Record<TodoItem['state'], string>

export const countsText = (items: readonly TodoItem[]): string =>
  `${items.filter(it => it.state === 'in_flight').length} in flight, ${items.filter(it => it.state === 'queued').length} queued`

// The tool's answer: one line that counts the list. A read also lists the entries in their written order, one line each with its state, so the
// agent's next write can restate the list as it was given.
export const todoReply = (items: readonly TodoItem[], isRead: boolean): string => {
  const head = `${HEADING}: ${countsText(items)}`
  return isRead && items.length > 0 ? [head, ...items.map(it => `- ${it.state}: ${it.title}`)].join('\n') : head
}

// The counts a successful call's reply opens with, as the transcript row says them.
const countsOf = (reply: string): string => {
  const head = reply.split('\n')[0] ?? ''
  return head.startsWith(`${HEADING}: `) ? `${HEADING} ${head.slice(HEADING.length + 2)}` : head
}

// The one line a call to the tool draws in the transcript, from its input and its reply, as toolLine does for the human list's tool.
export const todoLine = (call: ToolCall): string => {
  const reply = typeof call.output === 'string' ? call.output : ''
  const parsed = parseTodo(call.input)
  const text = !parsed.ok
    ? parsed.reason
    : call.isErrored
      ? reply || 'failed'
      : call.isRunning
        ? `${parsed.value === null ? 'reading' : 'writing'} the ${HEADING} list…`
        : countsOf(reply) || 'failed'
  return `human-plugin: ${text}`.replace(/\s+/g, ' ')
}

export const SUBAGENT_REFUSAL = `only the main agent keeps the ${HEADING} list`
