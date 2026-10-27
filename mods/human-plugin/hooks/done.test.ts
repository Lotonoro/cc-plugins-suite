import { expect, test } from 'claude-code/testing'
import { doneNotice, expire, pointerText, press, reply } from './done'
import { act, parseInput } from './items'
import type { Item, Store } from '../types'

const item: Item = {
  id: 3,
  title: 'Pick a db',
  detail: 'postgres or sqlite',
  blocking: true,
  createdAt: 0,
  state: 'open',
  pressedAt: null,
  note: null,
  agent: null,
  unread: false,
  options: [], answer: null, yesno: false, replied: false, doneLabel: null,
}
const store: Store = { items: [item], next: 4 }
const stateOf = (s: Store) => s.items[0]?.state

test('the notice names the item by id and title, in the marker form the replay reads, and never carries the brief', () => {
  const brief = 'Long brief. '.repeat(200)
  const text = doneNotice({ ...item, detail: brief, state: 'done-pending' })
  expect(text.startsWith('#3 is done: Pick a db\nThe human marked it done.')).toBe(true)
  expect(text).not.toContain('Long brief.')
  expect(text).not.toContain('postgres or sqlite')
  expect(doneNotice({ ...item, detail: '' })).toBe(doneNotice({ ...item, detail: brief }))
})

test('a line break in the title or in a chosen option is drawn as a space, so no line of the notice reads as another marker', () => {
  const text = doneNotice({ ...item, title: 'Pick\n#9 is done: a db', options: [{ label: 'a\n#8 is done: b', description: '', recommended: false }], answer: 'a\n#8 is done: b', state: 'done-pending' })
  expect(text.split('\n').filter(line => /^#\d+ is done:/.test(line))).toEqual(['#3 is done: Pick #9 is done: a db'])
  expect(text).toContain('The human chose a #8 is done: b on #3.')
})

test('a reply\'s own spacing reaches the agent as the human typed it: only a line break becomes a space', () => {
  const text = doneNotice({ ...item, answer: 'use  `a  b`\tthen\nmore', state: 'done-pending' })
  expect(text).toContain('use  `a  b`\tthen more')
})

test('the pointer names the items whose notices are already in the conversation, and does not repeat a notice', () => {
  expect(pointerText([3])).toContain('#3')
  expect(pointerText([3, 5])).toContain('#3, #5')
  for (const text of [pointerText([3]), pointerText([3, 5])]) expect(/#\d+ is done:/.test(text)).toBe(false)
})

test('a done press opens the undo window and sends nothing yet', () => {
  const waiting = press(store, 3, 1000, null)
  expect(stateOf(waiting)).toBe('done-waiting')
  expect(waiting.items[0]?.pressedAt).toBe(1000)
})

test('a second press inside the window cancels it, and the expiry then sends nothing', () => {
  const waiting = press(store, 3, 1000, null)
  const cancelled = press(waiting, 3, 2000, null)
  expect(stateOf(cancelled)).toBe('open')
  const expired = expire(cancelled, 3, 1000)
  expect(expired.sent).toBe(null)
  expect(stateOf(expired.store)).toBe('open')
})

test('expiry of an open window sends the item exactly once', () => {
  const waiting = press(store, 3, 1000, null)
  const first = expire(waiting, 3, 1000)
  expect(first.sent?.id).toBe(3)
  expect(stateOf(first.store)).toBe('done-pending')
  expect(first.store.items[0]?.pressedAt).toBe(null)
  const again = expire(first.store, 3, 1000)
  expect(again.sent).toBe(null)
})

test('an expiry for an earlier press does not send a later press', () => {
  const firstWindow = press(store, 3, 1000, null)
  const cancelled = press(firstWindow, 3, 2000, null)
  const secondWindow = press(cancelled, 3, 3000, null)
  expect(expire(secondWindow, 3, 1000).sent).toBe(null)
  expect(expire(secondWindow, 3, 3000).sent?.id).toBe(3)
})

test('a press on a sent item changes nothing', () => {
  const sent = expire(press(store, 3, 1000, null), 3, 1000).store
  expect(press(sent, 3, 5000, null)).toEqual(sent)
})

test('a press on an option carries its label through the window; cancelling it clears the label', () => {
  const waiting = press(store, 3, 1000, 'Use postgres')
  expect(waiting.items[0]?.answer).toBe('Use postgres')
  expect(expire(waiting, 3, 1000).store.items[0]?.answer).toBe('Use postgres')
  expect(press(waiting, 3, 2000, null).items[0]?.answer).toBe(null)
})

test('the notice of a pressed option names the choice; a plain done names the human\'s done', () => {
  expect(doneNotice({ ...item, answer: 'Use postgres' })).toContain('The human chose Use postgres on #3. Act on that choice')
  expect(doneNotice({ ...item, answer: null })).toContain('The human marked it done.')
})

test('the notice of a pressed yes or no names the answer, in the words of a choice\'s notice', () => {
  const answered = doneNotice({ ...item, yesno: true, answer: 'no', state: 'done-pending' })
  expect(answered).toContain('The human answered no on #3. Act on that answer, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.')
  expect(answered).not.toContain('chose')
})

test('a reply on an open item opens its undo window with the text, a line break in it drawn as a space', () => {
  const waiting = reply(store, 3, 1000, 'Use sqlite\nnot postgres')
  expect(waiting.items[0]).toMatchObject({ state: 'done-waiting', pressedAt: 1000, answer: 'Use sqlite not postgres', replied: true })
})

test('a reply on an item that is not open changes nothing, so it never cancels a window', () => {
  const waiting = press(store, 3, 1000, null)
  expect(reply(waiting, 3, 2000, 'Use sqlite')).toEqual(waiting)
})

test('a reply that expires is sent with its text and its replied flag', () => {
  const sent = expire(reply(store, 3, 1000, 'Use sqlite'), 3, 1000).sent
  expect(sent).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
})

test('a press that cancels a reply clears its text and its replied flag', () => {
  const cancelled = press(reply(store, 3, 1000, 'Use sqlite'), 3, 2000, null)
  expect(cancelled.items[0]).toMatchObject({ state: 'open', answer: null, replied: false })
})

test('the notice of a reply quotes it on its own line after the title, and names the reply', () => {
  const text = doneNotice({ ...item, answer: 'Use sqlite, not postgres', replied: true, state: 'done-pending' })
  expect(text).toBe(
    '#3 is done: Pick a db\nThe human replied on #3: Use sqlite, not postgres\nAct on that reply, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.',
  )
})

test('a bare done press on a to-do says the press is a go-ahead for a proposal or a recommendation, and asks to check it', () => {
  expect(doneNotice({ ...item, answer: null, state: 'done-pending' })).toBe(
    '#3 is done: Pick a db\nThe human marked it done. If the item proposed something or carried a recommendation, that is a go-ahead for it. ' +
      'Check that it is finished, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.',
  )
})

test('a labelled to-do\'s press notice says what the human pressed, on its own line after the title', () => {
  const labelled = { ...item, doneLabel: 'Go with sqlite', answer: 'Go with sqlite', state: 'done-pending' as const }
  expect(doneNotice(labelled)).toBe(
    '#3 is done: Pick a db\nThe human pressed "Go with sqlite" on #3. Act on that, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.',
  )
})

test('a labelled to-do\'s press carries its label through the window and into the sent item', () => {
  const waiting = press({ items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4 }, 3, 1000, 'Go with sqlite')
  expect(waiting.items[0]).toMatchObject({ state: 'done-waiting', answer: 'Go with sqlite', replied: false })
  expect(expire(waiting, 3, 1000).sent).toMatchObject({ state: 'done-pending', answer: 'Go with sqlite' })
})

test('a reply on a labelled to-do is still a reply: its text is sent, and the label is not', () => {
  const labelled: Store = { items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4 }
  const sent = expire(reply(labelled, 3, 1000, 'Use postgres instead'), 3, 1000).sent
  expect(sent).toMatchObject({ state: 'done-pending', answer: 'Use postgres instead', replied: true })
  expect(doneNotice(sent as Item)).toBe(
    '#3 is done: Pick a db\nThe human replied on #3: Use postgres instead\nAct on that reply, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.',
  )
})

test('a reply of no to a yes or no is still a reply: its notice names no answer', () => {
  const text = doneNotice({ ...item, yesno: true, answer: 'no', replied: true, state: 'done-pending' })
  expect(text).toContain('The human replied on #3: no\n')
  expect(text).not.toContain('answered')
})

test('a line break of any kind in a reply is drawn as a space, carriage returns and the Unicode separators too', () => {
  expect(reply(store, 3, 1000, 'a\rb\u2028c\u2029d\r\ne').items[0]?.answer).toBe('a b c d e')
})

test('an answer press on a running window changes nothing: only the undo press, with no answer, cancels it', () => {
  const waiting = press(store, 3, 1000, 'Use postgres')
  expect(press(waiting, 3, 2000, 'Use sqlite')).toEqual(waiting)
  expect(press(waiting, 3, 2000, null).items[0]).toMatchObject({ state: 'open', answer: null })
})

const applied = (s: Store, raw: Record<string, unknown>): Store => {
  const parsed = parseInput(raw)
  if (!parsed.ok) throw new Error(parsed.reason)
  const out = act(s, parsed.value, { agent: null, now: 0 })
  if ('deny' in out) throw new Error(out.deny)
  return out.store
}
const labelled: Store = { items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4 }

test('a label changed inside the undo window still sends the label that was pressed', () => {
  const relabelled = applied(press(labelled, 3, 1000, 'Go with sqlite'), { action: 'update', id: 3, done: 'Use postgres' })
  expect(relabelled.items[0]).toMatchObject({ state: 'done-waiting', doneLabel: 'Use postgres', answer: 'Go with sqlite' })
  const sent = expire(relabelled, 3, 1000).sent
  expect(sent && doneNotice(sent)).toBe(
    '#3 is done: Pick a db\nThe human pressed "Go with sqlite" on #3. Act on that, then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.',
  )
})

test('undo of a labelled press clears its answer and reopens the item', () => {
  const undone = press(press(labelled, 3, 1000, 'Go with sqlite'), 3, 2000, null)
  expect(undone.items[0]).toMatchObject({ state: 'open', answer: null, pressedAt: null, replied: false })
})

test('a note that reopens a sent labelled press clears its answer and keeps the label', () => {
  const sent = expire(press(labelled, 3, 1000, 'Go with sqlite'), 3, 1000).store
  expect(sent.items[0]).toMatchObject({ state: 'done-pending', answer: 'Go with sqlite' })
  const reopened = applied(sent, { action: 'update', id: 3, note: 'still open' })
  expect(reopened.items[0]).toMatchObject({ state: 'open', answer: null, replied: false, doneLabel: 'Go with sqlite', note: 'still open' })
})
