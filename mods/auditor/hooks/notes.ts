export type Note = { text: string; escalation: boolean; stall: boolean }

const QUIET = 'Nothing to note.'
const ESCALATION = 'Escalation:'
// The marker of a note that names a stall: the worker ended its turn with work undone and nothing in flight to wake it.
const STALL = 'Stalled:'
// The headers the reviewer copies from the framing its notes arrive under, each on a line of its own or opening the note's first line,
// with the blanks after them.
const COPIED_HEADER = /^(?:[ \t]*auditor, review \d+:\s*)+/

// The reviewer's answer without its copied header, trimmed: empty when the answer is only the header.
export const answerBody = (answer: string): string => answer.trim().replace(COPIED_HEADER, '').trim()

// A complete, non-empty answer read as a note: null when it is exactly the quiet answer, else its body, whether it opens with an escalation, and whether it opens with the stall marker.
export const readNote = (answer: string): Note | null => {
  const text = answerBody(answer)
  if (text === QUIET) return null
  return { text, escalation: text.startsWith(ESCALATION), stall: text.startsWith(STALL) }
}

// The note as the worker receives it: a first line naming the review, then the note's text.
export const frameNote = (number: number, text: string): string => `auditor, review ${number}:\n${text}`
