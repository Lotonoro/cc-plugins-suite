import type { EngineInterface } from 'claude-code'
import { report } from './pricesync'
import { WRAP, type PaneRow, type PaneSize } from './sections'

// The details pane: its flag, the open, close and re-open the footer's presses and the tick make, the size its draw recorded, and the note on an open that failed.
// A press decides on the flag synchronously, because the open must be made inside the press: an open made after an await is not counted
// as asked, and below 144 columns the pane then waits undrawn.

export const PANE = 'cachier-details'
const PANE_TITLE = 'Prompt cache'
const PANE_FAILED = 'the details pane did not open; see the debug log'

// The size a press opens the pane at before any draw this session has recorded one: 12 rows by the command's wrap width.
const PROVISIONAL: PaneSize = { rows: 12, columns: WRAP }

// Whether the pane is open and drawn, as the mod last knows it. The mod's own open sets it and its own close clears it; a read of the engine's
// record of panes (`readPane`) puts it right after each event that can leave it wrong: the mod's own open or close settling, a close of the
// pane, the tick, and session.start.
let paneOpen = false
// The size the pane was last asked to open at; null when it is open but its size is not known (after a sync). A failed open or a close leaves
// it: a re-open another plugin refuses leaves the pane open at its old size, and asking again each tick would be refused each time.
let paneSize: PaneSize | null = null
// The size the pane's last draw recorded; null before the first draw of the session. It survives a close and is cleared only by a session-start
// sync. Only the draw writes it, and only the tick reads it to re-size: a press opens at it, and nothing builds the pane's rows to know it.
let drawn: PaneSize | null = null
// The pane's rows of that draw, kept beside its size: what a draw whose state read fails shows again. Cleared with it.
let drawnRows: PaneRow[] | null = null
// Why the last open failed, named on the status line until an open lands.
let failure: string | null = null

// Counts the starts of the mod's own opens and closes and the failure write-backs, so a read can tell that a call began while it was out.
let writes = 0
// The mod's own opens and closes still out, counted from the call's start to just before its post-call read begins.
let inFlight = 0

// The size the pane's draw recorded, as the pane asks for it from now on.
export const recordSize = (size: PaneSize): void => {
  drawn = size
}

// The rows the last draw produced, and the rows a draw whose state read failed shows again: none before the first draw of the session.
export const recordRows = (rows: PaneRow[]): void => {
  drawnRows = rows
}
export const lastRows = (): PaneRow[] => drawnRows ?? []

// The size a press opens a shut pane at: the last draw's, else 12 rows by 48 columns.
export const pressSize = (): PaneSize => drawn ?? PROVISIONAL

export const isPaneOpen = (): boolean => paneOpen
export const paneAlarm = (): string | null => failure

// The engine's record of the pane: open when it lists the pane and has placed it, shut otherwise. A read that fails throws and leaves the
// flag as it stands. One rule: a read out across the mod's own open or close is dropped, so it cannot undo that call's write. The read
// applies only if no call was out when it started, none was started while it was out (`writes` unchanged), and none is out when it
// returns. Nothing else shortens that window. A call's own post-call read starts after the call is counted off, so it applies unless
// another call overlaps it; then that call's own post-call read puts the flag right.
export async function readPane($: EngineInterface): Promise<void> {
  const before = writes
  const clear = inFlight === 0
  const open = (await $.ui.panes()).some((pane) => pane.id === PANE && pane.isPlaced)
  if (clear && writes === before && inFlight === 0) paneOpen = open
}

// The record read once at a session's start: a reload keeps the pane, and the flag says so. The size the pane was asked at is not known, and
// no draw of this session has recorded one.
export async function syncPane($: EngineInterface): Promise<void> {
  paneSize = null
  drawn = null
  drawnRows = null
  await readPane($)
}

// The read after the mod's own open or close settles, however it settled, started once the call is counted off. A failure is reported here, through the debug log, apart from the call's own error.
async function readAfterCall($: EngineInterface): Promise<void> {
  try {
    await readPane($)
  } catch (err) {
    report($, err)
  }
}

// The open, made at once: the flag is set before the open is awaited, so a press made while it runs is counted as an open of a pane already
// open. A failure clears the flag and is named until an open is answered; an open answered unplaced clears the flag and names nothing. The read
// that follows puts the flag right where the pane stays open and drawn.
function openAt($: EngineInterface, size: PaneSize): Promise<unknown> {
  writes++
  inFlight++
  paneOpen = true
  paneSize = size
  return $.ui
    .open({ id: PANE, title: PANE_TITLE, ...size, closeOnEscape: true })
    .then((r) => {
      // Any answer clears the note. An open the engine holds but has not drawn (a narrow terminal) is no failure: the flag clears so a press asks
      // it open again, and the read that follows sets it once the engine places the pane.
      failure = null
      if (!r.isPlaced) {
        writes++
        paneOpen = false
      }
    })
    .catch((err: unknown) => {
      writes++
      paneOpen = false
      failure = PANE_FAILED
      throw err
    })
    .finally(() => {
      inFlight--
      return readAfterCall($)
    })
}

// The close: the flag clears before the close is awaited, so an open made while it runs counts as open.
function closePane($: EngineInterface): Promise<unknown> {
  writes++
  inFlight++
  paneOpen = false
  // A close that rejects leaves the pane open, so the flag goes back to open; a close another plugin refuses is told by the read.
  return $.ui
    .close({ id: PANE })
    .catch((err: unknown) => {
      writes++
      paneOpen = true
      throw err
    })
    .finally(() => {
      inFlight--
      return readAfterCall($)
    })
}

// A press on the details: a shut pane opens at `size`, an open one closes.
export function togglePane($: EngineInterface, size: PaneSize): Promise<unknown> {
  return paneOpen ? closePane($) : openAt($, size)
}

// An open pane is re-opened at `size` when that differs from its last size, or its size is not known; a shut one is left shut.
export function resizePane($: EngineInterface, size: PaneSize): Promise<unknown> {
  if (!paneOpen) return Promise.resolve()
  if (paneSize !== null && paneSize.rows === size.rows && paneSize.columns === size.columns) return Promise.resolve()
  return openAt($, size)
}

// The tick's re-size: an open pane is re-opened at the size its draw recorded when that differs from the size last asked, or the size last asked
// is not known; with nothing recorded, or the pane shut, nothing is asked.
export function followDraw($: EngineInterface): Promise<unknown> {
  return drawn === null ? Promise.resolve() : resizePane($, drawn)
}
