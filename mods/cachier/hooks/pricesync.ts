// One price list for every session: the shared record's I/O. A session keeps its copy of the record, when it read it,
// and the page read in flight; a tick re-reads a copy over a minute old, and a due read stamps the record before it
// fetches and writes its outcome and list onto a fresh re-read.
import type { EngineInterface, HttpResponse } from 'claude-code'
import { overridesPath, parseOverrides, UNREADABLE, type Overrides, type Skip } from './overrides'
import { parsePricing, PRICING_URL, type PriceList } from './prices'
import {
  failedOf,
  isDue,
  landedOf,
  PRICE_KEY,
  pricesInForce,
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

// What a page read reports to the session's sink: it began its fetch, then ended with its list written (landed) or any
// other way (failed). Every `started` is followed by exactly one of the other two.
export type PriceEvent = 'started' | 'landed' | 'failed'
export type PriceSink = (event: PriceEvent) => void

// A session's copy of the record, when it was read, the overrides file as last read, and the page read in flight.
// The fields are what make one session's copy its own.
export type PriceSync = {
  record: PriceRecord | null
  // The overrides file as last read; null with no file.
  overrides: Overrides | null
  // The skip list and the file's warnings last written to the debug log, as text, so a list that has not changed is not logged again.
  loggedSkips: string
  loggedWarnings: string
  readAtMs: number
  loaded: boolean
  readable: boolean
  // Whether the run in flight fetched the page.
  reading: Promise<boolean> | null
  // Bumped by every load and every write of the copy; a load applies its result only if it is still the latest.
  generation: number
  // The newest load started.
  newest: Promise<boolean>
  readyPromise: Promise<void> | null
  // Where every read this session runs reports, whoever started it; null before one is registered.
  sink: PriceSink | null
}

// A failure is logged with its stack; the caller carries on without it.
export function report($: Dollar, err: unknown) {
  $.ui.log(`cachier: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: 'debug' })
}

// Adopts a record as this session's copy: a newer state than any load still in flight. Its skips are logged again when the
// merge changed them.
function adopt(state: PriceSync, $: Dollar, record: PriceRecord | null, atMs: number) {
  state.generation++
  state.record = record
  state.readAtMs = atMs
  noteOverrides(state, $)
}

// Reads the overrides file with the record: none when it does not exist, an unreadable item when it exists and cannot be read.
// Never throws.
async function readOverrides($: Dollar): Promise<Overrides | null> {
  try {
    const path = overridesPath(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
    if (path === null || !(await $.fs.exists(path))) return null
    return parseOverrides(await $.fs.read(path))
  } catch (err) {
    report($, err)
    return UNREADABLE
  }
}

// Writes each skip reason, and each warning about the file, to the debug log when its list is not the one last written.
function noteOverrides(state: PriceSync, $: Dollar) {
  const skips = priceSkips(state)
  const text = JSON.stringify(skips)
  if (text !== state.loggedSkips) {
    state.loggedSkips = text
    for (const s of skips) $.ui.log(`cachier: price overrides skipped ${s.kind}${s.id === null ? '' : ` ${s.id}`}: ${s.reason}`, { to: 'debug' })
  }
  const warnings = state.overrides?.warnings ?? []
  const warningText = JSON.stringify(warnings)
  if (warningText !== state.loggedWarnings) {
    state.loggedWarnings = warningText
    for (const w of warnings) $.ui.log(`cachier: price overrides warning: ${w}`, { to: 'debug' })
  }
}

// Reads the record. A failure keeps the last list in force and leaves the copy marked unreadable; the next check past
// the minute reads again. Returns whether the store answered. Latest wins: a load's result is applied only if no newer
// load or write began since, so a slower earlier read never lands over a newer state, and every caller reads for itself.
async function loadRecord(state: PriceSync, $: Dollar): Promise<boolean> {
  const own = loadOnce(state, $, ++state.generation)
  state.newest = own
  let answered = await own
  // A load that a newer load superseded leaves the copy to that one, which began after this caller did: wait for it and
  // answer as it did, so a caller that re-reads to decide never decides on a copy older than its own call.
  for (let last = own; state.newest !== last; ) {
    last = state.newest
    answered = await last.catch(() => false)
  }
  return answered
}

async function loadOnce(state: PriceSync, $: Dollar, generation: number): Promise<boolean> {
  const atMs = await $.clock.now()
  let record: PriceRecord | null = null
  let overrides: Overrides | null = null
  let readable = true
  try {
    overrides = await readOverrides($)
    record = recordOf(await $.store.get(PRICE_KEY))
  } catch (err) {
    readable = false
    report($, err)
  } finally {
    // Set once the store has answered, so a caller that finds it set never prices from a record still being read.
    state.loaded = true
  }
  // The file and the record land together, and only if no newer load or write began since.
  if (generation === state.generation) {
    if (readable) state.record = record
    state.overrides = overrides
    state.readAtMs = atMs
    state.readable = readable
    noteOverrides(state, $)
  }
  return readable
}

async function readyOf(state: PriceSync, $: Dollar): Promise<void> {
  const ready = (state.readyPromise ??= (async () => {
    if (!state.loaded) await loadRecord(state, $)
  })())
  try {
    await ready
  } catch (err) {
    // A rejected first load is not kept: a later ready tries again.
    if (state.readyPromise === ready) state.readyPromise = null
    throw err
  }
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

// A report never breaks the read: a sink that throws is logged and the read goes on.
function emit(state: PriceSync, $: Dollar, event: PriceEvent) {
  try {
    state.sink?.(event)
  } catch (err) {
    report($, err)
  }
}

// Returns whether it fetched the page. Reports `started` as the fetch begins and exactly one end after it.
async function readPage(state: PriceSync, $: Dollar, switched: boolean): Promise<boolean> {
  const stampMs = await $.clock.now()
  const base = state.record
  const pending = stampedOf(base, stampMs)
  let stamped = true
  if (pending !== base) {
    try {
      await $.store.set(PRICE_KEY, pending)
      adopt(state, $, pending, stampMs)
    } catch (err) {
      stamped = false
      report($, err)
    }
  }
  // A refused stamp means this session does not read; a switch reads anyway, since the user asked for it.
  if (!stamped && !switched) return false

  emit(state, $, 'started')
  let landed = false
  try {
    landed = await fetchAndWrite(state, $, stampMs)
  } finally {
    emit(state, $, landed ? 'landed' : 'failed')
  }
  return true
}

// The fetch and the write of its outcome. Returns whether the list landed.
async function fetchAndWrite(state: PriceSync, $: Dollar, stampMs: number): Promise<boolean> {
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
    return false
  }

  if (outcome.kind === 'success') {
    const next = landedOf(held, outcome.list, atMs, stampMs)
    try {
      await $.store.set(PRICE_KEY, next)
      adopt(state, $, next, atMs)
      return true
    } catch (err) {
      // A refused list write lands nothing: the stored list stays in force, and the retry is an unreachable failure's.
      report($, err)
    }
    await writeFailure(state, $, held, 'unreachable', stampMs, atMs)
    return false
  }

  await writeFailure(state, $, held, outcome.kind, stampMs, atMs)
  return false
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
  adopt(state, $, next, atMs)
}

// Waits for the read in flight. True when the check is done: the run fetched, or the check is no switch. A switch whose
// awaited run made no fetch (its stamp was refused) goes on to its own read.
async function joinedRun(state: PriceSync, switched: boolean): Promise<boolean> {
  while (state.reading !== null) {
    if ((await state.reading) || !switched) return true
  }
  return false
}

async function checkOf(state: PriceSync, $: Dollar, switched: boolean): Promise<void> {
  if (await joinedRun(state, switched)) return

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
  // Rechecked after each wait, so the run is claimed in the same turn that finds none in flight.
  while (state.reading !== null) {
    if (await joinedRun(state, switched)) return
  }
  // The waits above can outlast another read's success, so a tick tests the copy it holds, at the clock value from its last
  // read (a fresh read is an await, which would reopen the window), with no await before the claim.
  if (!switched && !isDue(state.record, nowMs)) return
  const run = readPage(state, $, switched)
  state.reading = run.finally(() => {
    state.reading = null
  })
  await state.reading
}

// A session's price record and page read. Each load of the plugin makes a new one, so a reload starts with none of it.
export const priceSync = (): PriceSync => ({
  record: null,
  overrides: null,
  loggedSkips: '[]',
  loggedWarnings: '[]',
  readAtMs: 0,
  loaded: false,
  readable: false,
  reading: null,
  generation: 0,
  newest: Promise.resolve(true),
  readyPromise: null,
  sink: null,
})

// The engine lets `$` be passed only to a top-level function, or one imported from the module's own files, whose body is
// kept as written. These wrappers keep the per-session object and give register.ts a function declaration to call.
export function priceReady(sync: PriceSync, $: Dollar): Promise<void> {
  return readyOf(sync, $)
}

// Registers the one sink the session's reads report to. Called once, when the session starts.
export function priceSink(sync: PriceSync, sink: PriceSink): void {
  sync.sink = sink
}

export function priceList(sync: PriceSync): PriceList {
  return pricesInForce(sync.record, sync.overrides).list
}

// The overrides entries left out, beside the prices in force: the file's skips, then the merge's.
export function priceSkips(sync: PriceSync): Skip[] {
  return pricesInForce(sync.record, sync.overrides).skips
}

// Never rejects: a failure is logged and the check ends, so a caller's command is not broken by it.
export async function priceCheck(sync: PriceSync, $: Dollar, switched = false): Promise<void> {
  try {
    await checkOf(sync, $, switched)
  } catch (err) {
    report($, err)
  }
}
