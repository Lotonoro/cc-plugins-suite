import type { EngineInterface, Timer } from 'claude-code'
import type { Item } from '../types'
import { cutLine, messageOf } from './done'
import type { Outcome } from './items'
import { readList } from './shared'

// The push's text is one line of at most this many UTF-16 units, the ellipsis counted within them: a mobile OS truncates a longer one.
const MESSAGE_MAX = 180
// A call with no answer this long after it was made is unanswered: its item's tries end. The call itself may stay pending.
const BOUND_MS = 10_000
// A push refused as user_present is tried again this long after the answer that refused it.
const RETRY_MS = 60_000
// No retry comes this long after its chain's first try.
const LIMIT_MS = 3_600_000

// The message a blocking item's push carries: its number and its title.
const pushText = (item: Item): string => cutLine(`Blocking: #${item.id} ${item.title}`, MESSAGE_MAX)

// An item's chain of tries: its first try, then the retries a refusal schedules. An item has at most one chain. A trigger replaces the item's
// chain, and every step of a chain checks that its chain is still the item's current one, so an ended chain's call, bound or timer pushes,
// logs and schedules nothing.
type Chain = { id: number; firstAt: number; timer: Timer | null }
const chains = new Map<number, Chain>()
// The session's first push call logs its whole answer at debug. A session's end makes the next session's first call the first again.
let firstCall = true

const current = (chain: Chain): boolean => chains.get(chain.id) === chain

// Ends a chain: its pending timer (a retry, or a call's bound) is cancelled, and it is forgotten when it is still the item's current chain.
const endChain = (chain: Chain): void => {
  chain.timer?.cancel()
  chain.timer = null
  if (current(chain)) chains.delete(chain.id)
}

// Runs one step of a chain in the background. A step that fails ends its chain and says why in the transcript, once. A step of a chain that
// has already ended says nothing.
function inChain($: EngineInterface, chain: Chain, step: () => Promise<void>): void {
  void step().catch((err: unknown) => {
    if (!current(chain)) return
    endChain(chain)
    $.ui.log(`human-plugin: the push for #${chain.id} stopped: ${messageOf(err)}`)
  })
}

// An item has just become open and blocking, by a filing, a promotion, a reopen, or a window's end that reopened it: its chain starts, ending
// any older chain of the item at whatever point it is, and the chain's first try runs in the background. Nothing waits on it.
export function pushBlocking($: EngineInterface, item: Item): void {
  const older = chains.get(item.id)
  if (older !== undefined) endChain(older)
  const chain: Chain = { id: item.id, firstAt: 0, timer: null }
  chains.set(item.id, chain)
  inChain($, chain, async () => {
    chain.firstAt = await $.clock.now()
    await tryPush($, chain, item)
  })
}

// What a push call settled with: its answer, its error, or nothing by its bound.
type Settled = { kind: 'answered'; reply: unknown } | { kind: 'thrown'; error: unknown } | { kind: 'unanswered' }

// One push call, settled by its answer or by its bound, whichever comes first. The bound is the chain's timer while the call is in flight.
function callPush($: EngineInterface, chain: Chain, message: string): Promise<Settled> {
  return new Promise<Settled>(settle => {
    chain.timer = $.clock.after(BOUND_MS, () => settle({ kind: 'unanswered' }))
    Promise.resolve()
      .then(() => $.tool.call({ tool: 'PushNotification', message, status: 'proactive' }))
      .then(reply => settle({ kind: 'answered', reply }), error => settle({ kind: 'thrown', error }))
  })
}

// A field of an answer, read at this boundary: a hook's answer is not checked against the tool's typing, so each field is read as unknown.
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined

// What a settled call does to its chain: the chain is retried; it ends quietly (sent), or ends with a line that says why, in the transcript
// (failed) or at debug (quiet).
type Verdict = { kind: 'sent' } | { kind: 'retry' } | { kind: 'quiet'; why: string } | { kind: 'failed'; why: string }

function verdictOf(settled: Settled): Verdict {
  if (settled.kind === 'unanswered') return { kind: 'failed', why: 'was not answered in 10 seconds' }
  if (settled.kind === 'thrown') return { kind: 'failed', why: `threw: ${messageOf(settled.error)}` }
  const reply = settled.reply
  const deny = fieldOf(reply, 'deny')
  if (typeof deny === 'string') return { kind: 'failed', why: `was denied: ${deny}` }
  if (fieldOf(reply, 'isError') === true) return { kind: 'failed', why: `failed: ${String(fieldOf(reply, 'text') ?? 'no text')}` }
  const result = fieldOf(reply, 'result')
  if (fieldOf(result, 'pushSent') === true) return { kind: 'sent' }
  const reason = fieldOf(result, 'disabledReason')
  if (reason === 'user_present') return { kind: 'retry' }
  if (reason === 'config_off' || reason === 'no_transport') return { kind: 'quiet', why: `was not sent: ${reason}` }
  return { kind: 'failed', why: `gave no outcome: ${JSON.stringify(reply)}` }
}

// One try of a chain: its push call, then what the call's settlement decides. The first push call of a session logs its whole answer at
// debug, provided its chain is still current when it answers.
async function tryPush($: EngineInterface, chain: Chain, item: Item): Promise<void> {
  if (!current(chain)) return
  const logWhole = firstCall
  firstCall = false
  const settled = await callPush($, chain, pushText(item))
  chain.timer?.cancel()
  chain.timer = null
  if (!current(chain)) return
  if (logWhole && settled.kind === 'answered') {
    $.ui.log(`human-plugin: the first push call answered: ${JSON.stringify(settled.reply)}`, { to: 'debug' })
  }
  const verdict = verdictOf(settled)
  if (verdict.kind === 'retry') {
    scheduleRetry($, chain)
    return
  }
  endChain(chain)
  if (verdict.kind === 'quiet') $.ui.log(`human-plugin: the push for #${item.id} ${verdict.why}`, { to: 'debug' })
  if (verdict.kind === 'failed') $.ui.log(`human-plugin: the push for #${item.id} ${verdict.why}`)
}

// A refused push is tried again a minute after its answer. The retry's timer is the chain's, so ending the chain cancels it.
function scheduleRetry($: EngineInterface, chain: Chain): void {
  chain.timer = $.clock.after(RETRY_MS, () => inChain($, chain, () => retry($, chain)))
}

// A retry reads its item as the list holds it now. The chain ends when the item is gone, no longer blocking, or sent, or when an hour has passed
// since the first try. An item in its undo window gets no push, and another minute; an open item is pushed with its current title.
async function retry($: EngineInterface, chain: Chain): Promise<void> {
  if (!current(chain)) return
  chain.timer = null
  const now = await $.clock.now()
  const { items } = await readList($)
  if (!current(chain)) return
  const item = items.find(it => it.id === chain.id)
  if (now - chain.firstAt >= LIMIT_MS || item === undefined || !item.blocking || item.state === 'done-pending') {
    endChain(chain)
    return
  }
  if (item.state === 'done-waiting') {
    scheduleRetry($, chain)
    return
  }
  await tryPush($, chain, item)
}

// The tool answer path's outcome (items.ts's act). A filing of a blocking item, a promotion, and a reopen of a blocking item start its push. An
// update that leaves an open item as it was, a reopen of a non-blocking item, and an update to an item in its undo window (whose window's end
// decides it) start none.
export function pushAnswer($: EngineInterface, out: Exclude<Outcome, { deny: string }>): void {
  if (out.added !== null) {
    if (out.added.blocking) pushBlocking($, out.added)
    return
  }
  const changed = out.changed
  if (changed === null || !(changed.promoted || changed.reopened)) return
  const item = out.store.items.find(it => it.id === changed.id)
  if (item?.blocking) pushBlocking($, item)
}

// A session's end ends every chain and cancels its timers: no retry fires afterwards, and a call still in flight schedules none.
export function endPushes(): void {
  firstCall = true
  for (const chain of chains.values()) chain.timer?.cancel()
  chains.clear()
}
