import { expect, test } from 'claude-code/testing'
import { bandDraws, bandRows, bandWidths, claudeRows, humanFoldRows, rowsHeight, type ClaudeRow } from './layout'
import type { Item, TodoItem } from '../types'

const item = (id: number, blocking = false): Item => ({
  id,
  title: `t${id}`,
  detail: '',
  blocking,
  createdAt: 0,
  state: 'open',
  pressedAt: null,
  note: null,
  agent: null,
  unread: false,
  options: [],
  answer: null,
  yesno: false,
  replied: false,
  doneLabel: null,
  thread: [],
  windowTurns: [],
  windowChanged: false,
})

const ids = (rows: ReturnType<typeof bandRows>): number[] => rows.map(r => (r.kind === 'item' ? r.item.id : -1))

test('a short list draws every item, with no summary', () => {
  expect(bandRows([item(1), item(2), item(3)], 5)).toEqual([
    { kind: 'item', item: item(1) },
    { kind: 'item', item: item(2) },
    { kind: 'item', item: item(3) },
  ])
})

test('blocking items come first, then the rest, each group in id order, one row each', () => {
  expect(ids(bandRows([item(1), item(2, true), item(3, true), item(4)], 5))).toEqual([2, 3, 1, 4])
})

test('a list exactly filling the rows has no summary', () => {
  expect(bandRows([item(1, true), item(2)], 2)).toEqual([
    { kind: 'item', item: item(1, true) },
    { kind: 'item', item: item(2) },
  ])
  expect(bandRows([item(1), item(2), item(3)], 3)).toEqual([
    { kind: 'item', item: item(1) },
    { kind: 'item', item: item(2) },
    { kind: 'item', item: item(3) },
  ])
})

test('when the rows run out, the last row summarises what is folded, counting blocking and non-blocking apart, and names the first folded item', () => {
  const mixed = [item(1), item(2, true), item(3, true), item(4), item(5, true), item(6)]
  expect(bandRows(mixed, 3)).toEqual([
    { kind: 'item', item: item(2, true) },
    { kind: 'item', item: item(3, true) },
    { kind: 'more', blocking: 1, more: 3, first: item(5, true) },
  ])
  const blocking = [1, 2, 3, 4, 5].map(id => item(id, true))
  expect(bandRows(blocking, 3)).toEqual([
    { kind: 'item', item: blocking[0] as Item },
    { kind: 'item', item: blocking[1] as Item },
    { kind: 'more', blocking: 3, more: 0, first: blocking[2] as Item },
  ])
  const crowded = [1, 2, 3, 4, 5, 6].map(id => item(id, id <= 4))
  expect(bandRows(crowded, 3)).toEqual([
    { kind: 'item', item: crowded[0] as Item },
    { kind: 'item', item: crowded[1] as Item },
    { kind: 'more', blocking: 2, more: 2, first: crowded[2] as Item },
  ])
})

test('with one row the summary takes it, and a single item that fits takes it as an item', () => {
  expect(bandRows([item(1, true), item(2)], 1)).toEqual([{ kind: 'more', blocking: 1, more: 1, first: item(1, true) }])
  expect(bandRows([item(1), item(2), item(3)], 1)).toEqual([{ kind: 'more', blocking: 0, more: 3, first: item(1) }])
  expect(bandRows([item(1)], 1)).toEqual([{ kind: 'item', item: item(1) }])
})

test('a band never exceeds the rows it is given, and no list or no row draws nothing', () => {
  expect(bandRows([item(1, true)], 0)).toEqual([])
  expect(bandRows([item(1)], 0)).toEqual([])
  expect(bandRows([], 5)).toEqual([])
  expect(bandRows([], 0)).toEqual([])
})

test('the fold counts each row by the lines it is given, the summary row included, and the summary takes the last of the rows', () => {
  const sorted = [item(1, true), item(2, true), item(3), item(4)]
  const tall = (row: ReturnType<typeof bandRows>[number]) => (row.kind === 'item' && row.item.id === 2 ? 2 : 1)
  // Items 1 and 2 take 1 + 2 lines and the summary one: 4 lines fill 4 rows.
  expect(bandRows(sorted, 4, tall)).toEqual([
    { kind: 'item', item: item(1, true) },
    { kind: 'item', item: item(2, true) },
    { kind: 'more', blocking: 0, more: 2, first: item(3) },
  ])
  // With 3 rows the tall item no longer fits beside a summary, so it folds and counts as blocking.
  expect(bandRows(sorted, 3, tall)).toEqual([
    { kind: 'item', item: item(1, true) },
    { kind: 'more', blocking: 1, more: 2, first: item(2, true) },
  ])
  // Every item laid out at once needs 5 lines; 5 rows draw them all with no summary.
  expect(bandRows(sorted, 5, tall).every(row => row.kind === 'item')).toBe(true)
  expect(rowsHeight(bandRows(sorted, 4, tall), tall)).toBe(4)
})

test('a summary taller than the rows still draws alone, and no rows draw nothing', () => {
  const tall = () => 3
  expect(bandRows([item(1), item(2)], 2, tall)).toEqual([{ kind: 'more', blocking: 0, more: 2, first: item(1) }])
  expect(bandRows([item(1), item(2)], 0, tall)).toEqual([])
})

test('a band over its rows folds the human list to the rows the engine\'s window shows, one fewer; a band that fits folds to its rows', () => {
  expect(humanFoldRows(10, 0)).toBe(10)
  expect(humanFoldRows(10, 10)).toBe(10)
  expect(humanFoldRows(10, 11)).toBe(9)
  expect(humanFoldRows(10, 31)).toBe(9)
})

const todoItem = (title: string, state: TodoItem['state']): TodoItem => ({ title, state })
const flying = (n: number): TodoItem[] => Array.from({ length: n }, (_, k) => todoItem(`f${k + 1}`, 'in_flight'))
const waiting = (n: number): TodoItem[] => Array.from({ length: n }, (_, k) => todoItem(`q${k + 1}`, 'queued'))
const titles = (rows: ClaudeRow[]): string[] => rows.map(r => (r.kind === 'item' ? r.item.title : `+${r.count} queued`))

test('the width rule gives the column a third of the band, rounded down, never under 32, and the human list the rest', () => {
  expect(bandWidths(96, 2, waiting(1))).toEqual({ human: 64, claude: 32 })
  expect(bandWidths(120, 2, waiting(1))).toEqual({ human: 80, claude: 40 })
  expect(bandWidths(155, 2, waiting(1))).toEqual({ human: 104, claude: 51 })
})

test('under 96 columns the column hides and the human list keeps the full width', () => {
  expect(bandWidths(95, 2, waiting(1))).toEqual({ human: 95, claude: null })
  expect(bandWidths(40, 2, flying(1))).toEqual({ human: 40, claude: null })
})

test('human items and no Claude items: the human list alone at full width, at any width', () => {
  expect(bandWidths(120, 2, [])).toEqual({ human: 120, claude: null })
  expect(bandWidths(90, 2, [])).toEqual({ human: 90, claude: null })
  expect(bandWidths(300, 2, [])).toEqual({ human: 300, claude: null })
})

test('no human items: an item in flight draws the column alone at its width, however narrow the band, and queued items alone draw nothing', () => {
  expect(bandWidths(40, 0, flying(1))).toEqual({ human: null, claude: 32 })
  expect(bandWidths(120, 0, [...waiting(2), ...flying(1)])).toEqual({ human: null, claude: 40 })
  expect(bandWidths(20, 0, flying(1))).toEqual({ human: null, claude: 20 })
  expect(bandWidths(120, 0, waiting(2))).toEqual({ human: null, claude: null })
  expect(bandWidths(120, 0, [])).toEqual({ human: null, claude: null })
})

test('the band draws when a human item exists or a Claude item is in flight, and hands on otherwise', () => {
  expect(bandDraws(0, [])).toBe(false)
  expect(bandDraws(0, waiting(3))).toBe(false)
  expect(bandDraws(0, flying(1))).toBe(true)
  expect(bandDraws(1, [])).toBe(true)
})

test('the column fills the human list\'s height after its header and every in-flight row: queued rows, the last a summary when they do not all fit', () => {
  const todo = [...waiting(3), ...flying(2)]
  // Height 7: header, 2 in flight, then 4 rows left for 3 queued items, which all fit.
  expect(titles(claudeRows(todo, 7))).toEqual(['f1', 'f2', 'q1', 'q2', 'q3'])
  // Height 5: 2 rows left for 3 queued, so one item and the summary of the other two.
  expect(titles(claudeRows(todo, 5))).toEqual(['f1', 'f2', 'q1', '+2 queued'])
  // Height 4: one row left for several queued items, which is the summary alone.
  expect(titles(claudeRows(todo, 4))).toEqual(['f1', 'f2', '+3 queued'])
  // One row left for one queued item: the item itself.
  expect(titles(claudeRows([...waiting(1), ...flying(2)], 4))).toEqual(['f1', 'f2', 'q1'])
})

test('with the header and the in-flight rows filling the height, or over it, no queued row and no summary draws; every in-flight row stays', () => {
  expect(titles(claudeRows([...waiting(2), ...flying(2)], 3))).toEqual(['f1', 'f2'])
  expect(titles(claudeRows([...waiting(2), ...flying(12)], 5))).toEqual(flying(12).map(it => it.title))
  expect(titles(claudeRows([...waiting(2), ...flying(2)], 0))).toEqual(['f1', 'f2'])
})

test('beside one human item the column is its header and one summary row for three queued items', () => {
  // The human list's height is its header and one row.
  expect(titles(claudeRows(waiting(3), 2))).toEqual(['+3 queued'])
})

test('queued only: the column fills the human list\'s height with queued rows, in written order', () => {
  expect(titles(claudeRows(waiting(2), 6))).toEqual(['q1', 'q2'])
  expect(titles(claudeRows(waiting(5), 4))).toEqual(['q1', 'q2', '+3 queued'])
})

test('the in-flight rows come first and each group keeps its written order', () => {
  const mixed = [todoItem('q1', 'queued'), todoItem('f1', 'in_flight'), todoItem('q2', 'queued'), todoItem('f2', 'in_flight')]
  expect(titles(claudeRows(mixed, 10))).toEqual(['f1', 'f2', 'q1', 'q2'])
})

test('an empty Claude list has no rows', () => {
  expect(claudeRows([], 10)).toEqual([])
})
