import { expect, test } from 'claude-code/testing'
import {
  ARG_HINT, CLAUDE_COMMAND, CLAUDE_DESCRIPTION, CLAUDE_FAILED, CLAUDE_REBUILDING, CLAUDE_USAGE, DESCRIPTION, LIMITS, PHONE_ITEMS, PHONE_REBUILDING,
  PHONE_TITLE, USAGE, answerLine, answerTo, claudeTodoText, hasArgument, parseAsk, phoneBlock,
} from './commands'
import { TOOL } from './items'
import { replay, rowsOf, type Source } from './replay'
import { GLYPH } from './todo'
import type { Item, TodoItem, Turn } from '../types'

// The `/asks` answers, parsed and worded. The expectations are the layouts the plan gives, so a change to a line shows here.
const base: Item = {
  id: 0, title: '', detail: '', blocking: false, createdAt: 0, state: 'open', pressedAt: null, note: null, agent: null, unread: false,
  options: [], answer: null, yesno: false, replied: false, doneLabel: null, thread: [], windowTurns: [], windowChanged: false,
}
const made = (id: number, extra: Partial<Item> = {}): Item => ({ ...base, id, title: `Item ${id}`, ...extra })
const numbered = (ids: number[], state: Item['state'] = 'open'): Item[] => ids.map(id => made(id, { state }))
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k)
const list = (items: Item[]): string => answerTo(items, { kind: 'list' }).text
const whole = (items: Item[], digits: string): string => answerTo(items, { kind: 'item', digits }).text
const lineList = (text: string): string[] => text.split('\n')
const lastLine = (text: string): string => {
  const all = lineList(text)
  return all[all.length - 1] ?? ''
}
// The first line that starts with `start`, or '' when none does.
const lineStarting = (text: string, start: string): string => lineList(text).find(line => line.startsWith(start)) ?? ''
// The foot of a printed answer: its `/asks <n> <form>` lines, joined.
const footText = (text: string): string => lineList(text).filter(line => line.startsWith('  /asks ')).join('\n')
// The printed body of a section, from `heading` (its heading line, with its newline) to the next section's heading or the foot.
const bodyOf = (text: string, heading: string): string => {
  const rest = text.slice(text.indexOf(heading) + heading.length)
  const end = rest.search(/\n {2}(brief|thread|options):|\n {2}\/asks /)
  return end === -1 ? rest : rest.slice(0, end)
}
const pair = String.fromCodePoint(0x1f600)

// Whether a surrogate stands alone: a high one not followed by its low half, or a low one not after its high half.
const lone = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

test('a blank argument, trimmed of spaces and tabs, is the list', () => {
  expect(parseAsk('')).toEqual({ kind: 'list' })
  expect(parseAsk(' \t ')).toEqual({ kind: 'list' })
})

test('a number is read as a decimal: trimmed of blanks, its leading zeros dropped, and of any length', () => {
  expect(parseAsk(' 3 ')).toEqual({ kind: 'item', digits: '3' })
  expect(parseAsk('007')).toEqual({ kind: 'item', digits: '7' })
  expect(parseAsk('0000000000000007')).toEqual({ kind: 'item', digits: '7' })
  expect(parseAsk('0')).toEqual({ kind: 'item', digits: '0' })
  expect(parseAsk('12345678901234567890')).toEqual({ kind: 'item', digits: '12345678901234567890' })
})

test('anything else is the usage: a decimal, a sign, a letter, a second word, a number in another script', () => {
  for (const text of ['3.5', '-1', 'x', '3 x', '3 frobnicate', '#3', String.fromCharCode(0xff13)]) {
    expect(parseAsk(text)).toEqual({ kind: 'usage' })
  }
})

test('a form follows the number: done, yes or no alone, an option number alone, or reply and its text; its words match in any case', () => {
  expect(parseAsk('3 done')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'done' } })
  expect(parseAsk(' 3 DONE ')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'done' } })
  expect(parseAsk('03\tYes')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'yes' } })
  expect(parseAsk('3  No')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'no' } })
  expect(parseAsk('3 2')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'option', n: 2 } })
  expect(parseAsk('3 Reply  text ')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'reply', text: 'text' } })
  expect(parseAsk('12345678901234567890 done')).toEqual({ kind: 'answer', digits: '12345678901234567890', form: { kind: 'done' } })
  expect(parseAsk('0007 2')).toEqual({ kind: 'answer', digits: '7', form: { kind: 'option', n: 2 } })
})

test('an option number is ASCII digits read as a decimal, its leading zeros dropped; a sign, a point, a letter or another script is the usage', () => {
  expect(parseAsk('3 007')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'option', n: 7 } })
  expect(parseAsk('3 0')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'option', n: 0 } })
  expect(parseAsk('3 0000000000000000000012')).toEqual({ kind: 'answer', digits: '3', form: { kind: 'option', n: 12 } })
  for (const text of ['3 -1', '3 +1', '3 1.0', '3 1e2', '3 0x1', `3 ${String.fromCharCode(0x661)}`]) {
    expect(parseAsk(text)).toEqual({ kind: 'usage' })
  }
})

test('a reply\'s text is trimmed as the pane trims its field, U+00A0 included, and keeps its inner blanks; blank text is the usage', () => {
  const nbsp = String.fromCharCode(0xa0)
  expect(parseAsk(`3 reply ${nbsp}a  b${nbsp}`)).toEqual({ kind: 'answer', digits: '3', form: { kind: 'reply', text: 'a  b' } })
  for (const text of ['3 reply', '3 REPLY', `3 reply ${nbsp}`, `3 reply \t${nbsp} `, '3 replytext', '3 reply\nx']) {
    expect(parseAsk(text)).toEqual({ kind: 'usage' })
  }
})

test('text after done, yes or no, after an option number, or a second word after the number is the usage', () => {
  for (const text of ['3 done x', '3 Yes now', '3 no.', '3 1 x', '3 done done', '3 x reply y', '3 1 reply x']) {
    expect(parseAsk(text)).toEqual({ kind: 'usage' })
  }
})

test('an id no item has answers that there is no such item, and echoes no number', () => {
  for (const digits of ['3', '0', '12345678901234567890']) {
    expect(answerTo([made(1)], { kind: 'item', digits })).toEqual({ text: '  There is no such item.', shown: null })
  }
})

test('an empty list answers that nothing is on it', () => {
  expect(answerTo([], { kind: 'list' })).toEqual({ text: '  Nothing is on the list.', shown: null })
})

test('the list gives the open items first, a reopened one among them, then the answered ones; within each group blocking first, then by id', () => {
  const items = [
    made(4, { state: 'done-pending', answer: 'Use postgres' }),
    made(2, { blocking: true, state: 'done-waiting', answer: 'Use sqlite' }),
    made(5, { thread: [{ speaker: 'human', words: 'Old reply' }] }),
    made(1),
    made(3, { blocking: true }),
  ]
  expect(lineList(list(items))).toEqual([
    '  #3 blocking: Item 3',
    '  #1 non-blocking: Item 1',
    '  #5 non-blocking: Item 5',
    '  #2 blocking: Item 2 — you: Use sqlite (still undoable)',
    '  #4 non-blocking: Item 4 — you: Use postgres',
  ])
})

test('an answered line shows the words of its human turn: the option, yes or no, a to-do label, a reply, or pressed done for a bare press', () => {
  const items = [
    made(1, { state: 'done-pending', answer: 'Use sqlite' }),
    made(2, { state: 'done-pending', answer: 'yes' }),
    made(3, { state: 'done-pending', answer: 'Go with sqlite' }),
    made(4, { state: 'done-pending', answer: 'Use postgres please', replied: true }),
    made(5, { state: 'done-pending' }),
  ]
  expect(lineList(list(items))).toEqual([
    '  #1 non-blocking: Item 1 — you: Use sqlite',
    '  #2 non-blocking: Item 2 — you: yes',
    '  #3 non-blocking: Item 3 — you: Go with sqlite',
    '  #4 non-blocking: Item 4 — you: Use postgres please',
    '  #5 non-blocking: Item 5 — you: pressed done',
  ])
})

test('an item in its undo window is marked still undoable; a sent one is not', () => {
  expect(list([made(1, { state: 'done-waiting', answer: 'yes' })])).toBe('  #1 non-blocking: Item 1 — you: yes (still undoable)')
  expect(list([made(2, { state: 'done-pending', answer: 'yes' })])).toBe('  #2 non-blocking: Item 2 — you: yes')
})

test('an answered line cuts its answer to 80 characters, ellipsis included, and a line break in it reads as a space', () => {
  expect(list([made(1, { state: 'done-pending', answer: 'a'.repeat(100) })])).toBe(`  #1 non-blocking: Item 1 — you: ${'a'.repeat(79)}…`)
  expect(list([made(2, { state: 'done-pending', answer: 'a'.repeat(80) })])).toBe(`  #2 non-blocking: Item 2 — you: ${'a'.repeat(80)}`)
  expect(list([made(3, { state: 'done-pending', answer: 'one\ntwo' })])).toBe('  #3 non-blocking: Item 3 — you: one two')
})

test('a list line cuts its title to 80 characters, ellipsis included, and every kind of line break in it reads as a space', () => {
  expect(list([made(1, { title: 'x'.repeat(80) })])).toBe(`  #1 non-blocking: ${'x'.repeat(80)}`)
  expect(list([made(2, { title: 'x'.repeat(81) })])).toBe(`  #2 non-blocking: ${'x'.repeat(79)}…`)
  expect(list([made(3, { title: `a\r\nb${String.fromCharCode(0x2028)}c` })])).toBe('  #3 non-blocking: a b c')
})

test('the list names twenty items and folds the rest into one line of their numbers, as ranges', () => {
  const text = list(numbered(range(1, 30)))
  expect(lineList(text)).toHaveLength(21)
  expect(lastLine(text)).toBe('  and 10 more: 21-30')
})

test('a fold writes a number with no neighbour alone, and a run of two as a range', () => {
  expect(lastLine(list(numbered([...range(1, 38), 40])))).toBe('  and 19 more: 21-38, 40')
  expect(lastLine(list(numbered([...range(1, 20), 39, 40])))).toBe('  and 2 more: 39-40')
})

test('folded numbers that run in no sequence are each their own entry, in id order', () => {
  const odd = range(1, 40).filter(id => id % 2 === 1)
  const even = range(1, 40).filter(id => id % 2 === 0)
  const text = list([...numbered(odd), ...numbered(even, 'done-pending')])
  expect(lineList(text)).toHaveLength(21)
  expect(lastLine(text)).toBe(`  and 20 more: ${even.join(', ')}`)
})

test('a list of a thousand items, the folded numbers none in sequence, stays under 7,000 characters', () => {
  const folded = Array.from({ length: 980 }, (_, k) => made(21 + 2 * k, { state: 'done-pending' }))
  const text = list([...numbered(range(1, 20)), ...folded])
  expect(lastLine(text)).toMatch(/^ {2}and 980 more: 21, 23, 25, .*, 1977, 1979$/)
  expect(text.length).toBeLessThan(7000)
})

test('an item prints its title line, then its brief under a heading, every line indented two spaces', () => {
  expect(answerTo([made(3, { title: 'Pick a db', blocking: true, detail: 'postgres or sqlite' })], { kind: 'item', digits: '3' })).toEqual({
    text: '  #3 blocking: Pick a db\n  brief:\n  postgres or sqlite\n  /asks 3 done\n  /asks 3 reply <text>',
    shown: 3,
  })
})

test('a note prints under its own heading, before the brief; an empty or blank brief prints no section', () => {
  expect(whole([made(3, { detail: 'postgres or sqlite', note: 'Check the backup first.' })], '3')).toBe(
    '  #3 non-blocking: Item 3\n  note:\n  Check the backup first.\n  brief:\n  postgres or sqlite\n  /asks 3 done\n  /asks 3 reply <text>',
  )
  expect(whole([made(4, { note: 'Only a note.' })], '4')).toBe('  #4 non-blocking: Item 4\n  note:\n  Only a note.\n  /asks 4 done\n  /asks 4 reply <text>')
  expect(whole([made(5, { detail: '   ' })], '5')).toBe('  #5 non-blocking: Item 5\n  /asks 5 done\n  /asks 5 reply <text>')
})

test('a thread prints every turn whole, oldest first, labelled as the pane labels them, the sent answer as the newest', () => {
  const thread: Turn[] = [
    { speaker: 'agent', words: 'Which store?' },
    { speaker: 'human', words: 'Use postgres' },
    { speaker: 'agent', words: 'Noted.' },
    { speaker: 'human', words: 'Also backups' },
    { speaker: 'agent', words: 'Added.' },
  ]
  expect(whole([made(3, { state: 'done-pending', answer: 'Use sqlite', thread })], '3')).toBe(
    [
      '  #3 non-blocking: Item 3',
      '  thread:',
      '  agent:',
      '  Which store?',
      '  you:',
      '  Use postgres',
      '  agent:',
      '  Noted.',
      '  you:',
      '  Also backups',
      '  agent:',
      '  Added.',
      '  you:',
      '  Use sqlite',
    ].join('\n'),
  )
})

test('an undo window\'s agent turns follow the answer, which is then not the newest turn', () => {
  const windowed = made(4, { state: 'done-waiting', answer: 'Use sqlite', windowTurns: [{ speaker: 'agent', words: 'Sqlite is fine.' }] })
  expect(whole([windowed], '4')).toBe('  #4 non-blocking: Item 4\n  thread:\n  you:\n  Use sqlite\n  agent:\n  Sqlite is fine.')
})

test('a decision prints its options numbered, the recommended one first with its label then (recommended), and no description', () => {
  const options = [
    { label: 'Use sqlite', description: 'A local file', recommended: false },
    { label: 'Use postgres', description: 'A server', recommended: true },
  ]
  const text = whole([made(3, { detail: 'postgres or sqlite', options })], '3')
  expect(text).toBe(
    '  #3 non-blocking: Item 3\n  brief:\n  postgres or sqlite\n  options:\n  1. Use postgres (recommended)\n  2. Use sqlite\n  /asks 3 1-2\n  /asks 3 reply <text>',
  )
  expect(text).not.toContain('A server')
})

test('an open item\'s foot names its forms: done and reply for a to-do, with or without a done label; yes, no and reply for a yes/no; the options as one range', () => {
  const option = (label: string) => ({ label, description: '', recommended: false })
  expect(whole([made(3)], '3')).toBe('  #3 non-blocking: Item 3\n  /asks 3 done\n  /asks 3 reply <text>')
  expect(whole([made(3, { doneLabel: 'Ship it' })], '3')).toBe('  #3 non-blocking: Item 3\n  /asks 3 done\n  /asks 3 reply <text>')
  expect(whole([made(4, { yesno: true })], '4')).toBe('  #4 non-blocking: Item 4\n  /asks 4 yes\n  /asks 4 no\n  /asks 4 reply <text>')
  expect(whole([made(5, { options: [option('A'), option('B'), option('C')] })], '5')).toBe(
    '  #5 non-blocking: Item 5\n  options:\n  1. A\n  2. B\n  3. C\n  /asks 5 1-3\n  /asks 5 reply <text>',
  )
  expect(whole([made(6, { options: [option('A')] })], '6')).toBe('  #6 non-blocking: Item 6\n  options:\n  1. A\n  /asks 6 1\n  /asks 6 reply <text>')
})

test('an item in its undo window or sent prints no foot', () => {
  expect(whole([made(3, { state: 'done-waiting', answer: 'yes', yesno: true })], '3')).toBe('  #3 non-blocking: Item 3\n  thread:\n  you:\n  yes')
  expect(whole([made(4, { state: 'done-pending', answer: 'yes', yesno: true })], '4')).toBe('  #4 non-blocking: Item 4\n  thread:\n  you:\n  yes')
})

test('the foot of an item numbered with 16 digits names those digits, and is at most the foot bound for every kind of item', () => {
  const id = 1234567890123456
  const four = [1, 2, 3, 4].map(k => ({ label: `Option ${k}`, description: '', recommended: false }))
  for (const item of [made(id), made(id, { yesno: true }), made(id, { options: four })]) {
    const foot = footText(whole([item], String(id)))
    expect(foot.startsWith(`  /asks ${id} `)).toBe(true)
    expect(foot.length).toBeLessThanOrEqual(LIMITS.foot)
  }
})

test('an answer with its foot that fits the cap prints uncut, and an answer over it keeps the foot whole before the cut notice', () => {
  // Beside the brief's text, the title, the brief's heading and the foot come to 75 units.
  const fits = whole([made(3, { detail: 'x'.repeat(3900) })], '3')
  expect(fits).not.toContain('The rest was cut.')
  expect(fits.endsWith('\n  /asks 3 done\n  /asks 3 reply <text>')).toBe(true)
  // At 3,933 the answer is 4,008 units with its foot: the brief gives way by 28, and the foot stays.
  const over = whole([made(3, { detail: 'x'.repeat(3933) })], '3')
  expect(over.length).toBeLessThanOrEqual(LIMITS.cap)
  expect(over.endsWith('\n  /asks 3 done\n  /asks 3 reply <text>\n  The rest was cut.')).toBe(true)
})

test('the answer to a form the item does not take lists the forms its foot lists, each line indented', () => {
  const option = (label: string) => ({ label, description: '', recommended: false })
  const decision = made(5, { options: [option('A'), option('B'), option('C')] })
  expect(answerLine({ kind: 'takes', item: decision })).toBe('  #5 takes these answers:\n  /asks 5 1-3\n  /asks 5 reply <text>')
  expect(answerLine({ kind: 'takes', item: made(6, { yesno: true }) })).toBe('  #6 takes these answers:\n  /asks 6 yes\n  /asks 6 no\n  /asks 6 reply <text>')
  expect(answerLine({ kind: 'takes', item: made(7) })).toBe('  #7 takes these answers:\n  /asks 7 done\n  /asks 7 reply <text>')
  expect(answerLine({ kind: 'takes', item: decision }).split('\n').slice(1).join('\n')).toBe(footText(whole([decision], '5')))
  for (const line of lineList(answerLine({ kind: 'takes', item: decision }))) expect(line.startsWith('  ')).toBe(true)
})

test('an applied answer names the answer given, on one line, and an answer of 200 characters is echoed cut to 80, ellipsis included', () => {
  const item = made(5, { options: [{ label: 'A', description: '', recommended: false }] })
  expect(answerLine({ kind: 'applied', item, answer: 'Use postgres' })).toBe('  answered #5 with Use postgres')
  expect(answerLine({ kind: 'applied', item, answer: 'a'.repeat(80) })).toBe(`  answered #5 with ${'a'.repeat(80)}`)
  expect(answerLine({ kind: 'applied', item, answer: 'a'.repeat(200) })).toBe(`  answered #5 with ${'a'.repeat(79)}…`)
  expect(answerLine({ kind: 'applied', item, answer: 'one\ntwo' })).toBe('  answered #5 with one two')
})

test('a refused state answers that the item is sent, or not open with its undo window running; a missing item answers there is no such item', () => {
  expect(answerLine({ kind: 'sent', item: made(5, { state: 'done-pending' }) })).toBe('  #5 is already sent.')
  expect(answerLine({ kind: 'undoing', item: made(5, { state: 'done-waiting' }) })).toBe('  #5 is not open: its undo window is running.')
  expect(answerLine({ kind: 'missing' })).toBe('  There is no such item.')
})

test('the usage, the description and the argument hint name the answer forms, and every line of the usage is indented', () => {
  for (const word of ['done', 'yes', 'no', 'option', 'reply']) {
    expect(USAGE).toContain(word)
    expect(DESCRIPTION).toContain(word)
    expect(ARG_HINT).toContain(word)
  }
  for (const line of lineList(USAGE)) expect(line.startsWith('  ')).toBe(true)
})

test('a title of 300 characters prints whole, and a longer one is cut to 300 with its ellipsis', () => {
  expect(lineList(whole([made(3, { title: 't'.repeat(300) })], '3'))[0]).toBe(`  #3 non-blocking: ${'t'.repeat(300)}`)
  expect(lineList(whole([made(3, { title: 't'.repeat(600) })], '3'))[0]).toBe(`  #3 non-blocking: ${'t'.repeat(299)}…`)
})

test('an option label of 200 characters prints whole, and a longer one is cut to 200 with its ellipsis', () => {
  const labelled = (label: string): string => lineStarting(whole([made(3, { options: [{ label, description: '', recommended: false }] })], '3'), '  1. ')
  expect(labelled('L'.repeat(200))).toBe(`  1. ${'L'.repeat(200)}`)
  expect(labelled('L'.repeat(600))).toBe(`  1. ${'L'.repeat(199)}…`)
})

test('a title or option label with line breaks shows on one line, a carriage return and U+2028 included', () => {
  const separator = String.fromCharCode(0x2028)
  const text = whole([made(3, { title: `a\rb${separator}c`, options: [{ label: 'x\ny', description: '', recommended: false }] })], '3')
  expect(lineList(text)[0]).toBe('  #3 non-blocking: a b c')
  expect(lineStarting(text, '  1. ')).toBe('  1. x y')
})

test('every line an answer prints begins with two spaces, and a blank line inside a text is the indent alone', () => {
  const text = whole([made(3, { detail: 'one\n\ntwo', state: 'done-pending', answer: 'Use sqlite', thread: [{ speaker: 'agent', words: 'a\r\n\r\nb' }] })], '3')
  for (const line of lineList(text)) expect(line.startsWith('  ')).toBe(true)
  expect(text).toContain('  one\n  \n  two')
  expect(text).toContain('  agent:\n  a\n  \n  b')
})

test('an answer never ends on a line break: a last turn or a brief ending in one ends on its words', () => {
  expect(whole([made(3, { state: 'done-pending', answer: 'Use sqlite\n\n' })], '3')).toBe('  #3 non-blocking: Item 3\n  thread:\n  you:\n  Use sqlite')
  expect(whole([made(4, { detail: 'postgres\n' })], '4')).toBe('  #4 non-blocking: Item 4\n  brief:\n  postgres\n  /asks 4 done\n  /asks 4 reply <text>')
})

test('a section whose words end in a line break is followed by the next section with no blank line between them', () => {
  expect(whole([made(3, { note: 'Check it.\n', detail: 'postgres' })], '3')).toBe(
    '  #3 non-blocking: Item 3\n  note:\n  Check it.\n  brief:\n  postgres\n  /asks 3 done\n  /asks 3 reply <text>',
  )
  const thread = [{ speaker: 'agent' as const, words: 'Done.\n\n' }]
  expect(whole([made(4, { state: 'done-pending', answer: 'Use sqlite\n', thread })], '4')).toBe(
    '  #4 non-blocking: Item 4\n  thread:\n  agent:\n  Done.\n  you:\n  Use sqlite',
  )
  const options = [{ label: 'Use postgres', description: '', recommended: false }]
  expect(whole([made(5, { detail: 'postgres\n', options })], '5')).toBe(
    '  #5 non-blocking: Item 5\n  brief:\n  postgres\n  options:\n  1. Use postgres\n  /asks 5 1\n  /asks 5 reply <text>',
  )
})

test('a brief of 10,000 characters prints at most 4,000 and says the rest was cut', () => {
  const text = whole([made(3, { detail: 'b'.repeat(10000) })], '3')
  expect(text.length).toBeLessThanOrEqual(LIMITS.cap)
  expect(text.length).toBeGreaterThan(LIMITS.cap - 3)
  expect(text.endsWith('\n  The rest was cut.')).toBe(true)
  expect(text.startsWith('  #3 non-blocking: Item 3\n  brief:\n  bbb')).toBe(true)
})

test('with the brief and the thread over the cap, the brief\'s tail goes first and the oldest and newest turns stay whole', () => {
  const thread: Turn[] = [{ speaker: 'agent', words: 'o'.repeat(300) }]
  const text = whole([made(3, { detail: 'b'.repeat(3500), state: 'done-pending', answer: 'n'.repeat(300), thread })], '3')
  expect(text.length).toBeLessThanOrEqual(LIMITS.cap)
  expect(text).toContain(`  agent:\n  ${'o'.repeat(300)}`)
  expect(text).toContain(`  you:\n  ${'n'.repeat(300)}`)
  expect(text).not.toContain('b'.repeat(3500))
  expect(text).toContain('…')
})

test('a brief smaller than the excess goes whole, then the oldest turn, and the newest turn stays whole', () => {
  const thread: Turn[] = [{ speaker: 'agent', words: 'o'.repeat(3000) }]
  const text = whole([made(3, { detail: 'short brief', state: 'done-pending', answer: 'n'.repeat(1500), thread })], '3')
  expect(text).not.toContain('short brief')
  expect(text).not.toContain('o'.repeat(10))
  expect(text).toContain(`  you:\n  ${'n'.repeat(1500)}`)
  expect(text.endsWith('\n  The rest was cut.')).toBe(true)
})

test('a brief cut to six units keeps every line indented: its ellipsis ends the first line, and no line keeps only part of its indent', () => {
  // The answer with its foot is 4,001 units, 21 over the cap, so the brief (27 units: "  a", "  bcdef" and the x's) is cut by 21, to six. Every cut to six
  // that lands on the second line comes to seven units, so the brief keeps its first line alone.
  const brief = `a\nbcdef\n${'x'.repeat(13)}`
  const text = whole([made(3, { blocking: true, title: 'T', note: 'n'.repeat(3899), detail: brief })], '3')
  expect(text).toBe(`  #3 blocking: T\n  note:\n  ${'n'.repeat(3899)}\n  brief:\n  a…\n  /asks 3 done\n  /asks 3 reply <text>\n  The rest was cut.`)
  for (const line of lineList(text)) expect(line.startsWith('  ')).toBe(true)
})

test('a 300-character note prints whole even with a 10,000-character brief', () => {
  const text = whole([made(3, { detail: 'b'.repeat(10000), note: 'n'.repeat(300) })], '3')
  expect(text).toContain(`  note:\n  ${'n'.repeat(300)}\n  brief:\n  `)
  expect(text.length).toBeLessThanOrEqual(LIMITS.cap)
  expect(text.endsWith('\n  The rest was cut.')).toBe(true)
})

test('a 5,000-character note, four options and a 5,000-character newest turn print at most 4,000, the newest turn at least 1,000 as printed, and the note cut at its end', () => {
  const options = [1, 2, 3, 4].map(k => ({ label: `Option ${k}`, description: '', recommended: false }))
  const text = whole([made(3, { note: 'n'.repeat(5000), options, state: 'done-pending', answer: 'a'.repeat(5000) })], '3')
  expect(text.length).toBeLessThanOrEqual(LIMITS.cap)
  for (const k of [1, 2, 3, 4]) expect(text).toContain(`\n  ${k}. Option ${k}`)
  const newest = text.slice(text.indexOf('  you:\n'), text.indexOf('\n  options:'))
  expect(newest.length).toBeGreaterThanOrEqual(LIMITS.floor)
  expect(text).not.toContain('n'.repeat(5000))
  expect(text).toContain('n…\n  thread:')
  expect(text.endsWith('\n  The rest was cut.')).toBe(true)
})

test('the worst case, a 600-character title, four 600-character labels, a 5,000-character note, a 10,000-character brief and a newest turn of line breaks, prints the plan\'s bounds', () => {
  const options = [1, 2, 3, 4].map(() => ({ label: 'L'.repeat(600), description: '', recommended: false }))
  const text = whole(
    [made(3, { title: 't'.repeat(600), note: 'n'.repeat(5000), detail: 'b'.repeat(10000), options, state: 'done-pending', answer: '\n'.repeat(5000) })],
    '3',
  )
  expect(text.length).toBeLessThanOrEqual(LIMITS.cap)
  for (const k of [1, 2, 3, 4]) expect(text).toContain(`\n  ${k}. `)
  const newest = text.slice(text.indexOf('  you:\n'), text.indexOf('\n  options:'))
  expect(newest.length).toBeGreaterThanOrEqual(LIMITS.floor)
  const note = text.slice(text.indexOf('  note:\n') + '  note:\n'.length, text.indexOf('\n  thread:'))
  expect(note.length).toBeGreaterThanOrEqual(1690)
  for (const line of lineList(text)) expect(line.startsWith('  ')).toBe(true)
})

test('the worst case of an open decision, with its foot, keeps the foot whole before the cut notice, and leaves the note at least 1,190 units', () => {
  const options = [1, 2, 3, 4].map(() => ({ label: 'L'.repeat(600), description: '', recommended: false }))
  const text = whole(
    [made(3, { title: 't'.repeat(600), note: 'n'.repeat(5000), detail: 'b'.repeat(10000), options, thread: [{ speaker: 'human', words: '\n'.repeat(5000) }] })],
    '3',
  )
  expect(text.length).toBeLessThanOrEqual(LIMITS.cap)
  expect(text.endsWith('\n  /asks 3 1-4\n  /asks 3 reply <text>\n  The rest was cut.')).toBe(true)
  expect(footText(text).length).toBeLessThanOrEqual(LIMITS.foot)
  expect(bodyOf(text, '  note:\n').length).toBeGreaterThanOrEqual(1190)
  for (const line of lineList(text)) expect(line.startsWith('  ')).toBe(true)
})

test('the cut notice is one line of at most 40 characters, and each section heading one line of at most 15', () => {
  const options = [{ label: 'A', description: '', recommended: false }]
  const text = whole([made(3, { detail: 'b'.repeat(10000), note: 'n'.repeat(300), options, state: 'done-pending', answer: 'a'.repeat(3000) })], '3')
  expect(lastLine(text).length).toBeLessThanOrEqual(40)
  const headings = lineList(text).filter(line => /^ {2}(note|brief|thread|options):$/.test(line))
  expect(headings).toEqual(['  note:', '  brief:', '  thread:', '  options:'])
  for (const heading of headings) expect(heading.length).toBeLessThanOrEqual(15)
})

test('an answer within 4,000 characters prints uncut, with no cut notice, and a title cut to 300 shows its ellipsis without one', () => {
  const text = whole([made(3, { title: 't'.repeat(600), detail: 'short' })], '3')
  expect(text).not.toContain('The rest was cut.')
  expect(lineList(text)[0]).toBe(`  #3 non-blocking: ${'t'.repeat(299)}…`)
})

test('no cut splits a surrogate pair: titles of emoji cut at 80 and at 300, a label cut at 200, and each stays within its bound', () => {
  const inList = list([made(1, { title: pair.repeat(60) })])
  expect(inList.slice('  #1 non-blocking: '.length)).toBe(`${pair.repeat(39)}…`)
  const inItem = lineList(whole([made(2, { title: pair.repeat(200) })], '2'))[0]
  expect(inItem).toBe(`  #2 non-blocking: ${pair.repeat(149)}…`)
  const label = lineStarting(whole([made(3, { options: [{ label: pair.repeat(150), description: '', recommended: false }] })], '3'), '  1. ')
  expect(label).toBe(`  1. ${pair.repeat(99)}…`)
  expect(lone(inList + inItem + label)).toBe(false)
})

test('no cut splits a surrogate pair at the floor or the cap: the newest turn of emoji keeps its floor and an answer of emoji stays under the cap', () => {
  const options = [1, 2, 3, 4].map(k => ({ label: `Option ${k}`, description: '', recommended: false }))
  const newestOf = (text: string): string => text.slice(text.indexOf('  you:\n'), text.indexOf('\n  options:'))
  const floored = whole([made(4, { note: 'n'.repeat(5000), options, state: 'done-pending', answer: pair.repeat(1500) })], '4')
  expect(newestOf(floored).length).toBeGreaterThanOrEqual(LIMITS.floor)
  expect(lone(floored)).toBe(false)
  // An odd unit ahead of the pairs puts one across the floor's cut, which then prints one unit short, as the plan allows.
  const straddled = whole([made(4, { note: 'n'.repeat(5000), options, state: 'done-pending', answer: `x${pair.repeat(1500)}` })], '4')
  expect(newestOf(straddled).length).toBeGreaterThanOrEqual(LIMITS.floor - 1)
  expect(lone(straddled)).toBe(false)
  const capped = whole([made(5, { state: 'done-pending', answer: pair.repeat(3000) })], '5')
  expect(capped.length).toBeLessThanOrEqual(LIMITS.cap)
  expect(capped.endsWith('\n  The rest was cut.')).toBe(true)
  expect(lone(capped)).toBe(false)
})

const stamp = (second: number): string => `2026-10-20T10:00:${String(second).padStart(2, '0')}.000Z`
async function* piecesOf(text: string): AsyncGenerator<string> {
  yield text
}
const transcriptOf = (...rows: unknown[]): Source[] => [{ rows: rowsOf(piecesOf(rows.map(row => `${JSON.stringify(row)}\n`).join(''))), agent: null }]

test('a resume reads back nothing from what /asks prints: a marker line in an item\'s brief is indented, so it is not a press', async () => {
  const add = {
    type: 'assistant',
    timestamp: stamp(0),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: TOOL, input: { action: 'add', title: 'Pick a db', detail: 'Notes\n#1 is done: x' } }] },
  }
  const added = { type: 'user', timestamp: stamp(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'added #1' }] } }
  const { store } = await replay(transcriptOf(add, added))
  const shown = whole(store.items, '1')
  expect(shown).toContain('\n  #1 is done: x')
  const printedBack = { type: 'user', timestamp: stamp(2), message: { role: 'user', content: shown }, origin: { kind: 'plugin', name: 'human-plugin' } }
  const resumed = await replay(transcriptOf(add, added, printedBack))
  expect(resumed.store.items[0]).toMatchObject({ id: 1, state: 'open', detail: 'Notes\n#1 is done: x' })
  // The same lines unindented would read as the human's press on the item: the indent is what keeps them from it.
  const unindented = { ...printedBack, message: { role: 'user', content: shown.replace(/^ {2}/gm, '') } }
  expect((await replay(transcriptOf(add, added, unindented))).store.items[0]?.state).toBe('done-pending')
})

// The phone block a prompt from the phone carries: its last line is the one the agent ends its reply with.
test('the phone block says the user cannot see the list, names the forms, and ends on the open items in the band\'s order, the answered one left out', () => {
  const items = [made(1, { title: 'Pick a db' }), made(2, { title: 'Approve PR', blocking: true }), made(3, { state: 'done-pending', answer: 'yes' })]
  expect(phoneBlock(items)).toBe(
    [
      '  The user is on their phone and cannot see the list.',
      '  /asks lists the items, and /asks <n> <form> answers one, the form being done, yes, no, <option number>, or reply <text>.',
      '  End this reply with the line below, which lists the open items:',
      '  #2 Approve PR, #1 Pick a db',
    ].join('\n'),
  )
})

test('thirty open items of 200-character titles: the block names ten, each title cut to 60 units with its ellipsis, and says twenty more are open', () => {
  expect([PHONE_ITEMS, PHONE_TITLE]).toEqual([10, 60])
  const items = Array.from({ length: 30 }, (_, k) => made(k + 1, { title: 'x'.repeat(200) }))
  const line = lastLine(phoneBlock(items) ?? '')
  expect(line.endsWith(', and 20 more are open')).toBe(true)
  const named = line.slice('  '.length).replace(/, and 20 more are open$/, '').split(', ')
  expect(named).toHaveLength(PHONE_ITEMS)
  named.forEach((entry, k) => {
    expect(entry.slice(entry.indexOf(' ') + 1).length).toBeLessThanOrEqual(PHONE_TITLE)
    expect(entry).toBe(`#${k + 1} ${'x'.repeat(PHONE_TITLE - 1)}…`)
  })
})

test('every line of the block begins with two spaces, and a title with line breaks is named on one line', () => {
  const separator = String.fromCharCode(0x2028)
  const text = phoneBlock([made(1, { title: `Pick\r\na db${separator}now\nplease` }), made(2)]) ?? ''
  expect(lineList(text)).toHaveLength(4)
  for (const line of lineList(text)) expect(line.startsWith('  ')).toBe(true)
  expect(lastLine(text)).toBe('  #1 Pick a db now please, #2 Item 2')
})

test('the block names /asks and each answer form, and no plan', () => {
  const text = phoneBlock([made(1)]) ?? ''
  expect(text).toContain('/asks')
  expect(text).toContain('done, yes, no, <option number>, or reply <text>')
  expect(text).not.toMatch(/plan/i)
})

test('no open item, or no item at all, gives no block; an open item gives one', () => {
  expect(phoneBlock([made(1, { state: 'done-pending', answer: 'yes' }), made(2, { state: 'done-waiting', answer: 'no' })])).toBeNull()
  expect(phoneBlock([])).toBeNull()
  expect(phoneBlock([made(3)])).not.toBeNull()
})

test('ten open items are all named, with no count; eleven name ten and say one more is open', () => {
  const ten = Array.from({ length: 10 }, (_, k) => made(k + 1))
  const names = ten.map(it => `#${it.id} Item ${it.id}`).join(', ')
  expect(lastLine(phoneBlock(ten) ?? '')).toBe(`  ${names}`)
  expect(lastLine(phoneBlock([...ten, made(11)]) ?? '')).toBe(`  ${names}, and 1 more is open`)
})

test('the rebuilding block says the user cannot see the list, that the list is still being rebuilt and that /asks lists it, every line indented, and names no item', () => {
  expect(PHONE_REBUILDING).toContain('The user is on their phone and cannot see the list.')
  expect(PHONE_REBUILDING).toContain('still being rebuilt')
  expect(PHONE_REBUILDING).toContain('/asks lists it')
  for (const line of lineList(PHONE_REBUILDING)) expect(line.startsWith('  ')).toBe(true)
  expect(PHONE_REBUILDING).not.toMatch(/#\d/)
})

test('a resume reads back nothing from the phone block: an item titled like a done notice, which the block names, stays open', async () => {
  const add = {
    type: 'assistant',
    timestamp: stamp(0),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: TOOL, input: { action: 'add', title: 'is done: x' } }] },
  }
  const added = { type: 'user', timestamp: stamp(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'added #1' }] } }
  const block = phoneBlock([made(1, { title: 'is done: x' })])
  expect(block).toContain('#1 is done: x')
  // The block as a phone prompt carries it: a hook's context row, which the rebuild reads for done notices.
  const carried = {
    type: 'attachment',
    timestamp: stamp(2),
    attachment: { type: 'hook_additional_context', hookName: 'prompt.submit', hookEvent: 'UserPromptSubmit', content: [block] },
  }
  const without = await replay(transcriptOf(add, added))
  const withBlock = await replay(transcriptOf(add, added, carried))
  expect(withBlock.store).toEqual(without.store)
  expect(withBlock.store.items).toMatchObject([{ id: 1, title: 'is done: x', state: 'open' }])
})

// The `/claude-todo` print: the Claude TODO list as indented text, in-flight items first, bounded as `/asks` is.
const step = (title: string, state: TodoItem['state']): TodoItem => ({ title, state })
const steps = (count: number, state: TodoItem['state'], name = state): TodoItem[] => Array.from({ length: count }, (_, k) => step(`${name} ${k + 1}`, state))
const FLIGHT = GLYPH.in_flight
const QUEUED = GLYPH.queued

test('two in-flight and three queued items print the counting line, then each group under its heading in written order, every line indented', () => {
  const items = [step('q1', 'queued'), step('f1', 'in_flight'), step('q2', 'queued'), step('f2', 'in_flight'), step('q3', 'queued')]
  expect(claudeTodoText(items)).toBe(
    [
      '  Claude TODO: 2 in flight, 3 queued',
      '  in flight:',
      `    ${FLIGHT} f1`,
      `    ${FLIGHT} f2`,
      '  queued:',
      `    ${QUEUED} q1`,
      `    ${QUEUED} q2`,
      `    ${QUEUED} q3`,
    ].join('\n'),
  )
})

test('a group with no items prints no heading', () => {
  expect(claudeTodoText([step('q1', 'queued')])).toBe(['  Claude TODO: 0 in flight, 1 queued', '  queued:', `    ${QUEUED} q1`].join('\n'))
  expect(claudeTodoText([step('f1', 'in_flight')])).toBe(['  Claude TODO: 1 in flight, 0 queued', '  in flight:', `    ${FLIGHT} f1`].join('\n'))
})

test('an empty list prints the one empty line', () => {
  expect(claudeTodoText([])).toBe('  The Claude TODO list is empty.')
})

test('five in flight and twenty queued name the five and fifteen queued, and end on a line counting the five queued left out', () => {
  const text = claudeTodoText([...steps(20, 'queued'), ...steps(5, 'in_flight')])
  const lines = text.split('\n')
  expect(lines[0]).toBe('  Claude TODO: 5 in flight, 20 queued')
  expect(lines.filter(line => line.includes(FLIGHT))).toHaveLength(5)
  expect(lines.filter(line => line.includes(QUEUED))).toHaveLength(15)
  expect(lines[lines.length - 1]).toBe('  and 5 more queued')
  expect(lines[lines.length - 2]).toBe(`    ${QUEUED} queued 15`)
})

test('twenty-five in flight and three queued name twenty in flight, print no queued heading, and count both groups left out', () => {
  const text = claudeTodoText([...steps(25, 'in_flight'), ...steps(3, 'queued')])
  const lines = text.split('\n')
  expect(lines.filter(line => line.includes(FLIGHT))).toHaveLength(20)
  expect(lines.filter(line => line.includes(QUEUED))).toHaveLength(0)
  expect(lines).not.toContain('  queued:')
  expect(lines[lines.length - 1]).toBe('  and 5 more in flight, 3 more queued')
  expect(lines).toHaveLength(1 + 1 + 20 + 1)
})

test('exactly twenty items print whole, with no count line, and twenty-one fold one', () => {
  expect(claudeTodoText([...steps(10, 'in_flight'), ...steps(10, 'queued')]).split('\n')).toHaveLength(1 + 1 + 10 + 1 + 10)
  expect(claudeTodoText([...steps(10, 'in_flight'), ...steps(11, 'queued')]).endsWith('\n  and 1 more queued')).toBe(true)
  expect(claudeTodoText(steps(21, 'in_flight')).endsWith('\n  and 1 more in flight')).toBe(true)
})

test('an item\'s line is its indents, its glyph and a space, then its title; a title of 80 units prints whole, a longer stored one is cut to 80 with its ellipsis', () => {
  const whole = 'x'.repeat(LIMITS.listLine)
  expect(claudeTodoText([step(whole, 'queued')]).split('\n')[2]).toBe(`    ${QUEUED} ${whole}`)
  const cut = claudeTodoText([step('x'.repeat(200), 'in_flight')]).split('\n')[2] ?? ''
  expect(cut).toBe(`    ${FLIGHT} ${'x'.repeat(LIMITS.listLine - 1)}…`)
  expect(cut.slice(`    ${FLIGHT} `.length)).toHaveLength(LIMITS.listLine)
})

test('a stored title with line breaks prints on one line, and a cut never splits a surrogate pair', () => {
  expect(claudeTodoText([step('one\ntwo\r\nthree', 'queued')]).split('\n')).toHaveLength(3)
  const text = claudeTodoText([step(pair.repeat(60), 'queued')])
  expect(lone(text)).toBe(false)
  expect((text.split('\n')[2] ?? '').slice(`    ${QUEUED} `.length).length).toBeLessThanOrEqual(LIMITS.listLine)
})

test('every printed line starts with the two-space indent, whatever the list holds', () => {
  for (const items of [[], steps(30, 'in_flight'), [...steps(5, 'in_flight'), ...steps(30, 'queued')], [step('a\nb', 'queued')]]) {
    for (const line of claudeTodoText(items).split('\n')) expect(line.startsWith('  ')).toBe(true)
  }
})

test('the command takes no argument: a blank one is none, anything else is an argument', () => {
  expect(hasArgument('')).toBe(false)
  expect(hasArgument(' \t ')).toBe(false)
  expect(hasArgument('x')).toBe(true)
  expect(hasArgument(' 1 ')).toBe(true)
})

test('/claude-todo and /asks agree on what a blank argument is: the argument is blank to one exactly when /asks reads it as the list', () => {
  for (const args of ['', ' ', '\t', ' \t ', 'x', ' 1 ', '\u00a0', '\n', ' \n ']) expect(hasArgument(args)).toBe(parseAsk(args).kind !== 'list')
})

test('the usage, rebuilding and failure lines each name /claude-todo, none names /asks, and every line is indented', () => {
  expect(CLAUDE_COMMAND).toBe('claude-todo')
  for (const text of [CLAUDE_USAGE, CLAUDE_REBUILDING, CLAUDE_FAILED]) {
    expect(text).toContain('/claude-todo')
    expect(text).not.toContain('/asks')
    for (const line of text.split('\n')) expect(line.startsWith('  ')).toBe(true)
  }
  expect(CLAUDE_DESCRIPTION).not.toContain('/asks')
})
