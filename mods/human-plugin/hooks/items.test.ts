import { expect, test } from 'claude-code/testing'
import { DONE_MAX, EMPTY, act, carryNext, clearAll, columnsByCodePoint, displayColumns, listText, mergeRestored, normalizeItem, normalizeStore, parseInput, selectedItem, successorOf, type Ctx, type ToolInput } from './items'
import { expire, press, reply, turnsOf } from './done'
import type { Item, Store } from '../types'

const input = (raw: unknown): ToolInput => {
  const parsed = parseInput(raw)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value
}
const MAIN: Ctx = { agent: null, now: 1000 }
const SUB: Ctx = { agent: 'sub-1', now: 1000 }
const withState = (id: number, state: Item['state']): Item => ({
  id, title: `Item ${id}`, detail: '', blocking: false, createdAt: 0, state, pressedAt: null, note: null, agent: null, unread: false,
  options: [], answer: null, yesno: false, replied: false, doneLabel: null, thread: [], windowTurns: [], windowChanged: false,
})

const added =(store: Store, title: string, ctx: Ctx = MAIN) => {
  const out = act(store, input({ action: 'add', title }), ctx)
  if ('deny' in out) throw new Error(out.deny)
  return out
}

test('parseInput accepts each action and rejects malformed input', () => {
  expect(parseInput({ action: 'add', title: 'Pick a db' })).toEqual({
    ok: true,
    value: { action: 'add', title: 'Pick a db', detail: '', blocking: false, options: [], yesno: false, doneLabel: null },
  })
  expect(parseInput({ action: 'list' })).toEqual({ ok: true, value: { action: 'list' } })
  expect(parseInput({ action: 'add' }).ok).toBe(false)
  expect(parseInput({ action: 'add', title: '   ' }).ok).toBe(false)
  expect(parseInput({ action: 'update' }).ok).toBe(false)
  expect(parseInput({ action: 'update', id: 0 }).ok).toBe(false)
  expect(parseInput({ action: 'update', id: 1.5 }).ok).toBe(false)
  expect(parseInput({ action: 'bogus' }).ok).toBe(false)
  expect(parseInput(null).ok).toBe(false)
})

test('done labels a plain to-do: accepted on add and update, trimmed, one line', () => {
  expect(parseInput({ action: 'add', title: 'Pick a db', done: '  Go with sqlite  ' })).toEqual({
    ok: true,
    value: { action: 'add', title: 'Pick a db', detail: '', blocking: false, options: [], yesno: false, doneLabel: 'Go with sqlite' },
  })
  expect(parseInput({ action: 'update', id: 2, done: 'Go with sqlite' })).toEqual({
    ok: true,
    value: { action: 'update', id: 2, doneLabel: 'Go with sqlite' },
  })
  expect(parseInput({ action: 'add', title: 'Pick a db', done: 'Go\nwith sqlite' })).toMatchObject({ ok: true, value: { doneLabel: 'Go with sqlite' } })
})

test('done is refused on a yes/no or a decision, with the reason, and when blank or not text', () => {
  expect(parseInput({ action: 'add', title: 'Ship it?', yesno: true, done: 'Ship' })).toEqual({
    ok: false,
    reason: 'done is for a to-do: a yes/no or a decision already says what each press means',
  })
  expect(parseInput({ action: 'add', title: 'Pick', options: [{ label: 'A' }, { label: 'B' }], done: 'A' })).toMatchObject({ ok: false })
  expect(parseInput({ action: 'update', id: 2, options: [{ label: 'A' }, { label: 'B' }], done: 'A' })).toMatchObject({ ok: false })
  expect(parseInput({ action: 'add', title: 'Pick a db', done: '   ' })).toEqual({ ok: false, reason: 'done needs a label, e.g. "Go with sqlite"' })
  expect(parseInput({ action: 'add', title: 'Pick a db', done: 3 })).toEqual({ ok: false, reason: 'done must be text' })
})

test('act stores a done label on a plain to-do, and refuses one on a yes/no or a decision, or options on a labelled to-do', () => {
  const made = added(EMPTY, 'Pick a db')
  expect(act(made.store, input({ action: 'add', title: 'Pick a db', done: 'Go with sqlite' }), MAIN)).toMatchObject({
    added: { doneLabel: 'Go with sqlite' },
  })
  expect(made.added?.doneLabel).toBe(null)
  const labelled = act(made.store, input({ action: 'update', id: 1, done: 'Go with sqlite' }), MAIN)
  if ('deny' in labelled) throw new Error(labelled.deny)
  expect(labelled.store.items[0]?.doneLabel).toBe('Go with sqlite')
  expect(labelled.reply).toBe('updated #1')
  expect(act(labelled.store, input({ action: 'update', id: 1, done: 'Go with sqlite' }), MAIN)).toMatchObject({ reply: 'no change to #1' })
  const yes = added(EMPTY, 'Ship it?', MAIN).store
  const yesno = { items: yes.items.map(it => ({ ...it, yesno: true })), next: yes.next, term: null }
  expect(act(yesno, input({ action: 'update', id: 1, done: 'Ship' }), MAIN)).toEqual({
    deny: '#1 is a yes/no question or a decision: its buttons say what a press means, so it takes no done label',
  })
  const decision = { items: [{ ...withState(1, 'open'), options: [{ label: 'A', description: '', recommended: false }, { label: 'B', description: '', recommended: false }] }], next: 2, term: null }
  expect(act(decision, input({ action: 'update', id: 1, done: 'Ship' }), MAIN)).toMatchObject({ deny: expect.any(String) })
  expect(act(labelled.store, input({ action: 'update', id: 1, options: [{ label: 'A' }, { label: 'B' }] }), MAIN)).toEqual({
    deny: "#1 has a done label: it is a to-do, which takes no options; clear the label first with done: ''",
  })
})

test('add numbers items from 1, replies with the id only, and marks the item unread', () => {
  const first = added(EMPTY, 'Pick a db')
  expect(first.reply).toBe('added #1')
  expect(first.added?.id).toBe(1)
  expect(first.added?.unread).toBe(true)
  expect(first.added?.state).toBe('open')
  expect(first.added?.agent).toBe(null)
  expect(first.store.next).toBe(2)
  const second = added(first.store, 'Merge the PR')
  expect(second.reply).toBe('added #2')
})

test('ids are never reused after a remove', () => {
  const one = added(EMPTY, 'a').store
  const gone = act(one, input({ action: 'remove', id: 1 }), MAIN)
  if ('deny' in gone) throw new Error(gone.deny)
  expect(added(gone.store, 'b').reply).toBe('added #2')
})

// A list whose one item is sent (done-pending), as the human's reply left it: answered, and read.
const sentList = (extra: Partial<Item> = {}): Store => {
  const { store } = added(EMPTY, 'Pick a db')
  return { ...store, items: store.items.map(it => ({ ...it, state: 'done-pending' as const, answer: 'Use sqlite', replied: true, unread: false, ...extra })) }
}
const changed = (store: Store, raw: Record<string, unknown>) => {
  const out = act(store, input({ id: 1, ...raw }), MAIN)
  if ('deny' in out) throw new Error(out.deny)
  return out
}

test('an append, and an update that sets a title, detail, blocking, options, a note or a done label, reopen a sent item unread with no answer', () => {
  const sent = sentList({ detail: 'which store?' })
  const sets: Record<string, unknown>[] = [
    { action: 'append', text: 'more context' },
    { action: 'update', title: 'Pick a cache' },
    { action: 'update', detail: 'postgres' },
    { action: 'update', blocking: true },
    { action: 'update', options: [{ label: 'Use sqlite' }, { label: 'Use postgres' }] },
    { action: 'update', note: 'still open' },
    { action: 'update', done: 'Go with sqlite' },
  ]
  for (const raw of sets) {
    const out = changed(sent, raw)
    expect(out.store.items[0]).toMatchObject({ state: 'open', unread: true, pressedAt: null, answer: null, replied: false })
    expect(out.reply).toBe(raw.action === 'append' ? 'appended to #1' : 'updated #1')
    expect(out.changed).toEqual({ id: 1, reopened: true, promoted: false })
  }
})

test('an update that changes nothing, a note equal to the current one included, says so and leaves a sent item sent', () => {
  const sent = sentList({ note: 'recheck', detail: 'postgres' })
  for (const raw of [{ title: 'Pick a db' },{ note: 'recheck' }, { detail: 'postgres' }, { blocking: false }]) {
    expect(changed(sent, { action: 'update', ...raw })).toEqual({ store: sent, reply: 'no change to #1', added: null, changed: null })
  }
})

test('a whitespace-only edit of the detail or the note is no change, sent or in its undo window: it replies no change and leaves the item as it was', () => {
  const sent = sentList({ detail: 'postgres', note: 'recheck' })
  for (const raw of [{ detail: 'postgres ' }, { detail: ' postgres\n' }, { note: 'recheck ' }]) {
    expect(changed(sent, { action: 'update', ...raw })).toEqual({ store: sent, reply: 'no change to #1', added: null, changed: null })
  }
  const bare = sentList()
  expect(changed(bare, { action: 'update', detail: '  ' })).toEqual({ store: bare, reply: 'no change to #1', added: null, changed: null })
  const waiting = sentList({ state: 'done-waiting', pressedAt: 500, note: 'recheck' })
  expect(changed(waiting, { action: 'update', note: 'recheck ' })).toEqual({ store: waiting, reply: 'no change to #1', added: null, changed: null })
})

test('a whitespace-only edit beside a clear does not make the change set something: it applies without reopening a sent item', () => {
  const sent = sentList({ detail: 'postgres', note: 'recheck' })
  const noted = changed(sent, { action: 'update', detail: 'postgres ', note: '' })
  expect(noted.store.items[0]).toMatchObject({ state: 'done-pending', note: null, answer: 'Use sqlite' })
  expect(noted.reply).toBe('updated #1')
  expect(noted.changed).toEqual({ id: 1, reopened: false, promoted: false })
  const detailed = changed(sent, { action: 'update', detail: '', note: 'recheck ' })
  expect(detailed.store.items[0]).toMatchObject({ state: 'done-pending', detail: '', answer: 'Use sqlite' })
  expect(detailed.reply).toBe('updated #1')
  expect(detailed.changed).toEqual({ id: 1, reopened: false, promoted: false })
})

test('a field cleared alone applies without reopening a sent item; a clear with a change that sets something reopens it', () => {
  const sent = sentList({ note: 'recheck', detail: 'postgres', doneLabel: 'Go with sqlite' })
  for (const [raw, field, value] of [
    [{ note: '' }, 'note', null],
    [{ done: '' }, 'doneLabel', null],
    [{ detail: '' }, 'detail', ''],
    [{ detail: ' \n ' }, 'detail', ''],
  ] as const) {
    const out = changed(sent, { action: 'update', ...raw })
    expect(out.store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', unread: false, [field]: value })
    expect(out.reply).toBe('updated #1')
    expect(out.changed).toEqual({ id: 1, reopened: false, promoted: false })
  }
  const both = changed(sent, { action: 'update', note: '', title: 'Pick a cache' })
  expect(both.store.items[0]).toMatchObject({ state: 'open', note: null, unread: true, answer: null })
  expect(both.changed).toEqual({ id: 1, reopened: true, promoted: false })
})

test('a whitespace-only detail is a clear: it applies to a sent item without reopening it, and the list shows no stray line for it', () => {
  const sent = sentList({ detail: 'postgres' })
  const cleared = changed(sent, { action: 'update', detail: '   ' })
  expect(cleared.reply).toBe('updated #1')
  expect(cleared.changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(cleared.store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true, detail: '' })
  expect(listText(cleared.store.items)).toBe('#1 non-blocking, done-pending: Pick a db\n  you: Use sqlite')
  expect(changed(cleared.store, { action: 'append', text: 'Postgres is simpler.' }).store.items[0]).toMatchObject({
    detail: '',
    thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'Postgres is simpler.' }],
  })
})

test('a whitespace-only note is a clear too: it applies to a sent item without reopening it, and the list shows no note for it', () => {
  const noted = changed(sentList({ note: 'recheck' }), { action: 'update', note: '   ' })
  expect(noted.reply).toBe('updated #1')
  expect(noted.changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(noted.store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', note: null })
  expect(listText(noted.store.items)).toBe('#1 non-blocking, done-pending: Pick a db\n  you: Use sqlite')
})

test('a change on an item in its undo window applies its fields and leaves the window running', () => {
  const waiting = sentList({ state: 'done-waiting', pressedAt: 500 })
  for (const raw of [{ action: 'update', note: 'recheck', title: 'Pick a cache' }, { action: 'append', text: 'more' }]) {
    const out = changed(waiting, raw)
    expect(out.store.items[0]).toMatchObject({ state: 'done-waiting', pressedAt: 500, answer: 'Use sqlite', replied: true })
    expect(out.changed).toEqual({ id: 1, reopened: false, promoted: false })
  }
  expect(changed(waiting, { action: 'update', note: 'recheck' }).store.items[0]?.note).toBe('recheck')
  expect(changed(waiting, { action: 'append', text: 'more' }).store.items[0]?.windowTurns).toEqual([{ speaker: 'agent', words: 'more' }])
})

test('a change to an open item leaves its unread mark as it was', () => {
  const { store } = added(EMPTY, 'Pick a db')
  const read = { ...store, items: store.items.map(it => ({ ...it, unread: false })) }
  expect(changed(read, { action: 'append', text: 'more' }).store.items[0]?.unread).toBe(false)
  expect(changed(store, { action: 'append', text: 'more' }).store.items[0]?.unread).toBe(true)
})

test('the outcome of a change names the item and says whether it reopened or promoted it; an add, a list and a remove name none', () => {
  const { store } = added(EMPTY, 'Pick a db')
  expect(changed(store, { action: 'update', title: 'Pick a cache' }).changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(changed(sentList(), { action: 'append', text: 'more' }).changed).toEqual({ id: 1, reopened: true, promoted: false })
  expect(added(EMPTY, 'a').changed).toBe(null)
  expect(act(store, input({ action: 'list' }), MAIN)).toMatchObject({ changed: null })
  expect(changed(store, { action: 'remove' })).toMatchObject({ changed: null })
})

test('an update that makes an open item blocking says it promoted it; an unmark, a change to an item already blocking, a no-op and a change to an item not open do not', () => {
  const { store } = added(EMPTY, 'Pick a db')
  const promoted = changed(store, { action: 'update', blocking: true })
  expect(promoted.store.items[0]).toMatchObject({ blocking: true, state: 'open' })
  expect(promoted.changed).toEqual({ id: 1, reopened: false, promoted: true })
  expect(changed(promoted.store, { action: 'update', blocking: false }).changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(changed(promoted.store, { action: 'update', blocking: true }).changed).toBe(null)
  expect(changed(promoted.store, { action: 'update', blocking: true, title: 'Pick a cache' }).changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(changed(sentList(), { action: 'update', blocking: true }).changed).toEqual({ id: 1, reopened: true, promoted: false })
  expect(changed(sentList({ state: 'done-waiting', pressedAt: 500 }), { action: 'update', blocking: true }).changed).toEqual({ id: 1, reopened: false, promoted: false })
})

test('update and remove of an unknown id are denied', () => {
  expect(act(EMPTY, input({ action: 'update', id: 9, title: 'x' }), MAIN)).toEqual({ deny: 'no item #9' })
  expect(act(EMPTY, input({ action: 'remove', id: 9 }), MAIN)).toEqual({ deny: 'no item #9' })
})

test('the main agent removes any item; a subagent removes only its own', () => {
  const mainItem = added(EMPTY, 'main ask').store
  expect(act(mainItem, input({ action: 'remove', id: 1 }), SUB)).toEqual({
    deny: '#1 was filed by the main agent; only it can remove it',
  })
  const subItem = added(EMPTY, 'sub ask', SUB).store
  const removed = act(subItem, input({ action: 'remove', id: 1 }), SUB)
  if ('deny' in removed) throw new Error(removed.deny)
  expect(removed.reply).toBe('removed #1')
  expect(removed.store.items).toEqual([])
  const mainRemoves = act(subItem, input({ action: 'remove', id: 1 }), MAIN)
  if ('deny' in mainRemoves) throw new Error(mainRemoves.deny)
  expect(mainRemoves.reply).toBe('removed #1')
})

test('only list carries the list; every other reply is one short line', () => {
  const { store } = added(added(EMPTY, 'first').store, 'second')
  const listed = act(store, input({ action: 'list' }), MAIN)
  if ('deny' in listed) throw new Error(listed.deny)
  expect(listed.reply).toBe(listText(store.items))
  expect(listed.reply).toContain('#1')
  expect(listed.reply).toContain('#2')
  expect(listed.reply).toContain('first')
  expect(listed.reply).toContain('second')
  const updated = act(store, input({ action: 'update', id: 2, detail: 'more' }), MAIN)
  if ('deny' in updated) throw new Error(updated.deny)
  expect(updated.reply.includes('\n')).toBe(false)
  expect(updated.reply.includes('first')).toBe(false)
  expect(listText([])).toBe('no items')
})

test('clearing the list keeps the id counter, so the next add never reuses an id', () => {
  const { store } = added(added(EMPTY, 'first').store, 'second')
  const cleared = clearAll(store)
  expect(cleared.items).toEqual([])
  expect(added(cleared, 'third').reply).toBe('added #3')
})

test('a /clear carries the saved id counter into the new session, and never lowers it', () => {
  expect(carryNext(EMPTY, 7).next).toBe(7)
  expect(added(carryNext(EMPTY, 7), 'after clear').reply).toBe('added #7')
  expect(carryNext({ items: [], next: 9, term: null }, 7).next).toBe(9)
  expect(carryNext(EMPTY, undefined).next).toBe(1)
  expect(carryNext(EMPTY, '7').next).toBe(1)
  expect(carryNext(EMPTY, 2.5).next).toBe(1)
})

test('a rebuilt list keeps an item added after the transcript was read, drops one the transcript ended, and never lowers the counter', () => {
  const replayed = added(added(EMPTY, 'from the transcript').store, 'also replayed').store
  const live = added({ items: [], next: 7, term: null }, 'added meanwhile').store
  const removedInTranscript = { ...live, items: [...live.items, { ...(replayed.items[0] as Item), id: 5 }] }
  const merged = mergeRestored(removedInTranscript, replayed, [1, 2, 5])
  expect(merged.items.map(it => `${it.id} ${it.title}`)).toEqual(['1 from the transcript', '2 also replayed', '7 added meanwhile'])
  expect(merged.next).toBe(8)
  expect(mergeRestored(EMPTY, { items: [], next: 4, term: null }, [1, 2, 3]).next).toBe(4)
  expect(mergeRestored({ items: [], next: 9, term: null }, { items: [], next: 4, term: null }, [1, 2, 3]).next).toBe(9)
})

test('append adds a section to the end of the detail, after a blank line, and replies with the id', () => {
  const first = added(EMPTY, 'Pick a db')
  const brief = act(first.store, input({ action: 'update', id: 1, detail: 'Which store?' }), MAIN)
  if (!('store' in brief)) throw new Error('update denied')
  const out = act(brief.store, input({ action: 'append', id: 1, text: 'Postgres is simpler.' }), MAIN)
  if (!('store' in out)) throw new Error(out.deny)
  expect(out.reply).toBe('appended to #1')
  expect(out.store.items[0]?.detail).toBe('Which store?\n\nPostgres is simpler.')
})

test('append onto an empty detail sets it, and an unknown id is denied', () => {
  const first = added(EMPTY, 'Pick a db')
  const out = act(first.store, input({ action: 'append', id: 1, text: 'Two options.' }), MAIN)
  if (!('store' in out)) throw new Error(out.deny)
  expect(out.store.items[0]?.detail).toBe('Two options.')
  expect(act(first.store, input({ action: 'append', id: 9, text: 'x' }), MAIN)).toEqual({ deny: 'no item #9' })
})

test('append needs an id and text, and text that is only spaces is refused', () => {
  expect(parseInput({ action: 'append', id: 1 })).toEqual({ ok: false, reason: 'append needs text' })
  expect(parseInput({ action: 'append', text: 'x' })).toEqual({ ok: false, reason: 'append needs the item id (a whole number from 1)' })
  expect(parseInput({ action: 'append', id: 1, text: '   ' })).toEqual({ ok: false, reason: 'append needs text' })
})

test('an update identical to the item\'s current state changes nothing and replies no change', () => {
  const first = added(EMPTY, 'Pick a db')
  const same = act(first.store, input({ action: 'update', id: 1, title: 'Pick a db' }), MAIN)
  if (!('store' in same)) throw new Error(same.deny)
  expect(same.reply).toBe('no change to #1')
  expect(same.store).toBe(first.store)
  const real = act(first.store, input({ action: 'update', id: 1, title: 'Pick a cache' }), MAIN)
  if (!('store' in real)) throw new Error(real.deny)
  expect(real.reply).toBe('updated #1')
})

test('options are parsed as AskUserQuestion takes them: 2 to 4 one-line labels, at most one recommended, labels that differ', () => {
  expect(parseInput({ action: 'add', title: 'Pick', options: [{ label: 'Use sqlite', description: 'Simple' }, { label: 'Use postgres', recommended: true }] })).toEqual({
    ok: true,
    value: {
      action: 'add',
      title: 'Pick',
      detail: '',
      blocking: false,
      options: [
        { label: 'Use sqlite', description: 'Simple', recommended: false },
        { label: 'Use postgres', description: '', recommended: true },
      ],
      yesno: false,
      doneLabel: null,
    },
  })
  const one = [{ label: 'a' }]
  const five = [1, 2, 3, 4, 5].map(n => ({ label: `o${n}` }))
  expect(parseInput({ action: 'add', title: 'x', options: one }).ok).toBe(false)
  expect(parseInput({ action: 'add', title: 'x', options: five }).ok).toBe(false)
  expect(parseInput({ action: 'add', title: 'x', options: [{ label: 'a', recommended: true }, { label: 'b', recommended: true }] }).ok).toBe(false)
  expect(parseInput({ action: 'add', title: 'x', options: [{ label: 'a' }, { label: 'a' }] }).ok).toBe(false)
  expect(parseInput({ action: 'add', title: 'x', options: [{ label: 'a\nb' }, { label: 'c' }] }).ok).toBe(false)
})

test('a yes/no question is marked yesno and takes no options: the marker is parsed, and rejected together with named options', () => {
  expect(parseInput({ action: 'add', title: 'Ship it?', yesno: true })).toEqual({
    ok: true,
    value: { action: 'add', title: 'Ship it?', detail: '', blocking: false, options: [], yesno: true, doneLabel: null },
  })
  expect(parseInput({ action: 'add', title: 'Ship it?', yesno: false }).ok).toBe(true)
  expect(parseInput({ action: 'add', title: 'Ship it?', yesno: 'yes' }).ok).toBe(false)
  expect(parseInput({ action: 'add', title: 'Ship it?', yesno: true, options: [{ label: 'Yes' }, { label: 'No' }] }).ok).toBe(false)
})

test('a yes/no item is filed with the marker, and an update cannot give it options', () => {
  const made = act(EMPTY, input({ action: 'add', title: 'Ship it?', yesno: true }), MAIN)
  if (!('store' in made)) throw new Error(made.deny)
  expect(made.store.items[0]?.yesno).toBe(true)
  expect(act(made.store, input({ action: 'update', id: 1, options: [{ label: 'Yes' }, { label: 'No' }] }), MAIN)).toEqual({ deny: '#1 is a yes/no question: it takes no options' })
})

test('an update replaces the options; one that repeats them changes nothing', () => {
  const options = [{ label: 'Use sqlite' }, { label: 'Use postgres', recommended: true }]
  const made = act(EMPTY, input({ action: 'add', title: 'Pick a db', options }), MAIN)
  if (!('store' in made)) throw new Error('denied')
  expect(made.store.items[0]?.options.map(o => o.label)).toEqual(['Use sqlite', 'Use postgres'])
  expect(act(made.store, input({ action: 'update', id: 1, options }), MAIN)).toEqual({ store: made.store, reply: 'no change to #1', added: null, changed: null })
  const more = act(made.store, input({ action: 'update', id: 1, options: [...options, { label: 'Use a file' }] }), MAIN)
  expect('store' in more && more.reply).toBe('updated #1')
})

test('an option description edited only by spaces is no change, and a real description change still reopens a sent item', () => {
  const sent = sentList({ options: [{ label: 'Use sqlite', description: 'Simple', recommended: false }, { label: 'Use postgres', description: '', recommended: false }] })
  for (const options of [
    [{ label: 'Use sqlite', description: 'Simple  ' }, { label: 'Use postgres', description: '   ' }],
    [{ label: 'Use sqlite', description: ' Simple\n' }, { label: 'Use postgres', description: '' }],
  ]) {
    expect(changed(sent, { action: 'update', options })).toEqual({ store: sent, reply: 'no change to #1', added: null, changed: null })
  }
  const real = changed(sent, { action: 'update', options: [{ label: 'Use sqlite', description: 'Simple and cheap ' }, { label: 'Use postgres' }] })
  expect(real.store.items[0]).toMatchObject({ state: 'open', unread: true, answer: null })
  expect(real.store.items[0]?.options[0]?.description).toBe('Simple and cheap ')
  expect(real.changed).toEqual({ id: 1, reopened: true, promoted: false })
})

test('the pane\'s item is the selected one, with none selected the first; a selection whose item is gone names none', () => {
  let store = EMPTY
  for (const title of ['a', 'b', 'c']) store = added(store, title).store
  expect(selectedItem(store.items, 2)?.id).toBe(2)
  expect(selectedItem(store.items, null)?.id).toBe(1)
  const without2 = store.items.filter(it => it.id !== 2)
  expect(selectedItem(without2, 2)).toBe(undefined)
  expect(selectedItem(store.items, 9)).toBe(undefined)
  expect(selectedItem([], 1)).toBe(undefined)
})

test('the Claude list\'s view names no human item, whatever the list holds, while no selection still names the first', () => {
  let store = EMPTY
  for (const title of ['a', 'b', 'c']) store = added(store, title).store
  expect(selectedItem(store.items, 'claude-todo')).toBe(undefined)
  expect(selectedItem([], 'claude-todo')).toBe(undefined)
  expect(selectedItem(store.items, null)?.id).toBe(1)
})

test('an added item is not a reply', () => {
  expect(added(EMPTY, 'Pick a db').store.items[0]?.replied).toBe(false)
})

test('successorOf takes the next open item above, skipping items in a press or sent, else the last open item, and none when none is open', () => {
  const items = [withState(1, 'open'), withState(2, 'done-pending'), withState(3, 'done-waiting'), withState(4, 'open'), withState(5, 'done-pending')]
  expect(successorOf(items, 1)?.id).toBe(4)
  // Item 3 has just been sent (its press's window ended): the open items below it are 1 and nothing above.
  const sent = [withState(1, 'open'), withState(2, 'done-pending'), withState(3, 'done-pending')]
  expect(successorOf(sent, 3)?.id).toBe(1)
  expect(successorOf([withState(2, 'done-pending'), withState(3, 'done-pending')], 2)).toBeUndefined()
})

// An item as release 0.1 wrote it: only these six fields.
const legacy = { id: 1, title: 'Pick a db', detail: 'Which store?', blocking: true, createdAt: 5, state: 'open' }

test('an item an older release wrote is filled with the defaults of every field added since', () => {
  expect(normalizeItem(legacy)).toEqual({
    id: 1, title: 'Pick a db', detail: 'Which store?', blocking: true, createdAt: 5, state: 'open', pressedAt: null, note: null,
    agent: null, unread: false, options: [], yesno: false, answer: null, replied: false, doneLabel: null, thread: [], windowTurns: [], windowChanged: false,
  })
})

test('a stored window\'s update mark is kept while the window runs, and dropped from an item in no window or one never pressed', () => {
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: 7, answer: 'Use sqlite', windowChanged: true })?.windowChanged).toBe(true)
  expect(normalizeItem({ ...legacy, state: 'done-waiting', answer: 'Use sqlite', windowChanged: true })).toMatchObject({ state: 'open', windowChanged: false })
  expect(normalizeItem({ ...legacy, state: 'done-pending', windowChanged: true })?.windowChanged).toBe(false)
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: 7, windowChanged: 'yes' })?.windowChanged).toBe(false)
})

test('a stored window\'s agent turns are kept while the window runs, and dropped from an item in no window', () => {
  const agentTurn = { speaker: 'agent' as const, words: 'It needs a file.' }
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: 7, windowTurns: [agentTurn] })?.windowTurns).toEqual([agentTurn])
  expect(normalizeItem({ ...legacy, state: 'done-pending', windowTurns: [agentTurn] })?.windowTurns).toEqual([])
  expect(normalizeItem({ ...legacy, state: 'open', windowTurns: [agentTurn] })?.windowTurns).toEqual([])
})

test('an item stored without a done label, a stored label kept, and a label of the wrong type is null', () => {
  expect(normalizeItem(legacy)?.doneLabel).toBe(null)
  expect(normalizeItem({ ...legacy, doneLabel: 'Go with sqlite' })?.doneLabel).toBe('Go with sqlite')
  expect(normalizeItem({ ...legacy, doneLabel: 3 })?.doneLabel).toBe(null)
})

test('a field of the wrong type takes its default, and an unknown state becomes open', () => {
  const item = normalizeItem({ ...legacy, state: 'bogus', detail: 3, blocking: 'yes', createdAt: 'now', options: 'two', yesno: 'true', replied: 1 })
  expect(item).toMatchObject({ state: 'open', detail: '', blocking: false, createdAt: 0, options: [], yesno: false, replied: false })
  expect(normalizeItem({ ...legacy, options: [{ label: 'Yes', recommended: true }, { label: '' }, 'no', null] })?.options).toEqual([
    { label: 'Yes', description: '', recommended: true },
  ])
})

test('an item with no whole-number id from 1, or no title, is dropped', () => {
  expect(normalizeItem({ title: 'no id', detail: '', blocking: false, createdAt: 0, state: 'open' })).toBeNull()
  expect(normalizeItem({ ...legacy, id: '2' })).toBeNull()
  expect(normalizeItem({ ...legacy, id: 0 })).toBeNull()
  expect(normalizeItem({ ...legacy, id: 1.5 })).toBeNull()
  expect(normalizeItem({ id: 4, detail: 'no title' })).toBeNull()
  expect(normalizeItem(null)).toBeNull()
})

test('a stored list is normalized item by item, its garbage dropped, and its counter kept above the highest id', () => {
  expect(normalizeStore({ items: [legacy, { title: 'garbage' }], next: 2 })).toEqual({ items: [normalizeItem(legacy)], next: 2, term: null })
  expect(normalizeStore({ items: [{ ...legacy, id: 5 }], next: 2 }).next).toBe(6)
  expect(normalizeStore(undefined)).toEqual(EMPTY)
  expect(normalizeStore({ items: 'none', next: 'x' })).toEqual(EMPTY)
})


test('a done label is capped at 24 display columns: 24 ASCII is accepted, 25 refused; 12 wide characters (two columns each) accepted, 13 refused', () => {
  const reason = 'done must be at most 24 columns: name what a press does in a few words'
  expect(parseInput({ action: 'add', title: 'Pick', done: 'a'.repeat(24) })).toMatchObject({ ok: true, value: { doneLabel: 'a'.repeat(24) } })
  expect(parseInput({ action: 'add', title: 'Pick', done: 'a'.repeat(25) })).toEqual({ ok: false, reason })
  expect(parseInput({ action: 'update', id: 1, done: '中'.repeat(12) })).toMatchObject({ ok: true, value: { doneLabel: '中'.repeat(12) } })
  expect(parseInput({ action: 'update', id: 1, done: '中'.repeat(13) })).toEqual({ ok: false, reason })
})

test('the display-column measure the label limit uses is exported: a wide character counts two columns, any other one, a surrogate pair as one character', () => {
  expect(displayColumns('')).toBe(0)
  expect(displayColumns('abc')).toBe(3)
  expect(displayColumns('中文')).toBe(4)
  expect(displayColumns('a中b')).toBe(4)
  expect(displayColumns('😀')).toBe(2)
  expect(displayColumns('✓ ↶ […]')).toBe(7)
  expect(displayColumns('中'.repeat(12))).toBe(displayColumns('x'.repeat(24)))
})

// Code points written as numbers, so no editor or encoding changes a joiner or a variation selector that draws as nothing.
const cps = (...codes: number[]): string => String.fromCodePoint(...codes)

test('the measure counts each code point at the columns tmux drew for it alone, as the scan recorded: one for the glyphs the band draws and the text-presentation emoji, zero for joiners and selectors, two for wide characters', () => {
  const cases: [string, string, number][] = [
    // The glyphs the band draws, and the ones a title or an answer often holds.
    ...['✓', '✗', '↶', '…', '[', ']', '•', '·', '#', ' ', 'a'].map((glyph): [string, string, number] => [glyph, glyph, 1]),
    ['U+FF71 halfwidth katakana', cps(0xff71), 1],
    ['U+2764 heart, text presentation', cps(0x2764), 1],
    ['U+263A smiling face, text presentation', cps(0x263a), 1],
    ['U+2714 check mark, text presentation', cps(0x2714), 1],
    ['U+1F3F3 white flag', cps(0x1f3f3), 1],
    ['U+3FFFD, the last code point scanned', cps(0x3fffd), 1],
    ['U+200D joiner', cps(0x200d), 0],
    ['U+FE0F variation selector 16', cps(0xfe0f), 0],
    ['U+FE0E variation selector 15', cps(0xfe0e), 0],
    ['U+20E3 combining keycap', cps(0x20e3), 0],
    ['U+200B zero width space', cps(0x200b), 0],
    ['U+2705 ✅', cps(0x2705), 2],
    ['U+274C ❌', cps(0x274c), 2],
    ['U+2B50 ⭐', cps(0x2b50), 2],
    ['U+26A1 ⚡', cps(0x26a1), 2],
    ['U+65E5 日', cps(0x65e5), 2],
    ['U+306E の', cps(0x306e), 2],
    ['U+D55C 한', cps(0xd55c), 2],
    ['U+FF21 fullwidth A', cps(0xff21), 2],
    ['U+3001 ideographic comma', cps(0x3001), 2],
    ['U+20000', cps(0x20000), 2],
    ['U+20001', cps(0x20001), 2],
    ['U+2A6D6', cps(0x2a6d6), 2],
    ['U+30000', cps(0x30000), 2],
    ['U+1F600 😀', cps(0x1f600), 2],
    ['U+1F468 👨', cps(0x1f468), 2],
    ['U+1F308 🌈', cps(0x1f308), 2],
    // Where the scan and the table the measure replaced disagree: wide characters the table missed, and ones it counted wide that tmux draws narrow.
    ['U+2648 ♈', cps(0x2648), 2],
    ['U+2329', cps(0x2329), 2],
    ['U+1F004 🀄', cps(0x1f004), 2],
    ['U+1F18E 🆎', cps(0x1f18e), 2],
    ['U+17000', cps(0x17000), 2],
    ['U+2A6DF', cps(0x2a6df), 2],
    ['U+303F', cps(0x303f), 1],
    ['U+1F321 🌡', cps(0x1f321), 1],
    ['U+2A6E0', cps(0x2a6e0), 1],
  ]
  for (const [name, text, columns] of cases) expect(displayColumns(text), name).toBe(columns)
})

test('a variation selector 16 after a code point drawn one column wide adds one, as tmux draws the pair two wide; after anything else it adds none', () => {
  expect(displayColumns(cps(0x2764, 0xfe0f)), 'heart and selector').toBe(2)
  expect(displayColumns(cps(0x61, 0xfe0f)), 'a and selector').toBe(2)
  expect(displayColumns(cps(0x31, 0xfe0f, 0x20e3)), 'keycap 1').toBe(2)
  expect(displayColumns(cps(0x2713, 0xfe0f)), 'check mark and selector').toBe(2)
  // After a wide character the pair is two wide already; alone, or after a joiner, a selector takes no column.
  expect(displayColumns(cps(0x2705, 0xfe0f)), 'wide and selector').toBe(2)
  expect(displayColumns(cps(0xfe0f)), 'alone').toBe(0)
  expect(displayColumns(cps(0x200d, 0xfe0f)), 'after a joiner').toBe(0)
  expect(displayColumns(cps(0x61, 0xfe0f, 0xfe0f)), 'a second selector').toBe(2)
})

test('a joined sequence counts as its parts, never fewer columns than tmux draws it in: the family of four 8, the rainbow flag 4, a thumbs-up with a skin tone 4, two regional indicators 2, a letter, a joiner and a letter 2', () => {
  expect(displayColumns(cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466)), 'family of four').toBe(8)
  expect(displayColumns(cps(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)), 'rainbow flag').toBe(4)
  expect(displayColumns(cps(0x1f44d, 0x1f3fd)), 'thumbs-up, medium skin tone').toBe(4)
  expect(displayColumns(cps(0x1f1fa, 0x1f1f8)), 'US flag').toBe(2)
  expect(displayColumns(cps(0x61, 0x200d, 0x62)), 'a joiner b').toBe(2)
  expect(displayColumns(cps(0x2705, 0x274c, 0x2b50, 0x26a1)), 'four emoji').toBe(8)
})

test('a code point the scan did not measure counts two, the widest any measured one drew, so a cut lands early and never over the list', () => {
  const unmeasured: [string, number][] = [
    ['U+0007 a control', 0x07],
    ['U+0000', 0x00],
    ['U+001F', 0x1f],
    ['U+007F', 0x7f],
    ['U+009B a C1 control', 0x9b],
    ['U+009F', 0x9f],
    ['U+FFFE', 0xfffe],
    ['U+FFFF', 0xffff],
    ['U+1FFFE', 0x1fffe],
    ['U+1FFFF', 0x1ffff],
    ['U+3FFFE, the first past the scan', 0x3fffe],
    ['U+E0100 a variation selector supplement', 0xe0100],
    ['U+F0000 a private use plane', 0xf0000],
    ['U+10FFFF', 0x10ffff],
  ]
  for (const [name, code] of unmeasured) expect(displayColumns(cps(code)), name).toBe(2)
  // A lone surrogate is not a code point of the scan either.
  expect(displayColumns('\ud800'), 'lone high surrogate').toBe(2)
  expect(displayColumns('\udfff'), 'lone low surrogate').toBe(2)
  // The code points either side of a gap in the scan are measured.
  for (const code of [0x20, 0x7e, 0xa0, 0xd7ff, 0xe000, 0xfffd, 0x1fffd]) expect(displayColumns(cps(code)), `U+${code.toString(16)}`).toBe(1)
})

test('the columns of a text by code point: each whole code point with what it adds, a surrogate pair one, the selector after a one-column code point one, and the sum is the text\'s columns', () => {
  expect(columnsByCodePoint('')).toEqual([])
  expect(columnsByCodePoint(`a${cps(0x20000)}`)).toEqual([{ char: 'a', columns: 1 }, { char: cps(0x20000), columns: 2 }])
  expect(columnsByCodePoint(cps(0x2764, 0xfe0f, 0x200d, 0x1f525)).map(({ columns }) => columns)).toEqual([1, 1, 0, 2])
  expect(columnsByCodePoint(cps(0x2705, 0xfe0f)).map(({ columns }) => columns)).toEqual([2, 0])
  expect(columnsByCodePoint('\ud800a').map(({ char, columns }) => [char.length, columns])).toEqual([[1, 2], [1, 1]])
  for (const text of ['Fix it', `日本${cps(0x1f600, 0xfe0f)}`, cps(0x31, 0xfe0f, 0x20e3), cps(0x1f468, 0x200d, 0x1f469)]) {
    expect(columnsByCodePoint(text).reduce((sum, { columns }) => sum + columns, 0), text).toBe(displayColumns(text))
    expect(columnsByCodePoint(text).map(({ char }) => char).join(''), text).toBe(text)
  }
})

test('the band\'s answer cap and the tool\'s label limit are one constant, 24 columns', () => {
  expect(DONE_MAX).toBe(24)
  expect(parseInput({ action: 'add', title: 'Pick', done: 'a'.repeat(DONE_MAX) }).ok).toBe(true)
  expect(parseInput({ action: 'add', title: 'Pick', done: 'a'.repeat(DONE_MAX + 1) }).ok).toBe(false)
})

test('an update with done: \'\' clears the label; on a plain to-do with none it changes nothing, and an add refuses it', () => {
  expect(parseInput({ action: 'update', id: 2, done: '' })).toEqual({ ok: true, value: { action: 'update', id: 2, doneLabel: null } })
  expect(parseInput({ action: 'add', title: 'Pick', done: '' })).toEqual({ ok: false, reason: 'done needs a label, e.g. "Go with sqlite"' })
  const labelled = act(added(EMPTY, 'Pick a db').store, input({ action: 'update', id: 1, done: 'Go with sqlite' }), MAIN)
  if ('deny' in labelled) throw new Error(labelled.deny)
  const cleared = act(labelled.store, input({ action: 'update', id: 1, done: '' }), MAIN)
  if ('deny' in cleared) throw new Error(cleared.deny)
  expect(cleared.store.items[0]?.doneLabel).toBe(null)
  expect(cleared.reply).toBe('updated #1')
  expect(act(cleared.store, input({ action: 'update', id: 1, done: '' }), MAIN)).toMatchObject({ reply: 'no change to #1' })
})

// A call that is not denied, for the term tests: the outcome, or the test fails with the denial.
const applied = (store: Store, raw: Record<string, unknown>, ctx: Ctx = MAIN) => {
  const out = act(store, input(raw), ctx)
  if ('deny' in out) throw new Error(out.deny)
  return out
}
const TERM_TOO_LONG = 'term must be at most 20 columns: give the short word or name you use for the human'
const NOT_USED = ' (term not used: only the main agent sets it)'

test('a term is read as one line with single spaces, a blank one clears it, and one that is not text is refused for a main agent, naming the field', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  expect(applied(EMPTY, { action: 'add', title: 'Pick a db', term: '  Team\n   lead  ' }).store.term).toBe('Team lead')
  expect(applied(owned, { action: 'add', title: 'Second', term: '   ' }).store.term).toBe('')
  expect(applied(owned, { action: 'update', id: 1, term: '' }).store.term).toBe('')
  expect(act(owned, input({ action: 'add', title: 'Second', term: 3 }), MAIN)).toEqual({ deny: 'term must be text' })
  expect(act(owned, input({ action: 'update', id: 1, term: null }), MAIN)).toEqual({ deny: 'term must be text' })
})

test('a term is at most 20 columns, a wide character taking two: 20 is accepted, 21 refused with the limit named; 10 wide characters accepted, 11 refused', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db' }).store
  expect(applied(EMPTY, { action: 'add', title: 'Pick', term: 'a'.repeat(20) }).store.term).toBe('a'.repeat(20))
  expect(act(EMPTY, input({ action: 'add', title: 'Pick', term: 'a'.repeat(21) }), MAIN)).toEqual({ deny: TERM_TOO_LONG })
  expect(applied(owned, { action: 'update', id: 1, term: '中'.repeat(10) }).store.term).toBe('中'.repeat(10))
  expect(act(owned, input({ action: 'update', id: 1, term: '中'.repeat(11) }), MAIN)).toEqual({ deny: TERM_TOO_LONG })
})

test('the label and term limits read the scan\'s widths: ⭐ takes two columns, so 12 are a label and 13 are refused, 10 are a term and 11 are refused', () => {
  const labelReason = 'done must be at most 24 columns: name what a press does in a few words'
  expect(parseInput({ action: 'add', title: 'Pick', done: '⭐'.repeat(12) })).toMatchObject({ ok: true, value: { doneLabel: '⭐'.repeat(12) } })
  expect(parseInput({ action: 'add', title: 'Pick', done: '⭐'.repeat(13) })).toEqual({ ok: false, reason: labelReason })
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db' }).store
  expect(applied(owned, { action: 'update', id: 1, term: '⭐'.repeat(10) }).store.term).toBe('⭐'.repeat(10))
  expect(act(owned, input({ action: 'update', id: 1, term: '⭐'.repeat(11) }), MAIN)).toEqual({ deny: TERM_TOO_LONG })
})

test('a character the old table counted one column but tmux draws two is refused at its drawn width, and one it counted two but tmux draws one is accepted at its drawn width', () => {
  const labelReason = 'done must be at most 24 columns: name what a press does in a few words'
  // U+2648 ♈ and U+1F004 🀄 are two columns wide.
  for (const wide of [cps(0x2648), cps(0x1f004)]) {
    expect(parseInput({ action: 'add', title: 'Pick', done: wide.repeat(12) }).ok, `12 of U+${wide.codePointAt(0)?.toString(16)}`).toBe(true)
    expect(parseInput({ action: 'add', title: 'Pick', done: wide.repeat(13) }), `13 of U+${wide.codePointAt(0)?.toString(16)}`).toEqual({ ok: false, reason: labelReason })
  }
  // U+1F321 🌡 is one column wide: 24 make a label, 25 do not.
  const thermometer = cps(0x1f321)
  expect(parseInput({ action: 'add', title: 'Pick', done: thermometer.repeat(24) }).ok).toBe(true)
  expect(parseInput({ action: 'add', title: 'Pick', done: thermometer.repeat(25) })).toEqual({ ok: false, reason: labelReason })
})

test('a main agent\'s refused term refuses the whole call: an add is not made and an update applies none of its fields', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  expect(act(owned, input({ action: 'update', id: 1, title: 'Renamed', term: 'x'.repeat(21) }), MAIN)).toEqual({ deny: TERM_TOO_LONG })
  expect(act(owned, input({ action: 'update', id: 1, title: 'Renamed', term: 3 }), MAIN)).toEqual({ deny: 'term must be text' })
  expect(act(owned, input({ action: 'add', title: 'Second', term: 'x'.repeat(21) }), MAIN)).toEqual({ deny: TERM_TOO_LONG })
})

test('a subagent\'s term is not used, so one that would not check, over the limit or not text, does not refuse its add or its update', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  const added = applied(owned, { action: 'add', title: 'Sub ask', term: 'x'.repeat(21) }, SUB)
  expect(added.store.items.map(it => it.title)).toEqual(['Pick a db', 'Sub ask'])
  expect(added.store.term).toBe('owner')
  expect(added.reply).toBe(`added #2${NOT_USED}`)
  const edited = applied(owned, { action: 'update', id: 1, note: 'recheck', term: 3 }, SUB)
  expect(edited.store.items[0]?.note).toBe('recheck')
  expect(edited.reply).toBe(`updated #1${NOT_USED}`)
  expect(applied(owned, { action: 'update', id: 1, term: 'x'.repeat(21) }, SUB).reply).toBe(`no change to #1${NOT_USED}`)
})

test('an update that gives neither an item field nor a term is refused, and the reason lists the term', () => {
  expect(parseInput({ action: 'update', id: 1 })).toEqual({ ok: false, reason: 'update changes nothing: give a title, detail, blocking, note, options, done or term' })
})

test('an add from the main agent with a term sets it, and its reply names the term after the id', () => {
  const out = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' })
  expect(out.store.term).toBe('owner')
  expect(out.reply).toBe('added #1 (term set to "owner")')
  expect(out.added?.id).toBe(1)
})

test('a call with no term leaves the list\'s term and adds no note; a later term replaces it; a blank one clears it', () => {
  const first = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' })
  const plain = applied(first.store, { action: 'add', title: 'Second' })
  expect(plain.store.term).toBe('owner')
  expect(plain.reply).toBe('added #2')
  const replaced = applied(plain.store, { action: 'add', title: 'Third', term: 'boss' })
  expect(replaced.store.term).toBe('boss')
  expect(replaced.reply).toBe('added #3 (term set to "boss")')
  const cleared = applied(replaced.store, { action: 'add', title: 'Fourth', term: '  ' })
  expect(cleared.store.term).toBe('')
  expect(cleared.store.items.map(it => it.title)).toEqual(['Pick a db', 'Second', 'Third', 'Fourth'])
  expect(cleared.reply).toBe('added #4 (term cleared)')
})

test('an update of an id no item has is refused, whatever term it states', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  expect(act(owned, input({ action: 'update', id: 9, term: 'boss' }), MAIN)).toEqual({ deny: 'no item #9' })
})

test('a subagent\'s term is not used: its add adds the item, leaves the list\'s term, and its reply says so', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  const sub = applied(owned, { action: 'add', title: 'Sub ask', term: 'the user' }, SUB)
  expect(sub.store.term).toBe('owner')
  expect(sub.store.items.map(it => it.title)).toEqual(['Pick a db', 'Sub ask'])
  expect(sub.reply).toBe(`added #2${NOT_USED}`)
})

test('a subagent\'s update applies its other fields and leaves the term; a term-only one replies no change, with the note', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  const edited = applied(owned, { action: 'update', id: 1, note: 'recheck', term: 'the user' }, SUB)
  expect(edited.store.items[0]?.note).toBe('recheck')
  expect(edited.store.term).toBe('owner')
  expect(edited.reply).toBe(`updated #1${NOT_USED}`)
  const only = applied(owned, { action: 'update', id: 1, term: 'the user' }, SUB)
  expect(only.store.term).toBe('owner')
  expect(only.reply).toBe(`no change to #1${NOT_USED}`)
})

test('a term-only update from the main agent sets the term and leaves an open item as it was; a blank one clears the term', () => {
  const made = applied(EMPTY, { action: 'add', title: 'Pick a db' }).store
  const set = applied(made, { action: 'update', id: 1, term: 'owner' })
  expect(set.store.term).toBe('owner')
  expect(set.store.items).toEqual(made.items)
  expect(set.changed).toBe(null)
  expect(set.reply).toBe('no change to #1 (term set to "owner")')
  const cleared = applied(set.store, { action: 'update', id: 1, term: '' })
  expect(cleared.store.term).toBe('')
  expect(cleared.reply).toBe('no change to #1 (term cleared)')
})

test('a term-only update on a sent item sets the term and leaves the item sent', () => {
  const out = applied(sentList(), { action: 'update', id: 1, term: 'owner' })
  expect(out.store.term).toBe('owner')
  expect(out.store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
  expect(out.changed).toBe(null)
})

test('a blank term on an update clears the term, and the update\'s other fields still apply', () => {
  const owned = applied(EMPTY, { action: 'add', title: 'Pick a db', term: 'owner' }).store
  const retitled = applied(owned, { action: 'update', id: 1, title: 'Pick a cache', term: '  ' })
  expect(retitled.store.term).toBe('')
  expect(retitled.store.items[0]?.title).toBe('Pick a cache')
  expect(retitled.reply).toBe('updated #1 (term cleared)')
})

test('an update with a term that changes a field the human is asked about reopens a sent item, as without the term, and sets the term', () => {
  const sent = sentList()
  const withTerm = applied(sent, { action: 'update', id: 1, title: 'Pick a cache', term: 'owner' })
  const without = applied(sent, { action: 'update', id: 1, title: 'Pick a cache' })
  expect(withTerm.store.items).toEqual(without.store.items)
  expect(withTerm.store.items[0]).toMatchObject({ state: 'open', unread: true })
  expect(withTerm.changed).toEqual({ id: 1, reopened: true, promoted: false })
  expect(withTerm.changed).toEqual(without.changed)
  expect(withTerm.store.term).toBe('owner')
  expect(withTerm.reply).toBe('updated #1 (term set to "owner")')
})

test('a stored term is kept as text, a stored blank reads as the cleared term, and anything else, or no term at all, reads as none', () => {
  expect(normalizeStore({ items: [], next: 2, term: 'owner' })).toEqual({ items: [], next: 2, term: 'owner' })
  expect(normalizeStore({ items: [], next: 2, term: '' })).toEqual({ items: [], next: 2, term: '' })
  expect(normalizeStore({ items: [], next: 2, term: '  ' })).toEqual({ items: [], next: 2, term: '' })
  expect(normalizeStore({ items: [], next: 2 })).toEqual({ items: [], next: 2, term: null })
  expect(normalizeStore({ items: [], next: 2, term: 7 })).toEqual({ items: [], next: 2, term: null })
})

test('clearing the list clears the term with the items, and keeps the counter', () => {
  expect(clearAll({ items: [], next: 3, term: 'owner' })).toEqual({ items: [], next: 3, term: null })
})

test('a rebuilt list keeps a term stated live, a cleared one included, and takes the rebuilt term only when none was stated live', () => {
  const rebuilt: Store = { items: [], next: 1, term: 'owner' }
  expect(mergeRestored({ items: [], next: 1, term: 'mine' }, rebuilt, []).term).toBe('mine')
  expect(mergeRestored({ items: [], next: 1, term: '' }, rebuilt, []).term).toBe('')
  expect(mergeRestored({ items: [], next: 1, term: null }, rebuilt, []).term).toBe('owner')
  expect(mergeRestored(EMPTY, { items: [], next: 1, term: null }, []).term).toBe(null)
})

test('a term the main agent clears live stays cleared when a rebuild joins a transcript that states another', () => {
  const live = applied(EMPTY, { action: 'add', title: 'Pick a db', term: '  ' }).store
  expect(mergeRestored(live, { items: [], next: 1, term: 'owner' }, []).term).toBe('')
})

test('an unknown action names every action it takes', () => {
  expect(parseInput({ action: 'bogus' })).toEqual({ ok: false, reason: 'action must be add, update, append, remove or list' })
})

test('an update whose title is blank says the title is empty; a title that is not text says it is not text', () => {
  expect(parseInput({ action: 'update', id: 1, title: '   ' })).toEqual({ ok: false, reason: 'title is empty' })
  expect(parseInput({ action: 'update', id: 1, title: 3 })).toEqual({ ok: false, reason: 'title must be text' })
})

test('a blank note is parsed as clearing the note, and clears it from a sent item without reopening it', () => {
  expect(parseInput({ action: 'update', id: 1, note: '  ' })).toEqual({ ok: true, value: { action: 'update', id: 1, note: null } })
  const { store } = added(EMPTY, 'Pick a db')
  const noted = { ...store, items: store.items.map(it => ({ ...it, note: 'recheck', state: 'done-pending' as const })) }
  const cleared = act(noted, input({ action: 'update', id: 1, note: '' }), MAIN)
  if ('deny' in cleared) throw new Error(cleared.deny)
  expect(cleared.store.items[0]).toMatchObject({ note: null, state: 'done-pending' })
  expect(cleared.reply).toBe('updated #1')
})

test('a whitespace-only detail parses as an empty one, on add and on update; a real detail is kept as written', () => {
  expect(parseInput({ action: 'add', title: 'Pick a db', detail: '   ' })).toEqual({
    ok: true,
    value: { action: 'add', title: 'Pick a db', detail: '', blocking: false, options: [], yesno: false, doneLabel: null },
  })
  expect(parseInput({ action: 'update', id: 1, detail: ' \n ' })).toEqual({ ok: true, value: { action: 'update', id: 1, detail: '' } })
  expect(parseInput({ action: 'update', id: 1, detail: '  Which store?\n' })).toEqual({
    ok: true,
    value: { action: 'update', id: 1, detail: '  Which store?\n' },
  })
})

test('a whitespace-only detail on add is stored empty: the new item lists with no stray line, and an append sets its detail alone', () => {
  const made = act(EMPTY, input({ action: 'add', title: 'Pick a db', detail: '   ' }), MAIN)
  if (!('store' in made)) throw new Error(made.deny)
  expect(made.store.items[0]?.detail).toBe('')
  expect(listText(made.store.items)).toBe('#1 non-blocking, open: Pick a db')
  const appended = act(made.store, input({ action: 'append', id: 1, text: 'Two options.' }), MAIN)
  if (!('store' in appended)) throw new Error(appended.deny)
  expect(appended.store.items[0]?.detail).toBe('Two options.')
})

test('a stored detail or note of only spaces loads as cleared: an append sets the detail alone, and the list shows no stray line', () => {
  const loaded = normalizeStore({ items: [{ ...legacy, detail: '   ', note: ' \n ' }], next: 2 })
  expect(loaded.items[0]).toMatchObject({ detail: '', note: null })
  expect(listText(loaded.items)).toBe('#1 blocking, open: Pick a db')
  const appended = act(loaded, input({ action: 'append', id: 1, text: 'Two options.' }), MAIN)
  if (!('store' in appended)) throw new Error(appended.deny)
  expect(appended.store.items[0]?.detail).toBe('Two options.')
  expect(normalizeItem({ ...legacy, detail: '  Which store?  ', note: ' recheck ' })).toMatchObject({ detail: '  Which store?  ', note: ' recheck ' })
})

test('an undo window with no press time was never pressed, so the item is open; a timed one stays', () => {
  expect(normalizeItem({ ...legacy, state: 'done-waiting' })).toMatchObject({ state: 'open', pressedAt: null })
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: NaN })).toMatchObject({ state: 'open', pressedAt: null })
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: 7 })).toMatchObject({ state: 'done-waiting', pressedAt: 7 })
})

test('an unpressed window\'s agent turns load folded as a cancelled window folds them: into the brief with no human turn, after the thread with one; a timed window keeps them', () => {
  const agentTurn = { speaker: 'agent' as const, words: 'It needs a file.' }
  expect(normalizeItem({ ...legacy, state: 'done-waiting', answer: 'Use sqlite', replied: true, windowTurns: [agentTurn] })).toMatchObject({
    state: 'open', answer: null, replied: false, detail: 'Which store?\n\nIt needs a file.', thread: [], windowTurns: [],
  })
  const human = { speaker: 'human' as const, words: 'Use postgres' }
  expect(normalizeItem({ ...legacy, state: 'done-waiting', thread: [human], windowTurns: [agentTurn] })).toMatchObject({
    state: 'open', detail: 'Which store?', thread: [human, agentTurn], windowTurns: [],
  })
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: 7, windowTurns: [agentTurn] })).toMatchObject({ state: 'done-waiting', windowTurns: [agentTurn] })
})

// A reply the human typed, sent through its undo window (done.ts): the item is left with the reply as its sent answer.
const sentReply = (store: Store, text: string): Store => expire(reply(store, 1, 1000, text), 1, 1000).store

test('a reply, an append, a reply and an append leave a thread of four turns in that order, the words exact, and the brief as it was', () => {
  let store = added(EMPTY, 'Pick a db').store
  store = changed(store, { action: 'update', detail: 'Which store?' }).store
  store = sentReply(store, 'Use sqlite')
  store = changed(store, { action: 'append', text: 'It needs a file.' }).store
  store = sentReply(store, 'Use postgres')
  store = changed(store, { action: 'append', text: 'It needs a server.' }).store
  expect(store.items[0]?.detail).toBe('Which store?')
  expect(turnsOf(store.items[0] as Item)).toEqual([
    { speaker: 'human', words: 'Use sqlite' },
    { speaker: 'agent', words: 'It needs a file.' },
    { speaker: 'human', words: 'Use postgres' },
    { speaker: 'agent', words: 'It needs a server.' },
  ])
})

test('a reply sent and then an append before the agent has read the notice puts the reply first and the agent\'s turn second', () => {
  const out = changed(sentReply(added(EMPTY, 'Pick a db').store, 'Use sqlite'), { action: 'append', text: 'It needs a file.' })
  expect(out.store.items[0]).toMatchObject({ state: 'open', unread: true })
  expect(turnsOf(out.store.items[0] as Item)).toEqual([{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'It needs a file.' }])
})

test('an agent turn added to an open item the human has answered is unread, though the human has read the item since', () => {
  const archived = changed(sentReply(added(EMPTY, 'Pick a db').store, 'Use sqlite'), { action: 'append', text: 'It needs a file.' }).store
  const seen = { ...archived, items: archived.items.map(it => ({ ...it, unread: false })) }
  const again = changed(seen, { action: 'append', text: 'Or a server?' })
  expect(again.store.items[0]).toMatchObject({ state: 'open', unread: true })
  expect(turnsOf(again.store.items[0] as Item).map(turn => turn.words)).toEqual(['Use sqlite', 'It needs a file.', 'Or a server?'])
})

test('an append in a reply\'s undo window is an agent turn after the reply: the window runs on, and its end leaves the reply first, recorded once', () => {
  const waiting = reply(added(EMPTY, 'Pick a db').store, 1, 1000, 'Use sqlite')
  const appended = changed(waiting, { action: 'append', text: 'It needs a file.' })
  expect(appended.store.items[0]).toMatchObject({ state: 'done-waiting', pressedAt: 1000, detail: '', windowTurns: [{ speaker: 'agent', words: 'It needs a file.' }] })
  expect(appended.changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(turnsOf(expire(appended.store, 1, 1000).store.items[0] as Item)).toEqual([
    { speaker: 'human', words: 'Use sqlite' },
    { speaker: 'agent', words: 'It needs a file.' },
  ])
})

test('an update in a reply\'s undo window changes the item and the window runs on; its end archives the reply once and reopens the item, sending the reply', () => {
  const waiting = reply(added(EMPTY, 'Pick a db').store, 1, 1000, 'Use sqlite')
  const updated = changed(waiting, { action: 'update', detail: 'Postgres or sqlite?' })
  expect(updated.store.items[0]).toMatchObject({ state: 'done-waiting', pressedAt: 1000, detail: 'Postgres or sqlite?', windowTurns: [] })
  expect(updated.changed).toEqual({ id: 1, reopened: false, promoted: false })
  expect(listText(updated.store.items)).toBe('#1 non-blocking, done-waiting: Pick a db - Postgres or sqlite?\n  you: Use sqlite')
  const out = expire(updated.store, 1, 1000)
  expect(out.sent).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
  expect(out.store.items[0]).toMatchObject({ state: 'open', unread: true, answer: null, replied: false, detail: 'Postgres or sqlite?', windowChanged: false })
  expect(turnsOf(out.store.items[0] as Item)).toEqual([{ speaker: 'human', words: 'Use sqlite' }])
  expect(expire(out.store, 1, 1000).sent).toBe(null)
})

test('an update in a bare done press\'s window reopens the item at its end, the press archived as its turn', () => {
  const waiting = press(added(EMPTY, 'Pick a db').store, 1, 1000, null)
  const out = expire(changed(waiting, { action: 'update', note: 'which one?' }).store, 1, 1000)
  expect(out.store.items[0]).toMatchObject({ state: 'open', note: 'which one?', thread: [{ speaker: 'human', words: 'pressed done' }] })
})

test('an update in an undo window that changes nothing, or only clears a field, leaves the item sent at the window\'s end, as it would a sent item', () => {
  const waiting = reply(added(EMPTY, 'Pick a db').store, 1, 1000, 'Use sqlite')
  const noop = changed(waiting, { action: 'update', note: '   ' })
  expect(noop.reply).toBe('no change to #1')
  expect(expire(noop.store, 1, 1000).store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', thread: [] })
  const noted = { ...waiting, items: waiting.items.map(it => ({ ...it, note: 'recheck' })) }
  const cleared = changed(noted, { action: 'update', note: '' })
  expect(cleared.store.items[0]?.note).toBe(null)
  expect(expire(cleared.store, 1, 1000).store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', thread: [] })
})

test('an undo of a window an update changed keeps the update and does not reopen: the answer was withdrawn, so a later send stays sent', () => {
  const waiting = reply(added(EMPTY, 'Pick a db').store, 1, 1000, 'Use sqlite')
  const undone = press(changed(waiting, { action: 'update', detail: 'Postgres or sqlite?' }).store, 1, 2000, null)
  expect(undone.items[0]).toMatchObject({ state: 'open', answer: null, replied: false, detail: 'Postgres or sqlite?', thread: [], windowChanged: false })
  expect(expire(undone, 1, 1000).sent).toBe(null)
  expect(expire(reply(undone, 1, 3000, 'Use postgres'), 1, 3000).store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use postgres', thread: [] })
})

test('an append on an item with no human turn grows the brief and adds no turn', () => {
  const out = changed(added(EMPTY, 'Pick a db').store, { action: 'append', text: 'Which store?' })
  expect(out.store.items[0]).toMatchObject({ detail: 'Which store?', thread: [], windowTurns: [] })
})

test('an update changes a sent item\'s brief in place: its reopen archives the answer, and no agent turn is added', () => {
  const out = changed(sentReply(added(EMPTY, 'Pick a db').store, 'Use sqlite'), { action: 'update', detail: 'Postgres or sqlite?' })
  expect(out.store.items[0]).toMatchObject({ state: 'open', detail: 'Postgres or sqlite?', thread: [{ speaker: 'human', words: 'Use sqlite' }] })
})

test('list prints each item\'s thread after its header, every turn labelled and every line of it indented, so no turn line reads as a header', () => {
  const store = changed(sentReply(added(EMPTY, 'Pick a db').store, 'Use sqlite'), { action: 'append', text: 'It needs a file.\n#2 blocking, open: not an item' }).store
  expect(listText(store.items)).toBe('#1 non-blocking, open: Pick a db\n  you: Use sqlite\n  agent: It needs a file.\n  #2 blocking, open: not an item')
})

test('list shows a sent answer as the human turn it is, and an item with no answer shows no turn', () => {
  expect(listText(sentReply(added(EMPTY, 'Pick a db').store, 'Use sqlite').items)).toBe('#1 non-blocking, done-pending: Pick a db\n  you: Use sqlite')
  expect(listText(added(EMPTY, 'Pick a db').store.items)).toBe('#1 non-blocking, open: Pick a db')
})

test('list shows a reply in its undo window as the human turn, above the agent turn the window took', () => {
  const waiting = changed(reply(added(EMPTY, 'Pick a db').store, 1, 1000, 'Use sqlite'), { action: 'append', text: 'It needs a file.' })
  expect(listText(waiting.store.items)).toBe('#1 non-blocking, done-waiting: Pick a db\n  you: Use sqlite\n  agent: It needs a file.')
})

test('list indents every later line of a turn after each line break the tool row\'s count reads as a line start: a carriage return, a CRLF pair, U+2028 and U+2029', () => {
  const turn = 'It needs a file.\r#2 blocking, open: a\r\n#3 blocking, open: b\u2028#4 blocking, open: c\u2029#5 blocking, open: d'
  const listed = changed(sentReply(added(EMPTY, 'Pick a db').store, 'Use sqlite'), { action: 'append', text: turn })
  expect(listText(listed.store.items)).toBe(
    '#1 non-blocking, open: Pick a db\n  you: Use sqlite\n  agent: It needs a file.\n  #2 blocking, open: a\n  #3 blocking, open: b\n  #4 blocking, open: c\n  #5 blocking, open: d',
  )
})

test('list indents the later lines of an item\'s title, brief and note as it does a turn\'s, so none of them reads as an item\'s header', () => {
  const made = act(EMPTY, input({ action: 'add', title: 'Pick\n#2 blocking, open: a', detail: 'Which store?\n#3 blocking, open: b' }), MAIN)
  if (!('store' in made)) throw new Error(made.deny)
  const noted = act(made.store, input({ action: 'update', id: 1, note: 'recheck\n#4 blocking, open: c' }), MAIN)
  if (!('store' in noted)) throw new Error(noted.deny)
  expect(listText(noted.store.items)).toBe('#1 non-blocking, open: Pick\n  #2 blocking, open: a - Which store?\n  #3 blocking, open: b (note: recheck\n  #4 blocking, open: c)')
})

test('a list an older release wrote loads with empty threads, and a stored thread drops its malformed turns and keeps the rest', () => {
  expect(normalizeItem(legacy)).toMatchObject({ thread: [], windowTurns: [] })
  expect(normalizeItem({
    ...legacy,
    thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'robot', words: 'x' }, { speaker: 'agent' }, 'junk', { speaker: 'agent', words: '  ' }, { speaker: 'agent', words: 'It needs a file.' }],
    windowTurns: 'none',
  })).toMatchObject({ thread: [{ speaker: 'human', words: 'Use sqlite' }, { speaker: 'agent', words: 'It needs a file.' }], windowTurns: [] })
})
