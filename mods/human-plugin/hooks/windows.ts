import type { EngineInterface } from 'claude-code'
import type { Item, Store } from '../types'
import { send } from './deliver'
import { expire, press, reply, stateOf } from './done'
import { followSent } from './pane'
import { inBackground, readList, updateList } from './shared'

const TICK_MS = 1000

// The one-second tick: it redraws the undo countdowns and ends each window whose time has run out. It runs only while some item waits in its
// window, so a window ends on the first tick at or after its time. Every write that leaves a window waiting starts it (keepTicker); only a
// tick stops it, and not when a window was asked for since the tick began (`asked`): a write's answer may come after a later write's, so
// the list a write returns can be older than another window, and stopping on it would leave that window unended.
let ticker: { cancel: () => void } | null = null
let asked = 0

// A session's end stops the tick, so no tick is left to redraw the band.
export const stopTicker = (): void => {
  ticker?.cancel()
  ticker = null
}

const waits = (store: Store): boolean => store.items.some(it => it.state === 'done-waiting')

function keepTicker($: EngineInterface, store: Store, windowMs: number): void {
  if (!waits(store)) return
  asked++
  if (ticker === null) ticker = $.clock.every(TICK_MS, () => inBackground($, tick($, windowMs)))
}

// One tick: each window whose time has run out ends (expireWindow, token-checked, so an item is sent once even when two ticks see it overdue),
// and the countdowns are redrawn. The ticker stops when the list as the tick last saw it has no window left and none was asked for since.
async function tick($: EngineInterface, windowMs: number): Promise<void> {
  const since = asked
  const now = await $.clock.now()
  let store = await readList($)
  for (const it of store.items) {
    if (it.state !== 'done-waiting' || it.pressedAt === null || it.pressedAt + windowMs > now) continue
    store = await expireWindow($, it.id, it.pressedAt, windowMs)
  }
  if (!waits(store) && asked === since) stopTicker()
  $.ui.invalidate('ui.render')
}

// A press that changes an item's state, made at `now` by `change`: a done press or a reply on an open item opens its undo window (nothing
// is sent yet), which the ticker ends once its time has run out. Each press leaves a debug line with its token (the time it was pressed)
// and the state change it made.
async function openWindow(
  $: EngineInterface,
  id: number,
  windowMs: number,
  kind: 'done press' | 'reply',
  change: (store: Store, now: number) => Store,
): Promise<void> {
  const now = await $.clock.now()
  const moved: { from: string; to: string } = { from: 'missing', to: 'missing' }
  const written = await updateList($, store => {
    const next = change(store, now)
    moved.from = stateOf(store, id)
    moved.to = stateOf(next, id)
    return next
  })
  $.ui.log(`human-plugin: ${kind} #${id} at ${now}: ${moved.from} -> ${moved.to}`, { to: 'debug' })
  // A zero window has no time to wait for, so it ends now rather than at the next tick.
  if (moved.from === 'open' && moved.to === 'done-waiting' && windowMs === 0) {
    await expireWindow($, id, now, windowMs)
    return
  }
  keepTicker($, written, windowMs)
}

// A done press on an open item opens its undo window; the same press again, inside the window, cancels it.
export function pressDone($: EngineInterface, id: number, answer: string | null, windowMs: number): Promise<void> {
  return openWindow($, id, windowMs, 'done press', (store, now) => press(store, id, now, answer))
}

// A reply typed in the pane: the same window as a done press with the text as its answer.
export function pressReply($: EngineInterface, id: number, text: string, windowMs: number): Promise<void> {
  return openWindow($, id, windowMs, 'reply', (store, now) => reply(store, id, now, text))
}

// The window of press `token` has passed: sends the item, unless the press was cancelled or already sent. Returns the list its write left.
async function expireWindow($: EngineInterface, id: number, token: number, windowMs: number): Promise<Store> {
  const expired: { sent: Item | null } = { sent: null }
  const store = await updateList($, before => {
    const result = expire(before, id, token)
    expired.sent = result.sent
    return result.store
  })
  keepTicker($, store, windowMs)
  const sent = expired.sent
  if (sent === null) {
    $.ui.log(`human-plugin: the window of press ${token} on #${id} ended with nothing sent`, { to: 'debug' })
    return store
  }
  await followSent($, store.items, id)
  await send($, sent, token)
  return store
}

// A reload runs session.start again, and the ticker its old module started is cancelled: the ticker starts again for the windows still
// waiting, and the first tick ends each one whose time has run out.
export async function rearmWindows($: EngineInterface, windowMs: number): Promise<void> {
  keepTicker($, await readList($), windowMs)
}
