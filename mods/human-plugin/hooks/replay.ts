import type { Store } from '../types'
import { PLUGIN, TOOL, EMPTY, act, parseInput, type ToolInput } from './items'

type Block = Record<string, unknown>
export type Row = Record<string, unknown>

// One transcript as read: its rows in file order (null for a complete line that is not a JSON object), and the subagent
// it belongs to (null for the main agent, which must come first).
export type Source = { rows: AsyncIterable<Row | null>; agent: string | null }

// `skipped` counts rows that could not be read, `unreadable` the subagent transcripts left out because reading them
// failed, and `known` every id the transcripts handed out, on any branch.
export type Replayed = { store: Store; skipped: number; unreadable: { agent: string; reason: string }[]; known: number[] }

type Step = { at: number; seq: number; run: (store: Store) => Store }

// A done notice names its item at the start of a line; a turn's notices are joined into one submitted prompt, so every match counts.
// A line starts after a "\n" or at the text's start, and only a "\n" ends one: the `m` flag would also end it at a carriage return or a
// Unicode separator. A reply's text is the human's own, so it may quote a marker mid-line, or after one of those characters.
const DONE = /(?:^|\n)#(\d+) is done:/g
// The answer a done notice carries, when the press was an option's, or a yes or no (see doneNotice). Line-anchored for the same reason.
const ANSWER = /(?:^|\n)The human (?:chose|answered) (.+) on #(\d+)\./g
// The reply a done notice carries, when the human typed one (see doneNotice). A reply is one line, so its text runs to the next line break, a carriage return included.
const REPLY = /(?:^|\n)The human replied on #(\d+): ([^\r\n]*)/g
// The label a labelled to-do's press carries (see doneNotice): the press's answer, the text between the quotes. The label is one line
// (items.ts collapses its whitespace), and the verb `pressed` is neither the ANSWER line's `chose` or `answered` nor REPLY's `replied`.
const PRESSED = /(?:^|\n)The human pressed "(.+)" on #(\d+)\./g
const ADDED = /added #(\d+)/

const parseRow = (line: string): Row | null => {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null
  } catch {
    // One corrupt line is one skipped row: the caller counts it and logs the count.
    return null
  }
}

// Splits the transcript's text, arriving in pieces, into rows. A line may span pieces, so a piece is only searched for
// newlines and the text after its last one waits for the next piece. The unterminated last line is the row Claude Code
// is still writing, and it is dropped.
export async function* rowsOf(pieces: AsyncIterable<string>): AsyncGenerator<Row | null> {
  let carry = ''
  for await (const piece of pieces) {
    let start = 0
    for (let nl = piece.indexOf('\n', start); nl !== -1; nl = piece.indexOf('\n', start)) {
      const line = carry + piece.slice(start, nl)
      carry = ''
      start = nl + 1
      if (line !== '') yield parseRow(line)
    }
    carry += piece.slice(start)
  }
}

const blocksOf = (row: Row): Block[] => {
  const message = row.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Row).content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

const textOf = (block: Block): string => {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return (block.content as Block[]).map(part => (typeof part.text === 'string' ? part.text : '')).join('')
}

// The time a row was written, or null when the row carries none or one that is no date (a row the list cannot place in time is skipped).
const timeOf = (row: Row): number | null => {
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
  return Number.isNaN(at) ? null : at
}

// The row a row hangs from: its parent, or for a compaction boundary (which has no parent) the last row before it.
const linkOf = (row: Row): string | null => {
  if (typeof row.parentUuid === 'string') return row.parentUuid
  return typeof row.logicalParentUuid === 'string' ? row.logicalParentUuid : null
}

// A row that opens a turn: a user row the person sees (typed, or a plugin's submitted prompt), not a tool's result.
const opensTurn = (row: Row, blocks: readonly Block[]): boolean =>
  row.type === 'user' && row.isMeta !== true && !blocks.some(block => block.type === 'tool_result')

// The subagent an Agent call's result row says it spawned.
const spawnedBy = (row: Row): string | null => {
  const record = row.toolUseResult
  if (typeof record !== 'object' || record === null) return null
  const agent = (record as Row).agentId
  return typeof agent === 'string' ? agent : null
}

type Node = { uuid: string; link: string | null; opens: boolean }

// Which of a transcript's rows the conversation still holds. The spine runs from the last row written back to the first:
// a row's link is followed when it names a row written before it, and otherwise (a row never written; a compaction's
// boundary naming a row it writes after itself) the row written just before stands in for it. A row off the spine is
// live unless the way from it back to the spine passes a row that opens a turn: that is a branch a /rewind abandoned.
// The rest of what hangs beside the spine (a parallel call's result, a note appended mid-turn) is what the model read.
export const liveRows = (nodes: readonly Node[]): ((k: number) => boolean) => {
  const position = new Map<string, number>()
  nodes.forEach((node, k) => position.set(node.uuid, position.get(node.uuid) ?? k))
  const up = (k: number): number | null => {
    const link = nodes[k]?.link ?? null
    if (link === null) return null
    const parent = position.get(link)
    if (parent !== undefined && parent < k) return parent
    return k > 0 ? k - 1 : null
  }
  const spine = new Set<number>()
  for (let k: number | null = nodes.length - 1; k !== null && k >= 0; k = up(k)) spine.add(k)
  const known = new Map<number, boolean>()
  return k => {
    const path: number[] = []
    let cur: number | null = k
    while (cur !== null && !spine.has(cur) && !known.has(cur)) {
      path.push(cur)
      cur = up(cur)
    }
    let live = cur !== null && (spine.has(cur) || known.get(cur) === true)
    for (let i = path.length - 1; i >= 0; i--) {
      const at = path[i] as number
      live = live && !(nodes[at] as Node).opens
      known.set(at, live)
    }
    return spine.has(k) || known.get(k) === true
  }
}

// Applies one of the mod's own tool results to the list as the model saw it: the reply names the id an add was given.
const applyCall = (store: Store, input: ToolInput, agent: string | null, reply: string, at: number): Store => {
  let base = store
  if (input.action === 'add') {
    const named = ADDED.exec(reply)
    if (named === null) return store
    base = { ...store, next: Number(named[1]) }
  }
  const out = act(base, input, { agent, now: at })
  return 'deny' in out ? store : out.store
}

const markDone = (store: Store, id: number, answer: string | null, replied: boolean): Store => ({
  ...store,
  items: store.items.map(it => (it.id === id && it.state === 'open' ? { ...it, state: 'done-pending' as const, answer, replied } : it)),
})

// The text of a row that may carry a done notice, or null for a row that cannot. A plugin row is the mod's own notice. A
// notice held over an interrupt reaches the conversation as the context of the human's next prompt: a hook attachment
// that names no plugin, so its text is the only thing that marks it.
const noticeText = (row: Row, blocks: Block[]): string | null => {
  const origin = row.origin as Row | undefined
  if (origin?.kind === 'plugin' && origin.name === PLUGIN) return blocks.map(block => (typeof block.text === 'string' ? block.text : '')).join('\n')
  const attachment = row.attachment as Row | undefined
  if (row.type !== 'attachment' || attachment?.type !== 'hook_additional_context' || attachment.hookName !== 'prompt.submit') return null
  return Array.isArray(attachment.content) ? attachment.content.filter((text): text is string => typeof text === 'string').join('\n') : null
}

// What one transcript holds for the list: its rows' places, the mod's own actions by row, and the subagents it spawned.
type Read = { nodes: Node[]; own: { k: number; step: Step }[]; spawns: { agent: string; k: number }[]; issued: number[]; skipped: number }

const readSource = async (source: Source, next: () => number): Promise<Read> => {
  const read: Read = { nodes: [], own: [], spawns: [], issued: [], skipped: 0 }
  const pending = new Map<string, ToolInput>()
  for await (const row of source.rows) {
    if (row === null) {
      read.skipped++
      continue
    }
    const blocks = blocksOf(row)
    // A row with no id cannot be placed on a branch, and is taken as live.
    const k = typeof row.uuid === 'string' ? read.nodes.push({ uuid: row.uuid, link: linkOf(row), opens: opensTurn(row, blocks) }) - 1 : -1
    const at = timeOf(row)
    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name === TOOL && typeof block.id === 'string') {
        const parsed = parseInput(block.input)
        // A call the mod refused as malformed never ran; its result is an error and is not replayed.
        if (parsed.ok) pending.set(block.id, parsed.value)
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const input = pending.get(block.tool_use_id)
        if (input === undefined) continue
        pending.delete(block.tool_use_id)
        // A call whose result is an error was refused or failed and changed nothing.
        if (block.is_error === true) continue
        if (at === null) {
          read.skipped++
          continue
        }
        const reply = textOf(block)
        const named = input.action === 'add' ? ADDED.exec(reply) : null
        if (named !== null) read.issued.push(Number(named[1]))
        read.own.push({ k, step: { at, seq: next(), run: store => applyCall(store, input, source.agent, reply, at) } })
      }
    }
    const spawned = spawnedBy(row)
    if (spawned !== null && k >= 0) read.spawns.push({ agent: spawned, k })
    const said = noticeText(row, blocks)
    if (said !== null) {
      if (at === null) {
        read.skipped++
        continue
      }
      const replies = new Map([...said.matchAll(REPLY)].map(m => [Number(m[1]), m[2] ?? ''] as const))
      const answers = new Map([...said.matchAll(ANSWER)].map(m => [Number(m[2]), m[1] ?? ''] as const))
      const pressed = new Map([...said.matchAll(PRESSED)].map(m => [Number(m[2]), m[1] ?? ''] as const))
      for (const done of said.matchAll(DONE)) {
        const id = Number(done[1])
        const reply = replies.get(id)
        const answer = reply ?? answers.get(id) ?? pressed.get(id) ?? null
        read.own.push({ k, step: { at, seq: next(), run: store => markDone(store, id, answer, reply !== undefined) } })
      }
    }
  }
  return read
}

// Rebuilds the list from the transcripts the mod's own tool calls and done notices are in, as the live conversation
// holds them (see liveRows). A subagent's actions count when the main transcript's Agent result that spawned it is
// live, or when no result names it. Ids go on past every id the transcripts ever handed out, rewound branches included.
export const replay = async (sources: readonly Source[]): Promise<Replayed> => {
  const steps: Step[] = []
  const known = new Set<number>()
  const unreadable: Replayed['unreadable'] = []
  let seq = 0
  let skipped = 0
  const spawnedLive = new Map<string, boolean>()
  for (const source of sources) {
    let read: Read
    try {
      read = await readSource(source, () => seq++)
    } catch (err) {
      if (source.agent === null) throw err
      unreadable.push({ agent: source.agent, reason: String(err) })
      continue
    }
    skipped += read.skipped
    for (const id of read.issued) known.add(id)
    const live = liveRows(read.nodes)
    if (source.agent === null) {
      for (const { agent, k } of read.spawns) spawnedLive.set(agent, spawnedLive.get(agent) === true || live(k))
    } else if (spawnedLive.get(source.agent) === false) {
      continue
    }
    for (const { k, step } of read.own) if (k < 0 || live(k)) steps.push(step)
  }
  steps.sort((a, b) => a.at - b.at || a.seq - b.seq)
  const replayed = steps.reduce<Store>((store, step) => step.run(store), EMPTY)
  let next = replayed.next
  for (const id of known) next = Math.max(next, id + 1)
  const store = { items: replayed.items.map(it => ({ ...it, unread: false })), next }
  return { store, skipped, unreadable, known: [...known] }
}
