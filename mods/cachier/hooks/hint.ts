import type { ButtonProps, BoxProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'
import type { HintState, PriceCue } from '../types'
import { COLOUR_SENTENCE, cueOf, pieOf, refreshingOf, type CueMark, type Tone } from './countdown'
import type { PaneSize } from './pane'
import { WRAP, wrapLine } from './sections'

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

// The details pane's lines: the cache's warmth, keepalive's state, and the cost it states. While it refreshes, the cost of its refreshes and
// their interval; while it is off, `offer`, the cost a press would turn it on at. Then the break-even line and this session's tally, which
// `session` carries. A line with no text is left out.
export const paneLines = (state: HintState | null, on: boolean, session: string): string[] => {
  const refreshing = refreshingOf(on, state?.reading ?? null, state?.cost?.label ?? null)
  const status = !on
    ? `Keepalive is off. ${COLOUR_SENTENCE}`
    : refreshing
      ? 'Keepalive is on and refreshing the cache.'
      : state?.reading == null
        ? 'Keepalive is on, with no cache to count from yet.'
        : `Keepalive is paused: ${state.paused ?? 'no refresh is due'}. ${COLOUR_SENTENCE}`
  const figure = refreshing ? state?.cost : !on ? state?.offer : null
  return [
    ...(state === null ? [] : [state.warmth]),
    status,
    ...(figure ? [figure.explain, figure.figures] : []),
    ...(state === null ? [] : [state.breakEven]),
    session,
  ].filter((line) => line !== '')
}

// The advice sentence as the pane's first rows: wrapped at the widest of the other lines and at least the bare answer's width, with no
// indent, so nothing is cut at the pane's edge. No rows when there is no sentence.
export const adviceRowsOf = (sentence: string, lines: string[]): string[] =>
  sentence === '' ? [] : wrapLine(sentence, Math.max(WRAP, ...lines.map((line) => line.length)), '', '')

// The size the details pane asks for (PaneSize) for these lines.
export const paneSize = (lines: string[]): PaneSize => ({
  rows: lines.length,
  columns: Math.max(...lines.map((line) => line.length)),
})

// The details pane's body: one row per line, cut at the pane's width rather than wrapped.
export const paneOf = (t: Table, lines: string[]): RenderElement =>
  t.Box({
    flexDirection: 'column',
    children: lines.map((line) => t.Text({ wrap: 'truncate-end', children: [line] })),
  })
