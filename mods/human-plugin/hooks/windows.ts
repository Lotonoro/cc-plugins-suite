import type { EngineInterface } from 'claude-code'
import type { Item, Store } from '../types'
import { send } from './deliver'
import { answerOf, answerShown, expire, isNumbered, press, reply, type AnswerOutcome, type Form, type GuardedOutcome } from './done'
import { followSent } from './pane'
import { pushBlocking } from './push'
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

// The state of the item a number names, as the debug line and the zero window read it: 'missing' when no item carries the number.
const stateNamed = (store: Store, digits: string): Item['state'] | 'missing' => store.items.find(it => isNumbered(it, digits))?.state ?? 'missing'

// The one write a press or a command makes on the list, and the undo window it leaves, which the ticker ends once its time has run out. `digits`
// names the item as `/asks <n>` does (a press passes its id). The write's time is the clock's less `back`: a press counts from when it was made,
// a command from one window earlier, so its window is due at once and the first tick ends it. A zero window that a press opens ends inside the
// write (`endsAtOnce`); a command's never does, since its notice is the ticker's to send. Each write leaves a debug line with its time and the
// state change it made. A write whose outcome says its session has ended (`lostSession`) goes no further than that line: the session's end stopped the
// ticker, and one started now would end windows on a list that is no longer the session's. What fails after the write is logged, and the write stands.
async function openWindow<T>(
  $: EngineInterface,
  windowMs: number,
  digits: string,
  { source, back, endsAtOnce, lostSession }: { source: string; back: number; endsAtOnce: boolean; lostSession?: (outcome: T) => boolean },
  change: (store: Store, token: number) => { store: Store; outcome: T },
): Promise<T> {
  const token = (await $.clock.now()) - back
  const moved: { from: string; to: string; outcome?: T } = { from: 'missing', to: 'missing' }
  const written = await updateList($, store => {
    const next = change(store, token)
    moved.from = stateNamed(store, digits)
    moved.to = stateNamed(next.store, digits)
    moved.outcome = next.outcome
    return next.store
  })
  const outcome = moved.outcome as T
  try {
    $.ui.log(`human-plugin: ${source} #${digits} at ${token}: ${moved.from} -> ${moved.to}`, { to: 'debug' })
    if (lostSession?.(outcome) === true) return outcome
    if (endsAtOnce && moved.from === 'open' && moved.to === 'done-waiting' && windowMs === 0) {
      // A zero window has no time to wait for, so it ends now rather than at the next tick. A press names its item by its id, so digits is the id.
      await expireWindow($, Number(digits), token, windowMs)
    } else {
      keepTicker($, written, windowMs)
    }
  } catch (err) {
    $.ui.log(`human-plugin: ${source} #${digits} was written; a step after the write failed: ${String(err)}`)
  }
  return outcome
}

// A done press on an open item opens its undo window; the same press again, inside the window, cancels it.
export function pressDone($: EngineInterface, id: number, answer: string | null, windowMs: number): Promise<void> {
  return openWindow($, windowMs, String(id), { source: 'done press', back: 0, endsAtOnce: true }, (store, token) => ({
    store: press(store, id, token, answer),
    outcome: undefined,
  }))
}

// A reply typed in the pane: the same window as a done press with the text as its answer.
export function pressReply($: EngineInterface, id: number, text: string, windowMs: number): Promise<void> {
  return openWindow($, windowMs, String(id), { source: 'reply', back: 0, endsAtOnce: true }, (store, token) => ({
    store: reply(store, id, token, text),
    outcome: undefined,
  }))
}

// A `/asks <n> <form>`: the resolver's write (answerOf), and the undo window an applied form leaves. The window counts from one window back, so the
// first tick after the write ends it; the notice is sent from the ticker's callback, never from the command's hook.
export function pressAnswer($: EngineInterface, digits: string, form: Form, windowMs: number): Promise<AnswerOutcome> {
  return openWindow($, windowMs, digits, { source: '/asks', back: windowMs, endsAtOnce: false }, (store, token) => answerOf(store, digits, form, token))
}

// A walk's answer to the item it showed: the guarded write (answerShown), and the undo window an applied one leaves, which is `pressAnswer`'s: it counts from
// one window back, so the first tick after the write ends it and sends the notice. A walk's writes carry their own source in the debug line. `owns` is the walk's
// test that it still owns its session, which the guard calls inside the list update; a write the guard refused for that starts no ticker.
export function pressShown($: EngineInterface, shown: Item, form: Form, windowMs: number, owns: () => boolean): Promise<GuardedOutcome> {
  return openWindow(
    $,
    windowMs,
    String(shown.id),
    { source: '/asks answer', back: windowMs, endsAtOnce: false, lostSession: (outcome: GuardedOutcome) => outcome.kind === 'session' },
    (store, token) => answerShown(store, shown, form, token, owns),
  )
}

// The window of press `token` has passed: sends the item, unless the press was cancelled or already sent. An item the window's end reopens is
// pushed when it is blocking, as a filing is; the push runs in the background, so it holds back neither the send nor the next window. Returns
// the list its write left.
async function expireWindow($: EngineInterface, id: number, token: number, windowMs: number): Promise<Store> {
  const expired: { sent: Item | null; reopened: boolean } = { sent: null, reopened: false }
  const store = await updateList($, before => {
    const result = expire(before, id, token)
    expired.sent = result.sent
    expired.reopened = result.reopened
    return result.store
  })
  const written = store.items.find(it => it.id === id)
  if (expired.reopened && written?.blocking) pushBlocking($, written)
  keepTicker($, store, windowMs)
  const sent = expired.sent
  if (sent === null) {
    $.ui.log(`human-plugin: the window of press ${token} on #${id} ended with nothing sent`, { to: 'debug' })
    return store
  }
  await followSent($, id)
  await send($, sent, token)
  return store
}

// A reload runs session.start again, and the ticker its old module started is cancelled: the ticker starts again for the windows still
// waiting, and the first tick ends each one whose time has run out.
export async function rearmWindows($: EngineInterface, windowMs: number): Promise<void> {
  keepTicker($, await readList($), windowMs)
}
