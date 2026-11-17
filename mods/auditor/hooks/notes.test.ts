import { describe, expect, test } from 'claude-code/testing'
import type { Conversation, OpenReview } from '../types/index'
import { ESCALATION, QUIET, STALL, admitSend, decideRefusal, followUpText, frameNote, isStoppedRefusal, marksOf, readSend, reviewLine, settleOutcome } from './notes'
import type { Refusal, Slot } from './notes'
import { REVIEWER_PROMPT } from './prompt'

// Review 3's open slot, empty, from a brief that said nothing will wake the worker unless told otherwise.
const OPEN = (over: Partial<Slot> = {}): Slot => ({ number: 3, nothingWakes: true, ...over })
const SENT = (text: string, to = 'main') => readSend(to, text)

describe('readSend', () => {
  test('a note to main reads its number, its body, and no marks', () => {
    expect(SENT('auditor, review 3:\na.ts:4 swallows it.')).toEqual({ toMain: true, number: 3, body: 'a.ts:4 swallows it.', quiet: false, escalation: false, stall: false })
  })

  test('the body keeps every line, trimmed', () => {
    expect(SENT('\n auditor, review 3:\n\n  a.ts:4 swallows it.\n\nb.ts:2 also.\n').body).toBe('a.ts:4 swallows it.\n\nb.ts:2 also.')
  })

  test('the review line may open the first line, with the body after it', () => {
    expect(SENT('auditor, review 57: Escalation: auth.')).toMatchObject({ number: 57, body: 'Escalation: auth.', escalation: true })
  })

  test('copies of the review line after the first are set aside, so a marker after them still counts', () => {
    expect(SENT('auditor, review 3:\nauditor, review 3:\n\nStalled: nothing wakes you.')).toMatchObject({ number: 3, body: 'Stalled: nothing wakes you.', stall: true })
  })

  test('a review line mentioned mid-note is kept', () => {
    expect(SENT('auditor, review 3:\na.ts:4 swallows it.\nauditor, review 2:\nb.ts:2 also.').body).toBe('a.ts:4 swallows it.\nauditor, review 2:\nb.ts:2 also.')
  })

  test('a text with no opening review line has no number, and its body is the text', () => {
    expect(SENT('a.ts:4 swallows it. auditor, review 3:')).toMatchObject({ number: null, body: 'a.ts:4 swallows it. auditor, review 3:' })
  })

  test('the quiet status after the review line is quiet; a near miss is not', () => {
    expect(SENT('auditor, review 3:\n  Nothing to note.\n')).toMatchObject({ quiet: true })
    expect(SENT('auditor, review 3:\nNothing to note, but a.ts:4 swallows it.')).toMatchObject({ quiet: false })
  })

  test('only an address that is exactly main goes to main', () => {
    for (const to of ['Main', 'main ', 'other-agent', 'team-lead']) expect(SENT('auditor, review 3:\nx', to).toMain).toBe(false)
  })

  test('a mark counts only where it opens the body', () => {
    expect(SENT('auditor, review 3:\na.ts:4 swallows it. Escalation: not at the start. Stalled: neither.')).toMatchObject({ escalation: false, stall: false })
  })
})

describe('marksOf', () => {
  test('reads a stored body\'s marks', () => {
    expect(marksOf('Escalation: auth.')).toEqual({ escalation: true, stall: false })
    expect(marksOf('Stalled: you ended the turn.')).toEqual({ escalation: false, stall: true })
    expect(marksOf('a.ts:4 swallows it.')).toEqual({ escalation: false, stall: false })
  })
})

describe('admitSend', () => {
  const refused = (text: string, review: Slot | undefined, to = 'main'): string => {
    const verdict = admitSend(SENT(text, to), review, 7)
    if (verdict.admitted) throw new Error('admitted')
    return verdict.reason
  }

  test('a note for the open review, to main, into an empty slot is admitted at the given epoch', () => {
    expect(admitSend(SENT('auditor, review 3:\na.ts:4 swallows it.'), OPEN(), 7)).toEqual({ admitted: true, number: 3, epoch: 7 })
  })

  test('with no open review, a send is refused', () => {
    expect(refused('auditor, review 3:\nx', undefined)).toContain('no review open')
  })

  test('a send with no review line is refused, and the reason does not name the open review\'s number', () => {
    const reason = refused('a.ts:4 swallows it.', OPEN())
    expect(reason).toContain('auditor, review N:')
    expect(reason).not.toContain('3')
  })

  test('a send naming another review\'s number is refused', () => {
    expect(refused('auditor, review 2:\nx', OPEN())).toContain('review 2 is not the open review')
  })

  test('a send to anyone but main is refused', () => {
    expect(refused('auditor, review 3:\nx', OPEN(), 'team-lead')).toContain('"main" only')
  })

  test('an empty or whitespace body is refused', () => {
    expect(refused('auditor, review 3:', OPEN())).toContain('nothing after its review line')
    expect(refused('auditor, review 3:\n \n\t', OPEN())).toContain('nothing after its review line')
  })

  test('the quiet status is refused', () => {
    expect(refused('auditor, review 3:\nNothing to note.', OPEN())).toContain('a quiet review sends nothing')
  })

  test('a second note into a filled slot is refused', () => {
    expect(refused('auditor, review 3:\nb.ts:1 too.', OPEN({ note: 'a.ts:4 swallows it.' }))).toContain('one note already')
  })

  test('a stall note is refused from a review whose brief did not say nothing will wake the worker, and admitted from one that did', () => {
    expect(refused('auditor, review 3:\nStalled: x.', OPEN({ nothingWakes: false }))).toContain('sends no "Stalled:" note')
    expect(admitSend(SENT('auditor, review 3:\nStalled: x.'), OPEN(), 7)).toMatchObject({ admitted: true })
  })
})

describe('isStoppedRefusal', () => {
  test('both measured wordings, naming main and naming a teammate, are the stopped-session refusal', () => {
    expect(isStoppedRefusal('The main conversation was not messaged: the session was stopped and nobody has sent input since.')).toBe(true)
    expect(isStoppedRefusal('Teammate "auditor-reviewer" was not messaged: the session was stopped and nobody has sent input since.')).toBe(true)
  })

  test('another refusal is not, nor a near miss of the tail', () => {
    expect(isStoppedRefusal('main is gone')).toBe(false)
    expect(isStoppedRefusal('the session was stopped')).toBe(false)
    expect(isStoppedRefusal('Not sent: a plugin hook refused it (no)')).toBe(false)
  })
})

describe('decideRefusal', () => {
  const STOPPED = 'The main conversation was not messaged: the session was stopped and nobody has sent input since.'
  // Review 3 is open at epoch 7, its slot filled when the note was admitted (the gate) or still empty (the follow-up).
  const conversation = (over: Partial<Conversation> = {}, review: Partial<OpenReview> = {}): Conversation =>
    ({ epoch: 7, interrupted: false, pendingNotes: [], memory: [], review: { number: 3, record: [], dispatchedAt: 1, nothingWakes: true, ...review }, ...over }) as unknown as Conversation
  const booked = (c: Conversation): Conversation => ({ ...c, memory: [...c.memory, { number: 3, text: 'booked' }] })
  const NOTE = SENT('auditor, review 3:\na.ts:4 swallows it.')
  const refusal = (over: Partial<Refusal> = {}): Refusal => ({ number: 3, epoch: 7, sent: NOTE, reason: 'main is gone', filling: false, ...over })

  test('a note refused with the stopped-session wording is held with its booking, on the held list, its slot kept', () => {
    const c = conversation({}, { note: 'a.ts:4 swallows it.' })
    const decided = decideRefusal(c, refusal({ reason: STOPPED }), booked)
    expect(decided.outcome).toBe('hold')
    expect(decided.next).toMatchObject({ pendingNotes: [{ number: 3, text: 'a.ts:4 swallows it.' }], memory: [{ number: 3, text: 'booked' }], review: { note: 'a.ts:4 swallows it.' } })
    expect(decided.next.review).not.toHaveProperty('delivered')
  })

  test('another refusal is held while the interrupt mark is set, and releases the slot while it is not', () => {
    const c = conversation({}, { note: 'a.ts:4 swallows it.' })
    expect(decideRefusal({ ...c, interrupted: true }, refusal(), booked).outcome).toBe('hold')
    const released = decideRefusal(c, refusal(), booked)
    expect(released.outcome).toBe('release')
    expect(released.next.review).not.toHaveProperty('note')
    expect(released.next.pendingNotes).toEqual([])
  })

  test('a send that threw has no reason, so it releases whatever the mark', () => {
    const c = conversation({ interrupted: true }, { note: 'a.ts:4 swallows it.' })
    expect(decideRefusal(c, refusal({ reason: undefined }), booked).outcome).toBe('release')
  })

  test('a release clears only the send\'s own review\'s slot', () => {
    const c = conversation({}, { number: 4, note: 'later review\'s note.' })
    const decided = decideRefusal(c, refusal(), booked)
    expect(decided.outcome).toBe('release')
    expect(decided.next).toBe(c)
  })

  test('a hold under an older epoch is stale: nothing is written', () => {
    const c = conversation({ epoch: 8 }, { note: 'a.ts:4 swallows it.' })
    const decided = decideRefusal(c, refusal({ reason: STOPPED }), booked)
    expect(decided).toMatchObject({ outcome: 'hold', stale: true })
    expect(decided.next).toBe(c)
  })

  test('the follow-up\'s note is admitted into the empty slot and held when a signal is there', () => {
    const decided = decideRefusal(conversation(), refusal({ reason: STOPPED, filling: true }), booked)
    expect(decided.outcome).toBe('hold')
    expect(decided.next).toMatchObject({ pendingNotes: [{ number: 3, text: 'a.ts:4 swallows it.' }], review: { note: 'a.ts:4 swallows it.' } })
    expect(decideRefusal(conversation({ interrupted: true }), refusal({ filling: true }), booked).outcome).toBe('hold')
  })

  test('the follow-up with neither signal never touches the slot', () => {
    const c = conversation()
    const decided = decideRefusal(c, refusal({ filling: true }), booked)
    expect(decided.outcome).toBe('untouched')
    expect(decided.next).toBe(c)
  })

  test('the follow-up\'s note admission refuses is not held, and admission\'s reason comes back', () => {
    const c = conversation({}, { nothingWakes: false })
    const decided = decideRefusal(c, refusal({ reason: STOPPED, filling: true, sent: SENT('auditor, review 3:\nStalled: x.') }), booked)
    expect(decided.outcome).toBe('untouched')
    expect(decided.refused).toContain('sends no "Stalled:" note')
    expect(decided.next).toBe(c)
  })

  test('the follow-up under an older epoch fills no slot and holds nothing', () => {
    const c = conversation({ epoch: 8 })
    const decided = decideRefusal(c, refusal({ reason: STOPPED, filling: true }), booked)
    expect(decided.outcome).toBe('untouched')
    expect(decided.next).toBe(c)
  })
})

describe('settleOutcome', () => {
  // Review 4's turn end, with no note booked and no follow-up yet unless told otherwise.
  const END = (answer: string, over: Partial<Parameters<typeof settleOutcome>[0]> = {}) => settleOutcome({ note: undefined, number: 4, followedUp: false, reason: 'answer', answer, ...over })

  test('a booked note completes the review with it, whatever the turn end, and logs no answer', () => {
    expect(END('Sent.', { note: 'a.ts:4 swallows it.' })).toEqual({ status: 'complete', note: 'a.ts:4 swallows it.', logAnswer: false })
    expect(END('', { note: 'a.ts:4 swallows it.', reason: 'aborted' })).toEqual({ status: 'complete', note: 'a.ts:4 swallows it.', logAnswer: false })
    expect(END('auditor, review 4:\na.ts:4 swallows it.', { note: 'a.ts:4 swallows it.' })).toEqual({ status: 'complete', note: 'a.ts:4 swallows it.', logAnswer: false })
  })

  test('no note and a non-empty answer completes the review quiet, logged only when it is not the quiet status; an empty answer, a copied review line alone included, is incomplete', () => {
    expect(END('')).toEqual({ status: 'incomplete' })
    expect(END(' \n\t')).toEqual({ status: 'incomplete' })
    expect(END('auditor, review 4:\n  ')).toEqual({ status: 'incomplete' })
    expect(END(' Nothing to note.\n')).toEqual({ status: 'complete', note: null, logAnswer: false })
    expect(END('auditor, review 4:\nNothing to note.')).toEqual({ status: 'complete', note: null, logAnswer: false })
    expect(END('a.ts:4 swallows it.')).toEqual({ status: 'complete', note: null, logAnswer: true })
  })

  test('a note written as the answer, opening with the review\'s own line, gets the follow-up, a padded quiet status included', () => {
    expect(END('auditor, review 4:\na.ts:4 swallows it.')).toEqual({ status: 'follow-up' })
    expect(END('  auditor, review 4: a.ts:4 swallows it.')).toEqual({ status: 'follow-up' })
    expect(END('auditor, review 4:\nNothing to note. The worker left a.ts:4 as it was.')).toEqual({ status: 'follow-up' })
  })

  test('an answer without the review\'s own line, with an empty or exactly quiet body, or after the follow-up, settles without one', () => {
    expect(END('a.ts:4 swallows it. auditor, review 4:')).toEqual({ status: 'complete', note: null, logAnswer: true })
    expect(END('auditor, review 3:\na.ts:4 swallows it.')).toEqual({ status: 'complete', note: null, logAnswer: true })
    expect(END('auditor, review 4:\n Nothing to note. ')).toEqual({ status: 'complete', note: null, logAnswer: false })
    expect(END('auditor, review 4:')).toEqual({ status: 'incomplete' })
    expect(END('auditor, review 4:\na.ts:4 swallows it.', { followedUp: true })).toEqual({ status: 'complete', note: null, logAnswer: true })
    expect(END('Nothing to note.', { followedUp: true })).toEqual({ status: 'complete', note: null, logAnswer: false })
    expect(END('auditor, review 4:\na.ts:4 swallows it.', { reason: 'aborted' })).toEqual({ status: 'incomplete' })
  })

  test('no note and any other end fails the review', () => {
    expect(END('a.ts:4', { reason: 'aborted' })).toEqual({ status: 'incomplete' })
    expect(END('', { reason: 'error' })).toEqual({ status: 'incomplete' })
  })
})

describe('followUpText', () => {
  test('names the review, says it is not a new review and to fetch no entries, and asks for the note sent to main opening with the review line, or the quiet status', () => {
    const text = followUpText(4)
    expect(text).toContain('not a new review')
    expect(text).toContain('fetch no entries')
    expect(text).toContain('`main` with SendMessage')
    expect(text).toContain('opening with `auditor, review 4:`')
    expect(text).toContain('answer `Nothing to note.`')
  })
})

describe('frameNote', () => {
  test('the note follows a first line naming its review number', () => {
    expect(frameNote(3, 'a.ts:4 swallows it.')).toBe('auditor, review 3:\na.ts:4 swallows it.')
  })
})

describe('the prompt and the verdict agree', () => {
  test('for every review number, the review line, the quiet status and the marks the prompt names are the ones the verdict matches', () => {
    for (const marker of [reviewLine('N'), QUIET, ESCALATION, STALL]) expect(REVIEWER_PROMPT).toContain(`\`${marker}\``)
    for (const n of [1, 9, 10, 4321]) {
      const line = reviewLine('N').replace('N', String(n))
      expect(admitSend(SENT(`${line}\na.ts:4 swallows it.`), OPEN({ number: n }), 0)).toMatchObject({ admitted: true, number: n })
      expect(SENT(`${line}\n${QUIET}`).quiet).toBe(true)
      expect(SENT(`${line}\n${ESCALATION} auth.`).escalation).toBe(true)
      expect(SENT(`${line}\n${STALL} nothing wakes you.`).stall).toBe(true)
    }
  })
})
