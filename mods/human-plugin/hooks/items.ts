import type { Item, ItemOption, ItemState, Store, Turn } from '../types'
import { answered, archive, cancelWindow, labelOf, reopen, turnsOf, withSection } from './done'

export const PLUGIN = 'human-plugin'
export const TOOL = 'mcp__human-plugin__human_items'
export const EMPTY: Store = { items: [], next: 1, term: null }

const STATES: readonly ItemState[] = ['open', 'done-waiting', 'done-pending']

// Text of only spaces is no detail or note: it is stored cleared, a detail as '' and a note as null, the value listText and the pane read
// as no note. Stored text (normalizeItem) and text the tool is given (parseInput) are both stored this way.
const detailOf = (raw: string): string => (raw.trim() === '' ? '' : raw)
const noteOf = (raw: string): string | null => (raw.trim() === '' ? null : raw)

// One option as stored. An entry with no label is no option, and is dropped.
const optionOf = (raw: unknown): ItemOption | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.label !== 'string' || r.label === '') return null
  return { label: r.label, description: typeof r.description === 'string' ? r.description : '', recommended: r.recommended === true }
}

// One turn as stored. A turn with no known speaker, or no words, is malformed and is dropped.
const turnOf = (raw: unknown): Turn | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const speaker = r.speaker
  if ((speaker !== 'human' && speaker !== 'agent') || typeof r.words !== 'string' || r.words.trim() === '') return null
  return { speaker, words: r.words }
}

// A stored list of turns, its malformed turns dropped. A value that is no list is an empty one.
const turnsStored = (raw: unknown): Turn[] => (Array.isArray(raw) ? raw.map(turnOf).filter((turn): turn is Turn => turn !== null) : [])

// One item as stored, with every field the current release reads filled in: a list an older release wrote lacks the fields added
// since, and a field of the wrong type takes its default. Null when the item has no id (a whole number from 1) or no title.
export const normalizeItem = (raw: unknown): Item | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1 || typeof r.title !== 'string') return null
  const pressedAt = typeof r.pressedAt === 'number' && Number.isFinite(r.pressedAt) ? r.pressedAt : null
  const stored = STATES.find(s => s === r.state) ?? 'open'
  const item: Item = {
    id: r.id,
    title: r.title,
    detail: typeof r.detail === 'string' ? detailOf(r.detail) : '',
    blocking: r.blocking === true,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    state: stored,
    pressedAt,
    note: typeof r.note === 'string' ? noteOf(r.note) : null,
    agent: typeof r.agent === 'string' ? r.agent : null,
    unread: r.unread === true,
    options: Array.isArray(r.options) ? r.options.map(optionOf).filter((o): o is ItemOption => o !== null) : [],
    yesno: r.yesno === true,
    answer: typeof r.answer === 'string' ? r.answer : null,
    replied: r.replied === true,
    doneLabel: typeof r.doneLabel === 'string' ? r.doneLabel : null,
    thread: turnsStored(r.thread),
    windowTurns: stored === 'done-waiting' ? turnsStored(r.windowTurns) : [],
    windowChanged: stored === 'done-waiting' && r.windowChanged === true,
  }
  // An undo window with no press time cannot end, so the item was never pressed: it is open, and its window's turns are given to it as a
  // cancelled window gives them (cancelWindow).
  return stored === 'done-waiting' && pressedAt === null ? cancelWindow(item) : item
}

// The term as stored: text, a blank text as the cleared term (''). Any other value is no term (null), so a list an older release wrote has none.
const termStored = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  return raw.trim() === '' ? '' : raw
}

// The whole list as stored: its items normalized (the garbage ones dropped), the id counter kept at least one above the highest
// id, so an id is never handed out twice, and the term as stored.
export const normalizeStore = (raw: unknown): Store => {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const items = Array.isArray(r.items) ? r.items.map(normalizeItem).filter((it): it is Item => it !== null) : []
  const highest = items.reduce((max, it) => Math.max(max, it.id), 0)
  const saved = typeof r.next === 'number' && Number.isInteger(r.next) && r.next >= 1 ? r.next : 1
  return { items, next: Math.max(saved, highest + 1), term: termStored(r.term) }
}

// A term as the input check reads it: one line, or the reason it is refused. A blank term is `ok` with the empty text, which clears the term.
type TermCheck = { ok: true; value: string } | { ok: false; reason: string }

// `term` is the term the call states for the human (add and update only): undefined when it states none.
export type ToolInput =
  | { action: 'add'; title: string; detail: string; blocking: boolean; options: ItemOption[]; yesno: boolean; doneLabel: string | null; term?: TermCheck }
  | { action: 'update'; id: number; title?: string; detail?: string; blocking?: boolean; note?: string | null; options?: ItemOption[]; doneLabel?: string | null; term?: TermCheck }
  | { action: 'append'; id: number; text: string }
  | { action: 'remove'; id: number }
  | { action: 'list' }

type UpdateInput = Extract<ToolInput, { action: 'update' }>

export type Parsed = { ok: true; value: ToolInput } | { ok: false; reason: string }

// The options of a decision, as AskUserQuestion takes them: 2 to 4, each with a one-line label, at most one recommended.
// Undefined when none were given.
const parseOptions = (raw: unknown): { ok: true; value: ItemOption[] | undefined } | { ok: false; reason: string } => {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return { ok: false, reason: 'options must be a list of 2 to 4 options' }
  const options: ItemOption[] = []
  for (const o of raw) {
    const r = typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {}
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    if (label === '' || label.includes('\n')) return { ok: false, reason: 'each option needs a label on one line' }
    if (r.description !== undefined && typeof r.description !== 'string') return { ok: false, reason: 'option description must be text' }
    if (r.recommended !== undefined && typeof r.recommended !== 'boolean') return { ok: false, reason: 'option recommended must be true or false' }
    options.push({ label, description: typeof r.description === 'string' ? r.description : '', recommended: r.recommended === true })
  }
  if (options.filter(o => o.recommended).length > 1) return { ok: false, reason: 'at most one option is recommended' }
  if (new Set(options.map(o => o.label)).size !== options.length) return { ok: false, reason: 'option labels must differ' }
  return { ok: true, value: options }
}

// The longest label a to-do's ✓ may carry, in display columns: a few words, so the drawn `[✓ label]` does not crowd the title out of a
// narrow band. A wide character (CJK, emoji) takes two columns.
const DONE_MAX = 24
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff],
]
const columns = (text: string): number =>
  [...text].reduce((sum, ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return sum + (WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1)
  }, 0)

// The longest term the agent gives for the human, in display columns: the short word the band's chip names the human by.
const TERM_MAX = 20

// A label or a term as one line: whitespace collapsed to single spaces and trimmed, so a line break is drawn as a space. Refused, with
// `refusal` as the reason, when it is over `max` columns.
const lineOf = (raw: string, max: number, refusal: string): { ok: true; value: string } | { ok: false; reason: string } => {
  const line = raw.replace(/\s+/g, ' ').trim()
  return columns(line) > max ? { ok: false, reason: refusal } : { ok: true, value: line }
}

// The label a plain to-do's ✓ carries: what a press means, one line (whitespace is drawn as a space). Undefined when none was given, and
// null when an update's `done: ''` clears it. A yes/no or a decision says what each press means in its own buttons, so it takes none.
const parseDone = (raw: unknown, decision: boolean, clear: boolean): { ok: true; value: string | null | undefined } | { ok: false; reason: string } => {
  if (raw === undefined) return { ok: true, value: undefined }
  if (decision) return { ok: false, reason: 'done is for a to-do: a yes/no or a decision already says what each press means' }
  if (typeof raw !== 'string') return { ok: false, reason: 'done must be text' }
  const label = lineOf(raw, DONE_MAX, `done must be at most ${DONE_MAX} columns: name what a press does in a few words`)
  if (!label.ok) return label
  if (label.value === '') return clear ? { ok: true, value: null } : { ok: false, reason: 'done needs a label, e.g. "Go with sqlite"' }
  return { ok: true, value: label.value }
}

// The term the call states for the human, as the input check reads it: one line, at most TERM_MAX columns, '' when blank. Undefined when none
// is given. A refused term is returned, not acted on here: whether it refuses the call depends on the caller, and withTerm decides that.
const parseTerm = (raw: unknown): TermCheck | undefined => {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return { ok: false, reason: 'term must be text' }
  return lineOf(raw, TERM_MAX, `term must be at most ${TERM_MAX} columns: give the short word or name you use for the human`)
}

// The model's tool input is external data: it is checked here once, and the rest of the mod sees only ToolInput.
export const parseInput = (raw: unknown): Parsed => {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'the input must be an object' }
  const r = raw as Record<string, unknown>
  const id = r.id
  const isId = typeof id === 'number' && Number.isInteger(id) && id >= 1
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  switch (r.action) {
    case 'add': {
      const title = text(r.title)?.trim() ?? ''
      if (title === '') return { ok: false, reason: 'add needs a title' }
      if (r.detail !== undefined && text(r.detail) === undefined) return { ok: false, reason: 'detail must be text' }
      if (r.blocking !== undefined && typeof r.blocking !== 'boolean') return { ok: false, reason: 'blocking must be true or false' }
      if (r.yesno !== undefined && typeof r.yesno !== 'boolean') return { ok: false, reason: 'yesno must be true or false' }
      if (r.yesno === true && r.options !== undefined) return { ok: false, reason: 'a yes/no question takes no options' }
      const options = parseOptions(r.options)
      if (!options.ok) return options
      const done = parseDone(r.done, r.yesno === true || options.value !== undefined, false)
      if (!done.ok) return done
      return {
        ok: true,
        value: {
          action: 'add',
          title,
          detail: detailOf(text(r.detail) ?? ''),
          blocking: r.blocking === true,
          options: options.value ?? [],
          yesno: r.yesno === true,
          doneLabel: done.value ?? null,
          term: parseTerm(r.term),
        },
      }
    }
    case 'update': {
      if (!isId) return { ok: false, reason: 'update needs the item id (a whole number from 1)' }
      const value: UpdateInput = { action: 'update', id: id as number }
      if (r.title !== undefined) {
        const title = text(r.title)
        if (title === undefined) return { ok: false, reason: 'title must be text' }
        if (title.trim() === '') return { ok: false, reason: 'title is empty' }
        value.title = title.trim()
      }
      if (r.detail !== undefined) {
        const detail = text(r.detail)
        if (detail === undefined) return { ok: false, reason: 'detail must be text' }
        value.detail = detailOf(detail)
      }
      if (r.blocking !== undefined) {
        if (typeof r.blocking !== 'boolean') return { ok: false, reason: 'blocking must be true or false' }
        value.blocking = r.blocking
      }
      if (r.note !== undefined) {
        const note = text(r.note)
        if (note === undefined) return { ok: false, reason: 'note must be text' }
        // A blank note clears the note, as a blank done label clears the label (parseDone).
        value.note = noteOf(note)
      }
      if (r.options !== undefined) {
        const options = parseOptions(r.options)
        if (!options.ok) return options
        value.options = options.value
      }
      const done = parseDone(r.done, r.options !== undefined, true)
      if (!done.ok) return done
      if (done.value !== undefined) value.doneLabel = done.value
      const term = parseTerm(r.term)
      if (term !== undefined) value.term = term
      if (value.title === undefined && value.detail === undefined && value.blocking === undefined && value.note === undefined && value.options === undefined && value.doneLabel === undefined && value.term === undefined) {
        return { ok: false, reason: 'update changes nothing: give a title, detail, blocking, note, options, done or term' }
      }
      return { ok: true, value }
    }
    case 'append': {
      if (!isId) return { ok: false, reason: 'append needs the item id (a whole number from 1)' }
      const text = typeof r.text === 'string' ? r.text.trim() : ''
      if (text === '') return { ok: false, reason: 'append needs text' }
      return { ok: true, value: { action: 'append', id: id as number, text } }
    }
    case 'remove':
      return isId ? { ok: true, value: { action: 'remove', id: id as number } } : { ok: false, reason: 'remove needs the item id (a whole number from 1)' }
    case 'list':
      return { ok: true, value: { action: 'list' } }
    default:
      return { ok: false, reason: 'action must be add, update, append, remove or list' }
  }
}

// Who asks: null for the main agent, else the subagent's id.
export type Ctx = { agent: string | null; now: number }

// `changed` names the item an append or an update changed, whether that change reopened it, and whether it promoted it, marking an
// open item blocking (null for any other call, and for an update that changed nothing): the pane, the chime and any later consumer
// learn of a reopen or a promotion here and not by diffing lists.
export type Outcome =
  | { deny: string }
  | { store: Store; reply: string; added: Item | null; changed: { id: number; reopened: boolean; promoted: boolean } | null }

// An outcome that is not denied.
type Applied = Extract<Outcome, { store: Store }>

// The fields an agent's change writes, each as the text it compares by: the detail, the note and each option's description by their
// trimmed text, so a whitespace-only edit is no change, and a field a change empties as ''. `unchanged` is every field equal. `asks` is a
// field that differs and is not emptied, which sets a title, a blocking mark, options, or text in the detail, note or done label. Both read
// this one list, so a field added to it is compared by both.
const FIELDS: readonly ((it: Item) => string)[] = [
  it => it.title,
  it => it.detail.trim(),
  it => String(it.blocking),
  it => (it.note ?? '').trim(),
  it => JSON.stringify(it.options.map(o => ({ ...o, description: o.description.trim() }))),
  it => it.doneLabel ?? '',
]
const unchanged = (before: Item, after: Item): boolean => FIELDS.every(field => field(before) === field(after))
const asks = (before: Item, after: Item): boolean => FIELDS.some(field => field(after) !== field(before) && field(after) !== '')

// An agent's change to `target`, written as `after`. One that leaves the item as it was is no change. One that asks the human something
// (asks) puts a sent item back to open, with its reply field (done.ts); an item in its undo window keeps the window, and reopens when it ends.
const change = (store: Store, target: Item, after: Item, reply: string): Applied => {
  if (unchanged(target, after)) return { store, reply: `no change to #${target.id}`, added: null, changed: null }
  const asked = asks(target, after)
  const marked = asked && target.state === 'done-waiting' ? { ...after, windowChanged: true } : after
  const written = { ...store, items: store.items.map(it => (it.id === target.id ? marked : it)) }
  const out = asked ? reopen(written, target.id) : { store: written, reopened: false }
  const promoted = target.state === 'open' && !target.blocking && after.blocking
  return { store: out.store, reply, added: null, changed: { id: target.id, reopened: out.reopened, promoted } }
}

// An agent addition to an item the human has answered is a turn after the answer, not a change to the brief. A sent answer is archived first, so
// the turn follows it, and the item reopens; an answer in its undo window keeps the window, and the turn waits in it for the window's end (done.ts).
// A turn outside a window is unread, as a reopen is: the person may have read the item since its last turn.
const appendTurn = (store: Store, target: Item, text: string): Outcome => {
  const turn: Turn = { speaker: 'agent', words: text }
  const base = target.state === 'done-pending' ? archive(target) : target
  const after = target.state === 'done-waiting' ? { ...base, windowTurns: [...base.windowTurns, turn] } : { ...base, unread: true, thread: [...base.thread, turn] }
  return {
    store: { ...store, items: store.items.map(it => (it.id === target.id ? after : it)) },
    reply: `appended to #${target.id}`,
    added: null,
    changed: { id: target.id, reopened: target.state === 'done-pending', promoted: false },
  }
}

// The note a reply ends with about the term, after the item's outcome. An outcome holds no opening parenthesis, so outcomeOf can cut it off.
const termNote = (text: string): string => ` (${text})`

// The term a call leaves on the list, as the call states it. A subagent's term is not used, valid or not, and the reply says so. The main
// agent's term replaces the list's, a blank one clearing it; a term it states that is refused refuses the whole call, so nothing is applied.
// A call with no term leaves the list's as it is. The reply names what became of the term, after the item's outcome.
const withTerm = (out: Applied, term: TermCheck | undefined, ctx: Ctx): Outcome => {
  if (term === undefined) return out
  if (ctx.agent !== null) return { ...out, reply: `${out.reply}${termNote('term not used: only the main agent sets it')}` }
  if (!term.ok) return { deny: term.reason }
  const note = term.value === '' ? termNote('term cleared') : termNote(`term set to "${term.value}"`)
  return { ...out, store: { ...out.store, term: term.value }, reply: `${out.reply}${note}` }
}

// The item's outcome in a reply: the reply without the term note that follows it (the transcript row, ui.ts, draws the outcome alone).
export const outcomeOf = (reply: string): string => {
  const at = reply.indexOf(' (')
  return at === -1 ? reply : reply.slice(0, at)
}

export const act = (store: Store, input: ToolInput, ctx: Ctx): Outcome => {
  if (input.action === 'list') return { store, reply: listText(store.items), added: null, changed: null }
  if (input.action === 'add') {
    const item: Item = {
      id: store.next,
      title: input.title,
      detail: input.detail,
      blocking: input.blocking,
      createdAt: ctx.now,
      state: 'open',
      pressedAt: null,
      note: null,
      agent: ctx.agent,
      unread: true,
      options: input.options,
      answer: null,
      replied: false,
      yesno: input.yesno,
      doneLabel: input.doneLabel,
      thread: [],
      windowTurns: [],
      windowChanged: false,
    }
    return withTerm({ store: { items: [...store.items, item], next: store.next + 1, term: store.term }, reply: `added #${item.id}`, added: item, changed: null }, input.term, ctx)
  }
  const target = store.items.find(it => it.id === input.id)
  if (target === undefined) return { deny: `no item #${input.id}` }
  if (input.action === 'append') {
    if (answered(target)) return appendTurn(store, target, input.text)
    const detail = withSection(target.detail, input.text)
    return change(store, target, { ...target, detail }, `appended to #${target.id}`)
  }
  if (input.action === 'remove') {
    if (ctx.agent !== null && target.agent !== ctx.agent) {
      const who = target.agent === null ? 'the main agent' : 'another agent'
      return { deny: `#${target.id} was filed by ${who}; only ${target.agent === null ? 'it' : 'that agent'} can remove it` }
    }
    return { store: { ...store, items: store.items.filter(it => it.id !== target.id) }, reply: `removed #${target.id}`, added: null, changed: null }
  }
  if (input.options !== undefined && target.yesno) return { deny: `#${target.id} is a yes/no question: it takes no options` }
  if (input.doneLabel !== undefined && (target.yesno || target.options.length > 0)) {
    return { deny: `#${target.id} is a yes/no question or a decision: its buttons say what a press means, so it takes no done label` }
  }
  if (input.options !== undefined && target.doneLabel !== null) {
    return { deny: `#${target.id} has a done label: it is a to-do, which takes no options; clear the label first with done: ''` }
  }
  return withTerm(change(store, target, {
    ...target,
    title: input.title ?? target.title,
    detail: input.detail ?? target.detail,
    blocking: input.blocking ?? target.blocking,
    note: input.note !== undefined ? input.note : target.note,
    options: input.options ?? target.options,
    doneLabel: input.doneLabel !== undefined ? input.doneLabel : target.doneLabel,
  }, `updated #${target.id}`), input.term, ctx)
}

// The item the pane shows: the selected one, or with no selection the first. A selection whose item is gone names none; the pane
// moves on when its item is removed (successorOf), and that move writes the selection, so the lookup stays exact.
export const selectedItem = (items: readonly Item[], selected: number | null): Item | undefined =>
  selected === null ? items[0] : items.find(it => it.id === selected)

// The item the pane moves to when the one it shows leaves the actionable set (removed, or its press's window ended and it was sent): the
// first open item with a higher id, else the last open one. Undefined when none is open.
export const successorOf = (items: readonly Item[], removed: number): Item | undefined => {
  const open = items.filter(it => it.state === 'open')
  return open.find(it => it.id > removed) ?? open[open.length - 1]
}

// Empties the list and keeps the id counter: an id is never handed out twice, even across /clear. The term goes with the items.
export const clearAll = (store: Store): Store => ({ items: [], next: store.next, term: null })

// Carries the id counter a /clear saved in the plugin store into the new session. The store is the plugin's own JSON, so
// anything but a whole number from 1 is no saved counter; the counter never goes down.
export const carryNext = (store: Store, saved: unknown): Store => {
  const next = typeof saved === 'number' && Number.isInteger(saved) && saved >= 1 ? saved : 1
  return { ...store, next: Math.max(store.next, next) }
}

// Joins the list rebuilt from a transcript with the list as it stands. The transcript decides every item whose id it
// handed out (`known`, on any branch): kept as replayed, or gone if the replay dropped it. An item it does not know was
// added after the transcript was read, and stays. The counter never goes down. A term the main agent stated live is kept, a cleared one ('')
// included; the rebuilt term fills only a list on which none was stated (null).
export const mergeRestored = (live: Store, replayed: Store, known: readonly number[]): Store => {
  const decided = new Set([...known, ...replayed.items.map(it => it.id)])
  const added = live.items.filter(it => !decided.has(it.id))
  return { items: [...replayed.items, ...added], next: Math.max(live.next, replayed.next), term: live.term ?? replayed.term }
}

// A line break as the tool row's `^` takes one: a carriage return, a line feed, a Unicode line or paragraph separator, or a CRLF pair as one.
export const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/

// An entry's text as `list` prints it: its first line as it is, and every later line indented, so no later line of an entry reads as an item's
// header in the tool row's count (ui.ts). Each break is printed as a line feed.
const entryLines = (text: string): string[] => {
  const [first = '', ...rest] = text.split(LINE_BREAK)
  return [first, ...rest.map(line => `  ${line}`)]
}

export const listText = (items: readonly Item[]): string => {
  if (items.length === 0) return 'no items'
  return items
    .map(it => {
      const detail = it.detail === '' ? '' : ` - ${it.detail}`
      const note = it.note === null ? '' : ` (note: ${it.note})`
      const header = `#${it.id} ${it.blocking ? 'blocking' : 'non-blocking'}, ${it.state}: ${it.title}${detail}${note}`
      // Each turn is labelled with who spoke, and its lines are indented as the header's later lines are.
      return [...entryLines(header), ...turnsOf(it).flatMap(turn => entryLines(`  ${labelOf(turn)}: ${turn.words}`))].join('\n')
    })
    .join('\n')
}
