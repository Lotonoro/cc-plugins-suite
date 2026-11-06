import type { AgentInfo } from 'claude-code'
import type { Conversation } from '../types/index'

// Every decision about whether an agent, a send, a delivery, a prompt or a row is the reviewer's, as pure functions; register.ts keeps every step on `$` and the plugin's identifying literals, which it passes in. This file imports no value, so nothing here reads state or the engine: a conversation, an event or a list entry in, a decision or the next conversation out.

// The literals that identify this plugin's reviewer: the plugin's name, the name its spawn is given, and the description its spawn is given.
export type Identity = { plugin: string; name: string; description: string }

type Spawn = Conversation['spawnsInFlight'][number]

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A reviewer's spawn name, or the engine's rename of it when the name was taken (`auditor-reviewer-2`).
const nameAlone = (id: Identity): RegExp => new RegExp(`^${escaped(id.name)}(?:-\\d+)?$`)

// A reviewer's spawn name inside a longer text, bounded so a longer name that contains it does not match.
const nameWithin = (id: Identity): RegExp => new RegExp(`(?<![\\w-])${escaped(id.name)}(?:-\\d+)?(?![\\w-])`)

// What the state-based answer says of an agent id: the stored reviewer's (`current`); one this session's spawns returned that the state no longer stores, whether a rotation retired it, a switch or a /clear let it go, or its spawn went stale (`former`); or neither, the worker's own agents included, one under a reviewer's name too.
export type Standing = 'current' | 'former' | 'neither'

// The state-based answer. A site that must match only the reviewer being served asks for `current`; one that must match every reviewer this session spawned asks for anything but `neither`. A spawn whose id no hook has stored yet is `neither` here: the sites that must match it read its origin (`originOf`) instead.
export const standingOf = (c: Conversation, agentId: string | undefined): Standing => {
  if (agentId === undefined) return 'neither'
  if (c.reviewer?.id === agentId) return 'current'
  return c.reviewerIds.includes(agentId) ? 'former' : 'neither'
}

// What an event's origin says: this plugin's own hook (`own`), an agent this plugin spawned (`spawned`), or neither.
export type Origin = 'own' | 'spawned' | 'neither'

// The origin of a send (the model inside an agent this plugin spawned is stamped with this plugin's name and the agent's id; the plugin's own briefs carry no agent id), of a hook (`next.origin`), or of an agent-list entry (`spawnedBy`).
export type Provenance =
  | { from: 'send'; origin: { kind: string; name?: string }; agentId: string | undefined }
  | { from: 'hook'; origin: { plugin: string } }
  | { from: 'listed'; agent: { spawnedBy?: string } }

// The state-free classifier: it reads the event alone, so it answers for a spawn whose id has not landed, current or former alike. An origin-only site asks it, never the state-based answer.
export const originOf = (plugin: string, source: Provenance): Origin => {
  if (source.from === 'send') return source.origin.kind === 'plugin' && source.origin.name === plugin ? (source.agentId === undefined ? 'own' : 'spawned') : 'neither'
  if (source.from === 'hook') return source.origin.plugin === plugin ? 'own' : 'neither'
  return source.agent.spawnedBy === plugin ? 'spawned' : 'neither'
}

// Whether an agent-list entry is a reviewer's: its id is one the state knows, or the list names it as this plugin's spawn, which is how a spawn whose id has not landed shows.
export const isReviewerEntry = (id: Identity, c: Conversation, entry: AgentInfo): boolean => standingOf(c, entry.id) !== 'neither' || originOf(id.plugin, { from: 'listed', agent: entry }) === 'spawned'

// The name a reviewer is adopted under when the list entry for its caller is one: shaped like a spawn name and named as this plugin's spawn. A worker's own subagent under a reviewer's name, of the reviewer's type or another, is not.
export const reviewerNameOf = (id: Identity, entry: AgentInfo | undefined): string | undefined => {
  if (entry?.name === undefined || !nameAlone(id).test(entry.name)) return undefined
  return originOf(id.plugin, { from: 'listed', agent: entry }) === 'spawned' ? entry.name : undefined
}

// The team name a spawn is learned under: the agent list's, since the engine renames a taken name, else the name it was spawned under.
export const spawnName = (id: Identity, listed: readonly AgentInfo[] | undefined, agentId: string): string => listed?.find(a => a.id === agentId)?.name ?? id.name

// What the state says of a verified team name before any list is read: `known` (one of this conversation's reviewers), `ask` (shaped like a spawn name but not yet known, so the agent list is asked) or `other`.
export const nameKnown = (id: Identity, c: Conversation, name: string): 'known' | 'ask' | 'other' => {
  if (c.reviewerNames.includes(name)) return 'known'
  return nameAlone(id).test(name) ? 'ask' : 'other'
}

// What the agent list says of a name the state does not know: `learn` when it gives the name to one of this conversation's reviewer ids. A lost list takes the name as a reviewer's (`known`): a verified sender under a reviewer's name is this plugin's, and its traffic to the worker is clutter either way.
export const nameListed = (c: Conversation, name: string, listed: readonly AgentInfo[] | undefined): 'known' | 'learn' | 'other' => {
  if (listed === undefined) return 'known'
  return listed.some(a => a.name === name && standingOf(c, a.id) !== 'neither') ? 'learn' : 'other'
}

// A reviewer's hand-back, by its own frame alone: the hand-back marker opening the first line, which names the reviewer, or opening the line right after a reviewer's agent-message envelope. A note's first line is the envelope and its second the review line, so no note matches, whatever it quotes. A plain subagent's final report reaches prompt submission opening with this marker.
const HAND_BACK = '[Subagent hand-back]'
// The envelope an agent message arrives in, naming its sender.
const ENVELOPE = '<agent-message from='
export const isHandBack = (id: Identity, e: { text: string; origin: { kind: string } }): boolean => {
  if (e.origin.kind !== 'peer') return false
  const [first = '', second = ''] = e.text.split('\n', 2)
  if (!nameWithin(id).test(first)) return false
  return first.startsWith(HAND_BACK) || (first.startsWith(ENVELOPE) && second.startsWith(HAND_BACK))
}

// A teammate's end-of-run status notice, as the team mailbox carries it: a JSON object whose type is `idle_notification`.
export const isEndNotice = (text: string): boolean => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A body that is not JSON is not a status notice; nothing failed.
    return false
  }
  return typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'idle_notification'
}

// A reviewer's task notification (failed, stopped or finished), which the engine raises as a prompt of task-notification origin and which names the reviewer's spawn description in its summary. A batch that holds another task's notification too is a normal turn: every block in it must name the reviewer. Text with no block at all is judged by its text.
const TASK_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>/g
export const isNotice = (id: Identity, e: { text: string; origin: { kind: string } }): boolean => {
  if (e.origin.kind !== 'task-notification') return false
  const frame = `Agent "${id.description}"`
  const blocks = e.text.match(TASK_BLOCK)
  if (blocks === null) return e.text.includes(frame)
  return blocks.every(block => block.includes(frame))
}

const matchSpawn = (spawns: readonly Spawn[], brief: string): Spawn | undefined => spawns.find(s => s.brief === brief)

const withMember = (members: string[], member: string): string[] => (members.includes(member) ? members : [...members, member])

// Learns a reviewer spawn's id and its team name, as the spawn hook sees them. The id and the model the spawn resolved to are kept on the spawn's entry in `spawnsInFlight`, matched by brief, for the spawning dispatch, which has the last word on whether the spawn stays the reviewer (`land`). The spawn stands in as the reviewer at once while its review is open in its epoch and none is stored, so its calls and turn end are the reviewer's before its dispatch resumes; a hook that matches no entry only marks the id and name.
export const learn = (c: Conversation, brief: string, agentId: string, model: string, name: string): Conversation => {
  const own = matchSpawn(c.spawnsInFlight, brief)
  const standsIn = !c.off && c.reviewer === undefined && own !== undefined && own.epoch === c.epoch && own.number === c.review?.number
  return {
    ...c,
    spawnsInFlight: c.spawnsInFlight.map(s => (s === own ? { ...s, id: agentId, model } : s)),
    ...(standsIn ? { reviewer: { id: agentId, model } } : {}),
    reviewerIds: withMember(c.reviewerIds, agentId),
    reviewerNames: withMember(c.reviewerNames, name),
  }
}

// Learns a team name an agent list gave to one of this conversation's reviewers.
export const learnName = (c: Conversation, name: string): Conversation => (c.reviewerNames.includes(name) ? c : { ...c, reviewerNames: [...c.reviewerNames, name] })

// Whether an older epoch's spawn still in flight blocks adoption of `agentId` at `now`: one whose hook named another id does not, nor one past `timeoutMs`. With no clock reading every such spawn blocks.
const blocksAdoption = (c: Conversation, s: Spawn, agentId: string, now: number | undefined, timeoutMs: number): boolean =>
  s.epoch !== c.epoch && (s.id === undefined || s.id === agentId) && (now === undefined || now - s.startedAt <= timeoutMs)

// Adopts a caller no stored reviewer id names as the reviewer whose spawn result has not landed yet. Only a reviewer with no stored id is adopted: a second agent under the reviewer's name is refused, not swapped in, and so is an id the state already knows. Nothing is adopted while off, nor while a spawn from an older epoch blocks it: the caller could be that spawn's agent.
export const adopt = (c: Conversation, agentId: string, name: string, now: number | undefined, timeoutMs: number): Conversation => {
  if (c.off || c.reviewer?.id !== undefined || c.reviewerIds.includes(agentId) || c.spawnsInFlight.some(s => blocksAdoption(c, s, agentId, now, timeoutMs))) return c
  return { ...c, reviewer: { id: agentId, model: '' }, reviewerIds: withMember(c.reviewerIds, agentId), reviewerNames: withMember(c.reviewerNames, name) }
}

// Starts a reviewer spawn: no reviewer is stored from here until the spawn stands in, and the spawn is committed as an entry in `spawnsInFlight`.
export const spawning = (c: Conversation, spawn: Spawn): Conversation => ({ ...c, reviewer: undefined, reviewerContext: 0, spawnsInFlight: [...c.spawnsInFlight, spawn] })

// What a spawn's landing did: the id it settled on, whether it landed under an older epoch than its dispatch's, and whether it stood in as the reviewer.
export type Landing = { next: Conversation; id: string | undefined; stale: boolean; stood: boolean }

// Lands a spawn under the dispatch's epoch (`epoch`): its id is the result's, else its entry's, else the stored reviewer's, which under the dispatch's epoch can only be this spawn, adopted by name before its hook stood it in. The id marks the spawn's traffic and rows even when the spawn hook never saw it. A spawn that is not stale stands in as the reviewer while its review is open; a review that already closed, with another reviewer or none stored, means this spawn was retired or replaced since, and it is not stood in again. Otherwise the stored reviewer stays as it is: a stale spawn stored as the reviewer was adopted by name in the current epoch and may hold a later review, which clearing it would leave open with no reviewer to settle it.
export const land = (c: Conversation, brief: string, number: number, epoch: number, started: { agentId?: string; model?: string }): Landing => {
  const kept = matchSpawn(c.spawnsInFlight, brief)
  const stale = c.epoch !== epoch
  const id = started.agentId ?? kept?.id ?? (stale ? undefined : c.reviewer?.id)
  if (id === undefined) return { next: c, id, stale, stood: false }
  const known = c.reviewerIds.includes(id) ? c : { ...c, reviewerIds: [...c.reviewerIds, id] }
  const stood = !stale && (c.review?.number === number || c.reviewer?.id === id)
  if (!stood) return { next: known, id, stale, stood }
  return { next: { ...known, reviewer: { id, model: kept?.id === id && kept.model !== undefined ? kept.model : (started.model ?? '') } }, id, stale, stood }
}

// Retires the stored reviewer once its context passed `limit`, in the change that ends its review, so no dispatch can plan a brief to it in between. Its id and name still mark its traffic and rows, and its tools refuse it; `retired` is its id, for the caller to stop.
export const retire = (c: Conversation, limit: number): { next: Conversation; retired: string | undefined } =>
  c.reviewerContext > limit ? { next: { ...c, reviewer: undefined, reviewerContext: 0 }, retired: c.reviewer?.id } : { next: c, retired: undefined }

// Lets the stored reviewer go. Its id and name still mark its traffic and rows.
export const forget = (c: Conversation): Conversation => ({ ...c, reviewer: undefined, reviewerContext: 0 })

// The reviewer markers a /clear keeps: they mark traffic, not a review.
export const markers = (c: Conversation): Pick<Conversation, 'reviewerIds' | 'reviewerNames'> => ({ reviewerIds: c.reviewerIds, reviewerNames: c.reviewerNames })
