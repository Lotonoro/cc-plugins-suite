import type { Item, ItemOption, Store, Turn } from '../types'
import { oneLine } from './cut'

// The text the agent reads when the human's done press is sent: the item's title, and the answer the press chose, if an option or
// a yes or no was pressed, the label a labelled to-do's ✓ carries, or the reply the human typed. It carries no brief: the agent wrote
// that, and `list` returns it. The marker line is what the replay reads back.
// What a press's notice asks after acting: the item leaves the list unless the human still has a step of their own, since the list is what
// the human owes and the agent's own follow-up work (a build, an install, a check) would read as theirs. A reply's notice asks instead whether
// the reply settles the ask: the agent removes the item, or appends to it, after which it is open for their next reply.
const THEN = 'then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.'

// The stack of an error, not only its message: a log line that names no place cannot be traced back to where the failure came from. An error
// with no stack is logged by its message, and a value that is not an Error as it is.
export const messageOf = (err: unknown): string => (err instanceof Error ? err.stack || err.message : String(err))

export const doneNotice = (item: Item): string => {
  const answer = item.answer === null ? null : oneLine(item.answer)
  const outcome =
    answer === null
      ? `The human marked it done. If the item proposed something or carried a recommendation, that is a go-ahead for it. Check that it is finished, ${THEN}`
      : item.replied
        ? `The human replied on #${item.id}: ${answer}\nIf that reply settles the ask, act on it, then remove the item; if you need more from the human, or they asked you something, append what you have to say to #${item.id}; the item is then open for their next reply. Your own follow-up work never stays on the list.`
        : item.yesno
          ? `The human answered ${answer} on #${item.id}. Act on that answer, ${THEN}`
          : item.doneLabel !== null
            ? `The human pressed "${answer}" on #${item.id}. Act on that, ${THEN}`
            : `The human chose ${answer} on #${item.id}. Act on that choice, ${THEN}`
  return `#${item.id} is done: ${oneLine(item.title)}\n${outcome}`
}

// Points the agent at notices already in the conversation, without their text: it starts a turn when no request carried
// them. It never reads as a notice to the replay.
export const pointerText = (ids: readonly number[]): string => {
  const named = ids.map(id => `#${id}`).join(', ')
  return ids.length === 1
    ? `human-plugin: ${named} was marked done while you worked; its notice is above.`
    : `human-plugin: ${named} were marked done while you worked; their notices are above.`
}

export const stateOf = (store: Store, id: number): Item['state'] | 'missing' =>
  store.items.find(it => it.id === id)?.state ?? 'missing'

const mapItem = (store: Store, id: number, change: (item: Item) => Item): Store => ({
  ...store,
  items: store.items.map(it => (it.id === id ? change(it) : it)),
})

// The words of a bare done press, which carries no answer: the human's turn for it.
const BARE_DONE = 'pressed done'

// The human's turn for the answer an item carries: the words the press or the reply sent, or the phrase of a bare done.
export const humanTurn = (item: Item): Turn => ({ speaker: 'human', words: item.answer ?? BARE_DONE })

// The item's exchange as it reads: its thread, then the human's answer while its undo window runs or once it is sent and awaits the agent (the
// newest human turn), then the agent's turns its window took (none once sent, since the window's end reopens the item with them: expire). The
// list, the pane and `/todo` read it here.
export const turnsOf = (item: Item): Turn[] => [...item.thread, ...(item.state === 'open' ? [] : [humanTurn(item)]), ...item.windowTurns]

// The label a turn is listed and drawn under: who spoke.
export const labelOf = (turn: Turn): string => (turn.speaker === 'human' ? 'you' : 'agent')

// A decision's options in the order the pane draws them and `/todo` numbers them: the recommended one first, the rest in their own order.
export const orderedOptions = (item: Item): ItemOption[] => [...item.options].sort((a, b) => Number(b.recommended) - Number(a.recommended))

// Whether the human has answered the item, so an agent addition is a turn and not a change to the brief: a human turn is in the thread, or an
// answer is out (in its undo window, or sent).
export const answered = (item: Item): boolean => item.state !== 'open' || item.thread.some(turn => turn.speaker === 'human')

// The brief with an agent's text added as a section at its end, after a blank line; the text alone when the brief is empty.
export const withSection = (detail: string, text: string): string => (detail === '' ? text : `${detail}\n\n${text}`)

// An item whose undo window is cancelled, or was never pressed (items.ts's normalizer): the answer is gone, so the agent's turns the window took
// are no longer waiting on it. With a human turn in the thread they follow it there; with none, each is a section of the brief, as an append made
// while no answer is out would add it. An update the window took stays in the item, and reopens nothing: no answer is left to reopen past.
export const cancelWindow = (item: Item): Item => {
  const open: Item = { ...item, state: 'open', pressedAt: null, answer: null, replied: false, windowTurns: [], windowChanged: false }
  if (answered(open)) return { ...open, thread: [...open.thread, ...item.windowTurns] }
  return { ...open, detail: item.windowTurns.reduce((detail, turn) => withSection(detail, turn.words), open.detail) }
}

// A sent item's answer becomes the thread's next human turn, the agent's turns its window took follow it, and the item is open again, unread.
export const archive = (item: Item): Item => ({
  ...item,
  state: 'open',
  pressedAt: null,
  answer: null,
  replied: false,
  unread: true,
  thread: [...item.thread, humanTurn(item), ...item.windowTurns],
  windowTurns: [],
  windowChanged: false,
})

// A done press, or the press of an option or of a labelled to-do's ✓ (`answer`, its label). Open starts the undo window (nothing is sent yet) with that
// answer. Inside the window only the undo press (`answer` null) cancels it: an answer pressed there is a button drawn while the item
// was open, and changes nothing. A cancelled window's agent turns are given to the item (cancelWindow). A sent item is left as it is.
export const press = (store: Store, id: number, now: number, answer: string | null): Store =>
  mapItem(store, id, it => {
    if (it.state === 'open') return { ...it, state: 'done-waiting', pressedAt: now, answer }
    if (it.state === 'done-waiting' && answer === null) return cancelWindow(it)
    return it
  })

// A reply the human typed in the pane: a done press whose answer is the text. It acts on an open item only, so a reply never cancels
// a window. The text is one line, so the notice is one too.
export const reply = (store: Store, id: number, now: number, text: string): Store =>
  mapItem(store, id, it =>
    it.state === 'open' ? { ...it, state: 'done-waiting', pressedAt: now, answer: oneLine(text), replied: true } : it,
  )

// The agent changed a sent item in a way that asks the human something (items.ts decides): its answer is archived into the thread, and the item
// goes back to open, unread, so the band shows the follow-up. Any other item is left as it is, a window that is running included.
export const reopen = (store: Store, id: number): { store: Store; reopened: boolean } => {
  const target = store.items.find(it => it.id === id)
  if (target === undefined || target.state !== 'done-pending') return { store, reopened: false }
  return { store: mapItem(store, id, archive), reopened: true }
}

// The window of press `token` has passed. It sends only if that press is still the open window: a cancelled item sends nothing, and a second
// expiry of the same press finds it already sent. The item it sends is returned as sent, for its notice. An agent turn or an update the window took
// reopens the item here, with the answer archived ahead of those turns: the reply first, the agent's after; `reopened` says whether it did.
export const expire = (store: Store, id: number, token: number): { store: Store; sent: Item | null; reopened: boolean } => {
  const target = store.items.find(it => it.id === id)
  if (target === undefined || target.state !== 'done-waiting' || target.pressedAt !== token) return { store, sent: null, reopened: false }
  const sent: Item = { ...target, state: 'done-pending', pressedAt: null }
  const reopened = sent.windowTurns.length > 0 || sent.windowChanged
  return { store: mapItem(store, id, () => (reopened ? archive(sent) : sent)), sent, reopened }
}

// A form an answer takes, as `/todo <n> <form>` names it (commands.ts parses it): done, yes or no, a decision's option by its number, or a
// reply with its text.
export type Form = { kind: 'done' } | { kind: 'yes' } | { kind: 'no' } | { kind: 'option'; n: number } | { kind: 'reply'; text: string }
export type FormKind = Form['kind']

// The forms an item takes, by its kind, classified as the pane draws it: a decision's options first, then a yes/no's yes and no, else a to-do's
// done. Every item takes a reply. The foot of `/todo <n>` lists these and answerOf takes only these, so the two cannot differ.
export const formsOf = (item: Item): FormKind[] => (item.options.length > 0 ? ['option', 'reply'] : item.yesno ? ['yes', 'no', 'reply'] : ['done', 'reply'])

// Whether an item is the one a number names: its id as text is the digits, which carry no leading zero.
export const isNumbered = (item: Item, digits: string): boolean => String(item.id) === digits

// A reply's text as the pane's reply field sends it: trimmed as JavaScript trims, or null when nothing is left. The pane and `/todo <n> reply` both take it.
export const replyText = (text: string): string | null => {
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

// What an answer did, for the hook to word. An applied answer carries the answer the item took, as its notice names it.
export type AnswerOutcome =
  | { kind: 'applied'; item: Item; answer: string }
  | { kind: 'missing' }
  | { kind: 'sent'; item: Item }
  | { kind: 'undoing'; item: Item }
  | { kind: 'takes'; item: Item }

// What a walk's guarded answer did to the item it showed: the applied answer, the item gone from the list, or the item not as the walk showed it (nothing is
// written then).
export type ShownOutcome = Extract<AnswerOutcome, { kind: 'applied' | 'missing' }> | { kind: 'changed' }

// What the guarded write answers: what became of the item, or that the walk no longer owns its session (nothing is written then either).
export type GuardedOutcome = ShownOutcome | { kind: 'session' }

// The answer a press of a form carries, for a form that is not a reply: a to-do's label as it stands, `yes` or `no`, or the option's label in the
// order the pane draws the options.
const pressOf = (item: Item, form: Exclude<Form, { kind: 'reply' }>): string | null => {
  switch (form.kind) {
    case 'done':
      return item.doneLabel
    case 'yes':
    case 'no':
      return form.kind
    case 'option':
      return orderedOptions(item)[form.n - 1]?.label ?? null
  }
}

// The resolver: one answer form on the list, decided at `token`, the time its window counts from. The number names the item, and the checks run in
// this order: missing; state (anything not open is refused: sent, or in its undo window); kind (formsOf); option range. An applied form is the press's
// own transition, or the reply's, so its notice is the press's. It clears the item's unread mark in the same write, since answering reads the item.
// A refused form changes nothing.
export const answerOf = (store: Store, digits: string, form: Form, token: number): { store: Store; outcome: AnswerOutcome } => {
  const target = store.items.find(it => isNumbered(it, digits))
  if (target === undefined) return { store, outcome: { kind: 'missing' } }
  if (target.state === 'done-pending') return { store, outcome: { kind: 'sent', item: target } }
  if (target.state === 'done-waiting') return { store, outcome: { kind: 'undoing', item: target } }
  const taken = formsOf(target).includes(form.kind) && (form.kind !== 'option' || (form.n >= 1 && form.n <= target.options.length))
  if (!taken) return { store, outcome: { kind: 'takes', item: target } }
  const readItem = (s: Store): Store => mapItem(s, target.id, it => ({ ...it, unread: false }))
  if (form.kind === 'reply') return { store: readItem(reply(store, target.id, token, form.text)), outcome: { kind: 'applied', item: target, answer: form.text } }
  const answer = pressOf(target, form)
  return { store: readItem(press(store, target.id, token, answer)), outcome: { kind: 'applied', item: target, answer: answer ?? 'done' } }
}

const sameLabels = (a: readonly ItemOption[], b: readonly ItemOption[]): boolean => a.length === b.length && a.every((option, k) => option.label === b[k]?.label)
const sameThread = (a: readonly Turn[], b: readonly Turn[]): boolean =>
  a.length === b.length && a.every((turn, k) => turn.speaker === b[k]?.speaker && turn.words === b[k]?.words)

// Whether an item still means to an answer what it meant when a walk showed it: it is open, and its title, its options' labels in the pane's order, its
// done label and its thread are as shown. A turn is added to the thread only once the item has been answered, so an item answered elsewhere and reopened, or
// one the agent has answered back, differs. A note or brief edit, and the agent's append to an item the human never answered (which lands in the brief),
// leave it as it was, since they change what the item says and not what an answer to it means. The yes/no mark cannot change after filing.
const sameAsShown = (now: Item, shown: Item): boolean =>
  now.state === 'open' &&
  now.title === shown.title &&
  now.doneLabel === shown.doneLabel &&
  sameLabels(orderedOptions(now), orderedOptions(shown)) &&
  sameThread(now.thread, shown.thread)

// A walk's answer to the item it showed: the resolver's write (answerOf) for `form`, unless the walk no longer owns its session, which writes nothing and answers
// `session`, or the item is no longer as shown (sameAsShown), which writes nothing and answers `changed`, or has left the list, which answers `missing`. The guard
// sits in the same update as the write, so nothing can change the item between the two, and `owns`, the walk's own test of its session, is called here for the
// same reason: a session that ends after the walk's last test and before this update cannot be followed by a write. The session is checked first, since the list
// may by then be another session's. What the guard lets through cannot be refused by the resolver, so a refusal of it is read as a change as well.
export const answerShown = (store: Store, shown: Item, form: Form, token: number, owns: () => boolean): { store: Store; outcome: GuardedOutcome } => {
  if (!owns()) return { store, outcome: { kind: 'session' } }
  const now = store.items.find(it => it.id === shown.id)
  if (now === undefined) return { store, outcome: { kind: 'missing' } }
  if (!sameAsShown(now, shown)) return { store, outcome: { kind: 'changed' } }
  const result = answerOf(store, String(shown.id), form, token)
  return result.outcome.kind === 'applied' ? { store: result.store, outcome: result.outcome } : { store, outcome: { kind: 'changed' } }
}
