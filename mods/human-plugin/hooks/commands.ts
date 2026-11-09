import type { Item, TodoItem, Turn } from '../types'
import { cutLine, cutText, formsOf, humanTurn, isNumbered, labelOf, orderedOptions, replyText, turnsOf, type AnswerOutcome, type Form } from './done'
import { LINE_BREAK } from './items'
import { bandOrder } from './layout'
import { GLYPH, HEADING, countsText, etaTail, inDisplayOrder } from './todo'

// The bounds the answers keep, in UTF-16 units. `cap` is the most `/asks <n>` prints, the cut line included; `floor` is the least its cut newest
// turn keeps, as printed, one unit less when a surrogate pair straddles the cut; `title` and `label` cut those fields in `/asks <n>`;
// `listLine` cuts a list line's title and its answer, and the answer an answer form echoes; `listItems` is how many items the list names before the
// rest fold into a line of numbers; `foot` is the most the foot of `/asks <n>` prints, which its fixed wording keeps it to. The foot is never cut.
export const LIMITS = { cap: 4000, floor: 1000, title: 300, label: 200, listLine: 80, listItems: 20, foot: 500 } as const
// The phone block (phoneBlock) names at most PHONE_ITEMS open items, each title cut to PHONE_TITLE UTF-16 units, its ellipsis counted.
export const PHONE_ITEMS = 10
export const PHONE_TITLE = 60

export const COMMAND = 'asks'
// The answer forms `/asks <n> <form>` takes, as the wording names them: the description, the usage and the phone block name them alike.
const FORMS = 'done, yes, no, <option number>, or reply <text>'
export const DESCRIPTION = `Print the to-do list, or one item by number; answer an item with /asks <n> ${FORMS}.`
// The argument as the command's registration shows it: the number, then the form.
export const ARG_HINT = '[n [done | yes | no | option | reply text]]'

// Every line the command prints starts with this indent. It also keeps an item's text from reading as a marker to the rebuild: replay.ts reads
// `#<n> is done:` only at the start of a line.
const INDENT = '  '
export const USAGE = `${INDENT}Usage: /asks, or /asks <n> for one item.\n${INDENT}Answer an item: /asks <n> ${FORMS}.`
export const REBUILDING = `${INDENT}The list is still being rebuilt from the transcript; run /asks again in a moment.`
export const FAILED = `${INDENT}/asks failed: the error was logged.`
export const CLAUDE_COMMAND = 'claude-todo'
export const CLAUDE_DESCRIPTION = 'Print the Claude TODO list: the steps the agent is on and those queued after them.'
export const CLAUDE_USAGE = `${INDENT}Usage: /${CLAUDE_COMMAND} takes no argument.`
export const CLAUDE_REBUILDING = `${INDENT}The list is still being rebuilt from the transcript; run /${CLAUDE_COMMAND} again in a moment.`
export const CLAUDE_FAILED = `${INDENT}/${CLAUDE_COMMAND} failed: the error was logged.`
const CLAUDE_EMPTY = `${INDENT}The ${HEADING} list is empty.`
const NOTHING = `${INDENT}Nothing is on the list.`
const NO_SUCH = `${INDENT}There is no such item.`
const CUT = `${INDENT}The rest was cut.`
const CUT_LINE = `\n${CUT}`
// The phone block is unseen context a prompt from the phone carries: the person cannot see the list there. Every line of it is indented, as the
// list's own lines are, so that no line reads back as a marker in the rebuild (replay.ts).
const ON_PHONE = 'The user is on their phone and cannot see the list.'
const indented = (lines: readonly string[]): string => lines.map(line => `${INDENT}${line}`).join('\n')
export const PHONE_REBUILDING = indented([ON_PHONE, `The list is still being rebuilt from the transcript; /${COMMAND} lists it once the rebuild is done.`])

// The open items in the band's order, which `/asks` and the phone block both take.
const openOf = (items: readonly Item[]): Item[] => items.filter(it => it.state === 'open').sort(bandOrder)

// The block for the agent: the open items on one line, `#<n> <title>` each, in the band's order. The first PHONE_ITEMS are named, each title on
// that line and cut to PHONE_TITLE, and the count of the rest follows. The agent ends its reply with that line, which names items by their
// numbers, so the restatement check passes it. Null when no item is open.
export const phoneBlock = (items: readonly Item[]): string | null => {
  const open = openOf(items)
  if (open.length === 0) return null
  const named = open.slice(0, PHONE_ITEMS).map(it => `#${it.id} ${cutLine(it.title, PHONE_TITLE)}`).join(', ')
  const more = open.length - PHONE_ITEMS
  const line = more > 0 ? `${named}, and ${more} more ${more === 1 ? 'is' : 'are'} open` : named
  return indented([
    ON_PHONE,
    `/${COMMAND} lists the items, and /${COMMAND} <n> <form> answers one, the form being ${FORMS}.`,
    'End this reply with the line below, which lists the open items:',
    line,
  ])
}

// An argument without the ASCII spaces and tabs around it: the blanks both commands read an argument by.
const trimmed = (args: string): string => args.replace(/^[ \t]+|[ \t]+$/g, '')

// Whether the argument holds anything: `/claude-todo` takes none.
export const hasArgument = (args: string): boolean => trimmed(args) !== ''

// The Claude TODO list as `/claude-todo` prints it: a line that counts it, then the in-flight entries and the queued ones, each group in written
// order under a heading of its own, an entry as its state's glyph, its title cut to the list's width and its ETA whole. At most LIMITS.listItems entries are
// named, in-flight first, and a last line counts what is left out of each group that lost any. The entry lines are indented twice, so no line
// of the print starts short of the indent.
export const claudeTodoText = (items: readonly TodoItem[]): string => {
  if (items.length === 0) return CLAUDE_EMPTY
  const named = inDisplayOrder(items).slice(0, LIMITS.listItems)
  const lines = [`${INDENT}${HEADING}: ${countsText(items)}`]
  const left: string[] = []
  for (const [state, heading] of [['in_flight', 'in flight'], ['queued', 'queued']] as const) {
    const group = named.filter(it => it.state === state)
    if (group.length > 0) lines.push(`${INDENT}${heading}:`, ...group.map(it => `${INDENT}${INDENT}${GLYPH[state]} ${cutLine(it.title, LIMITS.listLine)}${etaTail(it)}`))
    const more = items.filter(it => it.state === state).length - group.length
    if (more > 0) left.push(`${more} more ${heading}`)
  }
  if (left.length > 0) lines.push(`${INDENT}and ${left.join(', ')}`)
  return lines.join('\n')
}

// What the argument asks for: the list (blank), one item by its number, an answer to an item by its number and a form, or nothing the command knows
// (the usage). Blanks are the ASCII spaces and tabs around the argument and between the number and the form. A number is ASCII digits, read as a
// decimal: its leading zeros do not count, and it is kept as digits, which an id is compared with as text, so a number of any length is no problem.
export type ListAsk = { kind: 'list' } | { kind: 'item'; digits: string }
export type Ask = { kind: 'usage' } | ListAsk | { kind: 'answer'; digits: string; form: Form }

export const parseAsk = (args: string): Ask => {
  const text = trimmed(args)
  if (text === '') return { kind: 'list' }
  const blank = text.search(/[ \t]/)
  const number = blank === -1 ? text : text.slice(0, blank)
  if (!/^[0-9]+$/.test(number)) return { kind: 'usage' }
  const digits = number.replace(/^0+(?=[0-9])/, '')
  if (blank === -1) return { kind: 'item', digits }
  const form = parseForm(text.slice(blank).replace(/^[ \t]+/, ''))
  return form === null ? { kind: 'usage' } : { kind: 'answer', digits, form }
}

// The form the rest of an argument names, or null when it names none the command takes: done, yes or no alone, an option's number alone, or reply
// and the text after its blanks. The words match in any case; the text is trimmed as the pane trims its field, and blank text is no form.
const parseForm = (rest: string): Form | null => {
  const lower = rest.toLowerCase()
  if (lower === 'done') return { kind: 'done' }
  if (lower === 'yes') return { kind: 'yes' }
  if (lower === 'no') return { kind: 'no' }
  if (/^[0-9]+$/.test(rest)) return { kind: 'option', n: Number(rest) }
  const reply = /^reply[ \t]+/i.exec(rest)
  const text = reply === null ? null : replyText(rest.slice(reply[0].length))
  return text === null ? null : { kind: 'reply', text }
}

// The answer to an ask on the list, and the item it shows (null when it shows none): the command clears that item's unread mark.
export const answerTo = (items: readonly Item[], ask: ListAsk): { text: string; shown: number | null } => {
  if (ask.kind === 'list') return { text: answerList(items), shown: null }
  const item = items.find(it => isNumbered(it, ask.digits))
  return item === undefined ? { text: NO_SUCH, shown: null } : { text: answerItem(item), shown: item.id }
}

// The line an answer form prints: the confirmation of an applied one, with the answer it gave cut to one line as a list line's answer is; else
// what refused it. A refused form names the forms the item takes, its foot.
export const answerLine = (outcome: AnswerOutcome): string => {
  switch (outcome.kind) {
    case 'applied':
      return `${INDENT}answered #${outcome.item.id} with ${cutLine(outcome.answer, LIMITS.listLine)}`
    case 'missing':
      return NO_SUCH
    case 'sent':
      return `${INDENT}#${outcome.item.id} is already sent.`
    case 'undoing':
      return `${INDENT}#${outcome.item.id} is not open: its undo window is running.`
    case 'takes':
      return [`${INDENT}#${outcome.item.id} takes these answers:`, ...footOf(outcome.item)].join('\n')
  }
}

// The list: the open items, then the answered ones (state done-waiting or done-pending), each group in the band's order. The first
// LIMITS.listItems are named; the rest fold into one line of their numbers, in id order.
const answerList = (items: readonly Item[]): string => {
  if (items.length === 0) return NOTHING
  const open = openOf(items)
  const answered = items.filter(it => it.state !== 'open').sort(bandOrder)
  const listed = [...open, ...answered]
  const lines = listed.slice(0, LIMITS.listItems).map(listLine)
  const folded = listed.slice(LIMITS.listItems).map(it => it.id).sort((a, b) => a - b)
  if (folded.length > 0) lines.push(`${INDENT}and ${folded.length} more: ${rangesOf(folded)}`)
  return lines.join('\n')
}

// One item's list line: its number, whether it is blocking, and its title on one line, cut to the list's width. An answered item adds its
// answer, the words of its human turn cut the same way, and an item in its undo window is marked as still undoable.
const listLine = (item: Item): string => {
  const head = `${INDENT}#${item.id} ${blockingWord(item)}: ${cutLine(item.title, LIMITS.listLine)}`
  if (item.state === 'open') return head
  const answer = humanTurn(item)
  const undoable = item.state === 'done-waiting' ? ' (still undoable)' : ''
  return `${head} — ${labelOf(answer)}: ${cutLine(answer.words, LIMITS.listLine)}${undoable}`
}

// The numbers, sorted, as the list writes them: a run of consecutive numbers as its range (`21-38`), a number with no neighbour alone (`40`),
// the entries joined by a comma and a space.
const rangesOf = (ids: readonly number[]): string => {
  const runs: [number, number][] = []
  for (const id of ids) {
    const last = runs[runs.length - 1]
    if (last !== undefined && id === last[1] + 1) last[1] = id
    else runs.push([id, id])
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ')
}

// `/asks <n>`: the item's title, its note, its brief, its thread (every turn, oldest first, a sent answer as the newest), a decision's options
// numbered in the pane's order, then the foot. Each part is printed whole unless the cap forces a cut (fit).
const answerItem = (item: Item): string =>
  fit({
    title: `${INDENT}#${item.id} ${blockingWord(item)}: ${cutLine(item.title, LIMITS.title)}`,
    note: item.note === null ? null : sectionOf('note', item.note),
    brief: item.detail.trim() === '' ? null : sectionOf('brief', item.detail),
    turns: turnsOf(item).map(turnOf),
    options: orderedOptions(item).map(
      (option, k) => `${INDENT}${k + 1}. ${cutLine(option.label, LIMITS.label)}${option.recommended ? ' (recommended)' : ''}`,
    ),
    foot: footOf(item),
  })

// The foot: the forms an open item takes, each named as a `/asks <n> <form>` line. A decision's options are one line, their number range. A reply
// names its text as `<text>`: a bare `reply` is the usage. An item in its undo window, or sent, takes no answer, so it prints no foot.
const footOf = (item: Item): string[] =>
  item.state !== 'open'
    ? []
    : formsOf(item).map(kind => `${INDENT}/asks ${item.id} ${kind === 'option' ? numbersOf(item) : kind === 'reply' ? 'reply <text>' : kind}`)

// A decision's option numbers as one range, `1-<k>`, or `1` alone for one option.
const numbersOf = (item: Item): string => (item.options.length === 1 ? '1' : `1-${item.options.length}`)

const blockingWord = (item: Item): string => (item.blocking ? 'blocking' : 'non-blocking')

// A text as printed: each of its lines indented, and a line holding nothing but blanks printed as the indent alone.
const printed = (text: string): string => text.split(LINE_BREAK).map(line => (line.trim() === '' ? INDENT : `${INDENT}${line}`)).join('\n')

// A section: its heading line, and its text printed under it.
type Section = { heading: string; body: string }
const sectionOf = (name: string, text: string): Section => ({ heading: `${INDENT}${name}:`, body: printed(text) })

// A turn as printed: its label on a line of its own, then its words.
const turnOf = (turn: Turn): Section => ({ heading: `${INDENT}${labelOf(turn)}:`, body: printed(turn.words) })

// A section as it prints whole: its body without the blank lines at its end, so no section ends on one (which would read as a gap before the
// next section, or at the end of the answer). The body is '' when no line of words is left.
const wholeOf = ({ heading, body }: Section): Section => {
  const lines = body.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1] === INDENT) end--
  return { heading, body: lines.slice(0, end).join('\n') }
}

// A section's lines as they print: its heading, and its body when it has one.
const linesOf = ({ heading, body }: Section): string[] => (body === '' ? [heading] : [heading, body])

// The parts of a whole answer. The title, the options and the foot are never cut; the rest gives way to the cap in fit's order.
type Parts = { title: string; note: Section | null; brief: Section | null; turns: Section[]; options: string[]; foot: string[] }

// The parts as one text, each section as it prints whole.
const assemble = (p: Parts): string =>
  [
    p.title,
    ...(p.note === null ? [] : linesOf(wholeOf(p.note))),
    ...(p.brief === null ? [] : linesOf(wholeOf(p.brief))),
    ...(p.turns.length === 0 ? [] : [`${INDENT}thread:`, ...p.turns.flatMap(turn => linesOf(wholeOf(turn)))]),
    ...(p.options.length === 0 ? [] : [`${INDENT}options:`, ...p.options]),
    ...p.foot,
  ].join('\n')

// The answer as printed, within LIMITS.cap, with the cut line after it when it must be cut. The cut falls first on the brief's tail, then on the
// oldest turns whole, then on the newest turn's tail down to LIMITS.floor, and last on the note's tail. A section cut to nothing is dropped.
const fit = (parts: Parts): string => {
  const whole = assemble(parts)
  if (whole.length <= LIMITS.cap) return whole
  let p = parts
  const excess = (): number => assemble(p).length + CUT_LINE.length - LIMITS.cap
  if (excess() > 0 && p.brief !== null) p = { ...p, brief: shrink(p.brief, excess()) }
  while (excess() > 0 && p.turns.length > 1) p = { ...p, turns: p.turns.slice(1) }
  // The newest turn is cut from its printed text, blank lines included, to what the cap leaves it, and never below the floor.
  const newest = p.turns[p.turns.length - 1]
  if (excess() > 0 && newest !== undefined) {
    const keep = Math.max(LIMITS.floor, linesOf(wholeOf(newest)).join('\n').length - excess())
    if (`${newest.heading}\n${newest.body}`.length > keep) p = { ...p, turns: [...p.turns.slice(0, -1), cutTurn(newest, keep)] }
  }
  if (excess() > 0 && p.note !== null) p = { ...p, note: shrink(p.note, excess()) }
  const room = LIMITS.cap - CUT_LINE.length
  const text = assemble(p)
  return `${text.length > room ? cutPrinted(text, room) : text}${CUT_LINE}`
}

// A section with its body cut `by` units shorter, its heading kept; dropped when no part of the body is left.
const shrink = (section: Section, by: number): Section | null => {
  const whole = wholeOf(section)
  const body = cutPrinted(whole.body, whole.body.length - by)
  return body === '' ? null : { heading: whole.heading, body }
}

// The newest turn cut as printed to `keep` units: its heading kept, and its body cut to what the heading leaves.
const cutTurn = (turn: Section, keep: number): Section => ({ heading: turn.heading, body: cutPrinted(turn.body, keep - turn.heading.length - 1) })

// Printed text cut to at most `max` units, the ellipsis included, with every line still indented. The ellipsis ends the line the cut leaves; a
// line the cut leaves holding only part of its indent gets the rest of it, so no line starts short of its indent. Empty when `max` is under three.
const cutPrinted = (text: string, max: number): string => {
  if (text.length <= max) return text
  let best = ''
  for (let at = max - 1; at >= Math.max(0, max - 3); at--) {
    // cutText keeps `at` units, or one fewer when a pair straddles them, and adds the ellipsis, which is taken off again here.
    const head = cutText(text, at + 1).slice(0, -1)
    const line = head.length - (head.lastIndexOf('\n') + 1)
    const cut = `${head}${line === 0 ? `${INDENT}…` : line === 1 ? ' …' : '…'}`
    if (cut.length <= max && cut.length > best.length) best = cut
  }
  return best
}
