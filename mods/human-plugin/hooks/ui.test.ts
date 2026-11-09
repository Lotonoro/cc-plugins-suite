import { expect, test } from 'claude-code/testing'
import { act, displayColumns, listText, normalizeItem } from './items'
import { answerOf, doneNotice, expire, press, reply, type Form } from './done'
import { bandDraws, headerLines, rowLayout, wrapText } from './layout'
import { backlogPane, backlogRows, band, claudeColumn, pane, paneRows, rowTexts, toolLine, type Handlers, type Table, type View } from './ui'
import { etaTail } from './todo'
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
const handlers: Handlers = { pick: () => {}, done: () => {}, more: () => {}, reply: () => {}, copy: () => {}, backlog: () => {} }
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
const mk = (state: TodoItem['state'], n: number, prefix = state === 'queued' ? 'q' : 'f'): TodoItem[] => Array.from({ length: n }, (_, k) => ({ title: `${prefix}${k + 1}`, state, eta: `eta ${prefix}${k + 1}` }))
const flight = (n: number): TodoItem[] => mk('in_flight', n)
const queue = (n: number): TodoItem[] => mk('queued', n)
const humans = (n: number, blocking = false): Store => ({ items: Array.from({ length: n }, (_, k) => at(k + 1, blocking && k === 0)), next: n + 1, term: null })
const drawn = (store: Store, todo: TodoItem[], columns: number, maxRows = 50, isDocked = false): Node => band(table, handlers, store, { ...view(), maxRows, claude: { items: todo, columns, isDocked } }) as Node
// Trees are compared as JSON: a press handler is a fresh closure on every draw.
const sameTree = (a: unknown, b: unknown, name?: string): void => expect(JSON.stringify(a), name).toBe(JSON.stringify(b))
const columnsOf = (tree: Node): Node[] => (tree.children ?? []) as Node[]
// The Claude column's lines: each is a button of its own, its text its label.
const lineTexts = (column: Node): string[] => (column.children as Node[]).map(row => String(row.label))

test('with no Claude items the human list draws the same at a wide band and a narrow one, nothing in it cut', () => {
  const wide = drawn(humans(2), [], 120)
  for (const columns of [90, 300]) sameTree(drawn(humans(2), [], columns), wide)
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

test('the human column holds the rows the human list draws alone in the layout width it keeps beside the column', () => {
  const store = humans(3, true)
  // The box of 80 beside the column keeps one column empty: its rows are laid out in 79.
  const alone = drawn(store, [], 79) as Node
  const left = columnsOf(drawn(store, queue(1), 120))[0] as Node
  sameTree(left.children, alone.children)
  expect(nodes(left, 'Button').map(b => b.key)).toEqual(nodes(alone, 'Button').map(b => b.key))
})

test('under 96 columns the Claude column hides and the human list draws as it does with no Claude items', () => {
  sameTree(drawn(humans(2), [...flight(1), ...queue(2)], 90), drawn(humans(2), [], 90))
})

test('the Claude column draws each row as its glyph and its title, with no ETA', () => {
  const right = columnsOf(drawn(humans(2), [...flight(1), ...queue(1)], 120))[1] as Node
  const rows = lineTexts(right).slice(1).join('\n')
  expect(rows).toContain('◐ f1')
  expect(rows).toContain('○ q1')
  expect(rows).not.toMatch(/eta|ETA/)
})

test('the Claude header counts the list in the short form, in flight as active', () => {
  const right = columnsOf(drawn(humans(2), [...flight(2), ...queue(3)], 120))[1] as Node
  expect(lineTexts(right)[0]).toBe('Claude TODO 2 active, 3 queued')
})

test('the header is a button handed its text cut at the column\'s layout width: 31 beside the human list, which cuts the two-digit counts\' 32 columns with an ellipsis; alone the column is laid out in its 32 and holds them whole', () => {
  const header = (store: Store, todo: TodoItem[]) => (columnsOf(drawn(store, todo, 96))[store.items.length === 0 ? 0 : 1] as Node).children?.[0] as Node
  const twoDigits = [...flight(12), ...queue(13)]
  const beside = header(humans(2), twoDigits)
  const box = columnsOf(drawn(humans(2), twoDigits, 96))[1] as Node
  // The box is 32 wide and keeps its first column empty: the text is cut to the 31 after it, and ends in an ellipsis.
  expect(Number(box.width) - Number(box.paddingLeft)).toBe(31)
  expect([beside.type, beside.key, beside.plain]).toEqual(['Button', 'claude-header', true])
  expect(beside.label).toBe('Claude TODO 12 active, 13 queu…')
  expect(displayColumns(String(beside.label))).toBe(31)
  // One-digit counts, 30 columns, are whole in the 31.
  expect(header(humans(2), [...flight(1), ...queue(1)]).label).toBe('Claude TODO 1 active, 1 queued')
  // Alone, the column is 32 wide with no empty column: the same header is whole.
  const alone = columnsOf(drawn(humans(0), twoDigits, 96))[0] as Node
  expect(alone).toMatchObject({ width: 32 })
  expect(alone.paddingLeft).toBeUndefined()
  expect(header(humans(0), twoDigits).label).toBe('Claude TODO 12 active, 13 queued')
  const over = header(humans(2), [...flight(120), ...queue(13)])
  expect(over.label).toBe('Claude TODO 120 active, 13 que…')
  expect(displayColumns(String(over.label))).toBe(31)
})

test('a row is a button of the state\'s glyph and the title on one line, in-flight first, handed its text cut at the column\'s layout width', () => {
  const long = 'x'.repeat(80)
  const right = columnsOf(drawn(humans(6), [{ title: 'queued one', state: 'queued', eta: 'no ETA' }, { title: long, state: 'in_flight', eta: 'no ETA' }], 120))[1] as Node
  const rows = (right.children as Node[]).slice(1)
  // The column is 40 wide and keeps one column empty: a title that does not fit the 39 is cut to 38 columns and an ellipsis, the glyph and its space among them.
  expect(rows.map(row => [row.type, row.plain, row.label])).toEqual([['Button', true, `◐ ${'x'.repeat(36)}…`], ['Button', true, '○ queued one']])
  expect(rows.map(row => row.wrap)).toEqual([undefined, undefined])
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
    // The Claude column\'s lines are buttons handed their text cut to the box less its padding, none with a width of its own or a cut of its own.
    expect(Number(right.width) - Number(right.paddingLeft), where).toBe(cut)
    for (const line of right.children as Node[]) expect([line.type, line.wrap, line.width, displayColumns(String(line.label)) <= cut], where).toEqual(['Button', undefined, undefined, true])
  }
})

// The trees the band draws for a list alone, with no padding on any box: the human list of two plain to-dos whose rows fit their lines, each its prefix, its title in a
// box that shrinks and a control cell of 17 columns (the reply's `✓ replied [↶ 5s]` and the space before it), and the Claude column alone at 120 and at 40.
const TODAY_HUMAN = '{"type":"Box","flexDirection":"column","children":[{"type":"Box","children":[{"type":"Box","flexShrink":0,"children":[{"type":"Text","bold":true,"color":"inverseText","backgroundColor":"permission","children":[" To do for you "]}]},{"type":"Text","children":[" 2 open "]}]},{"type":"Box","key":"item-1","children":[{"type":"Box","flexShrink":0,"children":[{"type":"Text","bold":false,"dimColor":true,"children":["  #1 "]}]},{"type":"Box","flexShrink":1,"children":[{"type":"Button","key":"title-1","plain":true,"label":"Pick a db"}]},{"type":"Box","width":17,"flexShrink":0,"children":[{"type":"Text","children":[" "]},{"type":"Button","key":"done-1","plain":true,"label":"[✓]"}]}]},{"type":"Box","key":"item-2","children":[{"type":"Box","flexShrink":0,"children":[{"type":"Text","bold":false,"dimColor":true,"children":["  #2 "]}]},{"type":"Box","flexShrink":1,"children":[{"type":"Button","key":"title-2","plain":true,"label":"Pick a db"}]},{"type":"Box","width":17,"flexShrink":0,"children":[{"type":"Text","children":[" "]},{"type":"Button","key":"done-2","plain":true,"label":"[✓]"}]}]}]}'
const TODAY_CLAUDE_120 = '{"type":"Box","flexDirection":"row","justifyContent":"flex-end","width":120,"children":[{"type":"Box","flexDirection":"column","width":40,"children":[{"type":"Button","key":"claude-header","plain":true,"label":"Claude TODO 1 active, 0 queued"},{"type":"Button","key":"claude-row-0","plain":true,"label":"◐ f1"}]}]}'
const TODAY_CLAUDE_40 = '{"type":"Box","flexDirection":"row","justifyContent":"flex-end","width":40,"children":[{"type":"Box","flexDirection":"column","width":32,"children":[{"type":"Button","key":"claude-header","plain":true,"label":"Claude TODO 1 active, 0 queued"},{"type":"Button","key":"claude-row-0","plain":true,"label":"◐ f1"}]}]}'

test('a list drawn alone is the tree the band draws with no padding on any box: the human list at 120 and 90 columns with no Claude items, the Claude column at 120 and 40 with no human items', () => {
  const alone: [string, Node, string][] = [
    ['human at 120', drawn(humans(2), [], 120), TODAY_HUMAN],
    ['human at 90', drawn(humans(2), [], 90), TODAY_HUMAN],
    ['Claude at 120', drawn(humans(0), flight(1), 120), TODAY_CLAUDE_120],
    ['Claude at 40', drawn(humans(0), flight(1), 40), TODAY_CLAUDE_40],
  ]
  for (const [name, tree, golden] of alone) {
    // A press handler is a fresh closure on every draw, so the tree is compared as the JSON it serializes to.
    expect(JSON.parse(JSON.stringify(tree)), name).toEqual(JSON.parse(golden))
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
      // The human list alone: one column of its header and rows, the width of the band and nothing of the Claude column.
      expect(wide, c.name).toMatchObject({ type: 'Box', flexDirection: 'column' })
      expect(wide.width, c.name).toBeUndefined()
      expect(shown(wide), c.name).not.toContain('Claude TODO')
    } else {
      const [left, right] = columnsOf(wide)
      expect(texts(left).join(''), c.name).toContain('To do for you')
      expect(shown(right), c.name).toContain('Claude TODO')
    }
    if (c.narrow === 'claude') expect(shown(narrow), c.name).toContain('Claude TODO')
    else expect(shown(narrow), c.name).not.toContain('Claude TODO')
    if (c.narrow === 'human') sameTree(narrow, drawn(c.human, [], 90, c.maxRows), c.name)
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
  sameTree(same.children, drawn(store, [], 79, 10).children)
  // Header and 10 in-flight rows are 11 rows: one row earlier, the summary the 9th row.
  const earlier = human(flight(10))
  expect(rowCount(earlier)).toBe(9)
  const last = (earlier.children as Node[])[8] as Node
  expect(nodes(last, 'Button').map(b => b.key)).toEqual(['band-more'])
  expect(nodes(earlier, 'Button').filter(b => String(b.key).startsWith('title-'))).toHaveLength(7)
})

test('with maxRows 10 and a column no taller than maxRows the human list folds as it does with no Claude items', () => {
  const store = humans(12)
  sameTree((columnsOf(drawn(store, flight(3), 120, 10))[0] as Node).children, drawn(store, [], 79, 10).children)
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

// A box of `box` columns for the human list beside the Claude column: the smallest band whose human box is that wide (the column is a third of the band,
// at least 32).
const bandFor = (box: number): number => {
  for (let columns = 96; ; columns++) if (columns - Math.max(32, Math.floor(columns / 3)) === box) return columns
}

// A human list as the band draws it, with the columns its rows are laid out in: beside the Claude column, in a box of `list` columns that keeps one
// empty, or full width, laid out in all of its `list`. `maxRows` leaves room for every row. A squeezed list is a box of 20 to 63 columns, which the band draws
// only beside this plugin's docked pane, at `list` and the column's 32.
const BESIDE = 'beside the column'
const FULL = 'full width'
const SQUEEZED = 'squeezed beside the docked pane'
type Where = typeof BESIDE | typeof FULL | typeof SQUEEZED
const humanList = (store: Store, list: number, where: Where, maxRows = 1000): { left: Node; layout: number } =>
  where === BESIDE
    ? { left: columnsOf(drawn(store, queue(1), bandFor(list), maxRows))[0] as Node, layout: list - 1 }
    : where === SQUEEZED
      ? { left: columnsOf(drawn(store, queue(1), list + 32, maxRows, true))[0] as Node, layout: list - 1 }
      : { left: drawn(store, [], list, maxRows), layout: list }

const U3 = '[↶ 3s]'
const saidControl = (answer: string, mark = '✓') => ({ before: `${mark} `, answer, after: answer === '' ? U3 : ` ${U3}` })
const REPLIED_CONTROL = { before: '✓ replied ', answer: '', after: U3 }

test('the row\'s texts are built once for the drawing and the layout: the id, the title on one line and a decision\'s marker, the open control around its answer, and each way a press can say its answer', () => {
  expect(rowTexts(at(12, false), 3000)).toEqual({
    prefix: '  #12 ',
    title: 'Pick a db',
    marker: '',
    open: { before: '[✓]', answer: '', after: '' },
    pressed: [saidControl(''), REPLIED_CONTROL],
    squeezed: `✓ ${U3}`,
    sent: '✓ sent',
  })
  expect(rowTexts({ ...at(12, false), unread: true }, 3000).prefix).toBe('• #12 ')
  expect(rowTexts({ ...at(1, false), doneLabel: 'Go with sqlite' }, 3000)).toMatchObject({
    open: { before: '[✓ ', answer: 'Go with sqlite', after: ']' },
    pressed: [saidControl('Go with sqlite'), REPLIED_CONTROL, saidControl('')],
  })
  expect(rowTexts({ ...at(1, false), yesno: true }, 3000)).toMatchObject({
    open: { before: '[✓] [✗]', answer: '', after: '' },
    pressed: [saidControl('yes'), saidControl('no', '✗'), REPLIED_CONTROL, saidControl('')],
  })
  const options = [{ label: 'Use sqlite', description: '', recommended: false }, { label: 'Use postgres', description: '', recommended: true }]
  expect(rowTexts({ ...at(1, false), options }, 3000)).toMatchObject({
    title: 'Pick a db',
    marker: ' […]',
    open: { before: '', answer: '', after: '' },
    pressed: [saidControl('Use sqlite'), saidControl('Use postgres'), REPLIED_CONTROL, saidControl('')],
  })
  // A line break and the blanks around it are one space.
  expect(rowTexts({ ...at(1, false), title: 'Ask the owner \n  then the one' }, 3000).title).toBe('Ask the owner then the one')
  // The undo button at its widest, the first second of the window: the seconds it starts from.
  expect(rowTexts(at(1, false), 12000).pressed[0]?.after).toBe('[↶ 12s]')
  expect(rowTexts(at(1, false), 12000).squeezed).toBe('✓ [↶ 12s]')
  expect(rowTexts(at(1, false), 2500).squeezed).toBe('✓ [↶ 3s]')
  expect(rowTexts(at(1, false), 0).squeezed).toBe('✓ [↶ 0s]')
})

// Every kind of control, with the states it reaches and what each draws as a control in a row whose answer width is `answer` columns and whose pressed controls
// are `squeezed` or not. A to-do's longest label is 24 columns, a term's 20, and a decision's option has no limit. The undo window is view()'s: 5 seconds, from the
// press. The answers are ASCII, so a text's length is its columns.
const LABEL = 'Go with sqlite for cache'
const TERM = 'Operations lead team'
const LONG = 'A title that is longer than the list and has a pneumonoultramicroscopic word'
const LONGER = `${LONG} and goes on, with ${LONG}`
const BROKEN = 'Ask the owner first\nthen the one who wrote the long title that wraps in a narrow list'
const OPTION = 'Use sqlite for the cache'
const LONG_OPTION = `${Array.from({ length: 30 }, () => 'word').join(' ')}x`
const choicesOf = (first: string) => [{ label: first, description: '', recommended: true }, { label: 'Use postgres', description: '', recommended: false }]
const UNDO = '[↶ 5s]'
const waiting = (answer: string | null, replied = false): Partial<Item> => ({ state: 'done-waiting', pressedAt: 0, answer, replied })
const SENT: Partial<Item> = { state: 'done-pending', answer: 'Use it', replied: true }
const cutA = (text: string, columns: number): string => (text.length <= columns ? text : `${text.slice(0, columns - 1)}…`)
type KindState = { name: string; over: Partial<Item>; answer: string | null; text: (answer: number, squeezed: boolean) => string }
type Kind = { name: string; base: Partial<Item>; states: KindState[] }
const replyState = (mark = '✓'): KindState => ({ name: 'pressed with a reply', over: waiting('Not yet', true), answer: null, text: (_, squeezed) => (squeezed ? `${mark} ${UNDO}` : `✓ replied ${UNDO}`) })
const sentState: KindState = { name: 'sent', over: SENT, answer: null, text: () => '✓ sent' }
const answered = (name: string, answer: string, mark = '✓'): KindState => ({
  name,
  over: waiting(answer),
  answer,
  text: (k, squeezed) => (squeezed ? `${mark} ${UNDO}` : `${mark} ${cutA(answer, k)} ${UNDO}`),
})
const KINDS: Kind[] = [
  {
    name: 'a plain to-do',
    base: {},
    states: [
      { name: 'open', over: {}, answer: null, text: () => '[✓]' },
      { name: 'pressed with none', over: waiting(null), answer: null, text: () => `✓ ${UNDO}` },
      replyState(),
      sentState,
    ],
  },
  {
    name: 'a labelled to-do',
    base: { doneLabel: LABEL },
    states: [{ name: 'open', over: {}, answer: null, text: k => `[✓ ${cutA(LABEL, k)}]` }, answered('pressed with its label', LABEL), replyState(), sentState],
  },
  {
    name: 'a yes/no',
    base: { yesno: true },
    states: [
      { name: 'open', over: {}, answer: null, text: () => '[✓] [✗]' },
      answered('pressed yes', 'yes'),
      answered('pressed no', 'no', '✗'),
      { ...replyState(), over: waiting('no', true) },
      sentState,
    ],
  },
  {
    name: 'a decision',
    base: { options: choicesOf(OPTION) },
    states: [{ name: 'open', over: {}, answer: null, text: () => '' }, answered('pressed with an option', OPTION), replyState(), sentState],
  },
  {
    name: 'a decision with an option of 150 columns',
    base: { options: choicesOf(LONG_OPTION) },
    states: [{ name: 'open', over: {}, answer: null, text: () => '' }, answered('pressed with the long option', LONG_OPTION), replyState(), sentState],
  },
]

// A title cut by hand at its room, ASCII: whole, or the start that leaves a column for the ellipsis, a decision's marker kept whole after it where the room holds both.
const labelBy = (title: string, marker: string, room: number): string => {
  if (title.length + marker.length <= room) return title + marker
  if (marker !== '' && room >= marker.length + 1) return `${title.slice(0, room - marker.length - 1)}…${marker}`
  return `${title}${marker}`.slice(0, room - 1) + '…'
}

// The cells of a drawn row: the row itself and its cells.
const rowOf = (left: Node, id: number): Node => nodes(left, 'Box').find(box => box.key === `item-${id}`) as Node
const cellsOf = (left: Node, id: number): Node[] => rowOf(left, id).children as Node[]

// One kind of control in one state, drawn as a row of a list whose rows are laid out in `layoutWidth` columns: one row of three cells, none under another;
// the prefix; the title's label in a box that shrinks, the title cut by hand to the room the prefix and the control cell leave it; the control cell of the
// layout's width with the state's control at its start, a pressed answer in a box of the layout's answer width holding the answer cut by hand to it; and no
// Button in the list holding a Text. It returns the title's label and the control cell's width, which every state of a kind shares. `squeezed`: the row is in a
// squeezed list, which starts its ladder at the third rung: every pressed control is its mark and undo button, with no box for an answer.
const checkRow = (left: Node, layoutWidth: number, row: Item, state: KindState, digits: number, where: string, squeezed = false): { label: string; width: number } => {
  const id = row.id
  const laid = rowLayout(rowTexts(row, view().windowMs), layoutWidth, squeezed)
  if (squeezed) expect(laid.rung, where).toBe(3)
  expect(rowOf(left, id).flexDirection, where).toBeUndefined()
  const cells = cellsOf(left, id)
  expect(
    cells.map(cell => cell.type),
    where,
  ).toEqual(['Box', 'Box', 'Box'])
  const [prefix, titleCell, controlCell] = cells as [Node, Node, Node]
  expect(prefix, where).toMatchObject({ flexShrink: 0 })
  const prefixColumns = displayColumns(shown(prefix))
  expect(prefixColumns, where).toBe(digits + 4)
  // The title: a button in a box that shrinks, its label the one-line title cut to the room the prefix and the control cell leave it.
  expect(titleCell, where).toMatchObject({ flexShrink: 1 })
  expect(
    (titleCell.children as Node[]).map(kid => [kid.type, kid.key]),
    where,
  ).toEqual([['Button', `title-${id}`]])
  const label = String((titleCell.children as Node[])[0]?.label)
  const room = Math.max(1, layoutWidth - prefixColumns - Number(controlCell.width))
  const marker = row.options.length > 0 ? ' […]' : ''
  expect(label, where).toBe(labelBy(row.title.replace(/\s*\n\s*/g, ' '), marker, room))
  expect(displayColumns(label), where).toBeLessThanOrEqual(room)
  expect(controlCell.width, where).toBe(laid.control)
  expect(laid.room, where).toBe(room)
  // The control cell: of the control column's width, never shrunk, the state's control after a space at its start (none for a decision still open).
  expect(controlCell, where).toMatchObject({ flexShrink: 0 })
  const want = state.text(laid.answer, laid.rung === 3)
  const kids = controlCell.children as Node[]
  if (want === '') {
    expect(kids, where).toEqual([])
  } else {
    expect(kids[0], where).toEqual({ type: 'Text', children: [' '] })
    expect(shown(controlCell), where).toBe(` ${want}`)
    expect(displayColumns(shown(controlCell)), where).toBeLessThanOrEqual(Number(controlCell.width))
  }
  // A pressed answer sits in a box of the row's answer width, or its own width when that is smaller, and is cut to it. A squeezed pressed control has no box
  // and no answer text.
  if (state.answer !== null && laid.rung !== 3) {
    const boxes = nodes(controlCell, 'Box').filter(box => box !== controlCell && box.width !== undefined)
    expect(boxes, where).toHaveLength(1)
    expect(boxes[0], where).toMatchObject({ width: Math.min(state.answer.length, laid.answer), flexShrink: 0 })
    expect(shown(boxes[0]), where).toBe(cutA(state.answer, laid.answer))
  } else if (state.answer !== null) {
    expect(nodes(controlCell, 'Box').filter(box => box !== controlCell && box.width !== undefined), where).toEqual([])
    expect(shown(controlCell), where).not.toContain(state.answer)
  }
  for (const button of nodes(left, 'Button')) expect(nodes(button, 'Text'), `${where}: a button holding a text`).toEqual([])
  return { label, width: Number(controlCell.width) }
}

// Every kind of control in every state, as a row of a list of each of `lists` columns, at an id of `digits` digits and for each title.
const sweep = (where: Where, lists: number[], titles: string[], digits: number): void => {
  const id = Number('1'.repeat(digits))
  for (const kind of KINDS) {
    for (const title of titles) {
      for (const list of lists) {
        const layout = where === FULL ? list : list - 1
        const labels = new Set<string>()
        const widths = new Set<number>()
        for (const state of kind.states) {
          const name = `${kind.name}, ${state.name}, ${digits} digits, list of ${list} ${where}, ${JSON.stringify(title)}`
          const row: Item = { ...at(id, false), title, ...kind.base, ...state.over }
          const drawnList = humanList({ items: [row], next: id + 1, term: TERM }, list, where)
          expect(drawnList.layout, name).toBe(layout)
          if (where !== FULL) expect(drawnList.left, name).toMatchObject({ type: 'Box', flexDirection: 'column', width: list, paddingRight: 1 })
          else expect(drawnList.left.width, name).toBeUndefined()
          const drawnRow = checkRow(drawnList.left, layout, row, state, digits, name, where === SQUEEZED)
          labels.add(drawnRow.label)
          widths.add(drawnRow.width)
        }
        // A press, an undo and the window's end move nothing: the title's label and the control cell's width are the same in every state, so the control
        // starts on the same column throughout.
        expect(labels.size, `${kind.name}, ${digits} digits, list of ${list} ${where}: title labels`).toBe(1)
        expect(widths.size, `${kind.name}, ${digits} digits, list of ${list} ${where}: control cells`).toBe(1)
      }
    }
  }
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k)

for (const digits of [1, 2, 3, 4]) {
  test(`every kind of control in every state, at an id of ${digits} digit${digits === 1 ? '' : 's'} and a full-width list of 20 to 63, with a title longer than the list and one holding a line break: the row is one line of three cells, the title is cut to its room, and the control starts on the same column in every state`, () => {
    sweep(FULL, range(20, 63), [LONG, BROKEN], digits)
  })

  test(`every kind of control in every state, at an id of ${digits} digit${digits === 1 ? '' : 's'} and a squeezed list of 20 to 63 beside the Claude column, with a title longer than the list and one holding a line break: the row is one line of three cells, the title is cut to its room, the control starts on the same column in every state, and every pressed control is its mark and undo button with no answer text`, () => {
    sweep(SQUEEZED, range(20, 63), [LONG, BROKEN], digits)
  })

  test(`every kind of control in every state, at an id of ${digits} digit${digits === 1 ? '' : 's'} and a list of 64 to 120 beside the Claude column and full width: the row is one line of three cells, the title is cut to its room, and the control starts on the same column in every state`, () => {
    sweep(BESIDE, range(64, 120), [LONGER], digits)
    sweep(FULL, range(64, 120), [LONGER], digits)
  })
}

test('a title that fits its room is drawn whole, and the control follows it one blank after: nothing is cut in a list of 64 or more for a short title, and the row\'s text is the id, the title, a space and the control', () => {
  for (const [name, store, text] of [
    ['a plain to-do', { items: [at(12, false)], next: 13, term: null }, '  #12 Pick a db [✓]'],
    ['a yes/no', { items: [yesNo({ id: 12, blocking: false })], next: 13, term: null }, '  #12 Pick a db [✓] [✗]'],
    ['a to-do labelled at 24 columns', { items: [{ ...at(12, false), doneLabel: LABEL }], next: 13, term: null }, `  #12 Pick a db [✓ ${LABEL}]`],
    ['a decision', { items: [{ ...at(12, false), options: choicesOf(OPTION) }], next: 13, term: null }, '  #12 Pick a db […]'],
  ] as [string, Store, string][]) {
    for (const [where, list] of [[BESIDE, 64], [BESIDE, 70], [FULL, 64], [FULL, 100], [FULL, 120]] as const) {
      const row = rowOf(humanList(store, list, where).left, 12)
      expect(shown(row).trimEnd(), `${name}, ${list} ${where}`).toBe(text)
    }
  }
})

test('pressing the control of a to-do whose label is cut passes the whole label on, and the undo of its pressed control undoes', () => {
  const calls: [number, string | null][] = []
  const press: Handlers = { ...handlers, done: (id, answer) => void calls.push([id, answer]) }
  const labelled: Item = { ...at(1, false), doneLabel: LABEL }
  const columns = 38
  const open = band(table, press, { items: [labelled], next: 2, term: null }, { ...view(), claude: { items: [], columns } })
  const control = nodes(open, 'Button').find(b => b.key === 'done-1')
  // The id takes 5 and the title keeps 10 of the 38 columns, so the control column is 23 columns at most: the label is cut to 13 columns.
  expect(control?.label).toBe('[✓ Go with sqli…]')
  ;(control?.onPress as () => void)()
  const pressed = band(table, press, { items: [{ ...labelled, ...waiting(LABEL) }], next: 2, term: null }, { ...view(), claude: { items: [], columns } })
  expect(shown(cellsOf(pressed as Node, 1)[2])).toBe(' ✓ Go with sqli… [↶ 5s]')
  ;(nodes(pressed, 'Button').find(b => b.key === 'done-1')?.onPress as () => void)()
  expect(calls).toEqual([[1, LABEL], [1, null]])
})

test('a squeezed pressed control is its mark and its undo button, for a yes/no\'s no a cross: `✓ [↶ 5s]` and `✗ [↶ 5s]` in a full-width list of 25, whatever the answer, a reply included', () => {
  const rows: [string, Item, string][] = [
    ['a plain to-do', { ...at(1, false), ...waiting(null) }, `✓ ${UNDO}`],
    ['a to-do pressed with its label', { ...at(1, false), doneLabel: LABEL, ...waiting(LABEL) }, `✓ ${UNDO}`],
    ['a yes/no pressed yes', yesNo({ id: 1, blocking: false, ...waiting('yes') }), `✓ ${UNDO}`],
    ['a yes/no pressed no', yesNo({ id: 1, blocking: false, ...waiting('no') }), `✗ ${UNDO}`],
    ['a reply', { ...at(1, false), ...waiting('Not yet', true) }, `✓ ${UNDO}`],
    ['a decision pressed with an option', { ...at(1, false), options: choicesOf(OPTION), ...waiting(OPTION) }, `✓ ${UNDO}`],
  ]
  for (const [name, row, control] of rows) {
    const left = drawn({ items: [row], next: 2, term: null }, [], 25)
    expect(shown(cellsOf(left, 1)[2]), name).toBe(` ${control}`)
    const cell = cellsOf(left, 1)[2] as Node
    expect(nodes(cell, 'Box').filter(box => box !== cell && box.width !== undefined), name).toEqual([])
  }
})

test('the summary row is cut at the list\'s layout width with an ellipsis, on its warning fill, and a press on it still opens the first folded item', () => {
  const opened: number[] = []
  const press: Handlers = { ...handlers, more: id => void opened.push(id) }
  const summary = '+1 blocking · +7 more […]'
  expect(displayColumns(summary)).toBe(25)
  const store = humans(8, true)
  for (const [columns, label] of [[40, summary], [25, summary], [20, '+1 blocking · +7 mo…'], [19, '+1 blocking · +7 m…']] as const) {
    // The rows the header leaves are one: the summary of every item.
    const probe = band(table, press, store, { ...view(), claude: { items: [], columns } }) as Node
    const [chip, count] = ((probe.children as Node[])[0] as Node).children as [Node, Node]
    const tree = band(table, press, store, { ...view(), maxRows: headerLines(shown(chip), shown(count), columns) + 1, claude: { items: [], columns } }) as Node
    const rows = (tree.children as Node[]).slice(1)
    expect(rows, `${columns}`).toHaveLength(1)
    expect(rows[0], `${columns}`).toMatchObject({ type: 'Box', backgroundColor: 'warning' })
    const more = nodes(tree, 'Button').find(b => b.key === 'band-more')
    expect(more?.label, `${columns}`).toBe(label)
    expect(displayColumns(String(more?.label)), `${columns}`).toBeLessThanOrEqual(columns)
    ;(more?.onPress as () => void)()
  }
  expect(opened).toEqual([1, 1, 1, 1])
})

test('in a full-width list the header counts the lines the count wraps to beside the chip, and the fold takes them: 2 lines at 22 columns and 1 at 23, so maxRows 10 holds 7 rows and a summary at 22 and 9 whole at 23', () => {
  const store = humans(9)
  for (const [columns, headerRows, rows, summary] of [[22, 2, 7, true], [23, 1, 9, false]] as const) {
    const tree = drawn(store, [], columns, 10)
    const kids = tree.children as Node[]
    expect(kids.filter(row => String(row.key).startsWith('item-')), `${columns}`).toHaveLength(rows)
    expect(nodes(kids[kids.length - 1], 'Button').some(b => b.key === 'band-more'), `${columns}`).toBe(summary)
    // The header is the chip and the count as it always was, whose lines are counted: ` 9 open ` wraps to ` 9 open` and a space at 22, and fits at 23.
    expect(wrapText(' 9 open ', columns - 15).length, `${columns}`).toBe(headerRows)
    expect(kids.length - 1 + headerRows, `${columns}`).toBeLessThanOrEqual(10)
  }
})

test('every row is one line, so a list folds by its rows and not by their text: 12 items at maxRows 10 draw the header, 8 items and the summary, whatever the titles, at a list of 20 and of 100, and a column as tall as the list fills down to its lines', () => {
  const store: Store = { items: Array.from({ length: 12 }, (_, k) => ({ ...at(k + 1, false), title: k % 2 === 0 ? LONGER : 'Hi' })), next: 13, term: null }
  for (const columns of [30, 100]) {
    const tree = drawn(store, [], columns, 10)
    const kids = tree.children as Node[]
    expect(kids.filter(row => String(row.key).startsWith('item-')), `${columns}`).toHaveLength(8)
    expect(nodes(kids[kids.length - 1], 'Button').map(b => b.key), `${columns}`).toEqual(['band-more'])
    expect(kids, `${columns}`).toHaveLength(10)
  }
  // Beside the column the Claude column is as tall as the list: its header and one row for each of the list's lines under its header.
  const [left, right] = columnsOf(drawn(humans(8), queue(30), 105, 10)) as [Node, Node]
  expect((left.children as Node[]).length).toBe(9)
  expect(lineTexts(right)).toEqual(['Claude TODO 0 active, 30 queued', ...queue(7).map(it => `○ ${it.title}`), '+23 queued'])
})

test('pressing a control, undoing it and letting its window end leave the same rows folded and the same control cell, at every maxRows', () => {
  const rowsFolded = (state: Partial<Item>, maxRows: number): string => {
    const items = Array.from({ length: 8 }, (_, k) => ({
      ...at(k + 1, false),
      title: 'Second to-do with a labelled control and a long title too',
      doneLabel: 'Approve the migration ok',
      ...(k === 2 ? state : {}),
    }))
    const left = columnsOf(drawn({ items, next: 9, term: null }, queue(1), 105, maxRows))[0] as Node
    // The keys of what is drawn, the summary's label (it says how many are folded), and the width of every control cell.
    const cellWidths = nodes(left, 'Box').filter(b => String(b.key).startsWith('item-')).map(row => (row.children as Node[])[2]?.width)
    return JSON.stringify([nodes(left, 'Button').map(b => b.key), nodes(left, 'Button').filter(b => b.key === 'band-more').map(b => b.label), cellWidths])
  }
  let folds = 0
  for (let maxRows = 3; maxRows <= 40; maxRows++) {
    const open = rowsFolded({}, maxRows)
    expect(rowsFolded({ state: 'done-waiting', pressedAt: 0, answer: 'Approve the migration ok' }, maxRows), `pressed, maxRows ${maxRows}`).toBe(open)
    expect(rowsFolded({ state: 'done-pending', answer: 'Approve the migration ok' }, maxRows), `sent, maxRows ${maxRows}`).toBe(open)
    if (open.includes('band-more')) folds++
  }
  // The sweep crosses rows folded and rows whole: the header and 8 one-line rows fit from a maxRows of 9, so 3 to 8 fold.
  expect(folds).toBe(6)
})

test('in the pane an item\'s pressed control is drawn as the band has always drawn it there: its mark, its answer whole and its undo button, no answer box and nothing cut, at any band width', () => {
  const decision: Item = { ...at(1, false), options: choicesOf(LONG_OPTION), ...waiting(LONG_OPTION) }
  const replied: Item = { ...at(1, false), ...waiting(`${'a long reply '.repeat(20)}`, true) }
  for (const [name, row, words] of [
    ['a decision pressed with a 150-column option', decision, `✓ ${LONG_OPTION} `],
    ['a long reply', replied, `✓ replied: ${replied.answer} `],
  ] as const) {
    const trees = [20, 64, 96, 120].map(columns => pane(table, handlers, { items: [row], next: 2, term: null }, { ...view(), selected: 1, claude: { items: [], columns } }))
    for (const tree of trees) {
      expect(nodes(tree, 'Text').some(text => texts(text).join('') === words), name).toBe(true)
      expect(nodes(tree, 'Box').filter(box => box.width !== undefined), name).toEqual([])
      expect(nodes(tree, 'Button').find(b => b.key === 'done-1')?.label, name).toBe('[↶ 5s]')
    }
    for (const tree of trees) sameTree(tree, trees[0], name)
  }
})

// The four rows of a live capture at a band of 105, whose human list is a box of 70: a to-do whose title is longer than its room beside its `[✓]`, one with a
// label whose control is 28 columns, a yes/no, and a decision. They were new, so each has the unread mark.
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

test('in the list of 70 beside the column that a live capture drew, each row is one line of the prefix, a title cut to its room and a control cell, which together are the 69 columns the list is laid out in', () => {
  const left = columnsOf(drawn(CAPTURED, [...flight(2), ...queue(3)], 105))[0] as Node
  expect(left).toMatchObject({ width: 70, paddingRight: 1 })
  // The id and the unread mark take 5. #1, #3 and #4 have a control column of 17 (the reply's `✓ replied [↶ 5s]` and the space), leaving their titles 47; #2's
  // label of 24 columns makes it 34 (`✓ Approve the migration ok [↶ 5s]` and the space), leaving 30.
  const want: [number, number, number][] = [[1, 17, 47], [2, 34, 30], [3, 17, 47], [4, 17, 47]]
  for (const [id, control, room] of want) {
    const [prefix, title, controlCell] = cellsOf(left, id) as [Node, Node, Node]
    expect(displayColumns(shown(prefix)), `#${id}`).toBe(5)
    expect(controlCell.width, `#${id}`).toBe(control)
    expect(displayColumns(shown(title)), `#${id}`).toBe(room)
    expect(5 + room + control, `#${id}`).toBe(69)
  }
  expect(shown(cellsOf(left, 1)[1])).toBe('Review the deliberately long wrapping title of…')
  expect(shown(cellsOf(left, 2)[1])).toBe('Second to-do with a labelled …')
  expect(shown(cellsOf(left, 3)[1])).toBe('Is the third item a yes or no question that wr…')
  expect(shown(cellsOf(left, 4)[1])).toBe('Pick a decision with options that wraps as… […]')
  expect(shown(cellsOf(left, 2)[2])).toBe(' [✓ Approve the migration ok]')
})

test('the human rows are laid out in one column less than their box while the Claude column draws beside them, and in all of it alone: a title cut at the room beside `[✓]` is 41, 57 and 81 columns at a bodyColumns of 96, 120 and 155, and 74, 98 and 133 with no Claude items', () => {
  const store: Store = { items: [{ ...at(1, false), title: LONGER }], next: 2, term: null }
  const labelColumns = (left: Node): number => displayColumns(shown(cellsOf(left, 1)[1]))
  for (const [columns, beside, alone] of [[96, 41, 74], [120, 57, 98], [155, 81, 133]] as const) {
    // The id takes 5 and `[✓]` with the reply's `✓ replied [↶ 5s]` makes the control column 17: the title keeps the layout width less 22.
    expect(labelColumns(columnsOf(drawn(store, queue(1), columns))[0] as Node), `${columns} beside the column`).toBe(beside)
    expect(labelColumns(drawn(store, [], columns)), `${columns} alone`).toBe(alone)
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

// The pane docked: the band is the transcript's column, and both lists draw from 52 columns.
const docked = (store: Store, todo: TodoItem[], columns = 52, maxRows = 50): Node => drawn(store, todo, columns, maxRows, true)
const isFolded = (left: Node): boolean => nodes((left.children as Node[]).slice(-1)[0], 'Button').some(b => b.key === 'band-more')

test('beside the docked pane a band of 52 is two boxes, the human list 20 wide and the Claude column 32, and a band of 51 is the human list alone, as it is drawn with the pane not docked', () => {
  const tree = docked(humans(2), flight(1))
  expect(tree).toMatchObject({ type: 'Box', flexDirection: 'row', width: 52 })
  const [left, right] = columnsOf(tree) as [Node, Node]
  expect(left).toMatchObject({ width: 20, paddingRight: 1 })
  expect(right).toMatchObject({ width: 32, paddingLeft: 1 })
  expect(lineTexts(right)[0]).toBe('Claude TODO 1 active, 0 queued')
  sameTree(docked(humans(2), flight(1), 51), drawn(humans(2), flight(1), 51))
  expect(JSON.stringify(docked(humans(2), flight(1), 51))).not.toContain('Claude TODO')
  // Not docked, a band of 60 draws the human list alone, full width.
  const alone = drawn(humans(2), flight(1), 60)
  expect(JSON.stringify(alone)).not.toContain('Claude TODO')
  expect(alone.width).toBeUndefined()
})

test('with the pane docked and a band of 100 the tree is the one drawn at 100 with the pane not docked', () => {
  for (const store of [humans(3), humans(12, true)]) sameTree(docked(store, [...flight(2), ...queue(2)], 100, 12), drawn(store, [...flight(2), ...queue(2)], 100, 12))
})

test('beside the dock with no human items an item in flight draws the Claude column alone, 32 wide at the band\'s right edge, with nothing to its left', () => {
  for (const columns of [52, 51]) {
    const tree = docked(humans(0), flight(1), columns)
    expect(tree).toMatchObject({ type: 'Box', flexDirection: 'row', justifyContent: 'flex-end', width: columns })
    expect(columnsOf(tree)).toHaveLength(1)
    expect(columnsOf(tree)[0]).toMatchObject({ width: 32 })
    expect(JSON.stringify(tree)).not.toContain('To do for')
  }
})

test('every row of the Claude list\'s state table, drawn at a band of 52 and of 51 with the pane docked, holds what the row says with 52 as the two-list width', () => {
  // Row 1: no human items and no item in flight: nothing draws.
  expect(bandDraws(0, [])).toBe(false)
  expect(bandDraws(0, queue(2))).toBe(false)
  for (const columns of [52, 51]) {
    const both = columns === 52
    const where = (row: number): string => `row ${row}, ${columns}`
    // Row 2: the column alone, at the right edge.
    expect(columnsOf(docked(humans(0), [...flight(1), ...queue(2)], columns)), where(2)).toHaveLength(1)
    sameTree(docked(humans(0), [...flight(1), ...queue(2)], columns), drawn(humans(0), [...flight(1), ...queue(2)], columns), where(2))
    // Row 3: the human list alone, full width.
    sameTree(docked(humans(2), [], columns), drawn(humans(2), [], columns), where(3))
    expect(JSON.stringify(docked(humans(2), [], columns)), where(3)).not.toContain('Claude TODO')
    // Rows 4 and 5: both lists, the column's queued rows down to the human list's height, the last a `+N queued` row when they do not all fit. The human list of two
    // items in 19 columns is a squeezed header of two lines and two rows: 4 lines.
    const wantRows: [number, TodoItem[], string[]][] = [
      [4, queue(5), ['Claude TODO 0 active, 5 queued', '○ q1', '○ q2', '+3 queued']],
      [5, [...flight(1), ...queue(5)], ['Claude TODO 1 active, 5 queued', '◐ f1', '○ q1', '+4 queued']],
    ]
    for (const [row, todo, want] of wantRows) {
      const tree = docked(humans(2), todo, columns)
      if (!both) {
        sameTree(tree, drawn(humans(2), todo, columns), where(row))
        continue
      }
      const [left, right] = columnsOf(tree) as [Node, Node]
      expect([left.width, right.width], where(row)).toEqual([20, 32])
      expect(lineTexts(right), where(row)).toEqual(want)
    }
    // Row 6: in flight overflowing the height: the header and every in-flight row, no queued or `+N queued` row, the header still counting the queued items.
    const overflow = docked(humans(2), [...flight(10), ...queue(2)], columns, 6)
    if (both) expect(lineTexts(columnsOf(overflow)[1] as Node), where(6)).toEqual(['Claude TODO 10 active, 2 queued', ...flight(10).map(it => `◐ ${it.title}`)])
    else sameTree(overflow, drawn(humans(2), [...flight(10), ...queue(2)], columns, 6), where(6))
    // Row 7: folded and overflowing: as row 6, with the human list folded into its summary row, its last.
    const taller = docked(humans(30), [...flight(12), ...queue(2)], columns, 10)
    if (both) {
      const [left, right] = columnsOf(taller) as [Node, Node]
      expect(lineTexts(right), where(7)).toEqual(['Claude TODO 12 active, 2 queued', ...flight(12).map(it => `◐ ${it.title}`)])
      expect(isFolded(left), where(7)).toBe(true)
      // The human list folds one row earlier, into the rows the band's window shows at its top: the header's two lines and the rows, the summary the last.
      expect(2 + (left.children as Node[]).length - 1, where(7)).toBeLessThanOrEqual(9)
    } else sameTree(taller, drawn(humans(30), [...flight(12), ...queue(2)], columns, 10), where(7))
  }
})

test('the squeezed header is two lines, the chip set to cut at its end and the count on the second line likewise: with the term `you` the chip and ` 8 open ` fit the 19 columns whole, and a 20-column term\'s chip is set to cut at its end', () => {
  const header = (store: Store): Node[] => ((columnsOf(docked(store, flight(1)))[0] as Node).children as Node[])[0]?.children as Node[]
  const lines = header(humans(8))
  expect(lines).toHaveLength(2)
  const [chip, count] = lines.map(line => nodes(line, 'Text')[0] as Node)
  expect(chip).toMatchObject({ wrap: 'truncate-end', bold: true, backgroundColor: 'permission', children: [' To do for you '] })
  expect(count).toMatchObject({ wrap: 'truncate-end', children: [' 8 open '] })
  expect(displayColumns(' To do for you ')).toBeLessThanOrEqual(19)
  expect(displayColumns(' 8 open ')).toBeLessThanOrEqual(19)
  const termed = header({ ...humans(8, true), term: 'x'.repeat(20) })
  expect(termed).toHaveLength(2)
  expect(nodes(termed[0], 'Text')[0]).toMatchObject({ wrap: 'truncate-end', backgroundColor: 'warning', children: [` To do for ${'x'.repeat(20)} `] })
  expect(nodes(termed[1], 'Text')[0]).toMatchObject({ wrap: 'truncate-end', children: [' 8 open '] })
  // A sent item adds its count after the open one.
  const sent: Store = { ...humans(3), items: humans(3).items.map(it => (it.id === 1 ? { ...it, state: 'done-pending' as const } : it)) }
  expect(nodes(header(sent)[1], 'Text')[0]?.children).toEqual([' 2 open, 1 sent '])
})

test('beside the dock the fold counts the squeezed header as two lines and each row as one, whatever its title: at maxRows 10, twelve items fold into seven rows and the summary with one item in flight, and six rows and the summary with enough in flight to make the band taller, the summary row the last', () => {
  const store: Store = { items: Array.from({ length: 12 }, (_, k) => ({ ...at(k + 1, false), title: k % 2 === 0 ? LONGER : 'Hi' })), next: 13, term: null }
  for (const [todo, drawnRows, most] of [[flight(1), 7, 10], [flight(12), 6, 9]] as const) {
    const left = columnsOf(docked(store, todo, 52, 10))[0] as Node
    const kids = left.children as Node[]
    const where = `${todo.length} in flight`
    expect(kids[0]?.children, where).toHaveLength(2)
    expect(kids.filter(row => String(row.key).startsWith('item-')), where).toHaveLength(drawnRows)
    expect(nodes(kids[kids.length - 1], 'Button').map(b => b.key), where).toEqual(['band-more'])
    // The header's two lines and every row one line each: the human list's counted lines, within maxRows or the rows the band's window shows at its top.
    expect(2 + kids.length - 1, where).toBe(most)
  }
})

test('beside the dock the header gives up its count line when the summary row would not draw: two lines at maxRows 3, the chip alone at 2 with the summary row on its warning fill, and the chip alone with no row at 1', () => {
  const store: Store = { items: [{ ...at(1, true), title: LONG }, { ...at(2, false), title: LONG }], next: 3, term: null }
  const summary = '+1 blocking · +1 more […]'
  expect(displayColumns(summary)).toBe(25)
  for (const [maxRows, headerRows, drawsSummary] of [[3, 2, true], [2, 1, true], [1, 1, false]] as const) {
    const left = columnsOf(docked(store, flight(1), 52, maxRows))[0] as Node
    const kids = left.children as Node[]
    expect(kids[0]?.children, `${maxRows}`).toHaveLength(headerRows)
    expect(nodes(left, 'Button').filter(b => String(b.key).startsWith('title-')), `${maxRows}`).toEqual([])
    // The summary row is one line, its text cut to the 19 columns of the list.
    expect(nodes(left, 'Button').find(b => b.key === 'band-more')?.label, `${maxRows}`).toBe(drawsSummary ? '+1 blocking · +1 m…' : undefined)
    expect(kids.length, `${maxRows}`).toBe(drawsSummary ? 2 : 1)
    if (drawsSummary) expect(kids[1], `${maxRows}`).toMatchObject({ backgroundColor: 'warning' })
    // The human list's counted lines never pass maxRows.
    expect(headerRows + kids.length - 1, `${maxRows}`).toBeLessThanOrEqual(maxRows)
  }
})

test('beside the dock, pressing a plain to-do\'s control, undoing it and letting its window end each leave the same human rows folded and the same control cells, at every maxRows', () => {
  const rowsFolded = (state: Partial<Item>, maxRows: number): string => {
    const items = Array.from({ length: 8 }, (_, k) => ({ ...at(k + 1, false), title: 'A to-do whose title is longer than the list beside the column', ...(k === 2 ? state : {}) }))
    const left = columnsOf(docked({ items, next: 9, term: null }, queue(1), 52, maxRows))[0] as Node
    const cellWidths = nodes(left, 'Box').filter(b => String(b.key).startsWith('item-')).map(row => (row.children as Node[])[2]?.width)
    return JSON.stringify([nodes(left, 'Button').map(b => b.key), nodes(left, 'Button').filter(b => b.key === 'band-more').map(b => b.label), cellWidths])
  }
  let folds = 0
  for (let maxRows = 1; maxRows <= 40; maxRows++) {
    const open = rowsFolded({}, maxRows)
    expect(rowsFolded({ state: 'done-waiting', pressedAt: 0, answer: null }, maxRows), `pressed, maxRows ${maxRows}`).toBe(open)
    expect(rowsFolded({ state: 'done-pending', answer: null }, maxRows), `sent, maxRows ${maxRows}`).toBe(open)
    if (open.includes('band-more')) folds++
  }
  // The sweep crosses rows folded and rows whole: the squeezed header's two lines and the 8 rows fit from a maxRows of 10; from 2 to 9 they fold into the
  // summary row, and at 1 the chip draws alone with no row at all, so no summary either.
  expect(folds).toBe(8)
})

test('with the 3-second window and the id #12, beside the column a plain to-do and a decision pressed keep their title 4 columns in a squeezed list of 20 and 16 in one of 32, each title cut with an ellipsis, and the fold counts each row as one line', () => {
  const three: View = { ...view(), windowMs: 3000 }
  const rows: [string, Partial<Item>][] = [['a plain to-do', waiting(null)], ['a decision', { options: choicesOf(OPTION), ...waiting(OPTION) }]]
  for (const [list, room] of [[20, 4], [32, 16]] as const) {
    for (const [name, over] of rows) {
      const store: Store = { items: [{ ...at(12, false), title: LONG, ...over }], next: 13, term: null }
      const left = columnsOf(band(table, handlers, store, { ...three, maxRows: 1000, claude: { items: queue(1), columns: list + 32, isDocked: true } }))[0] as Node
      const [, title, control] = cellsOf(left, 12) as [Node, Node, Node]
      const where = `${name}, list of ${list}`
      expect(displayColumns(shown(title)), where).toBe(room)
      expect(shown(title), where).toContain('…')
      // A decision's title keeps its marker whole after the cut once the room holds it.
      expect(shown(title).endsWith(over.options === undefined || room < 5 ? '…' : '… […]'), where).toBe(true)
      expect([control.width, shown(control)], where).toEqual([9, ' ✓ [↶ 3s]'])
    }
  }
  // Twelve such rows at maxRows 10 are the header's two lines, seven rows and the summary, whatever their titles.
  const many: Store = { items: Array.from({ length: 12 }, (_, k) => ({ ...at(k + 1, false), title: LONGER })), next: 13, term: null }
  const left = columnsOf(docked(many, flight(1), 52, 10))[0] as Node
  expect((left.children as Node[]).length - 1 + 2).toBe(10)
})

test('in a squeezed list of 20 a title with a word longer than the list, a title with wide characters, a labelled to-do and a decision pressed with a reply each draw on one line, and the summary row draws on one line cut to 19 ending in an ellipsis', () => {
  const rows: [string, Item][] = [
    ['a word longer than the list', { ...at(12, false), title: 'Fix abcdefghijklmnopqrstuvwxyz now' }],
    ['wide characters', { ...at(12, false), title: '部署新版本到生产环境' }],
    ['a labelled to-do', { ...at(12, false), title: 'Pick a db', doneLabel: 'Go with sqlite' }],
    ['a decision pressed with a reply', { ...at(12, false), title: 'Pick a store', options: choicesOf('Use sqlite'), ...waiting('Not yet', true) }],
  ]
  for (const [name, row] of rows) {
    const { left, layout } = humanList({ items: [row], next: 13, term: null }, 20, SQUEEZED)
    const cells = cellsOf(left, 12)
    expect(rowOf(left, 12).flexDirection, name).toBeUndefined()
    expect(cells.map(cell => cell.type), name).toEqual(['Box', 'Box', 'Box'])
    const [prefix, title, control] = cells as [Node, Node, Node]
    expect(displayColumns(shown(prefix)) + displayColumns(shown(title)) + Number(control.width), name).toBeLessThanOrEqual(layout)
    expect(nodes(left, 'Button').filter(b => nodes(b, 'Text').length > 0), name).toEqual([])
  }
  const store: Store = { items: [{ ...at(1, true), title: LONG }, { ...at(2, false), title: LONG }], next: 3, term: null }
  const left = columnsOf(docked(store, flight(1), 52, 3))[0] as Node
  const more = nodes(left, 'Button').find(b => b.key === 'band-more')
  expect(more?.label).toBe('+1 blocking · +1 m…')
  expect(displayColumns(String(more?.label))).toBe(19)
  expect(nodes(more, 'Text')).toEqual([])
})

test('beside the dock, below 96 columns the human list is squeezed and from 96 it is not: a pressed labelled to-do\'s and yes/no\'s control shows its mark and undo at 95 and its answer text at 96, under a header that is the squeezed one at 95 and the usual one at 96', () => {
  const labelled: Item = { ...at(1, false), doneLabel: LABEL, ...waiting(LABEL) }
  const yes = yesNo({ id: 2, blocking: false, ...waiting('yes') })
  const store: Store = { items: [labelled, yes], next: 3, term: null }
  const left = (columns: number): Node => columnsOf(docked(store, queue(1), columns))[0] as Node
  const control = (columns: number, id: number): string => shown(cellsOf(left(columns), id).slice(-1)[0])
  expect(left(95)).toMatchObject({ width: 63 })
  expect(control(95, 1)).toBe(` ✓ ${UNDO}`)
  expect(control(95, 2)).toBe(` ✓ ${UNDO}`)
  expect(((left(95).children as Node[])[0] as Node).flexDirection).toBe('column')
  expect(left(96)).toMatchObject({ width: 64 })
  expect(control(96, 1)).toBe(` ✓ ${LABEL} ${UNDO}`)
  expect(control(96, 2)).toBe(` ✓ yes ${UNDO}`)
  expect(((left(96).children as Node[])[0] as Node).flexDirection).toBeUndefined()
})

test('with the pane not docked a band of 120 draws a pressed labelled to-do\'s control and a yes/no\'s with their answer text', () => {
  const labelled: Item = { ...at(1, false), doneLabel: LABEL, ...waiting(LABEL) }
  const yes = yesNo({ id: 2, blocking: false, ...waiting('yes') })
  const left = columnsOf(drawn({ items: [labelled, yes], next: 3, term: null }, queue(1), 120))[0] as Node
  expect(shown(cellsOf(left, 1).slice(-1)[0])).toBe(` ✓ ${LABEL} ${UNDO}`)
  expect(shown(cellsOf(left, 2).slice(-1)[0])).toBe(` ✓ yes ${UNDO}`)
})

test('a human list with no Claude items is never squeezed, docked or not, at any width: its rows keep the ladder from the first rung, and a reply reads `✓ replied`', () => {
  const replied: Item = { ...at(1, false), ...waiting('Not yet', true) }
  const store: Store = { items: [replied], next: 2, term: null }
  for (const columns of [52, 56, 70, 95, 96]) {
    for (const isDocked of [true, false]) {
      expect(JSON.stringify(drawn(store, [], columns, 50, isDocked)), `${columns}, ${isDocked}`).toContain('✓ replied ')
      sameTree(drawn(store, [], columns, 50, isDocked), drawn(store, [], columns))
    }
  }
})

// The Claude column's press targets: its header, each of its rows and its `+N queued` row are each a button of their own, addressed by their place in the column (a Claude
// item carries no id, and a button with no address takes its label, so two rows with one title would share it).
const claudeLines = (right: Node): Node[] => right.children as Node[]
const withClaude = (human: Store, todo: TodoItem[], press: Handlers = handlers, columns = 120): Node =>
  band(table, press, human, { ...view(), maxRows: 50, claude: { items: todo, columns } }) as Node

test('the Claude column is a plain button for its header, one for each row and one for +N queued, each addressed by its place in the column, and +N queued is dim', () => {
  const right = columnsOf(withClaude(humans(4), [...flight(1), ...queue(5)]))[1] as Node
  const lines = claudeLines(right)
  expect(lines.map(line => line.label)).toEqual(['Claude TODO 1 active, 5 queued', '◐ f1', '○ q1', '○ q2', '+3 queued'])
  expect(lines.map(line => line.type)).toEqual(['Button', 'Button', 'Button', 'Button', 'Button'])
  expect(lines.map(line => line.key)).toEqual(['claude-header', 'claude-row-0', 'claude-row-1', 'claude-row-2', 'claude-queued'])
  expect(lines.map(line => line.plain)).toEqual([true, true, true, true, true])
  expect(lines.map(line => line.dimColor)).toEqual([undefined, undefined, undefined, undefined, true])
  expect(lines.every(line => typeof line.onPress === 'function')).toBe(true)
})

test('a press on the header, on any row and on +N queued runs the one handler for the Claude column, and no other', () => {
  const calls: string[] = []
  const press: Handlers = {
    pick: () => void calls.push('pick'),
    done: () => void calls.push('done'),
    more: () => void calls.push('more'),
    reply: () => void calls.push('reply'),
    copy: () => void calls.push('copy'),
    backlog: () => void calls.push('backlog'),
  }
  const right = columnsOf(withClaude(humans(4), [...flight(1), ...queue(5)], press))[1] as Node
  for (const line of claudeLines(right)) (line.onPress as () => void)()
  expect(calls).toEqual(['backlog', 'backlog', 'backlog', 'backlog', 'backlog'])
})

test('the column drawn alone is the same buttons: the header and each in-flight row', () => {
  const tree = withClaude(humans(0), [...flight(2), ...queue(3)])
  const lines = claudeLines(columnsOf(tree)[0] as Node)
  expect(lines.map(line => [line.type, line.key, line.label])).toEqual([
    ['Button', 'claude-header', 'Claude TODO 2 active, 3 queued'],
    ['Button', 'claude-row-0', '◐ f1'],
    ['Button', 'claude-row-1', '◐ f2'],
  ])
})

test('in a column of 20 layout columns a row of 60 columns is one button whose text ends in an ellipsis within the 20, no wide character split; the header and +N queued are cut the same way, +N queued dim, and a row that fits is whole', () => {
  expect(displayColumns('漢')).toBe(2)
  const todo: TodoItem[] = [
    { title: 'x'.repeat(58), state: 'in_flight', eta: 'no ETA' },
    { title: '漢'.repeat(29), state: 'in_flight', eta: 'no ETA' },
    { title: 'short', state: 'in_flight', eta: 'no ETA' },
    ...queue(4),
  ]
  // The human list is 6 lines: the column's header and three in-flight rows leave room for one queued row and `+3 queued`.
  const lines = claudeLines(claudeColumn(table, handlers, todo, { box: 20, layout: 20 }, 6) as Node)
  expect(lines.map(line => line.label)).toEqual([
    'Claude TODO 3 activ…',
    `◐ ${'x'.repeat(17)}…`,
    `◐ ${'漢'.repeat(8)}…`,
    '◐ short',
    '○ q1',
    '+3 queued',
  ])
  expect(lines.map(line => displayColumns(String(line.label))).every(columns => columns <= 20)).toBe(true)
  expect(lines.map(line => line.type)).toEqual(['Button', 'Button', 'Button', 'Button', 'Button', 'Button'])
  expect(lines.map(line => line.dimColor)).toEqual([undefined, undefined, undefined, undefined, undefined, true])
  // `+3 queued` is cut like the rest where the column is narrower than it, and stays dim.
  const narrow = claudeLines(claudeColumn(table, handlers, [...flight(1), ...queue(3)], { box: 6, layout: 6 }, 3) as Node)
  expect(narrow.map(line => [line.key, line.label, line.dimColor])).toEqual([
    ['claude-header', 'Claud…', undefined],
    ['claude-row-0', '◐ f1', undefined],
    ['claude-queued', '+3 qu…', true],
  ])
})

test('two Claude rows with the same title are two press targets with different addresses', () => {
  const same: TodoItem[] = [
    { title: 'Same title', state: 'in_flight', eta: 'no ETA' },
    { title: 'Same title', state: 'in_flight', eta: 'no ETA' },
    { title: 'Same title', state: 'queued', eta: 'no ETA' },
  ]
  const lines = claudeLines(claudeColumn(table, handlers, same, { box: 40, layout: 40 }, 6) as Node)
  const keys = lines.map(line => line.key)
  expect(new Set(keys).size).toBe(keys.length)
  expect(lines.filter(line => line.label === '◐ Same title').map(line => line.key)).toEqual(['claude-row-0', 'claude-row-1'])
})

// The backlog pane: the Claude list whole, read-only. The header is one line the engine cuts at its end. Each item is one row: a head that gives way, which the engine cuts at its end
// in the room the tail leaves, and the item's ETA tail, dim and never shrunk.
test('the backlog view is a header line with the counts in the long form and then every item, in-flight first and each group in written order: each a row of a head that gives way, holding its glyph, a space and its whole title, set to cut at its end, and a dim part that does not shrink, holding its tail', () => {
  const todo: TodoItem[] = [
    { title: 'Queued first', state: 'queued', eta: 'no ETA' },
    { title: 'x'.repeat(80), state: 'in_flight', eta: '~10 min' },
    { title: 'Queued second', state: 'queued', eta: 'no ETA' },
    { title: '漢'.repeat(40), state: 'in_flight', eta: 'no ETA' },
  ]
  const row = (head: string, tail: string) => ({
    type: 'Box',
    children: [
      { type: 'Box', flexShrink: 1, children: [{ type: 'Text', wrap: 'truncate-end', children: [head] }] },
      { type: 'Box', flexShrink: 0, children: [{ type: 'Text', dimColor: true, children: [tail] }] },
    ],
  })
  expect((backlogPane(table, todo) as Node).children).toEqual([
    { type: 'Text', wrap: 'truncate-end', children: ['Claude TODO 2 in flight, 2 queued'] },
    row(`◐ ${'x'.repeat(80)}`, ' · ~10 min'),
    row(`◐ ${'漢'.repeat(40)}`, ' · no ETA'),
    row('○ Queued first', ' · no ETA'),
    row('○ Queued second', ' · no ETA'),
  ])
})

test('the dim part of each backlog row is its entry\'s ETA tail, and an item stored with no ETA draws no ETA after its title', () => {
  const todo: TodoItem[] = [
    { title: 'Run the tests', state: 'in_flight', eta: '~10 min' },
    { title: 'Ship it', state: 'queued', eta: 'z'.repeat(30) },
    { title: 'Wait', state: 'queued', eta: 'no ETA' },
  ]
  const rows = (backlogPane(table, todo) as Node).children?.slice(1) as Node[]
  expect(rows.map(row => nodes(row, 'Text').filter(text => text.dimColor === true).map(text => shown(text)))).toEqual(todo.map(it => [etaTail(it)]))
  expect(rows.map(row => shown(row))).toEqual(['◐ Run the tests · ~10 min', `○ Ship it · ${'z'.repeat(30)}`, '○ Wait · no ETA'])
})

test('the backlog view asks for one row for its header and one for each item, as many as it draws: 2, 4 and 13 rows for lists of 1, 3 and 12 items', () => {
  for (const [items, rows] of [[1, 2], [3, 4], [12, 13]] as const) {
    const todo = [...flight(Math.ceil(items / 2)), ...queue(Math.floor(items / 2))]
    expect(todo).toHaveLength(items)
    expect(backlogRows(todo), `${items} items`).toBe(rows)
    expect((backlogPane(table, todo) as Node).children, `${items} items`).toHaveLength(rows)
  }
})

test('the backlog view drawn from an empty list is its header line alone, and asks for that one row', () => {
  const tree = backlogPane(table, []) as Node
  expect((tree.children as Node[]).map(line => [line.type, line.wrap, shown(line)])).toEqual([['Text', 'truncate-end', 'Claude TODO 0 in flight, 0 queued']])
  expect(backlogRows([])).toBe(1)
})

test('the backlog view draws no control: no button, field or markdown that could change the Claude list', () => {
  const tree = backlogPane(table, [...flight(2), ...queue(2)])
  expect(nodes(tree, 'Button')).toEqual([])
  expect(nodes(tree, 'Input')).toEqual([])
  expect(nodes(backlogPane(withInput, [...flight(2), ...queue(2)]), 'Input')).toEqual([])
  expect(nodes(tree, 'Markdown')).toEqual([])
})

test('the item pane given the Claude list\'s selection draws no human item', () => {
  const three: Store = { items: [1, 3, 5].map(id => ({ ...item, id, title: `t${id}`, detail: `brief ${id}` })), next: 6, term: null }
  const tree = pane(table, handlers, three, { ...view(), selected: 'claude-todo' })
  expect(nodes(tree, 'Markdown')).toEqual([])
  expect(nodes(tree, 'Button')).toEqual([])
})
