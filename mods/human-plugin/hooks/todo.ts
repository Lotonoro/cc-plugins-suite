import { atom, read, update, type EngineInterface } from 'claude-code'
import type { TodoItem } from '../types'
import { cutLine, oneLine, repairCut } from './cut'
import { LINE_BREAK } from './items'
import { resetCount } from './reminder'
import type { ToolCall } from './ui'

export const TODO_NAME = 'claude_todo'
export const TODO_TOOL = `mcp__human-plugin__${TODO_NAME}`

// The states an entry may be written with. `done` is accepted and never stored: a finished step leaves the list at once.
export const STATES = ['queued', 'in_flight', 'done'] as const
type WrittenState = (typeof STATES)[number]
const isState = (raw: unknown): raw is WrittenState => STATES.some(state => state === raw)
const STATE_LIST = `${STATES.slice(0, -1).join(', ')} or ${STATES[STATES.length - 1]}`

// The longest title, in UTF-16 units: the unit the length of a JavaScript string is, and the one /todo's bounds are counted in.
export const TITLE_MAX = 80

// The longest ETA, in UTF-16 units, and the text an entry holds when it is given none. An ETA is never refused: etaOf stores what it can.
export const ETA_MAX = 30
export const NO_ETA = 'no ETA'

// The ETA to store for any value a call or a stored list gives: its text trimmed and on one line, cut to ETA_MAX, and, where it ends in the ellipsis, ended at a cut point
// (repairCut), which mends an ETA an older cut stored ending on a dangling joiner, alone or followed by code points that draw nothing, before the ellipsis. A leftover that
// ends at a cut point, such as a family of three left of a family of four, cannot be told from the same text written whole and stays. NO_ETA when it is no text or blank.
// The list is normalized through this on every read, so the repair shows from the next read and is stored at the next write or rebuild.
export const etaOf = (raw: unknown): string => {
  const eta = typeof raw === 'string' ? repairCut(cutLine(raw.trim(), ETA_MAX)) : ''
  return eta === '' ? NO_ETA : eta
}

// A list's heading is a name and the fixed words after it, `<name> TODO`. A list whose agent has stated no name is headed by the plugin's own word for it, `Agent`, and the same words.
// Every view that names the list takes its heading from here (headingOf).
export const HEADING_TAIL = ' TODO'
export const HEADING = `Agent${HEADING_TAIL}`

// The heading the list is drawn, printed and answered under: the name the agent stated and the fixed words after it, or the default where it stated none or cleared it (the empty text).
export const headingOf = (name: string): string => (name === '' ? HEADING : `${name}${HEADING_TAIL}`)

// The list lives in $.state under its own key (a hot reload keeps it), and is null until it is first written in a session: that tells a list
// not written yet from an emptied one (fillTodo). The reference is declared here, with literal plugin and key, where the engine's scan of the
// state calls can read it, and every helper that takes $ is a function declaration (see shared.ts).
const TODO = { plugin: 'human-plugin', key: 'todo' } as const
const todo = atom(TODO, null as TodoItem[] | null)

// The name the agent states for the list lives under a key of its own, beside the list's: null until a call states one in a session, and the empty text once a call clears it.
// None stated and cleared both draw the default heading; the two differ only for a rebuild, which sets a name only where none was stated (fillName).
const STATED = { plugin: 'human-plugin', key: 'todoName' } as const
const stated = atom(STATED, null as string | null)

// A stored name, or null when none was stated.
const normalizeName = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null)

// A stored list, or null when none was written. A stored entry is kept when its title is text and its state is known; its title's length is not
// re-checked, so a hand-edited list can hold a longer one. Its ETA is read as a write's is, so an entry stored before the field gets NO_ETA.
export const normalizeTodo = (raw: unknown): TodoItem[] | null => {
  if (!Array.isArray(raw)) return null
  return raw.flatMap((entry: unknown): TodoItem[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const { title, state, eta } = entry as Record<string, unknown>
    return typeof title === 'string' && (state === 'queued' || state === 'in_flight') ? [{ title, state, eta: etaOf(eta) }] : []
  })
}

export async function readTodo($: EngineInterface): Promise<TodoItem[]> {
  return normalizeTodo(await read($, todo)) ?? []
}

export async function writeTodo($: EngineInterface, items: TodoItem[]): Promise<void> {
  await $.state.set(TODO, items)
  await resetCount($)
}

// A rebuild fills the list only while nothing has written it in this session: a write made live is newer than any the transcript can hold.
export async function fillTodo($: EngineInterface, items: TodoItem[]): Promise<void> {
  await update($, todo, raw => normalizeTodo(raw) ?? items)
}

// The name the heading is drawn from, as stored: the empty text where the agent has stated none or has cleared it.
export async function readName($: EngineInterface): Promise<string> {
  return normalizeName(await read($, stated)) ?? ''
}

// A call states a name, as parseTodo read it: the empty text clears it. The list is not written, so the reminder's count is not started over.
export async function writeName($: EngineInterface, name: string): Promise<void> {
  await $.state.set(STATED, name)
}

// A rebuild sets the name only while none was stated in this session: a name or a clear stated live is newer than any the transcript can hold.
export async function fillName($: EngineInterface, name: string): Promise<void> {
  await update($, stated, raw => normalizeName(raw) ?? name)
}

// A /clear: the list is written empty and the name is cleared (session.end), each attempted whichever write before it throws. The engine resets the state at a /clear, so the name
// is read as none in the next conversation either way, and the rebuild's generation check is what keeps the old conversation's name out of it (rebuild.ts). Both points that store
// the list start the reminder's count over (reminder.ts).
export async function emptyTodo($: EngineInterface): Promise<void> {
  try {
    await $.state.set(TODO, [])
    await resetCount($)
  } finally {
    await $.state.set(STATED, '')
  }
}

// What a call gives: the whole list to store (the done entries already gone, the rest in the order given), or null for a call that gives no array and only reads; and the
// name it states, or null where it states none. A name that is blank is the empty text, which clears the name.
export type TodoParsed = { ok: true; value: TodoItem[] | null; name: string | null } | { ok: false; reason: string }

const SHAPE = 'each with a title and a state'

// The model's tool input is external data: it is checked here once, and the rest of the mod sees only a list and a name. A refusal names the entry, or the name. The name is read on
// one line as an ETA is (etaOf): a line break and the blanks around it become one space and it is trimmed, the runs of spaces inside it kept. It has no bound: it is cut where it is drawn.
export const parseTodo = (raw: unknown): TodoParsed => {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'the input must be an object' }
  const { entries, name: given } = raw as Record<string, unknown>
  if (given !== undefined && typeof given !== 'string') return { ok: false, reason: 'name must be text' }
  const name = given === undefined ? null : oneLine(given.trim())
  if (entries === undefined) return { ok: true, value: null, name }
  if (!Array.isArray(entries)) return { ok: false, reason: `entries must be a list of entries, ${SHAPE}` }
  const kept: TodoItem[] = []
  for (let k = 0; k < entries.length; k++) {
    const at = `entry ${k + 1}`
    const entry: unknown = entries[k]
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: `${at} must be an object with a title and a state` }
    const { title: given, state, eta } = entry as Record<string, unknown>
    if (typeof given !== 'string') return { ok: false, reason: `${at}: the title must be text` }
    const title = given.trim()
    if (title === '') return { ok: false, reason: `${at}: the title is empty` }
    if (LINE_BREAK.test(title)) return { ok: false, reason: `${at}: the title must be on one line` }
    if (title.length > TITLE_MAX) return { ok: false, reason: `${at}: the title is over ${TITLE_MAX} characters` }
    if (!isState(state)) return { ok: false, reason: `${at}: the state must be ${STATE_LIST}` }
    if (state !== 'done') kept.push({ title, state, eta: etaOf(eta) })
  }
  return { ok: true, value: kept, name }
}

// The order the list is drawn and printed in: in-flight entries first, then queued ones, each in written order. The stored order is the written
// one alone.
export const inDisplayOrder = (items: readonly TodoItem[]): TodoItem[] => [
  ...items.filter(it => it.state === 'in_flight'),
  ...items.filter(it => it.state === 'queued'),
]

// What follows a title where a person reads the list (`/claude-todo`, and the backlog pane): a middle dot between spaces, then the entry's stored ETA. Both views take the tail from
// here, so its format is set once. The agent's own answer labels the ETA instead (todoReply), so the model does not read the separator as part of a title it restates.
const SEPARATOR = ' · '
export const etaTail = (item: TodoItem): string => `${SEPARATOR}${item.eta}`

// The glyph each state is drawn with, wherever the list is shown. A done entry is never stored, so done has none.
export const GLYPH = { in_flight: '◐', queued: '○' } as const satisfies Record<TodoItem['state'], string>

const countOf = (items: readonly TodoItem[], state: TodoItem['state']): number => items.filter(it => it.state === state).length

export const countsText = (items: readonly TodoItem[]): string => `${countOf(items, 'in_flight')} in flight, ${countOf(items, 'queued')} queued`

// The same counts in the band's short form, which names the in-flight state "active" (the column's header is too narrow for the long form).
export const bandCountsText = (items: readonly TodoItem[]): string => `${countOf(items, 'in_flight')} active, ${countOf(items, 'queued')} queued`

// The tool's answer, to a write and to a read alike: a line that counts the list under its heading (headingOf `name`), then every entry in written order with its state, its title and
// its ETA as stored, so the agent sees a default or a cut it was given and its next write can restate the list. The name is printed whole.
export const todoReply = (items: readonly TodoItem[], name = ''): string =>
  [`${headingOf(name)}: ${countsText(items)}`, ...items.map(it => `- ${it.state}: ${it.title} (ETA: ${it.eta})`)].join('\n')

// The counts a successful call's reply opens with, as the transcript row says them: the heading the reply was written under, then its counts. The split is at the
// colon right before the counts, not the first colon, so a heading that holds a colon of its own stays whole.
const COUNTED_HEAD = /^(.+): (\d+ in flight, \d+ queued)$/
const countsOf = (reply: string): string => {
  const head = reply.split('\n')[0] ?? ''
  const counted = COUNTED_HEAD.exec(head)
  return counted ? `${counted[1]} ${counted[2]}` : head
}

// The one line a call to the tool draws in the transcript, from its input and its reply, as toolLine does for the human list's tool. A running call names no heading, since the call
// that may rename the list is still running; a finished one reads the heading its answer opened with.
export const todoLine = (call: ToolCall): string => {
  const reply = typeof call.output === 'string' ? call.output : ''
  const parsed = parseTodo(call.input)
  const text = !parsed.ok
    ? parsed.reason
    : call.isErrored
      ? reply || 'failed'
      : call.isRunning
        ? `${parsed.value === null ? 'reading' : 'writing'} the list…`
        : countsOf(reply) || 'failed'
  return `human-plugin: ${text}`.replace(/\s+/g, ' ')
}

// Said to an agent, so it names the list as the steering section does, not by the heading.
export const SUBAGENT_REFUSAL = 'only the main agent keeps the Claude TODO list'
