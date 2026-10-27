// One tool call of the worker's loops as the turn record shows it: the input and the result are clipped, so a record stays small whatever the call did.

const INPUT_CHARS = 300
const RESULT_CHARS = 500

// The marker that states how many characters a clip cut, after the kept text.
export const cutMark = (cut: number): string => ` …+${cut} characters`

// The mod's one clipping rule: the first `max` characters, then the count cut; an uncut text carries no marker. Code points, so a cut never splits a surrogate pair.
export const clip = (text: string, max: number): string => {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}${cutMark(chars.length - max)}`
}

// `agent` is the subagent's label, already spelled (its id, and its type and name where known); absent for the main loop.
export type ToolRecord = { tool: string; input: unknown; agent?: string; text: string; isError: boolean }

export const toolLine = (call: ToolRecord): string => {
  const who = call.agent === undefined ? '' : `[agent ${call.agent}] `
  const input = clip(JSON.stringify(call.input) ?? '', INPUT_CHARS)
  return `TOOL ${who}${call.tool}(${input}) -> ${call.isError ? 'ERROR ' : ''}${clip(call.text, RESULT_CHARS)}`
}

// One entry of the turn record as a block of its own: its number, its text, then a blank line, so the next entry starts a new block.
export const entryBlock = (n: number, body: string): string => `[${n}] ${body}\n\n`

// The same entry block under number n, its number being the leading `[k] ` that entryBlock wrote.
export const renumberBlock = (block: string, n: number): string => block.replace(/^\[\d+\] /, `[${n}] `)

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
