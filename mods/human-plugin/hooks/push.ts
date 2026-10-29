import type { EngineInterface } from 'claude-code'
import type { Item } from '../types'
import { cutLine } from './done'
import type { Outcome } from './items'
import { inBackground } from './shared'

// The push's text is one line of at most this many UTF-16 units, the ellipsis counted within them: a mobile OS truncates a longer one.
const MESSAGE_MAX = 180

// The message a blocking item's push carries: its number and its title.
const pushText = (item: Item): string => cutLine(`Blocking: #${item.id} ${item.title}`, MESSAGE_MAX)

// A push call is made in its own function so a call that throws at once becomes a rejection, which the background work logs.
async function sendPush($: EngineInterface, item: Item): Promise<void> {
  await $.tool.call({ tool: 'PushNotification', message: pushText(item), status: 'proactive' })
}

// The tool answer path's outcome (items.ts's act). A filing of a blocking item, a promotion, and a reopen of a blocking item push the item;
// nothing else does. An update that leaves an open item as it was, a reopen of a non-blocking item, and an update to an item in its undo
// window (its window's end decides that one) push nothing.
export function pushAnswer($: EngineInterface, out: Exclude<Outcome, { deny: string }>): void {
  if (out.added !== null) {
    if (out.added.blocking) inBackground($, sendPush($, out.added))
    return
  }
  const changed = out.changed
  if (changed === null || !(changed.promoted || changed.reopened)) return
  const item = out.store.items.find(it => it.id === changed.id)
  if (item?.blocking) inBackground($, sendPush($, item))
}
