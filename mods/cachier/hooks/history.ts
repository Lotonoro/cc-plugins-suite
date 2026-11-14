// The user's pauses across sessions, kept in the plugin's store: the habit a learned ping count is read from. Each record
// is timing and price metadata only, never anything from the conversation.
//
// Every session writes only its own key, `pauses/<transcript id>`, and readers merge the keys. The store re-reads its file
// on every get and set and writes one key at a time, so two sessions never write one key; a single shared list would
// lose one session's record whenever two sessions' prompts land together.

// One pause a user's prompt ended. `hour` (0 to 23) and `weekday` (0 is Sunday) are local, at the pause's start, when a
// count must be chosen. `ratio` is what a rewrite costs over a ping, in pings, or null for a model with no price.
// `contextTokens` is the cached context at the pause's start, and `grownTokens` how much it grew since this session's
// previous pause: the turn's own writes, which a longer TTL makes dearer. Pauses recorded before 0.11.0 have neither.
export type PauseRecord = {
  startMs: number
  pausedMs: number
  hour: number
  weekday: number
  ratio: number | null
  ttlMs: number
  contextTokens?: number
  grownTokens?: number
}

// How many pauses are kept, the newest first: one to two weeks of steady use. A count, not a time window, so a break from
// work keeps the habits from before it.
export const HISTORY_BOUND = 2000

export const KEY_PREFIX = 'pauses/'

// The session's id: the transcript's file name without its extension. The one rule every per-session store key is named by.
export const idOf = (transcriptPath: string): string => {
  const name = transcriptPath.slice(transcriptPath.lastIndexOf('/') + 1)
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name
}

// The store key a transcript's session writes its pauses under. A resumed session writes on under its own key.
export const keyOf = (transcriptPath: string): string => KEY_PREFIX + idOf(transcriptPath)

export const recordOf = (
  startMs: number,
  endMs: number,
  ratio: number | null,
  ttlMs: number,
  contextTokens: number,
  previous: readonly PauseRecord[],
): PauseRecord => {
  const at = new Date(startMs)
  // The ratio to two places: prices are quoted to a few digits, and their quotient's float tail is noise.
  const rounded = ratio === null ? null : Math.round(ratio * 100) / 100
  // A session's first pause grew from nothing; a context that shrank (a compaction, a clear) grew by none.
  const before = previous[previous.length - 1]?.contextTokens ?? 0
  const grownTokens = Math.max(0, contextTokens - before)
  return { startMs, pausedMs: endMs - startMs, hour: at.getHours(), weekday: at.getDay(), ratio: rounded, ttlMs, contextTokens, grownTokens }
}

const isRecord = (r: unknown): r is PauseRecord => {
  if (typeof r !== 'object' || r === null) return false
  const v = r as Record<string, unknown>
  return (
    typeof v.startMs === 'number' &&
    typeof v.pausedMs === 'number' &&
    typeof v.hour === 'number' &&
    typeof v.weekday === 'number' &&
    (v.ratio === null || typeof v.ratio === 'number') &&
    typeof v.ttlMs === 'number' &&
    (v.contextTokens === undefined || typeof v.contextTokens === 'number') &&
    (v.grownTokens === undefined || typeof v.grownTokens === 'number')
  )
}

// A key's records as stored. Anything else under it, from another version or a hand edit, reads as no records, and a
// record of another shape is skipped.
export const recordsOf = (held: unknown): PauseRecord[] => (Array.isArray(held) ? held.filter(isRecord) : [])

// A pause's identity: its start, length, context and TTL. Two sessions' pauses can start in the same millisecond, but not also last as long
// over the same context.
export const identityOf = (r: PauseRecord): string => [r.startMs, r.pausedMs, r.contextTokens, r.ttlMs].join('|')

// The records a read returned, then each held record it did not return: one written after the read was answered, or never written.
export const merged = (read: readonly PauseRecord[], held: readonly PauseRecord[]): PauseRecord[] => {
  const seen = new Set(read.map(identityOf))
  return [...read, ...held.filter((r) => !seen.has(identityOf(r)))]
}

// A session's key with one more pause, the oldest dropped past the bound.
export const appended = (held: unknown, r: PauseRecord): PauseRecord[] => [...recordsOf(held), r].slice(-HISTORY_BOUND)

// The store's trim: the pause keys whose every record is older than the newest HISTORY_BOUND pauses over all keys. A key
// that straddles the cut is kept whole: rewriting another session's key could drop a record that session appended between
// this read and that write, so the store holds at most one key's worth past the bound, and each key is bounded on its own.
export const staleKeys = (keys: Readonly<Record<string, unknown>>): string[] => {
  const starts = Object.values(keys).flatMap((held) => recordsOf(held).map((r) => r.startMs))
  if (starts.length <= HISTORY_BOUND) return []
  const cut = starts.sort((a, b) => b - a)[HISTORY_BOUND - 1]!
  return Object.entries(keys)
    .filter(([, held]) => recordsOf(held).every((r) => r.startMs < cut))
    .map(([key]) => key)
}
