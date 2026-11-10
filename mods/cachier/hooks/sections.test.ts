import { describe, expect, test } from 'claude-code/testing'
import { answerOf, layoutOf, paneLayoutOf, sectionsOf, SPAN_SPACE, wrapLine, WRAP, type AnswerRow, type PaneRow, type Setting, type Snapshot } from './sections'

// The builder takes the figures and sentences as plain values: no engine, no `$`.
const SETTINGS: Setting[] = [
  { name: 'TTL', value: '5 min', source: 'read from the last response', change: 'set "promptCacheTtl": "1h" in settings.json for 1 h (new sessions)' },
  { name: 'lead', value: '15 s', source: null, change: '/keepalive on <lead seconds>' },
  { name: 'refreshes a pause', value: 'break-even, 24', source: 'keepalive_count caps it', change: 'keepalive_count' },
  { name: 'start mode', value: 'off', source: 'keepalive_default option', change: '/keepalive default on|off, for new sessions' },
  { name: 'unit', value: 'dollars', source: 'cost_unit option', change: '/keepalive unit tokens|dollars' },
]
const FULL: Snapshot = {
  cache: ['warm · 3:12 left · 5m TTL'],
  keepalive: { state: 'on, refreshing', lines: ['next in 4:59 · 3 left', 'next refresh $0.006 (~33k read)'] },
  session: ['session: 2 refreshes · $0.007', 'misses: 1 (lapse 1) · $0.10 rewritten'],
  advice: ['A 1-hour cache would have saved $4.74 over 10 pauses: set "promptCacheTtl": "1h" in settings.json.'],
  settings: SETTINGS,
}
const EMPTY: Snapshot = { cache: [], keepalive: { state: 'off', lines: [] }, session: [], advice: [], settings: [] }

describe('sectionsOf: the five sections in order, each with its lines', () => {
  test('the sections come Cache, Keepalive, This session, Advice, Settings', () => {
    expect(sectionsOf(FULL).map((s) => s.title)).toEqual(['Cache', 'Keepalive', 'This session', 'Advice', 'Settings'])
  })

  test('a section with no line and no state is absent, and no empty line is drawn', () => {
    expect(sectionsOf({ ...EMPTY, cache: ['warm'] }).map((s) => s.title)).toEqual(['Cache', 'Keepalive'])
    expect(sectionsOf({ ...EMPTY, advice: ['a'] }).map((s) => s.title)).toEqual(['Keepalive', 'Advice'])
    expect(sectionsOf({ ...EMPTY, session: ['session: no refreshes yet'] }).map((s) => s.title)).toEqual(['Keepalive', 'This session'])
  })

  test('a section that carries a state is never left out: the Keepalive section is there with no line, and only it carries a state', () => {
    expect(sectionsOf(EMPTY)).toEqual([{ title: 'Keepalive', state: 'off', lines: [] }])
    expect(sectionsOf(FULL).map((s) => s.state)).toEqual([null, 'on, refreshing', null, null, null])
  })

  test('a setting is one line: its name, its value, its source in brackets when there is one, and its change', () => {
    const lines = sectionsOf({ ...EMPTY, settings: SETTINGS }).find((s) => s.title === 'Settings')!.lines
    expect(lines[0]).toBe('TTL 5 min (read from the last response): set "promptCacheTtl": "1h" in settings.json for 1 h (new sessions).')
    expect(lines[1]).toBe('lead 15 s: /keepalive on <lead seconds>.')
  })
})

describe('wrapLine: at the wrap width, continuation lines indented, no word lost', () => {
  test('every line is no wider than the wrap width', () => {
    const text = 'Over ten pauses this session, keepalive saved $0.42 net against the other setting, and the learned count covers 5:00.'
    for (const line of wrapLine(text)) expect(line.length).toBeLessThanOrEqual(WRAP)
  })

  test('the first line is indented two, the rest four, and the words come back in order', () => {
    const text = 'Over ten pauses this session, keepalive saved $0.42 net against the other setting, and the learned count covers 5:00.'
    const lines = wrapLine(text)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0]?.startsWith('  ')).toBe(true)
    expect(lines[0]?.startsWith('   ')).toBe(false)
    for (const line of lines.slice(1)) expect(line.startsWith('    ')).toBe(true)
    expect(lines.map((line) => line.trim()).join(' ')).toBe(text)
  })

  test('a span joined by the span space stays whole on one row, moves whole to the next row, and prints with plain spaces', () => {
    const command = ['/keepalive', 'on', '15'].join(SPAN_SPACE)
    const text = `Over ten pauses this session, keepalive run ${command} or click the pie on.`
    const lines = wrapLine(text)
    expect(lines).toEqual(['  Over ten pauses this session, keepalive run', '    /keepalive on 15 or click the pie on.'])
    for (const line of lines) expect(line).not.toContain(SPAN_SPACE)
  })

  test('a line with no span wraps as before, and a span that fits stays where it is', () => {
    expect(wrapLine('one two three', 10)).toEqual(['  one two', '    three'])
    expect(wrapLine(`run ${['/keepalive', 'off'].join(SPAN_SPACE)} now`)).toEqual(['  run /keepalive off now'])
  })

  test('a short line is one line, indented two', () => {
    expect(wrapLine('short')).toEqual(['  short'])
  })
})

describe('answerOf: the sections as the bare command answers them', () => {
  test('each section is its name on a line of its own, then its lines, and sections are separated by a blank line', () => {
    const text = answerOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', lines: ['why'] } })
    expect(text).toBe('Cache\n  warm\n\nKeepalive  paused\n  why')
  })

  test('the full answer names the five sections in order, and every figure is in one of them', () => {
    const text = answerOf(FULL)
    const headings = ['Cache', 'Keepalive  on, refreshing', 'This session', 'Advice', 'Settings']
    expect(text.split('\n').filter((line) => headings.includes(line))).toEqual(headings)
    expect(text.indexOf('Keepalive  on, refreshing')).toBeLessThan(text.indexOf('This session'))
    expect(text.indexOf('This session')).toBeLessThan(text.indexOf('Advice'))
    expect(text.indexOf('Advice')).toBeLessThan(text.indexOf('Settings'))
    expect(text).toContain('next refresh $0.006')
  })
})

describe('layoutOf: the rows the answer is joined from, a heading row marked and no other row', () => {
  test('the rows, joined, are the answer: each section a heading row then its wrapped lines, and one blank row between sections', () => {
    expect(layoutOf(FULL).map((row) => row.text).join('\n')).toBe(answerOf(FULL))
    expect(layoutOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', lines: ['why'] } }).map((row) => row.text)).toEqual(['Cache', '  warm', '', 'Keepalive  paused', '  why'])
  })

  test('only the heading rows are marked, in an answer with all five sections and in one with a section left out', () => {
    expect(layoutOf(FULL).filter((row) => row.heading).map((row) => row.text)).toEqual(['Cache', 'Keepalive  on, refreshing', 'This session', 'Advice', 'Settings'])
    expect(layoutOf({ ...FULL, advice: [] }).filter((row) => row.heading).map((row) => row.text)).toEqual(['Cache', 'Keepalive  on, refreshing', 'This session', 'Settings'])
    expect(layoutOf({ ...FULL, session: [] }).filter((row) => row.heading).map((row) => row.text)).toEqual(['Cache', 'Keepalive  on, refreshing', 'Advice', 'Settings'])
  })

  test('exactly one blank row stands between two sections, and none before the first or after the last', () => {
    for (const snap of [FULL, { ...FULL, advice: [] }]) {
      const rows = layoutOf(snap)
      const headings = rows.flatMap((row, i) => (row.heading ? [i] : []))
      const blanks = rows.flatMap((row, i) => (row.text === '' ? [i] : []))
      expect(blanks).toEqual(headings.slice(1).map((i) => i - 1))
      expect(rows[0]?.heading).toBe(true)
      expect(rows.at(-1)?.text).not.toBe('')
    }
  })

  test('a line of several words longer than the wrap is several rows, none marked, each no wider than the wrap unless one word is', () => {
    const text = 'Over ten pauses this session, keepalive saved $0.42 net against the other setting, and the learned count covers 5:00.'
    const rows = layoutOf({ ...EMPTY, cache: [text] }).slice(1, -2)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.some((row) => row.heading)).toBe(false)
    expect(rows.every((row) => row.text.length <= WRAP || !row.text.trim().includes(' '))).toBe(true)
    expect(rows.map((row) => row.text.trim()).join(' ')).toBe(text)
  })

  test('a heading row is the title alone, or the title, two spaces and the state, and is marked either way', () => {
    expect(layoutOf({ ...EMPTY, cache: ['warm'] }).filter((row) => row.heading)).toEqual([
      { text: 'Cache', heading: true, wrapped: true },
      { text: 'Keepalive  off', heading: true, wrapped: true },
    ])
  })

  test('a Snapshot with keepalive off and no line anywhere lays out the one marked row Keepalive  off', () => {
    expect(layoutOf(EMPTY)).toEqual([{ text: 'Keepalive  off', heading: true, wrapped: true }])
    expect(answerOf(EMPTY)).toBe('Keepalive  off')
  })
})

const CMD = `run /keepalive${SPAN_SPACE}on${SPAN_SPACE}15 or click the pie on, and /keepalive${SPAN_SPACE}default${SPAN_SPACE}on for new sessions`

describe('paneLayoutOf: the pane\'s rows, kinded and unwrapped, with the size it asks for', () => {
  test('a heading, each line whole, and one blank between sections, each with its kind and no indent', () => {
    const { rows } = paneLayoutOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', lines: [CMD] } })
    expect(rows.map((row) => row.kind)).toEqual(['heading', 'line', 'blank', 'heading', 'line'])
    expect(rows.map((row) => row.text)).toEqual(['Cache', 'warm', '', 'Keepalive  paused', CMD.split(SPAN_SPACE).join(' ')])
  })

  test('no row holds a no-break space, and a long line is one row', () => {
    const long = `${'word '.repeat(60)}${CMD}`
    const { rows } = paneLayoutOf({ ...FULL, advice: [long] })
    expect(rows.some((row) => row.text.includes(SPAN_SPACE))).toBe(false)
    expect(rows.filter((row) => row.kind === 'line' && row.text.startsWith('word word'))).toHaveLength(1)
  })

  test('the rows, joined on whitespace, are the answer joined on whitespace', () => {
    for (const snap of [FULL, EMPTY, { ...FULL, advice: [CMD] }]) {
      const flat = (texts: string[]) => texts.join(' ').split(/\s+/).filter(Boolean).join(' ')
      expect(flat(paneLayoutOf(snap).rows.map((row) => row.text))).toBe(flat(answerOf(snap).split('\n')))
    }
  })

  test('the size is the count and longest row of the 48-column layout of the same content', () => {
    for (const snap of [FULL, EMPTY, { ...FULL, advice: [CMD] }]) {
      const rows = layoutOf(snap)
      expect(paneLayoutOf(snap).size).toEqual({ rows: rows.length, columns: Math.max(...rows.map((row) => row.text.length)) })
    }
  })

  test('the 48-column layout is unchanged in text: indents, wrap and commands whole', () => {
    const text = layoutOf({ ...EMPTY, cache: [CMD] }).map((row) => row.text)
    expect(text.every((row) => row.length <= WRAP)).toBe(true)
    expect(text.some((row) => row.includes('/keepalive on 15'))).toBe(true)
    expect(text.some((row) => row.includes('/keepalive default on'))).toBe(true)
  })

  test('the two row types are not assignable to each other', () => {
    const answer: AnswerRow = layoutOf(EMPTY)[0] as AnswerRow
    const pane: PaneRow = paneLayoutOf(EMPTY).rows[0] as PaneRow
    // @ts-expect-error a pane row is not a 48-column row
    const asAnswer: AnswerRow = pane
    // @ts-expect-error a 48-column row is not a pane row
    const asPane: PaneRow = answer
    expect([asAnswer, asPane]).toHaveLength(2)
  })
})
