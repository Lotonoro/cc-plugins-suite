import type { Item } from '../types'

export type BandRow = { kind: 'item'; item: Item } | { kind: 'more'; blocking: number; more: number; first: Item }

// The band's rows within `maxRows`: the blocking items first, then the rest, each group in id order, one item per row. When they
// do not all fit, the last row is the summary of what is folded: the blocking items (`blocking`) apart from the rest (`more`), and
// the first folded item (`first`), which the summary opens. That row is held back from the items, so the band never exceeds `maxRows`.
export const bandRows = (items: readonly Item[], maxRows: number): BandRow[] => {
  const sorted = [...items].sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.id - b.id)
  if (sorted.length <= maxRows) return sorted.map((item): BandRow => ({ kind: 'item', item }))
  const shown = sorted.slice(0, Math.max(0, maxRows - 1)).map((item): BandRow => ({ kind: 'item', item }))
  const folded = sorted.slice(shown.length)
  const blocking = folded.filter(item => item.blocking).length
  return maxRows > 0 ? [...shown, { kind: 'more', blocking, more: folded.length - blocking, first: folded[0] as Item }] : shown
}
