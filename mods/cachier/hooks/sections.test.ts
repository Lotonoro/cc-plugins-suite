import { describe, expect, test } from 'claude-code/testing'
import type { Run, Tone } from './countdown'
import { answerOf, layoutOf, paneLayoutOf, plainOf, sectionsOf, spanOf, SPAN_SPACE, wrapLine, WRAP, type AnswerRow, type PaneRow, type Setting, type Snapshot } from './sections'

// The builder takes the figures and sentences as plain values: no engine, no `$`. A command in a setting's change is one span, as the command gives it.
const SETTINGS: Setting[] = [
  { name: 'TTL', value: '5m', source: 'last response', change: 'set "promptCacheTtl": "1h" in settings.json for 1h (new sessions)' },
  { name: 'lead', value: '15s', source: null, change: spanOf('/keepalive on <lead_s>') },
  { name: 'refreshes/pause', value: 'break-even', source: 'keepalive_count cap', change: `${spanOf('/keepalive on <lead_s> <count>')} or keepalive_count` },
  { name: 'start mode', value: 'off', source: 'keepalive_default', change: `${spanOf('/keepalive default on|off')} (new sessions)` },
  { name: 'unit', value: 'dollars', source: 'cost_unit', change: spanOf('/keepalive unit tokens|dollars') },
]
const FULL: Snapshot = {
  cache: ['warm · 3:12 left · 5m TTL'],
  keepalive: { state: 'on, refreshing', tone: 'on', lines: ['next in 4:59 · 3 left', 'next refresh $0.006 (~33k read)'] },
  session: ['session: 2 refreshes · $0.007', 'misses: 1 (lapse 1) · $0.10 rewritten'],
  advice: ['setup: 5m/off', 'other TTL: 1h/off · would have saved $4.74 (10 priced pauses, all sessions)', 'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)'],
  settings: SETTINGS,
}
const EMPTY: Snapshot = { cache: [], keepalive: { state: 'off', tone: 'gone', lines: [] }, session: [], advice: [], settings: [] }

describe('sectionsOf: the five sections in order, each with its lines', () => {
  test('the sections come Cache, Keepalive, This session, Advice, Settings', () => {
    expect(sectionsOf(FULL).map((s) => s.title)).toEqual(['Cache', 'Keepalive', 'This session', 'Advice', 'Settings'])
  })

  test('a section with no line and no state is absent, and no empty line is drawn', () => {
    expect(sectionsOf({ ...EMPTY, cache: ['warm'] }).map((s) => s.title)).toEqual(['Cache', 'Keepalive'])
    expect(sectionsOf({ ...EMPTY, advice: ['a'] }).map((s) => s.title)).toEqual(['Keepalive', 'Advice'])
    expect(sectionsOf({ ...EMPTY, session: ['session: no refreshes yet'] }).map((s) => s.title)).toEqual(['Keepalive', 'This session'])
  })

  test('a section that carries a state is never left out: the Keepalive section is there with no line, and only it carries a state, which comes with its tone', () => {
    expect(sectionsOf(EMPTY)).toEqual([{ title: 'Keepalive', state: { text: 'off', tone: 'gone' }, lines: [] }])
    expect(sectionsOf(FULL).map((s) => s.state)).toEqual([null, { text: 'on, refreshing', tone: 'on' }, null, null, null])
  })

  test('a setting is one line: its name, its value, its source in brackets when there is one, and its change, with no full stop', () => {
    const lines = sectionsOf({ ...EMPTY, settings: SETTINGS }).find((s) => s.title === 'Settings')!.lines
    expect(lines).toHaveLength(5)
    expect(plainOf(lines[0]!)).toBe('TTL: 5m (last response) · set "promptCacheTtl": "1h" in settings.json for 1h (new sessions)')
    expect(plainOf(lines[1]!)).toBe(`lead: 15s · ${['/keepalive', 'on', '<lead_s>'].join(SPAN_SPACE)}`)
    expect(plainOf(lines[2]!)).toBe(`refreshes/pause: break-even (keepalive_count cap) · ${['/keepalive', 'on', '<lead_s>', '<count>'].join(SPAN_SPACE)} or keepalive_count`)
    expect(lines.some((line) => plainOf(line).endsWith('.'))).toBe(false)
  })

  test('a setting\'s line is its name and colon as one dim piece, then the rest of the line as one untoned piece', () => {
    const lines = sectionsOf({ ...EMPTY, settings: SETTINGS }).find((s) => s.title === 'Settings')!.lines
    expect(lines).toHaveLength(SETTINGS.length)
    SETTINGS.forEach((setting, i) => {
      const pieces = lines[i] as Run[]
      expect(Array.isArray(pieces)).toBe(true)
      expect(pieces).toHaveLength(2)
      expect(pieces[0]).toEqual({ text: `${setting.name}:`, tone: 'gone' })
      expect(pieces[1]!.tone).toBe('quiet')
      expect(pieces[1]!.text.startsWith(' ')).toBe(true)
    })
  })

  test('a setting\'s pieces joined are the line the answer wraps, so the bare answer is as it was', () => {
    const lines = sectionsOf({ ...EMPTY, settings: SETTINGS }).find((s) => s.title === 'Settings')!.lines
    lines.forEach((line, i) => {
      const setting = SETTINGS[i]!
      const source = setting.source === null ? '' : ` (${setting.source})`
      expect(plainOf(line)).toBe(`${setting.name}: ${setting.value}${source} · ${setting.change}`)
    })
  })

  test('the Settings rows at 48 columns keep each command whole on a row, the TTL step wrapping as words', () => {
    const rows = layoutOf({ ...EMPTY, settings: SETTINGS }).map((row) => row.text)
    expect(rows.slice(rows.indexOf('Settings') + 1)).toEqual([
      '  TTL: 5m (last response) · set',
      '    "promptCacheTtl": "1h" in settings.json for',
      '    1h (new sessions)',
      '  lead: 15s · /keepalive on <lead_s>',
      '  refreshes/pause: break-even (keepalive_count',
      '    cap) · /keepalive on <lead_s> <count> or',
      '    keepalive_count',
      '  start mode: off (keepalive_default) ·',
      '    /keepalive default on|off (new sessions)',
      '  unit: dollars (cost_unit) ·',
      '    /keepalive unit tokens|dollars',
    ])
  })
})

describe('spanOf: the words of a command or a setup token joined into one unbreakable span', () => {
  test('each space becomes the span space, and a text with none is unchanged', () => {
    expect(spanOf('/keepalive on <lead_s> <count>')).toBe(['/keepalive', 'on', '<lead_s>', '<count>'].join(SPAN_SPACE))
    expect(spanOf('5m/paused (lead 300s ≥ 300s TTL)')).toBe(['5m/paused', '(lead', '300s', '≥', '300s', 'TTL)'].join(SPAN_SPACE))
    expect(spanOf('keepalive_count')).toBe('keepalive_count')
  })

  test('a span moves whole to the next row where the same words, unjoined, would break between them', () => {
    const lead = 'refreshes/pause: break-even · '
    expect(wrapLine(`${lead}${spanOf('/keepalive on <lead_s> <count>')} or keepalive_count`)).toEqual([
      '  refreshes/pause: break-even ·',
      '    /keepalive on <lead_s> <count> or',
      '    keepalive_count',
    ])
    expect(wrapLine(`${lead}/keepalive on <lead_s> <count> or keepalive_count`)).toEqual([
      '  refreshes/pause: break-even · /keepalive on',
      '    <lead_s> <count> or keepalive_count',
    ])
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
    const text = answerOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', tone: 'warning', lines: ['why'] } })
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
    expect(layoutOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', tone: 'warning', lines: ['why'] } }).map((row) => row.text)).toEqual(['Cache', '  warm', '', 'Keepalive  paused', '  why'])
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
    const { rows } = paneLayoutOf({ ...EMPTY, cache: ['warm'], keepalive: { state: 'paused', tone: 'warning', lines: [CMD] } })
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

// The states a Keepalive heading carries and the tone each is drawn in, as the builder is handed them: it knows no state's words.
const STATES: { word: string; tone: Tone }[] = [
  { word: 'off', tone: 'gone' },
  { word: 'on, refreshing', tone: 'on' },
  { word: 'on, no count', tone: 'warning' },
  { word: 'paused', tone: 'warning' },
  { word: 'stopped', tone: 'alarm' },
]
const TONES: Tone[] = ['on', 'quiet', 'warning', 'alarm', 'gone']
const stated = (word: string, tone: Tone, base: Snapshot = FULL): Snapshot => ({ ...base, keepalive: { state: word, tone, lines: ['why'] } })

describe('paneLayoutOf: toned runs, the pieces of a row\'s text each drawn in a tone', () => {
  test('the Keepalive heading holds its title with the gap untoned, then its state word in the state\'s tone, in each state', () => {
    for (const { word, tone } of STATES) {
      const heading = paneLayoutOf(stated(word, tone)).rows.find((row) => row.kind === 'heading' && row.text.startsWith('Keepalive'))
      expect(heading?.text).toBe(`Keepalive  ${word}`)
      expect(heading?.runs).toEqual([{ text: 'Keepalive  ', tone: 'quiet' }, { text: word, tone }])
    }
  })

  test('each row with runs reads exactly its text when they are joined, and every row other than the Keepalive heading and the Settings rows has none, in each state', () => {
    for (const { word, tone } of STATES) {
      for (const base of [FULL, EMPTY, { ...FULL, advice: [], session: [] }]) {
        const { rows } = paneLayoutOf(stated(word, tone, base))
        for (const row of rows) if (row.runs !== undefined) expect(row.runs.map((run) => run.text).join('')).toBe(row.text)
        const settings = rows.findIndex((row) => row.kind === 'heading' && row.text === 'Settings')
        const settingRows = settings < 0 ? [] : rows.slice(settings + 1).map((row) => row.text)
        expect(settingRows).toHaveLength(base.settings.length)
        expect(rows.filter((row) => row.runs !== undefined).map((row) => row.text)).toEqual([`Keepalive  ${word}`, ...settingRows])
      }
    }
  })

  test('a tone adds no text: the answer, the 48-column rows, the pane rows\' text and the size it asks for are the same in every tone', () => {
    const plain = stated('paused', 'warning')
    for (const tone of TONES) {
      const toned = stated('paused', tone)
      expect(answerOf(toned)).toBe(answerOf(plain))
      expect(layoutOf(toned)).toEqual(layoutOf(plain))
      expect(paneLayoutOf(toned).rows.map((row) => row.text)).toEqual(paneLayoutOf(plain).rows.map((row) => row.text))
      expect(paneLayoutOf(toned).size).toEqual(paneLayoutOf(plain).size)
    }
    expect(layoutOf(plain).some((row) => 'runs' in row)).toBe(false)
  })
})

// A line given as its runs: the pieces of its text, each in a tone. Each line part brings one, with a toned piece among untoned ones and a command as
// a span at a place where the wrap would otherwise break it. `BY_TEXT` is the same snapshot with each of those lines as its plain text, spans kept.
const run = (text: string, tone: Tone = 'quiet'): Run => ({ text, tone })
const joined = (runs: Run[]): string => runs.map((r) => r.text).join('')
const tail = (command: string) => `run ${command} or click the pie on`
const SPANNED = tail(spanOf('/keepalive on 15'))
const PLAIN_TAIL = tail('/keepalive on 15')
const CACHE_RUNS = [run('◕', 'on'), run(` warm · 3:12 left · 5m TTL · ${SPANNED}`)]
const KEEPALIVE_RUNS = [run('pie: '), run('amber', 'warning'), run(` ≤¼ TTL left, red ≤⅒, ${SPANNED}`)]
const SESSION_RUNS = [run('session: '), run('2 refreshes', 'on'), run(` · $0.007 · ${SPANNED}`)]
const ADVICE_RUNS = [run('do: '), run('set the lead', 'alarm'), run(` first, then ${SPANNED}`)]
const BY_RUNS: Snapshot = {
  cache: [CACHE_RUNS],
  keepalive: { state: 'paused', tone: 'warning', lines: ['why', KEEPALIVE_RUNS] },
  session: [SESSION_RUNS, 'balance'],
  advice: [ADVICE_RUNS],
  settings: SETTINGS,
}
const BY_TEXT: Snapshot = {
  cache: [joined(CACHE_RUNS)],
  keepalive: { state: 'paused', tone: 'warning', lines: ['why', joined(KEEPALIVE_RUNS)] },
  session: [joined(SESSION_RUNS), 'balance'],
  advice: [joined(ADVICE_RUNS)],
  settings: SETTINGS,
}
// Each of those lines as the pane draws it and the answer states it unwrapped, spans as plain spaces.
const PLAIN = {
  cache: `◕ warm · 3:12 left · 5m TTL · ${PLAIN_TAIL}`,
  keepalive: `pie: amber ≤¼ TTL left, red ≤⅒, ${PLAIN_TAIL}`,
  session: `session: 2 refreshes · $0.007 · ${PLAIN_TAIL}`,
  advice: `do: set the lead first, then ${PLAIN_TAIL}`,
}

describe('lines given as runs: the pieces of a line, each in a tone, in the Cache, Keepalive, This session and Advice parts', () => {
  test('a section\'s lines are the snapshot\'s lines as given, plain text or runs, in each part', () => {
    const lines = (title: string) => sectionsOf(BY_RUNS).find((s) => s.title === title)?.lines
    expect(lines('Cache')).toEqual([CACHE_RUNS])
    expect(lines('Keepalive')).toEqual(['why', KEEPALIVE_RUNS])
    expect(lines('This session')).toEqual([SESSION_RUNS, 'balance'])
    expect(lines('Advice')).toEqual([ADVICE_RUNS])
  })

  test('the bare answer draws a line given as runs as its plain text: the answer, its rows and the pane\'s text and size are those of the same lines as plain text', () => {
    expect(answerOf(BY_RUNS)).toBe(answerOf(BY_TEXT))
    expect(layoutOf(BY_RUNS)).toEqual(layoutOf(BY_TEXT))
    expect(paneLayoutOf(BY_RUNS).rows.map((row) => row.text)).toEqual(paneLayoutOf(BY_TEXT).rows.map((row) => row.text))
    expect(paneLayoutOf(BY_RUNS).size).toEqual(paneLayoutOf(BY_TEXT).size)
    const flat = layoutOf(BY_RUNS).map((row) => row.text.trim()).join(' ')
    for (const text of Object.values(PLAIN)) expect(flat).toContain(text)
    expect(answerOf(BY_RUNS)).not.toContain(SPAN_SPACE)
  })

  test('the pane draws a line given as runs with those runs, spans as plain spaces: the Keepalive heading, the four lines and the Settings rows carry runs, and no other row has the field', () => {
    const { rows: all } = paneLayoutOf(BY_RUNS)
    const settings = all.findIndex((row) => row.kind === 'heading' && row.text === 'Settings')
    expect(all.slice(settings + 1).every((row) => row.kind === 'line' && row.runs !== undefined)).toBe(true)
    const rows = all.slice(0, settings)
    expect(rows.filter((row) => 'runs' in row)).toEqual([
      { kind: 'line', text: PLAIN.cache, runs: [{ text: '◕', tone: 'on' }, { text: ` warm · 3:12 left · 5m TTL · ${PLAIN_TAIL}`, tone: 'quiet' }] },
      { kind: 'heading', text: 'Keepalive  paused', runs: [{ text: 'Keepalive  ', tone: 'quiet' }, { text: 'paused', tone: 'warning' }] },
      {
        kind: 'line',
        text: PLAIN.keepalive,
        runs: [{ text: 'pie: ', tone: 'quiet' }, { text: 'amber', tone: 'warning' }, { text: ` ≤¼ TTL left, red ≤⅒, ${PLAIN_TAIL}`, tone: 'quiet' }],
      },
      {
        kind: 'line',
        text: PLAIN.session,
        runs: [{ text: 'session: ', tone: 'quiet' }, { text: '2 refreshes', tone: 'on' }, { text: ` · $0.007 · ${PLAIN_TAIL}`, tone: 'quiet' }],
      },
      {
        kind: 'line',
        text: PLAIN.advice,
        runs: [{ text: 'do: ', tone: 'quiet' }, { text: 'set the lead', tone: 'alarm' }, { text: ` first, then ${PLAIN_TAIL}`, tone: 'quiet' }],
      },
    ])
  })

  test('the runs of each pane line, joined, are its text, which the answer holds as that line unwrapped; none of their text holds a span space', () => {
    const { rows } = paneLayoutOf(BY_RUNS)
    const flat = layoutOf(BY_RUNS).map((row) => row.text.trim()).join(' ')
    const withRuns = rows.filter((row) => row.kind === 'line' && row.runs !== undefined)
    expect(withRuns).toHaveLength(4 + SETTINGS.length)
    for (const row of withRuns) {
      expect(row.runs!.map((r) => r.text).join('')).toBe(row.text)
      expect(flat).toContain(row.text)
      expect(row.text).not.toContain(SPAN_SPACE)
      for (const r of row.runs!) expect(r.text).not.toContain(SPAN_SPACE)
    }
  })

  test('a line given as plain text is a pane row of its text alone, as before: no runs field', () => {
    for (const snap of [FULL, BY_RUNS]) {
      const plain = paneLayoutOf(snap).rows.filter((row) => row.kind === 'line' && !('runs' in row))
      expect(plain.length).toBeGreaterThan(0)
      for (const row of plain) expect(Object.keys(row)).toEqual(['kind', 'text'])
    }
    expect(paneLayoutOf(BY_RUNS).rows.filter((row) => row.kind === 'line' && !('runs' in row)).map((row) => row.text)).toContain('why')
  })

  test('a command inside a line given as runs stays whole on one row of the 48-column answer, in each part, and prints with plain spaces', () => {
    const rows = layoutOf(BY_RUNS).map((row) => row.text)
    expect(rows.filter((row) => row.includes('/keepalive on 15'))).toEqual(Array(4).fill('    /keepalive on 15 or click the pie on'))
    expect(rows.every((row) => row.length <= WRAP)).toBe(true)
    expect(rows.some((row) => row.includes(SPAN_SPACE))).toBe(false)
  })

  test('a tone adds no text to a line given as runs: the answer, its rows, the pane rows\' text and the size are the same in every tone', () => {
    for (const tone of TONES) {
      const toned: Snapshot = { ...BY_RUNS, cache: [[run('◕', tone), ...CACHE_RUNS.slice(1)]], advice: [[run('do: ', tone), ...ADVICE_RUNS.slice(1)]] }
      expect(answerOf(toned)).toBe(answerOf(BY_RUNS))
      expect(layoutOf(toned)).toEqual(layoutOf(BY_RUNS))
      expect(paneLayoutOf(toned).rows.map((row) => row.text)).toEqual(paneLayoutOf(BY_RUNS).rows.map((row) => row.text))
      expect(paneLayoutOf(toned).size).toEqual(paneLayoutOf(BY_RUNS).size)
    }
  })

  test('the size is the count and longest row of the 48-column layout, with lines given as runs', () => {
    for (const snap of [BY_RUNS, { ...BY_RUNS, keepalive: { state: 'off', tone: 'gone' as const, lines: [] } }]) {
      const rows = layoutOf(snap)
      expect(paneLayoutOf(snap).size).toEqual({ rows: rows.length, columns: Math.max(...rows.map((row) => row.text.length)) })
    }
  })
})

describe('plainOf: a line\'s text, in one place', () => {
  test('a plain line is itself and a line of pieces is its pieces joined, the marks of its spans kept', () => {
    expect(plainOf('why')).toBe('why')
    expect(plainOf([])).toBe('')
    const command = spanOf('/keepalive on 15')
    expect(plainOf([{ text: 'do:', tone: 'gone' }, { text: ` ${command}`, tone: 'quiet' }])).toBe(`do: ${command}`)
    expect(plainOf([{ text: 'do:', tone: 'gone' }, { text: ` ${command}`, tone: 'quiet' }])).toContain(SPAN_SPACE)
  })
})
