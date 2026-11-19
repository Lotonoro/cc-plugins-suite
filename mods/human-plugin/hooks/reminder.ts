import { atom, update, type EngineInterface } from 'claude-code'

// The interval in tool calls at which the main agent is reminded, and the reminder: it names no item and no entry, so no rebuild pattern reads it.
export const THRESHOLD = 50
export const REMINDER_TEXT = `Reminder: your list kept with claude_todo has not been written for ${THRESHOLD} or more tool calls. If your steps have moved since, bring it up to date with claude_todo, an ETA on every entry.`

// The main agent's tool calls since the Claude list was last stored, in $.state (a /clear and a resume start it over; a hot reload keeps it).
// "Given" is not stored: a batch reminds when it takes the count across a multiple of the threshold. The reference is declared here, with
// literal plugin and key, where the engine's scan of the state calls can read it, and every helper that takes $ is a function declaration (see shared.ts).
const COUNT = { plugin: 'human-plugin', key: 'reminder' } as const
const count = atom(COUNT, 0)

// The list was stored: the count starts over. A failure is logged, never thrown, so it cannot fail the write or the /clear that called it.
export async function resetCount($: EngineInterface): Promise<void> {
  try {
    await $.state.set(COUNT, 0)
  } catch (err) {
    $.ui.log(`human-plugin: the tool-call count was not reset: ${String(err)}`)
  }
}

// A main-loop batch ended: adds its calls, those of the Claude list's tool (named by `listTool`) left out, to the count, and returns the reminder
// when the batch took the count across a multiple of the threshold, else null. A count that cannot be read or written is logged and gives no reminder.
export async function countBatch($: EngineInterface, calls: readonly { tool_name: string }[], listTool: string): Promise<string | null> {
  const added = calls.filter(call => call.tool_name !== listTool).length
  if (added === 0) return null
  try {
    const after = await update($, count, n => n + added)
    return Math.floor(after / THRESHOLD) > Math.floor((after - added) / THRESHOLD) ? REMINDER_TEXT : null
  } catch (err) {
    $.ui.log(`human-plugin: the tool-call count was not updated: ${String(err)}`)
    return null
  }
}
