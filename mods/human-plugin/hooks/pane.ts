import { atom, read, update, type EngineInterface, type PaneCloseOrigin, type PaneOpenArgs } from 'claude-code'
import type { Item, Selection, TodoItem } from '../types'
import { nextItem, poseItem, selectedItem, type Outcome } from './items'
import { inBackground, readList, updateList } from './shared'
import { HEADING, headingOf, readName, readTodo } from './todo'
import { backlogRows, paneRows } from './ui'

export const PANE = 'human-items'
// The pane has one id and two views: a human item, or the Claude list (the backlog). The stored selection says which, and a press sets it.
export const CLAUDE_VIEW = 'claude-todo'
// What the pane shows: an item's number, the Claude list, or null for none, which shows the first human item in the ranking (selectedItem). A drawing reads it, so it lives in the state, not a module variable.
const SELECTION = { plugin: 'human-plugin', key: 'selection' } as const
const selection = atom(SELECTION, null as Selection)
// Read here, beside its atom: the engine's scan reads a state source only from the file that declares it. Every stored value reads: an item number or the Claude list as it is,
// any other value as null.
async function readSelection($: EngineInterface): Promise<Selection> {
  const stored: unknown = await read($, selection)
  return stored === CLAUDE_VIEW || (typeof stored === 'number' && Number.isInteger(stored) && stored > 0) ? stored : null
}

// What a press or a move sets: an item to show, or the Claude list.
type Shown = Exclude<Selection, null>

// Whether the pane is open, as the mod last knows it. Set when its open is made; cleared by its own close when that is made
// (closePane), by a close it hears that it did not make (personClosed), and by a session's end (endPane). A band draw resyncs it from the engine's record of the pane
// (syncPane). The press decides on it synchronously, because the open must be made inside the press: an open made after an await is
// not counted as asked, and below 144 columns the pane then waits undrawn.
let paneOpen = false
// The open the mod has made and the engine has not settled yet: the engine's record does not list the pane until it settles.
let pendingOpen = false
// The surfaces whose pane draw has reported a dock (the `Pane` render's `placement`) since the pane was opened from closed, by the surface name the render
// carries. Only a draw says: the engine's pane list does not, and a session may draw on several surfaces. A report of another placement leaves a surface
// as it is, so within one opening a surface only goes from unseen to seen. The records outlive a close and reset on the next open from closed (openPane).
const docks = new Set<string>()
// The human list the surface drew last, from the band or the item view, and the Claude view the band or the backlog drew last: the whole stored Claude list it read (not only the rows it drew,
// which the band may limit to the column's header, in-flight rows and queued line) and the heading it read with it, as one record, so a press opens the pane on one draw's list under that
// draw's heading. A press reads them synchronously when it opens or resizes the pane (see openPane). The surface redraws on each change, so each is at most one draw behind its list.
type ClaudeView = { todo: readonly TodoItem[]; heading: string }
let drawnItems: readonly Item[] = []
let drawnClaude: ClaudeView = { todo: [], heading: HEADING }
// What the pane shows as the mod last set it (a press or a move), set before its selection write is awaited, so a read that follows a press sees it while the write is
// in flight. Null until a press or move sets one this session.
let shownPick: Shown | null = null
// The stored selection the last read of the shown selection returned (shownSelection): where a press looks while no press or move has set shownPick, as after a
// reload with the pane open.
let lastRead: Selection = null
// What the backlog last asked the pane for (recordAsked): the number of items it asked rows for and the heading it asked as the title, as one value, so a call that keeps both asks for
// nothing (followTodo). Null until the backlog asks, as after a reload, and after an open the pane refused.
type Asked = { items: number; heading: string }
let asked: Asked | null = null

// Each draw records what it drew (drawnItems, drawnClaude). The Claude view takes the heading of `name`, the name the agent stated, which is the empty text where it stated none.
export const setDrawn = (items: readonly Item[]): void => {
  drawnItems = items
}
export const setDrawnTodo = (todo: readonly TodoItem[], name: string): void => {
  drawnClaude = { todo, heading: headingOf(name) }
}

// Whether a band drawn on `surface` sits beside this plugin's pane docked: the pane is open and a draw of it on that surface has reported a dock since it was
// opened from closed. Derived from the open flag and the records, so each way the pane stops being open ends the dock with no edit here. Another plugin's
// docked pane is not seen, and a pane open on a surface that has not drawn it as a dock is not counted docked.
export const paneDocked = (surface: string): boolean => paneOpen && docks.has(surface)

// The Pane draw's report of where its `surface` seated the pane. The band's width rule turns on the answer, and the engine does not draw a band again when
// only the pane's placement changes, so a report that changes what paneDocked answers for that surface asks for a redraw, and a report that changes nothing
// asks for none, which is what ends the redraws.
export function seated($: EngineInterface, surface: string, placement: 'dock' | 'inline'): void {
  const was = paneDocked(surface)
  if (placement === 'dock') docks.add(surface)
  if (paneDocked(surface) !== was) $.ui.invalidate('ui.render')
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

// The item view's request for `id` shown: its rows come from `items` (the list last drawn, or the list a tool call has just written)
// and the item's box, and every open sets them anew.
const paneRequest = (id: number, items: readonly Item[]): PaneOpenArgs => ({ id: PANE, title: 'Items for you', rows: paneRows(items.find(it => it.id === id)), focus: true })

// The backlog's request for `view`: the Claude list's heading as the title, a row for its header and one for each item, and the keyboard, so a list taller than the pane scrolls.
const backlogRequest = ({ todo, heading }: ClaudeView): PaneOpenArgs => ({ id: PANE, title: heading, rows: backlogRows(todo), focus: true })

// Records what the backlog asks of the pane for `view` (asked) as the open is made, so a call that follows while the open is in flight is compared with what it asked for.
// An open the pane refuses leaves the pane with rows and a title the record does not name, so the record is forgotten and the next call asks again, unless a later ask has replaced it;
// the failure itself is left to the caller's catch.
function recordAsked({ todo, heading }: ClaudeView, opening: Promise<unknown>): Promise<unknown> {
  const ask = { items: todo.length, heading }
  asked = ask
  return opening.catch((err: unknown) => {
    if (asked === ask) asked = null
    throw err
  })
}

// The first thing a press does is open the pane: a press is only counted as asked while it is still running. The pane asks for
// rows, so an inline pane is tall enough for its view (left out, it is a third of the screen), and for the keyboard, so its
// scroll keys work; the surface grants the keyboard only over an empty composer. The open is made inside the press, before any
// read could settle, so its rows are taken from the lists last drawn.
function openPane($: EngineInterface, request: PaneOpenArgs): Promise<unknown> {
  paneOpen = true
  pendingOpen = true
  // The surface may seat the pane elsewhere than it last did (the terminal's width has changed): until it draws, it is not counted docked.
  docks.clear()
  return $.ui.open(request).finally(() => {
    pendingOpen = false
  })
}

// A switch while the pane is open re-opens it, so its rows fit the item shown now, and reads that item.
function switchPane($: EngineInterface, id: number, items: readonly Item[]): Promise<unknown> {
  return Promise.all([$.ui.open(paneRequest(id, items)), markRead($, id)])
}

// The pane shows one item and follows it. When the shown item is removed or its answer is sent, the pane moves to the next item (nextItem, an open item only), with that item's
// rows, and the selection moves with it so the band and the pane agree; with no open item left, the pane closes. Two triggers: a tool call that removes the shown item
// (followShown), and a window's end that sends it or finds it gone (followSent). A sent item the person opens by a press stays shown until it is removed. Never from a draw,
// since a draw may not write state (the host refuses it).
function moveOn($: EngineInterface, items: readonly Item[]): void {
  const next = nextItem(items)
  if (next === undefined) inBackground($, closePane($))
  else inBackground($, Promise.all([switchPane($, next.id, items), select($, next.id)]))
}

// Selects `view`: it is shown at once (shownPick), and its selection write follows. A write that fails drops the view the mod set, unless
// another press or move has set one since, so the draw falls back to the stored selection. A refused write changes no state, so nothing
// would redraw the surfaces drawn on the pressed view: the drop asks for the redraw itself. A write that another beat is tried again
// (update) with the view shown by then, so when two presses' writes land out of order, the later press is what is saved.
function select($: EngineInterface, view: Shown): Promise<unknown> {
  shownPick = view
  return update($, selection, () => shownPick ?? view).catch((err: unknown) => {
    if (shownPick === view) {
      shownPick = null
      $.ui.invalidate('ui.render')
    }
    throw err
  })
}

// What the pane draws as shown: the view the mod last set, else the stored selection. The pane's draw reads it, so it agrees with the follow-ups before a selection write
// lands; the band's draw reads it too, only for the record it keeps. The stored selection is read either way, so a drawing stays subscribed to it, and what it read is kept for a press to look at (lastRead).
export async function shownSelection($: EngineInterface): Promise<Selection> {
  lastRead = await readSelection($)
  return shownPick ?? lastRead
}

// What the pane shows, for a follow-up, which reads it afresh: the Claude list, an item's number, or with no selection the first item in the ranking of the human list last drawn,
// as the draw picks it (selectedItem). It is read at a tool call or a window's end, which may not draw, so the list drawn last is the one the pane was made from.
async function shownView($: EngineInterface): Promise<Shown | undefined> {
  return (await shownSelection($)) ?? selectedItem(drawnItems, null)?.id
}

// What a press decides on, with no await: the view the mod last set, else the stored selection its draws last read. The same fall back as shownView.
const shownNow = (): Shown | undefined => shownPick ?? lastRead ?? selectedItem(drawnItems, null)?.id

// After a tool call on the human list: an empty list closes the pane, whatever item it last showed. Otherwise the pane moves on only when its item has left
// the list. A sent item the person is viewing stays. A change to the item shown re-asks its rows as a switch does, and reads it: its rows
// follow the brief's length, so a change that does not reopen the item needs the re-ask too; a reopen adds the reply field's row. While the pane shows the Claude
// list none of this applies, an emptied human list included: the list is no ask for the person to act on, and a move would take the pane off it.
export async function followShown($: EngineInterface, out: Exclude<Outcome, { deny: string }>): Promise<void> {
  if (!paneOpen) return
  const shown = await shownView($)
  // Checked after the read: the person may have closed the pane meanwhile, and a move would then reopen it.
  if (!paneOpen || shown === CLAUDE_VIEW) return
  const items = out.store.items
  if (items.length === 0) {
    inBackground($, closePane($))
    return
  }
  if (shown === undefined) return
  if (!items.some(it => it.id === shown)) moveOn($, items)
  else if (out.changed?.id === shown) inBackground($, switchPane($, shown, items))
}

// After a window ends and sends `id`, the pane that shows that item moves on as it does when the item is removed, whatever kind of answer was sent: to the first open item in the
// ranking, or it closes when none is open (an item in its own undo window is not open, its answer being given). The list is read here, after the shown item, since a change made after
// the end wrote the item sent may have changed what the item is: an item open again (an agent turn or an update the window took reopened it: done.ts, expire) keeps the pane on it,
// with its rows asked again as a change asks them; an item back in an undo window (reopened, then pressed again) leaves the pane as it is, for that window's own end to decide; an item
// the agent removed moves the pane on, as a sent one does. A pane on another item, or on the Claude list, is left alone.
export async function followSent($: EngineInterface, id: number): Promise<void> {
  const shown = await shownView($)
  const { items } = await readList($)
  // Checked after the reads: the person may have closed the pane meanwhile, and a move would then reopen it.
  if (!paneOpen || shown !== id) return
  const current = items.find(it => it.id === id)
  if (current === undefined || current.state === 'done-pending') moveOn($, items)
  else if (current.state === 'open') inBackground($, switchPane($, id, items))
}

// After a call that writes the Claude list or its name, while the pane shows the list: it reads the list and the heading as stored now. An empty list closes the pane, as an empty
// human list closes an item's view. Otherwise the pane asks for its rows and title again only when the number of items or the heading differs from what it last asked, so a call that
// keeps both leaves the pane, and where it is scrolled, alone. The pane's draw reads the stored list and name itself. Called inside the tool's call, so two calls' follow-ups never land out of order.
export async function followTodo($: EngineInterface): Promise<void> {
  if (!paneOpen) return
  const todo = await readTodo($)
  const heading = headingOf(await readName($))
  const shown = await shownView($)
  // Checked after the reads: the person may have closed the pane meanwhile, and a re-ask would then reopen it.
  if (!paneOpen || shown !== CLAUDE_VIEW) return
  if (todo.length === 0) inBackground($, closePane($))
  else if (todo.length !== asked?.items || heading !== asked.heading) inBackground($, recordAsked({ todo, heading }, $.ui.open(backlogRequest({ todo, heading }))))
}

// Shows an item in the pane: the pane opens first when it is shut (the open is made inside the press), then the item is selected.
// Showing an item reads that item alone, whether the pane is shut or open: an open from closed and a switch both read the one they show.
export function showItem($: EngineInterface, id: number): Promise<unknown> {
  const opening = paneOpen ? switchPane($, id, drawnItems) : Promise.all([openPane($, paneRequest(id, drawnItems)), markRead($, id)])
  return Promise.all([opening, select($, id)])
}

// Shows the Claude list in the pane, from the view last drawn: opened from closed, or the open pane switched to it. It shows no human item, so it reads none.
// The view drawn last is at most one draw behind, and a call made since asked the pane nothing while it did not show the list. So once the open has settled, the pane follows
// the stored list and name as it follows a call (followTodo): it asks again when the count or the heading has changed since, and closes on a list a write has emptied, where it would stay
// open on its header line alone.
function showBacklog($: EngineInterface): Promise<unknown> {
  const view = drawnClaude
  const opening = paneOpen ? $.ui.open(backlogRequest(view)) : openPane($, backlogRequest(view))
  const followed = recordAsked(view, opening).then(() => followTodo($))
  return Promise.all([followed, select($, CLAUDE_VIEW)])
}

// The item as printed, against the item now: the same content, the unread and posed marks aside (a clear changes the first and a walk's mark the second, and a print
// shows neither). Both are normalized (normalizeItem), so their keys come in one order and the JSON compares the content.
const sameContent = (now: Item, printed: Item): boolean =>
  JSON.stringify({ ...now, unread: false, posed: false }) === JSON.stringify({ ...printed, unread: false, posed: false })

// Marks one item read: an item the pane opens on from closed or switches to is shown, so its unread mark goes. `/todo <n>` passes the item as it printed it, and the mark
// goes only while the item is still that one: a change made since the print is not in the text, so the mark it raised stays.
export function markRead($: EngineInterface, id: number, printed?: Item): Promise<unknown> {
  return updateList($, store => ({
    ...store,
    items: store.items.map(it => (it.id === id && (printed === undefined || sameContent(it, printed)) ? { ...it, unread: false } : it)),
  }))
}

// Marks the item a walk showed posed (items.ts), in a write of its own. The mark goes only while the walk still owns its session and the item is still the one shown,
// both tested in the list update itself: a session that ends before the update runs leaves the list another session's, where an item of the same number and content
// would take the mark, and an item the agent changed meanwhile was not shown as it now reads, so it stays unposed. `shown` is the item as the walk read it.
export function markPosed($: EngineInterface, shown: Item, owns: () => boolean): Promise<unknown> {
  return updateList($, store => (owns() && store.items.some(it => it.id === shown.id && sameContent(it, shown)) ? poseItem(store, shown.id) : store))
}

// The flag clears before the close is awaited: an open made while the close is in flight counts as open, and the close's settling
// must not clear it.
async function closePane($: EngineInterface): Promise<void> {
  paneOpen = false
  // A close another plugin refuses leaves the pane open, so the flag goes back to open. The pane is where it was and the engine draws nothing again for it,
  // so the bands drawn since the flag cleared, which had no dock beside them, are asked to draw again when any surface has seen it docked.
  await $.ui.close({ id: PANE }).catch((err: unknown) => {
    paneOpen = true
    if (docks.size > 0) $.ui.invalidate('ui.render')
    throw err
  })
}

// A press on the item the pane shows closes the pane; a press on any other item shows it. The press decides on the mod's own records of what the pane shows (shownNow), not
// on the band's draw, so a second press that lands before the band draws again sees the first press's view.
export function pickItem($: EngineInterface, id: number): Promise<unknown> {
  return paneOpen && shownNow() === id ? closePane($) : showItem($, id)
}

// A press on the Claude column closes the pane when it shows the Claude list, and shows the list otherwise.
export function pickBacklog($: EngineInterface): Promise<unknown> {
  return paneOpen && shownNow() === CLAUDE_VIEW ? closePane($) : showBacklog($)
}

// A session's end: the flag and the records of what the pane shows clear, and the pane closes first when it is open on the Claude list, whatever ended the session: a resume
// rebuilds that list from its transcript, a writer the list's follow-up never sees, so the pane would hold rows for a list that no longer matches. A /clear closes an open pane
// whichever view it shows, since its item leaves with the list and the pane must not stay open on nothing. A pane on a human item otherwise stays.
export function endPane($: EngineInterface, clear: boolean): void {
  const closes = paneOpen && (clear || shownNow() === CLAUDE_VIEW)
  paneOpen = false
  shownPick = null
  lastRead = null
  asked = null
  if (closes) inBackground($, closePane($))
}
