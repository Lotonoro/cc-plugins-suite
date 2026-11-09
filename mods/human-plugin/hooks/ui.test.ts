import { expect, test } from 'claude-code/testing'
import { act, displayColumns, listText, normalizeItem } from './items'
import { answerOf, doneNotice, expire, press, reply, type Form } from './done'
import { headerLines, rowLayout, rowLines, wrapText, type RowLayout, type RowTexts } from './layout'
import { band, pane, paneRows, rowTexts, toolLine, type Handlers, type Table, type View } from './ui'
import type { Item, Store, TodoItem, Turn } from '../types'

// A table whose constructors return their props, so a test reads the tree the drawing built.
type Node = { type: string; children?: unknown[]; wrap?: string; [k: string]: unknown }
const table = {
  Box: (p: Record<string, unknown>) => ({ type: 'Box', ...p }),
  Text: (p: Record<string, unknown>) => ({ type: 'Text', ...p }),
  Button: (p: Record<string, unknown>) => ({ type: 'Button', ...p }),
  Markdown: (p: Record<string, unknown>) => ({ type: 'Markdown', ...p }),
} as unknown as Table
// The same table with the `Input` a terminal or desktop surface has: the mobile table above has none.
const withInput = { ...table, Input: (p: Record<string, unknown>) => ({ type: 'Input', ...p }) } as unknown as Table
const handlers: Handlers = { pick: () => {}, done: () => {}, more: () => {}, reply: () => {}, copy: () => {} }
const submit = (field: Node | undefined, text: string): void => (field?.onSubmit as (value: string, e: unknown) => void)(text, {})
const view = (): View => ({ maxRows: 50, now: 0, windowMs: 5000 })

const texts = (node: unknown): string[] => {
  if (typeof node === 'string') return [node]
  if (typeof node !== 'object' || node === null) return []
  const n = node as Node
  return (n.children ?? []).flatMap(texts)
}
const nodes = (node: unknown, type: string): Node[] => {
  if (typeof node !== 'object' || node === null) return []
  const n = node as Node
  return [...(n.type === type ? [n] : []), ...(n.children ?? []).flatMap(c => nodes(c, type))]
}

// A detail over 200 characters, several sentences, ending in a marker the drawing must not cut.
const DETAIL = 'We compared two stores on the same data. Reads were slower on sqlite under load. Writes kept up on both. ' +
  'The tie-break is operations: the team already runs postgres. Recheck the numbers before the freeze. Last sentence.'
const item: Item = {
  id: 1,
  title: 'Pick a db',
  detail: DETAIL,
  blocking: true,
  createdAt: 0,
  state: 'open',
  pressedAt: null,
  note: 'still open',
  agent: null,
  unread: false,
  options: [], answer: null, yesno: false, replied: false, doneLabel: null, thread: [], windowTurns: [], windowChanged: false,
}
const store: Store = { items: [item], next: 2, term: null }

test('the pane draws the shown item alone: no other item\'s title or button, and its whole detail and controls', () => {
  const two: Store = { items: [item, { ...item, id: 2, title: 'Pick a cache', detail: 'Second brief.', blocking: false, note: null }], next: 3, term: null }
  const tree = pane(table, handlers, two, { ...view(), selected: 2 })
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['Second brief.'])
  expect(texts(tree).join('')).not.toContain('We compared')
  expect(JSON.stringify(tree)).not.toContain('Pick a db')
  expect(nodes(tree, 'Button').map(n => n.key)).toEqual(['done-2'])
})

test('the pane draws a brief\'s table as a list, and the stored detail keeps the table', () => {
  const detail = 'Pick one.\n\n| Store | Cost |\n|---|---|\n| sqlite | low |'
  const stored: Store = { items: [{ ...item, detail, note: null }], next: 2, term: null }
  const tree = pane(table, handlers, stored, { ...view(), selected: 1 })
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['Pick one.\n\n- **sqlite**: Cost: low'])
  expect(stored.items[0]?.detail).toBe(detail)
})

test('with nothing selected the pane shows the first item', () => {
  const tree = pane(table, handlers, store, { ...view(), selected: null })
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual([DETAIL])
})

test('a selection whose item is gone draws no other item: the pane is closing, and it shows nothing', () => {
  const three: Store = { items: [1, 3, 5].map(id => ({ ...item, id, title: `t${id}`, detail: `brief ${id}` })), next: 6, term: null }
  const gone = pane(table, handlers, three, { ...view(), selected: 2 })
  expect(nodes(gone, 'Markdown')).toEqual([])
  expect(nodes(gone, 'Button')).toEqual([])
})

test('an empty list draws the empty-state text', () => {
  expect(texts(pane(table, handlers, { items: [], next: 2, term: null }, { ...view(), selected: null })).join('')).toBe('Nothing to do for you.')
})
// A decision brief as the steering asks for it: the question on its first line, then sections.
const BRIEF = ['**Which store for the cache?**', '', '## Recommendation', 'Postgres.', '', '## Options', '- A: sqlite. Costs: slower reads under load.', '- B: postgres. Costs: one more service.'].join('\n')

test('the band shows no detail: a brief is read in the pane, which draws all of it', () => {
  const briefed: Store = { items: [{ ...item, detail: BRIEF, note: null }], next: 2, term: null }
  expect(texts(band(table, handlers, briefed, view())).join('')).not.toContain('Which store')
  expect(nodes(pane(table, handlers, briefed, view()), 'Markdown').map(n => n.text)).toEqual([BRIEF])
})

test('a waiting item shows a check and an undo countdown on its done control', () => {
  const waiting: Store = { items: [{ ...item, options: [], answer: null, state: 'done-waiting', pressedAt: 0 }], next: 2, term: null }
  const tree = band(table, handlers, waiting, { maxRows: 50, now: 2000, windowMs: 5000 })
  expect(texts(tree).join('')).toContain('✓')
  expect(nodes(tree, 'Button').some(b => b.label === '[↶ 3s]' && b.plain === true)).toBe(true)
})

test('the band\'s buttons are plain glyphs in brackets: a check to press done, and a row\'s title is plain', () => {
  const tree = band(table, handlers, { items: [store.items[0] as Item, { ...item, id: 2, blocking: false }], next: 3, term: null }, view())
  const buttons = nodes(tree, 'Button')
  const done = buttons.find(b => b.key === 'done-1')
  expect(done?.label).toBe('[✓]')
  expect(done?.plain).toBe(true)
  expect(buttons.find(b => b.key === 'title-1')?.plain).toBe(true)
})

test('a title and its done button are separated by a space, and the control does not shrink', () => {
  const tree = band(table, handlers, store, view())
  const row = nodes(tree, 'Box').find(n => (n.children as Node[]).some(k => k.key === 'title-1')) as Node
  const kids = row.children as Node[]
  const at = kids.findIndex(k => k.key === 'title-1')
  expect(kids[at + 1]).toMatchObject({ type: 'Box', flexShrink: 0 })
  expect((kids[at + 1]?.children as Node[])[0]).toEqual({ type: 'Text', children: [' '] })
  expect((kids[at + 1]?.children as Node[])[1]?.key).toBe('done-1')
})

test('the band row\'s id and control do not shrink, so a narrow row shrinks the title alone', () => {
  const tree = band(table, handlers, store, view())
  const row = nodes(tree, 'Box').find(n => n.key === 'item-1') as Node
  const kids = row.children as Node[]
  expect(kids[0]).toMatchObject({ type: 'Box', flexShrink: 0 })
  expect(texts(kids[0]).join('')).toContain('#1 ')
  const at = kids.findIndex(k => k.key === 'title-1')
  expect(kids[at]?.flexShrink).toBeUndefined()
  expect(kids[at + 1]).toMatchObject({ type: 'Box', flexShrink: 0 })
})

test('the fixed labels beside text that can wrap do not shrink: the header chip, an answer\'s marker, and an undo button', () => {
  const holder = (tree: unknown, key: string) => nodes(tree, 'Box').find(box => (box.children ?? []).some(c => (c as Node).key === key))
  const header = (band(table, handlers, store, view()) as Node).children?.[0] as Node
  expect(header.children?.[0]).toMatchObject({ type: 'Box', flexShrink: 0 })
  const decision: Item = { ...item, detail: '', options: [{ label: 'Use sqlite', description: '', recommended: false }] }
  const answerRow = nodes(pane(table, handlers, { items: [decision], next: 2, term: null }, { ...view(), selected: 1 }), 'Box').find(box => box.key === 'answer-row-1-0')
  expect((answerRow?.children as Node[])[0]).toMatchObject({ type: 'Box', flexShrink: 0 })
  const waiting = band(table, handlers, { items: [{ ...item, state: 'done-waiting', pressedAt: 0, options: [], answer: null }], next: 2, term: null }, { maxRows: 50, now: 2000, windowMs: 5000 })
  expect(holder(waiting, 'done-1')).toMatchObject({ flexShrink: 0 })
})

const at = (id: number, blocking: boolean): Item => ({ ...item, id, blocking, detail: '', note: null, options: [], answer: null })

test('the summary row is a button that opens the pane on the first folded item, a blocking one first, and says what it folds', () => {
  const crowded: Store = { items: [1, 2, 3, 4, 5].map(id => at(id, true)).concat(at(6, false)), next: 7, term: null }
  const opened: number[] = []
  const press: Handlers = { ...handlers, more: id => void opened.push(id) }
  const tree = band(table, press, crowded, { maxRows: 4, now: 0, windowMs: 5000 })
  const more = nodes(tree, 'Button').find(b => b.key === 'band-more')
  expect(more).toMatchObject({ plain: true, label: '+3 blocking · +1 more […]' })
  expect(nodes(tree, 'Text').filter(n => texts(n).join('').includes('#')).length).toBe(2)
  const onPress = more?.onPress as () => void
  onPress()
  expect(opened).toEqual([3])
})

test('a summary of only non-blocking items opens the pane on the first folded one, and is dim', () => {
  const opened: number[] = []
  const press: Handlers = { ...handlers, more: id => void opened.push(id) }
  const tree = band(table, press, { items: [at(1, false), at(2, false), at(3, false)], next: 4, term: null }, { ...view(), maxRows: 3 })
  const more = nodes(tree, 'Button').find(b => b.key === 'band-more')
  expect(more).toMatchObject({ label: '+2 more […]', dimColor: true })
  const onPress = more?.onPress as () => void
  onPress()
  expect(opened).toEqual([2])
})

test('a summary holding a blocking item sits in a warning box; one of only non-blocking items sits in none', () => {
  const holderOfMore = (tree: unknown) => nodes(tree, 'Box').find(box => (box.children ?? []).some(c => (c as Node).key === 'band-more'))
  const blocked = band(table, handlers, { items: [at(1, true), at(2, true), at(3, false)], next: 4, term: null }, { ...view(), maxRows: 2 })
  expect(holderOfMore(blocked)?.backgroundColor).toBe('warning')
  const quiet = band(table, handlers, { items: [at(1, false), at(2, false), at(3, false)], next: 4, term: null }, { ...view(), maxRows: 3 })
  expect(holderOfMore(quiet)?.backgroundColor).toBeUndefined()
})

test('the header is the chip and the count only: it has no button, with items shown or folded', () => {
  const folded = band(table, handlers, { items: [at(1, true), at(2, false)], next: 3, term: null }, { ...view(), maxRows: 2 })
  expect(nodes((folded as Node).children?.[0], 'Button')).toEqual([])
  expect(buttonKeys(folded)).not.toContain('details')
  expect(buttonKeys(band(table, handlers, { items: [{ ...at(1, true), detail: 'One line.' }], next: 2, term: null }, view()))).not.toContain('details')
})

test('a title gets […] only for a decision with options, whose answers are in the pane alone; a to-do or a yes/no never does, even with a brief or a note', () => {
  const titleOf = (one: Item) => nodes(band(table, handlers, { items: [one], next: 2, term: null }, view()), 'Button').find(b => b.key === 'title-1')?.label
  expect(titleOf(at(1, true))).toBe('Pick a db')
  expect(titleOf({ ...at(1, true), detail: 'One line.' })).toBe('Pick a db')
  expect(titleOf({ ...at(1, true), note: 'still open' })).toBe('Pick a db')
  expect(titleOf({ ...at(1, true), yesno: true })).toBe('Pick a db')
  expect(titleOf({ ...at(1, true), yesno: true, detail: 'Ship it?' })).toBe('Pick a db')
  expect(titleOf({ ...at(1, true), options: [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }] })).toBe('Pick a db […]')
})

const yesNo = (over: Partial<Item> = {}): Item => ({ ...at(1, true), yesno: true, ...over })

test('a yes/no row draws its yes and no marks after the title, plain', () => {
  const tree = band(table, handlers, { items: [yesNo()], next: 2, term: null }, view())
  expect(buttonKeys(tree)).toEqual(['title-1', 'yes-1', 'no-1'])
  const marks = nodes(tree, 'Button').filter(b => b.key === 'yes-1' || b.key === 'no-1')
  expect(marks.map(b => b.label)).toEqual(['[✓]', '[✗]'])
  expect(marks.every(b => b.plain === true)).toBe(true)
})

test('a yes/no row\'s marks answer yes and no, through the done handler', () => {
  const answers: (string | null)[] = []
  const press: Handlers = { ...handlers, done: (_id, answer) => void answers.push(answer) }
  const tree = band(table, press, { items: [yesNo()], next: 2, term: null }, view())
  const pressKey = (key: string) => (nodes(tree, 'Button').find(b => b.key === key)?.onPress as () => void)()
  pressKey('yes-1')
  pressKey('no-1')
  expect(answers).toEqual(['yes', 'no'])
})

test('a yes/no question\'s marks are plain and bare in the pane, as the band\'s are', () => {
  const shown = pane(table, handlers, { items: [yesNo({ detail: 'Brief.' })], next: 2, term: null }, { ...view(), selected: 1 })
  for (const key of ['yes-1', 'no-1']) {
    const mark = nodes(shown, 'Button').find(b => b.key === key)
    expect(mark).toMatchObject({ plain: true })
    expect(mark?.variant).toBeUndefined()
    expect(nodes(shown, 'Box').find(box => (box.children ?? []).some(c => c === mark))?.backgroundColor).toBeUndefined()
  }
  const bandTree = band(table, handlers, { items: [yesNo()], next: 2, term: null }, view())
  expect(nodes(bandTree, 'Box').find(box => (box.children ?? []).some(c => (c as Node).key === 'yes-1'))?.backgroundColor).toBeUndefined()
})

test('a yes/no answer pressed draws its answer and the undo countdown in place of both marks', () => {
  const waiting = yesNo({ state: 'done-waiting', pressedAt: 0, answer: 'no' })
  const tree = band(table, handlers, { items: [waiting], next: 2, term: null }, { maxRows: 50, now: 2000, windowMs: 5000 })
  expect(buttonKeys(tree)).toEqual(['title-1', 'done-1'])
  expect(nodes(tree, 'Button').find(b => b.key === 'done-1')?.label).toBe('[↶ 3s]')
  expect(texts(tree).join('')).toContain('✗ no ')
  expect(texts(tree).join('')).not.toContain('✓ no ')
})

test('a yes/no answer pressed yes draws a check in its undo window, and a no a cross', () => {
  const yes = band(table, handlers, { items: [yesNo({ state: 'done-waiting', pressedAt: 0, answer: 'yes' })], next: 2, term: null }, { maxRows: 50, now: 2000, windowMs: 5000 })
  expect(texts(yes).join('')).toContain('✓ yes ')
  expect(texts(yes).join('')).not.toContain('✗')
})

test('the header is a chip filled in warning while a blocking item is open, and in permission otherwise; the count is plain', () => {
  const chip = (tree: unknown) => nodes(tree, 'Text').find(n => texts(n).join('').includes('To do for you'))
  const quiet = band(table, handlers, { items: [at(1, false)], next: 2, term: null }, view())
  expect(chip(quiet)?.backgroundColor).toBe('permission')
  expect(chip(quiet)?.color).toBe('inverseText')
  const blocked = band(table, handlers, { items: [at(1, false), at(2, true)], next: 3, term: null }, view())
  expect(chip(blocked)?.backgroundColor).toBe('warning')
  const count = nodes(blocked, 'Text').find(n => texts(n).join('').includes('2 open'))
  expect(count?.backgroundColor).toBeUndefined()
})

test('the chip reads To do for you until the agent states a term, and To do for the term once it does; a term the agent cleared reads To do for you', () => {
  const chipText = (tree: unknown) => nodes(tree, 'Text').map(n => texts(n).join('')).find(text => text.includes('To do for'))
  expect(chipText(band(table, handlers, store, view()))).toBe(' To do for you ')
  expect(chipText(band(table, handlers, { ...store, term: 'owner' }, view()))).toBe(' To do for owner ')
  expect(chipText(band(table, handlers, { ...store, term: 'Team lead' }, view()))).toBe(' To do for Team lead ')
  expect(chipText(band(table, handlers, { ...store, term: '' }, view()))).toBe(' To do for you ')
})

test('the pane draws no term: an empty list still reads Nothing to do for you, and an item\'s pane shows none', () => {
  expect(texts(pane(table, handlers, { items: [], next: 2, term: 'owner' }, { ...view(), selected: null })).join('')).toBe('Nothing to do for you.')
  expect(JSON.stringify(pane(table, handlers, { ...store, term: 'owner' }, { ...view(), selected: 1 }))).not.toContain('owner')
})

test('the shown item draws no frame of its own inside the pane\'s', () => {
  const tree = pane(table, handlers, store, { ...view(), selected: 1 })
  expect(nodes(tree, 'Box').filter(n => n.borderStyle !== undefined)).toEqual([])
})

test('the detail draws its header, then its note, then the brief, and its controls last', () => {
  const tree = pane(table, handlers, store, view())
  const box = nodes(tree, 'Box').find(n => n.key === 'pane-1')
  const parts = (box?.children ?? []).map(c => {
    const n = c as Node
    if (n.type === 'Markdown') return 'markdown'
    if (nodes(n, 'Button').length > 0) return 'control'
    return texts(n).join('').startsWith('note:') ? 'note' : 'header'
  })
  expect(parts).toEqual(['header', 'note', 'markdown', 'control'])
})
const LONG_BRIEF = 'We compared two stores.\n\nReads were slower on sqlite under load.\n\nThe tie-break is operations.'
test('a call to the mod\'s tool draws one line: the action, the id, and for an add the title and whether it blocks', () => {
  expect(toolLine({ input: { action: 'add', title: 'Pick a db', detail: LONG_BRIEF, blocking: true }, output: 'added #3', isRunning: false, isErrored: false }))
    .toBe('human-plugin: added #3 Pick a db (blocking)')
  expect(toolLine({ input: { action: 'add', title: 'Note', detail: LONG_BRIEF }, output: 'added #4', isRunning: false, isErrored: false }))
    .toBe('human-plugin: added #4 Note')
  expect(toolLine({ input: { action: 'update', id: 3, note: 'recheck' }, output: 'updated #3', isRunning: false, isErrored: false }))
    .toBe('human-plugin: updated #3')
  expect(toolLine({ input: { action: 'remove', id: 2 }, output: 'removed #2', isRunning: false, isErrored: false }))
    .toBe('human-plugin: removed #2')
})

test('a term note in an add\'s or an update\'s reply is left out of the transcript row: each row reads as the same call without a term', () => {
  const row = (input: unknown, output: string) => toolLine({ input, output, isRunning: false, isErrored: false })
  const add = { action: 'add', title: 'Pick a db', blocking: true }
  expect(row(add, 'added #3 (term set to "owner")')).toBe('human-plugin: added #3 Pick a db (blocking)')
  expect(row(add, 'added #3')).toBe('human-plugin: added #3 Pick a db (blocking)')
  expect(row({ action: 'add', title: 'Pick (a) db' }, 'added #4 (term not used: only the main agent sets it)')).toBe('human-plugin: added #4 Pick (a) db')
  expect(row({ action: 'add', title: 'Sub ask', term: 'x'.repeat(21) }, 'added #5 (term not used: only the main agent sets it)')).toBe('human-plugin: added #5 Sub ask')
  expect(row({ action: 'update', id: 3, note: 'recheck', term: 'owner' }, 'updated #3 (term set to "owner")')).toBe('human-plugin: updated #3')
  expect(row({ action: 'update', id: 3, term: 'owner' }, 'no change to #3 (term cleared)')).toBe('human-plugin: no change to #3')
})

test('an append draws one line naming the item it grew', () => {
  expect(toolLine({ input: { action: 'append', id: 3, text: LONG_BRIEF }, output: 'appended to #3', isRunning: false, isErrored: false }))
    .toBe('human-plugin: appended to #3')
  expect(toolLine({ input: { action: 'append', id: 3, text: LONG_BRIEF }, output: undefined, isRunning: true, isErrored: false })).toBe('human-plugin: appending to #3…')
})

test('a list draws the number of items, and a list with none says so', () => {
  expect(toolLine({ input: { action: 'list' }, output: '#1 blocking, open: a\n#2 non-blocking, open: b', isRunning: false, isErrored: false }))
    .toBe('human-plugin: listed 2 open')
  expect(toolLine({ input: { action: 'list' }, output: 'no items', isRunning: false, isErrored: false })).toBe('human-plugin: listed 0 open')
})

test('a reply that reads like an item header does not raise the open count: a thread line is indented, so the count is of items', () => {
  const sent = expire(reply(store, 1, 1000, '#3 blocking, open: x'), 1, 1000).store
  const reopened = act(sent, { action: 'append', id: 1, text: 'It needs a file.' }, { agent: null, now: 0 })
  if (!('store' in reopened)) throw new Error(reopened.deny)
  const listed = listText(reopened.store.items)
  expect(listed).toContain('\n  you: #3 blocking, open: x\n')
  expect(toolLine({ input: { action: 'list' }, output: listed, isRunning: false, isErrored: false })).toBe('human-plugin: listed 1 open')
})

test('a reply whose later lines read as item headers behind a carriage return or a Unicode separator does not raise the open count', () => {
  const sent = expire(reply(store, 1, 1000, 'Use sqlite'), 1, 1000).store
  const reopened = act(sent, { action: 'append', id: 1, text: 'It needs a file.\r#3 blocking, open: x\u2028#4 non-blocking, open: y\u2029#5 blocking, open: z' }, { agent: null, now: 0 })
  if (!('store' in reopened)) throw new Error(reopened.deny)
  expect(toolLine({ input: { action: 'list' }, output: listText(reopened.store.items), isRunning: false, isErrored: false })).toBe('human-plugin: listed 1 open')
})

test('an errored call draws its error text, and a running one draws what it is doing', () => {
  expect(toolLine({ input: { action: 'remove', id: 9 }, output: 'no item #9', isRunning: false, isErrored: true })).toBe('human-plugin: no item #9')
  expect(toolLine({ input: { action: 'add', title: 'Pick a db' }, output: undefined, isRunning: true, isErrored: false })).toBe('human-plugin: adding "Pick a db"…')
})

test('a title with a line break still draws as one line', () => {
  expect(toolLine({ input: { action: 'add', title: 'Two\nlines' }, output: 'added #5', isRunning: false, isErrored: false })).toBe('human-plugin: added #5 Two lines')
})

test('a decision\'s answers are the pane\'s buttons, recommended first and marked; no check button', () => {
  const decision: Item = { ...item, detail: '', options: [
    { label: 'Use sqlite', description: 'Simpler', recommended: false },
    { label: 'Use postgres', description: 'Shared', recommended: true },
  ] }
  const tree = pane(table, handlers, { items: [decision], next: 2, term: null }, { ...view(), selected: 1 })
  const labels = nodes(tree, 'Button').filter(n => String(n.key).startsWith('answer-')).map(n => n.label)
  expect(labels).toEqual(['[Use postgres (recommended)]', '[Use sqlite]'])
  expect(nodes(tree, 'Button').some(n => n.key === 'done-1')).toBe(false)
})

test('each answer is a keyed row: a ▸ in the inline-code colour, then a plain button labelled in brackets that lights in that colour and bold on hover', () => {
  const decision: Item = { ...item, detail: '', options: [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: true },
  ] }
  const tree = pane(table, handlers, { items: [decision], next: 2, term: null }, { ...view(), selected: 1 })
  const rows = nodes(tree, 'Box').filter(box => String(box.key).startsWith('answer-row-'))
  expect(rows.length).toBe(2)
  for (const row of rows) {
    const kids = row.children as Node[]
    expect(kids[0]).toMatchObject({ type: 'Box', flexShrink: 0 })
    expect((kids[0]?.children as Node[])[0]).toEqual({ type: 'Text', color: 'suggestion', children: ['▸'] })
    expect((kids[0]?.children as Node[])[1]).toEqual({ type: 'Text', children: [' '] })
    expect(kids[1]).toMatchObject({ type: 'Button', plain: true, hover: { color: 'suggestion', bold: true } })
    expect(kids[1]?.variant).toBeUndefined()
    expect(String(kids[1]?.key).startsWith('answer-')).toBe(true)
  }
  expect(rows.map(row => (row.children as Node[])[1]?.label)).toEqual(['[Use postgres (recommended)]', '[Use sqlite]'])
})

test('no pane control sits in a background Box: the answers, the done and undo controls, and the marks', () => {
  const decision: Item = { ...item, detail: '', options: [{ label: 'Use sqlite', description: '', recommended: false }] }
  const trees = [
    pane(table, handlers, { items: [decision], next: 2, term: null }, { ...view(), selected: 1 }),
    pane(table, handlers, { items: [at(1, true)], next: 2, term: null }, view()),
    pane(table, handlers, { items: [{ ...at(1, true), state: 'done-waiting', pressedAt: 0 }], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 }),
    pane(table, handlers, { items: [yesNo({ detail: 'Brief.' })], next: 2, term: null }, { ...view(), selected: 1 }),
  ]
  for (const tree of trees) {
    expect(nodes(tree, 'Button').length).toBeGreaterThan(0)
    expect(nodes(tree, 'Box').filter(box => box.backgroundColor !== undefined && (box.children ?? []).some(c => (c as Node).type === 'Button'))).toEqual([])
  }
})

test('an answer draws its label only: no option description is in the pane', () => {
  const decision: Item = { ...item, detail: '', options: [
    { label: 'Use sqlite', description: 'Simpler to run', recommended: false },
    { label: 'Use postgres', description: 'Shared with the team', recommended: true },
  ] }
  const drawn = JSON.stringify(pane(table, handlers, { items: [decision], next: 2, term: null }, { ...view(), selected: 1 }))
  expect(drawn).not.toContain('Simpler to run')
  expect(drawn).not.toContain('Shared with the team')
})

test('a decision\'s answers are not in the band: answering means opening the item', () => {
  const decision: Item = { ...item, detail: '', options: [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: true },
  ] }
  const tree = band(table, handlers, { items: [decision], next: 2, term: null }, view())
  expect(nodes(tree, 'Button').some(n => String(n.key).startsWith('answer-') || n.key === 'done-1')).toBe(false)
})

test('a plain item is a plain check in the pane, with or without a brief', () => {
  const plain: Item = { ...item, detail: '', options: [] }
  expect(nodes(pane(table, handlers, { items: [plain], next: 2, term: null }, { ...view(), selected: 1 }), 'Button').find(n => n.key === 'done-1')?.label).toBe('[✓]')
  expect(nodes(pane(table, handlers, { items: [item], next: 2, term: null }, { ...view(), selected: 1 }), 'Button').find(n => n.key === 'done-1')?.label).toBe('[✓]')
})

test('a labelled to-do\'s check reads its label, in the band and in the pane, and its press passes the label on', () => {
  const labelled: Item = { ...item, detail: '', doneLabel: 'Go with sqlite' }
  const calls: [number, string | null][] = []
  const h: Handlers = { ...handlers, done: (id, answer) => calls.push([id, answer]) }
  const bandButton = nodes(band(table, h, { items: [labelled], next: 2, term: null }, view()), 'Button').find(b => b.key === 'done-1')
  expect(bandButton?.label).toBe('[✓ Go with sqlite]')
  const paneButton = nodes(pane(table, h, { items: [labelled], next: 2, term: null }, { ...view(), selected: 1 }), 'Button').find(b => b.key === 'done-1')
  expect(paneButton?.label).toBe('[✓ Go with sqlite]')
  ;(bandButton?.onPress as () => void)()
  ;(paneButton?.onPress as () => void)()
  expect(calls).toEqual([[1, 'Go with sqlite'], [1, 'Go with sqlite']])
})

test('an item an older release stored draws a bare check: its done label normalizes to none', () => {
  const old = normalizeItem({ id: 1, title: 'Pick a db', detail: '', blocking: false, createdAt: 5, state: 'open' }) as Item
  const drawn = band(table, handlers, { items: [old], next: 2, term: null }, view())
  expect(nodes(drawn, 'Button').find(b => b.key === 'done-1')?.label).toBe('[✓]')
})

test('a bare to-do\'s press passes no label, so the notice is the bare one', () => {
  const calls: [number, string | null][] = []
  const h: Handlers = { ...handlers, done: (id, answer) => calls.push([id, answer]) }
  const button = nodes(band(table, h, { items: [{ ...item, detail: '' }], next: 2, term: null }, view()), 'Button').find(b => b.key === 'done-1')
  ;(button?.onPress as () => void)()
  expect(calls).toEqual([[1, null]])
})

test('a labelled to-do pressed draws its label beside the undo countdown, and a bare to-do draws no label', () => {
  const waiting: Item = { ...item, detail: '', doneLabel: 'Go with sqlite', state: 'done-waiting', pressedAt: 0, answer: 'Go with sqlite' }
  const drawn = JSON.stringify(pane(table, handlers, { items: [waiting], next: 2, term: null }, { ...view(), selected: 1 }))
  expect(drawn).toContain('✓ Go with sqlite ')
  expect(drawn).toContain('[↶ 5s]')
  const bare = JSON.stringify(band(table, handlers, { items: [{ ...item, detail: '' }], next: 2, term: null }, view()))
  expect(bare).toContain('[✓]')
  expect(bare).not.toContain('Go with sqlite')
})

test('an answer pressed draws its label with the countdown, and the band\'s check is plain', () => {
  const waiting: Item = { ...item, detail: '', state: 'done-waiting', pressedAt: 0, answer: 'Use postgres', options: [{ label: 'Use postgres', description: '', recommended: true }, { label: 'Use sqlite', description: '', recommended: false }] }
  const drawn = JSON.stringify(pane(table, handlers, { items: [waiting], next: 2, term: null }, { ...view(), selected: 1 }))
  expect(drawn).toContain('✓ Use postgres ')
  expect(drawn).toContain('[↶ 5s]')
  expect(drawn).not.toContain('Use sqlite')
})

test('a decision\'s title press reaches the pane for that item', () => {
  const decision: Item = { ...item, detail: 'One line.', blocking: true, options: [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: true },
  ] }
  const picked: [number, boolean][] = []
  const press: Handlers = { ...handlers, pick: (id, isSelected) => void picked.push([id, isSelected]) }
  const tree = band(table, press, { items: [decision], next: 2, term: null }, view())
  const titlePress = nodes(tree, 'Button').find(n => n.key === 'title-1')?.onPress as (() => void) | undefined
  titlePress?.()
  expect(picked).toEqual([[1, true]])
})

test('a band title says whether the pane shows its item, so a press on the shown item closes the pane; with none chosen the first is shown', () => {
  const picked: [number, boolean][] = []
  const press: Handlers = { ...handlers, pick: (id, isSelected) => void picked.push([id, isSelected]) }
  const two: Store = { items: [at(1, true), at(2, true)], next: 3, term: null }
  const press2 = (tree: unknown, key: string) => (nodes(tree, 'Button').find(n => n.key === key)?.onPress as () => void)()
  press2(band(table, press, two, { ...view(), selected: 2 }), 'title-1')
  press2(band(table, press, two, { ...view(), selected: 2 }), 'title-2')
  press2(band(table, press, two, { ...view(), selected: null }), 'title-1')
  expect(picked).toEqual([[1, false], [2, true], [1, true]])
})

// The band's buttons in the order the focus ring walks them.
const buttonKeys = (tree: unknown): string[] => nodes(tree, 'Button').map(b => String(b.key))

test('an item whose undo window has ended keeps its button, so the window ending moves no other button in the focus ring', () => {
  const buttons = (state: Item['state']): string[] => {
    const one: Item = { ...at(1, true), state, pressedAt: state === 'done-waiting' ? 0 : null }
    return buttonKeys(band(table, handlers, { items: [one, at(2, true)], next: 3, term: null }, view()))
  }
  expect(buttons('done-pending')).toEqual(buttons('done-waiting'))
})

test('the pane asks for the shown item alone: a short item is its header, control, reply field and detail line', () => {
  const short = { ...at(1, true), detail: 'One line.', note: null }
  expect(paneRows(short)).toBe(4)
})

test('the pane\'s rows grow with the shown brief\'s lines and its note, and not with the other items', () => {
  const long = { ...at(2, false), detail: LONG_BRIEF, note: 'still open' }
  const short = { ...at(1, true), detail: 'One line.', note: null }
  expect(paneRows(long)).toBe(1 + 1 + 1 + 1 + 5)
  expect(paneRows(short)).toBe(1 + 1 + 1 + 1)
})

test('a one-item list with no detail asks for the bare item, and no shown item asks for one row', () => {
  const bare = { ...at(1, true), detail: '', note: null }
  expect(paneRows(bare)).toBe(3)
  // A bare press's window draws its 'pressed done' turn, one row more than the bare item.
  expect(paneRows({ ...bare, state: 'done-waiting', pressedAt: 0 })).toBe(3)
  expect(paneRows(undefined)).toBe(1)
})

test('a whitespace-only brief is no brief: the title is bare, the pane asks for no brief row and draws no markdown', () => {
  const blank = { ...at(1, true), detail: '  \n ', note: null }
  const titleOf = nodes(band(table, handlers, { items: [blank], next: 2, term: null }, view()), 'Button').find(b => b.key === 'title-1')?.label
  expect(titleOf).toBe('Pick a db')
  expect(paneRows(blank)).toBe(3)
  expect(nodes(pane(table, handlers, { items: [blank], next: 2, term: null }, view()), 'Markdown')).toEqual([])
})

test('the done button draws its label as written in the pane: plain, so the terminal adds no brackets of its own', () => {
  const done = nodes(pane(table, handlers, { items: [at(1, true)], next: 2, term: null }, view()), 'Button').find(b => b.key === 'done-1')
  expect(done).toMatchObject({ plain: true, label: '[✓]' })
  expect(done?.variant).toBeUndefined()
})

test('the undo button in the pane is plain too: its countdown reads [↶ 3s] as written', () => {
  const waiting: Item = { ...at(1, true), state: 'done-waiting', pressedAt: 0 }
  const undo = nodes(pane(table, handlers, { items: [waiting], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 }), 'Button').find(b => b.key === 'done-1')
  expect(undo).toMatchObject({ plain: true, label: '[↶ 3s]' })
  expect(undo?.variant).toBeUndefined()
})

// The box that holds the item's done button, the one that carries the button's background.
const holderOf = (tree: unknown): Node | undefined => nodes(tree, 'Box').find(box => (box.children ?? []).some(c => (c as Node).key === 'done-1'))

test('the pane\'s done buttons sit bare, as the band\'s do', () => {
  const one = { items: [at(1, true)], next: 2, term: null }
  expect(holderOf(pane(table, handlers, one, view()))?.backgroundColor).toBeUndefined()
  expect(holderOf(band(table, handlers, one, view()))?.backgroundColor).toBeUndefined()
  const waiting: Item = { ...at(1, true), state: 'done-waiting', pressedAt: 0 }
  expect(holderOf(pane(table, handlers, { items: [waiting], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 }))?.backgroundColor).toBeUndefined()
})

test('a list reply counts its items, not its lines: two items with multi-line details are listed 2 open', () => {
  const reply = '#1 blocking, open: Pick a db - Which store?\n\nMore context.\n#2 non-blocking, open: Cache - one\ntwo\nthree'
  expect(toolLine({ input: { action: 'list' }, output: reply, isRunning: false, isErrored: false })).toBe('human-plugin: listed 2 open')
})

test('the pane asks for the rows the item draws, and the row a heading adds', () => {
  const briefed = { ...at(1, true), detail: '# Brief\n\nOne.\nTwo.', note: null }
  // The header (1), control (1), reply field (1), then four detail lines and the heading's extra row.
  expect(paneRows(briefed)).toBe(1 + 1 + 1 + 4 + 1)
})

test('the pane draws a one-line reply field after an open item\'s controls, keyed by the item', () => {
  const tree = pane(withInput, handlers, store, view())
  // No `value`: a redraw that set one would wipe the text the person is typing.
  expect(nodes(tree, 'Input').map(f => [f.key, f.placeholder, f.submitLabel, f.value])).toEqual([['reply-1', 'Reply…', 'send', undefined]])
  expect(((tree as Node).children as Node[]).at(-1)?.type).toBe('Input')
  expect(nodes(tree, 'Input')[0]?.autoFocus).toBeUndefined()
})

test('no reply field for an item whose press is in its undo window, or sent', () => {
  const waiting = { items: [{ ...item, state: 'done-waiting' as const, pressedAt: 0 }], next: 2, term: null }
  const sent = { items: [{ ...item, state: 'done-pending' as const }], next: 2, term: null }
  expect(nodes(pane(withInput, handlers, waiting, view()), 'Input')).toEqual([])
  expect(nodes(pane(withInput, handlers, sent, view()), 'Input')).toEqual([])
})

test('the band draws no reply field, on any surface', () => {
  expect(nodes(band(withInput, handlers, store, view()), 'Input')).toEqual([])
})

test('a surface whose table has no Input (mobile) draws the pane without a field, and keeps its controls', () => {
  const tree = pane(table, handlers, store, view())
  expect(nodes(tree, 'Input')).toEqual([])
  expect(nodes(tree, 'Button').map(b => b.key)).toEqual(['done-1'])
})

test('a reply submitted is trimmed and handed to reply; an empty or blank one is not', () => {
  const sent: [number, string][] = []
  const h: Handlers = { ...handlers, reply: (id, text) => sent.push([id, text]) }
  const field = nodes(pane(withInput, h, store, view()), 'Input')[0]
  submit(field, '  Use sqlite  ')
  submit(field, '')
  submit(field, ' \t ')
  expect(sent).toEqual([[1, 'Use sqlite']])
})

test('a reply of only U+00A0 is not sent: the field trims as JavaScript does, so U+00A0 around a reply is trimmed and alone is nothing', () => {
  const nbsp = String.fromCharCode(0xa0)
  const sent: [number, string][] = []
  const h: Handlers = { ...handlers, reply: (id, text) => sent.push([id, text]) }
  const field = nodes(pane(withInput, h, store, view()), 'Input')[0]
  submit(field, nbsp)
  expect(sent).toEqual([])
  submit(field, `${nbsp}Use sqlite${nbsp}`)
  expect(sent).toEqual([[1, 'Use sqlite']])
})

// The form a control of the pane answers with, by the control's own kind or place: a decision's answer by its place in the pane's order, a yes or a
// no by its kind, and a to-do's check as done, whose answer is its label or none.
const formOf = (key: string): Form => {
  if (key.startsWith('answer-')) return { kind: 'option', n: Number(key.split('-')[2]) + 1 }
  if (key.startsWith('yes-')) return { kind: 'yes' }
  if (key.startsWith('no-')) return { kind: 'no' }
  return { kind: 'done' }
}

// The form resolves on the store as the press leaves it, and once each window has ended both give the same item and the same notice.
const sameAsPress = (store: Store, form: Form, pressed: Store): void => {
  const resolved = answerOf(store, '1', form, 1000)
  expect(resolved.outcome.kind).toBe('applied')
  expect(expire(resolved.store, 1, 1000)).toEqual(expire(pressed, 1, 1000))
  expect(doneNotice(expire(resolved.store, 1, 1000).sent as Item)).toBe(doneNotice(expire(pressed, 1, 1000).sent as Item))
}

test('each answer the pane\'s controls send is a form the resolver applies, and gives the notice its press gives, for every kind of item', () => {
  const options = [
    { label: 'Use sqlite', description: '', recommended: false },
    { label: 'Use postgres', description: '', recommended: false },
    { label: 'Use mysql', description: '', recommended: true },
  ]
  for (const kind of [{ detail: '' }, { detail: '', doneLabel: 'Ship it' }, { detail: '', yesno: true }, { detail: '', options }] as Partial<Item>[]) {
    const store0: Store = { items: [{ ...item, ...kind }], next: 2, term: null }
    // The pane drawn afresh, its handlers recording what each control sends.
    const drawn = (sent: [number, string | null][], replies: [number, string][]) =>
      pane(withInput, { ...handlers, done: (id, answer) => void sent.push([id, answer]), reply: (id, text) => void replies.push([id, text]) }, store0, {
        ...view(),
        selected: 1,
      })
    const keys = nodes(drawn([], []), 'Button')
      .map(b => String(b.key))
      .filter(key => /^(answer-1-\d+|done-1|yes-1|no-1)$/.test(key))
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const sent: [number, string | null][] = []
      const tree = drawn(sent, [])
      ;(nodes(tree, 'Button').find(b => b.key === key)?.onPress as () => void)()
      expect(sent.length).toBe(1)
      sameAsPress(store0, formOf(key), press(store0, 1, 1000, sent[0]?.[1] ?? null))
    }
    const replies: [number, string][] = []
    submit(nodes(drawn([], replies), 'Input')[0], '  Use sqlite  ')
    expect(replies).toEqual([[1, 'Use sqlite']])
    sameAsPress(store0, { kind: 'reply', text: 'Use sqlite' }, reply(store0, 1, 1000, 'Use sqlite'))
  }
})

test('a reply in its undo window draws its text as a check, not a cross even on a yes or no, with the undo countdown', () => {
  const replied = { ...yesNo(), state: 'done-waiting' as const, pressedAt: 0, answer: 'no', replied: true }
  const tree = pane(table, handlers, { items: [replied], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 })
  expect(texts(tree).join('')).toContain('✓ replied: no')
  expect(texts(tree).join('')).not.toContain('✗')
  expect(nodes(tree, 'Button').map(b => [b.key, b.label])).toEqual([['done-1', '[↶ 3s]']])
})

test('the band\'s reply check names no reply text: a 200-character reply draws ✓ replied alone, and the pane draws it whole', () => {
  const long = 'Use the staging cache, not production, because ' + 'x'.repeat(150)
  const replied = { ...item, state: 'done-waiting' as const, pressedAt: 0, answer: long, replied: true }
  const bandTree = band(table, handlers, { items: [replied], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 })
  expect(texts(bandTree).join('')).toContain('✓ replied')
  expect(texts(bandTree).join('')).not.toContain('Use the staging cache')
  const paneTree = pane(table, handlers, { items: [replied], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 })
  expect(texts(paneTree).join('')).toContain(long)
})

test('the undo button of a running window calls done with no answer, which is what cancels it', () => {
  const calls: [number, string | null][] = []
  const h: Handlers = { ...handlers, done: (id, answer) => calls.push([id, answer]) }
  const waiting = { ...item, state: 'done-waiting' as const, pressedAt: 0, answer: 'Use sqlite' }
  const tree = pane(table, h, { items: [waiting], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 })
  ;(nodes(tree, 'Button').find(b => b.key === 'done-1')?.onPress as () => void)()
  expect(calls).toEqual([[1, null]])
})

test('the header counts the open items, and the sent ones by their own count: an item in its undo window is in neither', () => {
  const waiting = { ...at(2, false), state: 'done-waiting' as const, pressedAt: 0, answer: null }
  const sent = { ...at(3, false), state: 'done-pending' as const }
  const tree = band(table, handlers, { items: [at(1, false), waiting, sent], next: 4, term: null }, { ...view(), now: 1000 })
  const count = nodes(tree, 'Text').find(n => /\d+ open/.test(texts(n).join('')))
  expect(texts(count).join('')).toBe(' 1 open, 1 sent ')
})

test('the header is amber only while a blocking item is open: one already sent or in its undo window does not make the chip warning', () => {
  const chip = (tree: unknown) => nodes(tree, 'Text').find(n => texts(n).join('').includes('To do for you'))
  const sent = band(table, handlers, { items: [{ ...at(1, true), state: 'done-pending' as const }], next: 2, term: null }, view())
  expect(chip(sent)?.backgroundColor).toBe('permission')
  const waiting = band(table, handlers, { items: [{ ...at(1, true), state: 'done-waiting' as const, pressedAt: 0, answer: null }], next: 2, term: null }, { ...view(), now: 1000 })
  expect(chip(waiting)?.backgroundColor).toBe('permission')
})

test('a list counts the open items only: a sent or waiting item is listed, but is not counted', () => {
  const reply = '#1 blocking, open: Pick a db\n#2 non-blocking, done-pending: Cache\n#3 non-blocking, done-waiting: Ship'
  expect(toolLine({ input: { action: 'list' }, output: reply, isRunning: false, isErrored: false })).toBe('human-plugin: listed 1 open')
})

test('each fenced block in a brief has a copy button after it that copies the block\'s lines alone, on the pressing surface', () => {
  const copied: [string, unknown][] = []
  const h: Handlers = { ...handlers, copy: (text, surface) => void copied.push([text, surface]) }
  const brief = 'Run this:\n\n```sh\nls -la\ncd /tmp\n```\n\nThen this:\n\n```\nmake test\n```\n\nDone.'
  const tree = pane(table, h, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['Run this:', '```sh\nls -la\ncd /tmp\n```', 'Then this:', '```\nmake test\n```', 'Done.'])
  const copies = nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))
  expect(copies.map(b => [b.key, b.label, b.plain])).toEqual([['copy-1-1', '[copy]', true], ['copy-1-3', '[copy]', true]])
  for (const b of copies) (b.onPress as (press: { surface: string }) => void)({ surface: 'terminal' })
  expect(copied).toEqual([['ls -la\ncd /tmp', 'terminal'], ['make test', 'terminal']])
})

test('the pane asks for a row more for each copy button', () => {
  const plain = { ...item, detail: 'One.\nTwo.\nThree.', note: null }
  const coded = { ...item, detail: 'One.\n```\nTwo.\n```', note: null }
  expect(paneRows(coded)).toBe(paneRows({ ...plain, detail: 'One.\nTwo.\nThree.\nFour.' }) + 1)
})

// Six turns: the two oldest are folded, the last four whole.
const SIX: Turn[] = [
  { speaker: 'human', words: 'Use sqlite' },
  { speaker: 'agent', words: 'Noted.' },
  { speaker: 'human', words: 'And the cache?' },
  { speaker: 'agent', words: 'Redis.' },
  { speaker: 'human', words: 'Fine.' },
  { speaker: 'agent', words: 'Done with that.' },
]

test('an item with six turns draws its two older turns as one dim line each, then the last four whole, then its controls and reply field', () => {
  const tree = pane(withInput, handlers, { items: [{ ...item, detail: '', note: null, thread: SIX }], next: 2, term: null }, view())
  const kids = (tree as Node).children as Node[]
  expect(kids.slice(1).map(k => k.key ?? k.type)).toEqual(['turn-1-0', 'turn-1-1', 'turn-1-2', 'turn-1-3', 'turn-1-4', 'turn-1-5', 'done-1', 'reply-1'])
  expect(kids.slice(1, 3).map(k => [texts(k).join(''), nodes(k, 'Text')[0]?.dimColor, nodes(k, 'Text')[0]?.wrap])).toEqual([['you: Use sqlite', true, 'truncate-end'], ['agent: Noted.', true, 'truncate-end']])
  expect(kids.slice(3, 7).map(k => [texts(k).join(''), nodes(k, 'Markdown').map(m => m.text)])).toEqual([['you: And the cache?', []], ['agent:', ['Redis.']], ['you: Fine.', []], ['agent:', ['Done with that.']]])
})

test('a sent reply is drawn as the newest turn, just above its ✓ sent', () => {
  const sent: Item = { ...item, detail: '', note: null, state: 'done-pending', answer: 'Use sqlite', replied: true, thread: [{ speaker: 'agent', words: 'Which store?' }] }
  const tree = pane(withInput, handlers, { items: [sent], next: 2, term: null }, view())
  const kids = (tree as Node).children as Node[]
  expect(kids.slice(-2).map(k => k.key ?? k.type)).toEqual(['turn-1-1', 'done-1'])
  expect(texts(kids.at(-2)).join('')).toBe('you: Use sqlite')
  expect(nodes(tree, 'Button').find(b => b.key === 'done-1')?.label).toBe('✓ sent')
})

test('a reply in its undo window is drawn as the newest turn above its controls, with the agent turn it took after it', () => {
  const waiting: Item = { ...item, detail: '', note: null, state: 'done-waiting', pressedAt: 0, answer: 'Use sqlite', replied: true, windowTurns: [{ speaker: 'agent', words: 'Noted.' }] }
  const kids = (pane(withInput, handlers, { items: [waiting], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 }) as Node).children as Node[]
  expect(kids.length).toBe(4)
  expect(texts(kids[1]).join('')).toBe('you: Use sqlite')
  expect(nodes(kids[2], 'Markdown').map(m => m.text)).toEqual(['Noted.'])
  expect(nodes(kids[3], 'Button').map(b => b.key)).toEqual(['done-1'])
})

test('an agent turn with fenced blocks is drawn as a brief: a copy button under each block copies exactly its lines', () => {
  const copied: [string, unknown][] = []
  const h: Handlers = { ...handlers, copy: (text, surface) => void copied.push([text, surface]) }
  const turn: Turn = { speaker: 'agent', words: 'Run this:\n\n```sh\nls -la\ncd /tmp\n```\n\nThen this:\n\n```\nmake test\n```' }
  const tree = pane(table, h, { items: [{ ...item, detail: '', note: null, thread: [turn] }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['Run this:', '```sh\nls -la\ncd /tmp\n```', 'Then this:', '```\nmake test\n```'])
  const copies = nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))
  expect(copies.map(b => [b.key, b.label])).toEqual([['copy-turn-1-0-1', '[copy]'], ['copy-turn-1-0-3', '[copy]']])
  for (const b of copies) (b.onPress as (press: { surface: string }) => void)({ surface: 'terminal' })
  expect(copied).toEqual([['ls -la\ncd /tmp', 'terminal'], ['make test', 'terminal']])
})

// A Markdown text that opens with a fence (up to three columns in, as a block in a list item is cut) is drawn as code.
const FENCE = /^ {0,3}(`{3,}|~{3,})/

// The rows a drawn tree takes, counted from the tree as the surface lays it out: a column stacks its children and a row is as tall as its
// tallest; a text is a row a line; a Markdown block a row a line and one more under each heading, but a fenced block is code and has none;
// a button or a field is one row.
const drawnRows = (node: unknown): number => {
  const n = node as Node
  if (n.type === 'Text') return texts(n).join('').split('\n').length
  if (n.type === 'Markdown') {
    const text = String(n.text)
    const headings = FENCE.test(text) ? 0 : text.split('\n').filter(line => /^#{1,6}\s/.test(line)).length
    return text.split('\n').length + headings
  }
  if (n.type === 'Button' || n.type === 'Input') return 1
  const rows = (n.children ?? []).map(drawnRows)
  return n.flexDirection === 'column' ? rows.reduce((sum, r) => sum + r, 0) : Math.max(0, ...rows)
}

test('the pane\'s row request for an item with a thread equals the rows its drawn output takes, for text that does not wrap', () => {
  const thread: Turn[] = [
    { speaker: 'human', words: 'Use sqlite' },
    { speaker: 'agent', words: 'Noted.' },
    { speaker: 'human', words: 'Both.\nStill open?' },
    { speaker: 'agent', words: '# Plan\n\nRun this:\n\n```sh\nls -la\n# not a heading\n```\n\n| Store | Cost |\n|---|---|\n| sqlite | low |' },
    { speaker: 'human', words: 'Fine.' },
    { speaker: 'agent', words: 'Done.\n\nThanks.' },
  ]
  const one: Item = { ...item, detail: 'Brief.\n\nMore.', note: 'still open\nsecond line', thread }
  const decision: Item['options'] = [{ label: 'Postgres', description: '', recommended: true }, { label: 'sqlite', description: '', recommended: false }]
  const drawn = (shown: Item): number => drawnRows(pane(withInput, handlers, { items: [shown], next: 2, term: null }, view()))
  expect(paneRows(one)).toBe(drawn(one))
  expect(paneRows({ ...one, options: decision })).toBe(drawn({ ...one, options: decision }))
  const sent: Item = { ...one, options: decision, state: 'done-pending', answer: 'Postgres' }
  expect(paneRows(sent)).toBe(drawn(sent))
  const waiting: Item = { ...one, options: [], state: 'done-waiting', pressedAt: 0, answer: 'Postgres', replied: true, windowTurns: [{ speaker: 'agent', words: 'Also this.' }] }
  expect(paneRows(waiting)).toBe(drawn(waiting))
})

test('the pane\'s row request equals the drawn rows for fenced blocks in list items, in the brief and in a thread turn', () => {
  const nested = '# Options\n\n- a\n  - b\n    ```sh\n    # not a heading\n    ls\n    ```\n  - c\n\n1. step\n   ~~~\n   make\n   ~~~\n\nAfter.'
  const withTurn: Item = { ...item, detail: nested, note: null, thread: [{ speaker: 'human', words: 'Ok' }, { speaker: 'agent', words: nested }] }
  const drawn = (shown: Item): number => drawnRows(pane(withInput, handlers, { items: [shown], next: 2, term: null }, view()))
  expect(paneRows(withTurn)).toBe(drawn(withTurn))
  expect(paneRows({ ...withTurn, thread: [] })).toBe(drawn({ ...withTurn, thread: [] }))
})

test('the pane asks for the rows a reply in its undo window draws: its header, the reply as a turn, the agent turn it took, and the undo button', () => {
  const waiting: Item = { ...at(1, true), state: 'done-waiting', pressedAt: 0, answer: 'Use sqlite', replied: true, windowTurns: [{ speaker: 'agent', words: 'Noted.' }] }
  expect(paneRows(waiting)).toBe(1 + 1 + 2 + 1)
  expect(paneRows(waiting)).toBe(drawnRows(pane(withInput, handlers, { items: [waiting], next: 2, term: null }, { ...view(), now: 0, windowMs: 3000 })))
})

test('a fence in a second-level list item has a copy button, its block is drawn without the item\'s indent, and the pane asks for its row', () => {
  const copied: [string, unknown][] = []
  const h: Handlers = { ...handlers, copy: (text, surface) => void copied.push([text, surface]) }
  const brief = '- a\n  - b\n    ```sh\n    ls\n    ```'
  const tree = pane(table, h, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['- a\n  - b', '```sh\nls\n```'])
  const copies = nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))
  expect(copies.map(b => [b.key, b.label, b.plain])).toEqual([['copy-1-1', '[copy]', true]])
  for (const b of copies) (b.onPress as (press: { surface: string }) => void)({ surface: 'terminal' })
  expect(copied).toEqual([['ls', 'terminal']])
  const plain = { ...item, detail: '- a\n  - b\n    one\n    two\n    three', note: null }
  expect(paneRows({ ...item, detail: brief, note: null })).toBe(paneRows(plain) + 1)
})

test('a fence on a list marker\'s own line reaches the pane as one block that starts with its marker, and its copy holds only the lines inside', () => {
  const copied: [string, unknown][] = []
  const h: Handlers = { ...handlers, copy: (text, surface) => void copied.push([text, surface]) }
  const brief = '1. x\n   - ```sh\n     ls\n     ```\nafter'
  const tree = pane(table, h, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['1. x', '- ```sh\n  ls\n  ```', 'after'])
  const copies = nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))
  expect(copies.map(b => b.key)).toEqual(['copy-1-1'])
  for (const b of copies) (b.onPress as (press: { surface: string }) => void)({ surface: 'terminal' })
  expect(copied).toEqual([['ls', 'terminal']])
})

test('a fence indented four spaces outside a list is no fence: no copy button, and a table after it is drawn as a list', () => {
  const brief = '    ```sh\n    ls\n    ```\n\n| a | b |\n|---|---|\n| 1 | 2 |'
  const tree = pane(table, handlers, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['    ```sh\n    ls\n    ```\n\n- **1**: b: 2'])
  expect(nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))).toEqual([])
})

test('a fence four or more columns past its list item\'s content column is no fence: no copy button, and its lines stay prose', () => {
  const brief = '- a\n      ```sh\n      ls\n      ```'
  const tree = pane(table, handlers, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual([brief])
  expect(nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))).toEqual([])
})

test('a backtick run with a backtick in its info string is no fence: no copy button, and the table after it is drawn as a list', () => {
  const brief = '```x```\n| a | b |\n|---|---|\n| 1 | 2 |'
  const tree = pane(table, handlers, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['```x```\n\n- **1**: b: 2'])
  expect(nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))).toEqual([])
})

test('a tilde fence with a backtick line inside has one copy button, and a table after its close is drawn as a list', () => {
  const copied: [string, unknown][] = []
  const h: Handlers = { ...handlers, copy: (text, surface) => void copied.push([text, surface]) }
  const brief = '~~~\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~\n| c | d |\n|---|---|\n| 3 | 4 |'
  const tree = pane(table, h, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['~~~\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n~~~', '- **3**: d: 4'])
  const copies = nodes(tree, 'Button').filter(b => String(b.key).startsWith('copy-'))
  expect(copies.map(b => b.key)).toEqual(['copy-1-0'])
  for (const b of copies) (b.onPress as (press: { surface: string }) => void)({ surface: 'terminal' })
  expect(copied).toEqual([['```\n| a | b |\n|---|---|\n| 1 | 2 |', 'terminal']])
})

test('a table after a fence in a second-level list item is drawn as a list, with no indent of four or more columns', () => {
  const brief = '- a\n  - b\n    ```sh\n    ls\n    ```\n    | x | y |\n    |---|---|\n    | 1 | 2 |'
  const tree = pane(table, handlers, { items: [{ ...item, detail: brief, note: null }], next: 2, term: null }, view())
  expect(nodes(tree, 'Markdown').map(n => n.text)).toEqual(['- a\n  - b', '```sh\nls\n```', '- **1**: y: 2'])
})


// The Claude column: the band's tree with the Claude list beside the human list.
const mk = (state: TodoItem['state'], n: number, prefix = state === 'queued' ? 'q' : 'f'): TodoItem[] => Array.from({ length: n }, (_, k) => ({ title: `${prefix}${k + 1}`, state }))
const flight = (n: number): TodoItem[] => mk('in_flight', n)
const queue = (n: number): TodoItem[] => mk('queued', n)
const humans = (n: number, blocking = false): Store => ({ items: Array.from({ length: n }, (_, k) => at(k + 1, blocking && k === 0)), next: n + 1, term: null })
const drawn = (store: Store, todo: TodoItem[], columns: number, maxRows = 50): Node => band(table, handlers, store, { ...view(), maxRows, claude: { items: todo, columns } }) as Node
// Trees are compared as JSON: a press handler is a fresh closure on every draw.
const sameTree = (a: unknown, b: unknown, name?: string): void => expect(JSON.stringify(a), name).toBe(JSON.stringify(b))
const columnsOf = (tree: Node): Node[] => (tree.children ?? []) as Node[]
const lineTexts = (column: Node): string[] => (column.children as Node[]).map(row => texts(row).join(''))

test('with no Claude items the human list draws as it does today, at a wide band and a narrow one', () => {
  const today = band(table, handlers, humans(2), view())
  for (const columns of [120, 90, 300]) sameTree(drawn(humans(2), [], columns), today)
})

test('at 120 columns the band is two boxes, the human list 80 wide and the Claude column 40 wide at the right, each with its empty column inside', () => {
  const tree = drawn(humans(2), queue(1), 120)
  const [left, right] = columnsOf(tree)
  expect(tree).toMatchObject({ type: 'Box', flexDirection: 'row', width: 120 })
  expect(left).toMatchObject({ type: 'Box', flexDirection: 'column', width: 80, paddingRight: 1 })
  expect(right).toMatchObject({ type: 'Box', flexDirection: 'column', width: 40, paddingLeft: 1 })
  expect(columnsOf(tree).length).toBe(2)
  expect(texts(left).join('')).toContain('To do for you')
  expect(texts(left).join('')).not.toContain('Claude TODO')
  expect(lineTexts(right as Node)[0]).toBe('Claude TODO 0 active, 1 queued')
})

test('the human column holds the rows the band draws today', () => {
  const store = humans(3, true)
  const today = band(table, handlers, store, view()) as Node
  const left = columnsOf(drawn(store, queue(1), 120))[0] as Node
  sameTree(left.children, today.children)
  expect(nodes(left, 'Button').map(b => b.key)).toEqual(nodes(today, 'Button').map(b => b.key))
})

test('under 96 columns the Claude column hides and the human list draws as it does today', () => {
  sameTree(drawn(humans(2), [...flight(1), ...queue(2)], 90), band(table, handlers, humans(2), view()))
})

test('the Claude header counts the list in the short form, in flight as active', () => {
  const right = columnsOf(drawn(humans(2), [...flight(2), ...queue(3)], 120))[1] as Node
  expect(lineTexts(right)[0]).toBe('Claude TODO 2 active, 3 queued')
})

test('the header is one line set to cut at the column\'s layout width: 31 beside the human list, which cuts the two-digit counts\' 32 columns; alone the column is laid out in its 32 and holds them whole', () => {
  const header = (store: Store, todo: TodoItem[]) => (columnsOf(drawn(store, todo, 96))[store.items.length === 0 ? 0 : 1] as Node).children?.[0] as Node
  const twoDigits = [...flight(12), ...queue(13)]
  const beside = header(humans(2), twoDigits)
  expect(texts(beside).join('')).toBe('Claude TODO 12 active, 13 queued')
  expect(texts(beside).join('').length).toBe(32)
  expect(beside.wrap).toBe('truncate-end')
  const box = columnsOf(drawn(humans(2), twoDigits, 96))[1] as Node
  // The box is 32 wide and keeps its first column empty: the Text is cut at the 31 after it.
  expect(Number(box.width) - Number(box.paddingLeft)).toBe(31)
  expect(texts(beside).join('').length).toBeGreaterThan(31)
  // One-digit counts, 30 columns, are whole in the 31.
  expect(texts(header(humans(2), [...flight(1), ...queue(1)])).join('').length).toBe(30)
  // Alone, the column is 32 wide with no empty column: the same header is whole.
  const alone = columnsOf(drawn(humans(0), twoDigits, 96))[0] as Node
  expect(alone).toMatchObject({ width: 32 })
  expect(alone.paddingLeft).toBeUndefined()
  expect(texts(header(humans(0), twoDigits)).join('').length).toBeLessThanOrEqual(Number(alone.width))
  const over = header(humans(2), [...flight(120), ...queue(13)])
  expect(texts(over).join('')).toBe('Claude TODO 120 active, 13 queued')
  expect(over.wrap).toBe('truncate-end')
})

test('a row is the state\'s glyph and the title on one line, set to cut at the column\'s edge, in-flight first', () => {
  const long = 'x'.repeat(80)
  const right = columnsOf(drawn(humans(6), [{ title: 'queued one', state: 'queued' }, { title: long, state: 'in_flight' }], 120))[1] as Node
  const rows = (right.children as Node[]).slice(1)
  expect(rows.map(row => texts(row).join(''))).toEqual([`◐ ${long}`, '○ queued one'])
  expect(rows.map(row => [row.type, row.wrap])).toEqual([['Text', 'truncate-end'], ['Text', 'truncate-end']])
})

test('beside one human item three queued items draw as the header and one +3 queued row, and no queued item', () => {
  const right = columnsOf(drawn(humans(1), queue(3), 120))[1] as Node
  expect(lineTexts(right)).toEqual(['Claude TODO 0 active, 3 queued', '+3 queued'])
})

test('queued rows fill down to the human list\'s height, the last a summary when they do not all fit', () => {
  // The human list: its header and 3 rows, 4 in all. The column: its header, 1 in flight, 2 rows left for 3 queued.
  const right = columnsOf(drawn(humans(3), [...flight(1), ...queue(3)], 120))[1] as Node
  expect(lineTexts(right)).toEqual(['Claude TODO 1 active, 3 queued', '◐ f1', '○ q1', '+2 queued'])
  const all = columnsOf(drawn(humans(3), [...flight(1), ...queue(2)], 120))[1] as Node
  expect(lineTexts(all)).toEqual(['Claude TODO 1 active, 2 queued', '◐ f1', '○ q1', '○ q2'])
})

test('every in-flight item has a row however many there are, and no queued row draws when they fill the human list\'s height', () => {
  const right = columnsOf(drawn(humans(2), [...flight(5), ...queue(4)], 120))[1] as Node
  expect(lineTexts(right)).toEqual(['Claude TODO 5 active, 4 queued', ...flight(5).map(it => `◐ ${it.title}`)])
})

test('with no human items and an item in flight the column draws alone: 40 wide at the band\'s right edge, nothing to its left', () => {
  const tree = drawn(humans(0), [...flight(2), ...queue(3)], 120)
  expect(tree).toMatchObject({ type: 'Box', flexDirection: 'row', justifyContent: 'flex-end', width: 120 })
  const [only, ...rest] = columnsOf(tree) as [Node, ...Node[]]
  expect(rest).toEqual([])
  expect(only).toMatchObject({ type: 'Box', flexDirection: 'column', width: 40 })
  expect(lineTexts(only)).toEqual(['Claude TODO 2 active, 3 queued', '◐ f1', '◐ f2'])
  expect(JSON.stringify(tree)).not.toContain('To do for')
})

test('the column alone never hides on a narrow band, and keeps 32 columns', () => {
  const tree = drawn(humans(0), flight(1), 60)
  expect(columnsOf(tree)).toHaveLength(1)
  expect(columnsOf(tree)[0]).toMatchObject({ width: 32 })
})

test('at a bodyColumns of 96, 120 and 155 with both lists drawn, the boxes keep the widths the width rule rules, the human box padded one column on its right and the Claude box one on its left, so the Claude column\'s lines are cut at 31, 39 and 50 columns', () => {
  for (const [columns, human, claude, cut] of [[96, 64, 32, 31], [120, 80, 40, 39], [155, 104, 51, 50]] as const) {
    const tree = drawn(humans(2), [...flight(1), ...queue(1)], columns)
    const [left, right] = columnsOf(tree) as [Node, Node]
    const where = `${columns}`
    expect(columnsOf(tree), where).toHaveLength(2)
    expect(tree, where).toMatchObject({ type: 'Box', flexDirection: 'row', justifyContent: 'flex-end', width: columns })
    expect(left, where).toMatchObject({ type: 'Box', flexDirection: 'column', width: human, paddingRight: 1 })
    expect(right, where).toMatchObject({ type: 'Box', flexDirection: 'column', width: claude, paddingLeft: 1 })
    expect(left.paddingLeft, where).toBeUndefined()
    expect(right.paddingRight, where).toBeUndefined()
    // The Claude column\'s lines are Texts set to cut at the end of the box inside its padding, none with a width of its own.
    expect(Number(right.width) - Number(right.paddingLeft), where).toBe(cut)
    for (const line of right.children as Node[]) expect([line.type, line.wrap, line.width], where).toEqual(['Text', 'truncate-end', undefined])
  }
})

// The trees the band drew before the margin, captured from it: a human list alone (its rows fit a line), and the Claude column alone at 120 and at 40.
const TODAY_HUMAN = '{"type":"Box","flexDirection":"column","children":[{"type":"Box","children":[{"type":"Box","flexShrink":0,"children":[{"type":"Text","bold":true,"color":"inverseText","backgroundColor":"permission","children":[" To do for you "]}]},{"type":"Text","children":[" 2 open "]}]},{"type":"Box","key":"item-1","children":[{"type":"Box","flexShrink":0,"children":[{"type":"Text","bold":false,"dimColor":true,"children":["  #1 "]}]},{"type":"Button","key":"title-1","plain":true,"label":"Pick a db"},{"type":"Box","flexShrink":0,"children":[{"type":"Text","children":[" "]},{"type":"Button","key":"done-1","plain":true,"label":"[✓]"}]}]},{"type":"Box","key":"item-2","children":[{"type":"Box","flexShrink":0,"children":[{"type":"Text","bold":false,"dimColor":true,"children":["  #2 "]}]},{"type":"Button","key":"title-2","plain":true,"label":"Pick a db"},{"type":"Box","flexShrink":0,"children":[{"type":"Text","children":[" "]},{"type":"Button","key":"done-2","plain":true,"label":"[✓]"}]}]}]}'
const TODAY_CLAUDE_120 = '{"type":"Box","flexDirection":"row","justifyContent":"flex-end","width":120,"children":[{"type":"Box","flexDirection":"column","width":40,"children":[{"type":"Text","wrap":"truncate-end","children":["Claude TODO 1 active, 0 queued"]},{"type":"Text","wrap":"truncate-end","children":["◐ f1"]}]}]}'
const TODAY_CLAUDE_40 = '{"type":"Box","flexDirection":"row","justifyContent":"flex-end","width":40,"children":[{"type":"Box","flexDirection":"column","width":32,"children":[{"type":"Text","wrap":"truncate-end","children":["Claude TODO 1 active, 0 queued"]},{"type":"Text","wrap":"truncate-end","children":["◐ f1"]}]}]}'

test('a list drawn alone is the tree the band drew before the margin, with no padding on any box: the human list at 120 and 90 columns with no Claude items, the Claude column at 120 and 40 with no human items', () => {
  const alone: [string, Node, string][] = [
    ['human at 120', drawn(humans(2), [], 120), TODAY_HUMAN],
    ['human at 90', drawn(humans(2), [], 90), TODAY_HUMAN],
    ['Claude at 120', drawn(humans(0), flight(1), 120), TODAY_CLAUDE_120],
    ['Claude at 40', drawn(humans(0), flight(1), 40), TODAY_CLAUDE_40],
  ]
  for (const [name, tree, golden] of alone) {
    sameTree(tree, JSON.parse(golden), name)
    expect(JSON.stringify(tree), name).not.toContain('padding')
  }
})

test('the state table: each row, at 120 columns and at 90', () => {
  const fold = 6 // maxRows that folds a list of 8 items into a summary row
  const cases: { name: string; human: Store; todo: TodoItem[]; maxRows: number; wide: 'both' | 'human' | 'claude'; narrow: 'human' | 'claude' }[] = [
    { name: '2: no human items, in flight', human: humans(0), todo: [...flight(2), ...queue(1)], maxRows: 50, wide: 'claude', narrow: 'claude' },
    { name: '3: human, no Claude', human: humans(3), todo: [], maxRows: 50, wide: 'human', narrow: 'human' },
    { name: '3: human folded, no Claude', human: humans(8), todo: [], maxRows: fold, wide: 'human', narrow: 'human' },
    { name: '4: human, queued only', human: humans(3), todo: queue(4), maxRows: 50, wide: 'both', narrow: 'human' },
    { name: '4: folded human, queued only', human: humans(8), todo: queue(4), maxRows: fold, wide: 'both', narrow: 'human' },
    { name: '5: human, in flight within the height', human: humans(4), todo: [...flight(2), ...queue(5)], maxRows: 50, wide: 'both', narrow: 'human' },
    { name: '5: folded human, in flight within the height', human: humans(8), todo: [...flight(2), ...queue(5)], maxRows: fold, wide: 'both', narrow: 'human' },
    { name: '6: human, in flight overflowing', human: humans(2), todo: [...flight(6), ...queue(2)], maxRows: 50, wide: 'both', narrow: 'human' },
    { name: '7: folded human, in flight overflowing', human: humans(8), todo: [...flight(9), ...queue(2)], maxRows: fold, wide: 'both', narrow: 'human' },
  ]
  for (const c of cases) {
    const wide = drawn(c.human, c.todo, 120, c.maxRows)
    const narrow = drawn(c.human, c.todo, 90, c.maxRows)
    if (c.wide === 'claude') {
      expect(columnsOf(wide).length, c.name).toBe(1)
      expect(texts(wide).join(''), c.name).not.toContain('To do for')
    } else if (c.wide === 'human') {
      sameTree(wide, band(table, handlers, c.human, { ...view(), maxRows: c.maxRows }), c.name)
    } else {
      const [left, right] = columnsOf(wide)
      expect(texts(left).join(''), c.name).toContain('To do for you')
      expect(texts(right).join(''), c.name).toContain('Claude TODO')
    }
    if (c.narrow === 'claude') expect(texts(narrow).join(''), c.name).toContain('Claude TODO')
    else expect(texts(narrow).join(''), c.name).not.toContain('Claude TODO')
    if (c.narrow === 'human') sameTree(narrow, band(table, handlers, c.human, { ...view(), maxRows: c.maxRows }), c.name)
  }
})

test('state table row 7: with a column taller than maxRows the human list folds one row earlier, its summary in the top maxRows - 1 rows and its last row', () => {
  const store = humans(12)
  const human = (todo: TodoItem[]) => columnsOf(drawn(store, todo, 120, 10))[0] as Node
  const rowCount = (column: Node) => (column.children as Node[]).length
  // Header and 9 in-flight rows are 10 rows: the human list folds where it does today (header, 8 items, summary: 10 rows).
  const same = human(flight(9))
  expect(rowCount(same)).toBe(10)
  expect(nodes(same, 'Button').filter(b => b.key === 'band-more')).toHaveLength(1)
  sameTree(same.children, (band(table, handlers, store, { ...view(), maxRows: 10 }) as Node).children)
  // Header and 10 in-flight rows are 11 rows: one row earlier, the summary the 9th row.
  const earlier = human(flight(10))
  expect(rowCount(earlier)).toBe(9)
  const last = (earlier.children as Node[])[8] as Node
  expect(nodes(last, 'Button').map(b => b.key)).toEqual(['band-more'])
  expect(nodes(earlier, 'Button').filter(b => String(b.key).startsWith('title-'))).toHaveLength(7)
})

test('with maxRows 10 and a column no taller than maxRows the human list folds as it does today', () => {
  const store = humans(12)
  sameTree((columnsOf(drawn(store, flight(3), 120, 10))[0] as Node).children, (band(table, handlers, store, { ...view(), maxRows: 10 }) as Node).children)
})

test('with maxRows 10 and 30 in-flight items the column is taller than maxRows and holds every one', () => {
  const right = columnsOf(drawn(humans(2), flight(30), 120, 10))[1] as Node
  expect((right.children as Node[]).length).toBe(31)
  expect(lineTexts(right).slice(1)).toEqual(flight(30).map(it => `◐ ${it.title}`))
})

test('with maxRows 10, a folded human list and more in-flight items than maxRows, the summary row is its last row within the window\'s top maxRows - 1', () => {
  const left = columnsOf(drawn(humans(14, true), flight(15), 120, 10))[0] as Node
  const rows = left.children as Node[]
  const at = rows.findIndex(row => nodes(row, 'Button').some(b => b.key === 'band-more'))
  expect(at).toBe(rows.length - 1)
  expect(at).toBeLessThan(10 - 1)
})

test('a human list of exactly maxRows lines beside a column taller than maxRows still folds, one row earlier: its summary is its last row, within the window\'s top maxRows - 1', () => {
  // The human list: its header and 9 items, 10 lines, which fits maxRows 10 whole. The column: its header and 10 in-flight rows, 11 lines.
  const left = columnsOf(drawn(humans(9), flight(10), 120, 10))[0] as Node
  const rows = left.children as Node[]
  expect(rows).toHaveLength(9)
  expect(nodes(rows[8], 'Button').map(b => b.key)).toEqual(['band-more'])
  expect(nodes(left, 'Button').filter(b => String(b.key).startsWith('title-'))).toHaveLength(7)
  // Beside a column of 10 lines the same list fits whole, with no summary.
  const whole = columnsOf(drawn(humans(9), flight(9), 120, 10))[0] as Node
  expect((whole.children as Node[]).length).toBe(10)
  expect(nodes(whole, 'Button').some(b => b.key === 'band-more')).toBe(false)
})

// What a subtree shows: its text and its buttons' labels, in drawing order.
const shown = (node: unknown): string => {
  if (typeof node === 'string') return node
  const n = node as Node
  return n.type === 'Button' ? String(n.label) : (n.children ?? []).map(shown).join('')
}

// Where a row's control is drawn: on its title's line (the row is one line of boxes), below it (the row is a column of the title's line and the
// control's), or nowhere.
const placeDrawn = (tree: unknown, id: number): 'beside' | 'below' | 'none' => {
  const keys = [`done-${id}`, `yes-${id}`, `no-${id}`]
  if (!nodes(tree, 'Button').some(b => keys.includes(String(b.key)))) return 'none'
  const row = nodes(tree, 'Box').find(box => box.key === `item-${id}`)
  return row?.flexDirection === 'column' ? 'below' : 'beside'
}

// A box of `box` columns for the human list beside the Claude column: the smallest band whose human box is that wide (the column is a third of the band,
// at least 32).
const bandFor = (box: number): number => {
  for (let columns = 96; ; columns++) if (columns - Math.max(32, Math.floor(columns / 3)) === box) return columns
}

// A human list as the band draws it, with the columns its rows are laid out in: beside the Claude column, in a box of `list` columns that keeps one
// empty, or full width, laid out in all of its `list`. `maxRows` leaves room for every row.
const BESIDE = 'beside the column'
const FULL = 'full width'
type Where = typeof BESIDE | typeof FULL
const humanList = (store: Store, list: number, where: Where, maxRows = 1000): { left: Node; layout: number } =>
  where === BESIDE
    ? { left: columnsOf(drawn(store, queue(1), bandFor(list), maxRows))[0] as Node, layout: list - 1 }
    : { left: drawn(store, [], list, maxRows), layout: list }

test('the row\'s texts are built once for the drawing and the layout: the id, the title, the open control, and what each way a press can say its answer reads', () => {
  expect(rowTexts(at(12, false), 3000)).toEqual({ prefix: '  #12 ', title: 'Pick a db', open: '[✓]', said: ['✓ ', '✓ replied '], undo: '[↶ 3s]', sent: '✓ sent' })
  expect(rowTexts({ ...at(12, false), unread: true }, 3000).prefix).toBe('• #12 ')
  expect(rowTexts({ ...at(1, false), doneLabel: 'Go with sqlite' }, 3000)).toMatchObject({ open: '[✓ Go with sqlite]', said: ['✓ Go with sqlite ', '✓ replied ', '✓ '] })
  expect(rowTexts({ ...at(1, false), yesno: true }, 3000)).toMatchObject({ open: '[✓] [✗]', said: ['✓ yes ', '✗ no ', '✓ replied ', '✓ '] })
  const options = [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }]
  expect(rowTexts({ ...at(1, false), options }, 3000)).toMatchObject({ title: 'Pick a db […]', open: '', said: ['✓ Use sqlite ', '✓ Use postgres ', '✓ replied ', '✓ '] })
  // The undo button at its widest, the first second of the window: the seconds it starts from.
  expect(rowTexts(at(1, false), 12000).undo).toBe('[↶ 12s]')
  expect(rowTexts(at(1, false), 2500).undo).toBe('[↶ 3s]')
  expect(rowTexts(at(1, false), 0).undo).toBe('[↶ 0s]')
})

test('rows wrapped by hand at a list of 20: the layout\'s count for the real row is the hand count of its tallest state, in every state the row is drawn in', () => {
  const options = [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }]
  const states: Partial<Item>[] = [{}, { state: 'done-waiting', pressedAt: 0, answer: 'Use sqlite', replied: true }, { state: 'done-pending', answer: 'Use sqlite', replied: true }]
  const cases: [string, Item, number][] = [
    // A title with a word longer than the list, #12: 4 lines beside the open control (10 columns), 7 beside the pressed one (5), 6 under the title with
    // `✓ replied` under it, 6 beside `✓ sent` (7).
    ['a word longer than the list', { ...at(12, false), title: 'Fix abcdefghijklmnopqrstuvwxyz now' }, 7],
    // Wide characters: 2 lines, 5, 4, 4.
    ['wide characters', { ...at(12, false), title: '部署新版本到生产环境' }, 5],
    // A title holding a line break: 2 lines, 3, 4, 3.
    ['a line break', { ...at(12, false), title: 'Ask\nthe owner' }, 4],
    // A labelled to-do's control below its title: the title's line and the open control's two, the pressed one's two, the reply's two.
    ['a control below its title', { ...at(1, false), doneLabel: 'Go with sqlite' }, 3],
    // A decision, #12, whose title is `Pick a store […]`: 2 lines open (the title in 14 columns, no control), 4 pressed with `Use sqlite` and 5 with
    // `Use postgres` (the control goes under the title, its words in the 8 columns the undo button leaves: `✓ Use ` and `sqlite `, or `✓ Use `,
    // `postgres` and a line for the space), 4 with a reply (`✓ ` and `replied `), 3 sent (the title in 7 columns).
    ['a decision pressed with an option or a reply', { ...at(12, false), title: 'Pick a store', options }, 5],
  ]
  for (const [name, row, hand] of cases) {
    for (const state of states) expect(rowLines(rowTexts({ ...row, ...(row.options.length > 0 || row.doneLabel !== null ? state : { ...state, answer: null }) }, 3000), 20), name).toBe(hand)
  }
})

test('a list of 20 draws a plain to-do with a two-digit id with its control on its title\'s line, and one with a three-digit id with its control below, indented to the title\'s start, a title of one short word included', () => {
  const two = drawn({ items: [at(12, false)], next: 13, term: null }, [], 20)
  expect(placeDrawn(two, 12)).toBe('beside')
  const three = drawn({ items: [at(123, false)], next: 124, term: null }, [], 20)
  expect(placeDrawn(three, 123)).toBe('below')
  const row = nodes(three, 'Box').find(box => box.key === 'item-123') as Node
  expect(row).toMatchObject({ flexDirection: 'column' })
  expect((row.children as Node[]).map(k => nodes(k, 'Button').map(b => b.key))).toEqual([['title-123'], ['done-123']])
  expect((row.children as Node[])[1]).toMatchObject({ type: 'Box', paddingLeft: 7 })
  // `  #123 Hi [✓]` fits a list of 20, yet its title's room is 9: below at 20, beside at 21.
  const short: Store = { items: [{ ...at(123, false), title: 'Hi' }], next: 124, term: null }
  expect(placeDrawn(drawn(short, [], 20), 123)).toBe('below')
  expect(placeDrawn(drawn(short, [], 21), 123)).toBe('beside')
  // A to-do labelled at the maximum with a title of two columns: its title keeps 6 columns beside the control at a list of 40 and 10 at 44.
  const labelled: Store = { items: [{ ...at(1, false), title: 'Hi', doneLabel: 'Go with sqlite for cache' }], next: 2, term: null }
  expect(placeDrawn(drawn(labelled, [], 40), 1)).toBe('below')
  expect(placeDrawn(drawn(labelled, [], 44), 1)).toBe('beside')
})

// Every kind of control, with the states it reaches and what each draws as a control, beside its title or under it: its full answer text and its undo
// button. A to-do's longest label is 24 columns, a term's 20. The undo window is view()'s: 5 seconds, from the press.
const LABEL = 'Go with sqlite for cache'
const TERM = 'Operations lead team'
const LONG = 'A title that is longer than the list and has a pneumonoultramicroscopic word'
const LONGER = `${LONG} and goes on, with ${LONG}`
const BROKEN = 'Ask the owner first\nthen the one who wrote the long title that wraps in a narrow list'
const CHOICES = [{ label: 'Use sqlite for the cache', description: '', recommended: true }, { label: 'Use postgres', description: '', recommended: false }]
const UNDO = '[↶ 5s]'
const waiting = (answer: string | null, replied = false): Partial<Item> => ({ state: 'done-waiting', pressedAt: 0, answer, replied })
const SENT: Partial<Item> = { state: 'done-pending', answer: 'Use it', replied: true }
type KindState = { name: string; over: Partial<Item>; text: string }
type Kind = { name: string; base: Partial<Item>; open: string; states: KindState[] }
const KINDS: Kind[] = [
  {
    name: 'a plain to-do', base: {}, open: '[✓]',
    states: [
      { name: 'open', over: {}, text: '[✓]' },
      { name: 'pressed with none', over: waiting(null), text: `✓ ${UNDO}` },
      { name: 'pressed with a reply', over: waiting('Not yet', true), text: `✓ replied ${UNDO}` },
      { name: 'sent', over: SENT, text: '✓ sent' },
    ],
  },
  {
    name: 'a labelled to-do', base: { doneLabel: LABEL }, open: `[✓ ${LABEL}]`,
    states: [
      { name: 'open', over: {}, text: `[✓ ${LABEL}]` },
      { name: 'pressed with its label', over: waiting(LABEL), text: `✓ ${LABEL} ${UNDO}` },
      { name: 'pressed with a reply', over: waiting('Not yet', true), text: `✓ replied ${UNDO}` },
      { name: 'sent', over: SENT, text: '✓ sent' },
    ],
  },
  {
    name: 'a yes/no', base: { yesno: true }, open: '[✓] [✗]',
    states: [
      { name: 'open', over: {}, text: '[✓] [✗]' },
      { name: 'pressed yes', over: waiting('yes'), text: `✓ yes ${UNDO}` },
      { name: 'pressed no', over: waiting('no'), text: `✗ no ${UNDO}` },
      { name: 'pressed with a reply', over: waiting('no', true), text: `✓ replied ${UNDO}` },
      { name: 'sent', over: SENT, text: '✓ sent' },
    ],
  },
  {
    name: 'a decision', base: { options: CHOICES }, open: '',
    states: [
      { name: 'open', over: {}, text: '' },
      { name: 'pressed with an option', over: waiting(CHOICES[0]?.label ?? null), text: `✓ ${CHOICES[0]?.label} ${UNDO}` },
      { name: 'pressed with a reply', over: waiting('Not yet', true), text: `✓ replied ${UNDO}` },
      { name: 'sent', over: SENT, text: '✓ sent' },
    ],
  },
]

// Where a state's control sits, worked out from the room alone and apart from the layout (layout.test.ts does the same for the layout's own texts): on
// its title's line while the title keeps ten columns there beside the id (its digits, the `#`, the mark's two columns and a space) and the row's open
// control with the space before it, whatever the title's length and the list's width, and under the title otherwise; a state's own control moves under
// the title only when, with the id and its space, it would leave the title no column.
const wantPlace = (layout: number, digits: number, kind: Kind, text: string): 'beside' | 'below' => {
  const room = (control: string): number => layout - (digits + 4) - (control === '' ? 0 : 1 + displayColumns(control))
  return room(kind.open) >= 10 && room(text) >= 1 ? 'beside' : 'below'
}

// The cells of a drawn row: the row itself, its cells (its title's line when the control is under the title, which is then the row's second cell), and
// the cell its title is set in: the title's button itself, or a box around it.
const rowOf = (left: Node, id: number): Node => nodes(left, 'Box').find(box => box.key === `item-${id}`) as Node
const cellsOf = (left: Node, id: number): Node[] => rowOf(left, id).children as Node[]
const titleCellOf = (left: Node, id: number): Node => {
  const row = rowOf(left, id)
  return (row.flexDirection === 'column' ? ((row.children as Node[])[0] as Node).children : row.children)?.[1] as Node
}

// One kind of control in one state, drawn as a row of a list whose rows are laid out in `layout` columns: the title whole, set where the layout puts it
// (a box of the room it wraps in when it wraps there or is wider than it, the button itself otherwise), the control whole with its undo button on the
// line the layout gives it, a pressed control's words under the title in the box the layout gives them, and by the layout's own count no line of any
// state wider than the list. `built` and `laid`: the texts and the layout of the open row, which every state of the kind shares.
const checkRow = (left: Node, layout: number, built: RowTexts, laid: RowLayout, row: Item, kind: Kind, state: KindState, digits: number, where: string): void => {
  const id = row.id
  const widest = Math.max(...[laid.open, ...laid.pressed, laid.sent].flatMap(one => one.widths))
  expect(widest, where).toBeLessThanOrEqual(layout)
  // The state the row is drawn in: the pressed one that says the answer the item has.
  const saying = state.text.endsWith(UNDO) ? state.text.slice(0, -UNDO.length) : ''
  const expected = state.name === 'open' ? laid.open : state.name === 'sent' ? laid.sent : laid.pressed[built.said.indexOf(saying)]
  expect(expected, where).toBeDefined()
  // The title is whole, with a decision's marker.
  expect(nodes(left, 'Button').find(b => b.key === `title-${id}`)?.label, where).toBe(kind.base.options === undefined ? row.title : `${row.title} […]`)
  const titleCell = titleCellOf(left, id)
  if (expected?.title === null) expect(titleCell, where).toMatchObject({ type: 'Button', key: `title-${id}` })
  else expect(titleCell, where).toMatchObject({ type: 'Box', width: expected?.title, flexShrink: 0 })
  const place = placeDrawn(left, id)
  if (place === 'none') {
    // A decision's open row draws no control: its control's line is the title's.
    expect(kind.open === '' && state.name === 'open', where).toBe(true)
    expect(nodes(rowOf(left, id), 'Button').map(b => b.key), where).toEqual([`title-${id}`])
    return
  }
  expect(place, where).toBe(wantPlace(layout, digits, kind, state.text))
  expect(place, where).toBe(expected?.place)
  const cells = cellsOf(left, id)
  if (place === 'beside') {
    // The control follows its space at the end of the row, whole, and the row's pieces take no more than the list.
    expect(shown(cells[cells.length - 1]).slice(1), where).toBe(state.text)
    const titleColumns = expected?.title === null ? displayColumns(shown(titleCell)) : Number(expected?.title)
    expect(displayColumns(shown(cells[0])) + titleColumns + displayColumns(shown(cells[cells.length - 1])), where).toBeLessThanOrEqual(layout)
  } else {
    // Under the title it is the second line of the row, indented to the title's start, whole.
    const control = cells[1] as Node
    expect(control, where).toMatchObject({ type: 'Box', paddingLeft: displayColumns(built.prefix) })
    expect(shown(control), where).toBe(state.text)
    if (state.name !== 'open' && state.name !== 'sent') {
      // A pressed control's words wrap beside the undo button: in a box of the room it leaves them when they wrap there, bare otherwise.
      const [pressed] = control.children as [Node]
      const words = (pressed.children as Node[])[0] as Node
      if (expected?.said === null) expect(words, where).toMatchObject({ type: 'Text' })
      else expect(words, where).toMatchObject({ type: 'Box', width: expected?.said, flexShrink: 0 })
    }
  }
}

// Every kind of control in every state, as a row of a list of each of `lists` columns, at an id of `digits` digits and for each title.
const sweep = (where: Where, lists: number[], titles: string[], digits: number): void => {
  const id = Number('1'.repeat(digits))
  for (const kind of KINDS) {
    for (const title of titles) {
      for (const list of lists) {
        const layout = where === BESIDE ? list - 1 : list
        const built = rowTexts({ ...at(id, false), title, ...kind.base }, view().windowMs)
        const laid = rowLayout(built, layout)
        for (const state of kind.states) {
          const name = `${kind.name}, ${state.name}, ${digits} digits, list of ${list} ${where}, ${JSON.stringify(title)}`
          const row: Item = { ...at(id, false), title, ...kind.base, ...state.over }
          const drawnList = humanList({ items: [row], next: id + 1, term: TERM }, list, where)
          expect(drawnList.layout, name).toBe(layout)
          if (where === BESIDE) expect(drawnList.left, name).toMatchObject({ type: 'Box', flexDirection: 'column', width: list, paddingRight: 1 })
          else expect(drawnList.left.width, name).toBeUndefined()
          checkRow(drawnList.left, layout, built, laid, row, kind, state, digits, name)
        }
      }
    }
  }
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k)

for (const digits of [1, 2, 3, 4]) {
  test(`every kind of control in every state, at an id of ${digits} digit${digits === 1 ? '' : 's'} and a full-width list of 20 to 63, with a title longer than the list and a title holding a line break: nothing is cut, the control sits where the open control's room puts it, and no line is wider than the list`, () => {
    sweep(FULL, range(20, 63), [LONG, BROKEN], digits)
  })

  test(`every kind of control in every state, at an id of ${digits} digit${digits === 1 ? '' : 's'} and a list of 64 to 120 beside the Claude column and full width, with a title longer than the list: nothing is cut, the control sits where the open control's room puts it, and no line is wider than the layout width`, () => {
    sweep(BESIDE, range(64, 120), [LONG, LONGER], digits)
    sweep(FULL, range(64, 120), [LONG, LONGER], digits)
  })
}

// Where a row sets its title, read off the drawn tree and worked out by hand. The room a title wraps in is its list's layout width less the row's id and,
// beside a control, the control with its space; with the control under the title, or none, it is the line past the id. A title that wraps in its room, or
// is wider than it, is boxed to the room, because a bare title is laid out at the width of the whole list; one that fits is the button itself.
const checkTitleBox = (left: Node, id: number, layout: number, where: string): 'boxed' | 'bare' => {
  const row = rowOf(left, id)
  const under = row.flexDirection === 'column'
  const [prefix, titleCell, ...control] = (under ? ((row.children as Node[])[0] as Node).children : row.children) as [Node, Node, ...Node[]]
  const room = layout - displayColumns(shown(prefix)) - (under ? 0 : control.reduce((total, cell) => total + displayColumns(shown(cell)), 0))
  const label = String(nodes(titleCell, 'Button')[0]?.label)
  const [first = '', ...more] = wrapText(label, room)
  if (more.length > 0 || displayColumns(first) > room) {
    expect(titleCell, where).toMatchObject({ type: 'Box', width: room, flexShrink: 0 })
    expect(nodes(titleCell, 'Button').map(b => b.key), where).toEqual([`title-${id}`])
    return 'boxed'
  }
  expect(titleCell, where).toMatchObject({ type: 'Button', key: `title-${id}` })
  return 'bare'
}

test('every title is a box of the room it wraps in when it wraps there or is wider than it, and the button itself when it fits: each kind of control in each state, beside its control, under it or with none, at every list from 20 to 120', () => {
  const seen = new Set<string>()
  for (const kind of KINDS) {
    const id = 111
    for (const title of ['Hi', LONG, BROKEN]) {
      for (const state of kind.states) {
        const store: Store = { items: [{ ...at(id, false), title, ...kind.base, ...state.over }], next: id + 1, term: null }
        for (let list = 20; list <= 120; list++) {
          const lists: Where[] = list < 64 ? [FULL] : [FULL, BESIDE]
          for (const where of lists) {
            const { left, layout } = humanList(store, list, where)
            const how = checkTitleBox(left, id, layout, `${kind.name}, ${state.name}, ${JSON.stringify(title)}, ${where} list of ${list}`)
            seen.add(`${how} ${where} ${placeDrawn(left, id)}`)
          }
        }
      }
    }
  }
  // The sweep reaches a boxed and a bare title with the control beside it, under it and none in a full-width list, and beside the column with the control
  // beside it and none (a control is under a title from 64 columns only for a decision's long answer, which this sweep does not press with).
  for (const place of ['beside', 'below', 'none']) for (const how of ['boxed', 'bare']) expect(seen, `${how} ${FULL} ${place}`).toContain(`${how} ${FULL} ${place}`)
  for (const place of ['beside', 'none']) for (const how of ['boxed', 'bare']) expect(seen, `${how} ${BESIDE} ${place}`).toContain(`${how} ${BESIDE} ${place}`)
})

test('a decision pressed with an option label of any length draws its answer beside its title while the title keeps a column there and under it otherwise, in a box the undo button leaves, at every list from 64 to 120 beside the column and full width', () => {
  const marked = 'Pick a store […]'
  const linesIn = (room: number): number => wrapText(marked, room).length
  for (const where of [BESIDE, FULL] as const) {
    for (const labelColumns of [20, 45, 60, 150]) {
      // Words of four letters, so the label wraps wherever the room puts it.
      const label = Array.from({ length: Math.ceil(labelColumns / 5) }, () => 'word').join(' ')
      const row: Item = { ...at(1, false), title: 'Pick a store', options: [{ label, description: '', recommended: true }], ...waiting(label) }
      const said = `✓ ${label} `
      for (let list = 64; list <= 120; list++) {
        const name = `${where}, ${labelColumns} at ${list}`
        const { left, layout } = humanList({ items: [row], next: 2, term: null }, list, where)
        const built = rowTexts(row, view().windowMs)
        const pressed = rowLayout(built, layout).pressed[built.said.indexOf(said)]
        // The id takes 5; the pressed control, its undo button and the space before them take the rest, and the control goes under the title only
        // when the title would keep no column beside it.
        const room = layout - 5 - (1 + displayColumns(said) + displayColumns(UNDO))
        expect(placeDrawn(left, 1), name).toBe(room >= 1 ? 'beside' : 'below')
        expect(pressed?.place, name).toBe(room >= 1 ? 'beside' : 'below')
        // The title and the option are whole, and the saying and the undo button are all of the control.
        expect(nodes(left, 'Button').find(b => b.key === 'title-1')?.label, name).toBe(marked)
        expect(shown(left), name).toContain(`✓ ${label} ${UNDO}`)
        for (const w of pressed?.widths ?? []) expect(w <= layout, `${name}: ${w}`).toBe(true)
        if (room >= 1) {
          // Beside, the title is boxed to the room the control leaves it when it wraps there.
          if (linesIn(room) > 1) expect(titleCellOf(left, 1), name).toMatchObject({ type: 'Box', width: room, flexShrink: 0 })
          else expect(titleCellOf(left, 1), name).toMatchObject({ type: 'Button' })
        } else {
          const [pressedControl] = (cellsOf(left, 1)[1] as Node).children as [Node]
          const [words] = pressedControl.children as [Node]
          // The words are a box of the room the button leaves when they wrap, and the text itself when they do not.
          const wraps = wrapText(said, layout - 5 - displayColumns(UNDO)).length > 1
          expect(pressed?.said, name).toBe(wraps ? layout - 5 - displayColumns(UNDO) : null)
          if (wraps) expect(words, name).toMatchObject({ type: 'Box', width: pressed?.said, flexShrink: 0 })
          else expect(words, name).toMatchObject({ type: 'Text' })
        }
        if (labelColumns === 150) expect(placeDrawn(left, 1), name).toBe('below')
        // The lines the row takes are its tallest state's, worked out by hand from the wrapped title: open (no control), pressed with the option, pressed
        // with a reply (`✓ replied ` and the undo button leave the title 41 or more columns) and sent (`✓ sent`, 7 with its space).
        const underTitle = linesIn(layout - 5) + wrapText(said, layout - 5 - displayColumns(UNDO)).length
        const hand = Math.max(linesIn(layout - 5), room >= 1 ? linesIn(room) : underTitle, linesIn(layout - 5 - 1 - displayColumns('✓ replied ') - displayColumns(UNDO)), linesIn(layout - 5 - 7))
        expect(rowLines(built, layout), name).toBe(hand)
      }
    }
  }
})

// A pressed labelled to-do: it names its answer, the label.
const pressedLabelled: Item = { ...at(1, false), doneLabel: 'Go with sqlite', state: 'done-waiting', pressedAt: 0, answer: 'Go with sqlite' }

test('a row that fits its list is drawn as the band has always drawn it: a list of 64 or more, beside the column or full width, holds the rows a band with no width gives', () => {
  const store: Store = { items: [at(1, true), { ...at(12, false), doneLabel: 'Go with sqlite' }, { ...pressedLabelled, id: 13 }, yesNo({ id: 14, blocking: false })], next: 15, term: 'owner' }
  const today = (band(table, handlers, store, view()) as Node).children
  for (const list of [64, 70, 85, 100, 120]) {
    sameTree(humanList(store, list, BESIDE).left.children, today, `${list} beside the column`)
    sameTree(humanList(store, list, FULL).left.children, today, `${list} full width`)
  }
})

test('at a band of 52 to 56 with no Claude items, a to-do (labelled at the maximum width or not) and a yes/no keep their controls on their titles\' lines at an id of two to four digits: the room is at least 15 open, the title wraps in it, the list is full width, and no line is wider than the list', () => {
  for (const kind of KINDS.filter(it => it.base.options === undefined)) {
    for (let columns = 52; columns <= 56; columns++) {
      for (const digits of [2, 3, 4]) {
        const id = Number('1'.repeat(digits))
        for (const state of kind.states) {
          const name = `${kind.name}, ${state.name}, ${digits} digits, band of ${columns}`
          const row: Item = { ...at(id, false), title: LONG, ...kind.base, ...state.over }
          const tree = drawn({ items: [row], next: id + 1, term: TERM }, [], columns)
          // Full width: the list is the band's own box, and a pressed control says its answer in full.
          expect(tree.width, name).toBeUndefined()
          expect(placeDrawn(tree, id), name).toBe('beside')
          const cells = rowOf(tree, id).children as Node[]
          expect(shown(cells[cells.length - 1]).slice(1), name).toBe(state.text)
          // The title keeps the room the id (its digits, `#`, the mark's two columns and a space) and the control with its space leave it.
          const room = columns - (digits + 4) - (1 + displayColumns(state.text))
          expect(room, name).toBeGreaterThanOrEqual(state.name === 'open' ? 15 : 10)
          expect(cells[1], name).toMatchObject({ type: 'Box', width: room, flexShrink: 0 })
          // By the layout's own count no line of the row is wider than the list.
          const laid = rowLayout(rowTexts(row, view().windowMs), columns)
          for (const { widths } of [laid.open, ...laid.pressed, laid.sent]) for (const w of widths) expect(w <= columns, `${name}: ${w}`).toBe(true)
        }
      }
    }
  }
})

// The lines the layout counts for a human list as drawn: its header (the chip, never shrunk, and the count wrapped in the columns it leaves), each item
// row at its tallest state, and the summary row's text wrapped.
const drawnLines = (store: Store, left: Node, width: number): number => {
  const [header, ...rows] = left.children as Node[]
  const [chip, count] = (header as Node).children as [Node, Node]
  return rows.reduce((total, row) => {
    const found = store.items.find(it => `item-${it.id}` === row.key)
    return total + (found === undefined ? wrapText(shown(row), width).length : rowLines(rowTexts(found, view().windowMs), width))
  }, headerLines(shown(chip), shown(count), width))
}

test('a full-width list of 100 columns at maxRows 10 folds by the lines its rows take at their tallest, counted by hand: titles that wrap beside their controls and a decision pressed with an option whose answer goes under its title', () => {
  const OPTION = Array.from({ length: 20 }, () => 'word').join(' ')
  const once = 'Review the deliberately long wrapping title of the first plain to-do item here'
  const title = `${once} ${once}`
  const store: Store = {
    items: [
      { ...at(1, false), title: 'Pick a store', options: [{ label: OPTION, description: '', recommended: true }], ...waiting(OPTION) },
      ...Array.from({ length: 6 }, (_, k) => ({ ...at(k + 2, false), title })),
    ],
    next: 8,
    term: null,
  }
  // The lines of a row at its tallest, worked out from the wrapped title. The decision is a line open, pressed with a reply and sent (its title of 16
  // columns beside no control or a short one); pressed with its option, whose answer leaves its title no column, the control goes under the title and its
  // words wrap beside the undo button: 1 + 2. A to-do: its title in the room each state's control leaves (`[✓]`, `✓ [↶ 5s]`, `✓ replied [↶ 5s]`,
  // `✓ sent`, each with its space) after its id of 5.
  const todoLines = Math.max(...[4, 9, 17, 7].map(taken => wrapText(title, 100 - 5 - taken).length))
  const decisionLines = 1 + wrapText(`✓ ${OPTION} `, 100 - 5 - displayColumns(UNDO)).length
  expect([decisionLines, todoLines]).toEqual([3, 3])
  const hand = [decisionLines, ...Array.from({ length: 6 }, () => todoLines)]
  // The header is a line at 100 columns, and the summary row another; the rows that fit between them are the ones drawn.
  let shownRows = 0
  let used = 1 + 1
  while (shownRows < hand.length && used + (hand[shownRows] ?? 0) <= 10) used += hand[shownRows++] ?? 0
  const tree = drawn(store, [], 100, 10)
  const rows = tree.children as Node[]
  expect(shownRows).toBe(2)
  expect(rows.filter(row => String(row.key).startsWith('item-'))).toHaveLength(shownRows)
  expect(nodes(rows[rows.length - 1], 'Button').map(b => b.key)).toEqual(['band-more'])
  const lines = 1 + hand.slice(0, shownRows).reduce((total, n) => total + n, 0) + 1
  expect(lines).toBeLessThanOrEqual(10)
  expect(drawnLines(store, tree, 100)).toBe(lines)
  // Pressing, undoing and the window's end leave the rows folded as they are.
  for (const state of [{ state: 'done-waiting', pressedAt: 0 }, { state: 'done-pending' }] as Partial<Item>[]) {
    const items = store.items.map(it => (it.id === 3 ? { ...it, ...state } : it))
    expect(nodes(drawn({ ...store, items }, [], 100, 10), 'Button').map(b => b.key)).toEqual(nodes(tree, 'Button').map(b => b.key))
  }
})

// Eight to-dos from #11 whose 81-column titles take 2 lines at their tallest in a list of 69 (a reply leaves the title 46 columns) and in one of 100 (a reply
// leaves 77): at maxRows 10, the header's line, four rows of two and the summary's line fill it.
const ONCE = 'Review the deliberately long wrapping title of the first plain to-do item here'
const wrapping: Store = { items: Array.from({ length: 8 }, (_, k) => ({ ...at(11 + k, false), title: `${ONCE} ${k + 1}` })), next: 19, term: null }

test('a human list folds by the lines its rows take at their tallest: at a list of 70 beside the column and one of 100 full width at maxRows 10, titles that wrap beside their controls fold into the summary row, the list\'s counted lines within maxRows and the summary row its last', () => {
  const lists: [string, Node, number][] = [
    ['70 beside the column', columnsOf(drawn(wrapping, flight(1), 105, 10))[0] as Node, 69],
    ['100 full width', drawn(wrapping, [], 100, 10), 100],
  ]
  for (const [name, left, layout] of lists) {
    const rows = left.children as Node[]
    expect(drawnLines(wrapping, left, layout), name).toBeLessThanOrEqual(10)
    expect(nodes(rows[rows.length - 1], 'Button').map(b => b.key), name).toEqual(['band-more'])
    // The header, four rows of two lines and the summary's line are 10.
    expect(rows.filter(row => String(row.key).startsWith('item-')), name).toHaveLength(4)
    expect(drawnLines(wrapping, left, layout), name).toBe(10)
  }
})

test('a list beside the column folds by the lines its rows take at their tallest: eight to-dos of three lines at their tallest, at a list of 70 and maxRows 10, fold into two rows and a summary, and the Claude column is as tall as the list', () => {
  // Laid out in 69 columns (the box of 70 keeps one empty), each row is 2 lines open, 3 pressed with the label, 2 with a reply and 2 sent.
  const store: Store = {
    items: Array.from({ length: 8 }, (_, k) => ({ ...at(k + 1, false), title: 'Second to-do with a labelled control and a wrapping title too', doneLabel: 'Approve the migration ok' })),
    next: 9,
    term: null,
  }
  const [left, column] = columnsOf(drawn(store, queue(30), 105, 10)) as [Node, Node]
  expect(left.width).toBe(70)
  const rows = left.children as Node[]
  expect(nodes(rows[rows.length - 1], 'Button').map(b => b.key)).toEqual(['band-more'])
  // The header's line, two rows of three lines and the summary's: eight lines, within the room of ten that a third row would fill.
  expect(rows.filter(row => String(row.key).startsWith('item-'))).toHaveLength(2)
  expect(drawnLines(store, left, 69)).toBe(8)
  // The column beside it fills the list's lines, not its row count: its header and seven queued rows, the last a summary.
  expect(column.children).toHaveLength(8)
  expect(lineTexts(column)).toEqual(['Claude TODO 0 active, 30 queued', ...queue(6).map(it => `○ ${it.title}`), '+24 queued'])
})

test('beside the column at a list of 70, pressing a labelled to-do\'s control, undoing it and letting its window end each leave the same human rows folded, at every maxRows', () => {
  const rowsFolded = (state: Partial<Item>, maxRows: number): string => {
    const items = Array.from({ length: 8 }, (_, k) => ({
      ...at(k + 1, false),
      title: 'Second to-do with a labelled control and a wrapping title too',
      doneLabel: 'Approve the migration ok',
      ...(k === 2 ? state : {}),
    }))
    const left = columnsOf(drawn({ items, next: 9, term: null }, queue(1), 105, maxRows))[0] as Node
    // The keys of what is drawn, and the summary's label, which says how many are folded.
    return JSON.stringify([nodes(left, 'Button').map(b => b.key), nodes(left, 'Button').filter(b => b.key === 'band-more').map(b => b.label)])
  }
  let folds = 0
  for (let maxRows = 3; maxRows <= 40; maxRows++) {
    const open = rowsFolded({}, maxRows)
    expect(rowsFolded({ state: 'done-waiting', pressedAt: 0, answer: 'Approve the migration ok' }, maxRows), `pressed, maxRows ${maxRows}`).toBe(open)
    expect(rowsFolded({ state: 'done-pending', answer: 'Approve the migration ok' }, maxRows), `sent, maxRows ${maxRows}`).toBe(open)
    if (open.includes('band-more')) folds++
  }
  // The sweep crosses rows folded and rows whole.
  expect(folds).toBeGreaterThan(10)
})

test('the Claude column\'s queued rows fill down to the human list\'s counted height when a human row wraps to four lines at its tallest: header, rows and summary row', () => {
  // Fifteen words of nine letters: 3 lines in the 60 columns `[✓]` leaves a title in a list of 69, 3 in the 55 a pressed check leaves, 4 in the 47 a reply
  // leaves (four words a line) and 3 in the 57 `✓ sent` leaves: 4 lines at the tallest, and the header's one.
  const title = Array.from({ length: 15 }, () => 'abcdefghi').join(' ')
  const one: Item = { ...at(1, false), title }
  const store: Store = { items: [one], next: 2, term: null }
  const [left, right] = columnsOf(drawn(store, queue(10), 105)) as [Node, Node]
  expect(rowLines(rowTexts(one, view().windowMs), 69)).toBe(4)
  expect(drawnLines(store, left, 69)).toBe(5)
  // The column: its header, then queued rows down to the human list's five lines, the last a summary.
  expect(lineTexts(right)).toEqual(['Claude TODO 0 active, 10 queued', '○ q1', '○ q2', '○ q3', '+7 queued'])
  // The same through a press: the rows and the column do not move.
  const pressed: Store = { items: [{ ...one, state: 'done-waiting', pressedAt: 0 }], next: 2, term: null }
  sameTree(columnsOf(drawn(pressed, queue(10), 105))[1], right)
})

test('in a full-width list of 20 the header counts the lines the count wraps to beside the chip, and the fold takes them: 2 lines at 22 columns and 1 at 23, so maxRows 10 holds 3 rows of 2 lines at 22 and 4 at 23', () => {
  // Titles of `Hi`: 2 lines at their tallest at both widths (a reply goes under the title at 22 and wraps the title to a column at 23).
  const store: Store = { items: Array.from({ length: 8 }, (_, k) => ({ ...at(k + 1, false), title: 'Hi' })), next: 9, term: null }
  for (const [columns, headerRows, rows, lines] of [[22, 2, 3, 9], [23, 1, 4, 10]] as const) {
    const tree = drawn(store, [], columns, 10)
    const kids = tree.children as Node[]
    expect(kids.filter(row => String(row.key).startsWith('item-')), `${columns}`).toHaveLength(rows)
    expect(nodes(kids[kids.length - 1], 'Button').map(b => b.key), `${columns}`).toEqual(['band-more'])
    expect(drawnLines(store, tree, columns), `${columns}`).toBe(lines)
    // The header is the chip and the count as it always was, whose lines are counted: ` 8 open ` wraps to ` 8 open` and a space at 22, and fits at 23.
    expect(wrapText(' 8 open ', columns - 15).length, `${columns}`).toBe(headerRows)
  }
})

test('in a full-width list of 20 at maxRows 2, blocking and other rows folded draw the header and no row; the summary row of two lines draws from maxRows 4, and the counted lines stay within maxRows', () => {
  const store = humans(8, true)
  const summary = '+1 blocking · +7 more […]'
  expect(wrapText(summary, 20)).toEqual(['+1 blocking · +7 ', 'more […]'])
  for (const [maxRows, drawsSummary] of [[1, false], [2, false], [3, false], [4, true], [5, true]] as const) {
    const tree = drawn(store, [], 20, maxRows)
    const kids = tree.children as Node[]
    expect(kids.length, `${maxRows}`).toBe(drawsSummary ? 2 : 1)
    expect(nodes(tree, 'Button').filter(b => String(b.key).startsWith('title-')), `${maxRows}`).toEqual([])
    expect(nodes(tree, 'Button').find(b => b.key === 'band-more')?.label, `${maxRows}`).toBe(drawsSummary ? summary : undefined)
    // The header is two lines at 20: from maxRows 2 the counted lines are within it.
    if (maxRows >= 2) expect(drawnLines(store, tree, 20), `${maxRows}`).toBeLessThanOrEqual(maxRows)
  }
})

// The four rows of a live capture at a band of 105, whose human list is a box of 70: a to-do whose title wraps beside its `[✓]`, one with a label whose
// control is 28 columns, a yes/no, and a decision. They were new, so each has the unread mark.
const CAPTURED: Store = {
  items: [
    { ...at(1, false), unread: true, title: 'Review the deliberately long wrapping title of the first plain to-do item here' },
    { ...at(2, false), unread: true, title: 'Second to-do with a labelled control and a wrapping title too', doneLabel: 'Approve the migration ok' },
    { ...at(3, false), unread: true, title: 'Is the third item a yes or no question that wraps', yesno: true },
    { ...at(4, false), unread: true, title: 'Pick a decision with options that wraps as well', options: [{ label: 'Alpha', description: '', recommended: true }, { label: 'Beta', description: '', recommended: false }] },
  ],
  next: 5,
  term: 'Mr Longest Term Ever',
}

test('in the list of 70 beside the column that a live capture drew, a title that wraps beside its control is a box the room wide that the id and control leave in the 69 columns the list is laid out in, so the control is not pushed past the list', () => {
  const left = columnsOf(drawn(CAPTURED, [...flight(2), ...queue(3)], 105))[0] as Node
  expect(left).toMatchObject({ width: 70, paddingRight: 1 })
  // #1: the id takes 5 and `[✓]` with its space 4, leaving the title 60 of the 69.
  expect(cellsOf(left, 1).map(cell => cell.type)).toEqual(['Box', 'Box', 'Box'])
  expect(cellsOf(left, 1)[1]).toMatchObject({ width: 60, flexShrink: 0 })
  expect(nodes(cellsOf(left, 1)[1], 'Button').map(b => b.key)).toEqual(['title-1'])
  expect(shown(cellsOf(left, 1)[2])).toBe(' [✓]')
  // #2: the id takes 5 and `[✓ Approve the migration ok]` with its space 29, leaving the title 35.
  expect(cellsOf(left, 2)[1]).toMatchObject({ width: 35, flexShrink: 0 })
  expect(shown(cellsOf(left, 2)[2])).toBe(' [✓ Approve the migration ok]')
  // #3 and #4 fit their lines: their titles are the buttons themselves, in the row as the band has always drawn it.
  expect(cellsOf(left, 3)[1]).toMatchObject({ type: 'Button', key: 'title-3' })
  expect(cellsOf(left, 4)[1]).toMatchObject({ type: 'Button', key: 'title-4' })
  // Every wrapping row's boxes together take no more than the layout width: the id, the title's box and the control.
  for (const id of [1, 2]) {
    const [prefix, title, control] = cellsOf(left, id) as [Node, Node, Node]
    expect(displayColumns(shown(prefix)) + Number(title.width) + displayColumns(shown(control))).toBeLessThanOrEqual(69)
  }
  // Their lines at the tallest state, wrapped by hand in 69 columns. #1: its 78 columns take 2 lines in the 60 left open, 55 pressed, 47 on a reply
  // and 57 sent. #2: 2 lines open (35), 3 pressed (30, beside a control that names its 24-column label), 2 on a reply (47) and 2 sent (57). #3: one
  // line, but 2 on a reply, whose control leaves its 49 columns 47. #4: one line open with no control, 2 once pressed or replied.
  expect(CAPTURED.items.map(it => rowLines(rowTexts(it, view().windowMs), 69))).toEqual([2, 3, 2, 2])
})

test('the human rows are laid out in one column less than their box while the Claude column draws beside them, and in all of it alone: a title that wraps beside `[✓]` is a box of 54, 70 and 94 columns at a bodyColumns of 96, 120 and 155, and of 87, 111 and 146 with no Claude items', () => {
  const store: Store = { items: [{ ...at(1, false), title: LONGER }], next: 2, term: null }
  for (const [columns, beside, alone] of [[96, 54, 87], [120, 70, 111], [155, 94, 146]] as const) {
    // The id takes 5 and `[✓]` with its space 4: the title keeps the layout width less 9.
    expect(titleCellOf(columnsOf(drawn(store, queue(1), columns))[0] as Node, 1), `${columns} beside the column`).toMatchObject({ type: 'Box', width: beside, flexShrink: 0 })
    expect(titleCellOf(drawn(store, [], columns), 1), `${columns} alone`).toMatchObject({ type: 'Box', width: alone, flexShrink: 0 })
  }
})

test('a band with no Claude view (no width to fit its rows to) draws them as it always has, one line each: no box for a title, whatever its length, and a fold that counts each row and the header as a line', () => {
  const left = band(table, handlers, CAPTURED, view()) as Node
  for (const id of [1, 2, 3, 4]) {
    expect(cellsOf(left, id)[1], `${id}`).toMatchObject({ type: 'Button', key: `title-${id}` })
    expect(rowOf(left, id).flexDirection, `${id}`).toBeUndefined()
  }
  // The header and the four rows are five lines: maxRows 5 holds them whole, and maxRows 4 folds two rows into a summary row.
  expect(nodes(band(table, handlers, CAPTURED, { ...view(), maxRows: 5 }), 'Button').some(b => b.key === 'band-more')).toBe(false)
  const four = band(table, handlers, CAPTURED, { ...view(), maxRows: 4 }) as Node
  expect((four.children as Node[]).map(row => String(row.key))).toEqual(['undefined', 'item-1', 'item-2', 'undefined'])
  expect(nodes(four, 'Button').find(b => b.key === 'band-more')?.label).toBe('+2 more […]')
})
