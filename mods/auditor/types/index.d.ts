// Token counts of one reviewer turn.
export type ReviewUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

// A reviewer's turn end: when it arrived, and the engine's answer (the report), reason, duration and usage for that turn.
export type TurnEnd = { at: number; answer: string; reason: string; durationMs: number; usage: ReviewUsage | null }

// The open review, from the dispatch that briefed the reviewer until its turn ends. Its number is that dispatch's number.
export type OpenReview = {
  number: number
  // The worker's record as it stood at the dispatch: one block per entry.
  record: string[]
  dispatchedAt: number
  // Whether the brief said nothing will wake the worker. Only a stall note from such a review is delivered.
  nothingWakes: boolean
}

// The worker's record since the reviewer's last dispatch: one numbered block per entry, in order.
export type TurnRecord = { blocks: string[] }

// A note held for the worker. It is submitted as soon as its review settles while the worker is idle, else it goes out at the worker's next tool batch or turn end; an interrupt or a dropped submit holds it for the user's next prompt instead (Conversation's `interrupted` and `dropped`). A stall note also arms the once-per-stall guard.
export type PendingNote = { number: number; text: string; stall: boolean }

// A stall fact: what is in flight at the worker's Stop that will wake it. Each is spelled `type "description"`: a working agent or a teammate the worker messaged, from the agent list, then Stop's other tasks; the reviewer's own agents are left out.
export type Wake = { tasks: string[]; crons: number }

// What started a worker turn: the user's own prompt (typed, from a Remote Control client, or a headless run's), a reviewer's task notification, or anything else.
export type TurnStart = 'user' | 'notice' | 'other'

// One conversation, from a /clear or resume to the next. A /clear forgets its reviewer and open review.
export type Conversation = {
  // Dispatches this session has made. Numbers carry across /clear, since a session's logs share one directory.
  dispatches: number
  // Whether the worker is mid-turn: a prompt entered its main loop and that loop's turn has not ended.
  midTurn: boolean
  // Notes held for the worker, oldest first; PendingNote says when they go out.
  pendingNotes: PendingNote[]
  // Whether the user interrupted the worker's latest turn: the notes wait for the user's next prompt that is not a slash command, which carries them and clears it, so no flush or tool batch takes them meanwhile.
  interrupted: boolean
  // Whether a submit another hook dropped holds the notes from submits: they wait for the user's next prompt that is not a slash command, which carries them and clears it. A tool batch still appends them.
  dropped: boolean
  // Whether the band's button has the reviewer off: no review is dispatched and the record stops collecting.
  off: boolean
  // The worker's last message, which each brief names.
  lastMessage: string
  // The session transcript's path from the engine's events; a session end clears it, so a /clear keeps it only if the engine reports it again.
  transcript: string | null
  // The reviewer, once its spawn result names it.
  reviewer?: { id: string; model: string }
  // Every reviewer id this conversation's spawns have returned, oldest first: a respawned reviewer's finished row is hidden too.
  reviewerIds: string[]
  // The team name each of this conversation's reviewer spawns runs under, as the agent list names it (the engine renames a taken name): a verified delivery from one of these is reviewer traffic.
  reviewerNames: string[]
  // The current reviewer's context at its last request (input, cache-read and cache-write tokens): past ROTATE_AT it is retired at its review's end and the next dispatch spawns a fresh one.
  reviewerContext: number
  // The last notes delivered to the worker this conversation, framed, oldest first: a fresh reviewer's first brief carries them.
  deliveredNotes: string[]
  // The reviewer's open review, if it has one.
  review?: OpenReview
  // Whether the last review failed and none has succeeded since: no review is dispatched until a turn the user's own prompt started ends.
  failing: boolean
  // What started the worker's latest turn. A turn a reviewer's task notification started records nothing and dispatches nothing at its end.
  turnStart: TurnStart | null
  // The stall fact the worker's latest Stop gave, which the brief states. Null when the guards withheld it, a Stop omitted a list, the agent list was unread, or an aborted turn cleared it.
  wake: Wake | null
  // Whether the worker's latest main-loop tool call asked the user: AskUserQuestion, or a human_items add. A subagent's call leaves it as it was. Reset at each worker turn end.
  lastAsked: boolean
  // The addresses the worker's main-loop SendMessage calls named in this turn: a message wakes its recipient whatever its status. Reset at each worker turn end.
  messaged: string[]
  // Whether a stall note from a review dispatched after the user's latest own prompt has been delivered since that prompt, /clear or toggle: one nudge per stall.
  nudged: boolean
  // The dispatch count when the user's latest own prompt arrived, or the last /clear or toggle press: a review numbered above it was dispatched after that point.
  dispatchesAtPrompt: number
  // The worker's record since the reviewer's last dispatch.
  record: TurnRecord
  // What each of the worker's own subagents is labelled as, by agent id.
  subagents: Record<string, { type: string; name: string }>
  // Briefs this plugin is delivering, whose SendMessage or Agent call has not yet reached the recorder: that call is the plugin's, not the worker's.
  briefsInFlight: string[]
}

declare module 'claude-code' {
  interface PluginState {
    auditor: {
      conversation: Conversation
    }
  }
}

// The mod's own deferred tools, which no connected server lists: merged into the engine's tool inputs so a tool.call narrows to them. Typed unknown, since the reviewer model writes them and the hook checks each one.
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__auditor__entries': { which: unknown; from?: unknown }
    'mcp__auditor__transcript': { search?: unknown; line?: unknown; full?: unknown; from?: unknown }
  }
}
