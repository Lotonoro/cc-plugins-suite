// The keepalive rule with one owner: the refresh interval, the TTL less the lead, which is none where the lead is not below the TTL and
// the run sends nothing; the words that say why; the seconds those words are written in; a setup's type; and the words a setup is named
// in. Pure; milliseconds in.
import type { TtlLabel } from '../types'
import { TTL_MS, TTL_WORDS } from './prices'

export type Setup = { ttl: TtlLabel; keepalive: boolean }

// The gap between a run's refreshes, or null where the run sends none.
export const refreshIntervalMs = (leadMs: number, ttlMs: number): number | null => (leadMs < ttlMs ? ttlMs - leadMs : null)

export const secs = (ms: number) => `${ms / 1000} s`

// Why a run sends nothing: its lead is not below the TTL.
export const notBelowTtl = (leadMs: number, ttlMs: number): string => `lead ${secs(leadMs)} is not below the ${secs(ttlMs)} TTL`

// A setup in the words a sentence names it by: its TTL, and its keepalive state, which is paused, with the reason, where its run at this
// lead sends nothing.
export const setupPhrase = (setup: Setup, leadMs: number): string => {
  const ttlMs = TTL_MS[setup.ttl]
  const state = !setup.keepalive ? 'off' : refreshIntervalMs(leadMs, ttlMs) === null ? `paused, sending nothing (${notBelowTtl(leadMs, ttlMs)})` : 'on'
  return `a ${TTL_WORDS[setup.ttl]} cache with keepalive ${state}`
}
