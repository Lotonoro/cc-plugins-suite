import type { EngineInterface, PaneCloseOrigin } from 'claude-code'

// The details pane: its flag, the open, close and re-open the footer's presses and the tick make, and the note on an open that failed.
// A press decides on the flag synchronously, because the open must be made inside the press: an open made after an await is not counted
// as asked, and below 144 columns the pane then waits undrawn.

export const PANE = 'cachier-details'
const PANE_TITLE = 'Prompt cache'
const PANE_FAILED = 'the details pane did not open; see the debug log'

// The rows and columns the pane asks for: one row per line, and the columns of the longest.
export type PaneSize = { rows: number; columns: number }

// Whether the pane is open, as the mod last knows it. Set when its open is made; cleared by its own close, and by a close the mod hears
// that it did not make (`closedPane`). A reload loses this, so the engine's record is read once at session.start (`syncPane`).
let paneOpen = false
// The size the pane was last opened at; null when it is open but its size is not known (after a sync).
let paneSize: PaneSize | null = null
// Why the last open failed, named on the status line until an open lands.
let failure: string | null = null

export const isPaneOpen = (): boolean => paneOpen
export const paneAlarm = (): string | null => failure

// The engine's record of the pane, read once at a session's start: a reload keeps the pane, and the flag says so.
export async function syncPane($: EngineInterface): Promise<void> {
  paneOpen = (await $.ui.panes()).some((pane) => pane.id === PANE)
  paneSize = null
}

// A close the mod hears (`origin`, as the engine stamps it): the flag clears for the pane's id. The mod's own close ('plugin') cleared it
// when it was made, and an open made since must not be undone by the report of that earlier close.
export function closedPane(id: string, origin: PaneCloseOrigin['kind']): void {
  if (id === PANE && origin !== 'plugin') paneOpen = false
}

// The open, made at once: the flag is set before the open is awaited, so a press made while it runs is counted as an open of a pane already
// open. A failure, or an open the engine does not place, clears the flag and is named until an open lands.
function openAt($: EngineInterface, size: PaneSize): Promise<unknown> {
  paneOpen = true
  paneSize = size
  return $.ui
    .open({ id: PANE, title: PANE_TITLE, ...size, closeOnEscape: true })
    .then((r) => {
      if (!r.isPlaced) throw new Error(`the details pane was not placed: ${r.reason}`)
      failure = null
    })
    .catch((err: unknown) => {
      paneOpen = false
      paneSize = null
      failure = PANE_FAILED
      throw err
    })
}

// The close: the flag clears before the close is awaited, so an open made while it runs counts as open.
function closePane($: EngineInterface): Promise<unknown> {
  paneOpen = false
  paneSize = null
  // A close that is refused leaves the pane open, so the flag goes back to open, its size unknown.
  return $.ui.close({ id: PANE }).catch((err: unknown) => {
    paneOpen = true
    throw err
  })
}

// A press on the details: a shut pane opens at `size`, an open one closes.
export function togglePane($: EngineInterface, size: PaneSize): Promise<unknown> {
  return paneOpen ? closePane($) : openAt($, size)
}

// The pane's size after a change of its lines: an open pane is re-opened at `size` when that differs from its last size, or its size is not
// known; a shut one is left shut.
export function resizePane($: EngineInterface, size: PaneSize): Promise<unknown> {
  if (!paneOpen) return Promise.resolve()
  if (paneSize !== null && paneSize.rows === size.rows && paneSize.columns === size.columns) return Promise.resolve()
  return openAt($, size)
}
