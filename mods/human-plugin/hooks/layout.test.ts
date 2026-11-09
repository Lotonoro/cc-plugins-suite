import { expect, test } from 'claude-code/testing'
import { bandDraws, bandRows, bandWidths, claudeRows, columnHeight, cutTitle, cutToColumns, headerLines, humanFoldRows, rowLayout, wrapText, type ClaudeRow, type Control, type RowTexts } from './layout'
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

// Code points written as numbers, so no editor or encoding changes a joiner or a variation selector that draws as nothing.
const cps = (...codes: number[]): string => String.fromCodePoint(...codes)
const JOINER = cps(0x200d)
const FAMILY = cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466)

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

test('a joiner is never the last thing kept: the family of four then `x` is its first member and an ellipsis at 3, and its first two members at 5', () => {
  const man = cps(0x1f468)
  expect(cutToColumns(`${FAMILY}x`, 3)).toBe(`${man}…`)
  expect(cutToColumns(`${FAMILY}x`, 3).includes(JOINER)).toBe(false)
  expect(cutToColumns(`${FAMILY}x`, 5)).toBe(`${cps(0x1f468, 0x200d, 0x1f469)}…`)
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
]

test('whatever the text and the room, the cut is the longest start of the text, in whole code points and not ending on a joiner, that leaves a column for the ellipsis, and it measures at most the room', () => {
  for (const text of SAMPLES) {
    const points = [...text]
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
      // The longest start that fits the room less the ellipsis and does not end on a joiner, found by trying every start.
      let want = ''
      for (let n = 0; n <= points.length; n++) {
        const start = points.slice(0, n).join('')
        if (displayColumns(start) <= room - 1 && !start.endsWith(JOINER)) want = start
      }
      expect(got, where).toBe(`${want}…`)
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
// such. A control's column is the widest of its states and the space before it. The answers here are ASCII, so a text's length is its columns.
const cut = (text: string, columns: number): string => (text.length <= columns ? text : `${text.slice(0, columns - 1)}…`)
const oracle = (row: RowTexts, width: number): { rung: number; answer: number; control: number; room: number } => {
  const prefix = displayColumns(row.prefix)
  const control = (squeezed: boolean, answer: number): number => {
    const drawn = (one: Control): string => `${one.before}${cut(one.answer, answer)}${one.after}`
    const states = [drawn(row.open), ...(squeezed ? [row.squeezed] : row.pressed.map(drawn)), row.sent].filter(text => text !== '')
    return 1 + Math.max(...states.map(displayColumns))
  }
  const rungs = [false, true].flatMap(squeezed => Array.from({ length: 24 }, (_, k) => ({ squeezed, answer: 24 - k })).map(rung => ({ ...rung, control: control(rung.squeezed, rung.answer) })))
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

test('a title is cut by columns at its room, with its decision\'s marker, the line break already joined: wide characters and the family of four are never split', () => {
  const row = (title: string, marker: string): RowTexts => ({ ...rowFor(marker === '' ? PLAIN : DECISION_19), title, marker })
  // A plain to-do at 42 has a control column of 17 and a prefix of 6: a room of 19.
  expect(rowLayout(row('日本語のタイトルは長い', ''), 42).title).toBe('日本語のタイトルは…')
  expect(rowLayout(row(`${FAMILY} ${FAMILY} ${FAMILY}`, ''), 42).title).toBe(`${FAMILY} ${FAMILY} …`)
  // A decision with an option of 19 columns at 96 has a control column of 29 and a room of 61: the title and its marker whole.
  expect(rowLayout(row('Pick the release train for the next deploy', ' […]'), 96).title).toBe('Pick the release train for the next deploy […]')
  const tight = rowLayout(row('Pick the release train for the next deploy', ' […]'), 42)
  expect(tight.title.endsWith('… […]')).toBe(true)
  expect(displayColumns(tight.title)).toBe(tight.room)
})

test('below the narrowest width the row cannot be one line within the list: the control takes its squeezed 9 columns and the title keeps one, whatever the list', () => {
  for (const kind of KINDS) {
    for (const width of [1, 8, 12, 15]) {
      const got = rowLayout(rowFor(kind), width)
      expect([got.rung, got.control, got.room], `${kind.name} at ${width}`).toEqual([3, 9, 1])
    }
    // At the prefix and 10 the title keeps exactly one column.
    expect(rowLayout(rowFor(kind), 16).room, kind.name).toBe(1)
  }
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
