import { atom, read, update, type EngineInterface, type PaneCloseOrigin } from 'claude-code'
import type { Item } from '../types'
import { successorOf, type Outcome } from './items'
import { inBackground, updateList } from './shared'
import { paneRows } from './ui'

export const PANE = 'human-items'
// The item the pane shows (null until a press picks one). A drawing reads it, so it lives in the state, not a module variable.
const SELECTION = { plugin: 'human-plugin', key: 'selection' } as const
const selection = atom(SELECTION, null as number | null)
// Read here, beside its atom: the engine's scan reads a state source only from the file that declares it.
async function readSelection($: EngineInterface): Promise<number | null> {
  return read($, selection)
}

// Whether the pane is open, as the mod last knows it. Set when its open is made; cleared by its own close when that is made
// (closePane), by a close it hears that it did not make (personClosed), and by a session's end (endPane). A band draw resyncs it from the engine's record of the pane
// (syncPane). The press decides on it synchronously, because the open must be made inside the press: an open made after an await is
// not counted as asked, and below 144 columns the pane then waits undrawn.
let paneOpen = false
// The open the mod has made and the engine has not settled yet: the engine's record does not list the pane until it settles.
let pendingOpen = false
// The list the surface drew last, from the band or the pane, which a press reads synchronously when it opens or resizes the pane
// (see openPane). The surface redraws on each change, so this is at most one draw behind the list.
let drawnItems: readonly Item[] = []
// The item the pane shows as the mod last set it (a press or a move), set before its selection write is awaited, so a read that
// follows a press sees it while the write is in flight. Null until a press or move sets one this session.
let shownItem: number | null = null

// Each draw records the list it drew (drawnItems).
export const setDrawn = (items: readonly Item[]): void => {
  drawnItems = items
}

// The engine's record of the pane, which is what an unload leaves behind without a ui.close the mod hears. Not read while an open
// the mod made is still unsettled, since the record does not list that pane yet.
export async function syncPane($: EngineInterface): Promise<void> {
  if (!pendingOpen) paneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
}

// A close of the pane the mod hears that it did not make: the person's.
export const personClosed = (id: string, origin: PaneCloseOrigin['kind']): void => {
  // The mod's own close ('plugin') cleared the flag when it was made; its late report must not undo an open made since.
  if (id === PANE && origin !== 'plugin') paneOpen = false
}

// The pane's request for `id` shown: its rows come from `items` (the list last drawn, or the list a tool call has just written)
// and the item's box, and every open sets them anew.
const paneRequest = (id: number, items: readonly Item[]) => ({ id: PANE, title: 'Items for you', rows: paneRows(items.find(it => it.id === id)), focus: true as const })

// The first thing a press does is open the pane: a press is only counted as asked while it is still running. The pane asks for
// rows, so an inline pane is tall enough for a brief (left out, it is a third of the screen), and for the keyboard, so its
// scroll keys work; the surface grants the keyboard only over an empty composer. The open is made inside the press, before any
// read could settle, so its rows are taken from the list last drawn.
function openPane($: EngineInterface, id: number): Promise<unknown> {
  paneOpen = true
  pendingOpen = true
  const opened = $.ui.open(paneRequest(id, drawnItems)).finally(() => {
    pendingOpen = false
  })
  const cleared = updateList($, store => ({ ...store, items: store.items.map(it => ({ ...it, unread: false })) }))
  return Promise.all([opened, cleared])
}

// A switch while the pane is open re-opens it, so its rows fit the item shown now, and reads that item.
function switchPane($: EngineInterface, id: number, items: readonly Item[]): Promise<unknown> {
  return Promise.all([$.ui.open(paneRequest(id, items)), markRead($, id)])
}

// The pane shows one item and follows it. It moves to the item's successor (successorOf, an open item only), with that item's rows, and
// the selection moves with it so the band and the pane agree; with no open item left, the pane closes. Two triggers: a tool call that
// removes the shown item (followShown), and a window that ends by sending the shown item (followSent). A sent item the person views
// stays shown until one of those. Never from a draw, since a draw may not write state (the host refuses it).
function moveOn($: EngineInterface, items: readonly Item[], leaving: number): void {
  const next = successorOf(items, leaving)
  if (next === undefined) inBackground($, closePane($))
  else inBackground($, Promise.all([switchPane($, next.id, items), select($, next.id)]))
}

// Selects `id`: it is shown at once (shownItem), and its selection write follows. A write that fails drops the item the mod set, unless
// another press or move has set one since, so the draw falls back to the stored selection. A refused write changes no state, so nothing
// would redraw the surfaces drawn on the pressed item: the drop asks for the redraw itself. A write that another beat is tried again
// (update) with the item shown by then, so when two presses' writes land out of order, the later press is what is saved.
function select($: EngineInterface, id: number): Promise<unknown> {
  shownItem = id
  return update($, selection, () => shownItem ?? id).catch((err: unknown) => {
    if (shownItem === id) {
      shownItem = null
      $.ui.invalidate('ui.render')
    }
    throw err
  })
}

// The item the surfaces draw as shown: the one the mod last set, else the stored selection's. The band and the pane read it, so they
// agree with shownId before a selection write lands. The stored selection is read either way, so a drawing stays subscribed to it.
export async function shownSelection($: EngineInterface): Promise<number | null> {
  const stored = await readSelection($)
  return shownItem ?? stored
}

// The item the pane shows: the shown selection's, or with none the first of the list last drawn, as the draw picks it (selectedItem). It is
// read at a tool call or a window's end, which may not draw, so the list drawn last is the one the pane was made from.
async function shownId($: EngineInterface): Promise<number | undefined> {
  return (await shownSelection($)) ?? drawnItems[0]?.id
}

// After a tool call: an empty list closes the pane, whatever it last showed. Otherwise the pane moves on only when its item has left
// the list. A sent item the person is viewing stays, and a change to the item shown re-asks its rows as a switch does: a reopen adds the
// reply field's row, which the pane's request did not count, and the item is being looked at, so it is read.
export async function followShown($: EngineInterface, out: Exclude<Outcome, { deny: string }>): Promise<void> {
  if (!paneOpen) return
  const items = out.store.items
  if (items.length === 0) {
    inBackground($, closePane($))
    return
  }
  const shown = await shownId($)
  // Checked after the read: the person may have closed the pane meanwhile, and a move would then reopen it.
  if (!paneOpen || shown === undefined) return
  if (!items.some(it => it.id === shown)) moveOn($, items, shown)
  else if (out.changed?.id === shown) inBackground($, switchPane($, shown, items))
}

// After a window ends and sends `id`: the pane moves on only when it shows that item.
export async function followSent($: EngineInterface, items: readonly Item[], id: number): Promise<void> {
  const shown = await shownId($)
  if (!paneOpen || shown !== id) return
  moveOn($, items, id)
}

// Shows an item in the pane: the pane opens first when it is shut (the open is made inside the press), then the item is selected.
// Showing an item reads it: the pane's open reads every item, and a switch reads the one it shows.
export function showItem($: EngineInterface, id: number): Promise<unknown> {
  const opening = paneOpen ? switchPane($, id, drawnItems) : openPane($, id)
  return Promise.all([opening, select($, id)])
}

// Marks one item read: an item the pane switches to is shown, so its unread mark goes.
function markRead($: EngineInterface, id: number): Promise<unknown> {
  return updateList($, store => ({ ...store, items: store.items.map(it => (it.id === id ? { ...it, unread: false } : it)) }))
}

// The flag clears before the close is awaited: an open made while the close is in flight counts as open, and the close's settling
// must not clear it.
async function closePane($: EngineInterface): Promise<void> {
  paneOpen = false
  // A close another plugin refuses leaves the pane open, so the flag goes back to open.
  await $.ui.close({ id: PANE }).catch((err: unknown) => {
    paneOpen = true
    throw err
  })
}

// A press on the item the pane shows closes the pane; a press on any other item shows it.
export function pickItem($: EngineInterface, id: number, isSelected: boolean): Promise<unknown> {
  return paneOpen && isSelected ? closePane($) : showItem($, id)
}

// A session's end: the flag clears, and a /clear closes an open pane first, since its item leaves with the list and the pane must not stay
// open on nothing.
export function endPane($: EngineInterface, clear: boolean): void {
  const wasOpen = paneOpen
  paneOpen = false
  shownItem = null
  if (clear && wasOpen) inBackground($, closePane($))
}
