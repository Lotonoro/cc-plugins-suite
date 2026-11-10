import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'
import { centsOf, percentOf, shareOf, wholeOf } from './pricing'

// The button's words and drawing: the footer label, the hover popup's rows as an ordered list, and `/auditor`'s answer, all from the same plain figures so they cannot drift apart.

// The elements the button is built from, as the surface's table hands them out.
type Table = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

// What the words read: the toggle's state, the tally in dollars, the model that made it unknown (null while it is known), and the session's total from the ledger (undefined when unknown).
export type Figures = { state: 'on' | 'off' | 'failing'; spent: number; unpriced: string | null; total: number | undefined }

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

// The popup's rows, in order: the cost row, then the press row. The popup never exceeds four rows.
export const rowsOf = (f: Figures): Row[] => [
  { key: 'cost', text: costRow(f) },
  { key: 'press', text: f.state === 'off' ? 'click to switch on' : 'click to switch off' },
]

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
