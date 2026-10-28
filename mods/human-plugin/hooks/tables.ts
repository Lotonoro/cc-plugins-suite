// A GitHub-flavoured markdown table, drawn as a list: the side pane is narrow and a table overflows it. Every other byte stays as it was.

type Table = { headers: string[]; rows: string[][]; end: number }

const DELIMITER_CELL = /^:?-+:?$/
// Four spaces or a tab: an indented code block, which holds no table.
const INDENTED = /^( {4}|\t)/

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
// up to a blank line or a line with no pipe, which is prose and is left as it is.
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
  while (row !== undefined && row.includes('|')) {
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

// The prose of a brief, its tables drawn as lists. Its input has no recognised fenced code: fences.ts cuts the blocks out before this sees the text.
export const tablesAsLists = (markdown: string): string => {
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
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
