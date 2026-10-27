import { describe, expect, test } from 'claude-code/testing'
import type { HintState, Reading } from '../types'
import { adviceRowsOf, footerLine, paneLines, paneOf, paneSize } from './hint'

// A table that builds the elements as plain data, the way a surface's table hands them out.
const table = {
  Box: (p: { children?: unknown } & Record<string, unknown>) => ({ type: 'Box', props: { ...p, children: undefined }, children: p.children }),
  Text: (p: { children?: unknown } & Record<string, unknown>) => ({ type: 'Text', props: { ...p, children: undefined }, children: p.children }),
  Button: (p: Record<string, unknown>) => ({ type: 'Button', props: p }),
}
const t = table as any
const noop = () => {}
const WARMTH = 'Prompt cache warm, 3:12 left (5-minute cache)'
const WARN = "The pie turns amber in the cache's last quarter and red in its last tenth: the cache is about to lapse."
const OFF = `Keepalive is off. ${WARN}`
const WARM: Reading = { words: '3:12', state: 'warm', quarter: 3, warn: 'calm' }
const COST = { label: '$0.006/refresh', explain: 'Next refresh: $0.006 (~33k cached tokens read).', figures: 'One refresh every 4:45.' }
// What one refresh would cost if a press turned keepalive on now, as the state carries it while keepalive is off.
const OFFER = { label: '$0.006/refresh', explain: 'Next refresh: $0.006 (~33k cached tokens read).', figures: 'One refresh every 3:30.' }
const state = (extra: Partial<HintState> = {}): HintState => ({
  reading: WARM,
  cost: null,
  offer: null,
  paused: null,
  warmth: WARMTH,
  breakEven: '',
  ...extra,
})
// The footer's parts: the pie button, the separator, and the time (a keyed Box of the time's button and its hover reveal). A line with
// no time is the pie alone.
const pieOf = (line: any) => (line.props.key === 'pie-box' ? line : line.children[0]).children[0]
// The pie's keyed Box, which holds the pie and its hover popup: the line's first child, or the line itself with no time.
const pieBoxOf = (line: any) => (line.props.key === 'pie-box' ? line : line.children[0])
const timeOf = (line: any) => line.children[2]
const glyphOf = (pie: any) => pie.props.children[0].children[0]
const toneOf = (pie: any) => pie.props.children[0].props
const revealOf = (line: any) => timeOf(line).children[1]

describe('footerLine: the pie, and the time beside it', () => {
  test('with no line to show, there is no element', () => {
    expect(footerLine(t, null, false, noop, noop)).toBeNull()
    expect(footerLine(t, state({ reading: null }), false, noop, noop)).toBeNull()
  })

  test('nothing to count with keepalive on is the pie alone, empty and green', () => {
    const pie = footerLine(t, state({ reading: null }), true, noop, noop) as any
    expect(pie.props.key).toBe('pie-box')
    expect(glyphOf(pieOf(pie))).toBe('○')
    expect(toneOf(pieOf(pie))).toEqual({ color: 'success' })
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
    expect(toneOf(pieOf(footerLine(t, state({ reading: tenth, paused: 'x' }), true, noop, noop)))).toEqual({ color: 'error' })
  })

  test('an expired cache is an empty pie and the rebuild figure, red with keepalive on and dim off', () => {
    const expired: Reading = { words: '~$0.42 to rebuild', state: 'expired', quarter: 0, warn: 'calm' }
    const on = footerLine(t, state({ reading: expired }), true, noop, noop) as any
    expect(glyphOf(pieOf(on))).toBe('○')
    expect(toneOf(pieOf(on))).toEqual({ color: 'error' })
    expect(timeOf(on).children[0].props).toMatchObject({ children: ['~$0.42 to rebuild'], dimColor: true })
    expect(toneOf(pieOf(footerLine(t, state({ reading: expired }), false, noop, noop)))).toEqual({ dimColor: true })
  })

  test('a cold cache is an empty pie with no time: green with keepalive on, dim off', () => {
    const cold: Reading = { words: '', state: 'cold', quarter: 0, warn: 'calm' }
    const on = footerLine(t, state({ reading: cold }), true, noop, noop) as any
    expect(on.props.key).toBe('pie-box')
    expect(toneOf(pieOf(on))).toEqual({ color: 'success' })
    const off = footerLine(t, state({ reading: cold }), false, noop, noop) as any
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
    const line = footerLine(t, state({ cost: COST, paused: 'x' }), true, noop, noop) as any
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
    expect(reveal(footerLine(t, state({ paused: 'x' }), true, noop, noop))).toMatchObject({ children: [{ children: ['cache keepalive is paused'] }] })
    expect(reveal(footerLine(t, state(), false, noop, noop))).toMatchObject({ children: [{ children: ['cache keepalive is off'] }] })
  })

  test('the pie box holds the pie and its popup, and the popup moves nothing: the pie stays the box\'s first child', () => {
    const line = footerLine(t, state({ cost: COST }), true, noop, noop) as any
    expect(pieBoxOf(line).props).toMatchObject({ key: 'pie-box', flexDirection: 'row' })
    expect(pieBoxOf(line).children[0]).toMatchObject({ type: 'Button', props: { key: 'pie' } })
  })
})

const SESSION = 'This session: 2 refreshes costing ~33k tokens read.'
const BREAK_EVEN = "Keepalive pays off if you're back between 5:00 and 19:15."

describe('paneLines: the lines the details pane holds', () => {
  test('keepalive off: the warmth, the state with what its colours warn of, and what one refresh would cost, as the state offers it', () => {
    expect(paneLines(state({ offer: OFFER }), false, '')).toEqual([WARMTH, OFF, OFFER.explain, OFFER.figures])
  })

  test('keepalive off with no figure to offer: the warmth and the state alone', () => {
    expect(paneLines(state(), false, '')).toEqual([WARMTH, OFF])
  })

  test('the offer is stated only while keepalive is off, and the colours\' warning only then', () => {
    expect(paneLines(state({ offer: OFFER }), true, '')).not.toContain(OFFER.explain)
    expect(paneLines(state({ cost: COST }), true, '')).not.toContain(OFF)
  })

  test('refreshing: the state, and the refresh\'s cost and interval, with no sentence about a click', () => {
    expect(paneLines(state({ cost: COST }), true, '')).toEqual([WARMTH, 'Keepalive is on and refreshing the cache.', COST.explain, COST.figures])
  })

  test('paused: why, with no refresh cost, and what the colours warn of', () => {
    expect(paneLines(state({ paused: 'the cache expired; it resumes after your next prompt' }), true, '')).toEqual([
      WARMTH,
      `Keepalive is paused: the cache expired; it resumes after your next prompt. ${WARN}`,
    ])
  })

  test('the break-even line and the session tally follow the state, each left out when empty', () => {
    expect(paneLines(state({ offer: OFFER, breakEven: BREAK_EVEN }), false, SESSION)).toEqual([WARMTH, OFF, OFFER.explain, OFFER.figures, BREAK_EVEN, SESSION])
    expect(paneLines(state({ breakEven: '' }), false, '')).toEqual([WARMTH, OFF])
  })

  test('with no cache to count the warmth is left out; with no transcript state the pane keeps the keepalive sentence alone', () => {
    expect(paneLines(state({ reading: null, warmth: '' }), false, '')).toEqual([OFF])
    expect(paneLines(null, true, '')).toEqual(['Keepalive is on, with no cache to count from yet.'])
    expect(paneLines(null, false, '')).toEqual([OFF])
  })

  test('no history sentence is in it, and no sentence says ping, armed, cold or par, or asks for a click, whatever the state', () => {
    const full = state({ offer: OFFER, breakEven: BREAK_EVEN })
    const panes = [
      paneLines(full, false, SESSION),
      paneLines({ ...full, cost: COST }, true, SESSION),
      paneLines({ ...full, paused: 'its refreshes for this pause are used up; it resumes after your next prompt' }, true, SESSION),
      paneLines({ ...full, paused: 'the cache expired; it resumes after your next prompt' }, true, SESSION),
    ]
    for (const line of panes.flat()) {
      expect(line).not.toMatch(/ping|armed|cold|\bpar\b/i)
      expect(line).not.toMatch(/click|Learned|Earlier pauses|Shown in tokens|Longest|Lapse misses|The pie is/i)
    }
  })
})

describe('paneSize: the rows and columns the pane asks for, its lines\' count and longest line', () => {
  test('one row per line, and the columns of the longest line', () => {
    expect(paneSize(['ab', 'abc'])).toEqual({ rows: 2, columns: 3 })
    expect(paneSize([OFF])).toEqual({ rows: 1, columns: OFF.length })
  })
})

describe('paneOf: the sentences as text, one row each, with no switch', () => {
  test('one row per sentence, cut at the pane\'s width rather than wrapped, and no button in it', () => {
    const pane = paneOf(t, ['a', 'b']) as any
    expect(pane.children).toHaveLength(2)
    expect(pane.children[0]).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' }, children: ['a'] })
    expect(pane.children[1]).toMatchObject({ type: 'Text', props: { wrap: 'truncate-end' }, children: ['b'] })
    expect(JSON.stringify(pane)).not.toMatch(/"type":"Button"|Turn keepalive/)
  })

  test('nothing in it is hovered or positioned absolutely', () => {
    expect(JSON.stringify(paneOf(t, [WARMTH, OFF]))).not.toMatch(/hover|absolute/)
  })
})

describe('adviceRowsOf: the advice sentence as the pane\'s first rows', () => {
  const SENTENCE = 'A 1-hour cache with keepalive off would have saved $1.20 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json and, in the new session, click the pie off.'

  test('wrapped at the widest other line, at least 48 columns, with no indent and no word cut', () => {
    const rows = adviceRowsOf(SENTENCE, ['short'])
    expect(rows.every((row) => row.length <= 48 && !row.startsWith(' '))).toBe(true)
    expect(rows.join(' ')).toBe(SENTENCE)
    expect(rows.length).toBeGreaterThan(2)
  })

  test('a wider other line widens the rows to match it', () => {
    const rows = adviceRowsOf(SENTENCE, ['y'.repeat(70)])
    expect(rows.every((row) => row.length <= 70)).toBe(true)
    expect(rows[0]!.length).toBeGreaterThan(48)
    expect(rows.join(' ')).toBe(SENTENCE)
  })

  test('no sentence, no rows', () => {
    expect(adviceRowsOf('', ['short'])).toEqual([])
  })
})
