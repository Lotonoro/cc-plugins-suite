import type { Conversation } from '../types/index'

// The one spelling of each marker the reviewer writes and the verdict matches; the reviewer's prompt interpolates them.
// The line a note opens with, naming its review.
export const reviewLine = (number: number | string): string => `auditor, review ${number}:`
// A quiet review's final answer; it sends nothing.
export const QUIET = 'Nothing to note.'
export const ESCALATION = 'Escalation:'
// The marker of a note that names a stall: the worker ended its turn with work undone and nothing in flight to wake it.
export const STALL = 'Stalled:'
// The one address a note goes to: the main conversation.
export const MAIN = 'main'

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The review line with its number as a capture, derived from `reviewLine`.
const [LINE_HEAD = '', LINE_TAIL = ''] = reviewLine('\0').split('\0')
const LINE = `[ \\t]*${escaped(LINE_HEAD)}(\\d+)${escaped(LINE_TAIL)}`
// The review line opening a text, with the blanks after it.
const OPENING = new RegExp(`^${LINE}\\s*`)
// Copies of the review line opening a body, each on a line of its own or opening the body's first line, with the blanks after them.
const COPIES = new RegExp(`^(?:${LINE}\\s*)+`)

// A note body's marks: whether it opens with an escalation, and whether it opens with the stall marker.
export type Marks = { escalation: boolean; stall: boolean }

// What a reviewer's send says: whether it goes to the main conversation, the number its opening review line names (null with no such line), the body after that line with any copies of it set aside, whether that body is the quiet status, and the body's marks.
export type Sent = Marks & { toMain: boolean; number: number | null; body: string; quiet: boolean }

// The marks of a note's body, as stored for the settle.
export const marksOf = (body: string): Marks => ({ escalation: body.startsWith(ESCALATION), stall: body.startsWith(STALL) })

// The text without copies of the review line opening it, trimmed: empty when the text is only the line.
const bodyOf = (text: string): string => text.trim().replace(COPIES, '').trim()

// Reads a reviewer's send from its address and raw text.
export const readSend = (to: string, text: string): Sent => {
  const trimmed = text.trim()
  const opening = OPENING.exec(trimmed)
  const body = bodyOf(opening === null ? trimmed : trimmed.slice(opening[0].length))
  return { toMain: to === MAIN, number: opening === null ? null : Number(opening[1]), body, quiet: body === QUIET, ...marksOf(body) }
}

// What the gate knows of the open review: its number, whether its brief said nothing will wake the worker, and its note slot.
export type Slot = { number: number; nothingWakes: boolean; note?: string | undefined }

// The send-admission verdict: admitted with the review number and the epoch its effects run under, or refused with the reason the reviewer reads.
export type Verdict = { admitted: true; number: number; epoch: number } | { admitted: false; reason: string }

// Admits a reviewer's send only as a note for the open review, at the conversation's current epoch.
export const admitSend = (sent: Sent, review: Slot | undefined, epoch: number): Verdict => {
  const refuse = (reason: string): Verdict => ({ admitted: false, reason })
  if (review === undefined) return refuse('auditor has no review open, so this message was not sent; end your turn')
  // The open review's number is not named: it is what tells the current reviewer from a former one.
  if (sent.number === null) return refuse(`a note opens with its brief's review line, "${reviewLine('N')}"; this message was not sent`)
  if (sent.number !== review.number) return refuse(`review ${sent.number} is not the open review, so this message was not sent; end your turn`)
  if (!sent.toMain) return refuse(`a note goes to "${MAIN}" only; this message was not sent`)
  if (sent.body === '') return refuse('this message has nothing after its review line, so it was not sent')
  if (sent.quiet) return refuse(`a quiet review sends nothing: end your turn with "${QUIET}"`)
  if (review.note !== undefined) return refuse('this review has sent its one note already; this message was not sent')
  if (sent.stall && !review.nothingWakes) return refuse(`this review's brief did not say nothing will wake the worker, so it sends no "${STALL}" note`)
  return { admitted: true, number: review.number, epoch }
}

// The stable tail of the engine's refusal of a send after an Esc, the same for the `main` and the teammate wordings: "...was not messaged: the session was stopped and nobody has sent input since."
const STOPPED = 'the session was stopped and nobody has sent input since'

// Whether a refusal reason is the engine's stopped-session refusal. The engine marks it with nothing structured, so only the reason's wording names it.
export const isStoppedRefusal = (reason: string): boolean => reason.includes(STOPPED)

// A refused note the hold-or-release step decides on. `number` and `epoch`: the review and the epoch the note's send was made under. `reason`: the engine's refusal, absent when the send threw, which is no refusal. `filling`: whether the note's slot is still to be filled, as for the follow-up's note, which admission has not yet seen; the gate's note filled its slot at admission.
export type Refusal = { number: number; epoch: number; sent: Sent; reason: string | undefined; filling: boolean }

// What the step did: `hold` (the note waits for the user's next prompt, with its booking effects), `release` (the note's slot is empty again, or already was), or `untouched` (the follow-up's note was not held and its slot was not filled; `refused` gives admission's reason when admission refused it). `stale`: a hold under an epoch that has since moved, so nothing was written and the note joined no held list. `next` is the state to write.
export type Decided = { next: Conversation; outcome: 'hold' | 'release' | 'untouched'; refused?: string; stale?: true }

// The hold-or-release decision on a note whose send was not delivered, from the conversation (its interrupt mark), the note's reading and the refusal's reason. Either stopped-session signal holds the note: the reason's wording, or the mark. A held note gets `booked`, the state a delivered note's booking writes (carried note, stall guard), and joins the held list, all under the send's epoch; the delivered mark stays unset. With neither signal a note whose slot was filled at the gate is released, only while the open review is still the send's (numbers never repeat, so a later review's slot is never cleared), and a follow-up's note is left untouched. For the follow-up the same admission as the gate's runs first, in this decision, so its slot is filled by admission alone. Under an older epoch nothing is written.
export const decideRefusal = (c: Conversation, refusal: Refusal, booked: (c: Conversation) => Conversation): Decided => {
  const { number, epoch, sent, reason, filling } = refusal
  const signalled = reason !== undefined && (isStoppedRefusal(reason) || c.interrupted)
  if (!signalled) {
    if (filling || c.review?.number !== number) return { next: c, outcome: filling ? 'untouched' : 'release' }
    const { note: _note, ...open } = c.review
    return { next: { ...c, review: open }, outcome: 'release' }
  }
  let state = c
  if (filling) {
    const verdict = admitSend(sent, c.review, c.epoch)
    if (!verdict.admitted) return { next: c, outcome: 'untouched', refused: verdict.reason }
    if (c.epoch !== epoch || c.review === undefined) return { next: c, outcome: 'untouched' }
    state = { ...c, review: { ...c.review, note: sent.body } }
  }
  if (c.epoch !== epoch) return { next: c, outcome: 'hold', stale: true }
  return { next: { ...booked(state), pendingNotes: [...state.pendingNotes, { number, text: sent.body }] }, outcome: 'hold' }
}

// How a review settles at its reviewer's turn end, and whether the raw final answer goes to the debug log; or, for a note written as the answer, that the review gets its one follow-up and stays open.
export type Outcome = { status: 'complete'; note: string | null; logAnswer: boolean } | { status: 'incomplete' } | { status: 'follow-up' }

// What the settle knows at the reviewer's turn end: the open review's note slot, number and follow-up mark, the turn end's reason, and the final answer.
export type TurnEndFacts = { note: string | undefined; number: number; followedUp: boolean; reason: string; answer: string }

// The settle's outcome: a booked note completes the review with it. Otherwise a turn that ends in an answer opening with the review's own line, whose body is neither empty nor exactly the quiet status, is a note written as the answer, and gets the review its one follow-up unless it has had it. Otherwise a turn that ends in an answer completes the review quiet when the answer, any copied review line set aside, is not empty, and any other end, an empty answer included, fails it. The answer goes to the debug log only when the review completes quiet on an answer that is not the quiet status.
export const settleOutcome = (end: TurnEndFacts): Outcome => {
  if (end.note !== undefined) return { status: 'complete', note: end.note, logAnswer: false }
  const body = bodyOf(end.answer)
  if (end.reason !== 'answer' || body === '') return { status: 'incomplete' }
  const opening = OPENING.exec(end.answer.trim())
  if (!end.followedUp && body !== QUIET && opening !== null && Number(opening[1]) === end.number) return { status: 'follow-up' }
  return { status: 'complete', note: null, logAnswer: body !== QUIET }
}

// The one follow-up to a reviewer that wrote its note as its final answer: it is its own instruction, so the reviewer's prompt carries no rule for it.
export const followUpText = (number: number): string =>
  `This is not a new review, so fetch no entries. Your final answer to review ${number} reads as a note, and a final answer reaches no one. Either send the note you wrote to \`${MAIN}\` with SendMessage, as one message opening with \`${reviewLine(number)}\`, or, if there is nothing to note, answer \`${QUIET}\`.`

// A note as a fresh reviewer's brief carries it: a first line naming the review, then the note's body.
export const frameNote = (number: number, body: string): string => `${reviewLine(number)}\n${body}`
