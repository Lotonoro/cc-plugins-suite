import type { ModelUsage } from 'claude-code'
import type { Conversation, ReviewUsage } from '../types/index'
import { entryOf, priceOf } from './pricing'

// The tally's and the review counters' transitions as conversation-in, conversation-out functions: the auditor's reviewers' spend at API list prices, the reviews completed and the notes given, since the conversation began or the auditor was last switched on. register.ts keeps the state writes, and calls these inside the changes it already makes.

// Adds `usage` priced as `model`. A model that is not priced makes the cost unknown, naming it, and it stays unknown until the tally restarts. Nothing is added while the auditor is off.
const added = (c: Conversation, usage: ModelUsage, model: string): Conversation => {
  if (c.off || c.unpriced !== null) return c
  const entry = entryOf(model)
  if (entry === undefined) return { ...c, unpriced: model }
  // A usage with a missing count prices as NaN, which would poison the tally for good: it adds nothing.
  const price = priceOf(entry, usage)
  return Number.isFinite(price) ? { ...c, spent: c.spent + price } : c
}

// One reviewer response, at the model it reports.
export const withResponse = (c: Conversation, usage: ReviewUsage): Conversation => added(c, usage, usage.model)

// What the unpriced mark names where a compaction's model is not known, so the cost reads as unknown for a named model rather than a blank.
export const UNKNOWN_MODEL = 'an unknown model'

// A reviewer compaction's own request, at the model its caller says the compacting reviewer ran on, which its usage does not name (`compactionModel` in reviewer.ts decides it). Where the caller knows none, the cost is unknown and the mark names `UNKNOWN_MODEL`. No usage adds nothing: core reused a summary already computed, and that request was counted when it ran.
export const withCompaction = (c: Conversation, usage: ModelUsage | undefined, model: string | undefined): Conversation => (usage === undefined ? c : added(c, usage, model || UNKNOWN_MODEL))

// A review that completed at `at`, with a note or quiet. Nothing is counted while the auditor is off.
export const withReviewDone = (c: Conversation, at: number, note: boolean): Conversation => (c.off ? c : { ...c, reviews: c.reviews + 1, last: { at, note } })

// A note booked, delivered or held. Nothing is counted while the auditor is off.
export const withNoteGiven = (c: Conversation): Conversation => (c.off ? c : { ...c, notes: c.notes + 1 })

// The tally and the counters empty: a switch, whichever way, and a fresh conversation start from here.
export const purged = (c: Conversation): Conversation => ({ ...c, spent: 0, unpriced: null, reviews: 0, notes: 0, last: undefined })
