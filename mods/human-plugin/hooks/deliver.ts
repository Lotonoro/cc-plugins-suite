import type { EngineInterface } from 'claude-code'
import type { Item } from '../types'
import { doneNotice, stateOf } from './done'
import { readList } from './shared'
import { endHold, notEntered, offer, type Submit } from './turns'

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

// The debug line of a release: what its prompt carries, the pointer to the notices appended that no request carried, then the notices of the items it names.
const releaseLine = (submit: Submit): string => {
  const named = (ids: readonly number[]): string => ids.map(id => `#${id}`).join(', ')
  const parts = [
    ...(submit.pointed.length > 0 ? [`a pointer to ${named(submit.pointed)}`] : []),
    ...(submit.notices.length > 0 ? [`notices for ${named(submit.notices.map(notice => notice.id))}`] : []),
  ]
  return `human-plugin: released at the walk's end: ${parts.join(', then ')}`
}

// A walk's release, which walk.ts runs from a timer once the walk's command hook has settled: what the walk left owed goes out as one prompt. The list is read
// first, for the check that each notice's item is still on it. Nothing is awaited between that read and the taking of what is owed, so the checks see the state as
// it is then: `isStale` says that a newer walk is asking, or that the session that armed the release has ended, and the release then takes nothing and leaves every
// state as it is. Otherwise the hold ends and what is owed is taken (turns.ts), and submitted unless a turn is running or nothing is owed. A list that cannot be
// read checks nothing: the notices are released unchecked, and the failure is logged. A prompt that does not enter holds its notices for the human's next prompt
// (enter).
export async function release($: EngineInterface, isStale: () => boolean): Promise<void> {
  let isLive: (id: number) => boolean
  try {
    const store = await readList($)
    isLive = id => stateOf(store, id) !== 'missing'
  } catch (err) {
    $.ui.log(`human-plugin: the list could not be read before the walk's notices were released, so they are released unchecked: ${String(err)}`)
    isLive = () => true
  }
  if (isStale()) return
  const submit = endHold(isLive)
  if (submit === null) return
  $.ui.log(releaseLine(submit), { to: 'debug' })
  await enter($, submit.text, () => notEntered(submit.notices))
}

// Sends the notice of a sent item (as the window sent it, its answer still in place): a turn when idle; while a turn runs, or a submit is starting
// one, the notice waits for the turn's next read point, and while the hold is on (a walk is asking, or its release is pending), for the release or the next turn to
// start, with no submit tried (see turns.ts).
// The debug line names the press (its token) that opened the window, so each notice traces to one press, and the path the notice took.
export async function send($: EngineInterface, item: Item, token: number): Promise<void> {
  const notice = { id: item.id, text: doneNotice(item) }
  const path = offer(notice)
  if (path === 'queued') {
    $.ui.log(`human-plugin: sent #${item.id} for press ${token} to the running turn`, { to: 'debug' })
    return
  }
  if (path === 'walk') {
    $.ui.log(`human-plugin: sent #${item.id} for press ${token} kept for the walk's release or the next turn`, { to: 'debug' })
    return
  }
  $.ui.log(`human-plugin: sent #${item.id} for press ${token} via submit`, { to: 'debug' })
  await enter($, notice.text, () => notEntered([notice]))
}
