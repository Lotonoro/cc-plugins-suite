import { isCutPoint, unitsOf } from './columns'

// A notice's title and answer, each on one line: a line break in either would start a line the replay reads as another item's marker,
// and the replay reads a reply's text to its line's end. Only a line break, with the blanks around it, becomes a space: the human's own
// spacing is kept.
export const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')

// The text cut to at most `max` UTF-16 units, the ellipsis counted within them. The cut keeps the longest prefix that ends at a cut point (columns.ts) and
// fits with the ellipsis, so it never splits a sequence, separates a mark from its letter, or ends on a joiner. It keeps `max - 1` units, or fewer by at most
// the length of the run that straddles that point, less one: at most 14 fewer for measured sequences, more for a chain of parts joined by U+200D, which is
// kept or dropped whole. Line breaks stay as they are, so a multi-line text is cut to a multi-line text; cutLine is the one-line cut.
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text
  if (max <= 0) return ''
  const room = max - 1
  const units = unitsOf(text)
  let end = 0
  let at = 0
  for (const [k, unit] of units.entries()) {
    if (at > room) break
    if (isCutPoint(units[k - 1], unit)) end = at
    at += unit.text.length
  }
  return `${text.slice(0, end)}…`
}

// A title or a label cut to one line: its line breaks become spaces (oneLine), then cutText.
export const cutLine = (text: string, max: number): string => cutText(oneLine(text), max)
