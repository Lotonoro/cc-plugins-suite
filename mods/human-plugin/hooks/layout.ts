import type { Item, TodoItem } from '../types'
import { displayColumns } from './items'
import { inDisplayOrder } from './todo'

export type BandRow = { kind: 'item'; item: Item } | { kind: 'more'; blocking: number; more: number; first: Item }

// The band's order: the blocking items first, then the rest, each group in id order. `/asks` orders its groups by it too.
export const bandOrder = (a: Item, b: Item): number => Number(b.blocking) - Number(a.blocking) || a.id - b.id

// The lines a row is laid out in. The human list's rows are one line each; a caller whose rows can be taller hands its own count.
const oneLine = (): number => 1

// The lines of `rows` together.
export const rowsHeight = (rows: readonly BandRow[], lines: (row: BandRow) => number = oneLine): number => rows.reduce((total, row) => total + lines(row), 0)

const summaryOf = (folded: readonly Item[]): BandRow => {
  const blocking = folded.filter(item => item.blocking).length
  return { kind: 'more', blocking, more: folded.length - blocking, first: folded[0] as Item }
}

// The band's rows within `maxRows` lines: the blocking items first, then the rest, each group in id order, each row counted by `lines`.
// When they do not all fit, the last row is the summary of what is folded: the blocking items (`blocking`) apart from the rest (`more`),
// and the first folded item (`first`), which the summary opens. That row is held back from the items and counted with them, so the rows
// never exceed `maxRows` lines: when not even the summary fits, no row draws. Each row is counted once, and each summary tried once.
export const bandRows = (items: readonly Item[], maxRows: number, lines: (row: BandRow) => number = oneLine): BandRow[] => {
  const sorted = [...items].sort(bandOrder)
  const all = sorted.map((item): BandRow => ({ kind: 'item', item }))
  // The lines of the first k rows, for each k.
  const above = [0]
  for (const row of all) above.push((above[above.length - 1] ?? 0) + lines(row))
  if ((above[all.length] ?? 0) <= maxRows) return all
  if (maxRows <= 0) return []
  for (let shown = sorted.length - 1; shown >= 0; shown--) {
    const summary = summaryOf(sorted.slice(shown))
    if ((above[shown] ?? 0) + lines(summary) <= maxRows) return [...all.slice(0, shown), summary]
  }
  return []
}

const isInFlight = (item: TodoItem): boolean => item.state === 'in_flight'

// The Claude column's lines that never fold: its header and every in-flight row.
export const columnHeight = (todo: readonly TodoItem[]): number => 1 + todo.filter(isInFlight).length

// The lines the human list folds to, header and summary row included, beside a Claude column of `columnLines` lines (its header and its
// in-flight rows). A band taller than `maxRows` is scrolled by the engine's window, which shows `maxRows` less one row (the `n more` row) at
// its top at first draw, so the list folds to that and its summary row is in view; a band that fits folds to `maxRows`.
export const humanFoldRows = (maxRows: number, columnLines: number): number => (columnLines > maxRows ? maxRows - 1 : maxRows)

// The columns the band's tree is laid out in, per list: null for a list that does not draw. `box`: the width of the list's box. `layout`: the
// columns its text is laid out and cut in, which the box's padding leaves it. While both lists draw each box keeps one column empty, the human
// list's its last and the Claude column's its first, so two blank columns separate their text; a list drawn alone is laid out in all of its box.
export type ListWidth = { box: number; layout: number }
export type BandWidths = { human: ListWidth | null; claude: ListWidth | null }

// The band's smallest width for both lists to draw (the human list keeps 64 of it), and the Claude column's narrowest width.
const TWO_LIST_WIDTH = 96
const CLAUDE_MIN_WIDTH = 32
// The empty column each box keeps while both lists draw.
const MARGIN = 1

const whole = (box: number): ListWidth => ({ box, layout: box })

// Whether the band draws anything: the human list when it has items, the Claude column alone when something is in flight.
export const bandDraws = (humanCount: number, todo: readonly TodoItem[]): boolean => humanCount > 0 || todo.some(isInFlight)

// The widths of the band's lists at `columns`. Beside a human list the Claude column draws when it has any item and the band is wide enough
// for both; alone it draws when an item is in flight, at any width. It is a third of the band, rounded down, never under 32 columns or wider
// than the band; the human list takes the rest, or all of the band when the column does not draw. Both lists keep their boxes' empty column
// (`layout` one less than `box`) only while both draw.
export const bandWidths = (columns: number, humanCount: number, todo: readonly TodoItem[]): BandWidths => {
  const column = Math.min(columns, Math.max(CLAUDE_MIN_WIDTH, Math.floor(columns / 3)))
  if (humanCount === 0) return { human: null, claude: todo.some(isInFlight) ? whole(column) : null }
  if (todo.length > 0 && columns >= TWO_LIST_WIDTH) {
    const human = columns - column
    return { human: { box: human, layout: human - MARGIN }, claude: { box: column, layout: column - MARGIN } }
  }
  return { human: whole(columns), claude: null }
}

export type ClaudeRow = { kind: 'item'; item: TodoItem } | { kind: 'queued'; count: number }

// The Claude column's rows under its header, within `height` lines (the human list's, header included; 0 beside none): every in-flight item,
// then queued items down to `height`. When the queued items do not all fit the last row is `+N queued`, held back from the items, and with one
// row left for several queued items it is the summary alone. When the header and the in-flight rows fill `height` no queued row draws.
export const claudeRows = (todo: readonly TodoItem[], height: number): ClaudeRow[] => {
  const ordered = inDisplayOrder(todo)
  const flying = ordered.filter(isInFlight)
  const queued = ordered.filter(item => !isInFlight(item))
  const room = height - columnHeight(todo)
  const rows = flying.map((item): ClaudeRow => ({ kind: 'item', item }))
  if (queued.length === 0 || room <= 0) return rows
  if (queued.length <= room) return [...rows, ...queued.map((item): ClaudeRow => ({ kind: 'item', item }))]
  return [...rows, ...queued.slice(0, room - 1).map((item): ClaudeRow => ({ kind: 'item', item })), { kind: 'queued', count: queued.length - (room - 1) }]
}

// One line of text wrapped into rows of `width` columns, as the surface wraps a Text: word by word at its spaces, a word wider than a row broken across
// rows, and the spaces kept where they fall. A full row sends the space after it to the next row, and a trailing space after a word that exactly fills a
// row takes a row of its own. A word that breaks starts on the row it follows, unless starting on the next row breaks it fewer times: the word is placed
// before the text after it is looked at.
const wrapLine = (line: string, width: number): string[] => {
  const rows: string[] = []
  let row = ''
  let used = 0
  const newRow = (): void => {
    rows.push(row)
    row = ''
    used = 0
  }
  line.split(' ').forEach((word, k) => {
    if (k > 0) {
      if (used >= width) newRow()
      row += ' '
      used++
    }
    const columns = displayColumns(word)
    if (columns > width) {
      // The breaks in the word from here (its first row has `width - used` columns) against from the start of the next row.
      if (Math.floor((columns - 1) / width) < 1 + Math.floor((columns - (width - used) - 1) / width)) newRow()
      const chars = [...word]
      chars.forEach((char, c) => {
        const w = displayColumns(char)
        if (used + w > width && used > 0) newRow()
        row += char
        used += w
        if (used === width && c < chars.length - 1) newRow()
      })
      return
    }
    if (used + columns > width && used > 0 && columns > 0) newRow()
    row += word
    used += columns
  })
  return [...rows, row]
}

// A text's rows within `width` columns (at least one), a line break starting a row of its own. A wide character is never split, so a row can be a
// column short of the width, and a character wider than the width is a row alone.
export const wrapText = (text: string, width: number): string[] => text.split(/\r?\n/).flatMap(line => wrapLine(line, Math.max(1, width)))

// The texts a band row is drawn from, as ui.ts's builder makes them, for the row layout to measure: the unread mark and the id before the title
// (`prefix`), the title, and the row's control in each state it reaches. `open` is the open control, empty for a row that draws none (a decision's
// answers are in the pane); `said` is what the pressed control says before its undo button, a text for each answer it can show; `sent` is the control
// once the press is sent.
export type RowTexts = { prefix: string; title: string; open: string; said: readonly string[]; undo: string; sent: string }

// How a row is laid out in one of its states. `place`: its control on its title's line (`beside`), or on lines of its own under the title,
// indented to the title's start (`below`). `title`: the width of the box the title is set in, the room it wraps in, when it wraps there or is
// wider than it: the room the id and the control leave it beside a control, the line past the id beside none or under it; null for a title that
// fits its room on one line, the button itself. `said`: the width of the box a pressed control's words that wrap under the title are set in,
// the room its undo button leaves them; null for words drawn bare. `widths`: the columns each line the row draws takes.
export type RowState = { place: 'beside' | 'below'; title: number | null; said: number | null; widths: number[] }

// A row's states: open; pressed, one for each text the pressed control can say, in the order of `said`; and sent.
export type RowLayout = { open: RowState; pressed: RowState[]; sent: RowState }

// The columns a title keeps beside the id and the control before the control moves below it.
const TITLE_MIN = 10

// The columns a control takes on its title's line, with the space before it; none for no control.
const besideColumns = (control: string): number => (control === '' ? 0 : 1 + displayColumns(control))

// A human row laid out in `width` columns, its list's layout width. Its control sits on its title's line when the title keeps ten columns there beside
// the id and the row's open control, the space before the control counted, whatever the title's length; otherwise it goes under the title, indented to
// the title's start, and a control wider than the line wraps there. The open control alone decides, in every list and for every state of the row, so a
// press, an undo or a window's end moves the control to no other line; the one exception is a state whose control would leave the title no column on
// its first line, as a decision's pressed option label can be as long as it likes, which is drawn under the title. In a list of 64 or more a bounded
// open control always leaves the title ten, so a row that fits its line keeps its control beside its title as it always did. A title that wraps in its
// room, or is wider than it, is set in a box of that room, so the surface wraps it where this count does and the control keeps the list's edge, and
// the words of a pressed control that wrap under the title are set in the room its undo button leaves them. Every title, label and text wraps word
// by word in what its line has left.
export const rowLayout = (row: RowTexts, width: number): RowLayout => {
  const indent = displayColumns(row.prefix)
  const line = Math.max(1, width - indent)
  const roomBeside = (control: string): number => width - indent - besideColumns(control)
  const isBeside = roomBeside(row.open) >= TITLE_MIN

  // The title wrapped in `wide` columns: its rows, and the width of the box it is set in, null when it fits there on one line.
  const titleIn = (wide: number): { rows: string[]; box: number | null } => {
    const rows = wrapText(row.title, wide)
    return { rows, box: rows.length > 1 || displayColumns(rows[0] ?? '') > wide ? wide : null }
  }
  const besideState = (control: string): RowState => {
    const taken = besideColumns(control)
    const room = Math.max(1, roomBeside(control))
    const {
      rows: [first = '', ...rest],
      box,
    } = titleIn(room)
    return {
      place: 'beside',
      title: box,
      said: null,
      widths: [indent + (box !== null && taken > 0 ? room : displayColumns(first)) + taken, ...rest.map(text => indent + displayColumns(text))],
    }
  }
  const belowState = (words: string, undo: string): RowState => {
    const { rows, box } = titleIn(line)
    const title = rows.map(text => indent + displayColumns(text))
    if (words === '') return { place: 'below', title: box, said: null, widths: title }
    const room = Math.max(1, line - displayColumns(undo))
    const [first = '', ...rest] = wrapText(words, room)
    const boxed = rest.length > 0 && undo !== ''
    return {
      place: 'below',
      title: box,
      said: boxed ? room : null,
      widths: [...title, indent + (boxed ? room : displayColumns(first)) + displayColumns(undo), ...rest.map(text => indent + displayColumns(text))],
    }
  }
  // `control`: the text on the title's line; `words` and `undo`: the text under the title and the undo button beside its first line.
  const stateFor = (control: string, words: string, undo: string): RowState => (isBeside && roomBeside(control) >= 1 ? besideState(control) : belowState(words, undo))

  return {
    open: stateFor(row.open, row.open, ''),
    pressed: row.said.map(said => stateFor(`${said}${row.undo}`, said, row.undo)),
    sent: stateFor(row.sent, row.sent, ''),
  }
}

// The lines a row takes in a list of `width` columns: its tallest state's, so a press, an undo or a window's end never changes which rows the band folds.
export const rowLines = (row: RowTexts, width: number): number => {
  const { open, pressed, sent } = rowLayout(row, width)
  return Math.max(...[open, ...pressed, sent].map(state => state.widths.length))
}

// The lines the header takes in a list of `width` columns: one at least, more when the count, which wraps word by word in the columns the chip leaves,
// does not fit them. The chip never shrinks.
export const headerLines = (chip: string, count: string, width: number): number => wrapText(count, width - displayColumns(chip)).length
