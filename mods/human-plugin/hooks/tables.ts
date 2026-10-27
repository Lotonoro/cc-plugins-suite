// A GitHub-flavoured markdown table, drawn as a list: the side pane is narrow and a table overflows it. Every other byte stays as it was.

type Table = { headers: string[]; rows: string[][]; end: number }

// An opening fence, at most three spaces in, whose backtick info string holds no backtick (so ```x``` is no fence). The closing one
// repeats the opening marker's character, at least as long (closesFence). Exported for restatement.ts, which skips fenced code the same way.
export const FENCE = /^ {0,3}(`{3,}(?!.*`)|~{3,})/
const CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const DELIMITER_CELL = /^:?-+:?$/
// Four spaces or a tab: an indented code block, which holds no table.
const INDENTED = /^( {4}|\t)/

export const closesFence = (line: string, opening: string): boolean => {
  const marker = CLOSE.exec(line)?.[1] ?? ''
  return marker !== '' && marker.charAt(0) === opening.charAt(0) && marker.length >= opening.length
}

// A row's cells: a pipe splits them unless escaped, and the optional leading and trailing pipes are no cells.
const splitRow = (line: string): string[] => {
  const text = line.trim()
  const pieces: string[] = []
  let cell = ''
  for (let k = 0; k < text.length; k++) {
    const ch = text.charAt(k)
    if (ch === '\\' && text.charAt(k + 1) === '|') {
      cell += '|'
      k++
    } else if (ch === '|') {
      pieces.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  pieces.push(cell)
  if (text.startsWith('|')) pieces.shift()
  if (pieces[pieces.length - 1] === '') pieces.pop()
  return pieces.map(piece => piece.trim())
}

// The table that starts at `start`, if one does: a header row with a pipe, a delimiter row of as many cells, then the body rows
// up to a blank line, a fence, or a line with no pipe, which is prose and is left as it is.
const tableAt = (lines: string[], start: number): Table | null => {
  const header = lines[start] ?? ''
  const delimiter = lines[start + 1]
  if (delimiter === undefined || INDENTED.test(header) || INDENTED.test(delimiter)) return null
  if (!header.includes('|') || !delimiter.includes('|')) return null
  const headers = splitRow(header)
  const cells = splitRow(delimiter)
  if (headers.length === 0 || cells.length !== headers.length || !cells.every(cell => DELIMITER_CELL.test(cell))) return null
  const rows: string[][] = []
  let end = start + 2
  let row = lines[end]
  while (row !== undefined && row.includes('|') && !FENCE.test(row)) {
    rows.push(splitRow(row))
    end++
    row = lines[end]
  }
  return { headers, rows, end }
}

// The list a table becomes: a header-only table is one bullet of its headers; each body row is a bullet, its first cell bold, then
// its other cells as `header: cell`, joined by `; `. A cell past the headers, or under an empty header, is drawn bare.
const listOf = ({ headers, rows }: Table): string[] => {
  if (rows.length === 0) return [`- ${headers.filter(header => header !== '').join('; ')}`]
  return rows.map(([first = '', ...rest]) => {
    const others = rest
      .map((cell, k) => ({ cell, header: headers[k + 1] }))
      .filter(({ cell }) => cell !== '')
      .map(({ cell, header }) => (header ? `${header}: ${cell}` : cell))
      .join('; ')
    const lead = first === '' ? '' : `**${first}**`
    return `- ${[lead, others].filter(part => part !== '').join(': ')}`.trimEnd()
  })
}

export const tablesAsLists = (markdown: string): string => {
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | null = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null
      out.push(line)
      i++
      continue
    }
    const opening = FENCE.exec(line)?.[1]
    if (opening !== undefined) {
      fence = opening
      out.push(line)
      i++
      continue
    }
    const table = tableAt(lines, i)
    if (table === null) {
      out.push(line)
      i++
      continue
    }
    if ((out[out.length - 1] ?? '').trim() !== '') out.push('')
    out.push(...listOf(table))
    i = table.end
    if (i < lines.length && (lines[i] ?? '').trim() !== '') out.push('')
  }
  return out.join('\n')
}

// A brief cut at its fenced code blocks, so the pane can draw a copy button under each block. A code part's `text` is the block as
// written, fences included, for the drawing; its `body` is the lines inside the fences, less the fence's indent, what a copy puts on the clipboard. A fence
// left open runs to the end, as markdown draws it. Prose parts lose their blank edge lines, and a blank one is dropped.
export type BriefPart = { kind: 'prose'; text: string } | { kind: 'code'; text: string; body: string }

export const briefParts = (markdown: string): BriefPart[] => {
  const parts: BriefPart[] = []
  const pushProse = (lines: string[]): void => {
    const text = lines.join('\n').replace(/^(\s*\n)+/, '').replace(/(\n\s*)+$/, '')
    if (text.trim() !== '') parts.push({ kind: 'prose', text })
  }
  const lines = markdown.split('\n')
  let prose: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const opening = FENCE.exec(line)?.[1]
    if (opening === undefined) {
      prose.push(line)
      i++
      continue
    }
    pushProse(prose)
    prose = []
    let end = i + 1
    while (end < lines.length && !closesFence(lines[end] ?? '', opening)) end++
    const closed = end < lines.length
    // A fence indented n spaces (at most three, as FENCE has it) takes up to n spaces off each line inside it, as markdown draws the block.
    const indent = line.length - line.trimStart().length
    const outdent = new RegExp(`^ {0,${indent}}`)
    const body = lines.slice(i + 1, end).map(inner => inner.replace(outdent, ''))
    parts.push({ kind: 'code', text: lines.slice(i, closed ? end + 1 : end).join('\n'), body: body.join('\n') })
    i = closed ? end + 1 : end
  }
  pushProse(prose)
  return parts
}
