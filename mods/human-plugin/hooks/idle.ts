import type { AgentStatus } from 'claude-code'
import type { Item } from '../types'
import type { ListedAgent, Reading } from './agents'
import { openOf } from './commands'
import type { OnItsWay } from './turns'

// The idle rule: a turn does not end with items open and none of them blocking. At the main agent's Stop the rule decides whether to send the Stop back once, with a
// steer that asks the agent to mark blocking each open item its remaining work waits on (the promotion pushes and sounds as any does), and gives its reasons as debug
// lines. When the agent ends the re-prompted turn the same way, the rule says so in one transcript line. The rule changes no item and logs nothing itself: what it reads
// comes in through its input, and the caller writes its lines and puts the steer in the Stop's answer. It takes no `$`: the caller hands it a function that reads the
// engine agent list.

// The Stop event as the rule reads it, a part of the engine's own, which is passed whole.
type StopFacts = {
  stop_hook_active: boolean
  background_tasks?: readonly { id: string; type: string }[]
  session_crons?: readonly unknown[]
}

type Facts = {
  stop: StopFacts
  // The answer from the hooks beneath already carries a block.
  blocked: boolean
  items: readonly Item[]
  // What turns.ts says is on its way to the agent.
  delivery: OnItsWay
  // A rebuild of the list is in progress, so the list may be partial.
  rebuilding: boolean
  // Reads the engine agent list. The rule calls it last, and only when every cheaper check has let the steer through.
  agents: () => Promise<Reading>
}

// The rule's answer: the steer for the Stop's block (null for none), the debug lines, and the transcript line for a steered turn that ended the same way (null for none).
type Verdict = { block: string | null; debug: string[]; decline: string | null }

// The addresses the main agent sent a message to in the running turn, and whether the rule's last answer was a steer. A turn's start and a session's end clear both
// (clearTurn); the mark is also cleared at every main-agent Stop, so a Stop that follows another hook's block is no decline of this rule's steer.
let messaged: string[] = []
let steered = false

// A batch of the main agent's calls ended: keeps the address of each SendMessage whose input has a string `to`. Any other call, or shape of input, is skipped.
export const recordBatch = (calls: readonly { tool_name: string; tool_input: unknown }[]): void => {
  for (const call of calls) {
    if (call.tool_name !== 'SendMessage' || typeof call.tool_input !== 'object' || call.tool_input === null) continue
    const to = (call.tool_input as { to?: unknown }).to
    if (typeof to === 'string') messaged = [...messaged, to]
  }
}

export const clearTurn = (): void => {
  messaged = []
  steered = false
}

// The statuses of an agent whose loop is in flight. A waiting agent is held on background work it owns or on a plan's approval, and resumes by itself.
const WORKING: readonly AgentStatus[] = ['pending', 'running', 'waiting']

// The most open items the steer names; the rest are counted.
const NAMED = 10

const debugLine = (text: string): string => `human-plugin: idle rule: ${text}`

// The open items' numbers, the first NAMED of them and then how many more, with `rest` after the count when there are more.
const numbers = (ids: readonly number[], rest = ''): string => {
  const named = ids.slice(0, NAMED).map(id => `#${id}`).join(', ')
  const more = ids.length - NAMED
  return more > 0 ? `${named}, and ${more} more${rest}` : named
}

// The steer: the same words every time but the numbers, and no item's title or ask. When the numbers are cut it says how to read the rest, an item beyond them being
// one the agent's work may wait on too.
const steerText = (ids: readonly number[]): string =>
  `Your turn is ending with items open on the human list and none of them blocking: ${numbers(ids, ' (read them with human_items list)')}. If there is nothing left you can do without the human, mark blocking, with human_items update, each open item your remaining work waits on, at least one. Otherwise do the work you still can, or remove an item that no longer applies.`

const declineText = (open: string): string => `human-plugin: the agent ended its turn after the steer with items open and none blocking: ${open}`

// A SendMessage may address a listed agent by its name with a ` [ref]` appended, so the suffix is set aside before matching.
const addressed = (agent: ListedAgent): boolean => messaged.some(to => agent.addresses.includes(to.replace(/ \[[^\]]*\]$/, '')))

// What the checks found: the steer is withheld, for a reason, or it goes out on the open items. Either way the result carries the debug lines the checks wrote on the
// way, one for each agent they set aside.
type Checked = { debug: string[] } & ({ kind: 'withheld'; why: string } | { kind: 'steer'; open: Item[] })
const withheld = (why: string, debug: string[] = []): Checked => ({ kind: 'withheld', why, debug })

// The checks, cheapest first; the first that holds the steer back says why. The engine agent list is read only when every other check has passed. Each agent it lists
// that a plugin spawned is set aside, with a debug line: a plugin's agents are that plugin's own work, never one the main agent waits on.
const check = async (f: Facts): Promise<Checked> => {
  if (f.blocked) return withheld('another hook blocked this Stop')
  if (f.rebuilding) return withheld('a rebuild running, so the list may be partial')
  const open = openOf(f.items)
  if (open.length === 0) return withheld('no item is open')
  if (open.some(it => it.blocking)) return withheld('an open item is blocking')
  const windowed = f.items.filter(it => it.state === 'done-waiting')
  if (windowed.length > 0) return withheld(`an answer on its way: ${numbers(windowed.map(it => it.id))} in its undo window`)
  if (f.delivery === 'answer') return withheld("an answer on its way: a done notice waits for a request or the turn's end")
  if (f.delivery === 'walk') return withheld('a walk asking')
  const { background_tasks: tasks, session_crons: crons } = f.stop
  if (tasks === undefined) return withheld('task list unknown')
  if (crons === undefined) return withheld('cron list unknown')
  if (crons.length > 0) return withheld('a scheduled wake-up')
  if (messaged.includes('*')) return withheld('a broadcast SendMessage this turn')
  const reading = await f.agents()
  if (reading.kind === 'unread') return withheld(`the engine agent list was not read: ${reading.reason}`)
  const aside = reading.agents.filter(a => a.spawnedBy !== null).map(a => debugLine(`set aside agent ${a.id}: spawned by ${a.spawnedBy}, ${a.status}`))
  // A task is an agent's when it carries a listed agent's id, whatever label the engine gives its type; the agent is then counted by its own status.
  const running = tasks.filter(t => t.type !== 'teammate' && t.type !== 'subagent' && !reading.agents.some(a => a.id === t.id)).map(t => `${t.type} task ${t.id}`)
  const working = reading.agents.flatMap(a => {
    if (a.spawnedBy !== null) return []
    const sent = addressed(a)
    return WORKING.includes(a.status) || sent ? [`agent ${a.id} (${a.status}${sent ? ', messaged this turn' : ''})`] : []
  })
  const inFlight = [...running, ...working]
  if (inFlight.length > 0) return withheld(`in flight: ${inFlight.join(', ')}`, aside)
  return { kind: 'steer', open, debug: aside }
}

const quiet = (): Verdict => ({ block: null, debug: [], decline: null })

// The main agent's Stop (the caller leaves a subagent's out). A Stop with `stop_hook_active` is never blocked: it follows a block. When that block was this rule's
// steer, the checks run again, and a Stop that they would steer again is the agent ending the re-prompted turn as it was, which the verdict's decline line says.
// A Stop that follows another hook's block is quiet.
export const atStop = async (f: Facts): Promise<Verdict> => {
  const afterSteer = steered
  steered = false
  if (f.stop.stop_hook_active && !afterSteer) return quiet()
  const checked = await check(f)
  // The answer's debug lines: those the checks wrote on the way, then the one that says what the rule did.
  const lines = (last: string): string[] => [...checked.debug, debugLine(last)]
  if (checked.kind === 'withheld') return { block: null, debug: lines(`withheld: ${checked.why}`), decline: null }
  const ids = checked.open.map(it => it.id)
  const open = numbers(ids)
  if (f.stop.stop_hook_active) return { block: null, debug: lines(`not steered again: ${open}`), decline: declineText(open) }
  steered = true
  return { block: steerText(ids), debug: lines(`steered, items open and none blocking: ${open}`), decline: null }
}
