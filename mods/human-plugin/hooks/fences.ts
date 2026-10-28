// The fenced code blocks of a brief, cut out of its prose so the pane can draw a copy button under each one. A fence is recognised
// relative to the list item it sits in, as CommonMark has it: a line opens or closes a fence when its indent is 0 to 3 columns past the
// content column of the innermost list item still open, or 0 at top level. restatement.ts keeps its own copy of the marker rule (the info
// string and the run length), which takes no account of lists; a change to that rule touches both modules.

export type BriefPart = { kind: 'prose'; text: string } | { kind: 'code'; text: string; body: string }

// A list item still open as the scan goes: its content column, the item it sits in, and the line that ends it (the line count while it runs on).
type ListItem = { content: number; parent: ListItem | null; end: number }

// A fenced block: the line its opening fence is on, the line after the block, and the line of its closing fence, null when it is unclosed (its
// item ended, or the text did). `enclosing` is the item the block sits in, null at top level; for a fence on a list marker's own line that is
// the marker's parent. `fenceColumn` is the column the opening fence starts at, which is where its body is cut.
type Block = { open: number; end: number; close: number | null; enclosing: ListItem | null; fenceColumn: number }

const OPEN = /^(`{3,}(?!.*`)|~{3,})/
const CLOSE = /^(`{3,}|~{3,})\s*$/
// A list marker: `-`, `+`, `*`, or 1 to 9 digits and then `.` or `)`, followed by whitespace or the end of the line.
const BULLET = /^([-+*]|\d{1,9}[.)])(?=[ \t]|$)/

// A tab advances to the next multiple of four columns, as CommonMark has it.
const tabStop = (col: number): number => (Math.floor(col / 4) + 1) * 4

// The column a run of spaces and tabs reaches from column `from`, and how many characters the run takes.
const run = (text: string, from: number): { col: number; chars: number } => {
  let col = from
  let chars = 0
  for (const ch of text) {
    if (ch === ' ') col += 1
    else if (ch === '\t') col = tabStop(col)
    else break
    chars++
  }
  return { col, chars }
}

// The line with up to `n` columns of leading whitespace removed. A tab the cut splits keeps its columns past the cut as spaces; whitespace
// past the cut is left as written.
const outdent = (line: string, n: number): string => {
  let col = 0
  let k = 0
  while (col < n && (line.charAt(k) === ' ' || line.charAt(k) === '\t')) {
    const stop = line.charAt(k) === '\t' ? tabStop(col) : col + 1
    if (stop > n) return ' '.repeat(stop - n) + line.slice(k + 1)
    col = stop
    k++
  }
  return line.slice(k)
}

// Whether a line, with its indent taken off, closes a block opened by `marker`: the same character, in a run at least as long.
const closes = (rest: string, marker: string): boolean => {
  const closing = CLOSE.exec(rest)?.[1] ?? ''
  return closing.charAt(0) === marker.charAt(0) && closing.length >= marker.length
}

// The block whose opening fence is on line `open`. It runs to a closing fence 0 to 3 columns past `owner`'s content column, to the line
// that ends `owner` (a non-blank line indented less than that column), or to the end of the text. A blank line never ends it. `owner` is the
// item the fence sits in, or for a fence on a list marker's own line, that marker's item; null at top level.
const blockAt = (lines: string[], open: number, marker: string, enclosing: ListItem | null, owner: ListItem | null, fenceColumn: number): Block => {
  const ownerColumn = owner?.content ?? 0
  let j = open + 1
  let close: number | null = null
  for (; j < lines.length; j++) {
    const text = (lines[j] ?? '').replace(/\r$/, '')
    const { col, chars } = run(text, 0)
    const rest = text.slice(chars)
    if (rest === '') continue
    if (col < ownerColumn) break
    if (col - ownerColumn <= 3 && closes(rest, marker)) {
      close = j
      break
    }
  }
  return { open, end: close === null ? j : j + 1, close, enclosing, fenceColumn }
}

// The fenced blocks of the text, in order. A non-blank line indented less than an open item's content column ends that item, and the line
// is then read as the start of whatever it is.
const scan = (lines: string[]): Block[] => {
  const blocks: Block[] = []
  let top: ListItem | null = null
  let i = 0
  while (i < lines.length) {
    const text = (lines[i] ?? '').replace(/\r$/, '')
    const { col, chars } = run(text, 0)
    const rest = text.slice(chars)
    if (rest === '') {
      i++
      continue
    }
    while (top !== null && top.content > col) {
      top.end = i
      top = top.parent
    }
    const enclosing = top
    const relative = col - (top?.content ?? 0)
    const fence = relative <= 3 ? OPEN.exec(rest)?.[1] : undefined
    if (fence !== undefined) {
      const block = blockAt(lines, i, fence, enclosing, enclosing, col)
      blocks.push(block)
      i = block.end
      continue
    }
    const bullet = relative <= 3 ? BULLET.exec(rest)?.[1] : undefined
    if (bullet === undefined) {
      i++
      continue
    }
    // The content column is the column after the marker and its whitespace when that is 1 to 4 columns and text follows; otherwise it is one
    // past the marker.
    const markerEnd = col + bullet.length
    const gap = run(rest.slice(bullet.length), markerEnd)
    const body = rest.slice(bullet.length + gap.chars)
    const tight = body !== '' && gap.col - markerEnd <= 4
    const item: ListItem = { content: tight ? gap.col : markerEnd + 1, parent: top, end: lines.length }
    top = item
    const onMarker = tight ? OPEN.exec(body)?.[1] : undefined
    if (onMarker !== undefined) {
      const block = blockAt(lines, i, onMarker, enclosing, item, item.content)
      blocks.push(block)
      i = block.end
      continue
    }
    i++
  }
  return blocks
}

// The column a prose line at `index` loses after `block`: the content column of the innermost item that encloses the block and is still open
// at that line, and none once none is. Prose before the first block loses none.
const cutAt = (block: Block | null, index: number): number => {
  let item = block?.enclosing ?? null
  while (item !== null && item.end <= index) item = item.parent
  return item?.content ?? 0
}

// A brief cut at its fenced code blocks, so the pane can draw a copy button under each block. A code part's `text` is the block as written, less the
// column of its item, for the drawing: markdown removes the fence's own indent as it draws the block. Its `body` is the lines inside the fences, less
// the column the fence starts at, what a copy puts on the clipboard. Prose lines after a block lose the column of the item around it (cutAt).
// Prose parts lose their blank edge lines, and a blank one is dropped.
export const briefParts = (markdown: string): BriefPart[] => {
  const lines = markdown.split('\n')
  const parts: BriefPart[] = []
  let previous: Block | null = null
  let cursor = 0
  const pushProse = (from: number, to: number): void => {
    const text = lines
      .slice(from, to)
      .map((line, k) => outdent(line, cutAt(previous, from + k)))
      .join('\n')
      .replace(/^(\s*\n)+/, '')
      .replace(/(\n\s*)+$/, '')
    if (text.trim() !== '') parts.push({ kind: 'prose', text })
  }
  for (const block of scan(lines)) {
    pushProse(cursor, block.open)
    const drawn = block.enclosing?.content ?? 0
    parts.push({
      kind: 'code',
      text: lines.slice(block.open, block.end).map(line => outdent(line, drawn)).join('\n'),
      body: lines.slice(block.open + 1, block.close ?? block.end).map(line => outdent(line, block.fenceColumn)).join('\n'),
    })
    cursor = block.end
    previous = block
  }
  pushProse(cursor, lines.length)
  return parts
}
