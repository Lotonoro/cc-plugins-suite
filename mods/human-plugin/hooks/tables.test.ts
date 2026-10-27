import { expect, test } from 'claude-code/testing'
import { briefParts, tablesAsLists } from './tables'

test('a basic table becomes one bullet per body row, its first cell bold, the prose around it kept', () => {
  const md = 'Pick one.\n| Store | Cost | Ops |\n|---|---|---|\n| sqlite | low | none |\n| postgres | high | team |\nThen decide.'
  expect(tablesAsLists(md)).toBe('Pick one.\n\n- **sqlite**: Cost: low; Ops: none\n- **postgres**: Cost: high; Ops: team\n\nThen decide.')
})

test('a table with no leading or trailing pipes converts the same way', () => {
  expect(tablesAsLists('Store | Cost\n--- | ---\nsqlite | low')).toBe('- **sqlite**: Cost: low')
})

test('alignment colons in the delimiter row are no cells and do not stop the table', () => {
  expect(tablesAsLists('| a | b | c |\n|:--|:-:|--:|\n| x | y | z |')).toBe('- **x**: b: y; c: z')
})

test('an escaped pipe is a character inside its cell, not a cell break', () => {
  expect(tablesAsLists('| Expr | Note |\n|---|---|\n| a \\| b | or |')).toBe('- **a | b**: Note: or')
})

test('a short row uses the cells it has; a long row appends its extra cells with no header', () => {
  const md = '| Store | Cost | Ops |\n|---|---|---|\n| sqlite |\n| postgres | high | team | extra |'
  expect(tablesAsLists(md)).toBe('- **sqlite**\n- **postgres**: Cost: high; Ops: team; extra')
})

test('a header-only table becomes one bullet listing its headers', () => {
  expect(tablesAsLists('| Store | Cost |\n|---|---|')).toBe('- Store; Cost')
})

test('two tables with prose between them each convert, and the prose is untouched', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |\nBetween them.\n| c | d |\n|---|---|\n| 3 | 4 |'
  expect(tablesAsLists(md)).toBe('- **1**: b: 2\n\nBetween them.\n\n- **3**: d: 4')
})

test('a table inside a backtick fence is left alone', () => {
  const md = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```'
  expect(tablesAsLists(md)).toBe(md)
})

test('a backtick run whose info string holds a backtick opens no fence, so a table after it is still a table', () => {
  expect(tablesAsLists('```x```\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('```x```\n\n- **1**: b: 2')
})

test('a tilde fence is closed only by a tilde, so a backtick line inside it does not end it', () => {
  const md = '~~~\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~\n| c | d |\n|---|---|\n| 3 | 4 |'
  expect(tablesAsLists(md)).toBe('~~~\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~\n\n- **3**: d: 4')
})

test('a table in indented code is left alone', () => {
  const md = '    | a | b |\n    |---|---|\n    | 1 | 2 |'
  expect(tablesAsLists(md)).toBe(md)
})

test('a pipe line not followed by a valid delimiter row is not a table', () => {
  const md = '| a | b |\n| just prose |\n| a | b |\n|---|'
  expect(tablesAsLists(md)).toBe(md)
})

test('text with no table comes back identical', () => {
  const md = 'Plain prose.\n\n- a list item | with a pipe\n# Heading\n\n`code | span`'
  expect(tablesAsLists(md)).toBe(md)
})

test('an empty middle cell keeps every later cell under its own header', () => {
  expect(tablesAsLists('| Store | Cost | Ops |\n|---|---|---|\n| sqlite | | none |')).toBe('- **sqlite**: Ops: none')
})

test('an empty first cell leaves the row unbolded and keeps the other cells under their headers', () => {
  expect(tablesAsLists('| Store | Cost | Ops |\n|---|---|---|\n|  | low | none |')).toBe('- Cost: low; Ops: none')
})

test('an empty last cell is dropped and the cells before it keep their headers', () => {
  expect(tablesAsLists('| Store | Cost | Ops |\n|---|---|---|\n| sqlite | low | |')).toBe('- **sqlite**: Cost: low')
})

test('two empty cells in a row are both dropped and the cell after them keeps its header', () => {
  expect(tablesAsLists('| Store | Cost | Ops | Owner |\n|---|---|---|---|\n| sqlite | | | team |')).toBe('- **sqlite**: Owner: team')
})

test('a brief with no fenced code is one prose part', () => {
  expect(briefParts('Pick one.\n\nBoth work.')).toEqual([{ kind: 'prose', text: 'Pick one.\n\nBoth work.' }])
})

test('a fenced block is a code part between the prose around it, its body the lines inside the fences', () => {
  const brief = 'Run this:\n\n```sh\nls -la\ncd /tmp\n```\n\nThen say so.'
  expect(briefParts(brief)).toEqual([
    { kind: 'prose', text: 'Run this:' },
    { kind: 'code', text: '```sh\nls -la\ncd /tmp\n```', body: 'ls -la\ncd /tmp' },
    { kind: 'prose', text: 'Then say so.' },
  ])
})

test('a tilde fence and two blocks in a row each make a code part; a fence left open runs to the end', () => {
  expect(briefParts('~~~\na\n~~~\n```\nb\n```')).toEqual([
    { kind: 'code', text: '~~~\na\n~~~', body: 'a' },
    { kind: 'code', text: '```\nb\n```', body: 'b' },
  ])
  expect(briefParts('Try:\n```\nmake\nmake test')).toEqual([
    { kind: 'prose', text: 'Try:' },
    { kind: 'code', text: '```\nmake\nmake test', body: 'make\nmake test' },
  ])
})

test('an indented fence, as in a list item, copies its lines without that indent, as markdown draws them', () => {
  expect(briefParts('1. Run:\n   ```py\n   if x:\n       y()\n  z\n   ```')).toEqual([
    { kind: 'prose', text: '1. Run:' },
    { kind: 'code', text: '   ```py\n   if x:\n       y()\n  z\n   ```', body: 'if x:\n    y()\nz' },
  ])
})

test('a longer closing fence closes a block, and a shorter one is a line inside it', () => {
  expect(briefParts('````\n```\nx\n`````')).toEqual([{ kind: 'code', text: '````\n```\nx\n`````', body: '```\nx' }])
})
