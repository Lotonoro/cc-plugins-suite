// One price list for every session: the shared record's I/O. A session keeps its copy of the record, when it read it,
// and the page read in flight; a tick re-reads a copy over a minute old, and a due read stamps the record before it
// fetches and writes its outcome and list onto a fresh re-read.
import type { EngineInterface, HttpResponse } from 'claude-code'
import { parsePricing, PRICING_URL, type PriceList } from './prices'
import {
  failedOf,
  isDue,
  landedOf,
  PRICE_KEY,
  pricesOf,
  recordOf,
  stampedOf,
  type PriceOutcome,
  type PriceRecord,
} from './pricelist'

type Dollar = EngineInterface
const READ_TIMEOUT_MS = 10000
// How old a session's copy may be before a check re-reads it.
const COPY_MAX_MS = 60000

type ReadOutcome =
  | { kind: 'success'; list: PriceList }
  | { kind: 'unreachable'; err: unknown }
  | { kind: 'format'; err: Error }

// A session's copy of the record, when it was read, and the page read in flight.
// The fields are what make one session's copy its own.
export type PriceSync = {
  record: PriceRecord | null
  readAtMs: number
  loaded: boolean
  readable: boolean
  reading: Promise<void> | null
  readyPromise: Promise<void> | null
}

// A failure is logged with its stack; the caller carries on without it.
export function report($: Dollar, err: unknown) {
  $.ui.log(`cachier: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: 'debug' })
}

// Reads the record. A failure keeps the last list in force and leaves the copy marked unreadable; the next check past
// the minute reads again. Returns whether the store answered.
async function loadRecord(state: PriceSync, $: Dollar): Promise<boolean> {
  const atMs = await $.clock.now()
  state.readAtMs = atMs
  try {
    state.record = recordOf(await $.store.get(PRICE_KEY))
    state.readable = true
    return true
  } catch (err) {
    state.readable = false
    report($, err)
    return false
  } finally {
    // Set once the store has answered, so a caller that finds it set never prices from a record still being read.
    state.loaded = true
  }
}

async function readyOf(state: PriceSync, $: Dollar): Promise<void> {
  state.readyPromise ??= (async () => {
    if (!state.loaded) await loadRecord(state, $)
  })()
  await state.readyPromise
}

async function fetchPage($: Dollar): Promise<ReadOutcome> {
  let late: () => void = () => {}
  const timeout = new Promise<null>((resolve) => {
    late = () => resolve(null)
  })
  const timer = $.clock.after(READ_TIMEOUT_MS, late)
  try {
    let answer: HttpResponse | null
    try {
      answer = await Promise.race([$.http.fetch(PRICING_URL), timeout])
    } catch (err) {
      return { kind: 'unreachable', err }
    }
    if (answer === null) return { kind: 'unreachable', err: new Error('the pricing page did not answer in time') }
    if (!answer.ok) return { kind: 'unreachable', err: new Error(`the pricing page answered ${answer.status}`) }
    const list = parsePricing(answer.text)
    return list === null
      ? { kind: 'format', err: new Error('the pricing page has no model prices it can read') }
      : { kind: 'success', list }
  } finally {
    timer.cancel()
  }
}

async function readPage(state: PriceSync, $: Dollar, switched: boolean): Promise<void> {
  const stampMs = await $.clock.now()
  const base = state.record
  const pending = stampedOf(base, stampMs)
  let stamped = true
  if (pending !== base) {
    try {
      await $.store.set(PRICE_KEY, pending)
      state.record = pending
      state.readAtMs = stampMs
    } catch (err) {
      stamped = false
      report($, err)
    }
  }
  // A refused stamp means this session does not read; a switch reads anyway, since the user asked for it.
  if (!stamped && !switched) return

  const outcome = await fetchPage($)
  const atMs = await $.clock.now()
  if (outcome.kind !== 'success') report($, outcome.err)
  let held: PriceRecord | null
  try {
    held = recordOf(await $.store.get(PRICE_KEY))
  } catch (err) {
    // No write without a fresh re-read: this session's copy may predate a newer stamp, and a write would overwrite it.
    // The stamp already stored stands as a pending failure on the schedule.
    report($, err)
    return
  }

  if (outcome.kind === 'success') {
    const next = landedOf(held, outcome.list, atMs, stampMs)
    try {
      await $.store.set(PRICE_KEY, next)
      state.record = next
      state.readAtMs = atMs
      return
    } catch (err) {
      // A refused list write lands nothing: the stored list stays in force, and the retry is an unreachable failure's.
      report($, err)
    }
    await writeFailure(state, $, held, 'unreachable', stampMs, atMs)
    return
  }

  await writeFailure(state, $, held, outcome.kind, stampMs, atMs)
}

// Writes a read's failure onto the record as it is stored now, so every session follows one retry schedule. A write refused
// here too is reported; the session's own copy still waits as the failure it was.
async function writeFailure(
  state: PriceSync,
  $: Dollar,
  held: PriceRecord | null,
  outcome: Exclude<PriceOutcome, 'success'>,
  stampMs: number,
  atMs: number,
): Promise<void> {
  const next = failedOf(held, outcome, stampMs)
  if (next !== held) {
    try {
      await $.store.set(PRICE_KEY, next)
    } catch (err) {
      report($, err)
    }
  }
  state.record = next
  state.readAtMs = atMs
}

async function checkOf(state: PriceSync, $: Dollar, switched: boolean): Promise<void> {
  if (state.reading !== null) {
    await state.reading
    return
  }

  let nowMs = await $.clock.now()
  if (!state.loaded || nowMs - state.readAtMs > COPY_MAX_MS) {
    if (!(await loadRecord(state, $))) return
    nowMs = await $.clock.now()
  }
  if (!state.readable && !switched) return

  if (!switched) {
    if (!isDue(state.record, nowMs)) return
    // A due read checks a fresh copy first: a stamp another session wrote meanwhile makes this one not due.
    if (!(await loadRecord(state, $)) || !isDue(state.record, await $.clock.now())) return
  } else if (!(await loadRecord(state, $))) {
    // A switch still re-reads before it stamps and fetches, so its write merges onto the list as stored then.
    return
  }

  // Two calls in one session share one page read; a switch that finds one running waits for its result.
  if (state.reading !== null) {
    await state.reading
    return
  }
  const run = readPage(state, $, switched)
  state.reading = run.finally(() => {
    state.reading = null
  })
  await state.reading
}

// A session's price record and page read. Each load of the plugin makes a new one, so a reload starts with none of it.
export const priceSync = (): PriceSync => ({
  record: null,
  readAtMs: 0,
  loaded: false,
  readable: false,
  reading: null,
  readyPromise: null,
})

// The engine lets `$` be passed only to a top-level function, or one imported from the module's own files, whose body is
// kept as written. These wrappers keep the per-session object and give register.ts a function declaration to call.
export function priceReady(sync: PriceSync, $: Dollar): Promise<void> {
  return readyOf(sync, $)
}

export function priceList(sync: PriceSync): PriceList {
  return pricesOf(sync.record)
}

export function priceCheck(sync: PriceSync, $: Dollar, switched = false): Promise<void> {
  return checkOf(sync, $, switched)
}
