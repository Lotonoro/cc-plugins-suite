import { expect, test } from 'claude-code/testing'
import { backlogTail, bandDraws, bandRows, bandWidths, claudeRows, columnHeader, cutTitle, cutToColumns, foldCount, headerLines, humanFoldRows, isChipShort, isSqueezed, rowLayout, squeezedFold, wrapText, type BandWidths, type ClaudeRow, type Control, type RowTexts } from './layout'
import { displayColumns, unitsOf } from './columns'
import { endsJoining } from './joining-oracle'
import { SEQUENCES } from './sequences'
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

test('a row is one line, so the fold draws every item when they fit and otherwise one fewer than the rows given with the summary of the rest as the last, for any number of items and rows', () => {
  for (let count = 0; count <= 14; count++) {
    const items = Array.from({ length: count }, (_, k) => item(k + 1, k % 3 === 0))
    const order = [...items.filter(it => it.blocking), ...items.filter(it => !it.blocking)]
    const asRows = (list: Item[]) => list.map((it): ReturnType<typeof bandRows>[number] => ({ kind: 'item', item: it }))
    for (let rows = 0; rows <= 16; rows++) {
      const where = `${count} items in ${rows} rows`
      const drawn = bandRows(items, rows)
      expect(drawn.length, where).toBeLessThanOrEqual(rows)
      if (count <= rows) {
        expect(drawn, where).toEqual(asRows(order))
      } else if (rows === 0) {
        expect(drawn, where).toEqual([])
      } else {
        const folded = order.slice(rows - 1)
        expect(drawn, where).toEqual([
          ...asRows(order.slice(0, rows - 1)),
          { kind: 'more', blocking: folded.filter(it => it.blocking).length, more: folded.filter(it => !it.blocking).length, first: folded[0] as Item },
        ])
      }
    }
  }
})

test('a band over its rows folds the human list to the rows the engine\'s window shows, one fewer; a band that fits folds to its rows', () => {
  expect(humanFoldRows(10, 0)).toBe(10)
  expect(humanFoldRows(10, 10)).toBe(10)
  expect(humanFoldRows(10, 11)).toBe(9)
  expect(humanFoldRows(10, 31)).toBe(9)
})

const todoItem = (title: string, state: TodoItem['state']): TodoItem => ({ title, state, eta: 'no ETA' })
const flying = (n: number): TodoItem[] => Array.from({ length: n }, (_, k) => todoItem(`f${k + 1}`, 'in_flight'))
const waiting = (n: number): TodoItem[] => Array.from({ length: n }, (_, k) => todoItem(`q${k + 1}`, 'queued'))
const titles = (rows: ClaudeRow[]): string[] => rows.map(r => (r.kind === 'item' ? r.item.title : `+${r.count} queued`))

test('the width rule gives the column half the band, rounded down, but no wider than the band less 64 and never under 32, and the human list the rest; each list\'s layout width is one column short of its box while both draw', () => {
  expect(bandWidths(96, 2, waiting(1))).toEqual({ human: { box: 64, layout: 63 }, claude: { box: 32, layout: 31 } })
  expect(bandWidths(100, 2, waiting(1))).toEqual({ human: { box: 64, layout: 63 }, claude: { box: 36, layout: 35 } })
  expect(bandWidths(120, 2, waiting(1))).toEqual({ human: { box: 64, layout: 63 }, claude: { box: 56, layout: 55 } })
  expect(bandWidths(128, 2, waiting(1))).toEqual({ human: { box: 64, layout: 63 }, claude: { box: 64, layout: 63 } })
  expect(bandWidths(139, 2, waiting(1))).toEqual({ human: { box: 70, layout: 69 }, claude: { box: 69, layout: 68 } })
  expect(bandWidths(155, 2, waiting(1))).toEqual({ human: { box: 78, layout: 77 }, claude: { box: 77, layout: 76 } })
  expect(bandWidths(200, 2, waiting(1))).toEqual({ human: { box: 100, layout: 99 }, claude: { box: 100, layout: 99 } })
  expect(bandWidths(300, 2, waiting(1))).toEqual({ human: { box: 150, layout: 149 }, claude: { box: 150, layout: 149 } })
})

test('under 96 columns the column hides and the human list keeps the full width, laid out in all of it', () => {
  expect(bandWidths(95, 2, waiting(1))).toEqual({ human: { box: 95, layout: 95 }, claude: null })
  expect(bandWidths(40, 2, flying(1))).toEqual({ human: { box: 40, layout: 40 }, claude: null })
})

test('human items and no Claude items: the human list alone at full width, at any width, laid out in all of it', () => {
  expect(bandWidths(120, 2, [])).toEqual({ human: { box: 120, layout: 120 }, claude: null })
  expect(bandWidths(90, 2, [])).toEqual({ human: { box: 90, layout: 90 }, claude: null })
  expect(bandWidths(300, 2, [])).toEqual({ human: { box: 300, layout: 300 }, claude: null })
})

test('no human items: a step in the agent\'s list, in flight or queued, draws the column alone at its width, however narrow the band, laid out in all of it, and an empty list draws nothing', () => {
  expect(bandWidths(40, 0, flying(1))).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(120, 0, [...waiting(2), ...flying(1)])).toEqual({ human: null, claude: { box: 56, layout: 56 } })
  expect(bandWidths(20, 0, flying(1))).toEqual({ human: null, claude: { box: 20, layout: 20 } })
  expect(bandWidths(120, 0, waiting(2))).toEqual({ human: null, claude: { box: 56, layout: 56 } })
  expect(bandWidths(40, 0, waiting(1))).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(12, 0, waiting(1))).toEqual({ human: null, claude: { box: 12, layout: 12 } })
  expect(bandWidths(120, 0, [])).toEqual({ human: null, claude: null })
})

test('the margin is one column off each box while both lists draw and none otherwise; the box widths sum to the band, the column is half of it capped to leave the human list 64 and at least 32, and both lists draw from 96', () => {
  const todos: [string, TodoItem[]][] = [['none', []], ['queued', waiting(2)], ['in flight', flying(2)], ['both', [...flying(1), ...waiting(1)]]]
  for (const [name, todo] of todos) {
    for (const humans of [0, 2]) {
      for (let columns = 1; columns <= 300; columns++) {
        const { human, claude } = bandWidths(columns, humans, todo)
        const where = `${name}, ${humans} human, ${columns} columns`
        if (human !== null && claude !== null) {
          // Both lists: the box widths sum to the band, the column is half the band rounded down but no wider than the band less 64, and at least 32, and the human list keeps at least 64.
          expect(human.box + claude.box, where).toBe(columns)
          expect(claude.box, where).toBe(Math.max(32, Math.min(Math.floor(columns / 2), columns - 64)))
          expect(human.box, where).toBeGreaterThanOrEqual(64)
          expect(columns, where).toBeGreaterThanOrEqual(96)
          expect([human.layout, claude.layout], where).toEqual([human.box - 1, claude.box - 1])
        } else {
          // One list or none: laid out in its whole box.
          for (const list of [human, claude]) expect(list === null || list.layout === list.box, where).toBe(true)
        }
      }
    }
  }
  // Both lists draw from 96 and not from 95.
  expect(bandWidths(96, 2, waiting(1)).claude).not.toBeNull()
  expect(bandWidths(95, 2, waiting(1)).claude).toBeNull()
})

test('beside this plugin\'s docked pane both lists draw from 52 columns: the column\'s 32 and a human list of 20, each laid out one column short of its box', () => {
  expect(bandWidths(52, 2, waiting(1), true)).toEqual({ human: { box: 20, layout: 19 }, claude: { box: 32, layout: 31 } })
  expect(bandWidths(56, 2, flying(1), true)).toEqual({ human: { box: 24, layout: 23 }, claude: { box: 32, layout: 31 } })
  expect(bandWidths(51, 2, waiting(1), true)).toEqual({ human: { box: 51, layout: 51 }, claude: null })
  // With the pane not docked the 96 rule holds.
  expect(bandWidths(60, 2, waiting(1))).toEqual({ human: { box: 60, layout: 60 }, claude: null })
  expect(bandWidths(60, 2, waiting(1), false)).toEqual({ human: { box: 60, layout: 60 }, claude: null })
})

test('beside the docked pane the other rows of the width rule hold: no Claude items leave the human list full width, no human items leave the column alone at its width, queued steps alone included', () => {
  expect(bandWidths(52, 2, [], true)).toEqual({ human: { box: 52, layout: 52 }, claude: null })
  expect(bandWidths(52, 0, flying(1), true)).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(51, 0, flying(1), true)).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(52, 0, waiting(2), true)).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(51, 0, waiting(2), true)).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(52, 0, [], true)).toEqual({ human: null, claude: null })
})

test('beside the docked pane, at every width from 1 to 300, both lists draw from 52 with the box widths summing to the band, the column half the band rounded down but no wider than the band less 64 and at least 32, the human list at least 20, and each list laid out one column short of its box', () => {
  const todos: [string, TodoItem[]][] = [['none', []], ['queued', waiting(2)], ['in flight', flying(2)], ['both', [...flying(1), ...waiting(1)]]]
  for (const [name, todo] of todos) {
    for (const humans of [0, 2]) {
      for (let columns = 1; columns <= 300; columns++) {
        const { human, claude } = bandWidths(columns, humans, todo, true)
        const where = `${name}, ${humans} human, ${columns} columns`
        if (human !== null && claude !== null) {
          expect(columns, where).toBeGreaterThanOrEqual(52)
          expect(human.box + claude.box, where).toBe(columns)
          expect(claude.box, where).toBe(Math.max(32, Math.min(Math.floor(columns / 2), columns - 64)))
          expect(human.box, where).toBeGreaterThanOrEqual(20)
          expect([human.layout, claude.layout], where).toEqual([human.box - 1, claude.box - 1])
        } else {
          for (const list of [human, claude]) expect(list === null || list.layout === list.box, where).toBe(true)
          // Two lists wanted and the band wide enough: both draw.
          expect(humans > 0 && todo.length > 0 && columns >= 52, where).toBe(false)
        }
      }
    }
  }
  expect(bandWidths(52, 2, waiting(1), true).claude).not.toBeNull()
  expect(bandWidths(51, 2, waiting(1), true).claude).toBeNull()
})

test('from 96 columns the docked width rule is the undocked one', () => {
  for (let columns = 96; columns <= 300; columns++) for (const todo of [[], waiting(1), flying(2)]) expect(bandWidths(columns, 2, todo, true), `${columns}`).toEqual(bandWidths(columns, 2, todo))
})

test('a human list is squeezed when it is drawn beside the Claude column under 64 columns wide, and never alone', () => {
  for (let columns = 52; columns <= 95; columns++) expect(isSqueezed(bandWidths(columns, 2, waiting(1), true)), `${columns}`).toBe(true)
  for (let columns = 96; columns <= 200; columns++) expect(isSqueezed(bandWidths(columns, 2, waiting(1), true)), `${columns}`).toBe(false)
  for (let columns = 1; columns <= 200; columns++) {
    expect(isSqueezed(bandWidths(columns, 2, [])), `${columns}, no column`).toBe(false)
    expect(isSqueezed(bandWidths(columns, 2, [], true)), `${columns}, no column, docked`).toBe(false)
    expect(isSqueezed(bandWidths(columns, 2, waiting(1))), `${columns}, undocked`).toBe(false)
    expect(isSqueezed(bandWidths(columns, 0, flying(1), true)), `${columns}, column alone`).toBe(false)
  }
})

test('the band draws when a human item exists or the Claude list has a step, queued or in flight, and hands on otherwise', () => {
  expect(bandDraws(0, [])).toBe(false)
  expect(bandDraws(0, waiting(3))).toBe(true)
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

test('with the header and the in-flight rows filling the height, or over it, the rows end with the queued line, after every in-flight row: the summary for several queued items and the item for one', () => {
  expect(titles(claudeRows([...waiting(2), ...flying(2)], 3))).toEqual(['f1', 'f2', '+2 queued'])
  expect(titles(claudeRows([...waiting(2), ...flying(12)], 5))).toEqual([...flying(12).map(it => it.title), '+2 queued'])
  expect(titles(claudeRows([...waiting(2), ...flying(2)], 0))).toEqual(['f1', 'f2', '+2 queued'])
  expect(titles(claudeRows([...waiting(1), ...flying(2)], 3))).toEqual(['f1', 'f2', 'q1'])
  expect(titles(claudeRows([...waiting(1), ...flying(2)], 0))).toEqual(['f1', 'f2', 'q1'])
})

test('a column with no queued item draws no queued line, at any height', () => {
  for (const height of [0, 1, 3, 9]) expect(titles(claudeRows(flying(2), height)), `${height}`).toEqual(['f1', 'f2'])
})

test('beside one human item the column is its header and one summary row for three queued items', () => {
  // The human list's height is its header and one row.
  expect(titles(claudeRows(waiting(3), 2))).toEqual(['+3 queued'])
})

test('queued only: the column fills the human list\'s height with queued rows, in written order', () => {
  expect(titles(claudeRows(waiting(2), 6))).toEqual(['q1', 'q2'])
  expect(titles(claudeRows(waiting(5), 4))).toEqual(['q1', 'q2', '+3 queued'])
})

test('queued only, drawn alone at height 0: the one line the queued steps keep is the item for one queued step and the summary for several', () => {
  expect(titles(claudeRows(waiting(1), 0))).toEqual(['q1'])
  expect(titles(claudeRows(waiting(3), 0))).toEqual(['+3 queued'])
})

test('with no press in the header the last queued row is always +N queued, a lone queued step included, after the queued rows that the room holds; with a press the lone step is its row', () => {
  expect(titles(claudeRows(waiting(1), 0, false))).toEqual(['+1 queued'])
  expect(titles(claudeRows(waiting(1), 0, true))).toEqual(['q1'])
  // The press is there unless said otherwise.
  expect(titles(claudeRows(waiting(1), 0))).toEqual(['q1'])
  // A room of 2 for two queued steps: both rows with a press; without one, the first and the summary of the other.
  expect(titles(claudeRows(waiting(2), 3, true))).toEqual(['q1', 'q2'])
  expect(titles(claudeRows(waiting(2), 3, false))).toEqual(['q1', '+1 queued'])
  // When they do not all fit, the press changes nothing.
  expect(titles(claudeRows(waiting(5), 4, true))).toEqual(['q1', 'q2', '+3 queued'])
  expect(titles(claudeRows(waiting(5), 4, false))).toEqual(['q1', 'q2', '+3 queued'])
  // The in-flight rows stay, and the press changes the queued line alone.
  expect(titles(claudeRows([...flying(2), ...waiting(1)], 6, false))).toEqual(['f1', 'f2', '+1 queued'])
})

test('the in-flight rows come first and each group keeps its written order', () => {
  const mixed = [todoItem('q1', 'queued'), todoItem('f1', 'in_flight'), todoItem('q2', 'queued'), todoItem('f2', 'in_flight')]
  expect(titles(claudeRows(mixed, 10))).toEqual(['f1', 'f2', 'q1', 'q2'])
})

test('an empty Claude list has no rows', () => {
  expect(claudeRows([], 10)).toEqual([])
})

test('the fold count is the column\'s header, every in-flight row and, while a step is queued, the one line it keeps for the queued steps; the queued rows still start after the in-flight rows', () => {
  expect(foldCount([])).toBe(1)
  expect(foldCount(flying(3))).toBe(4)
  expect(foldCount(waiting(1))).toBe(2)
  expect(foldCount(waiting(4))).toBe(2)
  expect(foldCount([...flying(3), ...waiting(4)])).toBe(5)
  // The queued rows start after the in-flight rows: the fold count is the height that leaves them one line, and a height one over it leaves two.
  const todo = [...flying(3), ...waiting(4)]
  expect(titles(claudeRows(todo, foldCount(todo)))).toEqual(['f1', 'f2', 'f3', '+4 queued'])
  expect(titles(claudeRows(todo, foldCount(todo) + 1))).toEqual(['f1', 'f2', 'f3', 'q1', '+3 queued'])
})

test('for every list and height, with a press in the header or without one, the column\'s drawn lines are its fold count at least and the larger of its fold count and the height at most, and the rows stand for every item', () => {
  for (let inFlight = 0; inFlight <= 5; inFlight++) {
    for (let queued = 0; queued <= 5; queued++) {
      const todo = [...flying(inFlight), ...waiting(queued)]
      for (let height = 0; height <= 12; height++) {
        for (const hasPress of [true, false]) {
          const where = `${inFlight} in flight, ${queued} queued, height ${height}, press ${hasPress}`
          const rows = claudeRows(todo, height, hasPress)
          // The header and the rows: the floor in the fold count and the floor in the queued rows' room hold each other.
          expect(1 + rows.length, where).toBeGreaterThanOrEqual(foldCount(todo))
          expect(1 + rows.length, where).toBeLessThanOrEqual(Math.max(foldCount(todo), height))
          // Every in-flight item first, then every queued item as a row or counted by the summary, which is the last row.
          expect(titles(rows.slice(0, inFlight)), where).toEqual(flying(inFlight).map(it => it.title))
          expect(rows.slice(inFlight).reduce((total, row) => total + (row.kind === 'item' ? 1 : row.count), 0), where).toBe(queued)
          expect(rows.slice(0, -1).every(row => row.kind === 'item'), where).toBe(true)
        }
      }
    }
  }
})

test('a text wraps word by word at its spaces, in display columns, and a line break starts a line', () => {
  expect(wrapText('Approve the deploy', 10)).toEqual(['Approve ', 'the deploy'])
  expect(wrapText('Pick a db', 15)).toEqual(['Pick a db'])
  expect(wrapText('', 10)).toEqual([''])
  expect(wrapText('ab\ncd', 10)).toEqual(['ab', 'cd'])
  expect(wrapText('ab\r\ncd', 10)).toEqual(['ab', 'cd'])
  // Each side of a line break wraps on its own.
  expect(wrapText('Approve the deploy\nnow', 10)).toEqual(['Approve ', 'the deploy', 'now'])
})

test('a word wider than the line breaks across lines, starting on the line it follows unless starting on the next line breaks it fewer times', () => {
  expect(wrapText('abcdefghijklmnopqrstuvwxyz', 10)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz'])
  // After `Fix ` six columns are left. From there the 26 letters break twice (6, 10 and 10 columns), and from the next line twice as well (10, 10 and 6), so
  // the word stays where it follows. The word is placed before the text after it is looked at, so ` now` goes where the last line of the word leaves it:
  // that line is full, and ` now` takes a line of its own, though starting the word on the next line would have let it share the word's last line.
  expect(wrapText('Fix abcdefghijklmnopqrstuvwxyz now', 10)).toEqual(['Fix abcdef', 'ghijklmnop', 'qrstuvwxyz', ' now'])
  // After `aaaa bbb ` one column is left: the 12 letters break twice from there (1, 10 and 1 columns) and once from the next line (10 and 2), which is fewer.
  expect(wrapText('aaaa bbb cccccccccccc', 10)).toEqual(['aaaa bbb ', 'cccccccccc', 'cc'])
})

test('the spaces stay where they fall: a full line sends the space after it to the next line, and a trailing space after an exact fit takes a line of its own', () => {
  expect(wrapText('aaaa bbbbb cc', 10)).toEqual(['aaaa bbbbb', ' cc'])
  expect(wrapText(' To do for xxxxxxxxxxxxxxxxxxxx ', 20)).toEqual([' To do for ', 'xxxxxxxxxxxxxxxxxxxx', ' '])
  expect(wrapText(' To do for xxxxxxxxxxxxxxxxxxxx ', 30)).toEqual([' To do for ', 'xxxxxxxxxxxxxxxxxxxx '])
})

test('a wide character counts two columns and is never split: the line breaks before one that does not fit', () => {
  expect(wrapText('部署新版本到生产环境', 10)).toEqual(['部署新版本', '到生产环境'])
  expect(wrapText('部署新版本到生产环境', 5)).toEqual(['部署', '新版', '本到', '生产', '环境'])
  expect(wrapText('ab 部署', 4)).toEqual(['ab ', '部署'])
})

test('no text is cut and no line is wider than the width, whatever the width, with a line of its own for every character that cannot be placed', () => {
  const text = 'Review internationalization of 部署 the pneumonoultramicroscopic plan'
  for (let width = 1; width <= 70; width++) {
    const lines = wrapText(text, width)
    expect(lines.join('').replace(/ /g, ''), `${width}`).toBe(text.replace(/ /g, ''))
    for (const line of lines) {
      expect(line.replace(/[一-鿿]/g, 'ab').length <= Math.max(width, 2), `${width}: ${line}`).toBe(true)
      // A text with something on every line has no empty row.
      expect(line, `${width}`).not.toBe('')
    }
  }
  expect(wrapText('abc', 0)).toEqual(['a', 'b', 'c'])
})

test('a character wider than the width is a row of its own, and no empty row comes before it', () => {
  expect(wrapText('漢', 1)).toEqual(['漢'])
  expect(wrapText('漢字', 1)).toEqual(['漢', '字'])
  expect(wrapText('a漢', 1)).toEqual(['a', '漢'])
  expect(wrapText('ab 漢', 1)).toEqual(['a', 'b', ' ', '漢'])
})

// Code points written as numbers, so no editor or encoding changes a joiner or a variation selector that draws as nothing.
const cps = (...codes: number[]): string => String.fromCodePoint(...codes)
const JOINER = cps(0x200d)
const SELECTOR = cps(0xfe0f)
const KEYCAP_MARK = cps(0x20e3)
const FAMILY = cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466)
// A heart with its selector, and a keycap `1` (digit, selector, enclosing keycap): tmux draws each two columns wide, and the measure gives the heart or the digit one
// column and the selector the other.
const HEART = cps(0x2764, 0xfe0f)
const KEYCAP_ONE = cps(0x31, 0xfe0f, 0x20e3)

test('a text that fits its room is whole, and a wider one is cut at its end with an ellipsis inside the room: `Ship it to staging today` is whole at 24 and at 30, `Ship it to stag…` at 16, `Ship it to…` at 11 and `Shi…` at 4', () => {
  const label = 'Ship it to staging today'
  expect(displayColumns(label)).toBe(24)
  expect(cutToColumns(label, 30)).toBe(label)
  expect(cutToColumns(label, 24)).toBe(label)
  expect(cutToColumns(label, 23)).toBe('Ship it to staging tod…')
  expect(cutToColumns(label, 16)).toBe('Ship it to stag…')
  expect(cutToColumns(label, 11)).toBe('Ship it to…')
  expect(cutToColumns(label, 4)).toBe('Shi…')
  expect(cutToColumns('', 5)).toBe('')
})

test('a wide character is never split: ten ✅ are `✅✅✅✅…` at 9 and at 10, `日本語のタイトル` is `日本語…` at 7, and U+20000, U+20001 and U+20000 are the first and an ellipsis at 4', () => {
  const check = cps(0x2705)
  expect(cutToColumns(check.repeat(10), 9)).toBe(`${check.repeat(4)}…`)
  expect(cutToColumns(check.repeat(10), 10)).toBe(`${check.repeat(4)}…`)
  expect(displayColumns(`${check.repeat(4)}…`)).toBe(9)
  expect(cutToColumns('日本語のタイトル', 7)).toBe('日本語…')
  expect(cutToColumns(cps(0x20000, 0x20001, 0x20000), 4)).toBe(`${cps(0x20000)}…`)
})

test('a joined sequence is one unit and a joiner is never the last thing kept: the family of four then `x` is whole at 3 and `…` at 2, a grinning face, a joiner and `x` is whole at 3 and `…` at 2, and ten families are four and an ellipsis at 9 and at 10', () => {
  const face = cps(0x1f600)
  expect(cutToColumns(`${FAMILY}x`, 3)).toBe(`${FAMILY}x`)
  expect(cutToColumns(`${FAMILY}x`, 2)).toBe('…')
  expect(cutToColumns(`${face}${JOINER}x`, 3)).toBe(`${face}${JOINER}x`)
  expect(cutToColumns(`${face}${JOINER}x`, 2)).toBe('…')
  expect(cutToColumns(`${face}${JOINER}${face}`, 4)).toBe(`${face}${JOINER}${face}`)
  expect(cutToColumns(`${face}${JOINER}${face}${face}`, 5)).toBe(`${face}${JOINER}${face}…`)
  for (const room of [9, 10]) {
    const got = cutToColumns(FAMILY.repeat(10), room)
    expect(got, `${room}`).toBe(`${FAMILY.repeat(4)}…`)
    expect(displayColumns(got), `${room}`).toBe(9)
  }
  expect(cutToColumns(`${face}${JOINER}${face}${JOINER}xx`, 5)).toBe('…')
})

test('a joiner and the U+FE0F after it are kept with the unit they join or dropped with it: a grinning face, a joiner, a selector and a grinning face is whole at 4 and `…` at 3, and with `xx` after it the whole and an ellipsis at 5 and `…` at 4', () => {
  const joined = cps(0x1f600, 0x200d, 0xfe0f, 0x1f600)
  expect(displayColumns(joined)).toBe(4)
  expect(cutToColumns(joined, 4)).toBe(joined)
  expect(cutToColumns(joined, 3)).toBe('…')
  expect(cutToColumns(`${joined}xx`, 5)).toBe(`${joined}…`)
  expect(cutToColumns(`${joined}xx`, 4)).toBe('…')
})

test('a run of unmeasured parts joined by a joiner is kept whole or dropped, never cut inside: three grinning faces joined, then `xx`, are the run and an ellipsis at 7 and `…` at 6, and with `ab` before them `ab…` at 8 and `ab`, the run and an ellipsis at 9', () => {
  const run = cps(0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600)
  expect(displayColumns(run)).toBe(6)
  expect(cutToColumns(`${run}xx`, 7)).toBe(`${run}…`)
  expect(cutToColumns(`${run}xx`, 6)).toBe('…')
  expect(cutToColumns(`ab${run}xx`, 8)).toBe('ab…')
  expect(cutToColumns(`ab${run}xx`, 9)).toBe(`ab${run}…`)
})

test('a code point and the U+FE0F after it are kept together or dropped together, as tmux draws the pair one glyph two columns wide: ten ❤ U+FE0F are seven hearts and an ellipsis at 15 and at 16, eight at 17 and at 18, nine at 19, and whole at 20', () => {
  const hearts = HEART.repeat(10)
  expect(displayColumns(hearts)).toBe(20)
  for (const [room, kept] of [[15, 7], [16, 7], [17, 8], [18, 8], [19, 9]] as const) expect(cutToColumns(hearts, room), `${room}`).toBe(`${HEART.repeat(kept)}…`)
  expect(cutToColumns(hearts, 20)).toBe(hearts)
  // A heart that does not fit with its selector is dropped whole: a room of 2 holds the ellipsis alone, and one of 3 a heart and the ellipsis.
  expect(cutToColumns(hearts, 2)).toBe('…')
  expect(cutToColumns(hearts, 3)).toBe(`${HEART}…`)
})

test('a keycap is kept whole or dropped whole, its digit, selector and enclosing keycap: four of them are three and an ellipsis at 7, two at 6 and at 5, one at 4 and at 3, and the ellipsis alone at 2', () => {
  const keycaps = KEYCAP_ONE.repeat(4)
  expect(displayColumns(keycaps)).toBe(8)
  for (const [room, kept] of [[7, 3], [6, 2], [5, 2], [4, 1], [3, 1]] as const) expect(cutToColumns(keycaps, room), `${room}`).toBe(`${KEYCAP_ONE.repeat(kept)}…`)
  expect(cutToColumns(keycaps, 2)).toBe('…')
})

test('whatever the room, a cut never ends between a code point and the U+FE0F or keycap mark after it in the text, and measures at most the room: eight ❤ U+FE0F then words, keycaps, a letter and a selector, a wide character and a selector', () => {
  const titles = [
    `${HEART.repeat(8)} then some words`,
    `Ship ${HEART.repeat(8)} it`,
    `${KEYCAP_ONE.repeat(4)} then some words`,
    `${cps(0x61, 0xfe0f)}b${cps(0x61, 0xfe0f)}b${cps(0x61, 0xfe0f)}b`,
    `${cps(0x2705, 0xfe0f)}${HEART}${cps(0x2705, 0xfe0f)}${HEART} ok`,
  ]
  for (const title of titles) {
    const points = [...title]
    for (let room = 1; room <= 45; room++) {
      const where = `${JSON.stringify(title)} in ${room}`
      const got = cutToColumns(title, room)
      expect(displayColumns(got), where).toBeLessThanOrEqual(room)
      if (got === title) continue
      expect(got.endsWith('…'), where).toBe(true)
      // What was kept is the start of the title, and the code point after it is neither a selector nor a keycap mark, so no kept code point is left bare.
      const kept = [...got].slice(0, -1)
      expect(points.slice(0, kept.length), where).toEqual(kept)
      expect([SELECTOR, KEYCAP_MARK].includes(points[kept.length] ?? ''), where).toBe(false)
    }
  }
})

test('a text wider than one column is `…` at a room of 1, and nothing is kept where there is no room', () => {
  for (const text of ['ab', 'Fix it', cps(0x65e5), cps(0x2705), FAMILY]) expect(cutToColumns(text, 1), text).toBe('…')
  expect(cutToColumns('a', 1)).toBe('a')
  expect(cutToColumns('abc', 0)).toBe('')
  expect(cutToColumns('abc', -3)).toBe('')
})

const SAMPLES = [
  'Ship it to staging today',
  `${cps(0x2705, 0x274c, 0x2b50, 0x26a1)} four emoji then words`,
  '日本語のタイトル and some words',
  cps(0x20000, 0x20001, 0x20000, 0x20001),
  `${FAMILY}x${FAMILY}`,
  `${cps(0x2764, 0xfe0f)}abc${cps(0x2764, 0xfe0f)}`,
  `a${cps(0x301)}bcd${cps(0x301)}`,
  `${cps(0x31, 0xfe0f, 0x20e3)}x`,
  `ab${cps(0x07)}cd`,
  `a\ud800bc`,
  `${cps(0x1f44d, 0x1f3fd)} ok`,
  `${HEART.repeat(8)} and words`,
  `${KEYCAP_ONE.repeat(3)}x`,
  `${cps(0x2705, 0xfe0f)}${HEART}${cps(0x2705, 0xfe0f)}ab`,
  `${cps(0x2764, 0xfe0f, 0x200d, 0x1f525)} on fire ${HEART}`,
  `${cps(0x261d, 0x1f3fd)} up ${cps(0x1faf1, 0x1f3fb, 0x200d, 0x1faf2, 0x1f3fc)} shake`,
  `${FAMILY.repeat(3)} and ${cps(0x1f1fa, 0x1f1f8)}`,
  `${cps(0x1f600, 0x200d, 0x1f600)}ab${cps(0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600)}cd ${cps(0x1f600, 0x200d, 0x1f600)} ef`,
  `${cps(0x1f600, 0x200d, 0xfe0f, 0x1f600)}ab${cps(0x1f600, 0x200d, 0xfe0f, 0x1f600)}cd`,
]

test('whatever the text and the room, the cut is the longest start of the text that ends at a cut point and leaves a column for the ellipsis, and it measures at most the room', () => {
  for (const text of SAMPLES) {
    for (let room = -1; room <= 45; room++) {
      const where = `${JSON.stringify(text)} in ${room}`
      const got = cutToColumns(text, room)
      if (displayColumns(text) <= room) {
        expect(got, where).toBe(text)
        continue
      }
      if (room < 1) {
        expect(got, where).toBe('')
        continue
      }
      expect(got.endsWith('…'), where).toBe(true)
      expect(displayColumns(got), where).toBeLessThanOrEqual(room)
      expect(endsJoining(got.slice(0, -1)), where).toBe(false)
      // The longest start that ends at a cut point and fits the room less the ellipsis, found by trying every start: the empty start, and one that ends between units,
      // where no joiner still joins what follows (endsJoining), before a unit that draws a column.
      let want = ''
      let start = ''
      for (const [k, { text: unit, columns }] of unitsOf(text).entries()) {
        if (displayColumns(start) <= room - 1 && (k === 0 || (!endsJoining(start) && columns > 0))) want = start
        start += unit
      }
      expect(got, where).toBe(`${want}…`)
    }
  }
})

// Text built from the measured sequences, every 37th of them (the doubled-joiner unit among them by name), each between ASCII, CJK and spaces so no two join into a
// longer one, except the two pieces that end on a joiner followed by U+FE0F or by a combining mark: a joiner joins the piece after it, so no cut may fall directly after either.
// Its pieces, whose ends are the only places a cut or a wrap may fall.
const MEASURED = SEQUENCES.filter((_, k) => k % 37 === 0).map(([hex]) => cps(...hex.split(' ').map(code => parseInt(code, 16))))
const PIECES = [...[cps(0x1f600, 0x200d, 0xfe0f), cps(0x1f600, 0x200d, 0x301), ...MEASURED].flatMap(text => [text, 'a', 'b', ' ', '日']), cps(0x1f600, 0x200d, 0x200d, 0x1f600), ' ']
const endsOf = (pieces: readonly string[]): Set<string> => new Set(pieces.map((_, k) => pieces.slice(0, k + 1).join('')))

test('for any text built from measured sequences, a joiner followed by U+FE0F or by a combining mark, ASCII and CJK, ending on a joiner, and any room from 1 to 40, no cut ends inside a measured sequence or on a joiner, or on one and the code points after it that draw nothing, and each measures at most its room', () => {
  expect(MEASURED.length).toBeGreaterThan(60)
  expect(MEASURED.some(text => text.length > 8)).toBe(true)
  const text = [...PIECES, JOINER].join('')
  const ends = endsOf(PIECES)
  for (let room = 1; room <= 40; room++) {
    const got = cutToColumns(text, room)
    const kept = got.slice(0, -1)
    expect(displayColumns(got), `${room}`).toBeLessThanOrEqual(room)
    expect(kept === '' || ends.has(kept), `${room}`).toBe(true)
    expect(endsJoining(kept), `${room}`).toBe(false)
  }
  // Several starts, so the cut meets different sequences: each start rotates the pieces.
  for (let start = 0; start < PIECES.length; start += 53) {
    const rotated = [...PIECES.slice(start), ...PIECES.slice(0, start)]
    for (let room = 1; room <= 40; room++) {
      const kept = cutToColumns(rotated.join(''), room).slice(0, -1)
      expect(kept === '' || endsOf(rotated).has(kept), `${start}, ${room}`).toBe(true)
    }
  }
})

test('the header\'s wrap never breaks inside a measured sequence: a word of measured sequences and ASCII wrapped at any width from 1 to 12 breaks only between them', () => {
  const pieces = MEASURED.slice(0, 80).flatMap(text => [text, '-'])
  const word = pieces.join('')
  const ends = endsOf(pieces)
  for (let width = 1; width <= 12; width++) {
    const rows = wrapText(word, width)
    expect(rows.join(''), `${width}`).toBe(word)
    let upTo = ''
    for (const row of rows) {
      upTo += row
      expect(ends.has(upTo), `${width}: ${JSON.stringify(row)}`).toBe(true)
    }
  }
})

test('a decision\'s title keeps its marker whole after the cut title while the room holds the marker and an ellipsis (5 columns), and below that is cut with the marker as one text', () => {
  const title = 'Pick the release train for the next deploy'
  const marker = ' […]'
  expect(cutTitle(title, marker, 20)).toBe('Pick the releas… […]')
  expect(cutTitle(title, marker, 5)).toBe('… […]')
  expect(cutTitle(title, marker, 4)).toBe('Pic…')
  expect(cutTitle(title, marker, 1)).toBe('…')
  // Whole where it fits, marker included; one column short of that the title gives way and the marker stays.
  expect(cutTitle('Pick a db', marker, 13)).toBe('Pick a db […]')
  expect(cutTitle('Pick a db', marker, 12)).toBe('Pick a … […]')
  // A row with no marker is its title cut as a text.
  expect(cutTitle('Fix the build', '', 13)).toBe('Fix the build')
  expect(cutTitle('Fix the build', '', 8)).toBe('Fix the…')
})

test('the summary text is cut like a title, at the list\'s layout width: `+3 blocking · +5 more […]` is whole at 25 columns and `+3 blocking · +5 m…` at 19', () => {
  const summary = '+3 blocking · +5 more […]'
  expect(displayColumns(summary)).toBe(25)
  expect(cutToColumns(summary, 25)).toBe(summary)
  expect(cutToColumns(summary, 19)).toBe('+3 blocking · +5 m…')
})

test('a title label measures at most its room, is the whole title with its marker when that fits, and ends in the marker whenever the room holds the marker and an ellipsis', () => {
  const marker = ' […]'
  for (const [title, mark] of [['Pick the release train for the next deploy', marker], ['日本語のタイトル', marker], ['Fix the build', ''], [`${FAMILY} deploy`, marker]] as const) {
    for (let room = 1; room <= 60; room++) {
      const where = `${JSON.stringify(title)} in ${room}`
      const label = cutTitle(title, mark, room)
      expect(displayColumns(label), where).toBeLessThanOrEqual(room)
      if (displayColumns(title + mark) <= room) expect(label, where).toBe(title + mark)
      else if (mark !== '' && room >= 5) expect(label.endsWith(`…${mark}`), where).toBe(true)
      else expect(label.endsWith('…'), where).toBe(true)
    }
  }
})

// The Claude column's header, the heading and the counts cut at the column's layout width as the two parts ui.ts draws; the counts are the part that is pressed.
const HEADING = 'Claude TODO'
const COUNTS = '1 active, 2 queued'

test('the header is the heading with its space and the counts: whole from 30 columns, the counts cut to the 8 the heading leaves at 20 (`1 activ…`), and at 6 the line cut as one text (`Claud…`)', () => {
  expect(displayColumns(`${HEADING} ${COUNTS}`)).toBe(30)
  for (const width of [30, 31, 80]) expect(columnHeader(HEADING, COUNTS, width), `${width}`).toEqual({ heading: 'Claude TODO ', counts: COUNTS })
  expect(columnHeader(HEADING, COUNTS, 29)).toEqual({ heading: 'Claude TODO ', counts: '1 active, 2 queu…' })
  expect(columnHeader(HEADING, COUNTS, 20)).toEqual({ heading: 'Claude TODO ', counts: '1 activ…' })
  expect(columnHeader(HEADING, COUNTS, 6)).toEqual({ heading: 'Claud…', counts: '' })
})

test('the counts part keeps a column while the heading and its space leave one: `1…` at 14 and a bare `…` at 13; at 12 and 11 the heading part is the line cut, `Claude TODO…` and `Claude TOD…`, and the counts part is empty', () => {
  expect(columnHeader(HEADING, COUNTS, 14)).toEqual({ heading: 'Claude TODO ', counts: '1…' })
  expect(columnHeader(HEADING, COUNTS, 13)).toEqual({ heading: 'Claude TODO ', counts: '…' })
  expect(columnHeader(HEADING, COUNTS, 12)).toEqual({ heading: 'Claude TODO…', counts: '' })
  expect(columnHeader(HEADING, COUNTS, 11)).toEqual({ heading: 'Claude TOD…', counts: '' })
})

test('whatever the counts and the width, the two parts joined are the line cut at the width and measure at most the width, and the counts part is empty exactly when the width is 12 or less', () => {
  for (const counts of ['0 active, 0 queued', COUNTS, '12 active, 13 queued', '120 active, 13 queued']) {
    for (let width = 0; width <= 45; width++) {
      const where = `${counts} in ${width}`
      const parts = columnHeader(HEADING, counts, width)
      expect(`${parts.heading}${parts.counts}`, where).toBe(cutToColumns(`${HEADING} ${counts}`, width))
      expect(displayColumns(`${parts.heading}${parts.counts}`), where).toBeLessThanOrEqual(width)
      expect(parts.counts === '', where).toBe(width <= 12)
      // The heading part is whole with its space while the counts draw, and below that it is the cut line, which ends in the ellipsis.
      if (width >= 13) expect(parts.heading, where).toBe('Claude TODO ')
      else if (width >= 1) expect(parts.heading.endsWith('…'), where).toBe(true)
    }
  }
})

// --- a row's ladder

const UNDO = '[↶ 3s]'
const ctl = (before: string, answer = '', after = ''): Control => ({ before, answer, after })
// A pressed control as ui.ts's builder makes it: its mark, the answer, and the undo button after a space when there is an answer.
const said = (answer: string, mark = '✓'): Control => ctl(`${mark} `, answer, answer === '' ? UNDO : ` ${UNDO}`)
const REPLIED = ctl('✓ replied ', '', UNDO)

const LABEL_24 = 'Ship it to staging today'
const OPTION_19 = 'Use sqlite for data'
const OPTION_56 = 'Use sqlite with write-ahead logging and a nightly backup'
const OPTION_150 = `${Array.from({ length: 30 }, () => 'word').join(' ')}x`

type Kind = { name: string; marker: string; open: Control; pressed: Control[] }
const decision = (name: string, option: string): Kind => ({ name, marker: ' […]', open: ctl(''), pressed: [said(option), said('Use postgres'), REPLIED] })
const labelled = (name: string, label: string): Kind => ({ name, marker: '', open: ctl('[✓ ', label, ']'), pressed: [said(label), REPLIED] })
const PLAIN: Kind = { name: 'a plain to-do', marker: '', open: ctl('[✓]'), pressed: [said(''), REPLIED] }
const YES_NO: Kind = { name: 'a yes/no', marker: '', open: ctl('[✓] [✗]'), pressed: [said('yes'), said('no', '✗'), REPLIED] }
const LABELLED_24 = labelled('a to-do labelled at 24 columns', LABEL_24)
const LABELLED_5 = labelled('a to-do labelled at 5 columns', 'Go on')
const DECISION_19 = decision('a decision with an option of 19 columns', OPTION_19)
const DECISION_56 = decision('a decision with an option of 56 columns', OPTION_56)
const DECISION_150 = decision('a decision with an option of 150 columns', OPTION_150)
const KINDS: Kind[] = [PLAIN, LABELLED_24, LABELLED_5, YES_NO, DECISION_19, DECISION_56, DECISION_150]

// A kind's row texts for an id of `digits` digits: the unread mark or two blanks, the id and a space, so the prefix is digits + 4 columns.
const rowFor = (kind: Kind, digits = 2, title = 'Fix it'): RowTexts => ({
  prefix: `${digits % 2 === 0 ? '• ' : '  '}#${'1'.repeat(digits)} `,
  title,
  marker: kind.marker,
  open: kind.open,
  pressed: kind.pressed,
  squeezed: `✓ ${UNDO}`,
  sent: '✓ sent',
})

test('the answer texts the sweeps use are the lengths their names say', () => {
  expect([OPTION_19, OPTION_56, OPTION_150, LABEL_24].map(displayColumns)).toEqual([19, 56, 150, 24])
  expect(displayColumns(rowFor(PLAIN).prefix)).toBe(6)
  expect(displayColumns(rowFor(PLAIN, 3).prefix)).toBe(7)
})

// The ladder worked on the strings the states draw, one rung at a time as the rule words it, apart from rowLayout: the row's rungs in order are the full
// control with its answer texts up to 24 columns, then the answers cut a column at a time down to 1, then the same again with every pressed control
// squeezed to its mark and undo button; the first that leaves the title ten columns is the row's, and where none does it is the narrowest, the first
// such. A squeezed list (`fromSqueezed`) starts at the third rung. A control's column is the widest of its states and the space before it. The answers here
// are ASCII, so a text's length is its columns.
const cut = (text: string, columns: number): string => (text.length <= columns ? text : `${text.slice(0, columns - 1)}…`)
const oracle = (row: RowTexts, width: number, fromSqueezed = false): { rung: number; answer: number; control: number; room: number } => {
  const prefix = displayColumns(row.prefix)
  const control = (squeezed: boolean, answer: number): number => {
    const drawn = (one: Control): string => `${one.before}${cut(one.answer, answer)}${one.after}`
    const states = [drawn(row.open), ...(squeezed ? [row.squeezed] : row.pressed.map(drawn)), row.sent].filter(text => text !== '')
    return 1 + Math.max(...states.map(displayColumns))
  }
  const rungs = (fromSqueezed ? [true] : [false, true]).flatMap(squeezed => Array.from({ length: 24 }, (_, k) => ({ squeezed, answer: 24 - k })).map(rung => ({ ...rung, control: control(rung.squeezed, rung.answer) })))
  const picked = rungs.find(rung => width - prefix - rung.control >= 10) ?? rungs.reduce((best, rung) => (rung.control < best.control ? rung : best))
  return { rung: picked.squeezed ? 3 : picked.answer === 24 ? 1 : 2, answer: picked.answer, control: picked.control, room: Math.max(1, width - prefix - picked.control) }
}

// What hand work gives for the id 12 and the 3-second window: for each kind and layout width, the rung, the row's answer width, the control column and the
// title's room.
const FIGURES: [Kind, [number, number, number, number, number][]][] = [
  [PLAIN, [[20, 3, 24, 9, 5], [32, 3, 24, 9, 17], [42, 1, 24, 17, 19], [64, 1, 24, 17, 41], [96, 1, 24, 17, 73]]],
  [YES_NO, [[20, 3, 24, 9, 5], [32, 3, 24, 9, 17], [42, 1, 24, 17, 19], [64, 1, 24, 17, 41], [96, 1, 24, 17, 73]]],
  [LABELLED_24, [[20, 3, 4, 9, 5], [32, 3, 11, 16, 10], [42, 2, 16, 26, 10], [64, 1, 24, 34, 24], [96, 1, 24, 34, 56]]],
  [DECISION_56, [[20, 3, 24, 9, 5], [32, 3, 24, 9, 17], [42, 2, 16, 26, 10], [64, 1, 24, 34, 24], [96, 1, 24, 34, 56]]],
]

test('the id 12 and the 3-second window give the rung, the answer width, the control column and the title\'s room worked by hand, for each kind at layout widths 20, 32, 42, 64 and 96', () => {
  for (const [kind, rows] of FIGURES) {
    for (const [width, rung, answer, control, room] of rows) {
      const got = rowLayout(rowFor(kind, 2), width)
      expect({ rung: got.rung, answer: got.answer, control: got.control, room: got.room }, `${kind.name} at ${width}`).toEqual({ rung, answer, control, room })
    }
  }
})

test('a full-width row keeps its title ten columns with its full control from a layout width of 32 to 35 (a plain to-do or a yes/no) and 49 to 52 (a to-do labelled at 24 columns, a decision with an option of 24 columns or more) for ids of one to four digits, and gives a squeezed control below 32 to 35, for every kind alike', () => {
  for (const digits of [1, 2, 3, 4]) {
    const prefix = digits + 4
    for (const kind of KINDS) {
      const fullFrom = prefix + (kind === PLAIN || kind === YES_NO || kind === LABELLED_5 ? 17 : kind === DECISION_19 ? 29 : 34) + 10
      expect(rowLayout(rowFor(kind, digits), fullFrom).rung, `${kind.name}, ${digits} digits at ${fullFrom}`).toBe(1)
      expect(rowLayout(rowFor(kind, digits), fullFrom - 1).rung, `${kind.name}, ${digits} digits at ${fullFrom - 1}`).not.toBe(1)
      // Rung 2 keeps the title ten down to a layout width of the prefix and 27, where the control is 17 columns; below it only the squeezed control does.
      expect(rowLayout(rowFor(kind, digits), prefix + 27).rung, `${kind.name}, ${digits} digits at ${prefix + 27}`).not.toBe(3)
      expect(rowLayout(rowFor(kind, digits), prefix + 26).rung, `${kind.name}, ${digits} digits at ${prefix + 26}`).toBe(3)
    }
  }
  expect([1, 2, 3, 4].map(digits => digits + 4 + 17 + 10)).toEqual([32, 33, 34, 35])
  expect([1, 2, 3, 4].map(digits => digits + 4 + 34 + 10)).toEqual([49, 50, 51, 52])
})

test('at every layout width from the prefix and 10 to 120, for every kind at an id of one to four digits, the layout is the ladder worked on the strings, its control column is the widest state\'s and the space before it, the prefix, the room and the control add up to the layout width, and the title keeps ten columns from the prefix and 19', () => {
  const long = 'Review the deliberately long title of the first plain to-do item here and then some more words so that it is cut'
  // A title cut by hand at the room, ASCII: whole, or the start that leaves a column for the ellipsis, the marker kept whole after it where the room holds both.
  const labelOf = (title: string, marker: string, room: number): string => {
    if (title.length + marker.length <= room) return title + marker
    if (marker !== '' && room >= marker.length + 1) return `${title.slice(0, room - marker.length - 1)}…${marker}`
    return `${title}${marker}`.slice(0, room - 1) + '…'
  }
  const taken = (one: Control, box: number): number => displayColumns(one.before) + box + displayColumns(one.after)
  for (const kind of KINDS) {
    for (const digits of [1, 2, 3, 4]) {
      for (const title of ['Fix it', long]) {
        const row = rowFor(kind, digits, title)
        const prefix = displayColumns(row.prefix)
        for (let width = prefix + 10; width <= 120; width++) {
          const where = `${kind.name}, ${digits} digits at ${width}, ${title.length} columns of title`
          const got = rowLayout(row, width)
          expect({ rung: got.rung, answer: got.answer, control: got.control, room: got.room }, where).toEqual(oracle(row, width))
          expect(prefix + got.room + got.control, where).toBe(width)
          expect(got.room, where).toBeGreaterThanOrEqual(width >= prefix + 19 ? 10 : 1)
          // Every state's control, at the width its allotted answer box gives it, fits the column, and the widest one fills it.
          const controls = [kind.open, ...kind.pressed]
          const boxes = [got.open, ...got.pressed]
          expect(boxes, where).toHaveLength(controls.length)
          const states = [
            ...(kind.open.before + kind.open.answer + kind.open.after === '' ? [] : [taken(kind.open, got.open.box)]),
            ...(got.rung === 3 ? [displayColumns(row.squeezed)] : kind.pressed.map((one, k) => taken(one, got.pressed[k]?.box ?? -1))),
            displayColumns(row.sent),
          ]
          expect(got.control, where).toBe(1 + Math.max(...states))
          // Each answer's box is its measured columns or the row's answer width, whichever is smaller, and holds its text cut to it.
          for (const [k, one] of controls.entries()) {
            const allotted = boxes[k]
            expect(allotted?.box, `${where}, state ${k}`).toBe(Math.min(displayColumns(one.answer), got.answer))
            expect(allotted?.text, `${where}, state ${k}`).toBe(cut(one.answer, got.answer))
            expect(displayColumns(allotted?.text ?? ''), `${where}, state ${k}`).toBeLessThanOrEqual(allotted?.box ?? -1)
          }
          // The title's label is the title cut by hand to the room.
          expect(got.title, where).toBe(labelOf(title, kind.marker, got.room))
        }
      }
    }
  }
})

test('the answer\'s box is its measured columns or the row\'s answer width, whichever is smaller: `Ship it to staging today` gets 24 at layout widths 64 and 96 and 16 at 42, `OK` gets 2 at every layout width, and a decision\'s 56-column option gets 24 at 96', () => {
  for (const width of [64, 96]) {
    const got = rowLayout(rowFor(LABELLED_24), width)
    expect([got.open.box, got.pressed[0]?.box], `${width}`).toEqual([24, 24])
    expect([got.open.text, got.pressed[0]?.text], `${width}`).toEqual([LABEL_24, LABEL_24])
  }
  const narrow = rowLayout(rowFor(LABELLED_24), 42)
  expect([narrow.open.box, narrow.pressed[0]?.box]).toEqual([16, 16])
  expect([narrow.open.text, narrow.pressed[0]?.text]).toEqual(['Ship it to stag…', 'Ship it to stag…'])
  for (let width = 16; width <= 120; width++) {
    const got = rowLayout(rowFor(labelled('a to-do labelled OK', 'OK')), width)
    expect([got.open.box, got.pressed[0]?.box, got.open.text, got.pressed[0]?.text], `${width}`).toEqual([2, 2, 'OK', 'OK'])
  }
  expect(rowLayout(rowFor(DECISION_56), 96).pressed[0]).toEqual({ box: 24, text: 'Use sqlite with write-a…' })
})

test('the reply\'s `✓ replied [↶ 3s]` is never cut: it keeps the control column at 17 columns with its space down to the squeezed control', () => {
  for (const kind of KINDS) {
    for (let width = 16; width <= 120; width++) {
      const got = rowLayout(rowFor(kind), width)
      if (got.rung !== 3) expect(got.control, `${kind.name} at ${width}`).toBeGreaterThanOrEqual(17)
    }
  }
})

test('the control column is the widest of every state, the open control and the sent one included, and the space before them', () => {
  // `✓ sent` is narrower than every other state, so a sent text wider than the reply's 16 columns shows the layout takes it into account.
  const sent = '✓ sent to the agent, which will answer when it is next idle'
  expect(displayColumns(sent)).toBeGreaterThan(16)
  expect(rowLayout({ ...rowFor(PLAIN), sent }, 120).control).toBe(1 + displayColumns(sent))
  // An open label of 24 columns is 28 with its brackets, wider than a pressed control that names no answer.
  const open = ctl('[✓ ', LABEL_24, ']')
  expect(rowLayout({ ...rowFor(PLAIN), open, pressed: [said('')] }, 120).control).toBe(29)
})

test('a wide label is cut by columns and never split, so its box can be a column wider than its text: twelve wide characters at a layout width of 36 get a box of 10 holding four of them and an ellipsis', () => {
  const wide = cps(0x4e2d).repeat(12)
  expect(displayColumns(wide)).toBe(24)
  const got = rowLayout(rowFor(labelled('a to-do labelled with wide characters', wide)), 36)
  expect(got.rung).toBe(2)
  expect(got.answer).toBe(10)
  expect(got.open).toEqual({ box: 10, text: `${cps(0x4e2d).repeat(4)}…` })
  expect(got.pressed[0]).toEqual({ box: 10, text: `${cps(0x4e2d).repeat(4)}…` })
  // The widest state is the pressed control: its mark and space, the box and the undo button after a space, and the space before them.
  expect(got.control).toBe(1 + 2 + 10 + 1 + 6)
  expect(got.room).toBe(10)
})

test('a title is cut by columns at its room, with its decision\'s marker, the line break already joined: wide characters, the family of four and a heart with its selector are never split', () => {
  const row = (title: string, marker: string): RowTexts => ({ ...rowFor(marker === '' ? PLAIN : DECISION_19), title, marker })
  // A plain to-do at 42 has a control column of 17 and a prefix of 6: a room of 19.
  expect(rowLayout(row('日本語のタイトルは長い', ''), 42).title).toBe('日本語のタイトルは…')
  expect(rowLayout(row(FAMILY.repeat(12), ''), 42).title).toBe(`${FAMILY.repeat(9)}…`)
  // At 41 the room is 18: the ninth heart does not fit with its selector, so the title is eight hearts and the ellipsis, a column short of the room.
  expect(rowLayout(row(HEART.repeat(10), ''), 41).title).toBe(`${HEART.repeat(8)}…`)
  // A decision with an option of 19 columns at 96 has a control column of 29 and a room of 61: the title and its marker whole.
  expect(rowLayout(row('Pick the release train for the next deploy', ' […]'), 96).title).toBe('Pick the release train for the next deploy […]')
  const tight = rowLayout(row('Pick the release train for the next deploy', ' […]'), 42)
  expect(tight.title.endsWith('… […]')).toBe(true)
  expect(displayColumns(tight.title)).toBe(tight.room)
})

test('at the prefix and 10 the row draws its control at the third rung and the title keeps one column, for every kind', () => {
  for (const kind of KINDS) {
    const got = rowLayout(rowFor(kind), 16)
    expect([got.rung, got.control, got.room, got.drawsControl, got.drawsPrefix], kind.name).toEqual([3, 9, 1, true, true])
  }
})

test('below the prefix and 10 the row draws no control, its prefix whole while that leaves the title a column, and under that its title alone in the whole width; the id 12 (prefix 6) gives 15 -> room 9, 7 -> 1, 6 and 1 -> the width', () => {
  for (const kind of KINDS) {
    const row = rowFor(kind)
    for (const [width, room, drawsPrefix] of [[15, 9, true], [7, 1, true], [6, 6, false], [1, 1, false]] as const) {
      const got = rowLayout(row, width)
      expect({ rung: got.rung, control: got.control, room: got.room, drawsControl: got.drawsControl, drawsPrefix: got.drawsPrefix }, `${kind.name} at ${width}`).toEqual({
        rung: 3,
        control: 0,
        room,
        drawsControl: false,
        drawsPrefix,
      })
    }
  }
})

test('for an id of one to four digits, a row draws its control and prefix from the prefix and 10, its prefix alone from the prefix and 1 to the prefix and 9, and its title alone under that; no row is wider than its list, squeezed or not, at any width from 1', () => {
  for (const kind of KINDS) {
    for (const digits of [1, 2, 3, 4]) {
      const row = rowFor(kind, digits, 'A title longer than the list, with a pneumonoultramicroscopic word in it')
      const prefix = displayColumns(row.prefix)
      for (const squeezed of [false, true]) {
        for (let width = 1; width <= 120; width++) {
          const where = `${kind.name}, ${digits} digits at ${width}${squeezed ? ', squeezed' : ''}`
          const got = rowLayout(row, width, squeezed)
          const stage = width >= prefix + 10 ? 'control' : width >= prefix + 1 ? 'prefix' : 'title'
          expect([got.drawsControl, got.drawsPrefix], where).toEqual([stage === 'control', stage !== 'title'])
          expect(got.drawsControl ? got.control : 0, where).toBe(got.control)
          expect((got.drawsPrefix ? prefix : 0) + got.room + got.control, where).toBeLessThanOrEqual(width)
          expect(got.room, where).toBeGreaterThanOrEqual(1)
          expect(displayColumns(got.title), where).toBeLessThanOrEqual(got.room)
          if (stage !== 'control') expect(got.room, where).toBe(stage === 'prefix' ? width - prefix : width)
          if (stage === 'control') expect(got.drawsControl && got.control > 0, where).toBe(true)
        }
      }
    }
  }
})

// A squeezed list (layout.ts's isSqueezed) starts the ladder at its third rung. What hand work gives for the id 12 and the 3-second window: for each kind and layout
// width, the answer width, the control column and the title's room, the rung always the third. The widths are the lists of 20, 32 and 42 columns beside the
// Claude column, laid out in one column less (19, 31 and 41), and the one-line output figures measured at 20, 32 and 42.
const SQUEEZED_FIGURES: [Kind, [number, number, number, number][]][] = [
  [PLAIN, [[19, 24, 9, 4], [20, 24, 9, 5], [31, 24, 9, 16], [32, 24, 9, 17], [41, 24, 9, 26], [42, 24, 9, 27]]],
  [YES_NO, [[19, 24, 9, 4], [20, 24, 9, 5], [31, 24, 9, 16], [32, 24, 9, 17], [41, 24, 9, 26], [42, 24, 9, 27]]],
  [LABELLED_24, [[19, 4, 9, 4], [20, 4, 9, 5], [24, 4, 9, 9], [25, 4, 9, 10], [31, 10, 15, 10], [32, 11, 16, 10], [41, 20, 25, 10], [42, 21, 26, 10]]],
  [DECISION_56, [[19, 24, 9, 4], [20, 24, 9, 5], [31, 24, 9, 16], [32, 24, 9, 17], [41, 24, 9, 26], [42, 24, 9, 27]]],
]

test('a squeezed list starts the ladder at its third rung: the id 12 and the 3-second window give the answer width, the control column and the title\'s room worked by hand, a pressed control always its mark and undo button', () => {
  for (const [kind, rows] of SQUEEZED_FIGURES) {
    for (const [width, answer, control, room] of rows) {
      const got = rowLayout(rowFor(kind, 2), width, true)
      expect({ rung: got.rung, answer: got.answer, control: got.control, room: got.room }, `${kind.name} at ${width}`).toEqual({ rung: 3, answer, control, room })
    }
  }
  // The title keeps 4, 16 and 26 columns in lists of 20, 32 and 42 for a plain to-do, a yes/no and a decision, and a labelled to-do's keeps 10 from a layout of 25.
  for (const kind of [PLAIN, YES_NO, DECISION_56]) expect([19, 31, 41].map(width => rowLayout(rowFor(kind, 2), width, true).room), kind.name).toEqual([4, 16, 26])
  expect([24, 25].map(width => rowLayout(rowFor(LABELLED_24, 2), width, true).room)).toEqual([9, 10])
  // The label is cut to fit the control column: its open control, `[✓ Shi…]` with its brackets, is the 8 columns the column of 9 leaves after its space.
  expect(rowLayout(rowFor(LABELLED_24, 2), 19, true).open).toEqual({ box: 4, text: 'Shi…' })
  expect(rowLayout(rowFor(LABELLED_24, 2), 25, true).pressed[0]).toEqual({ box: 4, text: 'Shi…' })
})

test('at every layout width a list of 20 to 63 columns beside the column can have, 19 to 62, every kind at an id of one to four digits is at its third rung: the layout is the ladder worked on the strings from that rung, the pieces add up to the layout width, and the title keeps ten columns from the prefix and 19', () => {
  for (const kind of KINDS) {
    for (const digits of [1, 2, 3, 4]) {
      const row = rowFor(kind, digits, 'A title longer than the list, with a pneumonoultramicroscopic word in it')
      const prefix = displayColumns(row.prefix)
      for (let width = 19; width <= 62; width++) {
        const where = `${kind.name}, ${digits} digits at ${width}`
        const got = rowLayout(row, width, true)
        expect(got.rung, where).toBe(3)
        expect({ rung: got.rung, answer: got.answer, control: got.control, room: got.room }, where).toEqual(oracle(row, width, true))
        expect(prefix + got.room + got.control, where).toBe(width)
        expect(got.room, where).toBeGreaterThanOrEqual(width >= prefix + 19 ? 10 : 1)
        // The control column holds the squeezed pressed control, `✓ [↶ 3s]` and the space before it: 9 columns, more only for an open label.
        expect(got.control, where).toBeGreaterThanOrEqual(9)
        if (kind.open.answer === '') expect(got.control, where).toBe(9)
        expect(displayColumns(got.title), where).toBeLessThanOrEqual(got.room)
      }
    }
  }
})

test('a row the unsqueezed ladder already takes to its third rung is laid out the same in a squeezed list, and one it keeps at an earlier rung is squeezed', () => {
  let squeezedHere = 0
  for (const kind of KINDS) {
    for (const digits of [1, 2, 3, 4]) {
      const row = rowFor(kind, digits)
      for (let width = 1; width <= 120; width++) {
        const where = `${kind.name}, ${digits} digits at ${width}`
        const open = rowLayout(row, width)
        const squeezed = rowLayout(row, width, true)
        expect(squeezed.rung, where).toBe(3)
        if (open.rung === 3) expect(squeezed, where).toEqual(open)
        else squeezedHere++
      }
    }
  }
  // The sweep crosses rows at rungs 1 and 2 in the plain list, which the squeezed list takes to the third.
  expect(squeezedHere).toBeGreaterThan(0)
})

test('the header counts the count\'s wrapped lines in the columns the chip leaves, which never shrinks: ` To do for you ` and ` 8 open ` take 23 columns, so a list of 20 draws the count on two lines', () => {
  // ` To do for you ` is 15 columns and ` 8 open ` 8: in the 5 that a list of 20 leaves they wrap to ` 8 ` and `open `.
  expect(headerLines(' To do for you ', ' 8 open ', 23)).toBe(1)
  expect(headerLines(' To do for you ', ' 8 open ', 120)).toBe(1)
  expect(headerLines(' To do for you ', ' 8 open ', 22)).toBe(2)
  expect(headerLines(' To do for you ', ' 8 open ', 20)).toBe(2)
  expect(wrapText(' 8 open ', 5)).toEqual([' 8 ', 'open '])
})

test('a count wider than the columns the chip leaves wraps word by word there, and with no column left it takes a line per character', () => {
  // The count ` 1234 open, 999999999999 sent ` is 30 columns: the 25 a list of 40 leaves beside the chip hold ` 1234 open, 999999999999` and `sent `.
  const count = ` 1234 open, ${'9'.repeat(12)} sent `
  expect(displayColumns(count)).toBe(30)
  expect(headerLines(' To do for you ', count, 40)).toBe(2)
  expect(headerLines(' To do for you ', count, 45)).toBe(1)
  // The chip never shrinks, and a 20-column term makes it 32 columns, as wide as a list of 32 and wider than one of 31 or 20, so the chip leaves the count
  // -12, -1 and 0 columns there, and 1 at 33. The model wraps in at least one column, so ` 8 open `, its eight characters (a space, `8`, a space, `o`, `p`,
  // `e`, `n`, a space), takes eight lines at all four widths. That is the model's count only: how the engine draws a count with no column left beside the
  // chip is unmeasured.
  const chip = ` To do for ${'x'.repeat(20)} `
  expect(displayColumns(chip)).toBe(32)
  expect(wrapText(' 8 open ', 1)).toEqual([' ', '8', ' ', 'o', 'p', 'e', 'n', ' '])
  for (const width of [20, 31, 32, 33]) expect(headerLines(chip, ' 8 open ', width), `${width}`).toBe(8)
  // With the 8 columns a list of 40 leaves, the count fits on one line.
  expect(headerLines(chip, ' 8 open ', 40)).toBe(1)
})

test('the squeezed header takes two lines and the rows after it; with no room for a row it gives up its count and is the chip alone on one line, and with none even then the chip alone and no row', () => {
  const items = [item(1, true), item(2)]
  const fold = (room: number) => {
    const { top, rows } = squeezedFold(items, room)
    return [top, ids(rows)]
  }
  // Whole: the header's two lines and both rows.
  expect(fold(10)).toEqual([2, [1, 2]])
  expect(fold(4)).toEqual([2, [1, 2]])
  // Folded into the summary row: the header's two lines and the summary.
  expect(fold(3)).toEqual([2, [-1]])
  // The two-line header would leave the summary no room: the chip alone, and the summary below it.
  expect(fold(2)).toEqual([1, [-1]])
  // Not even then: the chip alone and no row.
  expect(fold(1)).toEqual([1, []])
  expect(fold(0)).toEqual([1, []])
  expect(fold(-3)).toEqual([1, []])
  // A single item that fits beside the two-line header is a row of its own; where the second line would leave it no room, the chip alone gives it the line.
  expect(squeezedFold([item(1)], 3)).toEqual({ top: 2, rows: [{ kind: 'item', item: item(1) }] })
  expect(squeezedFold([item(1)], 2)).toEqual({ top: 1, rows: [{ kind: 'item', item: item(1) }] })
})

test('for any number of items and any room the squeezed fold draws the two-line header from a room of 3, the chip alone at 2 with a row and at 1 and 0 with none, and never more lines than the room but for the chip', () => {
  for (let count = 1; count <= 14; count++) {
    const items = Array.from({ length: count }, (_, k) => item(k + 1, k % 3 === 0))
    for (let room = 0; room <= 18; room++) {
      const where = `${count} items in ${room}`
      const { top, rows } = squeezedFold(items, room)
      expect(top, where).toBe(room >= 3 ? 2 : 1)
      expect(rows, where).toEqual(bandRows(items, Math.max(0, room - top)))
      expect(rows.length > 0, where).toBe(room >= 2)
      expect(top + rows.length, where).toBeLessThanOrEqual(Math.max(room, 1))
    }
  }
})

// The backlog row's tail: cut to the body less the smaller of the head's width and 12, and dropped where no ETA character survives.
const CJK_TAIL = ` · ${'漢'.repeat(30)}`
const LONG_HEAD = `◐ ${'x'.repeat(80)}`

test('a backlog tail is whole while the head keeps its minimum beside it, and cut at its end with an ellipsis, no wide character split, past that', () => {
  expect(backlogTail(LONG_HEAD, ' · ship it after the review pass!', 48)).toBe(' · ship it after the review pass!')
  expect(backlogTail(LONG_HEAD, CJK_TAIL, 97)).toBe(CJK_TAIL)
  const cutAt48 = backlogTail(LONG_HEAD, CJK_TAIL, 48)
  expect(cutAt48.endsWith('…')).toBe(true)
  expect(displayColumns(cutAt48)).toBeLessThanOrEqual(36)
  expect(cutAt48).toBe(` · ${'漢'.repeat(16)}…`)
})

test('a backlog tail is ` · ship it after the re…` at body 36, absent at bodies 13 to 16, and the CJK tail is ` · 日…` at a room of 6 and absent at 5', () => {
  expect(backlogTail(LONG_HEAD, ' · ship it after the review pass!', 36)).toBe(' · ship it after the re…')
  expect(backlogTail(LONG_HEAD, ' · ship it after the review pass!', 17)).toBe(' · s…')
  for (const body of [13, 14, 15, 16]) expect(backlogTail(LONG_HEAD, ' · ship it after the review pass!', body), `body ${body}`).toBe('')
  expect(backlogTail(LONG_HEAD, ` · ${'日'.repeat(30)}`, 18)).toBe(' · 日…')
  expect(backlogTail(LONG_HEAD, ` · ${'日'.repeat(30)}`, 17)).toBe('')
})

test('a backlog tail measures at most the room (body less the smaller of the head and 12), ends in an ellipsis when cut and keeps an ETA character, or is absent, for every body, head and tail', () => {
  for (let body = 1; body <= 120; body++) {
    for (let head = 3; head <= 82; head += 3) {
      for (const unit of ['a', '漢']) {
        for (let eta = 1; eta <= Math.floor(60 / displayColumns(unit)); eta += 3) {
          const tail = ` · ${unit.repeat(eta)}`
          const text = backlogTail('x'.repeat(head), tail, body)
          const room = Math.max(0, body - Math.min(head, 12))
          const label = `body ${body} head ${head} tail ${tail}`
          if (displayColumns(tail) <= room) expect(text, label).toBe(tail)
          else if (room < 3 + displayColumns(unit) + 1) expect(text, label).toBe('')
          else {
            expect(displayColumns(text), label).toBeLessThanOrEqual(room)
            expect(text.endsWith('…'), label).toBe(true)
            expect(displayColumns(text.slice(0, -1)), label).toBeGreaterThan(3)
            expect(text.slice(3, -1).split('').every(char => char === unit), label).toBe(true)
          }
        }
      }
    }
  }
})

test('a list that is not squeezed takes the stacked header only when it is narrower than its chip and one column, for the chip of the default term and of a 20-column term', () => {
  const chipOf = (term: string): string => ` To do for ${term} `
  const alone = (width: number): BandWidths => ({ human: { box: width, layout: width }, claude: null })
  for (const [chip, columns] of [[chipOf('you'), 15], [chipOf('x'.repeat(20)), 32]] as const) {
    expect(displayColumns(chip)).toBe(columns)
    for (let width = 1; width <= 120; width++) expect(isChipShort(alone(width), chip), `${columns}-column chip at ${width}`).toBe(width < columns + 1)
  }
  // A squeezed list has the stacked header already, and a band with no human list has none.
  const squeezed: BandWidths = { human: { box: 30, layout: 29 }, claude: { box: 32, layout: 31 } }
  expect(isSqueezed(squeezed)).toBe(true)
  expect(isChipShort(squeezed, chipOf('x'.repeat(20)))).toBe(false)
  expect(isChipShort({ human: null, claude: { box: 32, layout: 32 } }, chipOf('you'))).toBe(false)
})
