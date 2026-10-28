import type { Item, Store } from '../types'

// The text the agent reads when the human's done press is sent: the item's title, and the answer the press chose, if an option or
// a yes or no was pressed, the label a labelled to-do's ✓ carries, or the reply the human typed. It carries no brief: the agent wrote
// that, and `list` returns it. The marker line is what the replay reads back.
// What every notice asks after acting: the item leaves the list unless the human still has a step of their own, since the list is what
// the human owes and the agent's own follow-up work (a build, an install, a check) would read as theirs.
const THEN = 'then remove it. Keep it only if the human still has a step of their own to take, updated to name that step; your own follow-up work does not stay on the list.'

// A notice's title and answer, each on one line: a line break in either would start a line the replay reads as another item's marker,
// and the replay reads a reply's text to its line's end. Only a line break, with the blanks around it, becomes a space: the human's own
// spacing is kept.
export const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')

export const doneNotice = (item: Item): string => {
  const answer = item.answer === null ? null : oneLine(item.answer)
  const outcome =
    answer === null
      ? `The human marked it done. If the item proposed something or carried a recommendation, that is a go-ahead for it. Check that it is finished, ${THEN}`
      : item.replied
        ? `The human replied on #${item.id}: ${answer}\nAct on that reply, ${THEN}`
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

// A done press, or the press of an option or of a labelled to-do's ✓ (`answer`, its label). Open starts the undo window (nothing is sent yet) with that
// answer. Inside the window only the undo press (`answer` null) cancels it: an answer pressed there is a button drawn while the item
// was open, and changes nothing. A sent item is left as it is.
export const press = (store: Store, id: number, now: number, answer: string | null): Store =>
  mapItem(store, id, it => {
    if (it.state === 'open') return { ...it, state: 'done-waiting', pressedAt: now, answer }
    if (it.state === 'done-waiting' && answer === null) return { ...it, state: 'open', pressedAt: null, answer: null, replied: false }
    return it
  })

// A reply the human typed in the pane: a done press whose answer is the text. It acts on an open item only, so a reply never cancels
// a window. The text is one line, so the notice is one too.
export const reply = (store: Store, id: number, now: number, text: string): Store =>
  mapItem(store, id, it =>
    it.state === 'open' ? { ...it, state: 'done-waiting', pressedAt: now, answer: oneLine(text), replied: true } : it,
  )

// The agent changed a sent item in a way that asks the human something (items.ts decides): it goes back to open, with the press's
// answer and reply cleared, and unread so the band shows the follow-up. Any other item is left as it is, a window that is running included.
export const reopen = (store: Store, id: number): { store: Store; reopened: boolean } => {
  const target = store.items.find(it => it.id === id)
  if (target === undefined || target.state !== 'done-pending') return { store, reopened: false }
  return { store: mapItem(store, id, it => ({ ...it, state: 'open', pressedAt: null, answer: null, replied: false, unread: true })), reopened: true }
}

// The window of press `token` has passed. It sends only if that press is still the open window: a cancelled
// item sends nothing, and a second expiry of the same press finds it already sent.
export const expire = (store: Store, id: number, token: number): { store: Store; sent: Item | null } => {
  const target = store.items.find(it => it.id === id)
  if (target === undefined || target.state !== 'done-waiting' || target.pressedAt !== token) return { store, sent: null }
  const sent: Item = { ...target, state: 'done-pending', pressedAt: null }
  return { store: mapItem(store, id, () => sent), sent }
}
