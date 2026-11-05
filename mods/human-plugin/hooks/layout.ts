import type { Item, TodoItem } from '../types'
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
// never exceed `maxRows` lines unless the summary alone is taller.
export const bandRows = (items: readonly Item[], maxRows: number, lines: (row: BandRow) => number = oneLine): BandRow[] => {
  const sorted = [...items].sort(bandOrder)
  const all = sorted.map((item): BandRow => ({ kind: 'item', item }))
  if (rowsHeight(all, lines) <= maxRows) return all
  if (maxRows <= 0) return []
  for (let shown = sorted.length - 1; shown >= 0; shown--) {
    const summary = summaryOf(sorted.slice(shown))
    if (rowsHeight(all.slice(0, shown), lines) + lines(summary) <= maxRows) return [...all.slice(0, shown), summary]
  }
  return [summaryOf(sorted)]
}

const isInFlight = (item: TodoItem): boolean => item.state === 'in_flight'

// The Claude column's lines that never fold: its header and every in-flight row.
export const columnHeight = (todo: readonly TodoItem[]): number => 1 + todo.filter(isInFlight).length

// The lines the human list folds to, header and summary row included, beside a Claude column of `columnLines` lines (its header and its
// in-flight rows). A band taller than `maxRows` is scrolled by the engine's window, which shows `maxRows` less one row (the `n more` row) at
// its top at first draw, so the list folds to that and its summary row is in view; a band that fits folds to `maxRows`.
export const humanFoldRows = (maxRows: number, columnLines: number): number => (columnLines > maxRows ? maxRows - 1 : maxRows)

// The columns the band's tree is laid out in, per list: null for a list that does not draw.
export type BandWidths = { human: number | null; claude: number | null }

// The band's smallest width for both lists to draw (the human list keeps 64 of it), and the Claude column's narrowest width.
const TWO_LIST_WIDTH = 96
const CLAUDE_MIN_WIDTH = 32

// Whether the band draws anything: the human list when it has items, the Claude column alone when something is in flight.
export const bandDraws = (humanCount: number, todo: readonly TodoItem[]): boolean => humanCount > 0 || todo.some(isInFlight)

// The widths of the band's lists at `columns`. Beside a human list the Claude column draws when it has any item and the band is wide enough
// for both; alone it draws when an item is in flight, at any width. It is a third of the band, rounded down, never under 32 columns or wider
// than the band; the human list takes the rest, or all of the band when the column does not draw.
export const bandWidths = (columns: number, humanCount: number, todo: readonly TodoItem[]): BandWidths => {
  const column = Math.min(columns, Math.max(CLAUDE_MIN_WIDTH, Math.floor(columns / 3)))
  if (humanCount === 0) return { human: null, claude: todo.some(isInFlight) ? column : null }
  return todo.length > 0 && columns >= TWO_LIST_WIDTH ? { human: columns - column, claude: column } : { human: columns, claude: null }
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
