import { describe, expect, test } from 'claude-code/testing'
import { answerOf, sectionsOf, wrapLine, WRAP, type Setting, type Snapshot } from './sections'

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
  keepalive: ['keepalive on · next refresh in 4:59, 3 left', 'Next refresh: $0.006 (~33k cached tokens read).'],
  advice: ['A 1-hour cache would have saved $4.74 over 10 pauses: set "promptCacheTtl": "1h" in settings.json.'],
  settings: SETTINGS,
}
const EMPTY: Snapshot = { cache: [], keepalive: [], advice: [], settings: [] }

describe('sectionsOf: the four sections in order, each with its lines', () => {
  test('the sections come Cache, Keepalive, Advice, Settings', () => {
    expect(sectionsOf(FULL).map((s) => s.title)).toEqual(['Cache', 'Keepalive', 'Advice', 'Settings'])
  })

  test('a section with no line is absent, and no empty line is drawn', () => {
    expect(sectionsOf({ ...EMPTY, keepalive: ['keepalive off'] }).map((s) => s.title)).toEqual(['Keepalive'])
    expect(sectionsOf(EMPTY)).toEqual([])
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
    const text = answerOf({ ...EMPTY, cache: ['warm'], keepalive: ['off'] })
    expect(text).toBe('Cache\n  warm\n\nKeepalive\n  off')
  })

  test('the full answer names the four sections in order, and every figure is in one of them', () => {
    const text = answerOf(FULL)
    expect(text.split('\n').filter((line) => ['Cache', 'Keepalive', 'Advice', 'Settings'].includes(line))).toEqual(['Cache', 'Keepalive', 'Advice', 'Settings'])
    expect(text.indexOf('Keepalive')).toBeLessThan(text.indexOf('Advice'))
    expect(text.indexOf('Advice')).toBeLessThan(text.indexOf('Settings'))
    expect(text).toContain('Next refresh: $0.006')
  })
})
