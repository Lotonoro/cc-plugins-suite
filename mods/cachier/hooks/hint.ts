import type { ButtonProps, BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'
import type { HintState, PriceCue } from '../types'
import { cueOf, pieOf, type CueMark, type PieState, type Tone } from './countdown'
import type { PaneRow } from './sections'

// The elements the footer line and the details pane are built from, as the surface's table hands them out.
type Table = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

// The pie's glyph by its quarter step: empty at 0 (cold, expired, or nothing to count), full above three quarters of the TTL left.
const GLYPHS = ['○', '◔', '◑', '◕', '●']
// The pie's colour as theme tokens, so it follows the person's theme. The words beside it (the time, the rebuild figure, `reset` or `no count`) are dim, never coloured.
const TONE_PROPS: Record<Tone, Partial<TextProps>> = {
  on: { color: 'success' },
  quiet: {},
  warning: { color: 'warning' },
  alarm: { color: 'error' },
  gone: { dimColor: true },
}

// The cue's text props by tone: running dim, landed in the normal text colour, failed amber (a theme token).
const CUE_PROPS: Record<CueMark['tone'], Partial<TextProps>> = {
  dim: { dimColor: true },
  plain: {},
  warning: { color: 'warning' },
}

// The pie's hover popup words, by the keepalive state `pieOf` judges from the pie's tone.
const STATE_WORDS: Record<PieState, string> = { on: 'cache keepalive is on', paused: 'cache keepalive is paused', off: 'cache keepalive is off' }

// A hover popup: dim text one row above its anchor, out of the flow, its right edge on the anchor's, shown only while the anchor is hovered.
const popup = (t: Table, text: string): RenderElement =>
  t.Box({
    position: 'absolute',
    bottom: 1,
    right: 0,
    flexShrink: 0,
    display: 'none',
    hover: { display: 'flex' },
    children: [t.Text({ dimColor: true, wrap: 'truncate-end', children: [text] })],
  })

// The footer line: the pie, which a click switches keepalive with, and beside it the time, the rebuild figure, `reset` or `no count`, which a click
// opens the details with. After them, the price read's cue when one stands (`cue`): `⟳` while it runs, `✓` once it landed, an amber `!` once it
// failed; none without a line. The refresh cost shows on hover, in a popup above the time, for reference at any time, and the pie's hover names its
// keepalive state, as `pieOf` judges it. `on` is whether keepalive is on, and `stopped` whether a recorded stop stands, which the pie's tone reads
// (`footerOf`). Null when there is no line to show.
export const footerLine = (t: Table, state: HintState | null, on: boolean, onToggle: () => void, onDetails: () => void, cue: PriceCue | null = null, stopped = false): RenderElement | null => {
  const judged = pieOf(state?.reading ?? null, on, state?.cost?.label ?? null, stopped)
  if (judged.footer === null) return null
  const { footer } = judged
  const pie = t.Button({
    key: 'pie',
    plain: true,
    onPress: () => onToggle(),
    children: [t.Text({ ...TONE_PROPS[footer.tone], children: [GLYPHS[footer.quarter]] })],
  })
  // The pie's box is its popup's anchor.
  const pieBox = t.Box({ key: 'pie-box', flexDirection: 'row', children: [pie, popup(t, STATE_WORDS[judged.state])] })
  const cost = state?.cost ?? state?.offer ?? null
  const time = t.Box({
    key: 'time',
    flexDirection: 'row',
    children: [
      t.Button({ key: 'details', plain: true, dimColor: true, onPress: () => onDetails(), children: [footer.words] }),
      // Out of the flow, so showing it moves nothing on the line: the time stays under the pointer and clickable. Its right edge on the
      // time's, it opens leftwards and never past the screen's right edge.
      ...(cost === null ? [] : [popup(t, cost.label)]),
    ],
  })
  const mark = cueOf(cue)
  const cueText = mark === null ? [] : [t.Box({ key: 'cue', children: [t.Text({ ...CUE_PROPS[mark.tone], children: [` ${mark.glyph}`] })] })]
  return t.Box({ flexDirection: 'row', children: [pieBox, t.Text({ dimColor: true, children: [' '] }), time, ...cueText] })
}

// The details pane's body: the pane's rows, one element each, headings bold and nothing else styled. Every Text wraps, so the engine wraps a
// sentence at the width the pane is drawn at; a line sits in a box indented two columns, so each row it wraps into starts at that indent.
// A blank row is one space, so the row is drawn whether or not the engine gives an empty Text a line.
export const paneOf = (t: Table, rows: PaneRow[]): RenderElement =>
  t.Box({
    flexDirection: 'column',
    children: rows.map((row) => {
      if (row.kind === 'line') return t.Box({ paddingLeft: 2, children: [t.Text({ wrap: 'wrap', children: [row.text] })] })
      return t.Text({ ...(row.kind === 'heading' ? { bold: true } : {}), wrap: 'wrap', children: [row.kind === 'blank' ? ' ' : row.text] })
    }),
  })
