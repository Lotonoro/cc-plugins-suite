import type { Notice, OwedNotices } from '../types'
import { pointerText } from './done'

// What the turn's end submits: the prompt's text, and the notices it carries (the ones a refused submit holds again).
export type Submit = { text: string; notices: Notice[] }

// The done notices of the running main-loop turn, and whether one runs (a subagent's turn does not count). A notice
// offered while a turn runs waits for a read point: the end of a tool batch, or the start of a turn (a notice that
// came in while the turn was starting), which the engine holds before its next request. There it is appended, and it is
// unread until that request, which carries it, starts. Each notice moves on once, so the agent reads it once. The turn's
// end takes whatever is left: a turn of its own, or, after an interrupt, the human's next prompt (see takeHeld).
let busy = false
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

// Decides a notice's path in one synchronous step. The first notice of an idle session takes the turn: busy is set here,
// not when the turn starts, so a notice that lands before the turn starts waits for it instead of starting a second one.
export const offer = (notice: Notice): 'queued' | 'submit' => {
  if (busy) {
    waiting = [...waiting, notice]
    onChange()
    return 'queued'
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

// The turn has ended. `isLive` says whether an item is still on the list: a notice for an item the agent has removed is
// dropped, so it starts no turn. The end of a turn is taken once: a later end for the same turn changes nothing. Not interrupted: returns the one prompt that delivers what is left, or null. It is
// a pointer to the notices appended that no request carried (their rows are in the conversation already), then the
// waiting ones. That prompt keeps the session busy until it enters (its turn starts) or is refused (notEntered).
// Interrupted: the waiting ones are held for the human's next prompt, and nothing is submitted, so an interrupt starts
// no turn. The appended ones are not held: their rows are in the conversation, and the next request, the human's, reads
// them with the rest.
export const endTurn = (turnId: string, interrupted: boolean, isLive: (id: number) => boolean): Submit | null => {
  if (turnId === ended) return null
  ended = turnId
  turnEnds += 1
  const pointed = unread.filter(notice => isLive(notice.id)).map(notice => notice.id)
  const left = waiting.filter(notice => isLive(notice.id))
  waiting = []
  unread = []
  if (interrupted) {
    busy = false
    held = [...held, ...left]
    onChange()
    return null
  }
  onChange()
  const parts = [...(pointed.length > 0 ? [pointerText(pointed)] : []), ...left.map(notice => notice.text)]
  busy = parts.length > 0
  return parts.length === 0 ? null : { text: parts.join('\n\n'), notices: left }
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

// A /clear: the conversation the notices were for is gone.
export const reset = (): void => {
  turnEnds += 1
  busy = false
  waiting = []
  unread = []
  held = []
  ended = null
  onChange()
}
