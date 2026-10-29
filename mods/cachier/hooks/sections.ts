// The four sections bare `/keepalive` answers with: Cache, Keepalive, Advice and Settings. A pure builder: the command gathers the figures
// and sentences into a snapshot, and this turns them into sections and wrapped rows, so the text reads the same wherever it is drawn. It
// takes no engine handle, so it is tested without one. It knows no state's words: the Keepalive part brings its state as a string.

// The width a line is wrapped at, counting its indent.
export const WRAP = 48

// A setting the command names: its value, where the value came from when that is knowable, and what changes it.
export type Setting = { name: string; value: string; source: string | null; change: string }

// The figures and sentences of each section; a section with none is absent, unless it carries a state. Settings are kept as values, so their
// lines are formed here.
export type Snapshot = {
  cache: string[]
  keepalive: { state: string; lines: string[] }
  advice: string[]
  settings: Setting[]
}

// A section's state is written on its heading beside the title; a section that carries one is never left out.
export type Section = { title: 'Cache' | 'Keepalive' | 'Advice' | 'Settings'; state: string | null; lines: string[] }

// One row of the laid-out answer. A section's heading row carries the heading mark, so a drawing bolds it without reading its text;
// no other row is marked.
export type AnswerRow = { text: string; heading?: boolean }

const settingLine = (s: Setting): string => `${s.name} ${s.value}${s.source === null ? '' : ` (${s.source})`}: ${s.change}.`

// The sections, in order, each with its lines. A section with no line and no state is left out.
export const sectionsOf = (snap: Snapshot): Section[] =>
  [
    { title: 'Cache' as const, state: null, lines: snap.cache },
    { title: 'Keepalive' as const, state: snap.keepalive.state, lines: snap.keepalive.lines },
    { title: 'Advice' as const, state: null, lines: snap.advice },
    { title: 'Settings' as const, state: null, lines: snap.settings.map(settingLine) },
  ].filter((section) => section.state !== null || section.lines.length > 0)

// A sentence wrapped at the width: the first line indented two, each continuation four, no word broken.
export const wrapLine = (text: string, width = WRAP, first = '  ', rest = '    '): string[] => {
  const lines: string[] = []
  let line = first
  for (const word of text.split(' ')) {
    const empty = line.trim() === ''
    if (!empty && line.length + 1 + word.length > width) {
      lines.push(line)
      line = `${rest}${word}`
    } else {
      line = empty ? `${line}${word}` : `${line} ${word}`
    }
  }
  lines.push(line)
  return lines
}

// The answer as rows: each section's heading row, its lines wrapped beneath it, and one blank row between sections.
export const layoutOf = (snap: Snapshot): AnswerRow[] =>
  sectionsOf(snap).flatMap((section, i) => [
    ...(i === 0 ? [] : [{ text: '' }]),
    { text: section.state === null ? section.title : `${section.title}  ${section.state}`, heading: true },
    ...section.lines.flatMap((line) => wrapLine(line).map((text) => ({ text }))),
  ])

// The answer: the rows of the layout, joined.
export const answerOf = (snap: Snapshot): string => layoutOf(snap).map((row) => row.text).join('\n')
