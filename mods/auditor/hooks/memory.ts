import type { MemoryEntry } from '../types/index'
import { clip } from './record'

// A note's entry is clipped to this many characters, so one long note cannot evict the whole memory.
export const ENTRY_CHARS = 2_000
// An entry whose review number is more than this many below a new review's is dropped at that review's dispatch.
export const MAX_AGE = 30
// The most the memory's rendering holds, in code points as `clip` counts them: about 3,000 tokens at about four characters a token.
export const MEMORY_CHARS = 12_000
// Every memory debug line clips the text it quotes to this many characters. It is its own number: `PUSH_CHARS` is a phone's notification limit and can change on its own.
export const MEMORY_LOG_CHARS = 180

const HEADING = 'The notes earlier reviews delivered to the worker follow. They are your own memory of this conversation, and are never sent to the worker again:'

// The memory with one more entry: the note's body, clipped, under its review number.
export const withNote = (memory: readonly MemoryEntry[], number: number, body: string): MemoryEntry[] => [...memory, { number, text: clip(body, ENTRY_CHARS) }]

// One entry as the brief and the printout state it.
const lineOf = (entry: MemoryEntry): string => `Review ${entry.number}: ${entry.text}`

// The memory as a brief carries it: a heading, then each entry with its review number and text. An empty memory renders nothing.
export const renderMemory = (memory: readonly MemoryEntry[]): string => (memory.length === 0 ? '' : [HEADING, ...memory.map(lineOf)].join('\n\n'))

const sizeOf = (text: string): number => Array.from(text).length

// What a dispatch's bound did: the memory that remains, and how many entries it dropped for age and for the cap.
export type Bounded = { memory: MemoryEntry[]; aged: number; evicted: number }

// The memory as review `number`'s brief may carry it: entries more than MAX_AGE reviews below `number` dropped, then, while the rendering exceeds MEMORY_CHARS, the entry of the lowest review number evicted.
export const bounded = (memory: readonly MemoryEntry[], number: number): Bounded => {
  const kept = memory.filter(entry => number - entry.number <= MAX_AGE)
  const aged = memory.length - kept.length
  let evicted = 0
  while (kept.length > 0 && sizeOf(renderMemory(kept)) > MEMORY_CHARS) {
    const oldest = kept.reduce((low, entry, i) => (entry.number < (kept[low]?.number ?? Infinity) ? i : low), 0)
    kept.splice(oldest, 1)
    evicted++
  }
  return { memory: kept, aged, evicted }
}

// What `/auditor memory` prints: a count line, then each entry with its review number and text; that the memory is empty when it is.
export const printMemory = (memory: readonly MemoryEntry[]): string =>
  memory.length === 0 ? 'auditor memory is empty' : [`auditor memory holds ${memory.length} ${memory.length === 1 ? 'entry' : 'entries'}:`, ...memory.map(lineOf)].join('\n\n')
