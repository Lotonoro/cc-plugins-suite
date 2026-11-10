import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'
import type { FailCause, LastReview } from '../types/index'
import { centsOf, percentOf, shareOf, wholeOf } from './pricing'

// The button's words and drawing: the footer label, the hover popup's rows as an ordered list, and `/auditor`'s answer, all from the same plain figures so they cannot drift apart.

// The elements the button is built from, as the surface's table hands them out.
type Table = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

// What the words read: the toggle's state, the tally in dollars, the model that made it unknown (null while it is known), the session's total from the ledger (undefined when unknown), the reviews completed and notes given with the last review, the cause of the failure (set exactly while the state is failing) and the count of notes held for the next prompt.
export type Figures = {
  state: 'on' | 'off' | 'failing'
  spent: number
  unpriced: string | null
  total: number | undefined
  reviews: number
  notes: number
  last: LastReview | undefined
  cause: FailCause | undefined
  held: number
}

// One popup row: a stable key, so a test or a later row finds it by key and order, and its words.
export type Row = { key: string; text: string }

// The label: the state, then the dollars and the share in parentheses where there are figures to show. Off shows none.
export const labelOf = (f: Figures): string => {
  if (f.state === 'off' || f.unpriced !== null || f.spent === 0) return `auditor ${f.state}`
  const share = shareOf(f.spent, f.total)
  return `auditor ${f.state} (${wholeOf(f.spent)}${share === undefined ? '' : `, ${percentOf(share)}`})`
}

// The cost row's words.
const costRow = (f: Figures): string => {
  if (f.state === 'off') return 'off: no reviews, no figures until switched on'
  if (f.unpriced !== null) return `cost unknown: no price for ${f.unpriced}`
  // The share of nothing spent is not shown, as in the label.
  const share = f.spent === 0 ? undefined : shareOf(f.spent, f.total)
  const session = share === undefined || f.total === undefined ? [] : [`session ${centsOf(f.total)}`, percentOf(share)]
  return ['auditor ' + centsOf(f.spent) + ' since on', ...session, 'API list prices'].join(' · ')
}

// The failing row's cause wording, one per cause. A place that sets `failing` with a cause of its own adds its row here.
const CAUSE_WORDS: Record<FailCause, string> = {
  'no answer': 'the reviewer ended a turn without an answer',
  'not dispatched': 'a review could not be handed to a reviewer',
  'no start': 'the reviewer did not start in 10 minutes',
  unknown: 'cause unknown; see the debug log',
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

// The host's local time of day, as HH:MM.
const clockOf = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The reviews row: how many reviews completed and notes were given, and how the last review closed, at an absolute time since the popup is not redrawn while it is open.
const reviewsRow = (f: Figures): string => {
  if (f.reviews === 0 || f.last === undefined) return 'no reviews yet'
  return [plural(f.reviews, 'review'), f.notes === 0 ? 'no notes' : plural(f.notes, 'note'), `last at ${clockOf(f.last.at)}, ${f.last.note ? 'note sent' : 'quiet'}`].join(' · ')
}

// The state row, or none: the failure with its cause, the notes held for the next prompt, or both in one row.
const stateRow = (f: Figures): string | undefined => {
  const failing = f.state === 'failing' && f.cause !== undefined ? `failing: ${CAUSE_WORDS[f.cause]}` : undefined
  if (f.held === 0) return failing
  return failing === undefined ? `${plural(f.held, 'note')} held for your next prompt` : `${failing} · ${plural(f.held, 'note')} held`
}

// The popup's rows, in order: the cost row, the reviews row, the press row, then at most one state row; four at the most. Off shows the cost row and the press row alone.
export const rowsOf = (f: Figures): Row[] => {
  const press: Row = { key: 'press', text: f.state === 'off' ? 'click to switch on' : 'click to switch off' }
  if (f.state === 'off') return [{ key: 'cost', text: costRow(f) }, press]
  const state = stateRow(f)
  return [{ key: 'cost', text: costRow(f) }, { key: 'reviews', text: reviewsRow(f) }, press, ...(state === undefined ? [] : [{ key: 'state', text: state }])]
}

// What `/auditor` answers: the label the footer would draw, then the popup's rows.
export const answerOf = (f: Figures): string => [labelOf(f), ...rowsOf(f).map(row => row.text)].join('\n')

// The button and, beside it in a keyed box, its popup: a dim column of rows one row above the button, out of the flow, its right edge on the box's, shown only while the box is hovered (as cachier's footer popup does), so showing it moves nothing on the footer line.
export const buttonOf = (t: Table, key: string, f: Figures, onPress: () => void): RenderElement => {
  const popup = t.Box({
    position: 'absolute',
    bottom: 1,
    right: 0,
    flexShrink: 0,
    flexDirection: 'column',
    display: 'none',
    hover: { display: 'flex' },
    children: rowsOf(f).map(row => t.Box({ key: row.key, children: [t.Text({ dimColor: true, wrap: 'truncate-end', children: [row.text] })] })),
  })
  return t.Box({ key: 'auditor-box', flexDirection: 'row', children: [t.Button({ key, plain: true, dimColor: true, label: labelOf(f), onPress }), popup] })
}
