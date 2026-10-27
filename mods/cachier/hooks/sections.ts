// The four sections bare `/keepalive` answers with: Cache, Keepalive, Advice and Settings. A pure builder: the command gathers the figures
// and sentences into a snapshot, and this turns them into sections and wraps them, so the text reads the same wherever it is drawn. It
// takes no engine handle, so it is tested without one.

// The width a line is wrapped at, counting its indent.
export const WRAP = 48

// A setting the command names: its value, where the value came from when that is knowable, and what changes it.
export type Setting = { name: string; value: string; source: string | null; change: string }

// The figures and sentences of each section; a section with none is absent. Settings are kept as values, so their lines are formed here.
export type Snapshot = {
  cache: string[]
  keepalive: string[]
  advice: string[]
  settings: Setting[]
}

export type Section = { title: 'Cache' | 'Keepalive' | 'Advice' | 'Settings'; lines: string[] }

const settingLine = (s: Setting): string => `${s.name} ${s.value}${s.source === null ? '' : ` (${s.source})`}: ${s.change}.`

// The sections, in order, each with its lines. A section with no line is left out.
export const sectionsOf = (snap: Snapshot): Section[] =>
  [
    { title: 'Cache' as const, lines: snap.cache },
    { title: 'Keepalive' as const, lines: snap.keepalive },
    { title: 'Advice' as const, lines: snap.advice },
    { title: 'Settings' as const, lines: snap.settings.map(settingLine) },
  ].filter((section) => section.lines.length > 0)

// A sentence wrapped at the width: the first line indented two, each continuation four, no word broken. The details pane passes its own
// width and no indent.
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

// The answer: each section named on a line of its own, its lines wrapped beneath it, and a blank line between sections.
export const answerOf = (snap: Snapshot): string =>
  sectionsOf(snap)
    .map((section) => [section.title, ...section.lines.flatMap((line) => wrapLine(line))].join('\n'))
    .join('\n\n')
