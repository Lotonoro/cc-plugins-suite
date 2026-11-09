import { expect, test } from 'claude-code/testing'
import { bandDraws, bandRows, bandWidths, claudeRows, columnHeight, headerLines, humanFoldRows, rowLayout, rowLines, rowsHeight, wrapText, type ClaudeRow, type RowLayout, type RowTexts } from './layout'
import { displayColumns } from './items'
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

test('a summary taller than the rows draws nothing, so the rows never exceed the rows they are given', () => {
  const tall = () => 3
  expect(bandRows([item(1), item(2)], 2, tall)).toEqual([])
  expect(bandRows([item(1), item(2)], 0, tall)).toEqual([])
  // The summary that fits draws, and a single item taller than the rows is folded into it.
  const summaryTall = (row: ReturnType<typeof bandRows>[number]) => (row.kind === 'more' ? 2 : 4)
  expect(bandRows([item(1), item(2)], 2, summaryTall)).toEqual([{ kind: 'more', blocking: 0, more: 2, first: item(1) }])
  expect(bandRows([item(1), item(2)], 1, summaryTall)).toEqual([])
})

test('whatever each row takes and whatever the rows given, the rows drawn never take more than the rows given', () => {
  const items = Array.from({ length: 12 }, (_, k) => item(k + 1, k % 3 === 0))
  // A deterministic spread of heights, summaries of one to three lines.
  const heightOf = (row: ReturnType<typeof bandRows>[number]) => (row.kind === 'more' ? 1 + (row.blocking % 3) : 1 + (row.item.id % 4))
  for (let rows = 0; rows <= 40; rows++) {
    expect(rowsHeight(bandRows(items, rows, heightOf), heightOf), `${rows}`).toBeLessThanOrEqual(rows)
  }
})

test('the fold counts each row once and each summary it tries once, however long the list', () => {
  const items = Array.from({ length: 60 }, (_, k) => item(k + 1))
  let counted = 0
  const rows = bandRows(items, 20, () => {
    counted++
    return 1
  })
  expect(rows).toHaveLength(20)
  expect(rows[19]).toMatchObject({ kind: 'more' })
  expect(counted).toBeLessThanOrEqual(2 * items.length)
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

test('the width rule gives the column a third of the band, rounded down, never under 32, and the human list the rest; each list\'s layout width is one column short of its box while both draw', () => {
  expect(bandWidths(96, 2, waiting(1))).toEqual({ human: { box: 64, layout: 63 }, claude: { box: 32, layout: 31 } })
  expect(bandWidths(120, 2, waiting(1))).toEqual({ human: { box: 80, layout: 79 }, claude: { box: 40, layout: 39 } })
  expect(bandWidths(155, 2, waiting(1))).toEqual({ human: { box: 104, layout: 103 }, claude: { box: 51, layout: 50 } })
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

test('no human items: an item in flight draws the column alone at its width, however narrow the band, laid out in all of it, and queued items alone draw nothing', () => {
  expect(bandWidths(40, 0, flying(1))).toEqual({ human: null, claude: { box: 32, layout: 32 } })
  expect(bandWidths(120, 0, [...waiting(2), ...flying(1)])).toEqual({ human: null, claude: { box: 40, layout: 40 } })
  expect(bandWidths(20, 0, flying(1))).toEqual({ human: null, claude: { box: 20, layout: 20 } })
  expect(bandWidths(120, 0, waiting(2))).toEqual({ human: null, claude: null })
  expect(bandWidths(120, 0, [])).toEqual({ human: null, claude: null })
})

test('the margin is one column off each box while both lists draw and none otherwise; the box widths, the 96 two-list width, the 32 floor and the 64 the human list keeps are unchanged', () => {
  const todos: [string, TodoItem[]][] = [['none', []], ['queued', waiting(2)], ['in flight', flying(2)], ['both', [...flying(1), ...waiting(1)]]]
  for (const [name, todo] of todos) {
    for (const humans of [0, 2]) {
      for (let columns = 1; columns <= 300; columns++) {
        const { human, claude } = bandWidths(columns, humans, todo)
        const where = `${name}, ${humans} human, ${columns} columns`
        if (human !== null && claude !== null) {
          // Both lists: the box widths sum to the band, the column is a third rounded down and at least 32, and the human list keeps at least 64.
          expect(human.box + claude.box, where).toBe(columns)
          expect(claude.box, where).toBe(Math.max(32, Math.floor(columns / 3)))
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

test('the column\'s height is its header and every in-flight row, and the queued rows fill what is left of the height the column is given', () => {
  expect(columnHeight([])).toBe(1)
  expect(columnHeight(waiting(4))).toBe(1)
  expect(columnHeight([...flying(3), ...waiting(4)])).toBe(4)
  // The queued rows start where columnHeight ends: a height one over it leaves one row.
  const todo = [...flying(3), ...waiting(4)]
  expect(titles(claudeRows(todo, columnHeight(todo)))).toEqual(['f1', 'f2', 'f3'])
  expect(titles(claudeRows(todo, columnHeight(todo) + 1))).toEqual(['f1', 'f2', 'f3', '+4 queued'])
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

// A plain to-do's row texts as ui.ts's builder makes them, with the id 12: its open control, then what the pressed control says and the undo button.
const plain = (over: Partial<RowTexts> = {}): RowTexts => ({ prefix: '  #12 ', title: 'Fix it', open: '[✓]', said: ['✓ ', '✓ replied '], undo: '[↶ 3s]', sent: '✓ sent', ...over })

// Every state a row reaches: open, pressed in each way it can say its answer, and sent.
const statesOf = (layout: RowLayout) => [layout.open, ...layout.pressed, layout.sent]
// The lines each state takes, in that order.
const linesOf = (layout: RowLayout): number[] => statesOf(layout).map(state => state.widths.length)

// What the placement rule puts where, worked out from the room alone and apart from rowLayout. A control sits on its title's line when the title keeps ten
// columns there beside the id and the row's open control (the space before a control counted; a decision's open control is none), whatever the title's
// length and in a list of any width; a state moves under the title only when its own control would leave the title no column. For each state: its place,
// the lines it takes, and the width of the box its title is set in, the room it wraps in, when it wraps there or is wider than it.
type Placed = { place: 'beside' | 'below'; lines: number; title: number | null }
const placedBy = (row: RowTexts, width: number): Placed[] => {
  const line = width - displayColumns(row.prefix)
  const room = (control: string): number => line - (control === '' ? 0 : 1 + displayColumns(control))
  const boxed = (wide: number): number | null => {
    const [first = '', ...more] = wrapText(row.title, wide)
    return more.length > 0 || displayColumns(first) > wide ? wide : null
  }
  // The control on the title's line in each state, the words that go under the title instead, and the undo button beside their first line.
  const states = [
    { control: row.open, words: row.open, undo: '' },
    ...row.said.map(said => ({ control: `${said}${row.undo}`, words: said, undo: row.undo })),
    { control: row.sent, words: row.sent, undo: '' },
  ]
  return states.map(({ control, words, undo }): Placed => {
    if (room(row.open) >= 10 && room(control) >= 1) return { place: 'beside', lines: wrapText(row.title, room(control)).length, title: boxed(room(control)) }
    const under = words === '' ? 0 : wrapText(words, Math.max(1, line - displayColumns(undo))).length
    return { place: 'below', lines: wrapText(row.title, line).length + under, title: boxed(line) }
  })
}

// The layout's states against the rule's: where each control sits, the lines each state takes, which titles are boxed and how wide, that no line is
// wider than the list, and that the control's line is the open control's in every state but the one whose own control leaves the title no column.
const checkAgainstRule = (row: RowTexts, width: number, where: string): void => {
  const layout = rowLayout(row, width)
  const states = statesOf(layout)
  const want = placedBy(row, width)
  expect(states.length, where).toBe(want.length)
  states.forEach((state, k) => {
    expect({ place: state.place, lines: state.widths.length, title: state.title }, `${where}, state ${k}`).toEqual(want[k])
    for (const w of state.widths) expect(w <= width, `${where}, state ${k}: ${w}`).toBe(true)
  })
  const line = width - displayColumns(row.prefix)
  const controls = [row.open, ...row.said.map(said => `${said}${row.undo}`), row.sent]
  states.forEach((state, k) => {
    const noColumn = line - 1 - displayColumns(controls[k] ?? '') < 1
    expect(state.place === layout.open.place || noColumn, `${where}, state ${k} moved`).toBe(true)
  })
}

// The control kinds the sweeps cover, and the titles each is drawn with: a short one, one wider than a list under 64, one wider than any list, and one
// holding a line break.
const KINDS: Partial<RowTexts>[] = [
  { open: '[✓]', said: ['✓ ', '✓ replied '] },
  { open: `[✓ ${'x'.repeat(24)}]`, said: [`✓ ${'x'.repeat(24)} `, '✓ replied '] },
  { open: '[✓] [✗]', said: ['✓ yes ', '✗ no ', '✓ replied '] },
  { open: '', said: ['✓ Use sqlite ', `✓ ${'an option label '.repeat(8)}`, '✓ replied '] },
]
const titlesOf = (kind: Partial<RowTexts>): string[] =>
  [
    'Fix it',
    'A title that is longer than the list and has a pneumonoultramicroscopic word',
    'Review the deliberately long wrapping title of the first plain to-do item here'.repeat(2),
    'Ask the owner first\nthen the one who wrote the long title that wraps in a narrow list',
  ].map(title => (kind.open === '' ? `${title} […]` : title))

test('in a list of 20 a plain to-do with a two-digit id keeps its control on its title\'s line and one with a three-digit id draws it below, a title of one short word included', () => {
  expect(rowLayout(plain(), 20).open.place).toBe('beside')
  expect(rowLayout(plain({ prefix: '• #12 ' }), 20).open.place).toBe('beside')
  expect(rowLayout(plain({ prefix: '  #123 ' }), 20).open.place).toBe('below')
  // `Hi` and `  #123 [✓]` fit 20 columns on one line, yet the room for a title there is 9, under the ten that keep a control beside it.
  expect(rowLayout(plain({ title: 'Hi', prefix: '  #12 ' }), 20).open.place).toBe('beside')
  const three = rowLayout(plain({ title: 'Hi', prefix: '  #123 ' }), 20)
  expect(three.open.place).toBe('below')
  // The title is its own line and the control the next: both indented 7.
  expect(three.open.widths).toEqual([7 + 2, 7 + 3])
})

test('handed 19, the layout width a margin leaves a box of 20, a plain to-do with a one-digit id keeps its control on its title\'s line and a two-digit id draws it below; handed 20, the two-digit id keeps it', () => {
  const title = 'A title long enough to wrap in the ten columns that are left'
  // The id takes 5 and `[✓]` with its space 4: the title keeps ten columns, set in a box of them.
  expect(rowLayout(plain({ prefix: '  #1 ', title }), 19).open).toMatchObject({ place: 'beside', title: 10 })
  expect(rowLayout(plain({ prefix: '  #1 ', title }), 18).open.place).toBe('below')
  expect(rowLayout(plain({ title }), 19).open.place).toBe('below')
  expect(rowLayout(plain({ title }), 20).open).toMatchObject({ place: 'beside', title: 10 })
})

test('the control sits on the title\'s line while the title keeps ten columns there beside the id and the open control, the space before the control counted', () => {
  // The id takes 6 and the control 3 and its space: 6 + 4 + 10 = 20.
  expect(rowLayout(plain(), 20).open.place).toBe('beside')
  expect(rowLayout(plain(), 19).open.place).toBe('below')
  // A labelled to-do at the label's maximum, 24 columns, whether ASCII or wide: 28 for its brackets and check, and the space.
  for (const label of ['x'.repeat(24), '中'.repeat(12)]) {
    const labelled = plain({ open: `[✓ ${label}]` })
    expect(rowLayout(labelled, 45).open.place).toBe('beside')
    expect(rowLayout(labelled, 44).open.place).toBe('below')
  }
  // A yes/no's two marks are 7 columns and the space: 6 + 8 + 10 = 24.
  expect(rowLayout(plain({ open: '[✓] [✗]' }), 24).open.place).toBe('beside')
  expect(rowLayout(plain({ open: '[✓] [✗]' }), 23).open.place).toBe('below')
})

test('a row that draws no control (a decision) counts only its id beside the title, so its control\'s line is the title\'s at every id width and list width', () => {
  for (const digits of [2, 3, 4]) {
    for (let width = 20; width <= 63; width++) {
      expect(rowLayout(plain({ open: '', prefix: `  #${'1'.repeat(digits)} ` }), width).open.place, `${digits} digits at ${width}`).toBe('beside')
    }
  }
})

test('the control sits beside its title while the title keeps ten columns there, whatever the title\'s length', () => {
  // The id takes 6 and the control `x` times 47 with its space 48: 54, leaving the title 10 at a list of 64.
  const wide = (columns: number, title: string): RowTexts => plain({ title, open: 'x'.repeat(columns) })
  const long = 'A title that is longer than the room the id and the control leave it'
  expect(rowLayout(wide(47, long), 64).open).toMatchObject({ place: 'beside', title: 10 })
  expect(rowLayout(wide(48, long), 64).open.place).toBe('below')
  // A title that would fit on the line with its control is placed by the room too: `Fix` and the control are 57 columns, which a list of 64
  // holds, and the room is 9 with the control at 48 and 10 at 47.
  expect(rowLayout(wide(47, 'Fix'), 64).open).toMatchObject({ place: 'beside', title: null, widths: [6 + 3 + 48] })
  expect(rowLayout(wide(48, 'Fix'), 64).open).toMatchObject({ place: 'below', title: null, widths: [6 + 3, 6 + 48] })
  expect(rowLayout(wide(48, 'Fix it now please'), 64).open.place).toBe('below')
})

test('a title with a word longer than the list: the row\'s lines are its tallest state\'s, as wrapped by hand, in a list of 20', () => {
  // A plain to-do #12 at a list of 20: its id takes 6, so the open control leaves the title 10 columns, the pressed `✓ [↶ 3s]` 5, a reply
  // `✓ replied [↶ 3s]` none (it goes under the title, which has 14 columns, its words 8 beside the undo button), and `✓ sent` 7.
  const hand = {
    open: ['Fix abcdef', 'ghijklmnop', 'qrstuvwxyz', ' now'],
    pressed: ['Fix a', 'bcdef', 'ghijk', 'lmnop', 'qrstu', 'vwxyz', ' now'],
    reply: ['Fix ', 'abcdefghijklmn', 'opqrstuvwxyz ', 'now', '✓ ', 'replied '],
    sent: ['Fix ', 'abcdefg', 'hijklmn', 'opqrstu', 'vwxyz ', 'now'],
  }
  const row = plain({ title: 'Fix abcdefghijklmnopqrstuvwxyz now' })
  expect(linesOf(rowLayout(row, 20))).toEqual([hand.open.length, hand.pressed.length, hand.reply.length, hand.sent.length])
  expect(rowLines(row, 20)).toBe(7)
})

test('a title with wide characters: the row\'s lines are its tallest state\'s, as wrapped by hand, in a list of 20', () => {
  // Two columns a character: the open control leaves 10 columns (5 characters), the pressed one 5 (2 characters), a reply goes under the title (7
  // characters a line, then its words in 8 columns), and `✓ sent` leaves 7 (3 characters).
  const hand = {
    open: ['部署新版本', '到生产环境'],
    pressed: ['部署', '新版', '本到', '生产', '环境'],
    reply: ['部署新版本到生', '产环境', '✓ ', 'replied '],
    sent: ['部署新', '版本到', '生产环', '境'],
  }
  const row = plain({ title: '部署新版本到生产环境' })
  expect(linesOf(rowLayout(row, 20))).toEqual([hand.open.length, hand.pressed.length, hand.reply.length, hand.sent.length])
  expect(rowLines(row, 20)).toBe(5)
})

test('a title holding a line break: the break starts a line, and the row\'s lines are its tallest state\'s, as wrapped by hand, in a list of 20', () => {
  // `Ask` is a line and `the owner` the next in 10 columns; in 5 the second wraps to `the ` and `owner`; a reply goes under the title (two lines, then its
  // words in 8 columns, two lines); in 7 the second wraps the same.
  const hand = {
    open: ['Ask', 'the owner'],
    pressed: ['Ask', 'the ', 'owner'],
    reply: ['Ask', 'the owner', '✓ ', 'replied '],
    sent: ['Ask', 'the ', 'owner'],
  }
  const row = plain({ title: 'Ask\nthe owner' })
  expect(linesOf(rowLayout(row, 20))).toEqual([hand.open.length, hand.pressed.length, hand.reply.length, hand.sent.length])
  expect(rowLines(row, 20)).toBe(4)
  // The title wraps, so it is set in a box of the room the open control leaves it.
  expect(rowLayout(row, 20).open).toMatchObject({ place: 'beside', title: 10, widths: [20, 6 + 9] })
})

test('a labelled to-do whose control sits below its title: the row\'s lines are the title\'s and the tallest control state\'s, as wrapped by hand, in a list of 20', () => {
  // #1 at a list of 20: the id takes 5, so the open control `[✓ Go with sqlite]` (18, and its space) leaves the title no room and drops below. Every
  // line is then indented 5 and has 15 columns: the title takes one, the open control two, the pressed one two with the undo button's 6 columns beside
  // its words (9 left for them), a reply two, and `✓ sent` one.
  const hand = {
    title: ['Pick a db'],
    open: ['[✓ Go with ', 'sqlite]'],
    pressed: ['✓ Go with', ' sqlite '],
    reply: ['✓ replied', ' '],
    sent: ['✓ sent'],
  }
  const row = plain({ prefix: '  #1 ', title: 'Pick a db', open: '[✓ Go with sqlite]', said: ['✓ Go with sqlite ', '✓ replied '] })
  const layout = rowLayout(row, 20)
  expect(statesOf(layout).map(state => state.place)).toEqual(['below', 'below', 'below', 'below'])
  expect(linesOf(layout)).toEqual([hand.open, hand.pressed, hand.reply, hand.sent].map(under => hand.title.length + under.length))
  expect(rowLines(row, 20)).toBe(3)
})

test('a decision pressed with a reply: the title wraps beside no control open and under the pressed control\'s words, as wrapped by hand, in a list of 20', () => {
  // #12 at a list of 20, no open control: the title keeps 14 columns open, so its control's line is the title's; pressed with an option, or with a reply,
  // the control would leave it none and goes under the title (14 columns, its words 8 beside the undo button); `✓ sent` leaves 7.
  const hand = {
    open: ['Pick a store ', '[…]'],
    option: ['Pick a store ', '[…]', '✓ Use ', 'sqlite '],
    reply: ['Pick a store ', '[…]', '✓ ', 'replied '],
    sent: ['Pick a ', 'store ', '[…]'],
  }
  const row = plain({ title: 'Pick a store […]', open: '', said: ['✓ Use sqlite ', '✓ replied '] })
  const layout = rowLayout(row, 20)
  expect(layout.open.place).toBe('beside')
  expect(statesOf(layout).map(state => state.place)).toEqual(['beside', 'below', 'below', 'beside'])
  expect(linesOf(layout)).toEqual([hand.open.length, hand.option.length, hand.reply.length, hand.sent.length])
  expect(rowLines(row, 20)).toBe(4)
})

test('a labelled to-do at the maximum label width with a title that wraps beside it, in a list of 69 beside the column: the row\'s lines are its tallest state\'s, as wrapped by hand', () => {
  // `• #2 ` takes 5 and the open control `[✓ Approve the migration ok]` (28) with its space 29, leaving the title 35: two lines. Pressed it says its
  // answer in full beside the undo button, 34 with its space, leaving 30: three lines. A reply leaves 47, `✓ sent` 57: two lines each.
  const hand = {
    open: ['Second to-do with a labelled ', 'control and a wrapping title too'],
    pressed: ['Second to-do with a labelled ', 'control and a wrapping title ', 'too'],
    reply: ['Second to-do with a labelled control and a ', 'wrapping title too'],
    sent: ['Second to-do with a labelled control and a wrapping title', ' too'],
  }
  const row = plain({
    prefix: '• #2 ',
    title: 'Second to-do with a labelled control and a wrapping title too',
    open: '[✓ Approve the migration ok]',
    said: ['✓ Approve the migration ok ', '✓ replied '],
    undo: '[↶ 3s]',
  })
  expect(linesOf(rowLayout(row, 69))).toEqual([hand.open.length, hand.pressed.length, hand.reply.length, hand.sent.length])
  expect(rowLines(row, 69)).toBe(3)
  expect(rowLayout(row, 69).open).toMatchObject({ place: 'beside', title: 35 })
  expect(rowLayout(row, 69).pressed[0]).toMatchObject({ place: 'beside', title: 30 })
})

test('a title that wraps beside its control is a box the room wide that the id and the control leave, so the control keeps the list\'s edge; one that fits takes the columns it needs', () => {
  // #12 (6 columns) with a title of 6: the open control and its space take 4 more, the pressed `✓ [↶ 3s]` and its space 9, `✓ sent` and its space 7.
  const layout = rowLayout(plain({ title: 'Fix it' }), 20)
  expect(layout.open).toMatchObject({ place: 'beside', title: null, widths: [16] })
  // The pressed title wraps in 5 columns, to `Fix ` and `it`: the box is 5 wide with the control after it, and the line after is the id and `it`.
  expect(layout.pressed[0]).toMatchObject({ place: 'beside', title: 5, widths: [20, 8] })
  expect(layout.sent).toMatchObject({ place: 'beside', title: null, widths: [19] })
})

test('a row that fits its list on one line is placed as it always was: no box for its title, and its widths are the columns it needs', () => {
  const layout = rowLayout(plain({ title: 'Fix it' }), 70)
  expect(layout.open).toMatchObject({ place: 'beside', title: null, widths: [6 + 6 + 4] })
  // Pressed, the control says its answer in full beside the undo button: `✓ [↶ 3s]`, then `✓ replied [↶ 3s]`.
  expect(layout.pressed.map(state => state.widths)).toEqual([[6 + 6 + 9], [6 + 6 + 17]])
  expect(layout.sent).toMatchObject({ place: 'beside', title: null, widths: [19] })
})

test('a title that wraps beside no control (an open decision) is set in a box of the line the id leaves it, so the surface wraps it where the layout does; one that fits is the button itself', () => {
  const title = 'A decision whose title is longer than the line it is drawn on in a list of forty columns'
  const open = rowLayout(plain({ open: '', title }), 40).open
  expect(open).toMatchObject({ place: 'beside', title: 34 })
  expect(open.widths).toEqual(wrapText(title, 34).map(row => 6 + displayColumns(row)))
  expect(open.widths.length).toBeGreaterThan(1)
  expect(rowLayout(plain({ open: '', title: 'Pick a db […]' }), 40).open).toMatchObject({ place: 'beside', title: null, widths: [6 + 13] })
})

test('a title under its control is set in a box of the line the id leaves it when it wraps there, and is the button itself when it fits', () => {
  // #1 at a list of 20: the labelled control leaves the title no room, so it is under the title, which has the 15 columns past the id.
  const labelled = plain({ prefix: '  #1 ', open: '[✓ Go with sqlite]', said: ['✓ Go with sqlite ', '✓ replied '] })
  // The title wraps to `Pick a database` (15) and ` for the cache` (14); the control to `[✓ Go with ` (11) and `sqlite]` (7).
  const long = rowLayout({ ...labelled, title: 'Pick a database for the cache' }, 20)
  expect(long.open).toMatchObject({ place: 'below', title: 15, widths: [5 + 15, 5 + 14, 5 + 11, 5 + 7] })
  const short = rowLayout({ ...labelled, title: 'Pick a db' }, 20)
  expect(short.open).toMatchObject({ place: 'below', title: null, widths: [5 + 9, 5 + 11, 5 + 7] })
  // A decision draws no control, so a list too narrow to leave its title ten columns past the id has nothing to put under it: the title alone, boxed.
  const narrow = rowLayout(plain({ open: '', title: 'Pick a store […]' }), 12).open
  expect(narrow).toMatchObject({ place: 'below', title: 6, widths: wrapText('Pick a store […]', 6).map(row => 6 + displayColumns(row)) })
})

test('a state moves under the title only when its own control would leave the title no column: the exception to the open control\'s place', () => {
  const pressedAt = (label: number, width: number) =>
    rowLayout(plain({ prefix: '  #1 ', title: 'Pick a store […]', open: '', said: [`✓ ${'x'.repeat(label)} `], undo: '[↶ 5s]' }), width).pressed[0]
  // The id takes 5; the pressed control is `✓ `, the label, a space and the undo button's 6, and its own space before it: 10 and the label. A list of
  // 64 leaves the title 1 column with a label of 48 and none with 49.
  expect(pressedAt(48, 64)).toMatchObject({ place: 'beside', title: 1 })
  expect(pressedAt(49, 64)?.place).toBe('below')
  // A wide character is two columns, wider than that room: its title is still set in the box of one.
  const wide = plain({ prefix: '  #1 ', title: '漢', open: '', said: [`✓ ${'x'.repeat(48)} `], undo: '[↶ 5s]' })
  expect(rowLayout(wide, 64).pressed[0]).toMatchObject({ place: 'beside', title: 1, widths: [64] })
  // A plain to-do #12 at a list of 22: open `[✓]` leaves its title 12 and `✓ [↶ 3s]` 7, `✓ replied [↶ 3s]` none, and `✓ sent` 9.
  const layout = rowLayout(plain(), 22)
  expect(statesOf(layout).map(state => state.place)).toEqual(['beside', 'beside', 'below', 'beside'])
})

test('in every full-width list from 20 to 63 every control kind in every state is placed by the open control\'s room alone and takes the lines and the title box the rule gives it, at an id of one to four digits', () => {
  for (const kind of KINDS) {
    for (const title of titlesOf(kind)) {
      for (const digits of [1, 2, 3, 4]) {
        for (let width = 20; width <= 63; width++) {
          const row = plain({ ...kind, title, prefix: `• #${'1'.repeat(digits)} ` })
          checkAgainstRule(row, width, `${kind.open} ${digits} digits at ${width}: ${title}`)
        }
      }
    }
  }
})

test('at every list from 64 to 120 every control kind in every state is placed by the open control\'s room alone, takes the lines and the title box the rule gives it, and fits the list; an open control sits beside its title', () => {
  for (const kind of KINDS) {
    for (const title of titlesOf(kind)) {
      for (const digits of [1, 2, 3, 4]) {
        for (let width = 64; width <= 120; width++) {
          const row = plain({ ...kind, title, prefix: `• #${'1'.repeat(digits)} ` })
          const where = `${kind.open} ${digits} digits at ${width}: ${title}`
          checkAgainstRule(row, width, where)
          // An open control is at most 28 columns, so it always leaves the title ten.
          expect(rowLayout(row, width).open.place, where).toBe('beside')
        }
      }
    }
  }
})

test('a list of 64 or more keeps a row that fits one line on one line with its control beside its title, as it did before the rule', () => {
  for (const kind of KINDS) {
    for (const digits of [1, 2, 3, 4]) {
      const prefix = `• #${'1'.repeat(digits)} `
      for (const width of [64, 70, 100, 120]) {
        const row = plain({ ...kind, prefix, title: kind.open === '' ? 'Pick a db […]' : 'Fix it' })
        const layout = rowLayout(row, width)
        // A title of one short word beside the open control, and beside the pressed one when it too fits the line.
        expect(layout.open, `${width}`).toMatchObject({ place: 'beside', title: null })
        expect(layout.open.widths, `${width}`).toHaveLength(1)
      }
    }
  }
})

test('the pressed control of a decision with an option label of any length stays beside its title while the title keeps a column there, and goes under it otherwise, at every list from 64 to 120', () => {
  const title = 'Pick a store […]'
  for (const labelColumns of [10, 30, 45, 60, 100, 150, 400]) {
    // Words of four letters, so the label wraps wherever the room puts it.
    const label = Array.from({ length: Math.ceil(labelColumns / 5) }, () => 'word').join(' ')
    const said = `✓ ${label} `
    const row = plain({ prefix: '  #1 ', title, open: '', said: [said], undo: '[↶ 5s]' })
    for (let width = 64; width <= 120; width++) {
      const where = `${labelColumns} at ${width}`
      const layout = rowLayout(row, width)
      const pressed = layout.pressed[0]
      // The id takes 5; the pressed control, its space before it and its undo button take the rest, and the title keeps what is left.
      const room = width - 5 - (1 + said.length + 6)
      expect(pressed?.place, where).toBe(room >= 1 ? 'beside' : 'below')
      // The decision draws no control until it is pressed, and sent says `✓ sent`.
      expect(layout.open.place, where).toBe('beside')
      checkAgainstRule(row, width, where)
      if (room >= 1) {
        // Beside, the title wraps in the room the control leaves it, boxed when it wraps there.
        const rows = wrapText(title, room)
        expect(pressed?.title, where).toBe(rows.length > 1 ? room : null)
        expect(pressed?.widths.length, where).toBe(rows.length)
      } else if (pressed !== undefined) {
        // Under the title, which takes its lines first, the words wrap beside the undo button: a box of the room the button leaves.
        const sayRoom = width - 5 - 6
        const rows = wrapText(said, sayRoom).length
        expect(pressed.said, where).toBe(rows > 1 ? sayRoom : null)
        expect(pressed.widths.length, where).toBe(wrapText(title, width - 5).length + rows)
      }
    }
  }
})

test('a decision pressed with an option label of 150 columns at a list of 64: the words wrap beside the undo button under the title, as wrapped by hand', () => {
  // Thirty words of four letters (149 columns), the check and a space before them and a space after: 152. The id takes 5, so the words have
  // 59 columns under the title and 53 beside the undo button's 6: ten words and the check on the first line (52 columns with the space after
  // the tenth), ten on the second (50), and ten and the space after the last on the third (50).
  const said = `✓ ${Array.from({ length: 30 }, () => 'word').join(' ')} `
  const row = plain({ prefix: '  #1 ', title: 'Pick a store […]', open: '', said: [said], undo: '[↶ 5s]' })
  const layout = rowLayout(row, 64)
  expect(layout.pressed[0]).toMatchObject({ place: 'below', title: null, said: 53, widths: [5 + 16, 5 + 53 + 6, 5 + 50, 5 + 50] })
  expect(rowLines(row, 64)).toBe(4)
})

test('a control wider than its line goes under the title and wraps there, whatever the id: an open control of 70 columns at a list of 64', () => {
  const row = plain({ prefix: '  #1 ', title: 'Pick a db', open: `[✓ ${'word '.repeat(13)}x]` })
  const layout = rowLayout(row, 64)
  expect(layout.open.place).toBe('below')
  // Under the title the control wraps in the 59 columns past the id.
  expect(layout.open.widths.every(w => w <= 64)).toBe(true)
  expect(layout.open.widths.length).toBeGreaterThan(2)
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
