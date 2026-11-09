import { DRAWN, UNMEASURED } from './widths'
import { SEQUENCES } from './sequences'

// The range of `ranges` (sorted, none overlapping) that holds `code`, undefined when none does.
const holding = <R extends readonly [number, number, ...unknown[]]>(ranges: readonly R[], code: number): R | undefined => {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid] as R
    if (code < range[0]) high = mid - 1
    else if (code > range[1]) low = mid + 1
    else return range
  }
  return undefined
}

// The columns tmux drew for a code point printed alone, as the scan in widths.ts recorded: 0 for a joiner, a variation selector or a combining mark, 2 for a
// wide character, 1 for every other code point it measured. One it did not measure counts 2, the widest any measured one drew, so a cut lands early
// rather than over its room.
const columnsAlone = (code: number): number => {
  const drawn = holding(DRAWN, code)
  if (drawn !== undefined) return drawn[2]
  return holding(UNMEASURED, code) === undefined ? 1 : 2
}

const VARIATION_SELECTOR_16 = 0xfe0f
const COMBINING_KEYCAP = 0x20e3

// The measured sequences by their first code point, the longest first, each as its code points and its columns.
const SEQUENCES_BY_FIRST = new Map<number, { codes: number[]; columns: number }[]>()
for (const [hex, columns] of SEQUENCES) {
  const codes = hex.split(' ').map(code => parseInt(code, 16))
  const first = codes[0] as number
  SEQUENCES_BY_FIRST.set(first, [...(SEQUENCES_BY_FIRST.get(first) ?? []), { codes, columns }])
}
for (const sequences of SEQUENCES_BY_FIRST.values()) sequences.sort((a, b) => b.codes.length - a.codes.length)

// A stretch of a text that is cut and wrapped whole, and the columns it takes.
export type Unit = { text: string; columns: number }

const codePointsOf = (text: string): number[] => {
  const codes: number[] = []
  for (let at = 0; at < text.length; at++) {
    const code = text.codePointAt(at) as number
    codes.push(code)
    if (code > 0xffff) at++
  }
  return codes
}

// The columns of the unit that starts at `at` in `codes`, left in `unitColumns`, and the code points it holds. The unit is the longest measured sequence
// (sequences.ts) that starts there, counted at the wider of what tmux drew and what the engine lays out; else a code point, with the columns tmux drew for it
// alone. Two pairings that tmux draws one glyph wider than the parts stay together as one unit and add one: a U+FE0F after a code point, which tmux draws two wide
// where the code point alone is drawn one, and a U+20E3 directly after a code point drawn one column wide.
let unitColumns = 0
const unitAt = (codes: readonly number[], at: number): number => {
  const sequences = SEQUENCES_BY_FIRST.get(codes[at] as number)
  if (sequences !== undefined) {
    for (const { codes: wanted, columns } of sequences) {
      if (wanted.every((code, k) => codes[at + k] === code)) {
        unitColumns = columns
        return wanted.length
      }
    }
  }
  const alone = columnsAlone(codes[at] as number)
  const next = codes[at + 1]
  const joined = alone === 1 && next === COMBINING_KEYCAP ? 1 : next === VARIATION_SELECTOR_16 ? 1 : 0
  unitColumns = alone === 1 && joined === 1 ? 2 : alone
  return 1 + joined
}

// A text as the units it is measured in, in order; a code point is whole, a surrogate pair one. An unmeasured sequence is counted as its parts, so never
// fewer columns than tmux draws it in unless the engine lays it out wider, and a cut or a count on it errs early, never over the room.
export const unitsOf = (text: string): Unit[] => {
  const codes = codePointsOf(text)
  const units: Unit[] = []
  for (let at = 0; at < codes.length; ) {
    const length = unitAt(codes, at)
    units.push({ text: String.fromCodePoint(...codes.slice(at, at + length)), columns: unitColumns })
    at += length
  }
  return units
}

// The columns a text takes on screen: the measure the label and term limits are checked in, and the one the band's layout (layout.ts) cuts and wraps by.
export const displayColumns = (text: string): number => {
  const codes = codePointsOf(text)
  let total = 0
  for (let at = 0; at < codes.length; ) {
    at += unitAt(codes, at)
    total += unitColumns
  }
  return total
}
