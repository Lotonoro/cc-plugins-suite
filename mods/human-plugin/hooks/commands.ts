import type { Item, TodoItem, Turn } from '../types'
import { cutLine, cutText } from './cut'
import { formsOf, humanTurn, isNumbered, labelOf, orderedOptions, replyText, turnsOf, type AnswerOutcome, type Form, type ShownOutcome } from './done'
import { LINE_BREAK } from './items'
import { bandOrder } from './layout'
import { GLYPH, HEADING, countsText, etaTail, inDisplayOrder } from './todo'

// The bounds the answers keep, in UTF-16 units. `cap` is the most `/asks <n>` prints, the cut line included, and the most a walk's question holds;
// `floor` is the least its cut newest turn keeps, as printed, less the bound cutText states where its cut would split a run; `title` and `label` cut
// those fields in `/asks <n>` and in a walk's question; `dialogLabel` is the longest label the walk's dialog shows an item's answer by (the length the
// phone showed whole); `listLine` cuts a list line's title and its answer, and the answer an answer form echoes; `listItems` is how many items the list
// names before the rest fold into a line of numbers; `foot` is the most the foot of `/asks <n>` prints, which its fixed wording keeps it to. The foot is
// never cut.
export const LIMITS = { cap: 4000, floor: 1000, title: 300, label: 200, dialogLabel: 80, listLine: 80, listItems: 20, foot: 500 } as const
// The phone block (phoneBlock) names at most PHONE_ITEMS open items, each title cut to PHONE_TITLE UTF-16 units, its ellipsis counted.
export const PHONE_ITEMS = 10
export const PHONE_TITLE = 60

export const COMMAND = 'asks'
// The sub-word that starts the walk, `/asks answer`, and the pointer to it every place that names it takes from here: the command's own texts, the phone
// block, the push (PUSH_POINTER, whose title is cut to leave room for it) and the walk's end text.
export const WALK_WORD = 'answer'
export const WALK_POINTER = `/${COMMAND} ${WALK_WORD}`
export const PUSH_POINTER = ` · ${WALK_POINTER}`
// The answer forms `/asks <n> <form>` takes, as the wording names them: the description, the usage and the phone block name them alike.
const FORMS = 'done, yes, no, <option number>, or reply <text>'
export const DESCRIPTION = `Print the to-do list, or one item by number; answer an item with /asks <n> ${FORMS}, or every open item in turn with ${WALK_POINTER}.`
// The argument as the command's registration shows it: the number, then the form, or the walk's word.
export const ARG_HINT = `[n [done | yes | no | option | reply text] | ${WALK_WORD}]`

// Every line the command prints starts with this indent. It also keeps an item's text from reading as a marker to the rebuild: replay.ts reads
// `#<n> is done:` only at the start of a line.
const INDENT = '  '
export const USAGE = `${INDENT}Usage: /asks, or /asks <n> for one item.\n${INDENT}Answer an item: /asks <n> ${FORMS}.\n${INDENT}Answer every open item, one at a time: ${WALK_POINTER}.`
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

// The open items in the band's order, which `/asks`, the phone block and the walk all take.
export const openOf = (items: readonly Item[]): Item[] => items.filter(it => it.state === 'open').sort(bandOrder)

// The block for the agent: the open items on one line, `#<n> <title>` each, in the band's order. The first PHONE_ITEMS are named, each title on
// that line and cut to PHONE_TITLE, and the count of the rest follows. The agent ends its reply with that line, which names items by their
// numbers, so the restatement check passes it, and which ends with the walk's pointer, the one thing the person on the phone can type to answer
// them. Null when no item is open.
export const phoneBlock = (items: readonly Item[]): string | null => {
  const open = openOf(items)
  if (open.length === 0) return null
  const named = open.slice(0, PHONE_ITEMS).map(it => `#${it.id} ${cutLine(it.title, PHONE_TITLE)}`).join(', ')
  const more = open.length - PHONE_ITEMS
  const line = more > 0 ? `${named}, and ${more} more ${more === 1 ? 'is' : 'are'} open` : named
  return indented([
    ON_PHONE,
    `/${COMMAND} lists the items, and /${COMMAND} <n> <form> answers one, the form being ${FORMS}; ${WALK_POINTER} asks about them one at a time.`,
    'End this reply with the line below, which lists the open items:',
    `${line}; ${WALK_POINTER} asks them one by one`,
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

// What the argument asks for: the list (blank), one item by its number, an answer to an item by its number and a form, the walk (the word `answer`
// alone, in any case), or nothing the command knows (the usage). Blanks are the ASCII spaces and tabs around the argument and between the number and
// the form. A number is ASCII digits, read as a decimal: its leading zeros do not count, and it is kept as digits, which an id is compared with as
// text, so a number of any length is no problem.
export type ListAsk = { kind: 'list' } | { kind: 'item'; digits: string }
export type Ask = { kind: 'usage' } | ListAsk | { kind: 'answer'; digits: string; form: Form } | { kind: 'walk' }

export const parseAsk = (args: string): Ask => {
  const text = trimmed(args)
  if (text === '') return { kind: 'list' }
  if (text.toLowerCase() === WALK_WORD) return { kind: 'walk' }
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

// The confirmation of an applied answer, before any indent: the answer it gave cut to one line as a list line's answer is. `/asks <n> <form>` prints it,
// and a walk's outcome line is the same words.
const answeredText = (id: number, answer: string): string => `answered #${id} with ${cutLine(answer, LIMITS.listLine)}`

// The line an answer form prints: the confirmation of an applied one; else what refused it. A refused form names the forms the item takes, its foot.
export const answerLine = (outcome: AnswerOutcome): string => {
  switch (outcome.kind) {
    case 'applied':
      return `${INDENT}${answeredText(outcome.item.id, outcome.answer)}`
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
    // cutText keeps `at` units, or fewer by the bound it states, and adds the ellipsis, which is taken off again here.
    const head = cutText(text, at + 1).slice(0, -1)
    const line = head.length - (head.lastIndexOf('\n') + 1)
    const cut = `${head}${line === 0 ? `${INDENT}…` : line === 1 ? ' …' : '…'}`
    if (cut.length <= max && cut.length > best.length) best = cut
  }
  return best
}

// ---- the walk: `/asks answer` ----

// What the command prints when the walk does not start: a walk is asking already, or no item is open.
export const ALREADY_ASKING = `${INDENT}A walk is already asking; answer or close its question first.`
export const NOTHING_OPEN = `${INDENT}Nothing is open to answer.`

// The controls a question offers beside the item's answers, in the order they take the slots that are left, and the label a to-do's one answer takes when
// its own is not shown.
const STOP = 'Stop'
const SKIP = 'Skip'
const CONTROLS = [STOP, SKIP] as const
const DONE = 'Done'
// The dialog takes at most this many labels.
const SLOTS = 4

// Two labels read alike when they differ only in case; a typed text reads like a label when they differ only in case and the blanks around the text.
const keyOf = (text: string): string => text.trim().toLowerCase()
const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// One answer a question offers for its item: the label the dialog shows, the label the item itself gives it (which the numbered fallback hides), and the form
// that writes it.
type Choice = { shown: string; own: string; form: Form }

// The answers the dialog shows for an item, by its kind. A decision shows its options' own labels, whole, in the pane's order, when each fits the dialog and
// no two read alike; else it shows `Option 1` to `Option <k>`, which the numbered list in the question matches. A yes/no shows Yes and No. A to-do shows its
// done label when it fits the dialog and is no control's word; else Done.
const choicesOf = (item: Item): Choice[] => {
  if (item.options.length > 0) {
    const options = orderedOptions(item)
    const own = options.map(option => option.label)
    const whole = own.every(label => label.length <= LIMITS.dialogLabel) && new Set(own.map(label => label.toLowerCase())).size === own.length
    return options.map((option, k): Choice => ({ shown: whole ? option.label : `Option ${k + 1}`, own: option.label, form: { kind: 'option', n: k + 1 } }))
  }
  if (item.yesno) {
    return [
      { shown: 'Yes', own: 'Yes', form: { kind: 'yes' } },
      { shown: 'No', own: 'No', form: { kind: 'no' } },
    ]
  }
  const label = item.doneLabel
  const shown = label !== null && label.length <= LIMITS.dialogLabel && !CONTROLS.some(control => sameLabel(control, label)) ? label : DONE
  return [{ shown, own: shown, form: { kind: 'done' } }]
}

// The controls the question offers: Stop, then Skip, in the slots the item's answers leave of four. A control is left out when it reads like an answer's own
// label (on a numbered decision, the option's own label, not `Option <k>`); the next control then takes its slot.
const controlsOf = (choices: readonly Choice[]): string[] =>
  CONTROLS.filter(control => !choices.some(choice => sameLabel(choice.own, control))).slice(0, SLOTS - choices.length)

// The question's last line, by the item's kind. A to-do whose done label the dialog shows asks by that label.
const closingOf = (item: Item, choices: readonly Choice[]): string => {
  if (item.options.length > 0) return `Which option for #${item.id}?`
  if (item.yesno) return `Yes or no on #${item.id}?`
  const shown = choices[0]?.shown
  return item.doneLabel !== null && shown === item.doneLabel ? `"${shown}" for #${item.id}?` : `Done with #${item.id}?`
}

// The first question's opening: how many items are open, a zero count left out and a lone item in the singular, then what the walk does.
export const walkSummary = (open: readonly Item[]): string[] => {
  const blocking = open.filter(it => it.blocking).length
  const rest = open.length - blocking
  const counts = [...(blocking > 0 ? [`${blocking} blocking`] : []), ...(rest > 0 ? [`${rest} non-blocking`] : [])]
  return [
    `${counts.join(' and ')} ${open.length === 1 ? 'item is' : 'items are'} open.`,
    'They are asked one at a time, blocking first, and each answer is sent as you give it. Stop, or stop typed under Other, or closing the question ends this; what you have not answered stays on the list.',
  ]
}

// The parts of a question's text. The head and the tail are never cut; the body gives way to the cap in fitWalk's order.
type WalkParts = { id: number; head: string[]; note: Section | null; turn: Section | null; brief: Section | null; tail: string[] }

// The parts as one text, each body section as it prints whole, and the cut line after the body when it is cut.
const walkText = (p: WalkParts, isCut: boolean): string =>
  [
    ...p.head,
    ...[p.note, p.turn, p.brief].flatMap(section => (section === null ? [] : linesOf(wholeOf(section)))),
    ...(isCut ? [`The rest was cut; /${COMMAND} ${p.id} prints more of it.`] : []),
    ...p.tail,
  ].join('\n')

// The text within LIMITS.cap, with the cut line before the tail when the body must be cut. The cut falls first on the brief's tail, then on the agent's turn
// down to LIMITS.floor, and last on the note's tail, as `fit`'s cut falls on those; a section cut to nothing is dropped. The head and the tail stay under 2,600
// units whatever the item holds (the title is cut at LIMITS.title, a label and a description at LIMITS.label), so these three steps always reach the cap.
const fitWalk = (parts: WalkParts): string => {
  const whole = walkText(parts, false)
  if (whole.length <= LIMITS.cap) return whole
  let p = parts
  const excess = (): number => walkText(p, true).length - LIMITS.cap
  if (excess() > 0 && p.brief !== null) p = { ...p, brief: shrink(p.brief, excess()) }
  if (excess() > 0 && p.turn !== null) {
    const keep = Math.max(LIMITS.floor, linesOf(wholeOf(p.turn)).join('\n').length - excess())
    if (`${p.turn.heading}\n${p.turn.body}`.length > keep) p = { ...p, turn: cutTurn(p.turn, keep) }
  }
  if (excess() > 0 && p.note !== null) p = { ...p, note: shrink(p.note, excess()) }
  return walkText(p, true)
}

// One question of the walk, as `$.ui.ask` takes it: its header, its text and its labels (the item's answers, then the controls). `lead` opens the head:
// the summary on the first question, the previous item's outcome line on every later one. `k` counts the questions asked so far, this one included, and `n`
// is `k` plus the open items not yet asked about. The body is the note, the agent's newest turn when it is the thread's newest, and the raw brief, each under
// the heading `/asks <n>` gives it. The tail is a decision's numbered options, the line that says what Other takes, and the closing line.
export type Dialog = { header: string; question: string; options: string[] }

export const walkDialog = (item: Item, k: number, n: number, lead: readonly string[]): Dialog => {
  const choices = choicesOf(item)
  const turns = turnsOf(item)
  const newest = turns[turns.length - 1]
  const question = fitWalk({
    id: item.id,
    head: [...lead, `${k} of ${n} — #${item.id} ${blockingWord(item)}: ${cutLine(item.title, LIMITS.title)}`],
    note: item.note === null ? null : sectionOf('note', item.note),
    turn: newest === undefined || newest.speaker !== 'agent' ? null : turnOf(newest),
    brief: item.detail.trim() === '' ? null : sectionOf('brief', item.detail),
    tail: [
      ...orderedOptions(item).map(
        (option, at) =>
          `${at + 1}. ${cutLine(option.label, LIMITS.label)}${option.recommended ? ' (recommended)' : ''}${option.description.trim() === '' ? '' : ` — ${cutLine(option.description, LIMITS.label)}`}`,
      ),
      `Under Other: type a reply, or skip to pass, or stop to end.${item.options.length > 0 ? " An option's number picks it." : ''}`,
      closingOf(item, choices),
    ],
  })
  return { header: `#${item.id}`, question, options: [...choices.map(choice => choice.shown), ...controlsOf(choices)] }
}

// What a dialog's return means for the item it showed: a form to write, a skip, or the end of the walk.
export type Reading = { kind: 'form'; form: Form } | { kind: 'skip' } | { kind: 'stop' }

// The return of the dialog, read against the item as it was shown. The rules apply in this order, and the first that fits decides: an answer's label as
// shown; exactly one answer's label, ignoring case and the blanks around the text (on a numbered decision the option's own label counts too); on a decision,
// digits alone naming one of its options, in the pane's order; a control's word, `stop` or `skip`; blank text, which skips; else a reply, trimmed as the
// pane's field trims it. So an answer's label beats a control's word, and a reply that is exactly a label, a number in range or a control's word cannot be
// sent from the walk.
export const readAnswer = (item: Item, got: string): Reading => {
  const choices = choicesOf(item)
  const exact = choices.find(choice => choice.shown === got)
  if (exact !== undefined) return { kind: 'form', form: exact.form }
  const key = keyOf(got)
  const alike = choices.filter(choice => keyOf(choice.shown) === key || keyOf(choice.own) === key)
  const [only] = alike
  if (only !== undefined && alike.length === 1) return { kind: 'form', form: only.form }
  if (item.options.length > 0 && /^[0-9]+$/.test(key)) {
    const n = Number(key)
    if (n >= 1 && n <= item.options.length) return { kind: 'form', form: { kind: 'option', n } }
  }
  if (key === keyOf(STOP)) return { kind: 'stop' }
  if (key === keyOf(SKIP)) return { kind: 'skip' }
  const text = replyText(got)
  return text === null ? { kind: 'skip' } : { kind: 'form', form: { kind: 'reply', text } }
}

// The line that says what became of an item, as the first line of the next question and, for the last item, in the end text. `item` is the item as it was shown.
export const skippedLine = (item: Item): string => `skipped #${item.id}`

export const outcomeLine = (item: Item, outcome: ShownOutcome): string => {
  switch (outcome.kind) {
    case 'applied':
      return answeredText(outcome.item.id, outcome.answer)
    case 'changed':
      return `#${item.id} changed while it was shown, so nothing was sent; ${WALK_POINTER} asks it again.`
    case 'missing':
      return `#${item.id} left the list while it was shown, so nothing was sent.`
  }
}

// Why the walk ended.
export type Reason =
  | { kind: 'every' }
  | { kind: 'stop' }
  | { kind: 'error' }
  | { kind: 'session' }
  | { kind: 'closed' | 'auto' | 'unconfirmed'; id: number }

const reasonLine = (reason: Reason): string => {
  switch (reason.kind) {
    case 'every':
      return 'It asked about every open item.'
    case 'stop':
      return 'It ended on Stop.'
    case 'closed':
      return `It ended when the question on #${reason.id} was closed, timed out or refused; nothing was sent for it. /${COMMAND} ${reason.id} shows it, and /${COMMAND} ${reason.id} <form> answers it.`
    case 'auto':
      return `It ended when the question auto-continued while you were away; nothing was sent for #${reason.id}.`
    case 'unconfirmed':
      return `It ended because the answer to #${reason.id} could not be confirmed as yours; nothing was sent, and this was logged.`
    case 'error':
      return 'It stopped on an error, which was logged.'
    case 'session':
      return 'It ended with its session; nothing more was asked or sent.'
  }
}

// How many answers the walk sent and how many items are still open, in the singular for a count of one. With nothing left open there is no pointer.
const countLine = (sent: number, open: number): string => {
  const sentWords = sent === 0 ? 'nothing' : `${sent} ${sent === 1 ? 'answer' : 'answers'}`
  const openWords =
    open === 0
      ? 'nothing is left open.'
      : `${open} ${open === 1 ? 'item is' : 'items are'} still open. ${WALK_POINTER} asks about ${open === 1 ? 'it' : 'them'} again.`
  return `The walk sent ${sentWords}; ${openWords}`
}

// The command's output when the walk has ended, each line indented as the command's other prints are: the outcome line no question showed (`pending`, the
// last item's, when it has one), why the walk ended, and the count of what it sent and what is still open.
export const walkEnd = (pending: string | null, reason: Reason, sent: number, open: number): string =>
  [...(pending === null ? [] : [pending]), reasonLine(reason), countLine(sent, open)].map(line => `${INDENT}${line}`).join('\n')
