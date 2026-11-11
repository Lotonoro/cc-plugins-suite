// The five sections bare `/keepalive` answers with: Cache, Keepalive, This session, Advice and Settings. A pure builder: the command gathers the figures
// and sentences into a snapshot, and this turns them into sections, laid out unwrapped with its size for the pane and wrapped at 48 columns for the command. It
// takes no engine handle, so it is tested without one. It knows no state's words: the Keepalive part brings its state as a string beside the
// tone to draw it in, and the other parts bring finished lines, the This session fallback included, each as plain text or as the pieces to draw in tones.
// It imports the pie's tone and piece types and nothing else.
import type { Run, Tone } from './countdown'

// The width a line is wrapped at, counting its indent.
export const WRAP = 48

// A setting the command names: its value, where the value came from when that is knowable, and what changes it.
export type Setting = { name: string; value: string; source: string | null; change: string }

// A line of a section: plain text, or the pieces of its text, each drawn in a tone in the pane. The producer of a line gives the pieces, and decides
// whether the line exists; a line given as plain text carries no pieces and is drawn as it reads.
export type Line = string | Run[]

// The figures and sentences of each section; a section with none is absent, unless it carries a state. Settings are kept as values, so their
// lines are formed here.
export type Snapshot = {
  cache: Line[]
  keepalive: { state: string; tone: Tone; lines: Line[] }
  session: Line[]
  advice: Line[]
  settings: Setting[]
}

// A section's state is written on its heading beside the title, in its tone, so the two are one value: a section with no state has no tone. A
// section that carries a state is never left out.
export type Section = { title: 'Cache' | 'Keepalive' | 'This session' | 'Advice' | 'Settings'; state: Run | null; lines: Line[] }

// One row of the command's 48-column layout. A section's heading row carries the heading mark, so a drawing bolds it without reading its
// text; no other row is marked. Each row's indent is in its text, and `wrapped` is the field only this layout's rows have, so a pane row is
// not accepted where an answer row is expected.
export type AnswerRow = { text: string; heading?: boolean; wrapped: true }

// One row of the pane's layout: a heading, a line (a whole sentence or figure, which the drawing indents) or a blank between sections. The
// row states its kind, so a drawing reads no text to tell them apart, and carries no indent. `kind` is the field only this layout's rows
// have, so an answer row is not accepted where a pane row is expected. A row whose pieces are drawn in tones carries them as `runs`, so a
// drawing reads no text to find them either; the others carry none and are drawn as their text.
export type PaneRow = { kind: 'heading' | 'line' | 'blank'; text: string; runs?: Run[] }

// The rows and columns the pane asks for.
export type PaneSize = { rows: number; columns: number }

const settingLine = (s: Setting): string => `${s.name}: ${s.value}${s.source === null ? '' : ` (${s.source})`} · ${s.change}`

// The sections, in order, each with its lines. A section with no line and no state is left out.
export const sectionsOf = (snap: Snapshot): Section[] =>
  [
    { title: 'Cache' as const, state: null, lines: snap.cache },
    { title: 'Keepalive' as const, state: { text: snap.keepalive.state, tone: snap.keepalive.tone }, lines: snap.keepalive.lines },
    { title: 'This session' as const, state: null, lines: snap.session },
    { title: 'Advice' as const, state: null, lines: snap.advice },
    { title: 'Settings' as const, state: null, lines: snap.settings.map(settingLine) },
  ].filter((section) => section.state !== null || section.lines.length > 0)

// The space a sentence joins the words of an unbreakable span with, such as a command: the wrap keeps the span on one row and prints each
// as a plain space, so the answer's text carries none.
export const SPAN_SPACE = '\u00a0'

// A command or a setup token is one span: the wrap keeps it whole on a row, and the answer and the pane print each space in it as a plain one.
export const spanOf = (text: string): string => text.split(' ').join(SPAN_SPACE)

// A text as the answer and the pane print it: each mark of a span a plain space.
const plainSpaces = (text: string): string => text.split(SPAN_SPACE).join(' ')

// A sentence wrapped at the width: the first line indented two, each continuation four, no word broken and no span broken.
export const wrapLine = (text: string, width = WRAP, first = '  ', rest = '    '): string[] => {
  const lines: string[] = []
  let line = first
  for (const span of text.split(' ')) {
    const word = plainSpaces(span)
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

// A heading's pieces: the title, with the two-space gap before a state untoned, then the state in its tone. The heading's text is these joined,
// so the text and the pieces cannot disagree.
const headingRunsOf = (section: Section): Run[] =>
  section.state === null ? [{ text: section.title, tone: 'quiet' }] : [{ text: `${section.title}  `, tone: 'quiet' }, section.state]

const headingOf = (section: Section): string => headingRunsOf(section).map((run) => run.text).join('')

// A line's text, in one place: itself, or its pieces joined. It keeps the marks of its spans, which the wrap reads so a span stays whole.
const plainOf = (line: Line): string => (typeof line === 'string' ? line : line.map((run) => run.text).join(''))

// The sections as the command's rows: each section's heading row, its lines wrapped beneath it, and one blank row between sections.
const answerRowsOf = (sections: Section[]): AnswerRow[] =>
  sections.flatMap((section, i) => [
    ...(i === 0 ? [] : [{ text: '', wrapped: true as const }]),
    { text: headingOf(section), heading: true, wrapped: true as const },
    ...section.lines.flatMap((line) => wrapLine(plainOf(line)).map((text) => ({ text, wrapped: true as const }))),
  ])

// The answer as rows.
export const layoutOf = (snap: Snapshot): AnswerRow[] => answerRowsOf(sectionsOf(snap))

// The pane's rows: a heading per section, each line whole with its spans printed as plain spaces, and one blank row between sections; and the
// size the pane asks for, the count and longest row of the same sections wrapped at `WRAP`, so it depends on the content alone. A heading that
// carries a state, and a line given as pieces, also carry their pieces as runs, which the text of the answer and the size do not read.
export const paneLayoutOf = (snap: Snapshot): { rows: PaneRow[]; size: PaneSize } => {
  const sections = sectionsOf(snap)
  const rows = sections.flatMap((section, i): PaneRow[] => [
    ...(i === 0 ? [] : [{ kind: 'blank' as const, text: '' }]),
    { kind: 'heading' as const, text: headingOf(section), ...(section.state === null ? {} : { runs: headingRunsOf(section) }) },
    ...section.lines.map((line): PaneRow => ({
      kind: 'line',
      text: plainSpaces(plainOf(line)),
      ...(typeof line === 'string' ? {} : { runs: line.map((run) => ({ ...run, text: plainSpaces(run.text) })) }),
    })),
  ])
  const wrapped = answerRowsOf(sections)
  return { rows, size: { rows: wrapped.length, columns: Math.max(0, ...wrapped.map((row) => row.text.length)) } }
}

// The answer: the rows of the layout, joined.
export const answerOf = (snap: Snapshot): string => layoutOf(snap).map((row) => row.text).join('\n')
