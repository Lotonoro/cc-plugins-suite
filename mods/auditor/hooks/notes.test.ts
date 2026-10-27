import { describe, expect, test } from 'claude-code/testing'
import { answerBody, frameNote, readNote } from './notes'

describe('readNote', () => {
  test('exactly the quiet answer is no note', () => {
    expect(readNote('Nothing to note.')).toBeNull()
  })

  test('a quiet answer with surrounding whitespace is still no note', () => {
    expect(readNote('\n  Nothing to note.\n\n')).toBeNull()
  })

  test('a near miss of the quiet answer is a note, whole', () => {
    expect(readNote('Nothing to note, but a.ts:4 swallows the error.')).toEqual({ text: 'Nothing to note, but a.ts:4 swallows the error.', escalation: false, stall: false })
  })

  test('a note is its trimmed text, every line kept', () => {
    expect(readNote('\n\n  a.ts:4 swallows it.\n\nb.ts:2 also.\n')).toEqual({ text: 'a.ts:4 swallows it.\n\nb.ts:2 also.', escalation: false, stall: false })
  })

  test('a note opening with Escalation: is an escalation', () => {
    expect(readNote('Escalation: Disagreement on auth. Worker: JWT in handlers. Me: middleware. Escalating.')).toMatchObject({ escalation: true })
  })

  test('Escalation: after the start of the answer does not make it an escalation', () => {
    expect(readNote('a.ts:4 swallows it. Escalation: not at the start.')).toMatchObject({ escalation: false })
  })

  test('a note opening with Stalled: is a stall', () => {
    expect(readNote('Stalled: you said you would update the config and ended the turn; nothing will wake you.')).toEqual({ text: 'Stalled: you said you would update the config and ended the turn; nothing will wake you.', escalation: false, stall: true })
  })

  test('Stalled: after the start of the answer does not make it a stall', () => {
    expect(readNote('a.ts:4 swallows it. Stalled: not at the start.')).toMatchObject({ stall: false })
  })
})

describe('the copied header', () => {
  test('a copied header is stripped, and the framed note carries it once', () => {
    const note = readNote('auditor, review 3:\n\na.ts:4 swallows it.')
    expect(note).toEqual({ text: 'a.ts:4 swallows it.', escalation: false, stall: false })
    expect(frameNote(3, note?.text ?? '')).toBe('auditor, review 3:\na.ts:4 swallows it.')
  })

  test('a header with a different number is stripped too', () => {
    expect(readNote('auditor, review 12:\na.ts:4 swallows it.')).toEqual({ text: 'a.ts:4 swallows it.', escalation: false, stall: false })
  })

  test('a header copied on the note\'s first line is stripped, so a marker after it still counts', () => {
    expect(readNote('auditor, review 57: a.ts:4 swallows it.')).toEqual({ text: 'a.ts:4 swallows it.', escalation: false, stall: false })
    expect(readNote('auditor, review 57: Escalation: auth.')).toMatchObject({ text: 'Escalation: auth.', escalation: true })
  })

  test('a header mentioned mid-note is kept', () => {
    expect(readNote('a.ts:4 swallows it.\nauditor, review 2:\nb.ts:2 also.')).toEqual({ text: 'a.ts:4 swallows it.\nauditor, review 2:\nb.ts:2 also.', escalation: false, stall: false })
  })

  test('a header-only answer has an empty body, as an empty answer does', () => {
    expect(answerBody('auditor, review 4:\n\n  ')).toBe('')
  })
})

describe('frameNote', () => {
  test('the note follows a first line naming its review number', () => {
    expect(frameNote(3, 'a.ts:4 swallows it.')).toBe('auditor, review 3:\na.ts:4 swallows it.')
  })
})
