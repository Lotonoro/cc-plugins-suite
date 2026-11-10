import type { ModelUsage } from 'claude-code'
import type { Conversation, ReviewUsage } from '../types/index'
import { PRICED_MODEL, isPriced, priceOf } from './pricing'

// The tally's transitions as conversation-in, conversation-out functions: the auditor's reviewers' spend at API list prices since the conversation began or the auditor was last switched on. register.ts keeps the state writes, and calls these inside the changes it already makes.

// Adds `usage` priced as `model`. A model that is not priced makes the cost unknown, naming it, and it stays unknown until the tally restarts. Nothing is added while the auditor is off.
const added = (c: Conversation, usage: ModelUsage, model: string): Conversation => {
  if (c.off || c.unpriced !== null) return c
  if (!isPriced(model)) return { ...c, unpriced: model }
  // A usage with a missing count prices as NaN, which would poison the tally for good: it adds nothing.
  const price = priceOf(usage)
  return Number.isFinite(price) ? { ...c, spent: c.spent + price } : c
}

// One reviewer response, at the model it reports.
export const withResponse = (c: Conversation, usage: ReviewUsage): Conversation => added(c, usage, usage.model)

// A reviewer compaction's own request, at the reviewer's resolved model (the pinned one when none is resolved), which its usage does not name. No usage adds nothing: core reused a summary already computed, and that request was counted when it ran.
export const withCompaction = (c: Conversation, usage: ModelUsage | undefined): Conversation => (usage === undefined ? c : added(c, usage, c.reviewer?.model || PRICED_MODEL))

// The tally empty: a switch, whichever way, and a fresh conversation start from here.
export const purged = (c: Conversation): Conversation => ({ ...c, spent: 0, unpriced: null })
