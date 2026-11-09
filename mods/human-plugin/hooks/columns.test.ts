import { expect, test } from 'claude-code/testing'
import { displayColumns, unitsOf } from './columns'

// Code points written as numbers, so no editor or encoding changes a joiner or a variation selector that draws as nothing.
const cps = (...codes: number[]): string => String.fromCodePoint(...codes)

test('the display-column measure: a wide character counts two columns, any other one, a surrogate pair as one character', () => {
  expect(displayColumns('')).toBe(0)
  expect(displayColumns('abc')).toBe(3)
  expect(displayColumns('中文')).toBe(4)
  expect(displayColumns('a中b')).toBe(4)
  expect(displayColumns('😀')).toBe(2)
  expect(displayColumns('✓ ↶ […]')).toBe(7)
  expect(displayColumns('中'.repeat(12))).toBe(displayColumns('x'.repeat(24)))
})

test('the measure counts each code point at the columns tmux drew for it alone, as the scan recorded: one for the glyphs the band draws and the text-presentation emoji, zero for joiners and selectors, two for wide characters', () => {
  const cases: [string, string, number][] = [
    // The glyphs the band draws, and the ones a title or an answer often holds.
    ...['✓', '✗', '↶', '…', '[', ']', '•', '·', '#', ' ', 'a'].map((glyph): [string, string, number] => [glyph, glyph, 1]),
    ['U+FF71 halfwidth katakana', cps(0xff71), 1],
    ['U+2764 heart, text presentation', cps(0x2764), 1],
    ['U+263A smiling face, text presentation', cps(0x263a), 1],
    ['U+2714 check mark, text presentation', cps(0x2714), 1],
    ['U+1F3F3 white flag', cps(0x1f3f3), 1],
    ['U+3FFFD, the last code point scanned', cps(0x3fffd), 1],
    ['U+200D joiner', cps(0x200d), 0],
    ['U+FE0F variation selector 16', cps(0xfe0f), 0],
    ['U+FE0E variation selector 15', cps(0xfe0e), 0],
    ['U+20E3 combining keycap', cps(0x20e3), 0],
    ['U+200B zero width space', cps(0x200b), 0],
    ['U+2705 ✅', cps(0x2705), 2],
    ['U+274C ❌', cps(0x274c), 2],
    ['U+2B50 ⭐', cps(0x2b50), 2],
    ['U+26A1 ⚡', cps(0x26a1), 2],
    ['U+65E5 日', cps(0x65e5), 2],
    ['U+306E の', cps(0x306e), 2],
    ['U+D55C 한', cps(0xd55c), 2],
    ['U+FF21 fullwidth A', cps(0xff21), 2],
    ['U+3001 ideographic comma', cps(0x3001), 2],
    ['U+20000', cps(0x20000), 2],
    ['U+20001', cps(0x20001), 2],
    ['U+2A6D6', cps(0x2a6d6), 2],
    ['U+30000', cps(0x30000), 2],
    ['U+1F600 😀', cps(0x1f600), 2],
    ['U+1F468 👨', cps(0x1f468), 2],
    ['U+1F308 🌈', cps(0x1f308), 2],
    // Where the scan and the table the measure replaced disagree: wide characters the table missed, and ones it counted wide that tmux draws narrow.
    ['U+2648 ♈', cps(0x2648), 2],
    ['U+2329', cps(0x2329), 2],
    ['U+1F004 🀄', cps(0x1f004), 2],
    ['U+1F18E 🆎', cps(0x1f18e), 2],
    ['U+17000', cps(0x17000), 2],
    ['U+2A6DF', cps(0x2a6df), 2],
    ['U+303F', cps(0x303f), 1],
    ['U+1F321 🌡', cps(0x1f321), 1],
    ['U+2A6E0', cps(0x2a6e0), 1],
  ]
  for (const [name, text, columns] of cases) expect(displayColumns(text), name).toBe(columns)
})

test('a variation selector 16 after a code point drawn one column wide adds one, as tmux draws the pair two wide; after anything else it adds none', () => {
  expect(displayColumns(cps(0x2764, 0xfe0f)), 'heart and selector').toBe(2)
  expect(displayColumns(cps(0x61, 0xfe0f)), 'a and selector').toBe(2)
  expect(displayColumns(cps(0x31, 0xfe0f, 0x20e3)), 'keycap 1').toBe(2)
  expect(displayColumns(cps(0x2713, 0xfe0f)), 'check mark and selector').toBe(2)
  // After a wide character the pair is two wide already; alone, or after a joiner, a selector takes no column.
  expect(displayColumns(cps(0x2705, 0xfe0f)), 'wide and selector').toBe(2)
  expect(displayColumns(cps(0xfe0f)), 'alone').toBe(0)
  expect(displayColumns(cps(0x200d, 0xfe0f)), 'after a joiner').toBe(0)
  expect(displayColumns(cps(0x61, 0xfe0f, 0xfe0f)), 'a second selector').toBe(2)
})

test('a code point the scan did not measure counts two, the widest any measured one drew, so a cut lands early and never over the list', () => {
  const unmeasured: [string, number][] = [
    ['U+0007 a control', 0x07],
    ['U+0000', 0x00],
    ['U+001F', 0x1f],
    ['U+007F', 0x7f],
    ['U+009B a C1 control', 0x9b],
    ['U+009F', 0x9f],
    ['U+FFFE', 0xfffe],
    ['U+FFFF', 0xffff],
    ['U+1FFFE', 0x1fffe],
    ['U+1FFFF', 0x1ffff],
    ['U+3FFFE, the first past the scan', 0x3fffe],
    ['U+E0101 a variation selector supplement', 0xe0101],
    ['U+F0000 a private use plane', 0xf0000],
    ['U+10FFFF', 0x10ffff],
  ]
  for (const [name, code] of unmeasured) expect(displayColumns(cps(code)), name).toBe(2)
  // A lone surrogate is not a code point of the scan either.
  expect(displayColumns('\ud800'), 'lone high surrogate').toBe(2)
  expect(displayColumns('\udfff'), 'lone low surrogate').toBe(2)
  // The code points either side of a gap in the scan are measured.
  for (const code of [0x20, 0x7e, 0xa0, 0xd7ff, 0xe000, 0xfffd, 0x1fffd]) expect(displayColumns(cps(code)), `U+${code.toString(16)}`).toBe(1)
})

const FAMILY = cps(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466)
const KISS = cps(0x1f468, 0x1f3fb, 0x200d, 0x2764, 0xfe0f, 0x200d, 0x1f48b, 0x200d, 0x1f468, 0x1f3fb)
const HANDSHAKE = cps(0x1faf1, 0x1f3fb, 0x200d, 0x1faf2, 0x1f3fc)

test('a joined sequence sub-plan 3 measured counts at the wider of what tmux draws and the engine lays out: two where they agree, the family of four, the rainbow flag, a thumbs-up with a medium skin tone, the keycap 1, the US flag and the England flag', () => {
  expect(displayColumns(FAMILY), 'family of four').toBe(2)
  expect(displayColumns(cps(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)), 'rainbow flag').toBe(2)
  expect(displayColumns(cps(0x1f44d, 0x1f3fd)), 'thumbs-up, medium skin tone').toBe(2)
  expect(displayColumns(cps(0x31, 0xfe0f, 0x20e3)), 'keycap 1').toBe(2)
  expect(displayColumns(cps(0x1f1fa, 0x1f1f8)), 'US flag').toBe(2)
  expect(displayColumns(cps(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f)), 'England flag').toBe(2)
})

test('where tmux draws a sequence wider than the engine lays it out the measure counts tmux\'s width: ☝ with a medium skin tone 4, the two-tone handshake 6', () => {
  expect(displayColumns(cps(0x261d, 0x1f3fd)), 'index pointing up, medium skin tone').toBe(4)
  expect(displayColumns(HANDSHAKE), 'two-tone handshake').toBe(6)
})

test('where the engine lays a sequence out wider than tmux draws it the measure counts the engine\'s width: the heart on fire without its U+FE0F 2, `#` and U+20E3 2', () => {
  expect(displayColumns(cps(0x2764, 0x200d, 0x1f525)), 'heart on fire').toBe(2)
  expect(displayColumns(cps(0x23, 0x20e3)), 'hash and keycap').toBe(2)
})

test('a sequence whose measured width is its parts counts as its parts: a, a joiner and b 2, a with a medium skin tone 3, two grinning faces joined by a doubled joiner 4', () => {
  expect(displayColumns(cps(0x61, 0x200d, 0x62))).toBe(2)
  expect(displayColumns(cps(0x61, 0x1f3fd))).toBe(3)
  expect(displayColumns(cps(0x1f600, 0x200d, 0x200d, 0x1f600))).toBe(4)
})

test('a sequence that was not measured counts as its parts: two grinning faces joined by a joiner 4, two grinning faces side by side 4', () => {
  expect(displayColumns(cps(0x1f600, 0x200d, 0x1f600))).toBe(4)
  expect(displayColumns(cps(0x1f600, 0x1f600))).toBe(4)
})

test('a U+20E3 directly after a code point drawn one column wide adds one, measured or not: `1` and U+20E3 is 2, and after a wide character or a joiner it adds none', () => {
  expect(displayColumns(cps(0x31, 0x20e3))).toBe(2)
  expect(displayColumns(cps(0x2a, 0x20e3))).toBe(2)
  expect(displayColumns(cps(0x2705, 0x20e3))).toBe(2)
  expect(displayColumns(cps(0x200d, 0x20e3))).toBe(0)
  expect(displayColumns(cps(0x20e3))).toBe(0)
})

test('a sequence that starts or ends on a joiner is not a unit, and counts as its parts: a grinning face and a joiner 2, a and a joiner 1, a joiner and a grinning face 2', () => {
  expect(displayColumns(cps(0x1f600, 0x200d))).toBe(2)
  expect(displayColumns(cps(0x61, 0x200d))).toBe(1)
  expect(displayColumns(cps(0x200d, 0x1f600))).toBe(2)
  expect(unitsOf(cps(0x1f600, 0x200d)).map(({ text }) => text)).toEqual([cps(0x1f600), cps(0x200d)])
})

test('the longest sequence that starts at a point is the unit: the man with a light skin tone is 2 alone, and the kiss that starts with him is 4, not 2 and the rest', () => {
  expect(displayColumns(cps(0x1f468, 0x1f3fb))).toBe(2)
  expect(displayColumns(KISS)).toBe(4)
  expect(unitsOf(KISS)).toEqual([{ text: KISS, columns: 4 }])
})

test('a text of measured sequences and ASCII measures as the sum of its units, and its units read back as the text', () => {
  const text = `ab ${FAMILY} ${cps(0x261d, 0x1f3fd)}${HANDSHAKE}-${cps(0x1f1fa, 0x1f1f8)}x`
  expect(displayColumns(text)).toBe(2 + 1 + 2 + 1 + 4 + 6 + 1 + 2 + 1)
  expect(unitsOf(text).map(({ text: unit }) => unit).join('')).toBe(text)
})

test('the units of a text: each whole code point, a surrogate pair one, the selector after a code point kept with it, and the sum is the text\'s columns', () => {
  expect(unitsOf('')).toEqual([])
  expect(unitsOf(`a${cps(0x20000)}`)).toEqual([{ text: 'a', columns: 1 }, { text: cps(0x20000), columns: 2 }])
  expect(unitsOf(cps(0x2764, 0xfe0f, 0x200d, 0x61)).map(({ columns }) => columns)).toEqual([2, 0, 1])
  expect(unitsOf(cps(0x2705, 0xfe0f)).map(({ columns }) => columns)).toEqual([2])
  expect(unitsOf('\ud800a').map(({ text, columns }) => [text.length, columns])).toEqual([[1, 2], [1, 1]])
  for (const text of ['Fix it', `日本${cps(0x1f600, 0xfe0f)}`, cps(0x31, 0xfe0f, 0x20e3), FAMILY]) {
    expect(unitsOf(text).reduce((sum, { columns }) => sum + columns, 0), text).toBe(displayColumns(text))
    expect(unitsOf(text).map(({ text: unit }) => unit).join(''), text).toBe(text)
  }
})
