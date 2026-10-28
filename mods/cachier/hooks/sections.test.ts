import { describe, expect, test } from 'claude-code/testing'
import { answerOf, layoutOf, sectionsOf, wrapLine, WRAP, type Setting, type Snapshot } from './sections'

// The builder takes the figures and sentences as plain values: no engine, no `$`.
const SETTINGS: Setting[] = [
  { name: 'TTL', value: '5 min', source: 'read from the last response', change: 'set "promptCacheTtl": "1h" in settings.json for 1 h (new sessions)' },
  { name: 'lead', value: '15 s', source: null, change: '/keepalive on <lead seconds>' },
  { name: 'refreshes a pause', value: 'break-even, 24', source: 'keepalive_count caps it', change: 'keepalive_count' },
  { name: 'start mode', value: 'off', source: 'keepalive_default option', change: '/keepalive default on|off, for new sessions' },
  { name: 'unit', value: 'dollars', source: 'cost_unit option', change: '/keepalive unit tokens|dollars' },
]
const FULL: Snapshot = {
  cache: ['Prompt cache warm, 3:12 left (5-minute cache)'],
  keepalive: { state: 'on, refreshing', lines: ['next refresh in 4:59, 3 left', 'Next refresh: $0.006 (~33k cached tokens read).'] },
  advice: ['A 1-hour cache would have saved $4.74 over 10 pauses: set "promptCacheTtl": "1h" in settings.json.'],
  settings: SETTINGS,
}
const EMPTY: Snapshot = { cache: [], keepalive: { state: 'off', lines: [] }, advice: [], settings: [] }

describe('sectionsOf: the four sections in order, each with its lines', () => {
  test('the sections come Cache, Keepalive, Advice, Settings', () => {
    expect(sectionsOf(FULL).map((s) => s.title)).toEqual(['Cache', 'Keepalive', 'Advice', 'Settings'])
  })

  test('a section with no line and no state is absent, and no empty line is drawn', () => {
    expect(sectionsOf({ ...EMPTY, cache: ['warm'] }).map((s) => s.title)).toEqual(['Cache', 'Keepalive'])
    expect(sectionsOf({ ...EMPTY, advice: ['a'] }).map((s) => s.title)).toEqual(['Keepalive', 'Advice'])
  })

  test('a section that carries a state is never left out: the Keepalive section is there with no line, and only it carries a state', () => {
    expect(sectionsOf(EMPTY)).toEqual([{ title: 'Keepalive', state: 'off', lines: [] }])
    expect(sectionsOf(FULL).map((s) => s.state)).toEqual([null, 'on, refreshing', null, null])
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

  test('a short line is one line, indented two', () => {
    expect(wrapLine('short')).toEqual(['  short'])
  })
})

describe('answerOf: the sections as the bare command answers them', () => {
  test('each section is its name on a line of its own, then its lines, and sections are separated by a blank line', () => {
    const text = answerOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', lines: ['why'] } })
    expect(text).toBe('Cache\n  warm\n\nKeepalive  paused\n  why')
  })

  test('the full answer names the four sections in order, and every figure is in one of them', () => {
    const text = answerOf(FULL)
    expect(text.split('\n').filter((line) => ['Cache', 'Keepalive  on, refreshing', 'Advice', 'Settings'].includes(line))).toEqual(['Cache', 'Keepalive  on, refreshing', 'Advice', 'Settings'])
    expect(text.indexOf('Keepalive  on, refreshing')).toBeLessThan(text.indexOf('Advice'))
    expect(text.indexOf('Advice')).toBeLessThan(text.indexOf('Settings'))
    expect(text).toContain('Next refresh: $0.006')
  })
})

describe('layoutOf: the rows the answer is joined from, a heading row marked and no other row', () => {
  test('the rows, joined, are the answer: each section a heading row then its wrapped lines, and one blank row between sections', () => {
    expect(layoutOf(FULL).map((row) => row.text).join('\n')).toBe(answerOf(FULL))
    expect(layoutOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', lines: ['why'] } }).map((row) => row.text)).toEqual(['Cache', '  warm', '', 'Keepalive  paused', '  why'])
  })

  test('only the heading rows are marked, in an answer with all four sections and in one with a section left out', () => {
    expect(layoutOf(FULL).filter((row) => row.heading).map((row) => row.text)).toEqual(['Cache', 'Keepalive  on, refreshing', 'Advice', 'Settings'])
    expect(layoutOf({ ...FULL, advice: [] }).filter((row) => row.heading).map((row) => row.text)).toEqual(['Cache', 'Keepalive  on, refreshing', 'Settings'])
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
      { text: 'Cache', heading: true },
      { text: 'Keepalive  off', heading: true },
    ])
  })

  test('a Snapshot with keepalive off and no line anywhere lays out the one marked row Keepalive  off', () => {
    expect(layoutOf(EMPTY)).toEqual([{ text: 'Keepalive  off', heading: true }])
    expect(answerOf(EMPTY)).toBe('Keepalive  off')
  })
})
