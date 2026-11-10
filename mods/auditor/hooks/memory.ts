import type { MemoryEntry } from '../types/index'
import { clip } from './record'

// A note's entry is clipped to this many characters, so one long note cannot evict the whole memory.
export const ENTRY_CHARS = 2_000
// An entry last touched more than this many reviews below a new review's number is dropped at that review's dispatch.
export const MAX_AGE = 30
// The most the memory's rendering holds, in code points as `clip` counts them: about 3,000 tokens at about four characters a token.
export const MEMORY_CHARS = 12_000
// Every memory debug line clips the text it quotes to this many characters. It is its own number: `PUSH_CHARS` is a phone's notification limit and can change on its own.
export const MEMORY_LOG_CHARS = 180
// The most a memory call's `why` may hold, in code points: a reason, not a second note.
export const WHY_CHARS = 400

// The reviewer's memory tool, as the engine names the deferred tool `register.ts` registers under the short name `memory`. A literal, so the tool-input type keyed by it in `types/index.d.ts` checks a hook's matcher.
export const MEMORY = 'mcp__auditor__memory'
// The memory tool's two actions: neither adds an entry, which only a booked note does.
export const MEMORY_ACTION = { settle: 'settle', remove: 'remove' } as const
// The memory tool's fields, spelled again in the tool-input types.
export const MEMORY_FIELD = { action: 'action', review: 'review', why: 'why' } as const
// What the reviewer reads when its call reached the memory after its review closed, its epoch moved or it stopped being the stored reviewer.
export const REVIEW_ENDED = "auditor's review ended before this change, so the memory was not changed; end your turn"

const HEADING = 'The notes earlier reviews delivered to the worker follow. They are your own memory of this conversation, and are never sent to the worker again:'

// The memory with one more entry: the note's body, clipped, under its review number, in flight and touched at that number.
export const withNote = (memory: readonly MemoryEntry[], number: number, body: string): MemoryEntry[] => [...memory, { number, text: clip(body, ENTRY_CHARS) }]

// The review that last touched an entry: a settle's, else the one that booked it.
const touchedOf = (entry: MemoryEntry): number => entry.touched ?? entry.number

// Text on one line: every run of whitespace, line breaks included, becomes one space, so a blank line inside a note or a reason never starts a paragraph that reads as an entry of its own.
const folded = (text: string): string => text.replace(/\s+/g, ' ').trim()

// One entry as the brief and the printout state it, on one line: its review number, its kind, its last touch, a settled one's reason, then its note.
const lineOf = (entry: MemoryEntry): string =>
  entry.kind === 'settled'
    ? `Review ${entry.number} (settled, last touched in review ${touchedOf(entry)}; the reason: ${folded(entry.why)}): ${folded(entry.text)}`
    : `Review ${entry.number} (in flight, last touched in review ${touchedOf(entry)}): ${folded(entry.text)}`

// The entries in the order they are stated: in flight first, then settled, each kind in stored order.
const ordered = (memory: readonly MemoryEntry[]): MemoryEntry[] => [...memory.filter(e => e.kind !== 'settled'), ...memory.filter(e => e.kind === 'settled')]

// The memory as a brief carries it: a heading, then each entry as `lineOf` states it. An empty memory renders nothing.
export const renderMemory = (memory: readonly MemoryEntry[]): string => (memory.length === 0 ? '' : [HEADING, ...ordered(memory).map(lineOf)].join('\n\n'))

const sizeOf = (text: string): number => Array.from(text).length

// What a dispatch's bound did: the memory that remains, and how many entries it dropped for age and for the cap.
export type Bounded = { memory: MemoryEntry[]; aged: number; evicted: number }

// The index of the entry the cap evicts next: the oldest-touched settled entry while any is left, since losing one costs a repeated finding that settles again; else the oldest-touched in-flight one. A tie goes to the lower review number.
const nextEvicted = (memory: readonly MemoryEntry[]): number => {
  const settled = memory.some(e => e.kind === 'settled')
  let pick = -1
  memory.forEach((entry, i) => {
    if (settled && entry.kind !== 'settled') return
    const low = memory[pick]
    if (low === undefined || touchedOf(entry) < touchedOf(low) || (touchedOf(entry) === touchedOf(low) && entry.number < low.number)) pick = i
  })
  return pick
}

// The memory as review `number`'s brief may carry it: entries last touched more than MAX_AGE reviews below `number` dropped, then, while the rendering exceeds MEMORY_CHARS, an entry evicted (`nextEvicted`).
export const bounded = (memory: readonly MemoryEntry[], number: number): Bounded => {
  const kept = memory.filter(entry => number - touchedOf(entry) <= MAX_AGE)
  const aged = memory.length - kept.length
  let evicted = 0
  while (kept.length > 0 && sizeOf(renderMemory(kept)) > MEMORY_CHARS) {
    kept.splice(nextEvicted(kept), 1)
    evicted++
  }
  return { memory: kept, aged, evicted }
}

// A memory call's input, by the tool's field names.
export type MemoryCall = Record<(typeof MEMORY_FIELD)[keyof typeof MEMORY_FIELD], unknown>

// A memory call judged: the memory it leaves, the answer the reviewer reads and the debug line, without the plugin's prefix; or the refusal the reviewer reads, the memory unchanged.
export type MemoryChange = { memory: MemoryEntry[]; answer: string; logged: string } | { refusal: string }

const refused = (why: string): MemoryChange => ({ refusal: `${why}, so the memory was not changed` })

// Judges one memory call against `memory` while review `open` is open (undefined when none is): a settle makes the entry settled with the call's `why` as its reason and touches it at `open`, settled before or not; a remove takes it out. Anything else is refused, checked in this order: no open review, the action, the review number, the `why`, folded to one line before it is counted, stored, answered or logged, then a settle of the entry the open review itself booked, which the worker has not answered.
export const changeMemory = (memory: readonly MemoryEntry[], open: number | undefined, input: MemoryCall): MemoryChange => {
  if (open === undefined) return refused('auditor has no review in progress for this reviewer')
  const action = input[MEMORY_FIELD.action]
  if (action !== MEMORY_ACTION.settle && action !== MEMORY_ACTION.remove) return refused(`${MEMORY_FIELD.action} must be ${MEMORY_ACTION.settle} or ${MEMORY_ACTION.remove}`)
  const review = input[MEMORY_FIELD.review]
  if (review === undefined) return refused(`${MEMORY_FIELD.review} is missing: give the review number of the entry to change`)
  if (typeof review !== 'number' || !Number.isInteger(review)) return refused(`${MEMORY_FIELD.review} must be a whole review number`)
  const target = memory.find(e => e.number === review)
  if (target === undefined) return { refusal: `the memory holds no entry for review ${review}, so it was not changed` }
  const given = input[MEMORY_FIELD.why]
  if (typeof given !== 'string' || given.trim() === '') return refused(`${MEMORY_FIELD.why} is missing or blank`)
  const why = folded(given)
  if (sizeOf(why) > WHY_CHARS) return refused(`${MEMORY_FIELD.why} is ${sizeOf(why)} characters, over the ${WHY_CHARS} allowed`)
  if (action === MEMORY_ACTION.remove) {
    return { memory: memory.filter(e => e !== target), answer: `Review ${review}'s entry is removed.`, logged: `memory entry for review ${review} removed: ${clip(target.text, MEMORY_LOG_CHARS)}; why: ${clip(why, MEMORY_LOG_CHARS)}` }
  }
  if (review === open) return refused(`review ${review} is this review's own entry, which the worker has not answered yet, and a ${MEMORY_ACTION.settle} needs the worker's counter`)
  const settled: MemoryEntry = { number: target.number, text: target.text, kind: 'settled', touched: open, why }
  return { memory: memory.map(e => (e === target ? settled : e)), answer: `Review ${review}'s entry is now settled, with the reason: ${why}`, logged: `memory entry for review ${review} settled: ${clip(why, MEMORY_LOG_CHARS)}` }
}

// What `/auditor memory` prints: a count line with the count of each kind, then each entry as the brief states it; that the memory is empty when it is.
export const printMemory = (memory: readonly MemoryEntry[]): string => {
  if (memory.length === 0) return 'auditor memory is empty'
  const settled = memory.filter(e => e.kind === 'settled').length
  const count = `auditor memory holds ${memory.length} ${memory.length === 1 ? 'entry' : 'entries'}, ${memory.length - settled} in flight and ${settled} settled:`
  return [count, ...ordered(memory).map(lineOf)].join('\n\n')
}
