import type { Notice, OwedNotices } from '../types'
import { pointerText } from './done'

// What a prompt the mod submits for the notices it is owed carries: its text, the notices it carries (the ones a refused submit holds again), and the ids of the
// notices appended that no request carried, which its text points to.
export type Submit = { text: string; notices: Notice[]; pointed: number[] }

// The done notices of the running main-loop turn, and whether one runs (a subagent's turn does not count). A notice
// offered while a turn runs waits for a read point: the end of a tool batch, or the start of a turn (a notice that
// came in while the turn was starting), which the engine holds before its next request. There it is appended, and it is
// unread until that request, which carries it, starts. Each notice moves on once, so the agent reads it once. The turn's
// end takes whatever is left: a turn of its own; after an interrupt, the human's next prompt (see takeHeld); and, while a walk
// is asking, the walk's release (see endHold) or the next turn to start, whichever comes first.
let busy = false
// Whether the hold is on: a walk is asking, or has ended and its release is still to come (walk.ts switches it on, and its release ends it: endHold). The engine
// refuses a submit made while the walk's command hook is in flight, so none is tried: a notice that would have started a turn of its own waits instead, with the
// session left idle, and the next turn to start, whoever starts it, appends it at its first read point, unless the walk's release delivers it first. A turn that
// ends takes what it left the same way.
let walkAsking = false
let waiting: Notice[] = []
let unread: Notice[] = []
// The notices held over an interrupt or a submit that did not enter, for the human's next prompt to carry as context.
let held: Notice[] = []
// The turn whose end was taken last: a second end for the same turn (a turn.complete that overran, then answered late) is a no-op.
let ended: string | null = null
// Counts the turn's ends, refused submits and resets. A hand-over whose append was in flight when it moved knows the turn was cut off.
let turnEnds = 0
// Told after each change to `held` or `waiting`: register.tsx keeps pending() in the state, which a reload keeps (the variables do not).
let onChange: () => void = () => {}

export const setOnChange = (fn: () => void): void => {
  onChange = fn
}

// The notices the agent is still owed, kept apart: held ones wait for the human's next prompt, waiting ones for a read point or a turn.
export const pending = (): OwedNotices => ({ held, waiting })

export const startTurn = (): void => {
  busy = true
}

// The walk that is asking switches this on in the step it starts. It goes off with the walk's release (endHold), or, when the walk could not arm its release, in the
// walk's own code; a session's end (reset) switches it off too.
export const setWalkAsking = (on: boolean): void => {
  walkAsking = on
}

// Decides a notice's path in one synchronous step. The first notice of an idle session takes the turn: busy is set here,
// not when the turn starts, so a notice that lands before the turn starts waits for it instead of starting a second one.
// While the hold is on an idle session is not taken: the notice waits ('walk') and busy stays unset.
export const offer = (notice: Notice): 'queued' | 'submit' | 'walk' => {
  if (busy || walkAsking) {
    waiting = [...waiting, notice]
    onChange()
    return busy ? 'queued' : 'walk'
  }
  busy = true
  return 'submit'
}

// The submit the mod made did not enter (a hook or a settings block refused it, or it failed), so no turn starts for it.
// Its notices and the ones waiting for that turn go to the human's next prompt, as after an interrupt.
export const notEntered = (notices: readonly Notice[]): void => {
  turnEnds += 1
  busy = false
  held = [...held, ...notices, ...waiting]
  waiting = []
  onChange()
}

// At a read point: appends the waiting notices, one at a time. A notice stays in `waiting` until its own append starts, so an end of
// the turn that lands during an await takes the ones not yet started (held, or submitted), and this loop skips them. Each notice is
// checked against the list right before it is appended (`isLive` reads the list afresh): a notice whose item the agent has removed
// since it was queued is dropped, its row never written. `append` answers whether the row was kept. A refused one goes back to
// waiting, and the hand-over stops, unless the turn ended while the append was in flight: then it is held for the human's next prompt.
export const handOver = async (append: (text: string) => Promise<boolean>, isLive: () => Promise<(id: number) => boolean>): Promise<void> => {
  for (const notice of [...waiting]) {
    const live = await isLive()
    if (!waiting.includes(notice)) continue
    waiting = waiting.filter(queued => queued !== notice)
    onChange()
    if (!live(notice.id)) continue
    const ends = turnEnds
    if (await append(notice.text)) {
      // A turn that ended during the append has already taken what was unread: its row is in the conversation, and no pointer is owed.
      if (turnEnds === ends) unread = [...unread, notice]
      continue
    }
    if (turnEnds === ends) {
      waiting = [notice, ...waiting]
      onChange()
      return
    }
    held = [notice, ...held]
    onChange()
    return
  }
}

// A request of the main turn is starting. Every hand-over so far happened at a read point before it, so it carries them.
export const carried = (): void => {
  unread = []
}

export const unreadIds = (): number[] => unread.map(notice => notice.id)

// What is on its way to the agent beyond the list's own item states, which the idle rule (idle.ts) reads at a turn's end: an answer, when a notice waits for a
// read point or the turn's end, or one was appended that no request has read (the turn's end then submits a turn that carries it); the walk's hold, while a walk
// is asking or its release is pending; else nothing. A held notice is none of these: it waits for the human's next prompt, not for a turn of its own.
export type OnItsWay = 'answer' | 'walk' | null

export const onItsWay = (): OnItsWay => {
  if (waiting.length > 0 || unread.length > 0) return 'answer'
  return walkAsking ? 'walk' : null
}

// Whether a prompt is the human's own (typed at the composer, or sent from the remote bridge): the only prompt that
// carries the notices held over an interrupt.
export const carriesHeld = (origin: { kind: string }): boolean => origin.kind === 'composer' || origin.kind === 'bridge'

// The prompt the human sends carries the held notices whose items are still on the list (`isLive`), as context, once; a
// held notice for an item the agent has removed is dropped here. A refused or failed prompt gives them back, so the next
// human prompt carries them instead. `next` passes the prompt on; the result is what it answered. `onCarried` is handed the
// context once the prompt has entered with it.
export const carryHeld = async <E extends { origin: { kind: string }; context?: readonly string[] }, R extends { drop?: unknown }>(
  e: E,
  next: (e: E) => Promise<R>,
  isLive: (id: number) => boolean,
  onCarried: (text: string) => void = () => {},
): Promise<R> => {
  if (!carriesHeld(e.origin)) return next(e)
  const notices = takeHeld().filter(notice => isLive(notice.id))
  if (notices.length === 0) return next(e)
  try {
    const text = notices.map(notice => notice.text).join('\n\n')
    const result = await next({ ...e, context: [...(e.context ?? []), text] })
    if (result.drop !== undefined) giveBack(notices)
    else onCarried(text)
    return result
  } catch (err) {
    giveBack(notices)
    throw err
  }
}

// The one prompt that delivers what a turn's end or a walk's release found left: a pointer to the notices appended that no request carried (their rows are in the
// conversation already), then the waiting ones. It keeps the session busy until it enters (its turn starts) or is refused (notEntered). Null when nothing is left.
const promptFor = (appended: readonly Notice[], left: Notice[]): Submit | null => {
  const pointed = appended.map(notice => notice.id)
  const parts = [...(pointed.length > 0 ? [pointerText(pointed)] : []), ...left.map(notice => notice.text)]
  busy = parts.length > 0
  return parts.length === 0 ? null : { text: parts.join('\n\n'), notices: left, pointed }
}

// The turn has ended. `isLive` says whether an item is still on the list: a notice for an item the agent has removed is
// dropped, so it starts no turn. The end of a turn is taken once: a later end for the same turn changes nothing. Not interrupted: returns the one prompt that delivers
// what is left, or null (promptFor). Interrupted: the waiting ones are held for the human's next prompt, and nothing is submitted, so an interrupt starts
// no turn. The appended ones are not held: their rows are in the conversation, and the next request, the human's, reads
// them with the rest. While the hold is on, a turn that was not interrupted submits nothing either: the waiting ones keep
// waiting, and so do the appended ones that no request carried, for the walk's release (endHold) or the next turn to start. The session is idle, and a request that
// starts first carries the appended ones.
export const endTurn = (turnId: string, interrupted: boolean, isLive: (id: number) => boolean): Submit | null => {
  if (turnId === ended) return null
  ended = turnId
  turnEnds += 1
  const appended = unread.filter(notice => isLive(notice.id))
  const left = waiting.filter(notice => isLive(notice.id))
  waiting = []
  unread = []
  if (interrupted) {
    busy = false
    held = [...held, ...left]
    onChange()
    return null
  }
  if (walkAsking) {
    busy = false
    waiting = left
    unread = appended
    onChange()
    return null
  }
  onChange()
  return promptFor(appended, left)
}

// The walk's release: the hold ends, and what is owed goes by the rule a turn's end uses (promptFor). `isLive` is as in endTurn. With a turn running, nothing is
// taken: that turn's read points append the waiting notices, and its end submits what it leaves, as any turn's end does once no walk is asking. The notices an
// interrupt held are not touched: they stay for the human's next prompt.
export const endHold = (isLive: (id: number) => boolean): Submit | null => {
  walkAsking = false
  if (busy) return null
  const owed = waiting.length > 0
  const appended = unread.filter(notice => isLive(notice.id))
  const left = waiting.filter(notice => isLive(notice.id))
  waiting = []
  unread = []
  if (owed) onChange()
  return promptFor(appended, left)
}

// Takes the notices held over an interrupt or a refused submit, once: the human's prompt carries them as context.
export const takeHeld = (): Notice[] => {
  const notices = held
  held = []
  onChange()
  return notices
}

// Puts back notices a prompt did not carry (refused or dropped), so the next human prompt does.
export const giveBack = (notices: readonly Notice[]): void => {
  held = [...notices, ...held]
  onChange()
}

// A /clear: the conversation the notices were for is gone, and so is the walk that was asking in it.
export const reset = (): void => {
  turnEnds += 1
  busy = false
  walkAsking = false
  waiting = []
  unread = []
  held = []
  ended = null
  onChange()
}
