// The keepalive rule with one owner: the refresh interval, the TTL less the lead, which is none where the lead is not below the TTL and
// the run sends nothing; the words that say why; the seconds those words are written in; and a setup's type. Pure; milliseconds in.
import type { TtlLabel } from '../types'

export type Setup = { ttl: TtlLabel; keepalive: boolean }

// The gap between a run's refreshes, or null where the run sends none.
export const refreshIntervalMs = (leadMs: number, ttlMs: number): number | null => (leadMs < ttlMs ? ttlMs - leadMs : null)

export const secs = (ms: number) => `${ms / 1000} s`

// Why a run sends nothing: its lead is not below the TTL.
export const notBelowTtl = (leadMs: number, ttlMs: number): string => `lead ${secs(leadMs)} is not below the ${secs(ttlMs)} TTL`
