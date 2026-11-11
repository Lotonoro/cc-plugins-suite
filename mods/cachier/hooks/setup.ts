// The keepalive rule with one owner: the refresh interval, the TTL less the lead, which is none where the lead is not below the TTL and
// the run sends nothing; the words that say why; the seconds those words are written in; a setup's type; and the token a setup is named
// by. Pure; milliseconds in.
import type { TtlLabel } from '../types'
import { TTL_MS } from './prices'

export type Setup = { ttl: TtlLabel; keepalive: boolean }

// The gap between a run's refreshes, or null where the run sends none.
export const refreshIntervalMs = (leadMs: number, ttlMs: number): number | null => (leadMs < ttlMs ? ttlMs - leadMs : null)

export const secs = (ms: number) => `${ms / 1000} s`

// The terse seconds the reworded texts write: no space before the suffix.
export const SECONDS_SUFFIX = 's'
export const secsTerse = (ms: number) => `${ms / 1000}${SECONDS_SUFFIX}`

// Why a run sends nothing: its lead is not below the TTL.
export const notBelowTtl = (leadMs: number, ttlMs: number): string => `lead ${secsTerse(leadMs)} ≥ ${secsTerse(ttlMs)} TTL`

// A setup as a token the Advice rows name it by: its TTL and its keepalive state, `5m/on` or `1h/off`, and `5m/paused (<why>)` where its run
// at this lead sends nothing.
export const setupToken = (setup: Setup, leadMs: number): string => {
  const ttlMs = TTL_MS[setup.ttl]
  const state = !setup.keepalive ? 'off' : refreshIntervalMs(leadMs, ttlMs) === null ? `paused (${notBelowTtl(leadMs, ttlMs)})` : 'on'
  return `${setup.ttl}/${state}`
}
