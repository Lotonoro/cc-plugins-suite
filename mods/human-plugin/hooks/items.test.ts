import { expect, test } from 'claude-code/testing'
import { EMPTY, act, carryNext, clearAll, listText, mergeRestored, normalizeItem, normalizeStore, parseInput, selectedItem, successorOf, type Ctx, type ToolInput } from './items'
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
  options: [], answer: null, yesno: false, replied: false, doneLabel: null,
})

const added = (store: Store, title: string, ctx: Ctx = MAIN) => {
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
  const yesno = { items: yes.items.map(it => ({ ...it, yesno: true })), next: yes.next }
  expect(act(yesno, input({ action: 'update', id: 1, done: 'Ship' }), MAIN)).toEqual({
    deny: '#1 is a yes/no question or a decision: its buttons say what a press means, so it takes no done label',
  })
  const decision = { items: [{ ...withState(1, 'open'), options: [{ label: 'A', description: '', recommended: false }, { label: 'B', description: '', recommended: false }] }], next: 2 }
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

test('update changes fields and reopens a done-pending item only with a note', () => {
  const { store } = added(EMPTY, 'Pick a db')
  const pending = { ...store, items: store.items.map(it => ({ ...it, state: 'done-pending' as const })) }
  const noNote = act(pending, input({ action: 'update', id: 1, detail: 'postgres' }), MAIN)
  if ('deny' in noNote) throw new Error(noNote.deny)
  expect(noNote.store.items[0]?.state).toBe('done-pending')
  expect(noNote.store.items[0]?.detail).toBe('postgres')
  const reopened = act(pending, input({ action: 'update', id: 1, note: 'still open' }), MAIN)
  if ('deny' in reopened) throw new Error(reopened.deny)
  expect(reopened.store.items[0]?.state).toBe('open')
  expect(reopened.store.items[0]?.note).toBe('still open')
  expect(reopened.reply).toBe('updated #1')
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
  expect(carryNext({ items: [], next: 9 }, 7).next).toBe(9)
  expect(carryNext(EMPTY, undefined).next).toBe(1)
  expect(carryNext(EMPTY, '7').next).toBe(1)
  expect(carryNext(EMPTY, 2.5).next).toBe(1)
})

test('a rebuilt list keeps an item added after the transcript was read, drops one the transcript ended, and never lowers the counter', () => {
  const replayed = added(added(EMPTY, 'from the transcript').store, 'also replayed').store
  const live = added({ items: [], next: 7 }, 'added meanwhile').store
  const removedInTranscript = { ...live, items: [...live.items, { ...(replayed.items[0] as Item), id: 5 }] }
  const merged = mergeRestored(removedInTranscript, replayed, [1, 2, 5])
  expect(merged.items.map(it => `${it.id} ${it.title}`)).toEqual(['1 from the transcript', '2 also replayed', '7 added meanwhile'])
  expect(merged.next).toBe(8)
  expect(mergeRestored(EMPTY, { items: [], next: 4 }, [1, 2, 3]).next).toBe(4)
  expect(mergeRestored({ items: [], next: 9 }, { items: [], next: 4 }, [1, 2, 3]).next).toBe(9)
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
  expect(act(made.store, input({ action: 'update', id: 1, options }), MAIN)).toEqual({ store: made.store, reply: 'no change to #1', added: null })
  const more = act(made.store, input({ action: 'update', id: 1, options: [...options, { label: 'Use a file' }] }), MAIN)
  expect('store' in more && more.reply).toBe('updated #1')
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
    agent: null, unread: false, options: [], yesno: false, answer: null, replied: false, doneLabel: null,
  })
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
  expect(normalizeStore({ items: [legacy, { title: 'garbage' }], next: 2 })).toEqual({ items: [normalizeItem(legacy)], next: 2 })
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

test('an unknown action names every action it takes', () => {
  expect(parseInput({ action: 'bogus' })).toEqual({ ok: false, reason: 'action must be add, update, append, remove or list' })
})

test('an update whose title is blank says the title is empty; a title that is not text says it is not text', () => {
  expect(parseInput({ action: 'update', id: 1, title: '   ' })).toEqual({ ok: false, reason: 'title is empty' })
  expect(parseInput({ action: 'update', id: 1, title: 3 })).toEqual({ ok: false, reason: 'title must be text' })
})

test('a blank note is parsed as clearing the note, and clears it without reopening a done item', () => {
  expect(parseInput({ action: 'update', id: 1, note: '  ' })).toEqual({ ok: true, value: { action: 'update', id: 1, note: null } })
  const { store } = added(EMPTY, 'Pick a db')
  const noted = { ...store, items: store.items.map(it => ({ ...it, note: 'recheck', state: 'done-pending' as const })) }
  const cleared = act(noted, input({ action: 'update', id: 1, note: '' }), MAIN)
  if ('deny' in cleared) throw new Error(cleared.deny)
  expect(cleared.store.items[0]).toMatchObject({ note: null, state: 'done-pending' })
  expect(cleared.reply).toBe('updated #1')
})

test('an undo window with no press time was never pressed, so the item is open; a timed one stays', () => {
  expect(normalizeItem({ ...legacy, state: 'done-waiting' })).toMatchObject({ state: 'open', pressedAt: null })
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: NaN })).toMatchObject({ state: 'open', pressedAt: null })
  expect(normalizeItem({ ...legacy, state: 'done-waiting', pressedAt: 7 })).toMatchObject({ state: 'done-waiting', pressedAt: 7 })
})
