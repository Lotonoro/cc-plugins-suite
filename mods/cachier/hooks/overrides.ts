// The overrides file: rates and id mappings a person sets by hand. Pure: it parses and checks what the file alone can
// answer; `pricelist.ts` merges the entries over the prices, and `pricesync.ts` reads the file.
import type { Kinds } from '../types'
import { inOrder, kindsOf, type Rates } from './prices'

// An entry left out, and why. `id` is its model or mapping key; a file that cannot be read has none.
export type Skip = { id: string | null; kind: 'rates' | 'mapping' | 'file'; reason: string }

// A model's hand-set rates and when they were set.
export type RateEntry = { id: string; rates: Rates; setMs: number }
export type MappingEntry = { key: string; target: string }
// Warnings name the fields and sections the file has that are ignored: they change no price and are not skips.
export type Overrides = { rates: readonly RateEntry[]; mappings: readonly MappingEntry[]; skips: readonly Skip[]; warnings: readonly string[] }

// Shared by every session that cannot use the file, so frozen all the way down.
export const UNREADABLE: Overrides = Object.freeze({
  rates: Object.freeze([]),
  mappings: Object.freeze([]),
  skips: Object.freeze([Object.freeze({ id: null, kind: 'file', reason: 'unreadable' })]),
  warnings: Object.freeze([]),
})

// Where the file sits: under the config dir, `CLAUDE_CONFIG_DIR` when set, else `.claude` under the home dir.
export const overridesPath = (configDir: string | undefined, home: string | undefined): string | null => {
  const dir = configDir !== undefined && configDir !== '' ? configDir : home === undefined || home === '' ? null : `${home}/.claude`
  return dir === null ? null : `${dir}/cachier/prices.json`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/

// The zone's offset in minutes east of UTC at a local time, given as that time read as UTC. Null is the host's zone.
export type Zone = (localMs: number) => number

// A date as an instant, or null when it is no calendar date or time. A date with no time is the end of that day; a time with
// no offset is local time in `zone`.
const instantOf = (text: unknown, zone: Zone | null): number | null => {
  const m = typeof text === 'string' ? DATE.exec(text.trim()) : null
  if (m === null) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const timed = m[4] !== undefined
  const [h, mi, s] = timed ? [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : [23, 59, 59]
  const ms = timed ? Number((m[7] ?? '0').padEnd(3, '0')) : 999
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  const real = new Date(local)
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null
  const offset = m[8]
  if (offset === undefined) {
    if (zone === null) return new Date(y, mo - 1, d, h, mi, s, ms).getTime()
    return local - zone(local) * 60000
  }
  if (offset === 'Z') return local
  const [oh, om] = [Number(offset.slice(1, 3)), Number(offset.slice(-2))]
  if (oh > 23 || om > 59) return null
  const east = (offset[0] === '-' ? -1 : 1) * (oh * 60 + om)
  return local - east * 60000
}

// A rate per million, required or optional. `undefined` is a missing optional one.
const rateOf = (v: Record<string, unknown>, name: 'input' | 'read' | 'write5m' | 'write1h', optional: boolean): number | string | undefined => {
  if (v[name] === undefined && optional) return undefined
  return positive(v[name]) ? v[name] : `${name} rate missing or not a positive number`
}

// A set of rates as per-token ones, the write rates derived when not given; a string says why it cannot be.
const kindsFrom = (v: unknown): Kinds | string => {
  if (!isObject(v)) return 'not an object'
  const input = rateOf(v, 'input', false)
  if (typeof input === 'string') return input
  const read = rateOf(v, 'read', false)
  if (typeof read === 'string') return read
  const w5 = rateOf(v, 'write5m', true)
  if (typeof w5 === 'string') return w5
  const w1 = rateOf(v, 'write1h', true)
  if (typeof w1 === 'string') return w1
  const derived = kindsOf(input as number, read as number)
  const kinds = {
    input: derived.input,
    read: derived.read,
    write5m: w5 === undefined ? derived.write5m : w5 / 1e6,
    write1h: w1 === undefined ? derived.write1h : w1 / 1e6,
  }
  return inOrder(kinds) ? kinds : 'rates out of order: read <= input <= 5m write <= 1h write is required'
}

const ratesEntry = (id: string, v: unknown, zone: Zone | null): RateEntry | string => {
  const kinds = kindsFrom(v)
  if (typeof kinds === 'string') return kinds
  const entry = v as Record<string, unknown>
  const setMs = instantOf(entry.date, zone)
  if (setMs === null) return 'no valid date (a calendar date, or a date and time)'
  let above: Rates['above'] = null
  if (entry.above !== undefined) {
    const tier = kindsFrom(entry.above)
    if (typeof tier === 'string') return `size tier: ${tier}`
    const threshold = (entry.above as Record<string, unknown>).threshold
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return 'size tier: threshold missing or not a positive number'
    above = { ...tier, threshold }
  }
  return { id, rates: { ...kinds, above }, setMs }
}

// The fields a rates entry and a size tier read. Any other field is ignored and named in a warning, so a misspelling is seen.
const ENTRY_FIELDS = ['input', 'read', 'write5m', 'write1h', 'date', 'above']
const TIER_FIELDS = ['input', 'read', 'write5m', 'write1h', 'threshold']

// The warnings for the fields a rates entry or its size tier carries that they do not read.
const ignoredFields = (id: string, v: unknown): string[] => {
  if (!isObject(v)) return []
  const entry = Object.keys(v).filter((k) => !ENTRY_FIELDS.includes(k)).map((k) => `rates ${id}: unknown field ${k} ignored`)
  const tier = isObject(v.above) ? Object.keys(v.above).filter((k) => !TIER_FIELDS.includes(k)).map((k) => `rates ${id}: unknown field above.${k} ignored`) : []
  return [...entry, ...tier]
}

// Parses the file's text. Text that is not a JSON object with object sections is one unreadable item. Each entry the file
// alone shows to be wrong is skipped and named, in file order; the rest stand. A field or section the parser does not read
// changes no price: it is named in a warning.
export const parseOverrides = (text: string, zone: Zone | null = null): Overrides => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON: reported as unreadable, as every file that cannot be used is.
    return UNREADABLE
  }
  if (!isObject(parsed) || [parsed.rates, parsed.mappings].some((s) => s !== undefined && !isObject(s))) return UNREADABLE
  const rates: RateEntry[] = []
  const mappings: MappingEntry[] = []
  const skips: Skip[] = []
  const warnings: string[] = []
  // Each rates entry, kept or skipped, is read before the mappings, so a mapping can see which of its keys the file gives a rates entry.
  const rated = new Map<string, RateEntry | string>()
  if (isObject(parsed.rates)) {
    for (const [id, v] of Object.entries(parsed.rates)) rated.set(id, id === '__proto__' ? 'not a usable id' : ratesEntry(id, v, zone))
  }
  const handIds = new Set([...rated].filter(([, entry]) => typeof entry !== 'string').map(([id]) => id))
  const keys = isObject(parsed.mappings) ? new Set(Object.keys(parsed.mappings)) : new Set<string>()
  for (const section of Object.keys(parsed)) {
    const body = parsed[section]
    if (section === 'rates') {
      for (const [id, entry] of rated) {
        if (typeof entry === 'string') skips.push({ id, kind: 'rates', reason: entry })
        else rates.push(entry)
      }
      if (isObject(body)) for (const [id, v] of Object.entries(body)) warnings.push(...ignoredFields(id, v))
    } else if (section === 'mappings' && isObject(body)) {
      for (const [key, target] of Object.entries(body)) {
        if (key === '__proto__' || typeof target !== 'string' || target === '') skips.push({ id: key, kind: 'mapping', reason: 'not a usable id or target' })
        else if (keys.has(target)) skips.push({ id: key, kind: 'mapping', reason: `target ${target} is itself a mapping key; mappings do not chain` })
        else if (handIds.has(key)) skips.push({ id: key, kind: 'mapping', reason: 'is also a rates entry; the mapping is not used' })
        else mappings.push({ key, target })
      }
    } else if (section !== 'mappings') {
      warnings.push(`unknown section ${section} ignored`)
    }
  }
  return { rates, mappings, skips, warnings }
}
