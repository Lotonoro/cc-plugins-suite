import type { Item, TodoItem } from '../types'
import { displayColumns, unitsOf } from './columns'
import { DONE_MAX } from './items'
import { etaTail, inDisplayOrder } from './todo'

export type BandRow = { kind: 'item'; item: Item } | { kind: 'more'; blocking: number; more: number; first: Item }

// The band's order: the blocking items first, then the rest, each group in id order. `/asks` orders its groups by it too.
export const bandOrder = (a: Item, b: Item): number => Number(b.blocking) - Number(a.blocking) || a.id - b.id

const summaryOf = (folded: readonly Item[]): BandRow => {
  const blocking = folded.filter(item => item.blocking).length
  return { kind: 'more', blocking, more: folded.length - blocking, first: folded[0] as Item }
}

// The band's rows within `maxRows` lines, every row one line: the blocking items first, then the rest, each group in id order. When they do not all fit, the
// last row is the summary of what is folded: the blocking items (`blocking`) apart from the rest (`more`), and the first folded item (`first`), which the
// summary opens. That row takes the place of the last item row that would fit, so the rows never exceed `maxRows`: when none can be spared, no row draws.
export const bandRows = (items: readonly Item[], maxRows: number): BandRow[] => {
  const sorted = [...items].sort(bandOrder)
  const asRows = (list: readonly Item[]): BandRow[] => list.map((item): BandRow => ({ kind: 'item', item }))
  if (sorted.length <= maxRows) return asRows(sorted)
  if (maxRows <= 0) return []
  return [...asRows(sorted.slice(0, maxRows - 1)), summaryOf(sorted.slice(maxRows - 1))]
}

// The lines of the stacked header, the chip and the count under it: a squeezed list's, and the header of a list narrower than its chip (isChipShort).
const SQUEEZED_HEADER = 2

// The stacked header and the rows within `room` lines, header included (`humanFoldRows`): the header's lines, `top`, and the rows (`bandRows`) that fit under them.
// The header is two lines. When the room leaves no row beside both, the header gives up its count and is the chip alone on one line, so that the summary of what is folded,
// the only sign of the asks the band left out, draws in the line that frees; with no room for a row even then, the chip alone draws and no row.
export const squeezedFold = (items: readonly Item[], room: number): { top: number; rows: BandRow[] } => {
  const full = bandRows(items, Math.max(0, room - SQUEEZED_HEADER))
  return full.length > 0 ? { top: SQUEEZED_HEADER, rows: full } : { top: 1, rows: bandRows(items, Math.max(0, room - 1)) }
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
// Beside this plugin's docked pane the band is the transcript's column, and both lists draw from a narrower band: the column's 32 and a human list of 20.
const DOCKED_TWO_LIST_WIDTH = 52
// The empty column each box keeps while both lists draw.
const MARGIN = 1

const whole = (box: number): ListWidth => ({ box, layout: box })

// Whether the band draws anything: the human list when it has items, the Claude column alone when something is in flight.
export const bandDraws = (humanCount: number, todo: readonly TodoItem[]): boolean => humanCount > 0 || todo.some(isInFlight)

// The widths of the band's lists at `columns`. Beside a human list the Claude column draws when it has any item and the band is wide enough
// for both, 96 columns or 52 beside this plugin's pane docked (`isDocked`, pane.ts); alone it draws when an item is in flight, at any width. It is a third of
// the band, rounded down, never under 32 columns or wider than the band; the human list takes the rest, or all of the band when the column does not draw.
// Both lists keep their boxes' empty column (`layout` one less than `box`) only while both draw.
export const bandWidths = (columns: number, humanCount: number, todo: readonly TodoItem[], isDocked = false): BandWidths => {
  const column = Math.min(columns, Math.max(CLAUDE_MIN_WIDTH, Math.floor(columns / 3)))
  if (humanCount === 0) return { human: null, claude: todo.some(isInFlight) ? whole(column) : null }
  if (todo.length > 0 && columns >= (isDocked ? DOCKED_TWO_LIST_WIDTH : TWO_LIST_WIDTH)) {
    const human = columns - column
    return { human: { box: human, layout: human - MARGIN }, claude: { box: column, layout: column - MARGIN } }
  }
  return { human: whole(columns), claude: null }
}

// The human list's width at the undocked two-list floor, under which a human list drawn beside the Claude column is squeezed.
const SQUEEZE_UNDER = TWO_LIST_WIDTH - CLAUDE_MIN_WIDTH

// Whether the human list is squeezed: it draws beside the Claude column in a box under 64 columns, which only a band of 52 to 95 beside this plugin's docked pane has.
// A human list drawn alone is never squeezed, at any width, nor is any list from a band of 96, docked or not. A squeezed list's rows start the ladder at its third rung
// (rowLayout) and its header is stacked (squeezedFold).
export const isSqueezed = (widths: BandWidths): boolean => widths.human !== null && widths.claude !== null && widths.human.box < SQUEEZE_UNDER

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
      const units = unitsOf(word)
      units.forEach(({ text, columns: w }, c) => {
        if (used + w > width && used > 0) newRow()
        row += text
        used += w
        if (used === width && c < units.length - 1) newRow()
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

const ELLIPSIS = '…'
const ZERO_WIDTH_JOINER = '\u200d'

// A text cut at its end to `room` columns: whole when it fits, otherwise the longest start that leaves a column for the ellipsis, in whole units (a measured
// sequence is never split), and never ending on a joiner (which would join the ellipsis to what was kept), then the ellipsis. Nothing where the room has no column.
export const cutToColumns = (text: string, room: number): string => {
  if (room < 1) return ''
  const units = unitsOf(text)
  if (units.reduce((total, { columns }) => total + columns, 0) <= room) return text
  let kept = 0
  let used = 0
  // A mark that draws no column, such as a combining accent, never stops the cut, so it stays with the unit before it.
  for (const { columns } of units) {
    if (used + columns > room - 1) break
    used += columns
    kept++
  }
  while (kept > 0 && units[kept - 1]?.text.endsWith(ZERO_WIDTH_JOINER)) kept--
  return `${units.slice(0, kept).map(({ text: unit }) => unit).join('')}${ELLIPSIS}`
}

// A title cut to `room` columns with its decision's marker (` […]`, empty for a row with none): the marker stays whole after the cut title while the room
// holds it and an ellipsis, and below that the two are cut as one text.
export const cutTitle = (title: string, marker: string, room: number): string => {
  const markerColumns = displayColumns(marker)
  return marker !== '' && room > markerColumns ? `${cutToColumns(title, room - markerColumns)}${marker}` : cutToColumns(`${title}${marker}`, room)
}

// One state of a row's control as three fixed parts around an answer's text, which is the only part that varies and can be cut: `[✓ `, a label and `]` for an open
// labelled to-do; the mark, the answer and the undo button after a space for a pressed control. `answer` is empty for a control with none.
export type Control = { before: string; answer: string; after: string }

// The texts a band row is drawn from, as ui.ts's builder makes them, for the layout to measure and cut: the unread mark and the id before the title (`prefix`),
// the one-line title and the decision's marker after it, and the row's control in each state it reaches. `open` is the open control, empty for a row that draws
// none (a decision's answers are in the pane); `pressed` is the pressed control for each answer it can say, the undo button at its widest; `squeezed` is the
// pressed control with no answer, `✓ [↶ 3s]`; `sent` is the control once the press is sent.
export type RowTexts = { prefix: string; title: string; marker: string; open: Control; pressed: readonly Control[]; squeezed: string; sent: string }

// An answer's text as a row draws it: cut to the row's answer width, in a box of its measured columns or the answer width, whichever is smaller. The box can
// be a column wider than the text when a wide character would have been split.
export type Answer = { box: number; text: string }

// How a row is laid out. `rung`: 1 for the full controls, 2 with the answer texts cut, 3 with the pressed controls squeezed. `answer`: the columns an answer's
// text may take. `control`: the width of the control column, the widest state's control and the space before it, 0 for a row that draws none. `room`: the columns the
// title keeps. `title`: the title cut to the room, with its marker. `open` and `pressed`: the answer of the open control and of each pressed control, in the order of
// `RowTexts`. `drawsControl` and `drawsPrefix`: whether the row draws its control column and its prefix, which a row too narrow for them leaves out.
export type RowLayout = {
  rung: 1 | 2 | 3
  answer: number
  control: number
  room: number
  title: string
  open: Answer
  pressed: Answer[]
  drawsControl: boolean
  drawsPrefix: boolean
}

// The columns the title keeps before the control is given less.
const TITLE_MIN = 10

// The columns a backlog row's head keeps before its ETA tail is cut: the glyph, its space and the title floor. A head shorter than this keeps only its own width.
const HEAD_MIN = 2 + TITLE_MIN

// The columns of the tail's separator, read from the tail's own format.
const SEPARATOR_COLUMNS = displayColumns(etaTail({ title: '', state: 'queued', eta: '' }))

// A backlog row's ETA tail (` · ` and the ETA) cut to the room a `body`-column row leaves beside its `head`, which keeps its own width up to HEAD_MIN: whole when it fits, otherwise
// cut at its end with an ellipsis. Empty when the room keeps no character of the ETA, since a bare ellipsis or separator says nothing; the head then takes the whole body.
export const backlogTail = (head: string, tail: string, body: number): string => {
  const cut = cutToColumns(tail, Math.max(0, body - Math.min(displayColumns(head), HEAD_MIN)))
  return cut === tail || displayColumns(cut.slice(0, -ELLIPSIS.length)) > SEPARATOR_COLUMNS ? cut : ''
}

// A human row laid out in `width` columns, its list's layout width, as one line: its prefix, its title and a control column reserved at the widest of the
// row's states, so the title's room is the same in every state and a press, an undo or a window's end moves nothing. The ladder, from the first rung that leaves
// the title ten columns: the full controls, with answer texts up to DONE_MAX columns; the answer texts cut a column at a time from there down to one; then the
// same again with every pressed control squeezed to its mark and undo button, the open control keeping its (cut) label. Where no rung does, the first with the
// narrowest control, and the title takes what is left, down to one column. Where even that leaves the title no column, the row draws no control and its title takes what
// the prefix leaves; where the prefix leaves it no column, the row draws the title alone, in the whole width. The row's title still opens the item in the pane, which holds
// its controls. The reply's `✓ replied [↶ 3s]` is never cut. A row of a squeezed list (`startSqueezed`, isSqueezed) starts the ladder at its last stage, with every
// pressed control its mark and undo button.
export const rowLayout = (row: RowTexts, width: number, startSqueezed = false): RowLayout => {
  const prefix = displayColumns(row.prefix)
  const measured = (one: Control): { before: number; answer: number; after: number } => ({
    before: displayColumns(one.before),
    answer: displayColumns(one.answer),
    after: displayColumns(one.after),
  })
  const open = measured(row.open)
  const pressed = row.pressed.map(measured)
  const squeezed = displayColumns(row.squeezed)
  const sent = displayColumns(row.sent)
  const controlFor = (answer: number, marked: boolean): number => {
    const taken = (one: { before: number; answer: number; after: number }): number => one.before + Math.min(one.answer, answer) + one.after
    return 1 + Math.max(taken(open), ...(marked ? [squeezed] : pressed.map(taken)), sent)
  }
  const forms = (startSqueezed ? [true] : [false, true]).flatMap(marked => Array.from({ length: DONE_MAX }, (_, k) => ({ isSqueezed: marked, answer: DONE_MAX - k, control: controlFor(DONE_MAX - k, marked) })))
  const form = forms.find(one => width - prefix - one.control >= TITLE_MIN) ?? forms.reduce((best, one) => (one.control < best.control ? one : best))
  const drawsControl = width - prefix - form.control >= 1
  const drawsPrefix = drawsControl || width - prefix >= 1
  const control = drawsControl ? form.control : 0
  const room = Math.max(1, width - (drawsPrefix ? prefix : 0) - control)
  const fit = (text: string): Answer => ({ box: Math.min(displayColumns(text), form.answer), text: cutToColumns(text, form.answer) })
  return {
    rung: form.isSqueezed ? 3 : form.answer === DONE_MAX ? 1 : 2,
    answer: form.answer,
    control,
    room,
    title: cutTitle(row.title, row.marker, room),
    open: fit(row.open.answer),
    pressed: row.pressed.map(one => fit(one.answer)),
    drawsControl,
    drawsPrefix,
  }
}

// Whether a list that is not squeezed is narrower than its chip and one column, so its header takes the squeezed header's shape (the chip on a line of its own and the
// count under it, each cut at the list's edge) and its fold the squeezed list's (squeezedFold). `chip` is the chip's text.
export const isChipShort = (widths: BandWidths, chip: string): boolean => widths.human !== null && !isSqueezed(widths) && widths.human.layout <= displayColumns(chip)

// The lines the header takes in a list of `width` columns: one at least, more when the count, which wraps word by word in the columns the chip leaves,
// does not fit them. The chip holds its width here, which a list that fits it has; a narrower list stacks the chip over the count instead (isChipShort).
export const headerLines = (chip: string, count: string, width: number): number => wrapText(count, width - displayColumns(chip)).length
