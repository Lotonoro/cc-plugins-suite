import type { EngineInterface } from 'claude-code'
import { mergeRestored } from './items'
import { replay, rowsOf, type Source } from './replay'
import { inBackground, updateList } from './shared'
import { fillName, fillTodo } from './todo'

// A file's text as the host streams it, piece by piece. A one-shot read is capped at 4 MiB and a streamed child is not, so a
// transcript of any size is read whole, and only the rows the list needs are kept.
async function* textOf($: EngineInterface, path: string): AsyncGenerator<string> {
  const child = $.process.spawn({ argv: ['cat', path] })
  let stderr = ''
  for await (const piece of child) {
    if (piece.stream === 'stdout') yield piece.text
    else stderr += piece.text
  }
  const { code } = await child.result
  if (code !== 0) throw new Error(`human-plugin: cat ${path} exited ${code}: ${stderr.trim()}`)
}

// The subagents' transcripts beside a session's own; a folder that cannot be listed leaves them out, and says so.
async function subagentSources($: EngineInterface, path: string): Promise<Source[]> {
  const dir = `${path.replace(/\.jsonl$/, '')}/subagents`
  try {
    if (!(await $.fs.exists(dir))) return []
    const entries = await $.fs.list(dir)
    return entries
      .filter(entry => entry.kind === 'file' && /^agent-.+\.jsonl$/.test(entry.name))
      .map(entry => ({ rows: rowsOf(textOf($, `${dir}/${entry.name}`)), agent: entry.name.slice('agent-'.length, -'.jsonl'.length) }))
  } catch (err) {
    $.ui.log(`human-plugin: the subagents' transcripts were left out of the rebuild: ${String(err)}`)
    return []
  }
}

// A rebuild in progress (the tool waits on it), and the conversation it is for: a /clear bumps `generation`, so a rebuild
// begun before it does not fill the new list.
let restoring: Promise<void> | null = null
let generation = 0
const RESTORE_WAIT_MS = 5000

// Rebuilds the lists from a session's transcript and its subagents', off the session start. The human list is joined with whatever it
// gained while the rebuild ran; the Claude list fills only a list nothing has written in this session, and the name the agent stated for it
// only while none was stated. The three are written independently, in that order: a write that fails is logged, leaves its own as it was, and does not stop the others.
async function restore($: EngineInterface, path: string, of: number): Promise<void> {
  const sources: Source[] = [{ rows: rowsOf(textOf($, path)), agent: null }, ...(await subagentSources($, path))]
  const { store, todo, name, skipped, unreadable, known } = await replay(sources)
  if (skipped > 0) $.ui.log(`human-plugin: skipped ${skipped} unreadable transcript row(s) in the rebuild`, { to: 'debug' })
  for (const { agent, reason } of unreadable) $.ui.log(`human-plugin: subagent ${agent}'s transcript was left out of the rebuild: ${reason}`)
  if (of !== generation) return
  try {
    await updateList($, live => mergeRestored(live, store, known))
  } catch (err) {
    $.ui.log(`human-plugin: the list was not rebuilt: ${String(err)}`)
  }
  // The first write is awaited, so the session may have ended meanwhile: the old conversation's list must not fill the next one's.
  if (of !== generation) return
  try {
    await fillTodo($, todo)
  } catch (err) {
    $.ui.log(`human-plugin: the Claude TODO list was not rebuilt: ${String(err)}`)
  }
  // The list's fill is awaited too, so the session may have ended during it, and the old conversation's name must not head the next one's list. A session that ends
  // for a /resume writes no name, so only this check keeps a late fill from setting the resumed session's name before its own rebuild can.
  if (of !== generation) return
  if (name === null) return
  try {
    await fillName($, name)
  } catch (err) {
    $.ui.log(`human-plugin: the agent list's name was not rebuilt: ${String(err)}`)
  }
}

export function startRestore($: EngineInterface, path: string): void {
  const run: Promise<void> = restore($, path, generation).finally(() => {
    if (restoring === run) restoring = null
  })
  restoring = run
  inBackground($, run)
}

// Waits for a rebuild in progress, up to RESTORE_WAIT_MS of the calling hook's budget. False when it still runs; a
// rebuild that failed has been logged, and no longer holds the call.
export async function restored($: EngineInterface): Promise<boolean> {
  const pending = restoring
  if (pending === null) return true
  const timer: { at: { cancel: () => void } | null } = { at: null }
  const timedOut = new Promise<boolean>(resolve => {
    timer.at = $.clock.after(RESTORE_WAIT_MS, () => resolve(false))
  })
  const done = await Promise.race([pending.then(() => true, () => true), timedOut])
  timer.at?.cancel()
  return done
}

// Whether a rebuild is in progress, answered at once: the lists may be partial until it ends. A caller that must have the finished lists calls `restored`.
export const isRestoring = (): boolean => restoring !== null

// A forked session's transcript is written after classic.SessionStart (it exists by session.start): its rebuild starts
// at session.start, or at the first turn if the file is still missing then. The engine copies into it the original's
// live branch from its last compaction on, without the subagents' files, so that is all the rebuild finds.
let forkedTranscript: string | null = null

export const setForkedTranscript = (path: string): void => {
  forkedTranscript = path
}

export async function startForkRestore($: EngineInterface): Promise<void> {
  const path = forkedTranscript
  if (path === null || !(await $.fs.exists(path))) return
  forkedTranscript = null
  startRestore($, path)
}

// A session's end drops a rebuild in progress (its generation is bumped, so the rebuild does not fill the next conversation's list) and a
// fork still waiting for its transcript.
export const resetRebuild = (): void => {
  generation++
  restoring = null
  forkedTranscript = null
}
