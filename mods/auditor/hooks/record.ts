import type { Conversation } from '../types/index'

// One tool call of the worker's loops as the turn record shows it: the input and the result are clipped, so a record stays small whatever the call did.

const INPUT_CHARS = 300
const RESULT_CHARS = 500

// How many edited paths a brief lists; any more are counted, not named.
export const EDITED_PATHS_CAP = 20

// The input key that holds the path each edit tool writes (the engine's typed tool inputs: claude-code-tools/index.d.ts).
const EDIT_PATH_KEYS: ReadonlyMap<string, string> = new Map([
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
])

// The marker that states how many characters a clip cut, after the kept text.
export const cutMark = (cut: number): string => ` …+${cut} characters`

// The mod's one clipping rule: the first `max` characters, then the count cut; an uncut text carries no marker. Code points, so a cut never splits a surrogate pair.
export const clip = (text: string, max: number): string => {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}${cutMark(chars.length - max)}`
}

// `agent` is the subagent's label, already spelled (its id, and its type and name where known); absent for the main loop.
export type ToolRecord = { tool: string; input: unknown; agent?: string; text: string; isError: boolean }

// A successful edit shows its path ahead of the clipped rest of its input, so no clip cuts the path off, and `editedLines` reads the path from that layout alone. A failed edit, or one with no usable path, shows its whole input like any other call.
export const toolLine = (call: ToolRecord): string => {
  const who = call.agent === undefined ? '' : `[agent ${call.agent}] `
  const key = EDIT_PATH_KEYS.get(call.tool)
  const fields = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : undefined
  const path = key === undefined ? undefined : fields?.[key]
  if (key !== undefined && fields !== undefined && typeof path === 'string' && path !== '' && !call.isError) {
    const { [key]: _path, ...rest } = fields
    return `TOOL ${who}${call.tool}(${key}=${JSON.stringify(path)} ${clip(JSON.stringify(rest), INPUT_CHARS)}) -> ${clip(call.text, RESULT_CHARS)}`
  }
  const input = clip(JSON.stringify(call.input) ?? '', INPUT_CHARS)
  return `TOOL ${who}${call.tool}(${input}) -> ${call.isError ? 'ERROR ' : ''}${clip(call.text, RESULT_CHARS)}`
}

const EDIT_LINE = new RegExp(`^\\[\\d+\\] TOOL (?:\\[agent [^\\n]*?\\] )?(?:${[...EDIT_PATH_KEYS].map(([tool, key]) => `${tool}\\(${key}`).join('|')})=("(?:[^"\\\\\\n]|\\\\.)*") \\{`)

// The brief's line naming the paths the record edits: each path a successful Edit, Write or NotebookEdit call wrote, once, in first-edit order, at most EDITED_PATHS_CAP of them with a count of those left out. None for a record with no such call. A Bash write is not found: its paths are in shell text.
export const editedLines = (blocks: readonly string[]): string[] => {
  const paths = new Set<string>()
  for (const block of blocks) {
    const quoted = EDIT_LINE.exec(block)?.[1]
    if (quoted !== undefined) paths.add(JSON.parse(quoted) as string)
  }
  if (paths.size === 0) return []
  const left = paths.size - EDITED_PATHS_CAP
  return [`Paths the record edits, first edit first: ${[...paths].slice(0, EDITED_PATHS_CAP).map(path => JSON.stringify(path)).join(', ')}.${left > 0 ? ` ${left} more left out.` : ''}`]
}

// One entry of the turn record as a block of its own: its number, its text, then a blank line, so the next entry starts a new block.
export const entryBlock = (n: number, body: string): string => `[${n}] ${body}\n\n`

// The same entry block under number n, its number being the leading `[k] ` that entryBlock wrote.
export const renumberBlock = (block: string, n: number): string => block.replace(/^\[\d+\] /, `[${n}] `)

// Appends one entry to the record, in the order the entries happen; a switched-off reviewer records nothing, and neither does a turn a reviewer's task notification started.
export const withEntry = (c: Conversation, body: string): Conversation =>
  c.off || c.turnStart === 'notice' ? c : { ...c, record: { blocks: [...c.record.blocks, entryBlock(c.record.blocks.length + 1, body)] } }

// Whether a prompt is the user's own: typed at the terminal, sent from a Remote Control client, or a headless run's.
export const isUserKind = (kind: string): boolean => kind === 'composer' || kind === 'bridge' || kind === 'sdk'

// A prompt's entry: the user's own is labelled `USER:`, any other names its kind, since the reviewer attributes only a `USER:` line to the user.
export const promptEntry = (kind: string, text: string): string => (isUserKind(kind) ? `USER: ${text}` : `PROMPT (${kind}): ${text}`)

// The engine hands a tool result over whole only up to 50,000 characters (above it, it saves the result to a file in the user's configuration directory), so a page is at most this many UTF-8 bytes, within that limit whether the engine counts characters or bytes.
export const PAGE_BYTES = 50_000

const encoder = new TextEncoder()
const bytesOf = (text: string): number => encoder.encode(text).length

// The block cut to `room` bytes: its text kept, the characters cut counted, then its blank line. A multi-byte character the cut splits is dropped whole.
const clipBlock = (block: string, room: number): string => {
  const body = block.replace(/\n\n$/, '')
  // The mark is sized for the longest count the body could state, so the block fits whatever the count's digits.
  const reserve = bytesOf(cutMark(Array.from(body).length)) + bytesOf('\n\n')
  const head = new TextDecoder().decode(encoder.encode(body).slice(0, Math.max(0, room - reserve))).replace(/\uFFFD+$/, '')
  return `${head}${cutMark(Array.from(body).length - Array.from(head).length)}\n\n`
}

// One page: the numbers of its first and last entries, and its text, header first.
export type Page = { first: number; last: number; text: string }

// Entry blocks (block i is entry i + 1) in pages of at most `limit` bytes each, header included, every block whole in exactly one page unless it alone exceeds the limit, when it is clipped to fit.
export const splitPages = (blocks: readonly string[], header: (first: number, last: number) => string, limit: number): Page[] => {
  const pages: Page[] = []
  let first = 1
  let body: string[] = []
  let size = 0
  for (const [i, block] of blocks.entries()) {
    const n = i + 1
    if (body.length > 0 && bytesOf(header(first, n)) + size + bytesOf(block) > limit) {
      pages.push({ first, last: n - 1, text: header(first, n - 1) + body.join('') })
      first = n
      body = []
      size = 0
    }
    const room = limit - bytesOf(header(first, n))
    const kept = bytesOf(block) > room ? clipBlock(block, room) : block
    body.push(kept)
    size += bytesOf(kept)
  }
  if (body.length > 0) pages.push({ first, last: blocks.length, text: header(first, blocks.length) + body.join('') })
  return pages
}

// The first page of the entries from `from` (1-based) on, as a tool result: a header naming the list, the entries it holds and the total, then a line for the next page's `from` while entries remain. The caller checks `from` is within the entries.
export const pageOf = (title: string, blocks: readonly string[], from: number): string => {
  const total = blocks.length
  const header = (first: number, last: number): string =>
    `${title}: entries ${first}-${last} of ${total}\n${last < total ? `next page: from=${last + 1}\n` : ''}\n`
  const [page] = splitPages(blocks.slice(from - 1), (first, last) => header(first + from - 1, last + from - 1), PAGE_BYTES)
  return page?.text ?? ''
}
