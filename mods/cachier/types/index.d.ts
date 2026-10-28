// The cache reading the countdown shows, as the transcript reader last left it.
export type TtlLabel = '5m' | '1h'

// `model` and `speed` are the touch row's, as the transcript names them: what a refresh on this cache is priced at.
// `outputTokens` is the output of the reply row `promptTokens` comes from: the next request re-sends it with the prefix.
export type CacheView =
  | {
      kind: 'known'
      touchMs: number
      ttlMs: number
      ttlLabel: TtlLabel
      promptTokens: number
      outputTokens: number
      model: string | null
      speed: string | null
    }
  | { kind: 'ttl-unknown' }
  | { kind: 'no-cache' }
  | { kind: 'unread' }

// A cold event's mark: the cache is cold from atMs until a response after it touches the cache again.
export type ColdMark = { reason: 'model switch' | 'compaction' | 'cleared'; atMs: number }

// The unit every cost is shown in. Dollars fall back to tokens for a figure with no price.
export type Unit = 'dollars' | 'tokens'

// Tokens by what the cache did with them: uncached input, read, and written under each TTL.
export type Kinds = { input: number; read: number; write5m: number; write1h: number }
// What some requests cost: their tokens by kind, and their dollars at the price in force when each was counted. `usd` is
// null when any part had no price, and `why` says why the first such part had none.
export type Spend = Kinds & { usd: number | null; why: string | null }

// The refresh figure the line shows while keepalive refreshes (`$0.006/refresh`), and the two lines the details pane adds to
// explain it.
export type HintCost = { label: string; explain: string; figures: string }
// Whether the keepalive toggle, as it stands, is saving or wasting money now, against the toggle the other way.
export type Verdict = 'par' | 'saving' | 'wasting'
// The pauses this session's prompts ended that the marker judged: the net its toggle saved over the other way, and how many.
export type Judged = { netUsd: number; pauses: number }
// What the countdown counts on the pie and its time: the time left, or the rebuild figure once expired, and empty when cold; whether it is
// warm, expired or cold; the pie's quarter step (the quarters of the TTL left, rounded up; 0 when there is none); and how near the end it is:
// `quarter` in the TTL's last quarter, `tenth` in its last tenth, else `calm`.
export type Reading = { words: string; state: 'warm' | 'expired' | 'cold'; quarter: number; warn: 'calm' | 'quarter' | 'tenth' }

// The footer line's state, written each tick. `reading` is what the countdown counts, null for nothing to count. `cost` is the
// refresh figure while keepalive refreshes. `offer` is the figure a press would turn keepalive on at while it is off, or while it is on the
// figure of the run it is on, which a resume sends; null where that run sends no refresh.
// `paused` is why keepalive is on and not refreshing, null otherwise. The details pane's first line is `warmth` (empty when there is no
// cache to count) and `breakEven` is its break-even sentence (empty when none). Its history lives in the bare command, not here.
export type HintState = {
  reading: Reading | null
  cost: HintCost | null
  offer: HintCost | null
  paused: string | null
  warmth: string
  breakEven: string
}

// The price read's phase on the footer: running, or just landed or failed. The footer draws a cue for it after its words; it clears
// about 3 seconds after the read ends.
export type PriceCue = 'reading' | 'landed' | 'failed'

// The counts of one kind: the pings or misses, and what they spent.
export type StatCount = { count: number; spend: Spend }
// The cause a cache miss is given: the gap since the last response passed the TTL, a cold mark fell in the gap, or neither.
export type Cause = 'lapse' | 'cold' | 'unexplained'
// A pause that a user prompt ended, awaiting the first main-thread response after the prompt that classifies it: its ping
// spend, the last transcript touch and the TTL in force then, and the prompt's time.
export type PendingPause = { spend: Spend; touchMs: number; ttlMs: number; promptMs: number }
// The session's measured history, kept from the transcript's responses and the mod's own cold marks and pauses.
// `cursor` is the newest response counted; `last*` describe the newest response, for the next one's miss test; `coldSince`
// are the cold marks not yet passed by a response; `overlap` counts the ran-out pauses whose miss is also a lapse miss.
export type StatsState = {
  // The transcript these counts are of: a learn for another path starts them again, and the same path keeps them.
  transcript: string | null
  cursor: string | null
  lastAtMs: number | null
  lastTotal: number | null
  lastTtlMs: number | null
  coldSince: number[]
  misses: Record<Cause, StatCount>
  overlap: number
  // `avoided` is what the writes the pings saved would have cost.
  saved: StatCount & { avoided: Spend }
  ranOut: StatCount
  notNeeded: StatCount
  pending: PendingPause | null
  // Long pauses: gaps longer than the TTL. The count and the max are all-time; the gaps are the last LONG_GAPS_KEPT.
  longCount: number
  maxMs: number
  longGaps: number[]
}

// What forks cost, as reported by each fork's usage: the pings sent, and what they read and wrote.
export type Tally = { pings: number; spend: Spend }
// The tallies kept for the details pane and the bare command: this pause (since the user's last prompt) and this session, and
// the lead a slow ping raised this session, if one did. `epoch` is the keepalive pause epoch this tally counts for.
export type TallyState = { pause: Tally; session: Tally; raisedMs: number | null; epoch: number }

// Keepalive's state, per session, in one record so a write checks every field at once. `config` null is off, and its
// `count` is the user's pinned count, null for the break-even one; `remaining` counts the pings left of `runCount`; `stop` is why pings stopped, cleared by a user prompt; `last` is
// the cache read and write of the newest ping, answered or not; `seq` numbers the pings. `active` is whether a main-thread turn is running, and `gap` whether the idle gap is open
// (a prompt entering closes it, a turn's end opens it); `lastTurn` is the last turn counted. `coldPending` is whether a cold
// mark has begun and not landed: it holds pings until the mark's completing write lands, or, if that write fails, until a
// main-thread turn's first step clears it (`reset` carries it over).
// `generation` moves with every change that closes the idle gap, a user prompt, or the cache's context, so a ping's result
// from an older generation changes nothing.
export type KeepaliveState = {
  config: { leadMs: number; count: number | null } | null
  remaining: number
  stop: string | null
  last: { read: number; write: number } | null
  seq: number
  active: boolean
  gap: boolean
  coldPending: boolean
  lastTurn: string | null
  generation: number
  lastUsed: { leadMs: number; count: number | null } | null
  // The prompts that started a pause so far. A fork is sent with the epoch of the commit that counts it, so its tally goes to the
  // pause only while that pause is current.
  pauseEpoch: number
  // The count this run sends: the pinned count, else break-even under the cap, resolved at each enable and re-arm.
  runCount: number
}

declare module 'claude-code' {
  // Every value here is held across a plugin reload, and the code that reads it may be a later version's. A change to any
  // value's shape bumps STATE_SHAPE in register.ts: a reload under a new shape resets every value but the transcript, a
  // string, keepalive, whose fields restoreState checks one by one, and the unit, whose reader checks it.
  // hooks/shape.test.ts fails until the bump is made: see its header.
  interface PluginState {
    cachier: {
      // The STATE_SHAPE of the load that last wrote the state.
      shape: number
      transcript: string | null
      view: CacheView
      cold: ColdMark | null
      // The last cache touch in ms since the epoch: the start of the newest main-thread request, or of a keepalive fork
      // that read the cache, whichever is later; null before the first one.
      touch: number | null
      keepalive: KeepaliveState
      // The footer line's state, written when it changes: the countdown, and the cost while keepalive runs or the offer while it is off.
      hint: HintState | null
      tally: TallyState
      judged: Judged
      stats: StatsState
      // The unit costs are shown in this session; unset until the countdown's unit button is pressed, the option's then.
      unit: Unit
      // This session's price read, while it runs and for a few seconds after it ends; null otherwise. Only the session that ran the read has one.
      cue: PriceCue | null
    }
  }
}
