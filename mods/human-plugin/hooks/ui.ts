import type { ButtonProps, BoxProps, ElementConstructor, InputProps, MarkdownProps, RenderElement, TextProps, UiCopyArgs } from 'claude-code'
import type { Item, Store, TodoItem, Turn } from '../types'
import { labelOf, oneLine, orderedOptions, replyText, turnsOf } from './done'
import { briefParts } from './fences'
import { outcomeOf, parseInput, selectedItem, type ToolInput } from './items'
import {
  bandRows,
  bandWidths,
  claudeRows,
  columnHeight,
  cutToColumns,
  headerLines,
  humanFoldRows,
  rowLayout,
  type Answer,
  type BandWidths,
  type ClaudeRow,
  type Control,
  type ListWidth,
  type RowTexts,
} from './layout'
import { tablesAsLists } from './tables'
import { GLYPH, HEADING, bandCountsText } from './todo'

// The elements the band and the pane are built from, as the surface's table hands them out. The constructors take the
// props with `children`, as JSX would pass them; the mod has no JSX factory in an imported module.
export type Table = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Markdown: ElementConstructor<MarkdownProps>
  // The one-line field, which the terminal and desktop tables have and the mobile table lacks: the pane draws its reply field only where it exists.
  Input?: ElementConstructor<InputProps>
}

// What a press asks for; the handlers are the plugin's own and do the work.
export type Handlers = {
  // A band item's title: opens the pane on the item, or closes the pane when it shows it (`isSelected`).
  pick: (id: number, isSelected: boolean) => void
  // A done press (`answer` null), a labelled to-do's press (`answer`: its label), the press of an option (`answer`: its label), or a yes or no (`answer`: `yes` or `no`).
  done: (id: number, answer: string | null) => void
  // The band's summary row: opens the pane on `id`, the first item the band folds.
  more: (id: number) => void
  // A reply the pane's field sent: `text` is trimmed and not empty. It is sent like a done press with that text as its answer.
  reply: (id: number, text: string) => void
  // A brief's copy button: puts `text`, one fenced block's lines, on the clipboard of the surface pressed on.
  copy: (text: string, surface: UiCopyArgs['surface']) => void
}

// What the band draws with: the rows the surface has, the time now, and the undo window's length. `selected`: the item the pane
// shows, if any. `claude`: the Claude list and the columns the band is laid out in, which the Claude column is drawn from. It also gives the human
// list its width, which its rows are laid out and cut in; without it the band has no width to fit its rows to, and draws each whole, nothing cut.
// `isDocked`: whether this plugin's pane is docked on the band's surface (pane.ts), which narrows the width the two lists need.
export type View = { maxRows: number; now: number; windowMs: number; selected?: number | null; claude?: { items: readonly TodoItem[]; columns: number; isDocked?: boolean } }

const CHECK = { color: 'green' }

// The answers a decision offers, recommended first: one row each, a ▸ in the inline-code colour then the option's label in brackets, which takes that colour and
// bold under the pointer. No description is drawn: the brief above the controls explains the options.
const answers = (t: Table, h: Handlers, item: Item): RenderElement =>
  t.Box({
    flexDirection: 'column',
    children: orderedOptions(item).map((option, i) =>
      t.Box({
        key: `answer-row-${item.id}-${i}`,
        children: [
          t.Box({ flexShrink: 0, children: [t.Text({ color: 'suggestion', children: ['▸'] }), t.Text({ children: [' '] })] }),
          t.Button({
            key: `answer-${item.id}-${i}`,
            plain: true,
            label: `[${option.label}${option.recommended ? ' (recommended)' : ''}]`,
            hover: { color: 'suggestion', bold: true },
            onPress: () => h.done(item.id, option.label),
          }),
        ],
      }),
    ),
  })

// The texts a band row is drawn from. The drawing (doneControl, itemRow) and the row layout (rowTexts, layout.ts) take them from here, so a
// label that changes moves the drawing and the widths the layout measures together.
const SENT = '✓ sent'
const YES = '[✓]'
const NO = '[✗]'
// A decision with options is marked `[…]` after its title: its answers are in the pane alone. A row with its buttons on the line (a to-do's `[✓]`, a yes/no's
// marks) needs no marker, and its title still opens the pane.
const DECISION_MARKER = ' […]'
const undoLabel = (seconds: number): string => `[↶ ${seconds}s]`

// The unread mark and the id before a title. They are whole in every row: the title is cut, never they.
const prefixOf = (item: Item): string => `${item.unread ? '• ' : '  '}#${item.id} `

// The open control as three parts, the answer between the other two being the text the layout cuts: none for a decision, whose answers are in the pane
// alone; a labelled to-do's press sends its label as the answer, what the press means as the agent reads it (done.ts), and the label is the answer here.
const openControl = (item: Item): Control =>
  item.options.length > 0
    ? { before: '', answer: '', after: '' }
    : item.yesno
      ? { before: `${YES} ${NO}`, answer: '', after: '' }
      : item.doneLabel === null
        ? { before: YES, answer: '', after: '' }
        : { before: '[✓ ', answer: item.doneLabel, after: ']' }

// A control as text, its answer cut or whole.
const textOf = (one: Control, answer = one.answer): string => `${one.before}${answer}${one.after}`

// The mark a pressed control opens with. A reply is a check whatever its text, even a yes/no's `no`.
const markOf = (item: Item): string => (!item.replied && item.yesno && item.answer === 'no' ? '✗' : '✓')

// A pressed control in the band as three parts: its mark, the answer's text, and the undo button after a space. A reply is named, not quoted: it can be
// long, so the pane draws it whole (`saying`).
const pressedControl = (item: Item, undo: string): Control => {
  const answer = item.replied || item.answer === null ? '' : item.answer
  return { before: `${markOf(item)} ${item.replied ? 'replied ' : ''}`, answer, after: answer === '' ? undo : ` ${undo}` }
}
const sameSaying = (a: Control, b: Control): boolean => a.before === b.before && a.answer === b.answer

// What a pressed control says before its undo button where its answer is not cut (the pane, and a band with no width): its mark, then the answer's text.
// `inPane`: the pane names a reply's text whole.
const saying = (item: Item, inPane: boolean): string => {
  if (inPane && item.replied) return `${markOf(item)} replied: ${item.answer ?? ''} `
  const { before, answer } = pressedControl(item, '')
  return answer === '' ? before : `${before}${answer} `
}

// The answers a press can carry for the item's kind: a decision's options, a yes/no's two, a labelled to-do's label, or none for a plain to-do.
const answersOf = (item: Item): (string | null)[] => (item.options.length > 0 ? item.options.map(option => option.label) : item.yesno ? ['yes', 'no'] : [item.doneLabel])

// What a pressed control can say in the band: one control for each answer the item's kind carries, the reply's, and the item's own now (an answer its kind no
// longer offers, when the item changed under a running window). A control two of these make is listed once.
const pressedControls = (item: Item, undo: string): Control[] => {
  const all = [...answersOf(item).map(answer => pressedControl({ ...item, answer, replied: false }, undo)), pressedControl({ ...item, replied: true }, undo), pressedControl(item, undo)]
  return all.filter((one, k) => all.findIndex(other => sameSaying(other, one)) === k)
}

// The texts of an item's band row for the row layout, built from the drawing's own: the title on one line, by done.ts's join of line breaks, a decision's marker
// after it, and the undo button at its widest, the first second of a window of `windowMs`, when it counts the whole of it.
export const rowTexts = (item: Item, windowMs: number): RowTexts => {
  const undo = undoLabel(Math.ceil(windowMs / 1000))
  return {
    prefix: prefixOf(item),
    title: oneLine(item.title),
    marker: item.options.length > 0 ? DECISION_MARKER : '',
    open: openControl(item),
    pressed: pressedControls(item, undo),
    squeezed: `✓ ${undo}`,
    sent: SENT,
  }
}

// A yes/no question's two marks, yes then no, each drawn as the done check is.
const marks = (t: Table, h: Handlers, item: Item): RenderElement =>
  t.Box({
    children: [
      t.Button({ key: `yes-${item.id}`, plain: true, label: YES, onPress: () => h.done(item.id, 'yes') }),
      t.Text({ children: [' '] }),
      t.Button({ key: `no-${item.id}`, plain: true, label: NO, onPress: () => h.done(item.id, 'no') }),
    ],
  })

// The states of an item's done control: its press sent and awaiting the agent, its undo window running, or neither (open).
const isSent = (item: Item): boolean => item.state === 'done-pending'
const isPressed = (item: Item): item is Item & { pressedAt: number } => item.state === 'done-waiting' && item.pressedAt !== null

// How a row laid out in its list draws its controls (layout.ts): whether a pressed control is squeezed to its mark and its undo button, and the answer, cut
// and boxed, that the open control and the item's own pressed control hold.
type Fit = { squeezed: boolean; open: Answer; pressed: Answer }

// A pressed control's words before its undo button. Laid out, the answer is its cut text in a box of its width and the mark is alone before it, so the undo button
// follows on one column whatever the answer; otherwise (the pane, a band with no width) the words are one text with the answer whole.
const pressedWords = (t: Table, item: Item, inPane: boolean, fit: Fit | null): RenderElement[] => {
  const style = { ...CHECK, bold: true }
  if (fit === null || inPane) return [t.Text({ ...style, children: [saying(item, inPane)] })]
  if (fit.squeezed) return [t.Text({ ...style, children: [`${markOf(item)} `] })]
  const { before, answer } = pressedControl(item, '')
  if (answer === '') return [t.Text({ ...style, children: [before] })]
  return [t.Text({ ...style, children: [before] }), t.Box({ width: fit.pressed.box, flexShrink: 0, children: [t.Text({ ...style, children: [fit.pressed.text] })] }), t.Text({ children: [' '] })]
}

// The done control: a press on an open item starts the undo window, and the same control cancels it while it runs. A decision
// with options has its answers in the pane only: in the band, answering means opening the item. A yes/no question has its yes and
// no marks in the band too. Null when there is no control.
// A sent item keeps the button its undo window had, inert, so the window's ending moves no other button in the focus ring. The
// labels are drawn plain: the terminal would wrap a non-plain label in brackets of its own, as `[ [✓] ]`, in the pane too. The pane's
// controls sit bare, as the band's do. `fit`: how a row laid out in its list draws them, null for the pane and for a band with no width, which draw every
// answer whole.
const doneControl = (t: Table, h: Handlers, item: Item, view: View, inPane: boolean, fit: Fit | null = null): RenderElement | null => {
  if (isSent(item)) return t.Button({ key: `done-${item.id}`, plain: true, dimColor: true, label: SENT, onPress: () => undefined })
  if (isPressed(item)) {
    const left = Math.max(0, Math.ceil((item.pressedAt + view.windowMs - view.now) / 1000))
    return t.Box({
      children: [
        ...pressedWords(t, item, inPane, fit),
        // The undo button keeps its width beside an answer.
        t.Box({ flexShrink: 0, children: [t.Button({ key: `done-${item.id}`, plain: true, label: undoLabel(left), onPress: () => h.done(item.id, null) })] }),
      ],
    })
  }
  if (item.options.length > 0) return inPane ? answers(t, h, item) : null
  if (item.yesno) return marks(t, h, item)
  return t.Button({ key: `done-${item.id}`, plain: true, label: textOf(openControl(item), fit?.open.text), onPress: () => h.done(item.id, item.doneLabel) })
}

// The one rule for a blank brief: whitespace alone is no brief, in the title, the pane's rows and the pane's draw.
const hasBrief = (item: Item): boolean => item.detail.trim() !== ''

// A band row. `isShown`: whether the pane shows this item, so a press on it closes the pane. `width`: the columns the row is laid out in (layout.ts), null for a
// band with no width. A laid-out row is one line of three cells: its prefix, its title's button in a box that shrinks, its label the title cut to the room, and the
// control's cell, as wide as the row's widest state needs and never shrunk, with the state's control at its start. The titles and the answers are the strings the
// layout cut, drawn bare, so the terminal never wraps them.
const itemRow = (t: Table, h: Handlers, item: Item, view: View, isShown: boolean, width: number | null): RenderElement => {
  const texts = rowTexts(item, view.windowMs)
  const prefix = t.Box({ flexShrink: 0, children: [t.Text({ bold: item.blocking, dimColor: !item.blocking, children: [texts.prefix] })] })
  const title = (label: string): RenderElement => t.Button({ key: `title-${item.id}`, plain: true, label, onPress: () => h.pick(item.id, isShown) })
  if (width === null) {
    const control = doneControl(t, h, item, view, false)
    return t.Box({
      key: `item-${item.id}`,
      children: [prefix, title(`${texts.title}${texts.marker}`), ...(control === null ? [] : [t.Box({ flexShrink: 0, children: [t.Text({ children: [' '] }), control] })])],
    })
  }
  const laid = rowLayout(texts, width)
  // The item's own pressed control is one of those the layout measured (pressedControls lists it).
  const own = laid.pressed[texts.pressed.findIndex(one => sameSaying(one, pressedControl(item, '')))] as Answer
  const control = doneControl(t, h, item, view, false, { squeezed: laid.rung === 3, open: laid.open, pressed: own })
  return t.Box({
    key: `item-${item.id}`,
    children: [
      prefix,
      t.Box({ flexShrink: 1, children: [title(laid.title)] }),
      t.Box({ width: laid.control, flexShrink: 0, children: control === null ? [] : [t.Text({ children: [' '] }), control] }),
    ],
  })
}

// The summary row's text: what the band leaves out. Blocking items that did not fit are named apart from the rest.
const summaryText = (row: { blocking: number; more: number }): string =>
  `${[row.blocking > 0 ? `+${row.blocking} blocking` : '', row.more > 0 ? `+${row.more} more` : ''].filter(part => part !== '').join(' · ')} […]`

// The summary row: a button that opens the pane on the first folded item, its label cut at the list's layout width `width` (null for a band with no width). The
// row is set in a warning box while a blocking item is folded: they are the asks the band could not show.
const summaryRow = (t: Table, h: Handlers, row: { blocking: number; more: number; first: Item }, width: number | null): RenderElement =>
  t.Box({
    backgroundColor: row.blocking > 0 ? 'warning' : undefined,
    children: [
      t.Button({
        key: 'band-more',
        plain: true,
        dimColor: row.blocking === 0,
        label: width === null ? summaryText(row) : cutToColumns(summaryText(row), width),
        onPress: () => h.more(row.first.id),
      }),
    ],
  })

// A call to the mod's own tool, as its transcript row carries it.
export type ToolCall = { input: unknown; output?: unknown; isRunning: boolean; isErrored: boolean }

const doing = (input: ToolInput): string => {
  switch (input.action) {
    case 'add':
      return `adding "${input.title}"`
    case 'update':
      return `updating #${input.id}`
    case 'append':
      return `appending to #${input.id}`
    case 'remove':
      return `removing #${input.id}`
    case 'list':
      return 'listing'
  }
}

const done = (input: ToolInput, reply: string): string => {
  switch (input.action) {
    case 'add':
      return `${outcomeOf(reply)} ${input.title}${input.blocking ? ' (blocking)' : ''}`
    case 'list':
      // One header line per item (`#N blocking, state: title`), so an open item is a line with `open:`; a detail's own lines are not items.
      return `listed ${(reply.match(/^#\d+ (non-)?blocking, open: /gm) ?? []).length} open`
    case 'update':
      return outcomeOf(reply)
    default:
      return reply
  }
}

// The one line a call to the mod's tool draws in the transcript, from its input and its reply. It replaces the engine's row,
// which draws the raw arguments (a brief in full) and names the tool as an MCP server. A line break in a title is drawn as a space.
export const toolLine = (call: ToolCall): string => {
  const reply = typeof call.output === 'string' ? call.output : ''
  const parsed = parseInput(call.input)
  const text = !parsed.ok
    ? parsed.reason
    : call.isErrored
      ? reply || 'failed'
      : call.isRunning
        ? `${doing(parsed.value)}…`
        : done(parsed.value, reply)
  return `human-plugin: ${text}`.replace(/\s+/g, ' ')
}

// The chip names the term the agent states for the human; it says "you" until one is stated, and again once the agent clears it (the term '').
const chipText = (term: string | null): string => (term === null || term === '' ? 'To do for you' : `To do for ${term}`)

// One row of the Claude column: the state's glyph and the title on one line, cut at the column's edge; the queued summary is dim.
const claudeRow = (t: Table, row: ClaudeRow): RenderElement =>
  row.kind === 'item'
    ? t.Text({ wrap: 'truncate-end', children: [`${GLYPH[row.item.state]} ${row.item.title}`] })
    : t.Text({ dimColor: true, wrap: 'truncate-end', children: [`+${row.count} queued`] })

// The columns a list's box keeps empty inside its width: its box less its layout width (layout.ts).
const marginOf = (width: ListWidth): number => width.box - width.layout

// The Claude column: its header with the counts in the short form, then its rows (see claudeRows), each cut at the column's layout width, inside
// the box's padding. `height`: the human list's lines, which the queued rows fill down to.
const claudeColumn = (t: Table, todo: readonly TodoItem[], width: ListWidth, height: number): RenderElement =>
  t.Box({
    flexDirection: 'column',
    width: width.box,
    ...(marginOf(width) > 0 ? { paddingLeft: marginOf(width) } : {}),
    children: [t.Text({ wrap: 'truncate-end', children: [`${HEADING} ${bandCountsText(todo)}`] }), ...claudeRows(todo, height).map(row => claudeRow(t, row))],
  })

// The header's two cells: the chip, the line that asks for the person's attention (filled `warning` while the agent is stuck on an open blocking
// item, `permission` otherwise), and the count after it in plain text: the open items, and the sent ones by their own count.
const headerTexts = (store: Store): { chip: string; count: string } => {
  const pending = store.items.filter(it => it.state === 'done-pending').length
  return { chip: ` ${chipText(store.term)} `, count: ` ${store.items.filter(it => it.state === 'open').length} open${pending > 0 ? `, ${pending} sent` : ''} ` }
}

// The band above the prompt: a header with the count, then the rows that fit. When items are folded, the summary row is the way into
// the pane for them. The pane is also opened by a title, and closed by its own close or a press on the item it shows. On a band wide
// enough, and with a Claude list to show, the Claude column is drawn beside the human list at the band's right edge (layout.ts). The human list's
// rows are laid out and cut in its layout width, each one line, so the fold counts a line a row and the header's lines; the Claude column fills down to the same count.
export const band = (t: Table, h: Handlers, store: Store, view: View): RenderElement => {
  const open = store.items.filter(it => it.state === 'open')
  const todo = view.claude?.items ?? []
  const widths: BandWidths = view.claude === undefined ? { human: null, claude: null } : bandWidths(view.claude.columns, store.items.length, todo, view.claude.isDocked)
  // The columns the human rows are laid out in; null for a band with no width to lay them out in, which draws them whole.
  const fit = widths.human === null ? null : widths.human.layout
  // The column's fixed lines (its header and every in-flight row) can make the band taller than `maxRows` beside the human list.
  const columnLines = widths.human !== null && widths.claude !== null ? columnHeight(todo) : 0
  const { chip, count } = headerTexts(store)
  const top = fit === null ? 1 : headerLines(chip, count, fit)
  const rows = bandRows(store.items, Math.max(0, humanFoldRows(view.maxRows, columnLines) - top))
  const shownId = selectedItem(store.items, view.selected ?? null)?.id
  // The header is a filled chip, the line that asks for the person's attention: `warning` while the agent is stuck on an open blocking
  // item, `permission` otherwise. The count after it is plain text.
  const header = t.Box({
    children: [
      t.Box({ flexShrink: 0, children: [t.Text({ bold: true, color: 'inverseText', backgroundColor: open.some(it => it.blocking) ? 'warning' : 'permission', children: [chip] })] }),
      t.Text({ children: [count] }),
    ],
  })
  const body = rows.map(row => (row.kind === 'item' ? itemRow(t, h, row.item, view, row.item.id === shownId, fit) : summaryRow(t, h, row, fit)))
  if (view.claude === undefined || widths.claude === null) return t.Box({ flexDirection: 'column', children: [header, ...body] })
  // Two boxes at the band's width, the Claude column last: alone it keeps its width and stays at the right edge, with nothing drawn to its left.
  const humanList =
    widths.human === null
      ? []
      : [
          t.Box({
            flexDirection: 'column',
            width: widths.human.box,
            ...(marginOf(widths.human) > 0 ? { paddingRight: marginOf(widths.human) } : {}),
            children: [header, ...body],
          }),
        ]
  return t.Box({
    flexDirection: 'row',
    justifyContent: 'flex-end',
    width: view.claude.columns,
    children: [...humanList, claudeColumn(t, todo, widths.claude, widths.human === null ? 0 : top + rows.length)],
  })
}

// The rows of a text: one a line.
const lines = (text: string): number => text.split('\n').length

// A Markdown text's rows: one a line, and one more for each heading, which the surface sets off with a blank row. Measured live at 100
// columns: a 25-line brief with a `# Brief` heading drew 26 rows. Wrapped lines are not counted (no width here).
const markdownRows = (text: string): number => lines(text) + text.split('\n').filter(line => /^#{1,6}\s/.test(line)).length

// A brief's rows as briefOf draws it: each prose part is Markdown with its tables as lists, and each code block is its lines (code has no
// heading rows) with the row of its copy button under it.
const briefRows = (markdown: string): number =>
  briefParts(markdown).reduce((rows, part) => rows + (part.kind === 'prose' ? markdownRows(tablesAsLists(part.text)) : lines(part.text) + 1), 0)

// The last four turns of a thread are drawn whole, and each older one as one dim line (threadOf).
const WHOLE_TURNS = 4
const isFolded = (turns: Turn[], k: number): boolean => k < turns.length - WHOLE_TURNS

// A whole human turn is its label and words in one text; a whole agent turn is its label row and its words drawn as a brief.
const wholeRows = (turn: Turn): number => (turn.speaker === 'human' ? lines(turn.words) : 1 + briefRows(turn.words))
const threadRows = (turns: Turn[]): number => turns.reduce((rows, turn, k) => rows + (isFolded(turns, k) ? 1 : wholeRows(turn)), 0)

// The controls as doneControl draws them in the pane: one row for each answer an open decision offers, else one row.
const controlRows = (item: Item): number => (item.state === 'open' && item.options.length > 0 ? item.options.length : 1)

// The rows the pane asks for, as it draws them: the header (a row for each line of its title), the note, the brief, the thread, the controls,
// and the reply field's row while the item is open. For text that does not wrap, the request equals the drawn rows: a line that soft-wraps is
// asked as one row, and the pane scrolls. The engine grants what the layout spares, so this is a request.
export const paneRows = (shown: Item | undefined): number => {
  if (shown === undefined) return 1
  const turns = turnsOf(shown)
  return (
    lines(shown.title) +
    (shown.note === null ? 0 : lines(shown.note)) +
    (hasBrief(shown) ? briefRows(shown.detail) : 0) +
    threadRows(turns) +
    controlRows(shown) +
    (shown.state === 'open' ? 1 : 0)
  )
}

// The pane: the shown item alone, its header, its note, its whole detail (markdown, a decision brief is written in it), its thread, and last
// its controls. No other item is drawn, so a removal moves no button under the pointer; the pane moves to the next item when its item is
// removed, and closes when none is left (pane.ts). A tall pane scrolls by the person's keys once it has the keyboard.
export const pane = (t: Table, h: Handlers, store: Store, view: View): RenderElement => {
  const shown = selectedItem(store.items, view.selected ?? null)
  if (shown !== undefined) return paneDetail(t, h, shown, view)
  // An empty list has nothing to show. A pane whose selected item has just been removed draws nothing until the tool call moves it on.
  return store.items.length === 0 ? t.Text({ dimColor: true, children: ['Nothing to do for you.'] }) : t.Box({ children: [] })
}

// The reply field under an open item's controls: one line, Enter sends the text trimmed, and a blank one is nothing. Not drawn where the
// surface's table has no Input, nor for an item whose press is in its window or sent.
const replyField = (t: Table, h: Handlers, item: Item): RenderElement | null =>
  t.Input === undefined || item.state !== 'open'
    ? null
    : t.Input({
        key: `reply-${item.id}`,
        placeholder: 'Reply…',
        submitLabel: 'send',
        onSubmit: value => {
          const text = replyText(value)
          if (text !== null) h.reply(item.id, text)
        },
      })

// Markdown drawn as a brief is: cut at its fenced code blocks, each followed by a copy button that puts exactly its lines on the clipboard,
// with nothing the screen draws around them. A text without code is one markdown element, as before. `id` names its elements, so each is
// unique in the pane.
const briefOf = (t: Table, h: Handlers, id: string, markdown: string): RenderElement[] =>
  briefParts(markdown).flatMap((part, k) =>
    part.kind === 'prose'
      ? [t.Markdown({ key: `detail-${id}-${k}`, text: tablesAsLists(part.text) })]
      : [
          t.Markdown({ key: `detail-${id}-${k}`, text: part.text }),
          t.Button({ key: `copy-${id}-${k}`, plain: true, label: '[copy]', onPress: press => h.copy(part.body, press.surface) }),
        ],
  )

// One turn's drawing: an older turn is one dim line cut at the pane's width; a whole human turn is its label and words; a whole agent turn is
// its label and its words drawn as a brief.
const turnBody = (t: Table, h: Handlers, id: string, turn: Turn, folded: boolean): RenderElement[] => {
  if (folded) return [t.Text({ dimColor: true, wrap: 'truncate-end', children: [`${labelOf(turn)}: ${oneLine(turn.words)}`] })]
  if (turn.speaker === 'human') return [t.Text({ wrap: 'wrap', children: [`${labelOf(turn)}: ${turn.words}`] })]
  return [t.Text({ children: [`${labelOf(turn)}:`] }), ...briefOf(t, h, id, turn.words)]
}

// The thread as the pane draws it: each turn a keyed row, the last four whole and each older one as one dim line, so every turn stays listed and
// the reply field stays near the newest. The answer, while its undo window runs or once sent and awaiting the agent, is the newest human turn (turnsOf).
const threadOf = (t: Table, h: Handlers, item: Item): RenderElement[] => {
  const turns = turnsOf(item)
  return turns.map((turn, k) => {
    const id = `turn-${item.id}-${k}`
    return t.Box({ key: id, flexDirection: 'column', children: turnBody(t, h, id, turn, isFolded(turns, k)) })
  })
}

const paneDetail = (t: Table, h: Handlers, item: Item, view: View): RenderElement => {
  const control = doneControl(t, h, item, view, true)
  const field = replyField(t, h, item)
  return t.Box({
    key: `pane-${item.id}`,
    // No frame of its own: the pane draws one already, and a second one inside it added two rows and a second column of border
    // characters on screen. Copying a few lines whole is the copy button's (briefOf).
    flexDirection: 'column',
    children: [
      t.Text({ bold: item.blocking, wrap: 'wrap', children: [`#${item.id} ${item.blocking ? 'blocking' : 'non-blocking'}, ${item.state}: ${item.title}`] }),
      ...(item.note === null ? [] : [t.Text({ dimColor: true, wrap: 'wrap', children: [`note: ${item.note}`] })]),
      ...(hasBrief(item) ? briefOf(t, h, String(item.id), item.detail) : []),
      // The thread and the controls come after the brief, at the bottom of the item, where people look for them: the newest turn sits above
      // the controls and the reply field. The pane is focused and scrolls, so a long brief is scrolled past to reach them.
      ...threadOf(t, h, item),
      ...(control === null ? [] : [control]),
      ...(field === null ? [] : [field]),
    ],
  })
}
