import type { Item, ItemOption, Store, Turn } from '../types'

// The text the agent reads when the human's done press is sent: the item's title, and the answer the press chose, if an option or
// a yes or no was pressed, the label a labelled to-do's ✓ carries, or the reply the human typed. It carries no brief: the agent wrote
// that, and `list` returns it. The marker line is what the replay reads back.
// What a press's notice asks after acting: the item leaves the list unless the human still has a step of their own, since the list is what
// the human owes and the agent's own follow-up work (a build, an install, a check) would read as theirs. A reply's notice asks instead whether
// the reply settles the ask: the agent removes the item, or appends to it, after which it is open for their next reply.
const THEN = 'then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.'

// A notice's title and answer, each on one line: a line break in either would start a line the replay reads as another item's marker,
// and the replay reads a reply's text to its line's end. Only a line break, with the blanks around it, becomes a space: the human's own
// spacing is kept.
export const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')

// The text cut to at most `max` UTF-16 units, the ellipsis counted within them. A cut never splits a surrogate pair: one that would is a unit
// shorter. Line breaks stay as they are, so a multi-line text is cut to a multi-line text; cutLine is the one-line cut.
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text
  if (max <= 0) return ''
  let end = max - 1
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  if (end > 0 && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--
  return `${text.slice(0, end)}\u2026`
}

// A title or a label cut to one line: its line breaks become spaces (oneLine), then cutText.
export const cutLine = (text: string, max: number): string => cutText(oneLine(text), max)

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
// list, the pane and `/asks` read it here.
export const turnsOf = (item: Item): Turn[] => [...item.thread, ...(item.state === 'open' ? [] : [humanTurn(item)]), ...item.windowTurns]

// The label a turn is listed and drawn under: who spoke.
export const labelOf = (turn: Turn): string => (turn.speaker === 'human' ? 'you' : 'agent')

// A decision's options in the order the pane draws them and `/asks` numbers them: the recommended one first, the rest in their own order.
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
// reopens the item here, with the answer archived ahead of those turns: the reply first, the agent's after.
export const expire = (store: Store, id: number, token: number): { store: Store; sent: Item | null } => {
  const target = store.items.find(it => it.id === id)
  if (target === undefined || target.state !== 'done-waiting' || target.pressedAt !== token) return { store, sent: null }
  const sent: Item = { ...target, state: 'done-pending', pressedAt: null }
  return { store: mapItem(store, id, () => (sent.windowTurns.length > 0 || sent.windowChanged ? archive(sent) : sent)), sent }
}
