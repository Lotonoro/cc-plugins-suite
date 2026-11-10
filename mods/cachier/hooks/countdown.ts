import type { CacheView, ColdMark, PriceCue, Reading } from '../types'

const pad = (n: number) => String(n).padStart(2, '0')

// A span of time by the whole second: m:ss under an hour, h:mm:ss past it.
export const clockOf = (overMs: number) => {
  const seconds = Math.floor(overMs / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor(seconds / 60) % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`
}

// When the cache was last touched: the later of the transcript's reply start and the live request start the mod saw.
// Null when there is no known TTL to count from.
export const touchOf = (view: CacheView, liveMs: number | null): number | null => {
  if (view.kind !== 'known') return null
  return liveMs === null ? view.touchMs : Math.max(view.touchMs, liveMs)
}

// When the live cache expires: the touch plus the TTL, or null for a view with no touch. The one owner of the cache's expiry, asked at any lead.
export const expiryOf = (view: CacheView, liveMs: number | null): number | null => {
  const touch = touchOf(view, liveMs)
  return view.kind === 'known' && touch !== null ? touch + view.ttlMs : null
}

// Whether the live cache has expired at `nowMs`: at exactly the expiry moment it has. A view with no touch never has.
export const expiredAt = (view: CacheView, liveMs: number | null, nowMs: number): boolean => {
  const expiry = expiryOf(view, liveMs)
  return expiry !== null && nowMs >= expiry
}

// A reply's stamp read at `nowMs` that runs ahead of the clock counts as now, so the countdown and keepalive read one touch. The
// view is read through this once, where its stamp is read.
export const touchedAt = (view: CacheView, nowMs: number): CacheView =>
  view.kind === 'known' && view.touchMs > nowMs ? { ...view, touchMs: nowMs } : view

// The pie's quarter step: the quarters of the TTL left, rounded up, so a warm cache always shows at least the first.
const quarterOf = (leftMs: number, ttlMs: number): number => Math.ceil((leftMs * 4) / ttlMs)

// What the countdown counts, or null for nothing to count: no cache yet, after a clear, or a TTL unknown or unread. `rebuild` is the
// figure the next prompt pays to rebuild an expired cache. A cold mark outranks the reading: it holds until a touch after it.
export const readingOf = (view: CacheView, liveMs: number | null, cold: ColdMark | null, nowMs: number, rebuild: string): Reading | null => {
  if (cold !== null && cold.reason === 'cleared') return null
  if (view.kind === 'no-cache') return null
  if (cold !== null) return { words: '', state: 'cold', quarter: 0, warn: 'calm' }
  if (view.kind !== 'known') return null
  // Never more than the TTL, as a live touch read after `nowMs` would put it: the pie and its time stop at full.
  if (expiredAt(view, liveMs, nowMs)) return { words: `${rebuild} to rebuild`, state: 'expired', quarter: 0, warn: 'calm' }
  const left = Math.min(view.ttlMs, (expiryOf(view, liveMs) ?? 0) - nowMs)
  const seconds = Math.ceil(left / 1000)
  const warn = left * 10 <= view.ttlMs ? 'tenth' : left * 4 <= view.ttlMs ? 'quarter' : 'calm'
  return { words: `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`, state: 'warm', quarter: quarterOf(left, view.ttlMs), warn }
}

// The pie's tone: green while keepalive will send the next refresh, and whenever it is on with nothing to count or a cold cache, unless a
// recorded stop stands, which makes it red. Otherwise the cache is left to the person: the normal text, then amber in the TTL's last
// quarter and red in its last tenth, where a prompt can still keep it warm. An expired cache is red with keepalive on (only a click or a
// prompt resumes it) and dim off, where nothing is left to act on.
export type Tone = 'on' | 'quiet' | 'warning' | 'alarm' | 'gone'
// The word for a reset cache: the footer's cold word and the Cache line's `reset` read this one constant.
const RESET = 'reset'
// The footer's word with keepalive on and no reading: nothing is counted, which is true of every no-reading state.
const NO_COUNT = 'no count'
// What the footer draws: the pie's quarter step, the words beside it (the time, the rebuild figure, or one of the two words), and the pie's tone.
export type Footer = { quarter: number; words: string; tone: Tone }
const WARN_TONE: Record<Reading['warn'], Tone> = { calm: 'quiet', quarter: 'warning', tenth: 'alarm' }

// What the footer draws for a reading, or null for nothing: with nothing to count, the empty pie and `no count`, only while keepalive is on;
// a cold reading is the empty pie and `reset`. `refreshing` is whether keepalive will send the next refresh (`refreshingOf`). `stopped` is
// whether a recorded stop stands: with keepalive on it turns those two empty pies red, as an expired cache's is, since only a prompt resumes them.
export const footerOf = (reading: Reading | null, on: boolean, refreshing: boolean, stopped: boolean): Footer | null => {
  const onTone: Tone = stopped ? 'alarm' : 'on'
  if (reading === null) return on ? { quarter: 0, words: NO_COUNT, tone: onTone } : null
  if (reading.state === 'cold') return { quarter: 0, words: RESET, tone: on ? onTone : 'gone' }
  if (reading.state === 'expired') return { quarter: 0, words: reading.words, tone: on ? 'alarm' : 'gone' }
  return { quarter: reading.quarter, words: reading.words, tone: refreshing ? 'on' : WARN_TONE[reading.warn] }
}

// The cue after the footer's words for a price read's phase: a glyph and its tone. Running is dim, landed the normal text colour, failed amber.
export type CueMark = { glyph: string; tone: 'dim' | 'plain' | 'warning' }
const CUES: Record<PriceCue, CueMark> = {
  reading: { glyph: '⟳', tone: 'dim' },
  landed: { glyph: '✓', tone: 'plain' },
  failed: { glyph: '!', tone: 'warning' },
}
export const cueOf = (cue: PriceCue | null): CueMark | null => (cue === null ? null : CUES[cue])

// Whether keepalive refreshes as the pie and its time show it: on, with a refresh figure, and a warm cache to refresh.
export const refreshingOf = (on: boolean, reading: Reading | null, refresh: string | null): boolean =>
  on && refresh !== null && reading?.state === 'warm'

// What the pie's colours warn of where no refresh is coming, worded in the Keepalive section while the pie is amber or red.
export const COLOUR_SENTENCE = 'pie: amber ≤¼ TTL left, red ≤⅒'

// The keepalive state the pie's hover names: off with keepalive off, else on for the green tone and paused for any other.
export type PieState = 'on' | 'paused' | 'off'
// The state with keepalive on, by tone. Read only once off is decided from `on`, and typed over every Tone, so a tone added later is a decision here.
const STATE_OF_TONE: Record<Tone, 'on' | 'paused'> = { on: 'on', quiet: 'paused', warning: 'paused', alarm: 'paused', gone: 'paused' }

// The pie's whole judgement from its inputs: the reading, whether keepalive is on, the label of the refresh figure (null when none holds),
// and whether a recorded stop stands. `footer` is what the pie draws, tone included, null exactly where `footerOf` gives none, and `state` is
// the keepalive state its hover names, null exactly then. `colour` is the sentence wording where no refresh is coming: not refreshing, and
// either keepalive is off or a reading is held, whatever the pie's tone. So it is absent only while keepalive refreshes, and with keepalive
// on and nothing to count.
export type Pie = { footer: null; state: null; colour: string | null } | { footer: Footer; state: PieState; colour: string | null }
export const pieOf = (reading: Reading | null, on: boolean, refresh: string | null, stopped: boolean): Pie => {
  const refreshing = refreshingOf(on, reading, refresh)
  const warns = !refreshing && (!on || reading !== null)
  const colour = warns ? COLOUR_SENTENCE : null
  const footer = footerOf(reading, on, refreshing, stopped)
  if (footer === null) return { footer, state: null, colour }
  return { footer, state: on ? STATE_OF_TONE[footer.tone] : 'off', colour }
}

// Whether the warmth line draws the rebuild figure: a reading that is not warm, with a figure to draw. The bare command gives the figure's
// reason only where this holds, so the two cannot disagree.
export const rebuildDrawnOf = (reading: Reading | null, rebuild: string): boolean => reading !== null && reading.state !== 'warm' && rebuild !== ''

// The Cache section's line: the cache's warmth, its time left and its TTL label `ttl`, or cold or expired with the figure to rebuild
// it (`rebuild`, empty for none). Empty when there is no reading to count from.
export const warmthOf = (reading: Reading | null, ttl: '1h' | '5m', rebuild: string): string => {
  if (reading === null) return ''
  if (reading.state === 'warm') return `warm · ${reading.words} left · ${ttl} TTL`
  const state = reading.state === 'expired' ? 'expired' : RESET
  return rebuildDrawnOf(reading, rebuild) ? `${state} · rebuild ${rebuild}` : state
}

// A cold mark lifts when a touch after it is known: the reading's, or a live request start.
export const settleCold = (cold: ColdMark | null, view: CacheView, liveMs: number | null): ColdMark | null => {
  if (cold === null) return null
  const touch = touchOf(view, liveMs)
  if (touch !== null && touch > cold.atMs) return null
  return cold
}
