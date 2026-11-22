import type { AgentStatus, EngineInterface } from 'claude-code'

// The boundary to the engine's agent list (`$.agent.list()`): what the idle rule (idle.ts) knows of the session's subagents and teammates comes through here,
// as plain values. Every `$`-taking helper is a function declaration, since past an import `$` is followed only into one (see shared.ts).

// How long the read may take before it counts as unread. The call is local and answers well within it; a Stop waits this long at most, and the rule then
// withholds its steer.
const BOUND_MS = 2000

// The statuses the typings list for an agent, as a record, so one added to the typings is an error here until it is handled. The engine can be ahead of the
// typings: a status that is not here makes the read unread, and the steer is withheld rather than the agent read as not working.
const KNOWN: Record<AgentStatus, true> = { pending: true, running: true, waiting: true, idle: true, completed: true, failed: true, killed: true }

const isStatus = (value: unknown): value is AgentStatus => typeof value === 'string' && Object.hasOwn(KNOWN, value)

// One agent as the rule reads it: its id, where its loop stands, the strings a message is addressed to it by (its id, its name, its team address), and the
// name of the plugin that spawned it, null when the model or the person did.
export type ListedAgent = { id: string; status: AgentStatus; addresses: readonly string[]; spawnedBy: string | null }

// The list as read, or why it was not: the reason is the error's message, or the words for a late answer or an unexpected shape, and it reaches the debug log.
export type Reading = { kind: 'read'; agents: readonly ListedAgent[] } | { kind: 'unread'; reason: string }

const UNEXPECTED: Reading = { kind: 'unread', reason: 'unexpected shape' }

// What the timer settles the race with: a value no answer of the call can be.
const LATE = Symbol('late')

// An answer that is not a list, an entry that is not an object with a string id and a status the typings list, or a `spawnedBy` that is present and not a string,
// makes the read unread. An absent `spawnedBy` means no plugin spawned the agent. A name or team address that is not a string is no address.
function normalized(answer: unknown): Reading {
  if (!Array.isArray(answer)) return UNEXPECTED
  const agents: ListedAgent[] = []
  for (const entry of answer as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return UNEXPECTED
    const fields = entry as Record<string, unknown>
    const { id, status, name, teammateId, spawnedBy } = fields
    if (typeof id !== 'string' || !isStatus(status)) return UNEXPECTED
    if (spawnedBy !== undefined && typeof spawnedBy !== 'string') return UNEXPECTED
    agents.push({ id, status, addresses: [id, name, teammateId].filter((address): address is string => typeof address === 'string'), spawnedBy: spawnedBy ?? null })
  }
  return { kind: 'read', agents }
}

// The engine's agent list, once, bounded: the call and a timer of BOUND_MS race, and the first to settle decides. A late answer or rejection of the call is
// ignored, and the timer is cancelled on every path. Nothing leaves as a throw: a failed call, a timer that cannot be set (the call is then never made) and a late
// answer are all unread, with their reason. The call takes no argument, and its answer is read as unknown, since a hook's answer is not checked against the typings.
export async function readAgents($: EngineInterface): Promise<Reading> {
  const bound: { expire: () => void; timer: { cancel: () => void } | null } = { expire: () => undefined, timer: null }
  try {
    const late = new Promise<typeof LATE>(resolve => {
      bound.expire = () => resolve(LATE)
    })
    // Set outside the promise's executor, which would turn a throw into a rejection that the call's own answer can beat in the race.
    bound.timer = $.clock.after(BOUND_MS, () => bound.expire())
    const answer: unknown = await Promise.race([$.agent.list(), late])
    return answer === LATE ? { kind: 'unread', reason: `no answer within ${BOUND_MS / 1000} s` } : normalized(answer)
  } catch (err) {
    return { kind: 'unread', reason: err instanceof Error ? err.message : String(err) }
  } finally {
    bound.timer?.cancel()
  }
}
