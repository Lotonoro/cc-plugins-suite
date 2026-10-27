import type { Item, ItemOption, ItemState, Store } from '../types'

export const PLUGIN = 'human-plugin'
export const TOOL = 'mcp__human-plugin__human_items'
export const EMPTY: Store = { items: [], next: 1 }

const STATES: readonly ItemState[] = ['open', 'done-waiting', 'done-pending']

// One option as stored. An entry with no label is no option, and is dropped.
const optionOf = (raw: unknown): ItemOption | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.label !== 'string' || r.label === '') return null
  return { label: r.label, description: typeof r.description === 'string' ? r.description : '', recommended: r.recommended === true }
}

// One item as stored, with every field the current release reads filled in: a list an older release wrote lacks the fields added
// since, and a field of the wrong type takes its default. Null when the item has no id (a whole number from 1) or no title.
export const normalizeItem = (raw: unknown): Item | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id < 1 || typeof r.title !== 'string') return null
  const pressedAt = typeof r.pressedAt === 'number' && Number.isFinite(r.pressedAt) ? r.pressedAt : null
  const stored = STATES.find(s => s === r.state) ?? 'open'
  return {
    id: r.id,
    title: r.title,
    detail: typeof r.detail === 'string' ? r.detail : '',
    blocking: r.blocking === true,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
    // An undo window with no press time cannot end, so the item was never pressed: it is open.
    state: stored === 'done-waiting' && pressedAt === null ? 'open' : stored,
    pressedAt,
    note: typeof r.note === 'string' ? r.note : null,
    agent: typeof r.agent === 'string' ? r.agent : null,
    unread: r.unread === true,
    options: Array.isArray(r.options) ? r.options.map(optionOf).filter((o): o is ItemOption => o !== null) : [],
    yesno: r.yesno === true,
    answer: typeof r.answer === 'string' ? r.answer : null,
    replied: r.replied === true,
    doneLabel: typeof r.doneLabel === 'string' ? r.doneLabel : null,
  }
}

// The whole list as stored: its items normalized (the garbage ones dropped), and the id counter kept at least one above the highest
// id, so an id is never handed out twice.
export const normalizeStore = (raw: unknown): Store => {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const items = Array.isArray(r.items) ? r.items.map(normalizeItem).filter((it): it is Item => it !== null) : []
  const highest = items.reduce((max, it) => Math.max(max, it.id), 0)
  const saved = typeof r.next === 'number' && Number.isInteger(r.next) && r.next >= 1 ? r.next : 1
  return { items, next: Math.max(saved, highest + 1) }
}

export type ToolInput =
  | { action: 'add'; title: string; detail: string; blocking: boolean; options: ItemOption[]; yesno: boolean; doneLabel: string | null }
  | { action: 'update'; id: number; title?: string; detail?: string; blocking?: boolean; note?: string | null; options?: ItemOption[]; doneLabel?: string | null }
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

// The label a plain to-do's ✓ carries: what a press means, one line (whitespace is drawn as a space). Undefined when none was given, and
// null when an update's `done: ''` clears it. A yes/no or a decision says what each press means in its own buttons, so it takes none.
const parseDone = (raw: unknown, decision: boolean, clear: boolean): { ok: true; value: string | null | undefined } | { ok: false; reason: string } => {
  if (raw === undefined) return { ok: true, value: undefined }
  if (decision) return { ok: false, reason: 'done is for a to-do: a yes/no or a decision already says what each press means' }
  if (typeof raw !== 'string') return { ok: false, reason: 'done must be text' }
  const label = raw.replace(/\s+/g, ' ').trim()
  if (label === '') return clear ? { ok: true, value: null } : { ok: false, reason: 'done needs a label, e.g. "Go with sqlite"' }
  if (columns(label) > DONE_MAX) return { ok: false, reason: `done must be at most ${DONE_MAX} columns: name what a press does in a few words` }
  return { ok: true, value: label }
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
          detail: text(r.detail) ?? '',
          blocking: r.blocking === true,
          options: options.value ?? [],
          yesno: r.yesno === true,
          doneLabel: done.value ?? null,
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
        if (text(r.detail) === undefined) return { ok: false, reason: 'detail must be text' }
        value.detail = text(r.detail)
      }
      if (r.blocking !== undefined) {
        if (typeof r.blocking !== 'boolean') return { ok: false, reason: 'blocking must be true or false' }
        value.blocking = r.blocking
      }
      if (r.note !== undefined) {
        const note = text(r.note)
        if (note === undefined) return { ok: false, reason: 'note must be text' }
        // A blank note clears the note, as a blank done label clears the label (parseDone).
        value.note = note.trim() === '' ? null : note
      }
      if (r.options !== undefined) {
        const options = parseOptions(r.options)
        if (!options.ok) return options
        value.options = options.value
      }
      const done = parseDone(r.done, r.options !== undefined, true)
      if (!done.ok) return done
      if (done.value !== undefined) value.doneLabel = done.value
      if (value.title === undefined && value.detail === undefined && value.blocking === undefined && value.note === undefined && value.options === undefined && value.doneLabel === undefined) {
        return { ok: false, reason: 'update changes nothing: give a title, detail, blocking, note, options or done' }
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

export type Outcome =
  | { deny: string }
  | { store: Store; reply: string; added: Item | null }

export const act = (store: Store, input: ToolInput, ctx: Ctx): Outcome => {
  if (input.action === 'list') return { store, reply: listText(store.items), added: null }
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
    }
    return { store: { items: [...store.items, item], next: store.next + 1 }, reply: `added #${item.id}`, added: item }
  }
  const target = store.items.find(it => it.id === input.id)
  if (target === undefined) return { deny: `no item #${input.id}` }
  if (input.action === 'append') {
    const detail = target.detail === '' ? input.text : `${target.detail}\n\n${input.text}`
    const items = store.items.map(it => (it.id === target.id ? { ...it, detail } : it))
    return { store: { ...store, items }, reply: `appended to #${target.id}`, added: null }
  }
  if (input.action === 'remove') {
    if (ctx.agent !== null && target.agent !== ctx.agent) {
      const who = target.agent === null ? 'the main agent' : 'another agent'
      return { deny: `#${target.id} was filed by ${who}; only ${target.agent === null ? 'it' : 'that agent'} can remove it` }
    }
    return { store: { ...store, items: store.items.filter(it => it.id !== target.id) }, reply: `removed #${target.id}`, added: null }
  }
  if (input.options !== undefined && target.yesno) return { deny: `#${target.id} is a yes/no question: it takes no options` }
  if (input.doneLabel !== undefined && (target.yesno || target.options.length > 0)) {
    return { deny: `#${target.id} is a yes/no question or a decision: its buttons say what a press means, so it takes no done label` }
  }
  if (input.options !== undefined && target.doneLabel !== null) {
    return { deny: `#${target.id} has a done label: it is a to-do, which takes no options; clear the label first with done: ''` }
  }
  const changed: Item = {
    ...target,
    title: input.title ?? target.title,
    detail: input.detail ?? target.detail,
    blocking: input.blocking ?? target.blocking,
    note: input.note !== undefined ? input.note : target.note,
    options: input.options ?? target.options,
    doneLabel: input.doneLabel !== undefined ? input.doneLabel : target.doneLabel,
    // A note of text reopens a done item; a clear does not.
    state: input.note !== undefined && input.note !== null && target.state !== 'open' ? 'open' : target.state,
  }
  const unchanged =
    changed.title === target.title &&
    changed.detail === target.detail &&
    changed.blocking === target.blocking &&
    changed.note === target.note &&
    changed.state === target.state &&
    changed.doneLabel === target.doneLabel &&
    JSON.stringify(changed.options) === JSON.stringify(target.options)
  if (unchanged) return { store, reply: `no change to #${target.id}`, added: null }
  if (changed.state === 'open') {
    changed.pressedAt = null
    changed.answer = null
    changed.replied = false
  }
  const items = store.items.map(it => (it.id === target.id ? changed : it))
  return { store: { ...store, items }, reply: `updated #${target.id}`, added: null }
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

// Empties the list and keeps the id counter: an id is never handed out twice, even across /clear.
export const clearAll = (store: Store): Store => ({ items: [], next: store.next })

// Carries the id counter a /clear saved in the plugin store into the new session. The store is the plugin's own JSON, so
// anything but a whole number from 1 is no saved counter; the counter never goes down.
export const carryNext = (store: Store, saved: unknown): Store => {
  const next = typeof saved === 'number' && Number.isInteger(saved) && saved >= 1 ? saved : 1
  return { ...store, next: Math.max(store.next, next) }
}

// Joins the list rebuilt from a transcript with the list as it stands. The transcript decides every item whose id it
// handed out (`known`, on any branch): kept as replayed, or gone if the replay dropped it. An item it does not know was
// added after the transcript was read, and stays. The counter never goes down.
export const mergeRestored = (live: Store, replayed: Store, known: readonly number[]): Store => {
  const decided = new Set([...known, ...replayed.items.map(it => it.id)])
  const added = live.items.filter(it => !decided.has(it.id))
  return { items: [...replayed.items, ...added], next: Math.max(live.next, replayed.next) }
}

export const listText = (items: readonly Item[]): string => {
  if (items.length === 0) return 'no items'
  return items
    .map(it => {
      const detail = it.detail === '' ? '' : ` - ${it.detail}`
      const note = it.note === null ? '' : ` (note: ${it.note})`
      return `#${it.id} ${it.blocking ? 'blocking' : 'non-blocking'}, ${it.state}: ${it.title}${detail}${note}`
    })
    .join('\n')
}
