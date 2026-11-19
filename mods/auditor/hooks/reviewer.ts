import type { AgentInfo, AgentStatus } from 'claude-code'
import type { Conversation, FailCause, LetGoReason, OpenReview } from '../types/index'
import { DEFAULT_MODEL, canonicalOf, idOf, isFullId, sameModel } from './models'
import type { ModelIds } from './models'

// Every decision about whether an agent, a send, a delivery, a prompt or a row is the reviewer's, as pure functions; register.ts keeps every step on `$` and the plugin's identifying literals, which it passes in. This file imports only pure functions (`models.ts`), so nothing here reads state or the engine: a conversation, an event or a list entry in, a decision or the next conversation out.

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

// Why a reviewer's turn end closed nothing, in the words the debug log uses: the agent is one the state knows as a reviewer it let go (`former reviewer`), or it was the stored reviewer when its turn end was first read and the settle's take found it no longer stored (`let go during its settle`).
export type UnmatchedReason = 'former reviewer' | 'let go during its settle'

// How many of a review's latest turn ends that closed nothing are kept in full: two are enough to compare their ids with the stored reviewer's, and the conversation is one state value rewritten on every change.
const UNMATCHED_KEPT = 2

// The review with one more turn end counted under `reason`: its count raised, and the turn end appended to the latest ones, the oldest dropped past UNMATCHED_KEPT.
const withUnmatched = (review: OpenReview, reason: UnmatchedReason, agentId: string, at: number): OpenReview => {
  const held = review.unmatched ?? { former: 0, letGo: 0, last: [] }
  const former = reason === 'former reviewer'
  return { ...review, unmatched: { former: held.former + (former ? 1 : 0), letGo: held.letGo + (former ? 0 : 1), last: [...held.last, { agentId, at }].slice(-UNMATCHED_KEPT) } }
}

// What a reviewer turn end that closed nothing did: the conversation after it, the reason it counts under (absent where the agent is not one the state knows as let go), the number of the review that took it (absent where none did) and the number of the review open then, whether or not it took the count (absent where none was open): a review dispatched after the turn end was first read is open and takes none.
export type Counted = { next: Conversation; reason: UnmatchedReason | undefined; review: number | undefined; open: number | undefined }

// Counts the turn end of `agentId`, which arrived at `at`, on the open review under `reason`. It is judged on the conversation a change reads, never on the one the hook first read: only an agent the state knows as a reviewer it let go counts (the stored reviewer and the worker's own agents never do), and the open review takes it only when that review was dispatched by the time of the first read (`dispatched`, the dispatch count there). A review's number is its dispatch's count, so a newer review is not counted on; a clock reading could not say this exactly, since a dispatch in the window can carry a later time and a same-millisecond one ties.
export const countUnmatched = (c: Conversation, agentId: string, reason: UnmatchedReason, at: number, dispatched: number): Counted => {
  const open = c.review
  if (standingOf(c, agentId) !== 'former') return { next: c, reason: undefined, review: undefined, open: open?.number }
  if (open === undefined || open.number > dispatched) return { next: c, reason, review: undefined, open: open?.number }
  return { next: { ...c, review: withUnmatched(open, reason, agentId, at) }, reason, review: open.number, open: open.number }
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

// A reviewer as the state stores it: its id and resolved model, and the choice it was spawned for where one is known.
const reviewerOf = (id: string, model: string, choice: string | undefined): NonNullable<Conversation['reviewer']> => (choice === undefined ? { id, model } : { id, model, choice })

// The per-id record of resolved models with `model` for `id`; unchanged where the model is blank (a spawn result that has not landed) or already recorded.
const withModel = (models: Conversation['reviewerModels'], id: string, model: string): Conversation['reviewerModels'] => (model === '' || models[id] === model ? models : { ...models, [id]: model })

// The review with `id` recorded as the reviewer its brief reached: only where it has a route to record it for and holds no id for that route yet. The id a route already has is never overwritten, since it asks whom the brief reached and not who holds the review now, so a landing for the brief a stand-in already recorded leaves it; a route set replaces it (`withRoute` in register.ts).
const withBriefed = (review: OpenReview, id: string): OpenReview => (review.briefTo === undefined || review.briefedId !== undefined ? review : { ...review, briefedId: id })

// Learns a reviewer spawn's id and its team name, as the spawn hook sees them. The id and the model the spawn resolved to are kept on the spawn's entry in `spawnsInFlight`, matched by brief, for the spawning dispatch, which has the last word on whether the spawn stays the reviewer (`land`), and the model is recorded for the id (`reviewerModels`). The spawn stands in as the reviewer at once while its review is open in its epoch and none is stored, with the choice its entry was spawned for, so its calls and turn end are the reviewer's before its dispatch resumes, and its id is the one the review's brief reached, so a review whose spawn call never lands still names it; a hook that matches no entry only marks the id, the name and the model.
export const learn = (c: Conversation, brief: string, agentId: string, model: string, name: string): Conversation => {
  const own = matchSpawn(c.spawnsInFlight, brief)
  const standsIn = !c.off && c.reviewer === undefined && own !== undefined && own.epoch === c.epoch && own.number === c.review?.number
  return {
    ...c,
    spawnsInFlight: c.spawnsInFlight.map(s => (s === own ? { ...s, id: agentId, model } : s)),
    ...(standsIn ? { reviewer: reviewerOf(agentId, model, own?.choice) } : {}),
    ...(standsIn && c.review !== undefined ? { review: withBriefed(c.review, agentId) } : {}),
    reviewerIds: withMember(c.reviewerIds, agentId),
    reviewerNames: withMember(c.reviewerNames, name),
    reviewerModels: withModel(c.reviewerModels, agentId, model),
  }
}

// The choice the spawn in flight for `brief` was made for, matched as `learn` matches it: undefined where no entry holds the brief, or where the entry predates the choice.
export const spawnChoice = (c: Conversation, brief: string): string | undefined => matchSpawn(c.spawnsInFlight, brief)?.choice

// Learns a team name an agent list gave to one of this conversation's reviewers.
export const learnName = (c: Conversation, name: string): Conversation => (c.reviewerNames.includes(name) ? c : { ...c, reviewerNames: [...c.reviewerNames, name] })

// Whether an older epoch's spawn still in flight blocks adoption of `agentId` at `now`: one whose hook named another id does not, nor one past `timeoutMs`. With no clock reading every such spawn blocks.
const blocksAdoption = (c: Conversation, s: Spawn, agentId: string, now: number | undefined, timeoutMs: number): boolean =>
  s.epoch !== c.epoch && (s.id === undefined || s.id === agentId) && (now === undefined || now - s.startedAt <= timeoutMs)

// Adopts a caller no stored reviewer id names as the reviewer whose spawn result has not landed yet, with no model resolved and the choice of the current epoch's newest spawn in flight, or the conversation's choice where there is none. Only a reviewer with no stored id is adopted: a second agent under the reviewer's name is refused, not swapped in, and so is an id the state already knows. Nothing is adopted while off, nor while a spawn from an older epoch blocks it: the caller could be that spawn's agent.
export const adopt = (c: Conversation, agentId: string, name: string, now: number | undefined, timeoutMs: number): Conversation => {
  if (c.off || c.reviewer?.id !== undefined || c.reviewerIds.includes(agentId) || c.spawnsInFlight.some(s => blocksAdoption(c, s, agentId, now, timeoutMs))) return c
  const choice = [...c.spawnsInFlight].reverse().find(s => s.epoch === c.epoch)?.choice ?? c.choice
  return { ...c, reviewer: reviewerOf(agentId, '', choice), reviewerIds: withMember(c.reviewerIds, agentId), reviewerNames: withMember(c.reviewerNames, name) }
}

// Starts a reviewer spawn: no reviewer is stored from here until the spawn stands in, and the spawn is committed as an entry in `spawnsInFlight`.
export const spawning = (c: Conversation, spawn: Spawn): Conversation => ({ ...c, reviewer: undefined, reviewerContext: 0, spawnsInFlight: [...c.spawnsInFlight, spawn] })

// What a spawn's landing did: the id it settled on, whether it landed under an older epoch than its dispatch's, and whether it stood in as the reviewer.
export type Landing = { next: Conversation; id: string | undefined; stale: boolean; stood: boolean }

// Lands a spawn under the dispatch's epoch (`epoch`): its id is the result's, else its entry's, else the stored reviewer's, which under the dispatch's epoch can only be this spawn, adopted by name before its hook stood it in. The id marks the spawn's traffic and rows even when the spawn hook never saw it, and its resolved model is recorded for it. A spawn that stands in carries the choice its entry was spawned for, else the one the reviewer stored under its id already holds, and its id is the one its review's brief reached when that review is the open one and its stand-in recorded none. A spawn that is not stale stands in as the reviewer while its review is open; a review that already closed, with another reviewer or none stored, means this spawn was retired or replaced since, and it is not stood in again. Otherwise the stored reviewer stays as it is: a stale spawn stored as the reviewer was adopted by name in the current epoch and may hold a later review, which clearing it would leave open with no reviewer to settle it.
export const land = (c: Conversation, brief: string, number: number, epoch: number, started: { agentId?: string; model?: string }): Landing => {
  const kept = matchSpawn(c.spawnsInFlight, brief)
  const stale = c.epoch !== epoch
  const id = started.agentId ?? kept?.id ?? (stale ? undefined : c.reviewer?.id)
  if (id === undefined) return { next: c, id, stale, stood: false }
  const model = kept?.id === id && kept.model !== undefined ? kept.model : (started.model ?? '')
  const known = { ...c, reviewerIds: withMember(c.reviewerIds, id), reviewerModels: withModel(c.reviewerModels, id, model) }
  const stood = !stale && (c.review?.number === number || c.reviewer?.id === id)
  if (!stood) return { next: known, id, stale, stood }
  const choice = kept?.choice ?? (c.reviewer?.id === id ? c.reviewer.choice : undefined)
  return { next: { ...known, reviewer: reviewerOf(id, model, choice), ...(c.review?.number === number ? { review: withBriefed(c.review, id) } : {}) }, id, stale, stood }
}

// How long an open review may go on before it is given up, by whether a reviewer is stored: a spawn that stood none in (`start`) or a stored reviewer that has not ended its turn (`finish`), each in milliseconds from the dispatch.
export type Limits = { start: number; finish: number }

// Whether the open review lapsed at `now`, and as which failure: `no start` when no reviewer is stored, `no finish` when one is. Each reads its own limit, so changing how long a review may run does not change how long a spawn may take.
export const lapseOf = (c: Conversation, now: number, limits: Limits): Extract<FailCause, 'no start' | 'no finish'> | undefined => {
  if (c.review === undefined) return undefined
  const stored = c.reviewer !== undefined
  return now - c.review.dispatchedAt > (stored ? limits.finish : limits.start) ? (stored ? 'no finish' : 'no start') : undefined
}

// How many of a lapse's unknown plugin spawns its record names, with their status; the total counts every one.
const UNKNOWN_NAMED = 3

// What the agent list says at a lapse, in the words its log entry and debug line use. `heldId`: the reviewer the state held for the review, absent where none (a spawn that stood none in). `heldStatus`: the status the list gives it, `absent` where the list shows no agent under that id, `unread` where the list could not be read; absent where no reviewer was held. `unknown`: the first UNKNOWN_NAMED agents the list names as this plugin's spawn whose id the state did not know, in the list's order, with their status, and `unknownTotal` how many there are in all; both absent where the list could not be read.
export type LapseListFacts = {
  heldId: string | undefined
  heldStatus: AgentStatus | 'absent' | 'unread' | undefined
  unknown: { agentId: string; status: AgentStatus }[] | undefined
  unknownTotal: number | undefined
}

// The lapse's list facts, judged on `c`, the conversation as it was before the lapse let its reviewer go (a let-go clears the stored reviewer, so a later conversation holds none), and `listed`, the agent list read after the lapse was decided, undefined where it could not be read. An unknown spawn is a listed agent the list names as this plugin's (`originOf`) whose id the state does not know (`standingOf`): a reviewer the state let go, the held reviewer and any agent this plugin did not spawn, a worker's own subagent under a reviewer's name included, are not. The list shows every reviewer of the process whatever conversation it served and no field of an entry tells conversations apart (`sweepable`), so an unknown spawn may be another conversation's.
export const lapseListFacts = (id: Identity, c: Conversation, listed: readonly AgentInfo[] | undefined): LapseListFacts => {
  const heldId = c.reviewer?.id
  const heldStatus = heldId === undefined ? undefined : listed === undefined ? 'unread' : (listed.find(a => a.id === heldId)?.status ?? 'absent')
  if (listed === undefined) return { heldId, heldStatus, unknown: undefined, unknownTotal: undefined }
  const unknown = listed.filter(a => standingOf(c, a.id) === 'neither' && originOf(id.plugin, { from: 'listed', agent: a }) === 'spawned')
  return { heldId, heldStatus, unknown: unknown.slice(0, UNKNOWN_NAMED).map(a => ({ agentId: a.id, status: a.status })), unknownTotal: unknown.length }
}

// What a let-go decided: the conversation after it, and the id of the reviewer to stop (absent when none was let go).
export type Release = { next: Conversation; released: string | undefined }

// The reasons whose let-go clears the stored reviewer and its context. A refused brief's reviewer is cleared by the spawn that replaces it (`spawning`), and a stale landing's spawn was never the stored one. A rejected spawn's learned id clears it only where it is that id (`letGo`).
const CLEARING: readonly LetGoReason[] = ['rotation', 'switch off', 'session end', 'lapsed', 'failed review', 'reaped idle', 'model switch']

// The one decision to let a reviewer go, for `reason`. `id` is the reviewer let go: the stored one's for a rotation, a switch off, a session end, a lapse, a failed review, an idle reap and a model switch, the refused one's for a refused brief, the landed one's for a stale landing, the one the spawn hook learned for a rejected spawn (cleared from the stored reviewer only when it is that one, since a later spawn may have stored another). The reviewer's id and name still mark its traffic and rows. A rotation lets go only once the reviewer's context passed `rotateAt`, and a stale landing whose id is the stored reviewer's lets nothing go, since it is not stale after all. A let-go of an id notes its reason (`lastLetGo`), which a later one replaces; `released` is the id for the caller to stop, in the change that applies `next`.
export const letGo = (c: Conversation, reason: LetGoReason, id: string | undefined, rotateAt = 0): Release => {
  if (reason === 'rotation' && c.reviewerContext <= rotateAt) return { next: c, released: undefined }
  if (reason === 'stale landing' && c.reviewer?.id === id) return { next: c, released: undefined }
  const clears = CLEARING.includes(reason) || (reason === 'rejected spawn' && id !== undefined && c.reviewer?.id === id)
  const cleared: Conversation = clears ? { ...c, reviewer: undefined, reviewerContext: 0 } : c
  return id === undefined ? { next: cleared, released: undefined } : { next: { ...cleared, lastLetGo: reason }, released: id }
}

// What an idle-reap timer was started under: the stored reviewer's id, and the dispatch count and epoch at its start. The timer is nothing but this closure, checked again when it fires (`reapIdle`).
export type IdleTimer = { id: string; dispatches: number; epoch: number }

// The identity a reviewer left stored and idle has: no review open and no spawn in flight, else undefined. The one condition the timer is started under and the fire is judged by.
export const idleTimerOf = (c: Conversation): IdleTimer | undefined =>
  c.reviewer === undefined || c.review !== undefined || c.spawnsInFlight.length > 0 ? undefined : { id: c.reviewer.id, dispatches: c.dispatches, epoch: c.epoch }

// Whether a timer's fire lets its reviewer go: only while that reviewer is still the stored one and still idle, with no dispatch and no reset since the timer started; otherwise the fire changes nothing. A dispatch whose change landed first has opened a review, and one that lands after the fire finds no reviewer to send to and spawns.
export const reapIdle = (c: Conversation, timer: IdleTimer): Release => {
  const now = idleTimerOf(c)
  return now !== undefined && now.id === timer.id && now.dispatches === timer.dispatches && now.epoch === timer.epoch ? letGo(c, 'reaped idle', timer.id) : { next: c, released: undefined }
}

// The conversation with the stored reviewer `id`'s latest turn end noted at `at`, which the idle timer counts from; unchanged where `id` is not the stored reviewer.
export const withTurnEnd = (c: Conversation, id: string, at: number): Conversation => (c.reviewer?.id === id ? { ...c, reviewer: { ...c.reviewer, endedAt: at } } : c)

// The two names a switch compares: the one the stored reviewer was spawned for, and the one the conversation holds now. A reviewer that holds no choice, stored before choices existed, ran the definition's default. Undefined where there is no reviewer, or the conversation has switched nothing (no choice yet).
const namesOf = (c: Conversation): { spawned: string; chosen: string } | undefined =>
  c.reviewer === undefined || c.choice === undefined ? undefined : { spawned: c.reviewer.choice ?? DEFAULT_MODEL, chosen: c.choice }

// The model the stored reviewer's spawn resolved to: the one it stores, else the one recorded for its id, which a reviewer adopted before its result landed has alone. Undefined where there is no reviewer, or it has none.
const resolvedOf = (c: Conversation): string | undefined => (c.reviewer === undefined ? undefined : c.reviewer.model || c.reviewerModels[c.reviewer.id] || undefined)

// What a switch compares, or undefined where nothing needs comparing: no reviewer, no choice yet, or a reviewer spawned for the choice itself, which is kept whatever the id it runs, so an unchanged choice never lets one go. Otherwise the choice, against the id the stored reviewer runs (the model its spawn resolved to, in canonical form) where that is a full id, else against the name it was spawned for. The id outweighs the name: an alias resolves again at every spawn, so what the stored ids say of the reviewer's name now is not what the reviewer runs.
const comparedOf = (c: Conversation): { held: string; chosen: string } | undefined => {
  const names = namesOf(c)
  if (names === undefined || names.spawned === names.chosen) return undefined
  const resolved = resolvedOf(c)
  return { held: (resolved === undefined ? undefined : canonicalOf(resolved)) ?? names.spawned, chosen: names.chosen }
}

// Whether the stored reviewer may take the next brief: it runs the model the conversation's choice names, which is the id the choice resolves to now (`sameModel`, through the stored ids where the choice is an alias). A reviewer spawned for the choice the conversation holds is always kept; one that runs a known id is kept when that is the choice's id; one whose id is not known (no spawn result yet, or no full id) is kept when the ids of its name and of the choice's are both known and equal; any other is let go.
export const keeps = (c: Conversation, ids: ModelIds): boolean => {
  const compared = comparedOf(c)
  return compared === undefined || sameModel(compared.held, compared.chosen, ids)
}

// Whether judging the stored reviewer needs the stored ids: only where the comparison has an alias in it, since an unchanged choice is kept whatever the ids say and two full ids compare by themselves. A caller reads them before its change, whose callback is synchronous, and only then.
export const needsIds = (c: Conversation): boolean => {
  const compared = comparedOf(c)
  return compared !== undefined && !(isFullId(compared.held) && isFullId(compared.chosen))
}

// The dispatch's half of a model switch: the stored reviewer let go (`model switch`) when it is not kept. It covers what the switch itself could not: a reviewer that was mid-review at the switch and has settled since, and a spawn in flight at the switch that landed on the old model.
export const letGoSwitched = (c: Conversation, ids: ModelIds): Release => (c.reviewer === undefined || keeps(c, ids) ? { next: c, released: undefined } : letGo(c, 'model switch', c.reviewer.id))

// The switch's own half: the stored reviewer let go at once when it is idle, as the idle timer judges it, so it does not wait out its cache's life. A reviewer that is busy finishes on its old model, and the dispatch check (`letGoSwitched`) lets it go after.
export const letGoSwitchedIdle = (c: Conversation, ids: ModelIds): Release => (idleTimerOf(c) === undefined ? { next: c, released: undefined } : letGoSwitched(c, ids))

// The choice and the resolved model a review's log names.
export type ReviewModels = { configured: string | null; resolved: string | null }

// The choice comes from the reviewer that held the review; with none, from the spawn in flight for the review's number (a lapse with no start); with neither, it is the conversation's choice, and null where there is none. The resolved model is the reviewer's, null where it holds none.
export const reviewModels = (c: Conversation, number: number): ReviewModels => {
  const spawn = [...c.spawnsInFlight].reverse().find(s => s.number === number)
  return { configured: c.reviewer?.choice ?? spawn?.choice ?? c.choice ?? null, resolved: resolvedOf(c) ?? null }
}

// The model a compaction by reviewer `agentId` is priced at: the model recorded for that id, a former reviewer's from before a /clear included; else, for the stored reviewer whose spawn result never landed, the id its choice gets from the chain; else undefined, which the tally reads as an unknown model.
export const compactionModel = (c: Conversation, agentId: string, ids: ModelIds): string | undefined => {
  const recorded = c.reviewerModels[agentId] || (c.reviewer?.id === agentId ? c.reviewer.model : '')
  if (recorded) return recorded
  return c.reviewer?.id === agentId && c.reviewer.choice !== undefined ? idOf(c.reviewer.choice, ids) : undefined
}

// The reviewer markers a /clear keeps: they mark traffic, not a review, and the models its reviewers ran on, which a late compaction is priced at.
export const markers = (c: Conversation): Pick<Conversation, 'reviewerIds' | 'reviewerNames' | 'reviewerModels'> => ({ reviewerIds: c.reviewerIds, reviewerNames: c.reviewerNames, reviewerModels: c.reviewerModels })

// The agent list's statuses that are in flight. A waiting agent is held on background work it owns, or on a plan's approval, and resumes by itself or by a message it can send the worker.
export const WORKING: readonly string[] = ['pending', 'running', 'waiting']

// The statuses of an agent a stop has not ended: in flight, or idle between turns. The ended ones are `completed`, `failed` and `killed`, and an agent the list does not show; a stopped reviewer was measured absent from the list (engine 2.1.311).
const NOT_ENDED: readonly string[] = [...WORKING, 'idle']

// Whether a stop missed, and why in words for the debug log: the engine refused it, or took it and the list still shows the agent not ended. A list that could not be read says nothing against a stop the engine took.
export const stopMissed = (refused: boolean, listed: readonly AgentInfo[] | undefined, id: string): string | undefined => {
  if (refused) return 'the engine refused it'
  const status = listed?.find(a => a.id === id)?.status
  return status !== undefined && NOT_ENDED.includes(status) ? `the list still shows it ${status}` : undefined
}

// The ids an idle sweep stops: the listed reviewers that are idle, that the state knows and does not store. The list shows every reviewer of the process whatever conversation it served, and no field of an entry tells conversations apart (the team follows the process's first session, not `$.session.id()`; measured on engine 2.1.311), so an entry counts only when its id is one the state knows, and the state keeps those across a /clear. A reviewer whose spawn is in flight has no stored id yet, so nothing is swept while one is.
export const sweepable = (c: Conversation, listed: readonly AgentInfo[]): string[] =>
  c.spawnsInFlight.length > 0 ? [] : listed.filter(a => a.status === 'idle' && standingOf(c, a.id) === 'former').map(a => a.id)
