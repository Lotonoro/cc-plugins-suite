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

// The pie's tone: green whenever keepalive is on, in every state of the cache. With keepalive off the cache is left to the person: the normal
// text, then amber in the TTL's last quarter and red in its last tenth, where a prompt can still keep it warm; dim once it has expired or gone
// cold, where nothing is left to act on.
export type Tone = 'on' | 'quiet' | 'warning' | 'alarm' | 'gone'
// A piece of a line's text and the tone it is drawn in, one of the pie's. The pieces of a line, joined, are its text.
export type Run = { text: string; tone: Tone }
// The tone a row's label is drawn in: the pie's dim, so a label names its row and is no state of the cache or of keepalive.
const LABEL_TONE: Tone = 'gone'
// The pieces of a labelled line: the label as one dim piece, then the rest. The label carries its colon where it has one, and the rest opens with the space after
// it, so the pieces joined are the label then the rest. A rest given as text is one untoned piece; a rest given as pieces is kept as given.
export const labelled = (label: string, rest: string | Run[]): Run[] => [
  { text: label, tone: LABEL_TONE },
  ...(typeof rest === 'string' ? [{ text: rest, tone: 'quiet' as const }] : rest),
]
// The word for a reset cache: the footer's cold word and the Cache line's `reset` read this one constant.
const RESET = 'reset'
// The footer's word with keepalive on and no reading: nothing is counted, which is true of every no-reading state.
const NO_COUNT = 'no count'
// What the footer draws: the pie's quarter step, the words beside it (the time, the rebuild figure, or one of the two words), and the pie's tone.
export type Footer = { quarter: number; words: string; tone: Tone }
const WARN_TONE: Record<Reading['warn'], Tone> = { calm: 'quiet', quarter: 'warning', tenth: 'alarm' }

// What the footer draws for a reading, or null for nothing: with nothing to count, the empty pie and `no count`, only while keepalive is on;
// a cold reading is the empty pie and `reset`. `on` is whether keepalive is on, which alone makes the pie green, in every state; with it
// off the tone is the reading's own: its warn tone while warm, dim once expired or cold.
export const footerOf = (reading: Reading | null, on: boolean): Footer | null => {
  if (reading === null) return on ? { quarter: 0, words: NO_COUNT, tone: 'on' } : null
  if (reading.state === 'cold') return { quarter: 0, words: RESET, tone: on ? 'on' : 'gone' }
  if (reading.state === 'expired') return { quarter: 0, words: reading.words, tone: on ? 'on' : 'gone' }
  return { quarter: reading.quarter, words: reading.words, tone: on ? 'on' : WARN_TONE[reading.warn] }
}

// The pie's glyph by its quarter step: empty at 0 (cold, expired, or nothing to count), full above three quarters of the TTL left. The footer draws it, and
// the Cache line opens with it. The step is `Reading`'s, 0 to 4.
const GLYPHS = ['○', '◔', '◑', '◕', '●']
export const glyphOf = (quarter: number): string => GLYPHS[quarter]!

// The cue after the footer's words for a price read's phase: a glyph and its tone. Running is dim, landed the normal text colour, failed amber.
export type CueMark = { glyph: string; tone: 'dim' | 'plain' | 'warning' }
const CUES: Record<PriceCue, CueMark> = {
  reading: { glyph: '⟳', tone: 'dim' },
  landed: { glyph: '✓', tone: 'plain' },
  failed: { glyph: '!', tone: 'warning' },
}
export const cueOf = (cue: PriceCue | null): CueMark | null => (cue === null ? null : CUES[cue])

// Whether keepalive refreshes: on, with a refresh figure, and a warm cache to refresh. The pie's hover state reads it (`pieOf`), not its tone.
export const refreshingOf = (on: boolean, reading: Reading | null, refresh: string | null): boolean =>
  on && refresh !== null && reading?.state === 'warm'

// What the pie's colours warn of, as the pieces of the Keepalive section's line wherever the pie can be amber or red: with keepalive off (`pieOf` decides where).
// `amber` and `red` take the tones the pie takes at the quarter and tenth steps (`WARN_TONE`), so those tones cannot drift from the pie's; the words and the
// thresholds `¼` and `⅒` are paired with the steps by hand. They are drawn in those tones whatever the pie's own: a legend for the pie's colours, not a state. The
// label `pie:` is the line's one dim piece (`labelled`), the rest of the line has no tone, and the pieces joined are the sentence.
export const COLOUR_SENTENCE: Run[] = labelled('pie:', [
  { text: ' ', tone: 'quiet' },
  { text: 'amber', tone: WARN_TONE.quarter },
  { text: ' ≤¼ TTL left, ', tone: 'quiet' },
  { text: 'red', tone: WARN_TONE.tenth },
  { text: ' ≤⅒', tone: 'quiet' },
])

// The keepalive state the pie's hover names: off with keepalive off. With it on, on while it refreshes and over the empty pie of a cold cache or of
// nothing to count, unless a recorded stop stands, which only a prompt resumes; paused in every other state.
export type PieState = 'on' | 'paused' | 'off'

// The pie's whole judgement from its inputs: the reading, whether keepalive is on, the label of the refresh figure (null when none holds),
// and whether a recorded stop stands. `footer` is what the pie draws, tone included, null exactly where `footerOf` gives none, and `state` is
// the keepalive state its hover names, null exactly then; the refresh figure and the stop bear on that state alone, never on the tone.
// `colour` is the sentence's pieces, present exactly while keepalive is off, with a reading or without one: with it on the pie is never
// amber or red, so there is nothing for the sentence to describe.
export type Pie = { footer: null; state: null; colour: Run[] | null } | { footer: Footer; state: PieState; colour: Run[] | null }
export const pieOf = (reading: Reading | null, on: boolean, refresh: string | null, stopped: boolean): Pie => {
  const colour = on ? null : COLOUR_SENTENCE.map((run) => ({ ...run }))
  const footer = footerOf(reading, on)
  if (footer === null) return { footer, state: null, colour }
  if (!on) return { footer, state: 'off', colour }
  const empty = reading === null || reading.state === 'cold'
  return { footer, state: refreshingOf(on, reading, refresh) || (empty && !stopped) ? 'on' : 'paused', colour }
}

// Whether the warmth line draws the rebuild figure: a reading that is not warm, with a figure to draw. The bare command gives the figure's
// reason only where this holds, so the two cannot disagree.
export const rebuildDrawnOf = (reading: Reading | null, rebuild: string): boolean => reading !== null && reading.state !== 'warm' && rebuild !== ''

// The cache's warmth, which the Cache section's line states after the pie: its time left and its TTL label `ttl`, or cold or expired with the figure to
// rebuild it (`rebuild`, empty for none). Empty when there is no reading to count from.
export const warmthOf = (reading: Reading | null, ttl: '1h' | '5m', rebuild: string): string => {
  if (reading === null) return ''
  if (reading.state === 'warm') return `warm · ${reading.words} left · ${ttl} TTL`
  const state = reading.state === 'expired' ? 'expired' : RESET
  return rebuildDrawnOf(reading, rebuild) ? `${state} · rebuild ${rebuild}` : state
}

// The Cache section's line as its pieces: the pie's glyph in the pie's tone, then a space and the warmth untoned. `pie` is the judgement of the same
// reading that gives the colour sentence's pieces (`pieOf`), so the glyph is amber or red only where the sentence naming those colours is shown. Null when there
// is no reading to count from, so the glyph never stands alone; where there is a reading the pie has a footer to give the glyph and the tone.
export const cacheLineOf = (reading: Reading | null, ttl: '1h' | '5m', rebuild: string, pie: Pie): Run[] | null => {
  if (reading === null || pie.footer === null) return null
  return [{ text: glyphOf(pie.footer.quarter), tone: pie.footer.tone }, { text: ` ${warmthOf(reading, ttl, rebuild)}`, tone: 'quiet' }]
}

// A cold mark lifts when a touch after it is known: the reading's, or a live request start.
export const settleCold = (cold: ColdMark | null, view: CacheView, liveMs: number | null): ColdMark | null => {
  if (cold === null) return null
  const touch = touchOf(view, liveMs)
  if (touch !== null && touch > cold.atMs) return null
  return cold
}
