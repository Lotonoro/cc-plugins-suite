import type { ButtonProps, BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'
import type { HintState, PriceCue } from '../types'
import { cueOf, pieOf, refreshingOf, type CueMark, type Tone } from './countdown'
import type { PaneSize } from './pane'
import type { AnswerRow, SettingId } from './sections'

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

// The pie's hover popup: keepalive's state. Off is off; on with a refresh coming, or with no cache yet, is on; on and sending no more is paused.
export const pieHoverOf = (state: HintState | null, on: boolean): string => {
  if (!on) return 'cache keepalive is off'
  const refreshing = refreshingOf(on, state?.reading ?? null, state?.cost?.label ?? null)
  return refreshing || state?.reading == null ? 'cache keepalive is on' : 'cache keepalive is paused'
}

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
// failed; none without a line. The refresh cost shows on hover, in a popup above the time, for reference at any time. `on` is whether keepalive is
// on. Null when there is no line to show.
export const footerLine = (t: Table, state: HintState | null, on: boolean, onToggle: () => void, onDetails: () => void, cue: PriceCue | null = null): RenderElement | null => {
  const { footer } = pieOf(state?.reading ?? null, on, state?.cost?.label ?? null)
  if (footer === null) return null
  const pie = t.Button({
    key: 'pie',
    plain: true,
    onPress: () => onToggle(),
    children: [t.Text({ ...TONE_PROPS[footer.tone], children: [GLYPHS[footer.quarter]] })],
  })
  // The pie's box is its popup's anchor.
  const pieBox = t.Box({ key: 'pie-box', flexDirection: 'row', children: [pie, popup(t, pieHoverOf(state, on))] })
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

// The size the details pane asks for (PaneSize) for these laid-out rows: one row each, blank rows included, and the columns of the longest.
export const paneSizeOf = (rows: AnswerRow[]): PaneSize => ({
  rows: rows.length,
  columns: Math.max(0, ...rows.map((row) => row.text.length)),
})

// The details pane's body: the answer's rows, one Text each, headings bold and nothing else styled, cut at the pane's width rather than wrapped.
// A blank row is one space, so the row is drawn whether or not the engine gives an empty Text a line. A setting with a handler is one Button
// over all its rows, keyed on the setting; a Button holds only strings and Texts, so its rows are one Text joined by newlines.
export const paneOf = (t: Table, rows: AnswerRow[], handlers: Partial<Record<SettingId, () => void>> = {}): RenderElement => {
  const text = (row: AnswerRow) => (row.text === '' ? ' ' : row.text)
  const children: RenderElement[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const onPress = row.setting === undefined ? undefined : handlers[row.setting]
    if (row.setting === undefined || onPress === undefined) {
      children.push(t.Text({ ...(row.heading === true ? { bold: true } : {}), wrap: 'truncate-end', children: [text(row)] }))
      continue
    }
    const own = [row]
    while (rows[i + 1]?.setting === row.setting) own.push(rows[++i]!)
    children.push(t.Button({ key: `setting-${row.setting}`, plain: true, onPress: () => onPress(), children: [t.Text({ wrap: 'truncate-end', children: [own.map(text).join('\n')] })] }))
  }
  return t.Box({ flexDirection: 'column', children })
}
