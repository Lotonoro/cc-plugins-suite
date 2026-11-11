import { describe, expect, test } from 'claude-code/testing'
import type { HintState, Reading } from '../types'
import { labelled, type Tone } from './countdown'
import { mislabelled, withoutLabel } from './fixture'
import { footerLine, paneOf } from './hint'
import { layoutOf, paneLayoutOf, type Snapshot } from './sections'

// A table that builds the elements as plain data, the way a surface's table hands them out.
const table = {
  Box: (p: { children?: unknown } & Record<string, unknown>) => ({ type: 'Box', props: { ...p, children: undefined }, children: p.children }),
  Text: (p: { children?: unknown } & Record<string, unknown>) => ({ type: 'Text', props: { ...p, children: undefined }, children: p.children }),
  Button: (p: Record<string, unknown>) => ({ type: 'Button', props: p }),
}
const t = table as any
const noop = () => {}
const WARM: Reading = { words: '3:12', state: 'warm', quarter: 3, warn: 'calm' }
const COST = { label: '$0.006/refresh' }
const OFFER = { label: '$0.006/refresh' }
const state = (extra: Partial<HintState> = {}): HintState => ({
  reading: WARM,
  cost: null,
  offer: null,
  ...extra,
})
// The footer's parts: the pie button, the separator, and the words (a keyed Box of the details button and its hover reveal).
const pieOf = (line: any) => line.children[0].children[0]
// The pie's keyed Box, which holds the pie and its hover popup: the line's first child.
const pieBoxOf = (line: any) => line.children[0]
const timeOf = (line: any) => line.children[2]
const glyphOf = (pie: any) => pie.props.children[0].children[0]
const toneOf = (pie: any) => pie.props.children[0].props
const revealOf = (line: any) => timeOf(line).children[1]

describe('footerLine: the price read cue after the words', () => {
  const cueOf = (line: any) => line.children[3]
  const glyph = (line: any) => cueOf(line).children[0].children[0]
  const props = (line: any) => cueOf(line).children[0].props

  test('with no read there is no cue, and the line has the pie, the separator and the words only', () => {
    expect((footerLine(t, state(), false, noop, noop) as any).children).toHaveLength(3)
    expect((footerLine(t, state(), false, noop, noop, null) as any).children).toHaveLength(3)
  })

  test('a running read draws a dim glyph after the words, which stay a dim details button', () => {
    const line = footerLine(t, state(), false, noop, noop, 'reading') as any
    expect(line.children).toHaveLength(4)
    expect(glyph(line)).toBe(' ⟳')
    expect(props(line)).toEqual({ dimColor: true })
    expect(timeOf(line).children[0].props).toMatchObject({ key: 'details', dimColor: true, children: ['3:12'] })
  })

  test('a landed read draws a check mark in the normal text colour', () => {
    const line = footerLine(t, state(), false, noop, noop, 'landed') as any
    expect(glyph(line)).toBe(' ✓')
    expect(props(line)).toEqual({})
  })

  test('a failed read draws an amber exclamation mark, not a check mark', () => {
    const line = footerLine(t, state(), false, noop, noop, 'failed') as any
    expect(glyph(line)).toBe(' !')
    expect(props(line)).toEqual({ color: 'warning' })
    expect(JSON.stringify(line)).not.toContain('✓')
  })

  test('the cue follows the reset and no-count words too', () => {
    const cold = { words: '', state: 'cold', quarter: 0, warn: 'calm' } as const
    expect(glyph(footerLine(t, state({ reading: cold }), true, noop, noop, 'reading') as any)).toBe(' ⟳')
    expect(glyph(footerLine(t, state({ reading: null }), true, noop, noop, 'landed') as any)).toBe(' ✓')
  })

  test('with no footer drawn there is no cue', () => {
    expect(footerLine(t, state({ reading: null }), false, noop, noop, 'reading')).toBeNull()
    expect(footerLine(t, null, false, noop, noop, 'failed')).toBeNull()
  })

  test('the pie and the words stay pressable with a cue showing', () => {
    let toggles = 0
    let details = 0
    const line = footerLine(t, state(), false, () => toggles++, () => details++, 'reading') as any
    pieOf(line).props.onPress({ plugin: 'cachier', element: 'pie' })
    timeOf(line).children[0].props.onPress({ plugin: 'cachier', element: 'details' })
    expect([toggles, details]).toEqual([1, 1])
  })
})

describe('footerLine: the pie, and its words', () => {
  test('with no line to show, there is no element', () => {
    expect(footerLine(t, null, false, noop, noop)).toBeNull()
    expect(footerLine(t, state({ reading: null }), false, noop, noop)).toBeNull()
  })

  test('nothing to count with keepalive on is the empty green pie with `no count` beside it, a dim details button', () => {
    const line = footerLine(t, state({ reading: null }), true, noop, noop) as any
    expect(glyphOf(pieOf(line))).toBe('○')
    expect(toneOf(pieOf(line))).toEqual({ color: 'success' })
    expect(timeOf(line).children[0].props).toMatchObject({ key: 'details', dimColor: true, children: ['no count'] })
  })

  test('a warm cache that keepalive refreshes draws its quarter as the pie, green, then the time', () => {
    const line = footerLine(t, state({ cost: COST }), true, noop, noop) as any
    expect(glyphOf(pieOf(line))).toBe('◕')
    expect(toneOf(pieOf(line))).toEqual({ color: 'success' })
    expect(timeOf(line).props.key).toBe('time')
    expect(timeOf(line).children[0].props).toMatchObject({ key: 'details', dimColor: true, children: ['3:12'] })
  })

  test('a warm cache with keepalive off draws the pie in the normal text colour, and the time dim', () => {
    const line = footerLine(t, state(), false, noop, noop) as any
    expect(toneOf(pieOf(line))).toEqual({})
    expect(timeOf(line).children[0].props).toMatchObject({ dimColor: true, children: ['3:12'] })
  })

  test('in the last quarter with keepalive off the pie is amber, and in the last tenth it is red', () => {
    const quarter: Reading = { words: '1:00', state: 'warm', quarter: 1, warn: 'quarter' }
    const tenth: Reading = { words: '0:20', state: 'warm', quarter: 1, warn: 'tenth' }
    expect(glyphOf(pieOf(footerLine(t, state({ reading: quarter }), false, noop, noop)))).toBe('◔')
    expect(toneOf(pieOf(footerLine(t, state({ reading: quarter }), false, noop, noop)))).toEqual({ color: 'warning' })
    expect(toneOf(pieOf(footerLine(t, state({ reading: tenth }), false, noop, noop)))).toEqual({ color: 'error' })
  })

  test('the pie is green in every warm quarter while keepalive refreshes, and warns while it is paused', () => {
    const tenth: Reading = { words: '0:20', state: 'warm', quarter: 1, warn: 'tenth' }
    expect(toneOf(pieOf(footerLine(t, state({ reading: tenth, cost: COST }), true, noop, noop)))).toEqual({ color: 'success' })
    expect(toneOf(pieOf(footerLine(t, state({ reading: tenth }), true, noop, noop)))).toEqual({ color: 'error' })
  })

  test('an expired cache is an empty pie and the rebuild figure, red with keepalive on and dim off', () => {
    const expired: Reading = { words: '~$0.42 to rebuild', state: 'expired', quarter: 0, warn: 'calm' }
    const on = footerLine(t, state({ reading: expired }), true, noop, noop) as any
    expect(glyphOf(pieOf(on))).toBe('○')
    expect(toneOf(pieOf(on))).toEqual({ color: 'error' })
    expect(timeOf(on).children[0].props).toMatchObject({ children: ['~$0.42 to rebuild'], dimColor: true })
    expect(toneOf(pieOf(footerLine(t, state({ reading: expired }), false, noop, noop)))).toEqual({ dimColor: true })
  })

  test('a cold cache is an empty pie with `reset` beside it: green with keepalive on, dim off', () => {
    const cold: Reading = { words: '', state: 'cold', quarter: 0, warn: 'calm' }
    const on = footerLine(t, state({ reading: cold }), true, noop, noop) as any
    expect(toneOf(pieOf(on))).toEqual({ color: 'success' })
    expect(timeOf(on).children[0].props).toMatchObject({ key: 'details', dimColor: true, children: ['reset'] })
    const off = footerLine(t, state({ reading: cold }), false, noop, noop) as any
    expect(timeOf(off).children[0].props).toMatchObject({ key: 'details', children: ['reset'] })
    expect(glyphOf(pieOf(off))).toBe('○')
    expect(toneOf(pieOf(off))).toEqual({ dimColor: true })
  })

  test('a click on the pie runs the toggle, and a click on the time runs the details', () => {
    let toggles = 0
    let details = 0
    const line = footerLine(t, state(), false, () => toggles++, () => details++) as any
    pieOf(line).props.onPress({ plugin: 'cachier', element: 'pie' })
    timeOf(line).children[0].props.onPress({ plugin: 'cachier', element: 'details' })
    expect([toggles, details]).toEqual([1, 1])
  })

  test('the time reveals the refresh cost on hover as a popup above it, out of the flow, so nothing on the line moves; with keepalive off, the figure a press would turn it on at', () => {
    const popup = { position: 'absolute', bottom: 1, right: 0, flexShrink: 0, display: 'none', hover: { display: 'flex' } }
    expect(revealOf(footerLine(t, state({ cost: COST }), true, noop, noop))).toMatchObject({
      props: popup,
      children: [{ type: 'Text', children: ['$0.006/refresh'] }],
    })
    expect(revealOf(footerLine(t, state({ offer: OFFER }), false, noop, noop))).toMatchObject({
      props: popup,
      children: [{ type: 'Text', children: ['$0.006/refresh'] }],
    })
  })

  test('with no cost or offer to reveal, the time has no hover element', () => {
    expect(timeOf(footerLine(t, state(), true, noop, noop) as any).children).toHaveLength(1)
  })

  test('the drawn line says nothing of a bar, a refresh figure, the word cache, or a paused mark, outside the hover reveal', () => {
    const line = footerLine(t, state({ cost: COST }), true, noop, noop) as any
    const drawn = JSON.stringify({ ...line, children: [pieOf(line), timeOf(line).children[0]] })
    expect(drawn).not.toMatch(/↻|▰|▱|cache|refresh|paused/)
  })

  test('no element has a background, and the time and its hover figure carry no colour, only dim', () => {
    const line = footerLine(t, state({ cost: COST }), true, noop, noop) as any
    expect(JSON.stringify(line)).not.toContain('backgroundColor')
    expect(timeOf(line).children[0].props.color).toBeUndefined()
    expect(revealOf(line).children[0].props).toMatchObject({ dimColor: true })
    expect(revealOf(line).children[0].props.color).toBeUndefined()
  })

  test('the hover popups are the pie\'s, and the time\'s when it has a figure: two absolutely positioned elements with a figure, else the pie\'s alone', () => {
    expect(JSON.stringify(footerLine(t, state({ cost: COST }), true, noop, noop)).match(/absolute/g)).toHaveLength(2)
    expect(JSON.stringify(footerLine(t, state(), true, noop, noop)).match(/absolute/g)).toHaveLength(1)
    expect(JSON.stringify(footerLine(t, state({ reading: null }), true, noop, noop)).match(/absolute/g)).toHaveLength(1)
  })

  test('the pie reveals keepalive\'s state on hover as a dim popup above it, out of the flow, anchored to the pie\'s right edge', () => {
    const popup = { position: 'absolute', bottom: 1, right: 0, flexShrink: 0, display: 'none', hover: { display: 'flex' } }
    const reveal = (line: any) => pieBoxOf(line).children[1]
    expect(reveal(footerLine(t, state({ cost: COST }), true, noop, noop))).toMatchObject({ props: popup, children: [{ type: 'Text', props: { dimColor: true }, children: ['cache keepalive is on'] }] })
    expect(reveal(footerLine(t, state({ reading: null }), true, noop, noop))).toMatchObject({ children: [{ children: ['cache keepalive is on'] }] })
    expect(reveal(footerLine(t, state(), true, noop, noop))).toMatchObject({ children: [{ children: ['cache keepalive is paused'] }] })
    expect(reveal(footerLine(t, state(), false, noop, noop))).toMatchObject({ children: [{ children: ['cache keepalive is off'] }] })
  })

  test('the pie box holds the pie and its popup, and the popup moves nothing: the pie stays the box\'s first child', () => {
    const line = footerLine(t, state({ cost: COST }), true, noop, noop) as any
    expect(pieBoxOf(line).props).toMatchObject({ key: 'pie-box', flexDirection: 'row' })
    expect(pieBoxOf(line).children[0]).toMatchObject({ type: 'Button', props: { key: 'pie' } })
  })
})

describe('footerLine: a recorded stop standing with keepalive on draws the pie red beside reset or no count', () => {
  const COLD_READING: Reading = { words: '', state: 'cold', quarter: 0, warn: 'calm' }

  test('a cold cache is the empty pie in red with `reset` beside it, and the hover reads paused', () => {
    const line = footerLine(t, state({ reading: COLD_READING }), true, noop, noop, null, true) as any
    expect(toneOf(pieOf(line))).toEqual({ color: 'error' })
    expect(timeOf(line).children[0].props).toMatchObject({ key: 'details', children: ['reset'] })
    expect(pieBoxOf(line).children[1]).toMatchObject({ children: [{ children: ['cache keepalive is paused'] }] })
  })

  test('nothing to count is the empty pie in red beside `no count`', () => {
    const line = footerLine(t, state({ reading: null }), true, noop, noop, null, true) as any
    expect(toneOf(pieOf(line))).toEqual({ color: 'error' })
    expect(timeOf(line).children[0].props).toMatchObject({ key: 'details', children: ['no count'] })
  })

  test('with keepalive off no stop stands: a cold cache is dim beside reset', () => {
    const line = footerLine(t, state({ reading: COLD_READING }), false, noop, noop, null, true) as any
    expect(toneOf(pieOf(line))).toEqual({ dimColor: true })
  })
})

describe('footerLine: the pie\'s hover names the keepalive state its colour stands for', () => {
  const COLD_READING: Reading = { words: '', state: 'cold', quarter: 0, warn: 'calm' }
  const EXPIRED: Reading = { words: '~$0.42 to rebuild', state: 'expired', quarter: 0, warn: 'calm' }
  const QUARTER: Reading = { words: '1:00', state: 'warm', quarter: 1, warn: 'quarter' }
  const TENTH: Reading = { words: '0:20', state: 'warm', quarter: 1, warn: 'tenth' }
  // The word the pie's hover reads, on a line that draws a pie.
  const hoverOf = (line: any): string => pieBoxOf(line).children[1].children[0].children[0]

  test('a green pie reads on: a warm cache keepalive refreshes, and a cold cache or nothing to count does with keepalive on and no stop', () => {
    expect(hoverOf(footerLine(t, state({ cost: COST }), true, noop, noop))).toBe('cache keepalive is on')
    expect(hoverOf(footerLine(t, state({ reading: COLD_READING }), true, noop, noop))).toBe('cache keepalive is on')
    expect(hoverOf(footerLine(t, state({ reading: null }), true, noop, noop))).toBe('cache keepalive is on')
  })

  test('a red pie reads paused: an expired cache with keepalive on, and a recorded stop over nothing to count or a cold cache', () => {
    expect(hoverOf(footerLine(t, state({ reading: EXPIRED }), true, noop, noop))).toBe('cache keepalive is paused')
    expect(hoverOf(footerLine(t, state({ reading: null }), true, noop, noop, null, true))).toBe('cache keepalive is paused')
    expect(hoverOf(footerLine(t, state({ reading: COLD_READING }), true, noop, noop, null, true))).toBe('cache keepalive is paused')
  })

  test('with keepalive on and no refresh coming, the pie in its normal colour, amber or red reads paused', () => {
    for (const reading of [WARM, QUARTER, TENTH]) expect(hoverOf(footerLine(t, state({ reading }), true, noop, noop))).toBe('cache keepalive is paused')
  })

  test('with keepalive off, the pie in its normal colour, amber, red or dim reads off, with or without a refresh figure', () => {
    for (const reading of [WARM, QUARTER, TENTH, EXPIRED, COLD_READING]) {
      for (const cost of [null, COST]) expect(hoverOf(footerLine(t, state({ reading, cost }), false, noop, noop))).toBe('cache keepalive is off')
    }
  })
})

// The labelled rows state their label through the constructor, as their producers do; the Settings row is formed by the layout builder.
const SNAPSHOT: Snapshot = {
  cache: ['warm · 3:12 left · 5m TTL'],
  keepalive: { state: 'off', tone: 'gone', lines: [labelled('pie:', ' amber ≤¼ TTL left, red ≤⅒')] },
  session: [labelled('session:', ' no refreshes yet')],
  advice: [
    labelled('setup:', ' 5m/off'),
    labelled('best:', ' 1h/off · would have saved $1.20 (10 recent pauses)'),
    labelled('do:', ' set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)'),
  ],
  settings: [{ name: 'unit', value: 'dollars', source: 'cost_unit', change: '/keepalive unit tokens|dollars' }],
}
const ROWS = paneLayoutOf(SNAPSHOT).rows
// The Keepalive heading is the one heading row of SNAPSHOT that has runs.
const RUN_AT = ROWS.findIndex((row) => row.kind === 'heading' && row.runs !== undefined)
// The text a built element holds, its strings in order, and the props it sets, none when it sets none.
const textOf = (el: any): string => (typeof el === 'string' ? el : (el.children ?? []).map(textOf).join(''))
const propsOf = (el: any) => el.props ?? {}

describe('paneOf: the pane\'s rows, one element per row, wrapped by the engine, headings bold, the Keepalive state word coloured and each label dim', () => {
  test('a heading and a blank are a Text at the left edge, a line a Text in a box indented two; every Text wraps', () => {
    const pane = paneOf(t, ROWS) as any
    expect(pane.children).toHaveLength(ROWS.length)
    const texts: any[] = []
    pane.children.forEach((child: any, i: number) => {
      if (ROWS[i]?.kind === 'line') {
        expect(child).toMatchObject({ type: 'Box', props: { paddingLeft: 2 } })
        expect(child.children).toHaveLength(1)
        texts.push(child.children[0])
      } else {
        expect(child.type).toBe('Text')
        texts.push(child)
      }
    })
    // A row with no runs holds its text as its one child; the row with runs holds the same text across its pieces.
    ROWS.forEach((row, i) => {
      if (row.runs === undefined) expect(texts[i].children).toEqual([row.kind === 'blank' ? ' ' : row.text])
      else expect(textOf(texts[i])).toBe(row.text)
    })
    for (const x of texts) expect(x).toMatchObject({ type: 'Text', props: { wrap: 'wrap' } })
    expect(JSON.stringify(pane)).not.toContain('truncate')
  })

  test('a heading row is bold and no other row is', () => {
    const pane = paneOf(t, ROWS) as any
    expect(JSON.stringify(pane).match(/"bold":true/g)).toHaveLength(5)
    expect(pane.children.filter((child: any) => child.props.bold === true).map(textOf)).toEqual(['Cache', 'Keepalive  off', 'This session', 'Advice', 'Settings'])
  })

  test('the Keepalive heading is one bold Text that wraps, holding its title untoned and its state word in the state\'s tone', () => {
    const heading = (paneOf(t, ROWS) as any).children[RUN_AT]
    expect(heading.type).toBe('Text')
    expect(propsOf(heading)).toEqual({ bold: true, wrap: 'wrap' })
    expect(heading.children).toHaveLength(2)
    const [title, state] = heading.children
    expect(title).toMatchObject({ type: 'Text', children: ['Keepalive  '] })
    expect(propsOf(title)).toEqual({})
    expect(state).toMatchObject({ type: 'Text', children: ['off'] })
    expect(propsOf(state)).toEqual({ dimColor: true })
  })

  test('a line with runs is the Text in its box indented two with the runs nested in order, each in its tone', () => {
    const pane = paneOf(t, [{ kind: 'line', text: 'ab cd', runs: [{ text: 'ab ', tone: 'quiet' }, { text: 'cd', tone: 'alarm' }] }]) as any
    expect(pane.children[0]).toMatchObject({ type: 'Box', props: { paddingLeft: 2 } })
    const text = pane.children[0].children[0]
    expect(text.type).toBe('Text')
    expect(propsOf(text)).toEqual({ wrap: 'wrap' })
    expect(text.children.map(textOf)).toEqual(['ab ', 'cd'])
    expect(text.children.map(propsOf)).toEqual([{}, { color: 'error' }])
  })

  test('a run is drawn in the props the pie draws its tone in: one palette for the pane and the pie', () => {
    const quarter: Reading = { words: '1:00', state: 'warm', quarter: 1, warn: 'quarter' }
    const tenth: Reading = { words: '0:20', state: 'warm', quarter: 1, warn: 'tenth' }
    const expired: Reading = { words: '~$0.42 to rebuild', state: 'expired', quarter: 0, warn: 'calm' }
    // A footer whose pie is in each tone: keepalive refreshing, the normal colour, amber, red, and an expired cache with keepalive off.
    const pies: Record<Tone, unknown> = {
      on: footerLine(t, state({ cost: COST }), true, noop, noop),
      quiet: footerLine(t, state(), false, noop, noop),
      warning: footerLine(t, state({ reading: quarter }), false, noop, noop),
      alarm: footerLine(t, state({ reading: tenth }), false, noop, noop),
      gone: footerLine(t, state({ reading: expired }), false, noop, noop),
    }
    for (const [tone, line] of Object.entries(pies)) {
      const pane = paneOf(t, [{ kind: 'line', text: 'x', runs: [{ text: 'x', tone: tone as Tone }] }]) as any
      expect(propsOf(pane.children[0].children[0].children[0])).toEqual(toneOf(pieOf(line)))
    }
  })

  test('the tree is the same whatever the width: it takes none', () => {
    expect(JSON.stringify(paneOf(t, ROWS))).toBe(JSON.stringify(paneOf(t, ROWS)))
    const long = 'x'.repeat(150)
    const pane = paneOf(t, [{ kind: 'line', text: long }]) as any
    expect(pane.children[0].children[0].children).toEqual([long])
  })

  test('the state word and the labels are the only coloured pieces: no other row, nor the heading\'s title, nor the rest of a labelled row, has a colour or a dim', () => {
    const pane = paneOf(t, ROWS) as any
    const [title, state] = pane.children[RUN_AT].children
    expect(propsOf(state)).toEqual({ dimColor: true })
    const rest = [...pane.children.filter((_: unknown, i: number) => i !== RUN_AT).map(withoutLabel), title]
    expect(rest).toHaveLength(ROWS.length)
    expect(JSON.stringify(rest)).not.toMatch(/"color"|"dimColor"|"backgroundColor"/)
    expect(mislabelled(pane)).toEqual([])
  })

  test('each label is the one dim first piece of its row, the rest of the row untoned, the row\'s text unchanged', () => {
    const pane = paneOf(t, ROWS) as any
    const labels = ['pie:', 'session:', 'setup:', 'best:', 'do:', 'unit:']
    const rows = pane.children.filter((row: any) => row.type === 'Box' && labels.includes(textOf(row.children[0].children[0])))
    expect(rows.map(textOf)).toEqual([
      'pie: amber ≤¼ TTL left, red ≤⅒',
      'session: no refreshes yet',
      'setup: 5m/off',
      'best: 1h/off · would have saved $1.20 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
      'unit: dollars (cost_unit) · /keepalive unit tokens|dollars',
    ])
    for (const row of rows) {
      const [label, ...rest] = row.children[0].children
      expect(propsOf(label)).toEqual({ dimColor: true })
      expect(rest.map(propsOf)).toEqual([{}])
    }
  })

  // The helper and the check are shown to fail: a tree with a stray dim piece on an unlabelled row keeps it through the helper, so the negative above would see
  // it; a tree with a labelled row left as a plain string is flagged by the check; and a tree built right passes both.
  test('the helper keeps a dim piece that is not a listed label\'s first piece, and the check flags a labelled row left as a plain string', () => {
    const dim = (text: string) => ({ text, tone: 'gone' as const })
    const quiet = (text: string) => ({ text, tone: 'quiet' as const })
    const treeOf = (rows: Parameters<typeof paneOf>[1]) => paneOf(t, rows) as any
    const NEGATIVE = /"color"|"dimColor"|"backgroundColor"/

    const right = treeOf([
      { kind: 'line', text: 'setup: 5m/off', runs: [dim('setup:'), quiet(' 5m/off')] },
      { kind: 'line', text: 'every 4:45' },
      { kind: 'line', text: 'refresh due · waits for turn end' },
    ])
    expect(JSON.stringify(right.children.map(withoutLabel))).not.toMatch(NEGATIVE)
    expect(mislabelled(right)).toEqual([])

    const stray = treeOf([{ kind: 'line', text: 'every 4:45', runs: [dim('every'), quiet(' 4:45')] }])
    expect(JSON.stringify(stray.children.map(withoutLabel))).toMatch(NEGATIVE)
    const notFirst = treeOf([{ kind: 'line', text: 'setup: 5m/off', runs: [quiet('setup:'), dim(' 5m/off')] }])
    expect(JSON.stringify(notFirst.children.map(withoutLabel))).toMatch(NEGATIVE)
    const partial = treeOf([{ kind: 'line', text: 'next best: 1h/off', runs: [dim('next'), quiet(' best: 1h/off')] }])
    expect(JSON.stringify(partial.children.map(withoutLabel))).toMatch(NEGATIVE)

    const plain = treeOf([{ kind: 'line', text: 'setup: 5m/off' }, { kind: 'line', text: 'saves ~$0.12 vs 1h/off' }, { kind: 'line', text: 'every 4:45' }])
    expect(mislabelled(plain)).toEqual(['setup: 5m/off', 'saves ~$0.12 vs 1h/off'])
  })

  test('no background, button, hover or absolute position is in the pane', () => {
    expect(JSON.stringify(paneOf(t, ROWS))).not.toMatch(/"backgroundColor"|"type":"Button"|hover|absolute/)
  })

  test('the 48-column layout\'s rows are refused by the type', () => {
    const answer = layoutOf(SNAPSHOT)
    // @ts-expect-error 48-column rows are not pane rows
    expect(paneOf(t, answer)).toBeDefined()
  })
})
