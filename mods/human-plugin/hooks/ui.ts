import type { ButtonProps, BoxProps, ElementConstructor, InputProps, MarkdownProps, RenderElement, TextProps, UiCopyArgs } from 'claude-code'
import type { Item, Store } from '../types'
import { parseInput, selectedItem, type ToolInput } from './items'
import { bandRows } from './layout'
import { briefParts, tablesAsLists } from './tables'

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
// shows, if any.
export type View = { maxRows: number; now: number; windowMs: number; selected?: number | null }

const CHECK = { color: 'green' }

// The answers a decision offers, recommended first: one row each, a ▸ in the inline-code colour then the option's label in brackets, which takes that colour and
// bold under the pointer. No description is drawn: the brief above the controls explains the options.
const answers = (t: Table, h: Handlers, item: Item): RenderElement =>
  t.Box({
    flexDirection: 'column',
    children: [...item.options]
      .sort((a, b) => Number(b.recommended) - Number(a.recommended))
      .map((option, i) =>
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

// A yes/no question's two marks, yes then no, each drawn as the done check is.
const marks = (t: Table, h: Handlers, item: Item): RenderElement =>
  t.Box({
    children: [
      t.Button({ key: `yes-${item.id}`, plain: true, label: '[✓]', onPress: () => h.done(item.id, 'yes') }),
      t.Text({ children: [' '] }),
      t.Button({ key: `no-${item.id}`, plain: true, label: '[✗]', onPress: () => h.done(item.id, 'no') }),
    ],
  })

// The done control: a press on an open item starts the undo window, and the same control cancels it while it runs. A decision
// with options has its answers in the pane only: in the band, answering means opening the item. A yes/no question has its yes and
// no marks in the band too. Null when there is no control.
// A sent item keeps the button its undo window had, inert, so the window's ending moves no other button in the focus ring. The
// labels are drawn plain: the terminal would wrap a non-plain label in brackets of its own, as `[ [✓] ]`, in the pane too. The pane's
// controls sit bare, as the band's do.
const doneControl = (t: Table, h: Handlers, item: Item, view: View, inPane: boolean): RenderElement | null => {
  if (item.state === 'done-pending') {
    return t.Button({ key: `done-${item.id}`, plain: true, dimColor: true, label: '✓ sent', onPress: () => undefined })
  }
  if (item.state === 'done-waiting' && item.pressedAt !== null) {
    const left = Math.max(0, Math.ceil((item.pressedAt + view.windowMs - view.now) / 1000))
    // A reply is a check whatever its text, even a yes or no's `no`. The band names no text: a reply can be long, so the pane draws it whole.
    const said = item.replied ? (inPane ? `✓ replied: ${item.answer ?? ''} ` : '✓ replied ') : `${item.yesno && item.answer === 'no' ? '✗' : '✓'} ${item.answer === null ? '' : `${item.answer} `}`
    return t.Box({
      children: [
        t.Text({ ...CHECK, bold: true, children: [said] }),
        // The undo button keeps its width when a long answer's text wraps beside it.
        t.Box({ flexShrink: 0, children: [t.Button({ key: `done-${item.id}`, plain: true, label: `[↶ ${left}s]`, onPress: () => h.done(item.id, null) })] }),
      ],
    })
  }
  if (item.options.length > 0) return inPane ? answers(t, h, item) : null
  if (item.yesno) return marks(t, h, item)
  // A labelled to-do's press sends its label as the answer: what the press means, as the agent reads it (done.ts).
  return t.Button({
    key: `done-${item.id}`,
    plain: true,
    label: item.doneLabel === null ? '[✓]' : `[✓ ${item.doneLabel}]`,
    onPress: () => h.done(item.id, item.doneLabel),
  })
}

// The one rule for a blank brief: whitespace alone is no brief, in the title, the pane's rows and the pane's draw.
const hasBrief = (item: Item): boolean => item.detail.trim() !== ''

// The `[…]` marks a row whose answers are in the pane alone: a decision with options. A row with its buttons on the line (a to-do's
// `[✓]`, a yes/no's marks) needs no marker, and its title still opens the pane.
const titleLabel = (item: Item): string => (item.options.length > 0 ? `${item.title} […]` : item.title)

// `isShown`: whether the pane shows this item, so a press on it closes the pane.
const itemRow = (t: Table, h: Handlers, item: Item, view: View, isShown: boolean): RenderElement => {
  const control = doneControl(t, h, item, view, false)
  // The id and the control keep their natural width: in a narrow row only the title shrinks and wraps, so `#11` never breaks into a column.
  return t.Box({
    key: `item-${item.id}`,
    children: [
      t.Box({ flexShrink: 0, children: [t.Text({ bold: item.blocking, dimColor: !item.blocking, children: [`${item.unread ? '• ' : '  '}#${item.id} `] })] }),
      t.Button({ key: `title-${item.id}`, plain: true, label: titleLabel(item), onPress: () => h.pick(item.id, isShown) }),
      ...(control === null ? [] : [t.Box({ flexShrink: 0, children: [t.Text({ children: [' '] }), control] })]),
    ],
  })
}

// The summary row: what the band leaves out, as a button that opens the pane on the first folded item. Blocking items that did not
// fit are named apart from the rest, and the row is set in a warning box while any is folded: they are the asks the band could not show.
const summaryRow = (t: Table, h: Handlers, row: { blocking: number; more: number; first: Item }): RenderElement => {
  const text = [row.blocking > 0 ? `+${row.blocking} blocking` : '', row.more > 0 ? `+${row.more} more` : ''].filter(part => part !== '').join(' · ')
  return t.Box({
    backgroundColor: row.blocking > 0 ? 'warning' : undefined,
    children: [t.Button({ key: 'band-more', plain: true, dimColor: row.blocking === 0, label: `${text} […]`, onPress: () => h.more(row.first.id) })],
  })
}

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
      return `${reply} ${input.title}${input.blocking ? ' (blocking)' : ''}`
    case 'list':
      // One header line per item (`#N blocking, state: title`), so an open item is a line with `open:`; a detail's own lines are not items.
      return `listed ${(reply.match(/^#\d+ (non-)?blocking, open: /gm) ?? []).length} open`
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

// The band above the prompt: a header with the count, then the rows that fit. When items are folded, the summary row is the way into
// the pane for them. The pane is also opened by a title, and closed by its own close or a press on the item it shows.
export const band = (t: Table, h: Handlers, store: Store, view: View): RenderElement => {
  const open = store.items.filter(it => it.state === 'open')
  const pending = store.items.filter(it => it.state === 'done-pending').length
  const rows = bandRows(store.items, Math.max(0, view.maxRows - 1))
  const shownId = selectedItem(store.items, view.selected ?? null)?.id
  // The header is a filled chip, the line that asks for the person's attention: `warning` while the agent is stuck on an open blocking
  // item, `permission` otherwise. The count after it is plain text: the open items, and the sent ones by their own count.
  const header = t.Box({
    children: [
      t.Box({ flexShrink: 0, children: [t.Text({ bold: true, color: 'inverseText', backgroundColor: open.some(it => it.blocking) ? 'warning' : 'permission', children: [' To do for you '] })] }),
      t.Text({ children: [` ${open.length} open${pending > 0 ? `, ${pending} sent` : ''} `] }),
    ],
  })
  const body = rows.map(row => (row.kind === 'item' ? itemRow(t, h, row.item, view, row.item.id === shownId) : summaryRow(t, h, row)))
  return t.Box({ flexDirection: 'column', children: [header, ...body] })
}

// A brief's rows as Markdown draws them: one per line, and one more for each heading, which the surface sets off with a blank row.
// Measured live at 100 columns: a 25-line brief with a `# Brief` heading drew 26 rows. Wrapped lines are not counted (no width here).
const briefRows = (detail: string): number => {
  const lines = detail.split('\n')
  return lines.length + lines.filter(line => /^#{1,6}\s/.test(line)).length
}

// The rows the pane asks for: the shown item's header, control (one row per answer), the reply field's row while the item is open,
// its note if any, and its brief's rows with a row for each code block's copy button. The engine grants what the layout spares, so this is a request.
export const paneRows = (shown: Item | undefined): number => {
  if (shown === undefined) return 1
  const control = shown.options.length > 0 ? shown.options.length : 1
  const field = shown.state === 'open' ? 1 : 0
  return 1 + control + field + (shown.note === null ? 0 : 1) + (hasBrief(shown) ? briefRows(shown.detail) + briefParts(shown.detail).filter(part => part.kind === 'code').length : 0)
}

// The pane: the shown item alone, its header, its note, its whole detail (markdown, a decision brief is written in it), and last its
// controls. No other item is drawn, so a removal moves no button under the pointer; the pane moves to the next item when its item is
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
          const text = value.trim()
          if (text !== '') h.reply(item.id, text)
        },
      })

// The brief, cut at its fenced code blocks: each block is followed by a copy button that puts exactly its lines on the clipboard, with
// nothing the screen draws around them. A brief without code is one markdown element, as before.
const briefOf = (t: Table, h: Handlers, item: Item): RenderElement[] =>
  briefParts(item.detail).flatMap((part, k) =>
    part.kind === 'prose'
      ? [t.Markdown({ key: `detail-${item.id}-${k}`, text: tablesAsLists(part.text) })]
      : [
          t.Markdown({ key: `detail-${item.id}-${k}`, text: part.text }),
          t.Button({ key: `copy-${item.id}-${k}`, plain: true, label: '[copy]', onPress: press => h.copy(part.body, press.surface) }),
        ],
  )

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
      ...(hasBrief(item) ? briefOf(t, h, item) : []),
      // The controls come after the brief, at the bottom of the item, where people look for them. The pane is focused and scrolls,
      // so a long brief is scrolled past to reach them.
      ...(control === null ? [] : [control]),
      ...(field === null ? [] : [field]),
    ],
  })
}
