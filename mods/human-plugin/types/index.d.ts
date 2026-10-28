// One answer a decision offers, as an AskUserQuestion option: a button labelled `label`, with its `description`. At most one is
// `recommended`.
export type ItemOption = { label: string; description: string; recommended: boolean }

// One ask the agent has of the human. `state` is `done-pending` once the human marks it done, until the agent removes it
// or changes it in a way that asks the human something (an append, or an update that sets a title, detail, blocking, options, note or
// done label), which reopens it. `agent` is null when the main agent filed it, else the subagent's id.
// `done-waiting` is the undo window after a done press: nothing is sent yet. `done-pending` is sent, until the agent acts.
export type ItemState = 'open' | 'done-waiting' | 'done-pending'

// One turn of an item's exchange: who spoke, and the words. A human turn is the answer the human pressed or sent (done.ts derives it).
export type Turn = { speaker: 'human' | 'agent'; words: string }

export type Item = {
  id: number
  title: string
  detail: string
  blocking: boolean
  createdAt: number
  state: ItemState
  // When the done press opened the undo window; null outside it.
  pressedAt: number | null
  note: string | null
  agent: string | null
  unread: boolean
  // The answers a decision offers (none for a plain ask), and the one the human pressed, while its undo window runs or after.
  options: ItemOption[]
  // A yes/no question (the agent's `yesno` marker): its row offers a yes and a no in place of a check, and its answer is `yes` or
  // `no`. It has no options.
  yesno: boolean
  // The answer a press chose (an option's label, or `yes` or `no`), or the text of a reply the human typed, while its undo window runs or
  // after. `replied` says the text is the reply.
  answer: string | null
  replied: boolean
  // What a press of a plain to-do's ✓ means (`Go with sqlite`): drawn on its button as `[✓ <label>]`, and sent as the press's answer.
  // Null for a plain to-do with a bare `[✓]`, and for a yes/no or a decision, which say what a press means themselves.
  doneLabel: string | null
  // The exchange on the item, in order: each answer the human sent that the agent reopened past (archived by done.ts), and each agent
  // addition after it.
  thread: Turn[]
  // The agent's additions made while the item's answer is in its undo window. They follow that answer, which joins the thread when the
  // window ends; a cancelled window gives them to the brief, or to the thread after a human turn (done.ts).
  windowTurns: Turn[]
  // An update made while the item's answer is in its undo window, of the kind that reopens a sent item (items.ts): the item reopens when the
  // window ends, as it does for a window turn. It has no words, so it is no turn; a cancelled window drops it, and the update stays (done.ts).
  windowChanged: boolean
}

// The whole list, in one value so a write checks it at once: the items, and the number the next item takes.
export type Store = { items: Item[]; next: number }

// A done notice the agent is still owed (turns.ts). It is kept in the state, since a reload starts the module's own variables over.
export type Notice = { id: number; text: string }

// The owed notices as the state keeps them: held for the human's next prompt, or waiting for a read point or a turn.
export type OwedNotices = { held: Notice[]; waiting: Notice[] }

declare module 'claude-code' {
  interface PluginState {
    'human-plugin': { list: Store; selection: number | null; corrected: number[]; notices: OwedNotices }
  }
}
