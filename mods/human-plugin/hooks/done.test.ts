import { expect, test } from 'claude-code/testing'
import { answerOf, cutLine, cutText, doneNotice, expire, formsOf, isNumbered, orderedOptions, pointerText, press, reopen, reply, replyText, turnsOf, type Form } from './done'
import { act, parseInput } from './items'
import type { Item, Store, Turn } from '../types'

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
  options: [], answer: null, yesno: false, replied: false, doneLabel: null, thread: [], windowTurns: [], windowChanged: false,
}
const store: Store = { items: [item], next: 4, term: null }
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
    '#3 is done: Pick a db\nThe human replied on #3: Use sqlite, not postgres\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #3; the item is then open for their next reply. Your own follow-up work never stays on the list.',
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
  const waiting = press({ items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4, term: null }, 3, 1000, 'Go with sqlite')
  expect(waiting.items[0]).toMatchObject({ state: 'done-waiting', answer: 'Go with sqlite', replied: false })
  expect(expire(waiting, 3, 1000).sent).toMatchObject({ state: 'done-pending', answer: 'Go with sqlite' })
})

test('a reply on a labelled to-do is still a reply: its text is sent, and the label is not', () => {
  const labelled: Store = { items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4, term: null }
  const sent = expire(reply(labelled, 3, 1000, 'Use postgres instead'), 3, 1000).sent
  expect(sent).toMatchObject({ state: 'done-pending', answer: 'Use postgres instead', replied: true })
  expect(doneNotice(sent as Item)).toBe(
    '#3 is done: Pick a db\nThe human replied on #3: Use postgres instead\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #3; the item is then open for their next reply. Your own follow-up work never stays on the list.',
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
const labelled: Store = { items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4, term: null }

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

test('a change to a sent labelled press reopens it, clears its answer and keeps the label', () => {
  const sent = expire(press(labelled, 3, 1000, 'Go with sqlite'), 3, 1000).store
  expect(sent.items[0]).toMatchObject({ state: 'done-pending', answer: 'Go with sqlite' })
  const reopened = applied(sent, { action: 'update', id: 3, note: 'still open' })
  expect(reopened.items[0]).toMatchObject({ state: 'open', answer: null, replied: false, doneLabel: 'Go with sqlite', note: 'still open' })
})

test('reopen puts a sent item back to open, unread, with its press, answer and reply cleared; any other item is left as it is', () => {
  const replied = expire(reply(store, 3, 1000, 'Use postgres'), 3, 1000).store
  const out = reopen(replied, 3)
  expect(out.reopened).toBe(true)
  expect(out.store.items[0]).toMatchObject({ state: 'open', pressedAt: null, answer: null, replied: false, unread: true })
  const waiting = press(store, 3, 1000, 'Use sqlite')
  expect(reopen(waiting, 3)).toEqual({ store: waiting, reopened: false })
  expect(reopen(store, 3)).toEqual({ store, reopened: false })
  expect(reopen(replied, 9)).toEqual({ store: replied, reopened: false })
})

test('a window running when the agent changes the item still sends what the human gave', () => {
  const changed = applied(reply(store, 3, 1000, 'Use postgres'), { action: 'append', id: 3, text: 'more context' })
  expect(changed.items[0]).toMatchObject({ state: 'done-waiting', pressedAt: 1000 })
  const sent = expire(changed, 3, 1000).sent
  expect(sent && doneNotice(sent)).toContain('The human replied on #3: Use postgres')
})

test('a sent answer reads as the human turn of its kind: a reply\'s words, an option, a yes or no, a labelled press\'s label, or the phrase of a bare done', () => {
  const sentWith = (over: Partial<Item>): Item => ({ ...item, state: 'done-pending', ...over })
  expect(turnsOf(sentWith({ answer: 'Use sqlite, not postgres', replied: true }))).toEqual([{ speaker: 'human', words: 'Use sqlite, not postgres' }])
  expect(turnsOf(sentWith({ answer: 'Use postgres' }))).toEqual([{ speaker: 'human', words: 'Use postgres' }])
  expect(turnsOf(sentWith({ yesno: true, answer: 'no' }))).toEqual([{ speaker: 'human', words: 'no' }])
  expect(turnsOf(sentWith({ doneLabel: 'Go with sqlite', answer: 'Go with sqlite' }))).toEqual([{ speaker: 'human', words: 'Go with sqlite' }])
  expect(turnsOf(sentWith({ answer: null }))).toEqual([{ speaker: 'human', words: 'pressed done' }])
})

test('an answer in its undo window is the newest human turn while the window runs, a bare press\'s included; an item with no press has none', () => {
  expect(turnsOf(item)).toEqual([])
  expect(turnsOf(press(store, 3, 1000, 'Use postgres').items[0] as Item)).toEqual([{ speaker: 'human', words: 'Use postgres' }])
  expect(turnsOf(press(store, 3, 1000, null).items[0] as Item)).toEqual([{ speaker: 'human', words: 'pressed done' }])
})

test('while a reply\'s window runs, its turns read as the thread, then the reply, then the agent turns the window took', () => {
  const agentTurn = { speaker: 'agent' as const, words: 'The sqlite file is in data/.' }
  const earlier = { speaker: 'human' as const, words: 'Use postgres' }
  const waiting = { ...item, state: 'done-waiting' as const, pressedAt: 1000, answer: 'Use sqlite', replied: true, thread: [earlier], windowTurns: [agentTurn] }
  expect(turnsOf(waiting)).toEqual([earlier, { speaker: 'human', words: 'Use sqlite' }, agentTurn])
})

test('reopen archives the sent answer as the thread\'s human turn before it clears the answer: the item is open and unread', () => {
  const sent = expire(reply(store, 3, 1000, 'Use postgres'), 3, 1000).store
  expect(reopen(sent, 3).store.items[0]).toMatchObject({
    state: 'open', answer: null, replied: false, unread: true, thread: [{ speaker: 'human', words: 'Use postgres' }],
  })
})

test('the words of each kind of answer stay on the item after a reopen: an option, a yes or no, a labelled press and a bare done', () => {
  const decision: Item = { ...item, options: [{ label: 'Use postgres', description: '', recommended: false }, { label: 'Use sqlite', description: '', recommended: false }] }
  const cases: [Store, string | null, string][] = [
    [{ items: [decision], next: 4, term: null }, 'Use postgres', 'Use postgres'],
    [{ items: [{ ...item, yesno: true }], next: 4, term: null }, 'no', 'no'],
    [{ items: [{ ...item, doneLabel: 'Go with sqlite' }], next: 4, term: null }, 'Go with sqlite', 'Go with sqlite'],
    [store, null, 'pressed done'],
  ]
  for (const [before, answer, words] of cases) {
    const sent = expire(press(before, 3, 1000, answer), 3, 1000).store
    expect(reopen(sent, 3).store.items[0]?.thread).toEqual([{ speaker: 'human', words }])
  }
})

test('an undo press on a window the agent added a turn to folds that turn into the brief, as an append would add it: with no human turn in the thread, the thread gains nothing', () => {
  const agentTurn = { speaker: 'agent' as const, words: 'The sqlite file is in data/.' }
  const waiting: Store = { items: [{ ...item, state: 'done-waiting', pressedAt: 1000, answer: 'Use sqlite', replied: true, windowTurns: [agentTurn] }], next: 4, term: null }
  expect(press(waiting, 3, 2000, null).items[0]).toMatchObject({
    state: 'open', answer: null, replied: false, detail: 'postgres or sqlite\n\nThe sqlite file is in data/.', thread: [], windowTurns: [],
  })
})

test('after an undo the item has no human turn, so the window\'s turn and the next append both grow the brief, in order', () => {
  const waiting = applied(press(store, 3, 1000, 'Use sqlite'), { action: 'append', id: 3, text: 'It needs a file.' })
  const grown = applied(press(waiting, 3, 2000, null), { action: 'append', id: 3, text: 'Two files.' })
  expect(grown.items[0]).toMatchObject({ state: 'open', detail: 'postgres or sqlite\n\nIt needs a file.\n\nTwo files.', thread: [] })
})

test('an undo into an empty brief sets it to the window\'s turn alone, as an append onto an empty brief does', () => {
  const blank: Store = { items: [{ ...item, detail: '' }], next: 4, term: null }
  const waiting = applied(press(blank, 3, 1000, 'Use sqlite'), { action: 'append', id: 3, text: 'It needs a file.' })
  expect(press(waiting, 3, 2000, null).items[0]).toMatchObject({ detail: 'It needs a file.', thread: [] })
})

test('an undo gives the window\'s turns to the brief while the thread holds no human turn, and to the thread after its last turn once it holds one', () => {
  const agentTurn = { speaker: 'agent' as const, words: 'The sqlite file is in data/.' }
  const earlier = { speaker: 'human' as const, words: 'Use postgres' }
  const windowed = (thread: Turn[]): Store => ({ items: [{ ...item, thread, state: 'done-waiting', pressedAt: 1000, answer: 'Use sqlite', replied: true, windowTurns: [agentTurn] }], next: 4, term: null })
  expect(press(windowed([]), 3, 2000, null).items[0]).toMatchObject({ detail: 'postgres or sqlite\n\nThe sqlite file is in data/.', thread: [] })
  expect(press(windowed([earlier]), 3, 2000, null).items[0]).toMatchObject({ detail: 'postgres or sqlite', thread: [earlier, agentTurn] })
})

test('a window the agent added a turn to ends by sending the reply and reopening the item: the reply first, the agent\'s turn after, and the notice carries the reply', () => {
  const agentTurn = { speaker: 'agent' as const, words: 'The sqlite file is in data/.' }
  const waiting: Store = { items: [{ ...item, state: 'done-waiting', pressedAt: 1000, answer: 'Use sqlite', replied: true, windowTurns: [agentTurn] }], next: 4, term: null }
  const out = expire(waiting, 3, 1000)
  expect(out.sent).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
  expect(out.store.items[0]).toMatchObject({ state: 'open', unread: true, answer: null, replied: false, windowTurns: [] })
  expect(turnsOf(out.store.items[0] as Item)).toEqual([{ speaker: 'human', words: 'Use sqlite' }, agentTurn])
  expect(doneNotice(out.sent as Item)).toContain('The human replied on #3: Use sqlite')
})

test('cutText keeps a text within the bound as it is, and otherwise ends it in an ellipsis that is counted within the bound', () => {
  expect(cutText('abc', 3)).toBe('abc')
  expect(cutText('abcd', 3)).toBe('ab…')
  expect(cutText('abcd', 1)).toBe('…')
  expect(cutText('abcd', 0)).toBe('')
})

test('cutText never splits a surrogate pair: a cut that would is one unit shorter', () => {
  const pair = String.fromCodePoint(0x1f600)
  expect(cutText(`${pair}x`, 2)).toBe('…')
  expect(cutText(`a${pair}x`, 3)).toBe('a…')
  expect(cutText(`a${pair}x`, 4)).toBe(`a${pair}x`)
  expect(cutText(`${pair}${pair}x`, 4)).toBe(`${pair}…`)
})

test('cutText keeps the line breaks of a multi-line text, and cutLine cuts the same text to one line with every break as a space', () => {
  expect(cutText('one\ntwo\nthree', 9)).toBe('one\ntwo\n…')
  expect(cutLine('one\ntwo\nthree', 9)).toBe('one two …')
  expect(cutLine(`a\r\nb${String.fromCharCode(0x2028)}c${String.fromCharCode(0x2029)}d`, 20)).toBe('a b c d')
})

test('orderedOptions puts the recommended option first and keeps the rest in their order, and leaves the item\'s options as they are', () => {
  const options = [
    { label: 'A', description: '', recommended: false },
    { label: 'B', description: '', recommended: false },
    { label: 'C', description: '', recommended: true },
    { label: 'D', description: '', recommended: false },
  ]
  expect(orderedOptions({ ...item, options }).map(option => option.label)).toEqual(['C', 'A', 'B', 'D'])
  expect(options.map(option => option.label)).toEqual(['A', 'B', 'C', 'D'])
})

const DECISION = [
  { label: 'Use sqlite', description: '', recommended: false },
  { label: 'Use postgres', description: '', recommended: true },
]
const TOKEN = 5000
// The same list with every item read: an answer clears the unread mark, which a press does not.
const readOf = (s: Store): Store => ({ ...s, items: s.items.map(it => ({ ...it, unread: false })) })

test('an item takes the forms its kind takes, a reply among them: a decision its option numbers, a yes/no yes and no, a to-do done', () => {
  expect(formsOf({ ...item, options: DECISION })).toEqual(['option', 'reply'])
  expect(formsOf({ ...item, yesno: true })).toEqual(['yes', 'no', 'reply'])
  expect(formsOf(item)).toEqual(['done', 'reply'])
  expect(formsOf({ ...item, doneLabel: 'Go with sqlite' })).toEqual(['done', 'reply'])
})

test('an item with options and a yes/no marker takes its options, as the pane draws it', () => {
  expect(formsOf({ ...item, yesno: true, options: DECISION })).toEqual(['option', 'reply'])
})

test('reply text is trimmed as the pane trims it, and text blank after that is no reply', () => {
  expect(replyText('  Use sqlite  ')).toBe('Use sqlite')
  expect(replyText(' Use sqlite ')).toBe('Use sqlite')
  expect(replyText('')).toBe(null)
  expect(replyText(' \t ')).toBe(null)
  expect(replyText(' ')).toBe(null)
})

test('a number names an item when it is the item\'s id as text, so digits with a leading zero name none', () => {
  expect(isNumbered(item, '3')).toBe(true)
  expect(isNumbered(item, '03')).toBe(false)
  expect(isNumbered(item, '30')).toBe(false)
})

test('a form on a number no item has changes nothing and is missing, a number beyond the safe range included', () => {
  expect(answerOf(store, '9', { kind: 'done' }, TOKEN)).toEqual({ store, outcome: { kind: 'missing' } })
  expect(answerOf(store, '12345678901234567890', { kind: 'reply', text: 'x' }, TOKEN)).toEqual({ store, outcome: { kind: 'missing' } })
})

test('a done on a to-do applies its press: its label as it stands at the write, or a bare press without one, and reads the item', () => {
  const labelled: Store = { items: [{ ...item, doneLabel: 'Go with sqlite', unread: true }], next: 4, term: null }
  const answered = answerOf(labelled, '3', { kind: 'done' }, TOKEN)
  expect(answered.outcome).toEqual({ kind: 'applied', item: labelled.items[0], answer: 'Go with sqlite' })
  expect(answered.store).toEqual(readOf(press(labelled, 3, TOKEN, 'Go with sqlite')))
  const bare = answerOf(store, '3', { kind: 'done' }, TOKEN)
  expect(bare.outcome).toEqual({ kind: 'applied', item, answer: 'done' })
  expect(bare.store).toEqual(readOf(press(store, 3, TOKEN, null)))
})

test('a yes and a no on a yes/no apply that answer, as a press of it does', () => {
  const question: Store = { items: [{ ...item, yesno: true, unread: true }], next: 4, term: null }
  const yes = answerOf(question, '3', { kind: 'yes' }, TOKEN)
  expect(yes.outcome).toEqual({ kind: 'applied', item: question.items[0], answer: 'yes' })
  expect(yes.store).toEqual(readOf(press(question, 3, TOKEN, 'yes')))
  const no = answerOf(question, '3', { kind: 'no' }, TOKEN)
  expect(no.outcome).toEqual({ kind: 'applied', item: question.items[0], answer: 'no' })
  expect(no.store).toEqual(readOf(press(question, 3, TOKEN, 'no')))
})

test('an option number applies the option at that number in the pane\'s order, the recommended one first', () => {
  const decision: Store = { items: [{ ...item, options: DECISION }], next: 4, term: null }
  const first = answerOf(decision, '3', { kind: 'option', n: 1 }, TOKEN)
  expect(first.outcome).toEqual({ kind: 'applied', item: decision.items[0], answer: 'Use postgres' })
  expect(first.store).toEqual(readOf(press(decision, 3, TOKEN, 'Use postgres')))
  expect(answerOf(decision, '3', { kind: 'option', n: 2 }, TOKEN).outcome).toMatchObject({ kind: 'applied', answer: 'Use sqlite' })
})

test('a reply on an open item applies as a reply does: one line, marked as a reply, and the item is read', () => {
  const unread: Store = { items: [{ ...item, unread: true }], next: 4, term: null }
  const out = answerOf(unread, '3', { kind: 'reply', text: 'Use sqlite\nnot postgres' }, TOKEN)
  expect(out.outcome).toEqual({ kind: 'applied', item: unread.items[0], answer: 'Use sqlite\nnot postgres' })
  expect(out.store).toEqual(readOf(reply(unread, 3, TOKEN, 'Use sqlite\nnot postgres')))
  expect(out.store.items[0]).toMatchObject({ state: 'done-waiting', pressedAt: TOKEN, answer: 'Use sqlite not postgres', replied: true, unread: false })
})

test('an item in its undo window or sent takes no form: whatever the form, it changes nothing and the outcome names the state', () => {
  const waiting = press(store, 3, 1000, 'Use sqlite')
  const sent = expire(press(store, 3, 1000, null), 3, 1000).store
  const forms: Form[] = [{ kind: 'done' }, { kind: 'yes' }, { kind: 'option', n: 1 }, { kind: 'reply', text: 'x' }]
  for (const form of forms) {
    expect(answerOf(waiting, '3', form, TOKEN)).toEqual({ store: waiting, outcome: { kind: 'undoing', item: waiting.items[0] } })
    expect(answerOf(sent, '3', form, TOKEN)).toEqual({ store: sent, outcome: { kind: 'sent', item: sent.items[0] } })
  }
})

test('a form the item\'s kind does not take changes nothing and is takes: a done on a decision, a yes or a no or an option on a to-do, a done on a yes/no', () => {
  const decision: Store = { items: [{ ...item, options: DECISION }], next: 4, term: null }
  const question: Store = { items: [{ ...item, yesno: true }], next: 4, term: null }
  expect(answerOf(decision, '3', { kind: 'done' }, TOKEN)).toEqual({ store: decision, outcome: { kind: 'takes', item: decision.items[0] } })
  expect(answerOf(store, '3', { kind: 'yes' }, TOKEN)).toEqual({ store, outcome: { kind: 'takes', item } })
  expect(answerOf(store, '3', { kind: 'no' }, TOKEN)).toEqual({ store, outcome: { kind: 'takes', item } })
  expect(answerOf(store, '3', { kind: 'option', n: 1 }, TOKEN)).toEqual({ store, outcome: { kind: 'takes', item } })
  expect(answerOf(question, '3', { kind: 'done' }, TOKEN)).toEqual({ store: question, outcome: { kind: 'takes', item: question.items[0] } })
})

test('an option number out of the decision\'s range is takes: zero, one past the last, and a number beyond every safe integer', () => {
  const decision: Store = { items: [{ ...item, options: DECISION }], next: 4, term: null }
  for (const n of [0, 3, Number('9'.repeat(400))]) {
    expect(answerOf(decision, '3', { kind: 'option', n }, TOKEN)).toEqual({ store: decision, outcome: { kind: 'takes', item: decision.items[0] } })
  }
})

test('a refused form leaves an unread item unread, and a number no item has leaves the list as it is', () => {
  const unread: Store = { items: [{ ...item, unread: true }], next: 4, term: null }
  expect(answerOf(unread, '3', { kind: 'yes' }, TOKEN).store).toEqual(unread)
  expect(answerOf(unread, '9', { kind: 'done' }, TOKEN).store).toEqual(unread)
})
