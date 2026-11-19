import type { EngineInterface } from 'claude-code'
import type { Item } from '../types'
import { doneNotice } from './done'
import { notEntered, offer } from './turns'

// A prompt the mod submits, which starts a turn when it enters. One that does not enter (a hook or a settings block refused
// it, or it failed) is handed to onRefused: nothing else would deliver its notices.
export async function enter($: EngineInterface, text: string, onRefused: () => void): Promise<void> {
  try {
    const result = await $.prompt.submit({ text })
    if (result.drop !== undefined) {
      onRefused()
      $.ui.log(`human-plugin: a notice was not entered: ${result.drop}`)
    }
  } catch (err) {
    onRefused()
    throw err
  }
}

// Sends the notice of a sent item (as the window sent it, its answer still in place): a turn when idle; while a turn runs, or a submit is starting
// one, the notice waits for the turn's next read point, and while a walk is asking, for the next turn to start, with no submit tried (see turns.ts).
// The debug line names the press (its token) that opened the window, so each notice traces to one press, and the path the notice took.
export async function send($: EngineInterface, item: Item, token: number): Promise<void> {
  const notice = { id: item.id, text: doneNotice(item) }
  const path = offer(notice)
  if (path === 'queued') {
    $.ui.log(`human-plugin: sent #${item.id} for press ${token} to the running turn`, { to: 'debug' })
    return
  }
  if (path === 'walk') {
    $.ui.log(`human-plugin: sent #${item.id} for press ${token} kept for the next turn while a walk asks`, { to: 'debug' })
    return
  }
  $.ui.log(`human-plugin: sent #${item.id} for press ${token} via submit`, { to: 'debug' })
  await enter($, notice.text, () => notEntered([notice]))
}
