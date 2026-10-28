import { expect, test } from 'claude-code/testing'
import { bandRows } from './layout'
import type { Item } from '../types'

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
