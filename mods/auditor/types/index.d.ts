// Token counts of one reviewer turn.
export type ReviewUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

// A reviewer's turn end: when it arrived, and the engine's answer (the reviewer's one-line status, never delivered), reason, duration and usage for that turn.
export type TurnEnd = { at: number; answer: string; reason: string; durationMs: number; usage: ReviewUsage | null }

// The open review, from the dispatch that briefed the reviewer until a reviewer turn end settles it: a review whose reviewer wrote its note as its answer stays open across that turn end, for its one follow-up. Its number is that dispatch's number.
export type OpenReview = {
  number: number
  // The worker's record as it stood at the dispatch: one block per entry.
  record: string[]
  dispatchedAt: number
  // Whether the brief said nothing will wake the worker. Only such a review's reviewer may send a stall note; the gate refuses one from any other.
  nothingWakes: boolean
  // The note slot: the body of the one note the gate let through for this review, held from its admission and kept once its send is delivered or the note is held for the user's next prompt (`pendingNotes`). Absent means no note, as in a state stored before the slot existed.
  note?: string
  // Set once the note in the slot is reported delivered while the review is open: a review that closes without it, a held note's included, logs its note as not delivered. Absent means the note's send has not reported delivered while the review was open, as in a state stored before this field existed.
  delivered?: boolean
  // Set when the review has had its one follow-up, asking a reviewer that wrote its note as its answer to send it. Absent means it has had none, as in a state stored before the mark existed.
  followedUp?: boolean
}

// Why the reviewer is failing: a review ended without an answer, none could be handed to a reviewer, a spawn did not start in time, or a state stored before causes existed. Every place that sets `failing` sets one of these, or adds a row for its own cause to the words in button.ts in the same change.
export type FailCause = 'no answer' | 'not dispatched' | 'no start' | 'unknown'

// Why a reviewer was let go, which `letGo` in reviewer.ts decides: its context passed the rotation limit, the toggle switched off, the session ended, its brief was refused, or its spawn landed after it was no longer wanted.
export type LetGoReason = 'rotation' | 'switch off' | 'session end' | 'refused brief' | 'stale landing'

// The last completed review: when it closed (the clock's time) and whether it gave a note.
export type LastReview = { at: number; note: boolean }

// A note held for the worker's next prompt: the engine refused its send in its stopped-session state, by the refusal's wording or because the interrupt mark was set. It rides beside the user's next own prompt (a slash command never carries it), framed as its review line then its body, and carries no stall mark: the stall guard is armed when the note is held. A stored state may still give a note a `stall` mark; nothing reads it.
export type PendingNote = { number: number; text: string }

// The worker's record since the reviewer's last dispatch: one numbered block per entry, in order.
export type TurnRecord = { blocks: string[] }

// A stall fact: what is in flight at the worker's Stop that will wake it. Each is spelled `type "description"`: a working agent or a teammate the worker messaged, from the agent list, then Stop's other tasks; the reviewer's own agents are left out.
export type Wake = { tasks: string[]; crons: number }

// One entry of the handoff doc: the body of a note delivered or held for the worker, clipped to 2,000 characters, keyed by the number of the review that gave it. Review numbers never repeat and a review gives at most one note, so the number names its entry. The plugin adds an entry, in flight; the reviewer only settles or removes one, through its memory tool. `touched` is the number of the review that last touched it, the one that settled it last; absent means its key. An entry is in flight or settled: absent `kind` means in flight, as in an entry stored before kinds existed. A settled entry holds the reviewer's reason for settling it, `why`, the worker's counter and where it is.
export type MemoryEntry = { number: number; text: string; touched?: number } & ({ kind?: 'in flight' } | { kind: 'settled'; why: string })

// What started a worker turn: the user's own prompt (typed, from a Remote Control client, or a headless run's), a reviewer's task notification, or anything else.
export type TurnStart = 'user' | 'notice' | 'other'

// One conversation, from a /clear or resume to the next. A /clear forgets its current reviewer, its open review and that review's note slot; it keeps the reviewer markers (`reviewerIds`, `reviewerNames`), which mark traffic, not a review.
export type Conversation = {
  // Dispatches this session has made. Numbers carry across /clear, since a session's logs share one directory, and never repeat: a send naming an older number is a former reviewer's.
  dispatches: number
  // Whether the worker is mid-turn: a prompt entered its main loop and that loop's turn has not ended.
  midTurn: boolean
  // Notes held for the user's next own prompt, oldest first (`PendingNote`). Switching off empties the list, and a /clear starts it empty.
  pendingNotes: PendingNote[]
  // The interrupt mark: set when the worker's turn ends aborted, and cleared at the user's next own prompt (the prompt that takes the held notes), at switch-on and at /clear. A slash command, a plugin's prompt or a peer prompt leaves it set. While it is set, a note whose send the engine refuses is held rather than released.
  interrupted: boolean
  // Whether the toggle has the reviewer off: no review is open or dispatched, every reviewer send is refused, and the record stops collecting. A note whose send was let through before the switch may still reach the worker after it.
  off: boolean
  // The count of resets (each switch of the toggle, and each session end): a write carrying content taken under an older epoch is dropped, even when a switch was undone since.
  epoch: number
  // The worker's last message, which each brief names.
  lastMessage: string
  // The session transcript's path from the engine's events; a session end clears it, so a /clear keeps it only if the engine reports it again.
  transcript: string | null
  // The current reviewer, once its spawn result names it or a call it makes is adopted by name. The state-based answer (`standingOf` in reviewer.ts) reads it for `current`: only this id settles a review, calls the reviewer's tools or has its context counted.
  reviewer?: { id: string; model: string }
  // Every reviewer id this session's spawns have returned, oldest first, kept across /clear. The state-based answer reads it for `former`: an id here that is not the stored reviewer's is a retired, switched-off, forgotten or stale reviewer's, and is still a reviewer's wherever the answer asks for any reviewer: its task row is hidden, its calls stay out of the record, its compaction keeps what a reviewer keeps, and the agent list's entry for it is left out of the stall fact.
  reviewerIds: string[]
  // The team name each of this session's reviewer spawns runs under, as the agent list names it (the engine renames a taken name), kept across /clear: the name decisions in reviewer.ts read them, and a verified end-of-run notice from one of these is consumed.
  reviewerNames: string[]
  // Why the latest reviewer was let go, kept across /clear: the /clear's own let-go is why the next brief goes to a spawn. Absent until a reviewer is let go; a switch on does not clear it.
  lastLetGo?: LetGoReason
  // The current reviewer's context at its last request (input, cache-read and cache-write tokens): past ROTATE_AT it is retired when its review is taken, never at a turn end that gives the review its follow-up, and the next dispatch spawns a fresh one.
  reviewerContext: number
  // The reviewer's memory of this conversation, the handoff doc: one entry per note booked, oldest first. The plugin adds an entry when a note is booked, delivered or held, and never for a `Stalled:` note; an `Escalation:` note is kept. The current reviewer settles or removes an entry with its memory tool while its review is open, and does nothing else to it. At each dispatch it drops the entries last touched more than 30 reviews below the new review's number, then, while the rendering exceeds 12,000 characters, evicts the oldest-touched settled entry, or the oldest-touched in-flight one once none is settled, and every brief carries what remains; between dispatches it may run over the cap. It never reaches the worker. A /clear and a switch to on start it empty; a switch to off and a /compact of the worker leave it as it is, and while off it takes no entry.
  memory: MemoryEntry[]
  // The reviewer's open review, if it has one.
  review?: OpenReview
  // Each reviewer spawn still in flight, by the brief it was spawned with, the epoch it was spawned under, the number of the review it serves, the clock's time its dispatch started, and the id and resolved model once the spawn hook has seen it: a dispatch whose spawn result names no agent takes its id from here. No reset clears it, so a spawn a reset dropped still finds the id it is stopped by (`deliverBrief`). `learn`, `adopt` and `land` in reviewer.ts read and write it. Its landing takes it out (`releaseSpawn`). A review no reviewer has stood in for `SPAWN_TIMEOUT_MS` after its dispatch fails at the next dispatch (`dispatchIdle`).
  spawnsInFlight: { brief: string; epoch: number; number: number; startedAt: number; id?: string; model?: string }[]
  // Why the last review failed, while none has succeeded since: no review is dispatched until a turn the user's own prompt started ends. Absent means not failing. A state stored before causes existed holds `true` (read as the unknown cause) or `false` (not failing).
  failing?: FailCause | boolean
  // What started the worker's latest turn. A turn a reviewer's task notification started records nothing and dispatches nothing at its end.
  turnStart: TurnStart | null
  // The stall fact the worker's latest Stop gave, which the brief states. Null when the guards withheld it, a Stop omitted a list, the agent list was unread, or an aborted turn cleared it: a turn whose main loop sent a broadcast gets no stall verdict.
  wake: Wake | null
  // Whether the worker's latest main-loop tool call asked the user: AskUserQuestion, or a human_items add. A subagent's call leaves it as it was. Reset at each worker turn end.
  lastAsked: boolean
  // The addresses the worker's main-loop SendMessage calls named in this turn: a message wakes its recipient whatever its status. A broadcast (`"*"`) names no agent, so a turn that sent one gets no stall verdict. Reset at each worker turn end.
  messaged: string[]
  // Whether a stall note from a review dispatched after the user's latest own prompt has been let through and delivered since that prompt, /clear or toggle: one nudge per stall.
  nudged: boolean
  // The dispatch count when the user's latest own prompt arrived, or the last /clear or toggle press: a review numbered above it was dispatched after that point.
  dispatchesAtPrompt: number
  // What the auditor's reviewers have spent, in US dollars at API list prices (pricing.ts), since this conversation began or the auditor was last switched on: every response of every reviewer this session spawned and every reviewer compaction's own request, while on. Switching off empties it, and a fresh conversation starts it empty (the `session.end` reset in register.ts, the one place that decides which session ends restart it).
  spent: number
  // Reviews completed since this conversation began or the auditor was last switched on, a complete one with a note or quiet; an incomplete one is not counted. Restarts with the tally (`purged`, and the `session.end` reset).
  reviews: number
  // Notes given since the same point: each note booked, delivered or held for the next prompt, a stall note's and an escalation's included.
  notes: number
  // The last completed review. Absent while none has completed since the same point.
  last?: LastReview
  // The model id that made the cost unknown: a response or a compaction priced at a model pricing.ts has no rate for. Null while every figure was priced; once set it stays until the tally restarts, and `spent` stops growing.
  unpriced: string | null
  // The worker's record since the reviewer's last dispatch.
  record: TurnRecord
  // What each of the worker's own subagents is labelled as, by agent id.
  subagents: Record<string, { type: string; name: string }>
  // Briefs and follow-ups this plugin is delivering to a reviewer, whose SendMessage or Agent call has not yet reached the recorder: that call is the plugin's, not the worker's.
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
    'mcp__auditor__memory': { action: unknown; review: unknown; why: unknown }
  }
}
