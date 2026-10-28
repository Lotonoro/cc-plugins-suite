import type { CacheView, ColdMark, Reading } from '../types'
import { TTL_WORDS } from './prices'

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
  const left = Math.min(view.ttlMs, view.ttlMs - (nowMs - (touchOf(view, liveMs) ?? view.touchMs)))
  if (left <= 0) return { words: `${rebuild} to rebuild`, state: 'expired', quarter: 0, warn: 'calm' }
  const seconds = Math.ceil(left / 1000)
  const warn = left * 10 <= view.ttlMs ? 'tenth' : left * 4 <= view.ttlMs ? 'quarter' : 'calm'
  return { words: `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`, state: 'warm', quarter: quarterOf(left, view.ttlMs), warn }
}

// The pie's tone: green while keepalive will send the next refresh, and whenever it is on with nothing to count. Otherwise the cache is
// left to the person: the normal text, then amber in the TTL's last quarter and red in its last tenth, where a prompt can still keep it
// warm. An expired cache is red with keepalive on (only a click or a prompt resumes it) and dim off, where nothing is left to act on.
export type Tone = 'on' | 'quiet' | 'warning' | 'alarm' | 'gone'
// What the footer draws: the pie's quarter step, the words beside it (empty for none), and the pie's tone.
export type Footer = { quarter: number; words: string; tone: Tone }
const WARN_TONE: Record<Reading['warn'], Tone> = { calm: 'quiet', quarter: 'warning', tenth: 'alarm' }

// What the footer draws for a reading, or null for nothing: with nothing to count, an empty pie only while keepalive is on. `refreshing`
// is whether keepalive will send the next refresh (`refreshingOf`).
export const footerOf = (reading: Reading | null, on: boolean, refreshing: boolean): Footer | null => {
  if (reading === null) return on ? { quarter: 0, words: '', tone: 'on' } : null
  if (reading.state === 'cold') return { quarter: 0, words: '', tone: on ? 'on' : 'gone' }
  if (reading.state === 'expired') return { quarter: 0, words: reading.words, tone: on ? 'alarm' : 'gone' }
  return { quarter: reading.quarter, words: reading.words, tone: refreshing ? 'on' : WARN_TONE[reading.warn] }
}

// Whether keepalive refreshes as the pie and its time show it: on, with a refresh figure, and a warm cache to refresh.
export const refreshingOf = (on: boolean, reading: Reading | null, refresh: string | null): boolean =>
  on && refresh !== null && reading?.state === 'warm'

// What the pie's colours warn of where no refresh is coming: the bare words, which the details pane and the colour sentence share.
export const COLOUR_SENTENCE = "The pie turns amber in the cache's last quarter and red in its last tenth: the cache is about to lapse."

// The pie's whole judgement from its inputs: the reading, whether keepalive is on, and the label of the refresh figure (null when none
// holds). `footer` is what the pie draws, tone included, null exactly where `footerOf` gives none. `colour` is the sentence wording the
// pie's warning, present only while the pie is amber or red on a warm cache: the calm tone, a green pie, no reading, and a cold or
// expired cache have none.
export type Pie = { footer: Footer | null; colour: string | null }
export const pieOf = (reading: Reading | null, on: boolean, refresh: string | null): Pie => {
  const footer = footerOf(reading, on, refreshingOf(on, reading, refresh))
  const warns = reading?.state === 'warm' && (footer?.tone === 'warning' || footer?.tone === 'alarm')
  return { footer, colour: warns ? COLOUR_SENTENCE : null }
}

// The details pane's first line: the cache's warmth, its time left in the lifetime `ttl` names, or cold or expired with the figure to rebuild
// it (`rebuild`, empty for none). Empty when there is no reading to count from.
export const warmthOf = (reading: Reading | null, ttl: '1h' | '5m', rebuild: string): string => {
  if (reading === null) return ''
  const life = `${TTL_WORDS[ttl]} cache`
  if (reading.state === 'warm') return `Prompt cache warm, ${reading.words} left (${life})`
  const state = reading.state === 'expired' ? 'expired' : 'reset'
  return rebuild === '' ? `Prompt cache ${state}.` : `Prompt cache ${state}, ${rebuild} to rebuild.`
}

// A cold mark lifts when a touch after it is known: the reading's, or a live request start.
export const settleCold = (cold: ColdMark | null, view: CacheView, liveMs: number | null): ColdMark | null => {
  if (cold === null) return null
  const touch = touchOf(view, liveMs)
  if (touch !== null && touch > cold.atMs) return null
  return cold
}
