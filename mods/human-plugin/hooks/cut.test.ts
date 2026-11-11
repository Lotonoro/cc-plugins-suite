import { expect, test } from 'claude-code/testing'
import { unitsOf } from './columns'
import { cutLine, cutText, oneLine, repairCut } from './cut'
import { endsJoining } from './joining-oracle'

const pair = String.fromCodePoint(0x1f600)
const zwj = String.fromCodePoint(0x200d)
const vs16 = String.fromCodePoint(0xfe0f)
// The variation selectors a joiner may be followed by: the measure pairs U+FE0F with the joiner into one unit and leaves U+FE0E a unit of its own.
const selectors: [string, string][] = [['U+FE0F', vs16], ['U+FE0E', String.fromCodePoint(0xfe0e)]]
const man = '👨'
const woman = '👩'
const girl = '👧'
const family = '👨‍👩‍👧‍👦'
const kiss = '\u{1f468}\u{1f3fb}‍❤️‍\u{1f48b}‍\u{1f468}\u{1f3fb}'
const flag = '🇺🇸'
const keycap = '1️⃣'
const chain = '😀‍😀‍😀'
const acute = '́'
const a = (n: number): string => 'a'.repeat(n)
const x = (n: number): string => 'x'.repeat(n)

test('cutText keeps a text within the bound as it is, and otherwise ends it in an ellipsis that is counted within the bound', () => {
  expect(cutText('abc', 3)).toBe('abc')
  expect(cutText('abcd', 3)).toBe('ab…')
  expect(cutText('abcd', 1)).toBe('…')
  expect(cutText('abcd', 0)).toBe('')
})

test('cutText never splits a surrogate pair: a cut that would is one unit shorter', () => {
  expect(cutText(`${pair}x`, 2)).toBe('…')
  expect(cutText(`a${pair}x`, 3)).toBe('a…')
  expect(cutText(`a${pair}x`, 4)).toBe(`a${pair}x`)
  expect(cutText(`${pair}${pair}x`, 4)).toBe(`${pair}…`)
})

test('cutText keeps the line breaks of a multi-line text, and cutLine cuts the same text to one line with every break as a space', () => {
  expect(cutText('one\ntwo\nthree', 9)).toBe('one\ntwo\n…')
  expect(cutLine('one\ntwo\nthree', 9)).toBe('one two …')
  expect(cutLine(`a\r\nb${String.fromCharCode(0x2028)}c${String.fromCharCode(0x2029)}d`, 20)).toBe('a b c d')
})

test('oneLine turns a line break and the blanks around it into one space and keeps other spacing', () => {
  expect(oneLine('a \n\r\n b  c')).toBe('a b  c')
})

test('three families of four are cut to two families and the ellipsis', () => {
  const out = cutText(family.repeat(3), 30)
  expect(out).toBe(`${family.repeat(2)}…`)
  expect(out.length).toBe(23)
})

test('a measured sequence straddling the cut is kept whole or dropped', () => {
  expect(cutText(`${a(20)}${kiss}b`, 30)).toBe(`${a(20)}…`)
  expect(cutText(`${a(14)}${kiss}bc`, 30)).toBe(`${a(14)}${kiss}…`)
  expect(cutText(`${x(27)}${flag}y`, 30)).toBe(`${x(27)}…`)
  expect(cutText(`${x(28)}${keycap}y`, 30)).toBe(`${x(28)}…`)
})

test('an unmeasured run joined by U+200D is kept whole or dropped, never shown as a fragment', () => {
  expect(cutText(`${a(25)}${chain}b`, 30)).toBe(`${a(25)}…`)
  expect(cutText(`${a(21)}${chain}bc`, 30)).toBe(`${a(21)}${chain}…`)
})

test('a joiner followed by code points that draw nothing is dropped with the unit it joins, never shown as a fragment before the ellipsis', () => {
  for (const [name, selector] of selectors) expect(cutText(`${a(25)}${pair}${zwj}${selector}${pair}${x(45)}`, 30), name).toBe(`${a(25)}…`)
})

test('a joiner followed by code points that draw nothing is kept with the unit it joins when the cut falls after that unit', () => {
  for (const [name, selector] of selectors) {
    const joined = `${pair}${zwj}${selector}${pair}`
    expect(cutText(`${a(23)}${joined}bc`, 30), name).toBe(`${a(23)}${joined}…`)
  }
})

test('a combining mark stays with its letter, and a text of zero-width units cuts to the ellipsis', () => {
  expect(cutText(`${x(28)}e${acute}y`, 30)).toBe(`${x(28)}…`)
  expect(cutText(`${x(28)}ก่y`, 30)).toBe(`${x(28)}…`)
  expect(cutText(acute.repeat(31), 30)).toBe('…')
  expect(cutText(`${acute.repeat(30)}abc`, 30)).toBe('…')
})

test('a chain shorter than the cap is dropped whole, and kept when it fits with the ellipsis', () => {
  const six = Array(6).fill('😀').join('‍')
  expect(six.length).toBe(17)
  expect(cutText(`aa${six}bc`, 19)).toBe('aa…')
  expect(cutText(`aa${six}bc`, 20)).toBe(`aa${six}…`)
})

// The longest prefix that ends at a cut point and fits `max` with its ellipsis, found by trying every prefix: a prefix of `n` units ends on a unit boundary,
// where no U+200D still joins what follows (endsJoining), with a next unit that draws a column (or is the empty prefix).
const longestKept = (text: string, max: number): string => {
  const boundaries = new Set<number>([0])
  let at = 0
  for (const unit of unitsOf(text)) {
    at += unit.text.length
    boundaries.add(at)
  }
  let best = 0
  for (let n = 0; n <= max - 1; n++) {
    if (!boundaries.has(n)) continue
    const next = unitsOf(text.slice(n)).at(0)
    if (n === 0 || (!endsJoining(text.slice(0, n)) && next !== undefined && next.columns > 0)) best = n
  }
  return text.slice(0, best)
}

// The texts the cut is tried on: a family, a skin-tone kiss, a flag, a keycap, a joined chain, combining marks, and a joiner followed by a selector between two faces, each straddling the cap.
const cutTexts = [
  family.repeat(3),
  `${a(20)}${kiss}b`,
  `${a(14)}${kiss}bc`,
  `${x(27)}${flag}y`,
  `${x(28)}${keycap}y`,
  `${a(25)}${chain}b`,
  `${x(28)}e${acute}y`,
  acute.repeat(31),
  ...selectors.map(([, selector]) => `${a(25)}${pair}${zwj}${selector}${pair}${x(45)}`),
]

test('for every cap from 0 to 40, the cut is within it, never ends on a joiner or on the code points after one that draw nothing, and is the longest prefix at a cut point that fits', () => {
  for (const text of cutTexts) {
    for (let max = 0; max <= 40; max++) {
      const out = cutText(text, max)
      expect(out.length).toBeLessThanOrEqual(max)
      if (out === text) continue
      if (max === 0) {
        expect(out).toBe('')
        continue
      }
      expect(endsJoining(out.slice(0, -1))).toBe(false)
      expect(out).toBe(`${longestKept(text, max)}…`)
    }
  }
})

test('repairCut ends a text that ends in the ellipsis at its last cut point: the run a cut left ending on U+200D goes, and the ellipsis stays', () => {
  expect(repairCut(`${family.repeat(2)}${man}${zwj}${woman}${zwj}…`)).toBe(`${family.repeat(2)}…`)
  expect(repairCut(`${a(20)}${man}${zwj}${woman}${zwj}${girl}${zwj}…`)).toBe(`${a(20)}…`)
  expect(repairCut(`deploy ${pair}${zwj}…`)).toBe('deploy …')
  expect(repairCut(`${a(5)}${chain}${zwj}…`)).toBe(`${a(5)}…`)
  expect(repairCut(`${pair}${zwj}…`)).toBe('…')
})

test('repairCut ends a text that ends in a joiner and the code points after it that draw nothing, then the ellipsis, at its last cut point', () => {
  for (const [name, selector] of selectors) expect(repairCut(`${a(25)}${pair}${zwj}${selector}…`), name).toBe(`${a(25)}…`)
  expect(repairCut(`${a(5)}${pair}${zwj}${vs16}${vs16}${acute}…`)).toBe(`${a(5)}…`)
})

test('repairCut keeps a text whose text before the ellipsis already ends at a cut point, the leftovers of a cut inside a sequence included', () => {
  const regional = String.fromCodePoint(0x1f1fa)
  for (const text of [
    '…',
    'after tests…',
    `${family.repeat(2)}…`,
    `${a(21)}${man}${zwj}${woman}${zwj}${girl}…`,
    `${a(27)}${man}…`,
    `${a(24)}${man}${zwj}${woman}…`,
    `${a(10)}👋…`,
    `${x(10)}${regional}…`,
    `${x(10)}1${vs16}…`,
    `x${acute}…`,
    `${a(10)}${pair}${zwj}${vs16}${pair}…`,
  ]) {
    expect(repairCut(text)).toBe(text)
  }
})

test('repairCut returns a text with no ellipsis as it is, even one that ends on U+200D', () => {
  expect(repairCut('~10 min')).toBe('~10 min')
  expect(repairCut(`ab${zwj}`)).toBe(`ab${zwj}`)
})

test('every text the cut gives is one repairCut returns as it is, for every cap from 0 to 40', () => {
  for (const text of cutTexts) {
    for (let max = 0; max <= 40; max++) {
      const out = cutText(text, max)
      expect(repairCut(out)).toBe(out)
    }
  }
})

test('for every prefix of a text followed by the ellipsis, repairCut keeps the longest prefix that ends at a cut point', () => {
  for (const text of cutTexts) {
    for (let n = 0; n <= text.length; n++) {
      const stored = `${text.slice(0, n)}…`
      expect(repairCut(stored)).toBe(`${longestKept(stored, stored.length)}…`)
    }
  }
})
