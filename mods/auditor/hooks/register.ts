import type { AgentInfo, AgentSpawnResult, CoreEngineInterface, ProcessRunResult, Register, TurnUsage } from 'claude-code'
import { update } from 'claude-code'
import type { BriefTo, Conversation, FailCause, OpenReview, PendingNote, ReviewUsage, TurnEnd, TurnRecord, TurnStart, Wake } from '../types/index'
import { PLUGIN, recordFailed, within } from './boundary'
import { readChoices } from './catalog'
import { MEMORY, MEMORY_ACTION, MEMORY_FIELD, MEMORY_LOG_CHARS, REVIEW_ENDED, WHY_CHARS, bounded, changeMemory, printMemory, renderMemory, withNote } from './memory'
import type { MemoryChange } from './memory'
import { answerOf, buttonOf } from './button'
import type { Figures } from './button'
import { MAIN, admitSend, decideRefusal, followUpText, frameNote, isStoppedRefusal, marksOf, readSend, settleOutcome } from './notes'
import type { Decided, Outcome, Refusal, Sent, Verdict } from './notes'
import { REVIEWER_PROMPT } from './prompt'
import { clip, editedLines, entryBlock, pageOf, renumberBlock, toolLine } from './record'
import { DEFAULT_MODEL, FALLBACK_CHOICES, isFullId, takeChoice } from './models'
import type { Choices, ModelIds } from './models'
import { adopt, compactionModel, idleTimerOf, isEndNotice, isHandBack, isNotice, isReviewerEntry, land, lapseOf, learn, learnName, letGo, letGoSwitched, markers, nameKnown, nameListed, needsIds, originOf, reapIdle, reviewModels, reviewerNameOf, spawnChoice, spawnName, spawning, standingOf, stopMissed, sweepable, WORKING, withTurnEnd } from './reviewer'
import type { Identity, IdleTimer, Release, ReviewModels } from './reviewer'
import { readLastModel, readModelIds, storeModelId } from './store'
import { purged, withCompaction, withNoteGiven, withResponse, withReviewDone } from './tally'
import { DIGEST_CHARS, LOOKUP_TIMEOUT_MS, SEARCH_TERM_CHARS, digestBlocks, digestOf, lineCommand, lookupOf, parseSearch, renderSearch, searchCommand } from './transcript'

const REVIEWER = 'auditor-reviewer'
const REVIEWER_TYPE = `${PLUGIN}:reviewer`
// What the spawn is described as, which the engine's task notification for the reviewer names.
const REVIEW_DESCRIPTION = 'auditor review'
// The literals `reviewer.ts` tests against; the plugin's identity stays with this file.
const IDENTITY: Identity = { plugin: PLUGIN, name: REVIEWER, description: REVIEW_DESCRIPTION }
const REVIEWER_EFFORT = 'high'
const CONV = { plugin: 'auditor', key: 'conversation' } as const
const TOGGLE = 'auditor-toggle'
const ENTRIES = 'mcp__auditor__entries'
const TRANSCRIPT = 'mcp__auditor__transcript'
const HUMAN_ITEMS = 'mcp__human-plugin__human_items'
const REFUSED = `this tool serves only auditor's reviewers their open review's record; it is not for this agent`
const NO_TRANSCRIPT = 'auditor has no session transcript to look in yet, so there is nothing to find'
const NO_LOOKUP = 'auditor could not look in the session transcript; the lookup did not run'
const ESCALATED = 'auditor: the reviewer escalated a disagreement; see its note to the worker'
// A push is cut here: phones truncate a notification past about 200 characters.
const PUSH_CHARS = 180
// A reviewer whose context passed this many tokens is retired when its review is taken (`takeReview`), not at a turn end that gives the review its follow-up: under Haiku 5.5's 100,000-token price tier, with room for one review's growth. It sits above the engine's own compaction of the reviewer (about 64-68k, measured), so it fires only when a reviewer jumps past 80k in one review; it is the backstop for that jump.
const ROTATE_AT = 80_000
// How long a reviewer spawn may stay in flight before it is given up (`spawnsInFlight`).
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000
// How long a stored reviewer may hold a review open before it is given up (`dispatchIdle`): four times the longest review logged, and its own limit so that changing it does not change how long a spawn may take (`SPAWN_TIMEOUT_MS` also bounds adoption).
const REVIEW_TIMEOUT_MS = 10 * 60 * 1000
// How long a reviewer may sit idle before it is let go (`armReap`): the life of its prompt cache, after which a brief to it re-writes its whole context where a fresh spawn writes only its prompt and the brief.
const CACHE_LIFE_MS = 5 * 60 * 1000
// The reason a review the stopped session refused is logged incomplete with (`giveBack`).
const GIVEN_BACK = 'given back: the session was stopped'
// The reason a review is logged incomplete with when no spawn stood a reviewer in for it in SPAWN_TIMEOUT_MS (`dispatchIdle`).
const SPAWN_LAPSED = `reviewer spawn did not settle in ${SPAWN_TIMEOUT_MS / 60_000} minutes`
// The reason a review is logged incomplete with when its stored reviewer had not ended its turn in REVIEW_TIMEOUT_MS (`dispatchIdle`).
const REVIEW_LAPSED = `reviewer did not finish in ${REVIEW_TIMEOUT_MS / 60_000} minutes`
// What a compaction of the reviewer's own conversation keeps: the facts its judgement rests on, not the reviews that found nothing. Neither its notes nor its disputes: the memory every brief carries is their one record.
const REVIEWER_COMPACTION = 'You are the auditor reviewer. Keep: every instruction, rule and preference of the user you have found, with where it was given. Drop: the details of reviews that found nothing to note.'
// The reason a known reviewer's end-of-run notice is consumed with.
const END_NOTICE = 'auditor reviewer end-of-run notice'
// The reason the reviewer reads when its send is refused because the gate could not read the conversation.
const UNCHECKED = 'auditor could not check this message, so it was not sent'
const INTERRUPTED = 'INTERRUPTED: the user stopped this turn before it finished.'
const NONE_INTERRUPTED = '(none: the user interrupted the turn)'
const EMPTY_RECORD: TurnRecord = { blocks: [] }
// How long a reviewer stop with its check, or an idle sweep, may run before it is given up (`withinTime`): both are started and left to run, and an engine call of theirs that never answered would otherwise hold their guard (`stopsRunning`, `sweeping`) until a reload.
const BACKGROUND_TIMEOUT_MS = 90_000

type Scope = Pick<CoreEngineInterface, 'state' | 'ui' | 'clock' | 'fs' | 'env' | 'session' | 'prompt' | 'agent' | 'process' | 'tool' | 'store' | 'settings'>
// A complete review's `note`: the body the gate let through for it, or null for a quiet review.
type Ending = { status: 'complete'; note: string | null } | { status: 'incomplete'; reason: string }
// Held notes taken for an attach, and the `epoch` at the take.
type TakenNotes = { notes: readonly PendingNote[]; epoch: number }
// `models`: the choice and the resolved model the review's log names. `released`: the reviewer the take let go, when it did (a rotation or a failed review). `epoch`: the epoch at the take.
type Taken = { review: OpenReview; models: ReviewModels; released: string | undefined; epoch: number }
type Closed = { review: OpenReview; models: ReviewModels; turnEnd: TurnEnd | null }
type Finished = { answer: string; reason: string; isAborted: boolean; durationMs: number; usage?: TurnUsage }
// `epoch`: the epoch at the plan; `at`: the clock's time at the plan.
type Plan = { number: number; brief: string; send: string | undefined; epoch: number; at: number }

const fresh = (): Conversation => ({ dispatches: 0, off: false, epoch: 0, midTurn: false, pendingNotes: [], interrupted: false, lastMessage: '', transcript: null, record: EMPTY_RECORD, subagents: {}, briefsInFlight: [], turnStart: null, reviewerIds: [], reviewerNames: [], reviewerContext: 0, memory: [], reviewerModels: {}, spawnsInFlight: [], wake: null, lastAsked: false, messaged: [], nudged: false, dispatchesAtPrompt: 0, spent: 0, unpriced: null, reviews: 0, notes: 0 })

// The toggle, by the footer button or `/auditor`. Off stops the auditor at once: the open review is dropped with its note slot, the held notes are dropped and the reviewer is let go (`letGo`; `toggle` releases it), so the gate refuses every reviewer send from then on; a note let through before the switch may still arrive. Its ids still mark its traffic and rows, and its late turn end matches no reviewer. On starts an empty record, an empty memory and a fresh run, so no entry from the off period or before it is briefed, no memory entry about work the reviewer never saw is briefed either, a failure before it no longer holds the reviewer back, and an interrupt mark from before it holds no note refused for another reason. Either empties the tally (`purged`), so off shows no figures and on starts them from zero, and clears the stall guard. A switch moves the epoch (`epoch`); setting the state it already has changes nothing.
const switched = (c: Conversation, off: boolean): Release => {
  if (c.off === off) return { next: c, released: undefined }
  const moved = { ...c, epoch: c.epoch + 1, nudged: false, dispatchesAtPrompt: c.dispatches }
  if (!off) return { next: { ...purged(moved), off: false, record: EMPTY_RECORD, memory: [], failing: undefined, interrupted: false }, released: undefined }
  const { next, released } = letGo(moved, 'switch off', moved.reviewer?.id)
  return { next: { ...purged(next), off: true, review: undefined, pendingNotes: [] }, released }
}

// What the footer label and `/auditor` say: off by the toggle, failing until a review succeeds, else on.
const stateOf = (c: Conversation): 'on' | 'off' | 'failing' => (c.off ? 'off' : c.failing ? 'failing' : 'on')

// Why the reviewer is failing, if it is: the cause itself, or the unknown cause for a state stored before causes existed (`true`).
const causeOf = (c: Conversation): FailCause | undefined => (c.failing === true ? 'unknown' : c.failing || undefined)

// The words a drawing shows, in order: its strings, the labels of its buttons and links, and the text a leaf holds in its props (a Markdown's `text`, a Code's `source`, a picture's `alt`). A drawing with none shows nothing. Core's own drawing is an opaque `engine` node whose words are not in the tree: it reads as `engine`, the words core draws there.
const LEAF_WORDS = ['label', 'text', 'source', 'alt'] as const
const wordsOf = (node: unknown, engine: string): string => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(n => wordsOf(n, engine)).join('')
  if (typeof node !== 'object' || node === null) return ''
  const el = node as { type?: unknown; props?: Partial<Record<(typeof LEAF_WORDS)[number], unknown>>; children?: unknown }
  if (el.type === 'engine') return engine
  const own = LEAF_WORDS.map(prop => el.props?.[prop]).filter((word): word is string => typeof word === 'string')
  return own.join('') + wordsOf(el.children, engine)
}

// The session's total cost in US dollars from the engine's ledger (`/cost`'s figure), or undefined when it cannot be known: no `cost` (the host keeps no ledger), a figure that is not finite and non-negative, a rejected call, or no answer within BOUND_MS. The last two are logged. The one reader of the ledger: the footer and `/auditor` both go through `figuresOf`.
// Exported for its test, which calls it with a hand-made `$`: the test engine cannot make a hook's call reject.
export const readLedger = async ($: Pick<Scope, 'session' | 'clock' | 'ui'>): Promise<number | undefined> => {
  const read = await within($, 'session cost read', async () => (await $.session.usage()).cost?.usd)
  const usd = read?.value
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined
}

// What the button's words read for a conversation: its state and tally, and the session total where there is a share to show (off shows no figures, and nothing spent or an unknown cost has no share, so the ledger is not read for them).
const figuresOf = async ($: Pick<Scope, 'session' | 'clock' | 'ui'>, c: Conversation): Promise<Figures> => {
  const showsShare = !c.off && c.unpriced === null && c.spent > 0
  return { state: stateOf(c), spent: c.spent, unpriced: c.unpriced, total: showsShare ? await readLedger($) : undefined, reviews: c.reviews, notes: c.notes, last: c.last, cause: causeOf(c), held: c.pendingNotes.length }
}

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? ''

const sessionDir = async ($: Pick<CoreEngineInterface, 'env'>, sessionId: string): Promise<string> => {
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('HOME is unset, so there is no per-session directory')
  return `${home}/.claude/auditor/${sessionId}`
}

const numbered = (n: number): string => String(n).padStart(4, '0')

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// The engine's error for a tool call made where no session is bound (a headless run, or a process on its way out). It names itself in its message.
const NO_SESSION_BOUND = /no session is bound in this process/

// Whether `reason` is the engine's refusal of a stop whose id is no task, which a reviewer that is already gone is: "No task found with ID: <id>" for this very id, alone or inside a tool_use_error tag. Any other text, one that merely contains those words included, is a different refusal.
const noTaskFound = (reason: string, id: string): boolean => reason.trim().replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1').trim() === `No task found with ID: ${id}`

// The session end reasons of a process that is exiting (`/exit`, ctrl+c, ctrl+d; a `-p` run finished, or a signal); any other reason (`clear`, `resume`, `logout`) leaves the process going or costs a line at worst.
const EXIT_REASONS: readonly string[] = ['prompt_input_exit', 'other']

type Label = { type: string; name: string }

// A subagent as the record names it: its id, then its type and name where known.
const describeAgent = (id: string, label: Label | undefined): string => {
  const known = [label?.type ?? '', label?.name ?? ''].filter(part => part !== '')
  return known.length === 0 ? id : `${id} (${known.join(', ')})`
}

// The model-facing spelling is snake_case; the hook event carries the camelCase one.
const subagentTypeOf = (e: { subagentType?: string; subagent_type?: string }): string => e.subagentType ?? e.subagent_type ?? ''

const blankReview = (number: number, dispatchedAt: number, record: string[], nothingWakes: boolean): OpenReview => ({
  number,
  record,
  dispatchedAt,
  nothingWakes,
})

const usageOf = (turn: TurnUsage | undefined): ReviewUsage | null => {
  if (turn === undefined) return null
  return {
    input_tokens: turn.input_tokens,
    output_tokens: turn.output_tokens,
    cache_read_input_tokens: turn.cache_read_input_tokens,
    cache_creation_input_tokens: turn.cache_creation_input_tokens,
    model: turn.model,
  }
}

// A conversation state written before a field existed reads with that field's default.
const withDefaults = (c: Conversation): Conversation => {
  const stored = Object.fromEntries(Object.entries(c).filter(([, value]) => value !== undefined && value !== null))
  return { ...fresh(), ...stored }
}

// The transcript path an engine event carries, taken when it is there and kept otherwise.
const withTranscript = (c: Conversation, path: string | undefined): Conversation => (typeof path === 'string' ? { ...c, transcript: path } : c)

// The conversation is one state value; every change is one compare-and-set on it.
const readConversation = async ($: Pick<Scope, 'state'>): Promise<Conversation> => {
  const read = await $.state.get(CONV)
  return withDefaults(read.value ?? fresh())
}

const change = (
  $: Pick<Scope, 'state'>,
  fn: (c: Conversation) => Conversation,
): Promise<Conversation> => update($, CONV, c => fn(withDefaults(c ?? fresh())))

const logReview = async ($: Scope, sessionId: string, log: boolean, closed: Closed, ending: Ending): Promise<void> => {
  if (!log) return
  const { review, models, turnEnd } = closed
  try {
    const note = ending.status === 'complete' ? ending.note : (review.note ?? null)
    // The marks are read from the stored body, as the gate read them from the send.
    const marks = note === null ? { escalation: false, stall: false } : marksOf(note)
    const body = {
      status: ending.status,
      reason: ending.status === 'incomplete' ? ending.reason : null,
      number: review.number,
      claude_code_version: (await $.session.version()).version,
      record_entries: review.record.length,
      dispatched_at: review.dispatchedAt,
      usage: turnEnd === null ? null : turnEnd.usage,
      // The choice its reviewer was spawned for, and the model that spawn resolved to: per review, since a switch moves the next review's reviewer and not this one's.
      model_configured: models.configured,
      model_resolved: models.resolved,
      turn_end: turnEnd === null ? null : { at: turnEnd.at, answer: turnEnd.answer, reason: turnEnd.reason, duration_ms: turnEnd.durationMs },
      note,
      // Delivered as the gate saw it: the note's send reported delivered while its review was still open, which is not the worker having read it. A review that closed before its send reported delivery, dropped or settled while the send was out, logs its note as not delivered, though the note may still reach the worker.
      note_delivered: review.delivered === true,
      escalation: marks.escalation,
      stall: marks.stall,
      // What the review's brief said of waking the worker: only a review whose brief said nothing will may carry a stall note.
      nothing_wakes: review.nothingWakes === true,
      // Whether the review had its one follow-up, asking its reviewer to send a note it wrote as its answer.
      followed_up: review.followedUp === true,
      // Where the brief went: the stored reviewer, or a spawn and why. Null when no brief is known to have gone out.
      brief_to: review.briefTo ?? null,
    }
    await $.fs.write(`${await sessionDir($, sessionId)}/${numbered(review.number)}.json`, JSON.stringify(body))
  } catch (err) {
    recordFailed($, 'review log', err)
  }
}

// A review as its log reads it when its brief is not known to have reached a reviewer: without its route.
const withoutRoute = ({ briefTo: _route, ...review }: OpenReview): OpenReview => review

// Logs a review that closed with no reviewer turn end as incomplete.
const logIncomplete = ($: Scope, sessionId: string, log: boolean, review: OpenReview, models: ReviewModels, reason: string): Promise<void> =>
  logReview($, sessionId, log, { review, models, turnEnd: null }, { status: 'incomplete', reason })

// Logs as incomplete the open review a conversation dropped (a switch to off, a session end), when it had one.
const logDropped = async ($: Scope, sessionId: string, log: boolean, c: Conversation, reason: string): Promise<void> => {
  if (c.review !== undefined) await logIncomplete($, sessionId, log, c.review, reviewModels(c, c.review.number), reason)
}

// The entries of a review that ended without an answer go back to the front of the record, ahead of those recorded since.
const withEntriesFirst = (entries: readonly string[], record: TurnRecord): TurnRecord => {
  const { blocks } = record
  return { blocks: [...entries, ...blocks.map((block, i) => renumberBlock(block, entries.length + i + 1))] }
}

// The conversation as it is now: read through a change, which writes the state back unchanged. A plain get answers the dispatch's starting moment; no read in the dispatch sees the writes made since it began, its own or another dispatch's, except a change.
const currentConversation = ($: Pick<Scope, 'state'>): Promise<Conversation> => change($, c => c)

const stopFailed = ($: Pick<Scope, 'ui'>, err: unknown): void => {
  if (NO_SESSION_BOUND.test(reasonOf(err))) $.ui.log(`${PLUGIN}: reviewer stop skipped: no session is bound in this mode`, { to: 'debug' })
  else recordFailed($, 'reviewer stop', err)
}

// One TaskStop of `id`: whether the engine took it ('ok'), refused it ('refused', logged), answered that the id is no task ('gone', logged: the reviewer is already gone, so there is nothing to stop again), or the call threw ('threw', logged).
const issueStop = async ($: Pick<Scope, 'tool' | 'ui'>, id: string): Promise<'ok' | 'refused' | 'gone' | 'threw'> => {
  try {
    const result = await $.tool.call({ tool: 'TaskStop', task_id: id })
    if (result.deny === undefined && result.isError !== true) return 'ok'
    const reason = result.deny ?? result.text ?? ''
    $.ui.log(`${PLUGIN}: reviewer stop refused: ${reason}`, { to: 'debug' })
    return noTaskFound(reason, id) ? 'gone' : 'refused'
  } catch (err) {
    stopFailed($, err)
    return 'threw'
  }
}

// The stop the caller has issued (`first`) and its check: the agent list is read after each stop, and the stop is issued once more when the engine refused it or the list still shows the reviewer not ended (`stopMissed`); a second miss logs one line naming the reviewer as left running. A stop the engine answers with no task found (`gone`) is not a miss: the reviewer is already gone, so it is neither retried nor named as left running. An id the state holds as the current reviewer by then is not stopped again (`stopReviewer`). A thrown stop is not checked: it is logged and, with no session bound, the list is no more readable than the stop was. Any failure is logged and ends the check. Work that has been given up (`given`) issues and logs nothing further.
const verifyStop = async ($: Pick<Scope, 'agent' | 'state' | 'tool' | 'ui'>, id: string, first: 'ok' | 'refused', given: GivenUp): Promise<void> => {
  try {
    const missed = stopMissed(first === 'refused', await listAgents($), id)
    if (missed === undefined) return
    if (standingOf(await currentConversation($), id) === 'current' || given.up) return
    $.ui.log(`${PLUGIN}: reviewer ${id} was not stopped: ${missed}; stopping it once more`, { to: 'debug' })
    const second = await issueStop($, id)
    if (second === 'threw' || second === 'gone') return
    if (stopMissed(second === 'refused', await listAgents($), id) !== undefined && !given.up) $.ui.log(`${PLUGIN}: reviewer ${id} left running: two stops did not end it`, { to: 'debug' })
  } catch (err) {
    recordFailed($, 'reviewer stop check', err)
  }
}

// Set by `withinTime` when the work it runs is given up.
type GivenUp = { up: boolean }

// Runs `run`, a stop with its check or a sweep, and waits for it for at most BACKGROUND_TIMEOUT_MS and then gives it up with one plain line naming `what`; `run` is handed a flag (`given`) that is set once it is given up: what is still running then checks it before each stop and each retry, and issues and logs nothing further, so a sweep given up does not stop beside the next one and a stop given up does not retry beside a newer one. A call of its that never answers is left to hang. Resolves whatever the work does: a failure of its own was logged where it happened, and a log that throws has nowhere to be recorded. Where no timer can be set the work is not waited for at all: one plain line says so, and the work is left to finish or hang, its flag unset, so a call that never answers holds nothing. What the wait would have held is then not held: the guard against a second stop of an id (`stopReviewer`) and the one-at-a-time queue of sweeps (`sweepIdle`) are not kept, and a stop issued again meanwhile is answered "No task found" at worst.
const withinTime = async ($: Pick<Scope, 'clock' | 'ui'>, what: string, run: (given: GivenUp) => Promise<void>): Promise<void> => {
  const given: GivenUp = { up: false }
  const finished = run(given).then(() => 'done' as const, () => 'done' as const)
  let late: () => void = () => undefined
  const timeout = new Promise<'late'>(resolve => {
    late = () => resolve('late')
  })
  let timer: { cancel: () => void }
  try {
    timer = $.clock.after(BACKGROUND_TIMEOUT_MS, late)
  } catch {
    try {
      $.ui.log(`${PLUGIN}: ${what} not waited: no timer could be set`, { to: 'debug' })
    } catch {
      // The line could not be written.
    }
    return
  }
  try {
    if ((await Promise.race([finished, timeout])) === 'late') {
      given.up = true
      $.ui.log(`${PLUGIN}: ${what} gave up: no answer within ${BACKGROUND_TIMEOUT_MS} ms`, { to: 'debug' })
    }
  } catch {
    // The give-up line could not be written.
  } finally {
    try {
      timer.cancel()
    } catch {
      // A timer that cannot be cancelled fires into a flag nobody reads.
    }
  }
}

// The stop of `id` and, where a respawn can follow, its check; a failure of either is logged as a stop failure.
const stopAndCheck = async ($: Pick<Scope, 'agent' | 'state' | 'tool' | 'ui'>, id: string, mayRespawn: boolean, given: GivenUp): Promise<void> => {
  try {
    const outcome = await issueStop($, id)
    if (mayRespawn && outcome !== 'threw' && outcome !== 'gone' && !given.up) await verifyStop($, id, outcome, given)
  } catch (err) {
    stopFailed($, err)
  }
}

// The reviewer ids whose stop, with its check, is still running in this process. A hot reload starts the module over with none.
const stopsRunning = new Set<string>()

// Stops a reviewer the auditor lets go (`letGo`: one a take rotated out or a failed review ended, one a session end forgot, one a refused brief dropped, one whose spawn rejected after its id was learned, one whose review lapsed, one that sat idle past its cache's life, or one the toggle switched off or whose spawn landed after it), so it does not sit idle for the rest of the session; each caller says when it issues it. The engine call is not awaited, so no caller's settle or dispatch waits on it or on its check; the helper resolves once the stop is issued. Any failure, the state read included, is logged and leaves the reviewer idle, and the caller goes on; the engine's no-session-bound error is the expected failure where no session is bound, and is logged as one plain line. Where a respawn can follow (`mayRespawn`), an id the state holds as the current reviewer is not stopped: a fresh reviewer can come back under a forgotten id, and the stop would end it. Such a stop is checked against the agent list and retried once (`verifyStop`; a stopped reviewer was measured absent from the list, or `killed`). A session end spawns none and runs under a short wall-clock bound, so it passes false: its one stop is not checked. Its reset may also have failed, and then the state still names the reviewer it forgot. Where a respawn can follow, an id whose stop and check are still running (`stopsRunning`, for at most BACKGROUND_TIMEOUT_MS; not kept without a timer, see `withinTime`) is not stopped again, whoever asks: a sweep that overlaps a reap, a lapse, a rotation or another sweep issues no duplicate. A session end's one stop neither reads nor enters that set, so it always issues, since the one in flight may be parked or hung, and it cannot release the guard another stop owns. A caller that has been given up (`caller`) and is still parked in the helper's state read issues no stop either.
export const stopReviewer = async ($: Pick<Scope, 'agent' | 'clock' | 'state' | 'tool' | 'ui'>, id: string | undefined, mayRespawn: boolean, caller?: GivenUp): Promise<void> => {
  if (id === undefined || (mayRespawn && stopsRunning.has(id))) return
  try {
    // A plain get would miss a spawn this dispatch made under the id (currentConversation).
    if (mayRespawn && standingOf(await currentConversation($), id) === 'current') return
    // The read above yielded, so the guard is read again before it is set, and so is the caller's flag: a caller given up while parked here (`caller`, a sweep's) issues nothing.
    if ((mayRespawn && stopsRunning.has(id)) || caller?.up === true) return
    if (mayRespawn) stopsRunning.add(id)
    void withinTime($, `reviewer ${id}'s stop`, given => stopAndCheck($, id, mayRespawn, given)).finally(() => mayRespawn && stopsRunning.delete(id))
  } catch (err) {
    stopFailed($, err)
  }
}

const sweepOnce = async ($: Pick<Scope, 'agent' | 'clock' | 'state' | 'tool' | 'ui'>, stopping: string | undefined, given: GivenUp): Promise<void> => {
  // The list as read now, or undefined where it could not be: the engine's no-session-bound error is one plain line, any other is a recorded failure, and either ends the sweep.
  const read = async (): Promise<AgentInfo[] | undefined> => {
    try {
      return await $.agent.list()
    } catch (err) {
      if (NO_SESSION_BOUND.test(reasonOf(err))) $.ui.log(`${PLUGIN}: idle reviewer sweep skipped: no session is bound in this mode`, { to: 'debug' })
      else recordFailed($, 'idle reviewer sweep', err)
      return undefined
    }
  }
  try {
    const listed = await read()
    if (listed === undefined) return
    for (const id of sweepable(await currentConversation($), listed)) {
      if (given.up) return
      if (id === stopping || stopsRunning.has(id)) continue
      // The list is read again with the conversation, since an earlier stop of this loop, or another caller's, may have ended the id since the first read.
      const relisted = await read()
      if (relisted === undefined) return
      if (!sweepable(await currentConversation($), relisted).includes(id)) continue
      if (given.up) return
      $.ui.log(`${PLUGIN}: sweeping idle reviewer ${id}, which the state does not store`, { to: 'debug' })
      await stopReviewer($, id, true, given)
    }
  } catch (err) {
    recordFailed($, 'idle reviewer sweep', err)
  }
}

// The tail of the sweeps asked for so far; `withinTime` never rejects.
let sweeping: Promise<void> = Promise.resolve()

// Stops every listed reviewer that is idle and that the state knows but does not store (`sweepable`), so a reviewer whose let-go or stop was lost, or whose reap a reload cancelled, does not stay listed for the rest of the session, whatever lost it. It runs at load (`session.start`, which also fires again at an enable, a worker respawn and a hot reload) and wherever a settle or a give-back leaves the stored reviewer idle, which is where `armReap` runs; a settle cut off by a reset or by a throw leaves none idle and runs none. The agent list, not the state, says what is left. Just before each stop the list and the conversation are read again: an id that has ended, that is no longer idle, or that has become the stored reviewer, or a spawn that has started since the first read, is not stopped. Each stop goes through `stopReviewer` with a respawn possible, so it is checked against the list and retried once. The stored reviewer is exempt even past its cache's life; its idle reap is its timer's job. `stopping` is a reviewer the caller has stopped itself, which the list may still show idle until the engine has taken that stop, and an id with a stop running (`stopReviewer`) is skipped, so neither is stopped a second time. Not awaited by a caller: no failure rejects, the engine's no-session-bound error on the list read is logged as one plain line, and any other is recorded; a sweep that fails or that a reload cuts off stops nothing that time, and the next load or review runs it again. Sweeps run one at a time (`sweeping`; not kept without a timer, see `withinTime`): a sweep asked for while another runs waits for it and then reads the list afresh, so two that overlap cannot both stop an id whose stop the first has just finished. A sweep that has not finished within BACKGROUND_TIMEOUT_MS (`withinTime`) is given up with one plain line, and the next one runs; the late one is left to finish or hang.
export const sweepIdle = ($: Pick<Scope, 'agent' | 'clock' | 'state' | 'tool' | 'ui'>, stopping?: string): Promise<void> => {
  sweeping = sweeping.then(() => withinTime($, 'idle reviewer sweep', given => sweepOnce($, stopping, given)))
  return sweeping
}

// The release step of a let-go whose stop follows its change at once: applies `decide`, a state change that makes its let-go through `letGo` and returns the decision, then stops the reviewer it released, unless `stops` is false. Resolves with the conversation after and the id released; a change that throws throws, with nothing stopped. A let-go whose stop must wait for other work applies `letGo` in its own change and stops afterwards: a rotation or a failed review is let go in the change that takes the review and stopped after the review's log (`takeReview`, `settle`, `failReview`), a lapse in the dispatch's change and stopped after its log (`dispatchIdle`), and a refused brief and a stale landing are let go in the delivery's changes and stopped as it goes on (`deliverBrief`); a rejected spawn (`releaseRejected`) and an idle reap (`reap`) go through the step itself.
const release = async ($: Scope, decide: (c: Conversation) => Release, mayRespawn: boolean, stops = true): Promise<{ after: Conversation; released: string | undefined }> => {
  const got: { released?: string } = {}
  const after = await change($, c => {
    const decided = decide(c)
    got.released = decided.released
    return decided.next
  })
  if (stops) await stopReviewer($, got.released, mayRespawn)
  return { after, released: got.released }
}

// Starts the timer that lets a reviewer go once its prompt cache has expired, for the reviewer `c` stores when it is idle (`idleTimerOf`); `c` is the conversation a settle or a give-back has just written. It fires CACHE_LIFE_MS after the reviewer's latest turn end (`endedAt`), or after now where it has had none since it was stored; a settle's turn end is now. The timer is only its closure: nothing is stored and nothing is cancelled, and its fire judges again (`reapIdle`) in one change through the release step, so a dispatch, a reset or a rotation since the start makes it change nothing. A failed fire is logged. A hot reload cancels a pending timer; the reloaded module's session start arms it again (`leftIdleAtLoad`); a reload that lands before that timer is set still leaves the reviewer idle until the next load or its next review settles.
const armReap = async ($: Scope, c: Conversation, fromTurnEnd = false): Promise<void> => {
  const timer = idleTimerOf(c)
  if (timer === undefined) return
  const wait = await waitOf($, c.reviewer?.endedAt, fromTurnEnd)
  try {
    $.clock.after(wait, () => {
      reap($, timer).catch((err: unknown) => recordFailed($, 'idle reap', err))
    })
  } catch (err) {
    // A timer that cannot be set leaves the reviewer idle until its next review; the settle or give-back that set it goes on.
    recordFailed($, 'idle reap timer', err)
  }
}

// What a settle, a give-back or a load (`leftIdleAtLoad`) does once it leaves the stored reviewer idle: arms its idle reap (`armReap`) and starts a sweep (`sweepIdle`, which does not stop `released`, the reviewer the caller has just let go and stopped itself). Every site that arms the reap goes through here, so none can leave the sweep out. The sweep is not awaited.
const leftIdle = async ($: Scope, c: Conversation, released?: string, fromTurnEnd = false): Promise<void> => {
  await armReap($, c, fromTurnEnd)
  void sweepIdle($, released)
}

// What the auditor does at load (`session.start`, which fires once at process start and again at an enable, a worker respawn and a reload of the auditor's changed modules): `leftIdle` for the stored reviewer, timed from its latest turn end, so a reviewer a reload cut the timer of is reaped when its cache's life ends, or at once where that has passed, and one sweep. A hot reload cancels the pending timer and fires the reloaded module's `session.start`, the one hook guaranteed to run after it, so this is called from there and from no dispatch or prompt hook: those could not tell whether a timer is already pending. An enable or a worker respawn may leave a timer pending, so the load may arm a second one for the same stored idle reviewer; that is harmless, since the fire judges again (`reapIdle`: same reviewer, dispatch count and epoch), so the later fire finds nothing to do, and the extra sweep is idempotent. At process start the state is empty and nothing is armed. The conversation is read here, since `armReap` takes one already read. Not awaited by its caller, so it does not hold turn one; a failed read is logged and rejects nothing, arms nothing and still starts the sweep, and a reload that lands before the timer is set leaves the reviewer to the next load or review.
const leftIdleAtLoad = async ($: Scope): Promise<void> => {
  let c: Conversation
  try {
    c = await currentConversation($)
  } catch (err) {
    // Nothing is armed without the conversation, but the sweep reads its own and starts all the same.
    recordFailed($, 'idle reap at load', err)
    void sweepIdle($)
    return
  }
  await leftIdle($, c, undefined, true)
}

// How long the cache has left: CACHE_LIFE_MS less the time since `endedAt` where a turn end is counted from, whole where the reviewer has had none or its clock cannot be read (it is then reaped later than it could be, never while warm).
const waitOf = async ($: Pick<Scope, 'clock' | 'ui'>, endedAt: number | undefined, fromTurnEnd: boolean): Promise<number> => {
  if (!fromTurnEnd || endedAt === undefined) return CACHE_LIFE_MS
  try {
    return Math.min(CACHE_LIFE_MS, Math.max(0, endedAt + CACHE_LIFE_MS - (await $.clock.now())))
  } catch (err) {
    recordFailed($, 'idle reap clock read', err)
    return CACHE_LIFE_MS
  }
}

const reap = async ($: Scope, timer: IdleTimer): Promise<void> => {
  await release($, c => reapIdle(c, timer), true)
}

// Takes the open review if `ready`, judged on the conversation the change reads; where `back` holds for the review taken, its entries are put back in the record in the same change. Where `mark` holds instead, the review is not taken but marked as followed up (`followedUp`), in the same change: it stays open with its entries held, and its reviewer is not let go. Where `fails` holds for the review taken, its reviewer is let go in the same change (`failed review`) unless a rotation already let it go. The dispatch failure never asks for a mark.
const takeReview = async ($: Pick<Scope, 'state'>, ready: (r: OpenReview, c: Conversation) => boolean, back: (r: OpenReview) => boolean, mark: (r: OpenReview) => boolean = () => false, fails: (r: OpenReview) => boolean = () => false): Promise<Taken | undefined> => {
  const got: { taken?: Taken } = {}
  await change($, c => {
    got.taken = undefined
    const open = c.review
    if (open === undefined || !ready(open, c)) return c
    if (mark(open)) {
      got.taken = { review: open, models: reviewModels(c, open.number), released: undefined, epoch: c.epoch }
      return { ...c, review: { ...open, followedUp: true } }
    }
    // A reviewer past ROTATE_AT, or one whose review failed, is let go in the same change that ends its review (`letGo`); the caller stops it.
    const rotated = letGo(c, 'rotation', c.reviewer?.id, ROTATE_AT)
    const { next, released } = rotated.released === undefined && fails(open) ? letGo(c, 'failed review', c.reviewer?.id) : rotated
    got.taken = { review: open, models: reviewModels(c, open.number), released, epoch: c.epoch }
    return { ...next, review: undefined, record: back(open) ? withEntriesFirst(open.record, c.record) : c.record }
  })
  return got.taken
}

// Takes a brief out of flight (`briefsInFlight`).
const unflightBrief = ($: Pick<Scope, 'state'>, brief: string): Promise<Conversation> =>
  change($, c => ({ ...c, briefsInFlight: c.briefsInFlight.filter(b => b !== brief) }))

// Appends one entry to the record, in the order the entries happen; a switched-off reviewer records nothing, and neither does a turn a reviewer's task notification started.
const withEntry = (c: Conversation, body: string): Conversation =>
  c.off || c.turnStart === 'notice' ? c : { ...c, record: { blocks: [...c.record.blocks, entryBlock(c.record.blocks.length + 1, body)] } }

const appendEntry = async ($: Pick<Scope, 'state'>, body: string): Promise<void> => {
  await change($, c => withEntry(c, body))
}

// Applies `fn` only while the conversation is still at the epoch the caller read (`epoch`).
const inEpoch = (epoch: number, fn: (c: Conversation) => Conversation) => (c: Conversation): Conversation => (c.epoch !== epoch ? c : fn(c))

// A review that fails: the footer reads `auditor failing` until a review succeeds, with the cause in the popup (`cause`) and the raw reason in the debug log. A review taken or planned under an older epoch (`epoch`) does not fail.
const markFailed = async ($: Pick<Scope, 'state' | 'ui'>, reason: string, epoch: number, cause: FailCause, also: (c: Conversation) => Conversation = c => c): Promise<Conversation> => {
  const after = await change($, inEpoch(epoch, c => also({ ...c, failing: cause })))
  $.ui.log(`${PLUGIN}: review failed: ${reason}`, { to: 'debug' })
  return after
}

// Whether a prompt is the user's own: typed at the terminal, sent from a Remote Control client, or a headless run's.
const isUserKind = (kind: string): boolean => kind === 'composer' || kind === 'bridge' || kind === 'sdk'

// Takes every held note in one change, so each is attached by one prompt only. `epoch`: the epoch at the take (`restorePending`).
const takePending = async ($: Pick<Scope, 'state'>): Promise<TakenNotes> => {
  const got: TakenNotes = { notes: [], epoch: 0 }
  await change($, c => {
    got.notes = c.pendingNotes
    got.epoch = c.epoch
    return got.notes.length === 0 ? c : { ...c, pendingNotes: [] }
  })
  return got
}

// Puts notes back at the front of the held list, unless the epoch has moved since the take (`epoch`); notes held since the take stay behind them.
const restorePending = ($: Pick<Scope, 'state'>, taken: TakenNotes): Promise<Conversation> =>
  change($, inEpoch(taken.epoch, c => ({ ...c, pendingNotes: [...taken.notes, ...c.pendingNotes] })))

// The held notes as the worker reads them: each framed as its review line then its body, oldest first.
const framedOf = (notes: readonly PendingNote[]): string => notes.map(n => frameNote(n.number, n.text)).join('\n\n')

// A booked stall note sets the once-per-stall guard only when its review was dispatched after the user's latest prompt. An older review's note answers a turn the user has already moved past, so it must not hold back the stall fact of the turn it lands in.
const withStallGuard = (c: Conversation, number: number, stall: boolean): Conversation => (stall && number > c.dispatchesAtPrompt ? { ...c, nudged: true } : c)

// Admits a reviewer's send in one change (`admitSend`): an admitted note fills its open review's note slot in that change, so of two notes sent at once one is admitted.
const admit = async ($: Pick<Scope, 'state'>, sent: Sent): Promise<Verdict> => {
  const got: { verdict: Verdict } = { verdict: { admitted: false, reason: UNCHECKED } }
  await change($, c => {
    got.verdict = admitSend(sent, c.review, c.epoch)
    return got.verdict.admitted && c.review !== undefined ? { ...c, review: { ...c.review, note: sent.body } } : c
  })
  return got.verdict
}

// The user is told of an escalation when the reviewer gives it, whether or not the worker has read it yet: a toast, and a push that reaches a phone when the user is away from the terminal (the engine holds it back while they are at it).
const announce = ($: Scope, sent: Sent): void => {
  if (!sent.escalation) return
  $.ui.toast(ESCALATED)
  const message = clip(`auditor escalated: ${firstLine(sent.body)}`, PUSH_CHARS)
  void $.tool.call({ tool: 'PushNotification', message, status: 'proactive' }).catch((err: unknown) => recordFailed($, 'escalation push', err))
}

// What a note's booking writes into the conversation, delivered or held: one more note given, then the marks from the send's own read: a stall note arms the stall guard and adds no memory entry, since once the worker moves on there is nothing to dispute; any other note, an escalation included, adds one.
const withBooked = (c: Conversation, number: number, sent: Sent): Conversation => ({ ...withNoteGiven(withStallGuard(c, number, sent.stall)), ...(sent.stall ? {} : { memory: withNote(c.memory, number, sent.body) }) })

// The debug line for a memory entry a booking added.
const logAdded = ($: Pick<Scope, 'ui'>, number: number, body: string): void => {
  $.ui.log(`${PLUGIN}: memory entry added for review ${number}: ${clip(body, MEMORY_LOG_CHARS)}`, { to: 'debug' })
}

// What a delivered note triggers: its booking state, only while the conversation is still at the send's epoch (`epoch`), and in that same change its review marked delivered, while it is still open (`delivered`). An escalation is announced whatever the epoch, and even when the booking write throws: the note was delivered. The change says whether it found the review; when it found none (the review was taken, or the epoch moved), the review's log was written with `note_delivered` false and stays so, and one debug line names the review. It says too whether the booking added a memory entry, which a moved epoch or a stall note does not; the entry's debug line is written after the change lands, since a compare-and-set change can run more than once.
const book = async ($: Scope, sent: Sent, number: number, epoch: number): Promise<void> => {
  announce($, sent)
  const got = { found: false, added: false }
  await change($, c => {
    got.found = false
    got.added = false
    return inEpoch(epoch, s => {
      got.found = s.review?.number === number
      const booked = withBooked(s, number, sent)
      got.added = booked.memory !== s.memory
      return { ...booked, ...(s.review?.number === number ? { review: { ...s.review, delivered: true } } : {}) }
    })(c)
  })
  if (!got.found) $.ui.log(`${PLUGIN}: review ${number}'s note was delivered after its review closed, so its log keeps note_delivered false`, { to: 'debug' })
  if (got.added) logAdded($, number, sent.body)
}

// The one hold-or-release step for a note whose send was not delivered (`decideRefusal`), run in one change: the gate's note, whose slot admission filled (`filling` false), and the follow-up's, which the step admits itself (`filling` true). `reason` is the engine's refusal, absent for a send that threw. A held note gets the booking effects a delivered one gets, bar the delivered mark, its memory entry included (logged once the change lands, when it added one), and an escalation is announced then. If the change throws, nothing is held or released: the failure is logged with its stack, the slot stays as it was, and an escalation is still announced, as for a failed booking. Returns what the change decided, or undefined when it threw.
const holdOrRelease = async ($: Scope, refusal: Refusal): Promise<Decided | undefined> => {
  const { number, sent } = refusal
  const got: { decided?: Decided; added: boolean } = { added: false }
  try {
    await change($, c => {
      got.decided = decideRefusal(c, refusal, state => withBooked(state, number, sent))
      got.added = got.decided.next.memory !== c.memory
      return got.decided.next
    })
  } catch (err) {
    recordFailed($, `review ${number}'s note hold or release`, err)
    announce($, sent)
    return undefined
  }
  if (got.decided?.outcome === 'hold') {
    announce($, sent)
    if (got.added) logAdded($, number, sent.body)
    $.ui.log(
      got.decided.stale === true
        ? `${PLUGIN}: review ${number}'s note was refused while the session was stopped, but a reset since its send dropped it: nothing is held`
        : `${PLUGIN}: review ${number}'s note was refused while the session was stopped, so it is held for the user's next prompt`,
      { to: 'debug' },
    )
  }
  return got.decided
}

// The reviewer's turn end settles its open review, with the outcome the gate saw (`settleOutcome`): the take computes it in its own change, which takes the review, so the entries go back exactly when it fails, or marks it for its one follow-up (`followUp`) and leaves it open.
// The review is taken or marked only while `agentId` is still the stored reviewer, in the take's own change: a reviewer a switch or a /clear let go after its turn end was matched must not close the next run's review.
// `unsent`: this settle follows a follow-up that could not be sent, whose attempt already put the answer in the debug log.
const settle = async ($: Scope, log: boolean, agentId: string, done: Finished, unsent = false): Promise<void> => {
  const outcomeOf = (r: OpenReview): Outcome => settleOutcome({ note: r.note, number: r.number, followedUp: r.followedUp === true, reason: done.reason, answer: done.answer })
  // An incomplete review lets its reviewer go unless its turn was aborted: an abort is the user's Esc, and a cold respawn after it is what the stopped-session refusal already costs.
  const taken = await takeReview($, (_r, c) => standingOf(c, agentId) === 'current', r => outcomeOf(r).status === 'incomplete', r => outcomeOf(r).status === 'follow-up', r => outcomeOf(r).status === 'incomplete' && !done.isAborted)
  if (taken === undefined) {
    $.ui.log(`${PLUGIN}: the reviewer ended a turn with no review in progress; not recorded`, { to: 'debug' })
    return
  }
  const { review, models, released, epoch } = taken
  const outcome = outcomeOf(review)
  if (outcome.status === 'follow-up') {
    await followUp($, log, agentId, done, review.number, epoch)
    return
  }
  // The stop is issued last whatever the close or dispatch does: a reviewer let go is never left running by a throw.
  try {
    const turnEnd: TurnEnd = { at: await $.clock.now(), answer: done.answer, reason: done.reason, durationMs: done.durationMs, usage: usageOf(done.usage) }
    const sessionId = await $.session.id()
    const closed: Closed = { review, models, turnEnd }
    if (outcome.status === 'incomplete') {
      // settleOutcome fails an answer only when it is empty.
      const reason = done.reason === 'answer' ? 'reviewer ended its turn with an empty answer' : `reviewer turn ended with reason ${done.reason}, isAborted ${done.isAborted}`
      const failed = await markFailed($, reason, epoch, 'no answer', c => withTurnEnd(c, agentId, turnEnd.at))
      // A reviewer kept (its turn was aborted) idles from here.
      if (failed.epoch === epoch) await leftIdle($, failed, released)
      await logReview($, sessionId, log, closed, { status: 'incomplete', reason })
      // Its restored entries wait for the worker's next turn end.
      return
    }
    // An answer the reviewer wrote instead of sending reaches no one: it is kept here, in the debug log alone, once.
    if (outcome.logAnswer && !unsent) $.ui.log(`${PLUGIN}: review ${review.number} sent no note, and its final answer was: ${done.answer}`, { to: 'debug' })
    await logReview($, sessionId, log, closed, { status: 'complete', note: outcome.note })
    // The failure clears under the take's epoch (`epoch`), and a moved epoch dispatches nothing.
    const after = await change($, inEpoch(epoch, c => ({ ...withTurnEnd(withReviewDone(c, turnEnd.at, outcome.note !== null), agentId, turnEnd.at), failing: undefined })))
    if (after.epoch !== epoch) return
    await leftIdle($, after, released)
    // An idle worker gets the next brief at once; a busy one's turn end dispatches. midTurn is read through a change (currentConversation), since a plain get answers the dispatch's starting moment and misses a prompt that entered while this settle ran, a note's own among them.
    if (!(await currentConversation($)).midTurn) await dispatchIdle($, log)
  } finally {
    await stopReviewer($, released, true)
  }
}

// A review marked for its follow-up asks its reviewer once, through the step briefs use (`sendToReviewer`), to send the note it wrote as its answer. The answer goes to the debug log as the follow-up is attempted, so its text is kept whatever becomes of the follow-up. A follow-up the engine refuses in its stopped-session state (or refuses while the interrupt mark is set) has the note the reviewer wrote admitted and held by the shared hold-or-release step (`holdOrRelease`), which fills the review's slot. A follow-up that is not delivered, or whose send throws, then settles the review through the same settle, with this turn end's answer: the review is marked, so it completes quiet, or with the held note, and nothing is retried. One a reset made stale before it went out is not sent, and settles nothing.
const followUp = async ($: Scope, log: boolean, agentId: string, done: Finished, number: number, epoch: number): Promise<void> => {
  $.ui.log(`${PLUGIN}: review ${number} wrote its note as its final answer, so its reviewer is asked once to send it; the answer was: ${done.answer}`, { to: 'debug' })
  let failure: string
  try {
    const sent = await sendToReviewer($, agentId, followUpText(number), epoch, number)
    if (sent.status !== 'refused') return
    failure = sent.reason
    const held = await holdOrRelease($, { number, epoch, sent: readSend(MAIN, done.answer), reason: sent.reason, filling: true })
    if (held?.refused !== undefined) failure = `${failure} (its note was not held: ${held.refused})`
  } catch (err) {
    failure = err instanceof Error ? (err.stack ?? err.message) : String(err)
  }
  $.ui.log(`${PLUGIN}: review ${number}'s follow-up could not be sent: ${failure}`, { to: 'debug' })
  await settle($, log, agentId, done, true)
}

// A guard withholds the stall fact: the turn's last tool call asked the user; a stall note on a review dispatched since the user's last prompt was delivered; or the turn's main loop sent a broadcast (`"*"`), which names no listed agent, so the agent list cannot say what it wakes.
const withheld = (c: Conversation): boolean => c.lastAsked || c.nudged || c.messaged.includes('*')

// A SendMessage may address a listed name with its ` [ref]` appended, so the suffix is set aside before matching.
const addressedBy = (a: AgentInfo, to: string): boolean => {
  const bare = to.replace(/ \[[^\]]*\]$/, '')
  return a.name === bare || a.teammateId === bare || a.id === bare
}

// The stall fact at the worker's Stop: what is in flight that will wake it. The agents are the subagents and teammates the agent list shows working, plus any the worker messaged this turn whatever their status, the reviewer's own left out; Stop's tasks count only when they are neither (a shell, a monitor, ...). Null when a guard withholds it, or when the agent list is unread. A Stop that omits either list is unknown, not empty, so it is withheld too.
type StopFacts = { background_tasks?: { id: string; type: string; description: string }[]; session_crons?: readonly unknown[] }
const stallFact = (c: Conversation, e: StopFacts, listed: AgentInfo[] | undefined): Wake | null => {
  if (withheld(c)) return null
  const { background_tasks: running, session_crons: crons } = e
  if (running === undefined || crons === undefined || listed === undefined) return null
  const agents = listed.filter(a => !isReviewerEntry(IDENTITY, c, a) && (WORKING.includes(a.status) || c.messaged.some(to => addressedBy(a, to))))
  // An agent's task is set aside by its id as well as its label: a task carries its agent's id, and a label the engine spells another way must not count an idle agent.
  const tasks = running.filter(t => t.type !== 'teammate' && t.type !== 'subagent' && !listed.some(a => a.id === t.id))
  return { tasks: [...agents.map(a => `${a.teammateId === undefined ? 'subagent' : 'teammate'} "${a.description}"`), ...tasks.map(t => `${t.type} "${t.description}"`)], crons: crons.length }
}

// Nothing is in flight to wake the worker: no task and no scheduled wake-up. The brief's line and the review's record of it both read this.
const wakesNothing = (wake: Wake | null): boolean => wake !== null && wake.tasks.length === 0 && wake.crons === 0

// The line that says what will wake the worker: nothing, or what is in flight. No line when the stall fact is withheld.
const wakeLines = (wake: Wake | null): string[] => {
  if (wake === null) return []
  if (wakesNothing(wake)) return ['Nothing will wake the worker: no background task or scheduled wake-up is in flight.']
  const parts = [wake.tasks.join(', '), wake.crons === 0 ? '' : `${wake.crons} scheduled wake-up(s)`].filter(part => part !== '')
  return [`Will wake the worker: ${parts.join('; ')}.`]
}

// Whether a worker tool call asks the user something: AskUserQuestion, or a human_items call that adds an item for the user.
const asksUser = (tool: string, input: Record<string, unknown>): boolean => tool === 'AskUserQuestion' || (tool === HUMAN_ITEMS && input['action'] === 'add')

// The addresses a worker tool call messages, appended to those the turn already named: a SendMessage's `to`. A refused or failed send woke no one, so it names none.
const sentTo = (messaged: readonly string[], tool: string, input: Record<string, unknown>, failed: boolean): string[] => (tool === 'SendMessage' && !failed && typeof input['to'] === 'string' ? [...messaged, input['to']] : [...messaged])

// What the review is told: the reviewer's memory first when it holds any (`renderMemory`), the same for every reviewer, then its number, the entries its record covers, how to fetch them and the entries recorded since, the paths the record edits when it edits any, the wake-up line, and the worker's last message.
const briefOf = (number: number, blocks: readonly string[], lastMessage: string, wake: Wake | null, memory: string): string => [
  ...(memory === '' ? [] : [memory, '']),
  'The worker finished a turn.',
  `Review ${number}. Its record holds entries 1-${blocks.length}, everything recorded since the previous review was dispatched. Fetch it with the ${ENTRIES} tool, which: 'record', page by page as each page's header says.`,
  `The worker may have kept working since this dispatch. Its later entries come from the same tool, which: 'live', read as they are at each call.`,
  ...editedLines(blocks),
  ...wakeLines(wake),
  'Worker last message:',
  lastMessage === '' ? '(none)' : lastMessage,
].join('\n')

// A review is dispatched only with no review open and entries to cover. After an Esc, while the interrupt mark is set or a note is held, none is: the engine refuses every message from the session to an agent until the user types again, and the user's next plain prompt clears both. After a failed review only a turn the user's own prompt started dispatches: a notice, a peer's message or a plugin's own prompt does not.
const eligible = (c: Conversation): boolean => !c.off && c.review === undefined && c.record.blocks.length > 0 && !c.interrupted && c.pendingNotes.length === 0 && !(c.failing && c.turnStart !== 'user')

// The brief a SendMessage's message or an Agent call's prompt is, when it is exactly one in flight: the plugin's own call, which the record leaves out.
const briefCalled = (c: Conversation, tool: string, input: Record<string, unknown>): string | undefined => {
  const text = tool === 'SendMessage' ? input['message'] : tool === 'Agent' ? input['prompt'] : undefined
  return typeof text === 'string' && c.briefsInFlight.includes(text) ? text : undefined
}

// The stored ids the switch check may need (`keeps`), read before the change that judges the stored reviewer, whose callback is synchronous: only where the reviewer was spawned for another name than the choice (`needsIds`). A read that fails leaves them unknown, and the names decide.
const idsForSwitch = async ($: Pick<Scope, 'state' | 'store' | 'clock' | 'ui'>): Promise<ModelIds> => {
  const c = await readConversation($)
  return needsIds(c) ? await readModelIds($) : {}
}

// A review given up at a dispatch: the review, its cause and logged reason, the models its log names, and the reviewer let go with it, if any.
type Lapsed = { review: OpenReview; cause: Extract<FailCause, 'no start' | 'no finish'>; reason: string; models: ReviewModels; released: string | undefined }

// The reviewer gets one brief when it has no open review and turns since its last dispatch.
// Eligibility is judged in the change alone: a get reads the dispatch's starting moment, so a settle's own take of the open review is invisible to it.
const dispatchIdle = async ($: Scope, log: boolean): Promise<void> => {
  const now = await $.clock.now()
  // Read before the review opens, so a failed read leaves none open that no brief went out for; and before the brief goes out, so a /clear while it is in flight leaves a failed review's log in the session it was dispatched in.
  const sessionId = await $.session.id()
  // The stored ids the model-switch check may need, read before the change, whose callback is synchronous.
  const ids = await idsForSwitch($)
  // Set by the change's last run alone: a compare-and-set retry plans again from the state it read.
  const planned: { plan?: Plan; lapsed?: Lapsed; bound?: { aged: number; evicted: number }; switched?: string } = {}
  await change($, c => {
    planned.plan = undefined
    planned.bound = undefined
    planned.lapsed = undefined
    planned.switched = undefined
    // The one place an open review is given up, its entries put back: one still open with no reviewer stored SPAWN_TIMEOUT_MS after its dispatch has no spawn left that will stand one in; one whose stored reviewer has not ended its turn REVIEW_TIMEOUT_MS after it never will, so that reviewer is let go (the caller stops it), and its late turn end, sends and tool calls match no open review.
    const open = c.review
    const cause = lapseOf(c, now, { start: SPAWN_TIMEOUT_MS, finish: REVIEW_TIMEOUT_MS })
    let d: Conversation = c
    if (open !== undefined && cause !== undefined) {
      const gone = cause === 'no finish' ? letGo(c, 'lapsed', c.reviewer?.id) : { next: c, released: undefined }
      planned.lapsed = { review: open, cause, reason: cause === 'no finish' ? REVIEW_LAPSED : SPAWN_LAPSED, models: reviewModels(c, open.number), released: gone.released }
      d = { ...gone.next, review: undefined, failing: cause, record: withEntriesFirst(open.record, c.record) }
    }
    if (!eligible(d)) return d
    // A stored reviewer takes the brief only while it runs the model the conversation's choice names: one that does not is let go in this change, and the brief goes to a spawn (`letGoSwitched`). It covers what the switch itself could not let go: a reviewer that was mid-review at the switch, and a spawn in flight at the switch that landed on the old model.
    const switched = letGoSwitched(d, ids)
    planned.switched = switched.released
    d = switched.next
    const number = d.dispatches + 1
    const { blocks } = d.record
    // The memory is bounded in the dispatch's own change, before the brief is built, so the brief carries it as it stands after the bound.
    const { memory, aged, evicted } = bounded(d.memory, number)
    planned.bound = { aged, evicted }
    planned.plan = { number, brief: briefOf(number, blocks, d.lastMessage, d.wake, renderMemory(memory)), send: d.reviewer?.id, epoch: d.epoch, at: now }
    return { ...d, memory, dispatches: number, review: blankReview(number, now, blocks, wakesNothing(d.wake)), record: EMPTY_RECORD }
  })
  const { plan, lapsed, bound } = planned
  if (lapsed !== undefined) {
    // The stop is issued last whatever the log does: a reviewer let go is never left running by a throw.
    try {
      await logIncomplete($, sessionId, log, lapsed.review, lapsed.models, lapsed.reason)
      $.ui.log(`${PLUGIN}: review failed: ${lapsed.reason}`, { to: 'debug' })
    } finally {
      await stopReviewer($, lapsed.released, true)
    }
  }
  if (plan === undefined) return
  await stopReviewer($, planned.switched, true)
  if (bound !== undefined && bound.aged + bound.evicted > 0) $.ui.log(`${PLUGIN}: review ${plan.number}'s dispatch aged out ${bound.aged} and evicted ${bound.evicted} memory entries`, { to: 'debug' })
  try {
    if (await deliverBrief($, plan)) await giveBack($, sessionId, log, plan)
  } catch (err) {
    await unflightBrief($, plan.brief)
    recordFailed($, 'review dispatch', err)
    await failReview($, sessionId, log, plan, reasonOf(err))
  }
}

// The dispatch at a worker turn's end. A turn a reviewer's task notification started records nothing, so it dispatches nothing.
const dispatchAtTurnEnd = async ($: Scope, log: boolean): Promise<void> => {
  if ((await readConversation($)).turnStart === 'notice') return
  await dispatchIdle($, log)
}

// A worker turn end's dispatch that throws is logged with its stack, and the turn end goes on.
const atTurnEnd = async ($: Scope, dispatch: () => Promise<void>): Promise<void> => {
  try {
    await dispatch()
  } catch (err) {
    recordFailed($, 'review dispatch', err)
  }
}

// A reviewer spawn's id, as the spawn hook sees it, and the team name it runs under (`spawnName`). The id and name mark the reviewer's traffic and rows from here on, and the spawn stands in as the reviewer at once where `spawnsInFlight` allows it (`learn`).
const recordSpawnedId = async ($: Pick<Scope, 'state' | 'ui' | 'agent'>, brief: string, started: AgentSpawnResult): Promise<void> => {
  if (started.deny !== undefined || started.agentId === undefined) return
  const { agentId: id, model } = started
  const name = spawnName(IDENTITY, await listAgents($), id)
  await change($, c => learn(c, brief, id, model, name))
  $.ui.log(`${PLUGIN}: reviewer id ${id} (${name}) from its spawn result`, { to: 'debug' })
}

// A reviewer spawn of the plugin's own that carries a full id as its choice: the spawn call takes only an alias as its `model`, so the call passes none and this sets it, from the choice the spawn's in-flight entry was made for, matched by brief. An alias choice rode the call itself and is left alone. Where the choice cannot be found, or the state cannot be read, the spawn goes on as it is, on the definition's default, and the review's log names that model.
export const withChoice = async <E extends { prompt: string; model?: string }>($: Pick<Scope, 'state' | 'ui'>, e: E): Promise<E> => {
  try {
    const choice = spawnChoice(await readConversation($), e.prompt)
    if (choice === undefined) {
      recordFailed($, 'reviewer model choice', new Error('no spawn in flight holds this spawn\'s brief with a choice, so it keeps the definition\'s model'))
      return e
    }
    return isFullId(choice) ? { ...e, model: choice } : e
  } catch (err) {
    recordFailed($, 'reviewer model choice', err)
    return e
  }
}

// The agent list, or undefined when it rejects: each caller says what a lost list means.
const listAgents = ($: Pick<Scope, 'agent' | 'ui'>): Promise<AgentInfo[] | undefined> =>
  $.agent.list().catch((err: unknown) => {
    recordFailed($, 'agent list', err)
    return undefined
  })

// Whether a verified team name is one of this conversation's reviewers. A name shaped like a reviewer's that is not yet known (its spawn result's list lookup failed or lagged) is looked up again by the agent list, and learned when the list gives it to one of this conversation's reviewer ids (`nameListed`).
const knownReviewerName = async ($: Pick<Scope, 'state' | 'agent' | 'ui'>, name: string): Promise<boolean> => {
  const c = await readConversation($)
  const known = nameKnown(IDENTITY, c, name)
  if (known !== 'ask') return known === 'known'
  const listed = nameListed(c, name, await listAgents($))
  if (listed === 'learn') await change($, s => learnName(s, name))
  return listed !== 'other'
}

// Lets go the id the spawn hook learned for `brief`'s spawn (`learn` keeps it on the spawn's entry in `spawnsInFlight`) once that spawn rejected: it is no longer stored, so no brief goes to it and its turn end settles nothing, and it is stopped. Only the id on the spawn's own entry is let go: a spawn that rejected before its hook saw an id lets go and stops nothing. It runs before the finally takes the entry out. A failed write is logged and stops nothing, so the spawn's error is the one its dispatch fails with.
const releaseRejected = ($: Scope, brief: string): Promise<unknown> =>
  release($, c => letGo(c, 'rejected spawn', c.spawnsInFlight.find(s => s.brief === brief)?.id), true).catch((err: unknown) => recordFailed($, 'spawn bookkeeping', err))

// Takes `brief`'s entry out of `spawnsInFlight`. A failed write is logged and leaves the entry, which blocks no adoption past SPAWN_TIMEOUT_MS (`adopt`).
const releaseSpawn = async ($: Pick<Scope, 'state' | 'ui'>, brief: string): Promise<void> => {
  await change($, c => ({ ...c, spawnsInFlight: c.spawnsInFlight.filter(s => s.brief !== brief) })).catch((err: unknown) => recordFailed($, 'spawn bookkeeping', err))
}

type Delivery = { status: 'stale' } | { status: 'delivered' } | { status: 'refused'; reason: string }

// Takes a plugin message out of flight; a failed write is logged, so the send's own outcome or error is what its caller sees.
const leaveFlight = ($: Pick<Scope, 'state' | 'ui'>, text: string): Promise<void> =>
  unflightBrief($, text).then(
    () => undefined,
    (err: unknown) => recordFailed($, 'flight bookkeeping', err),
  )

// Where a brief goes when it is spawned for: the latest let-go's reason, or that no reviewer was ever let go. Read from the conversation after the let-go this delivery made (a refused brief's), so a spawn's route is the latest reason whichever delivery made it.
const spawnRoute = (c: Conversation): BriefTo => (c.lastLetGo === undefined ? 'spawn: no reviewer yet' : `spawn: ${c.lastLetGo}`)

// The conversation with its open review's brief going `route`; unchanged where no route is named or no review is open.
const withRoute = (c: Conversation, route: BriefTo | undefined): Conversation => (c.review === undefined || route === undefined ? c : { ...c, review: { ...c.review, briefTo: route } })

// The route taken off review `number` at `epoch` when its brief is known not to have reached a reviewer (a send or a spawn that threw or was refused), so its log reads null. A review that failed after its brief went out keeps its route.
const unroute = ($: Scope, epoch: number, number: number): Promise<unknown> =>
  change($, c => (c.epoch === epoch && c.review?.number === number ? { ...c, review: withoutRoute(c.review) } : c)).catch((err: unknown) => recordFailed($, 'route bookkeeping', err))

// The one step that sends a plugin message, a brief or a follow-up, to the stored reviewer `to`. A brief names its route (`briefTo`), which the same change that puts it in flight sets on the review. It goes out only while the conversation is still at the epoch (`epoch`) and open review `number` it was planned under, and is 'stale' otherwise. It is held in flight (`briefsInFlight`) until its call reaches the recorder, which takes it out and leaves the call out of the record; a refused or thrown send takes it out here. It carries no agent id, so the send gate passes it untouched. Each caller decides what a refusal means.
const sendToReviewer = async ($: Scope, to: string, text: string, epoch: number, number: number, route?: BriefTo): Promise<Delivery> => {
  const ours = (c: Conversation): boolean => c.epoch === epoch && c.review?.number === number
  const queued = await change($, c => (ours(c) ? { ...withRoute(c, route), briefsInFlight: [...c.briefsInFlight, text] } : c))
  if (!ours(queued)) return { status: 'stale' }
  const sent = await $.session.send({ to, text }).catch(async (err: unknown) => {
    await leaveFlight($, text)
    await unroute($, epoch, number)
    throw err
  })
  if (!sent.isDelivered) {
    await leaveFlight($, text)
    return { status: 'refused', reason: sent.reason }
  }
  // A reset (`epoch`) while the send was in flight let this reviewer go, and its stop may have landed before the message: the message must not run a turn nothing settles, so the reviewer is stopped again.
  // A failed read is logged, not thrown: the message was delivered, so its caller must not treat it as failed.
  const moved = await currentConversation($).then(
    c => c.epoch !== epoch,
    (err: unknown) => {
      recordFailed($, 'reviewer send bookkeeping', err)
      return false
    },
  )
  if (moved) await stopReviewer($, to, true)
  return { status: 'delivered' }
}

// What the take of a conversation's choice rests on: the last model set, and the choices it may take. Read before the change that takes it, since a change's callback is synchronous.
type TakeInputs = { last: string | undefined; choices: Choices }
const takeInputs = async ($: Scope): Promise<TakeInputs> => {
  const [last, choices] = await Promise.all([readLastModel($), readChoices($)])
  return { last, choices }
}

// Delivers the plan's brief to a reviewer, stored or spawned. Resolves true when the engine refused the brief in its stopped-session state, by either transport, so the caller gives the review back (`giveBack`); the stored reviewer is kept then, and no spawn is made after its refusal.
const deliverBrief = async ($: Scope, plan: Plan): Promise<boolean> => {
  const { send, brief, number } = plan
  // The plan's review must still be the open one, at the plan's epoch (`epoch`); otherwise its brief goes to no reviewer, stored or spawned.
  const ours = (c: Conversation): boolean => c.epoch === plan.epoch && c.review?.number === number
  if (send !== undefined) {
    const sent = await sendToReviewer($, send, brief, plan.epoch, number, 'stored')
    if (sent.status !== 'refused') return false
    if (isStoppedRefusal(sent.reason)) return true
    // The stored reviewer did not take the brief, so it is no longer the reviewer: this dispatch spawns one.
    $.ui.log(`${PLUGIN}: the reviewer's send was refused, so a new reviewer is spawned: ${sent.reason}`, { to: 'debug' })
  }
  // The spawn sends the brief as planned, whether the stored reviewer refused it or none was stored: every brief carries the memory. It enters flight in this change, until its Agent call reaches the recorder.
  // A plan whose review was dropped, before the spawn or while the send was refused, spawns no reviewer and stops the refused reviewer there as well. The spawn is committed in this change as an entry in `spawnsInFlight` under the plan's epoch (`epoch`), which the finally takes out.
  // A conversation holding no choice takes one here, at its first spawn, from the last model set or the default (`takeChoice`); a choice it holds, or one a switch set since, is kept. What the take reads is read only then, and before the change, whose callback is synchronous. The choice rides the spawn: on its entry, and as the call's `model` where it is an alias.
  const taking = (await readConversation($)).choice === undefined ? await takeInputs($) : undefined
  const spawned: { dropped: boolean; released?: string; choice: string } = { dropped: false, choice: DEFAULT_MODEL }
  await change($, c => {
    spawned.dropped = !ours(c)
    if (spawned.dropped) return c
    const { next, released } = letGo(c, 'refused brief', send)
    spawned.released = released
    const taken = { ...next, choice: takeChoice(next.choice, taking?.last, taking?.choices ?? FALLBACK_CHOICES) }
    spawned.choice = taken.choice
    return { ...spawning(withRoute(taken, spawnRoute(taken)), { brief, epoch: plan.epoch, number, startedAt: plan.at, choice: taken.choice }), briefsInFlight: [...c.briefsInFlight, brief] }
  })
  if (spawned.dropped) {
    await stopReviewer($, send, true)
    return false
  }
  // However the spawn settles, the finally takes its entry out of `spawnsInFlight`, with what the spawn hook kept on it, and stops the refused stored reviewer (`spawned.released`, set only when its send was refused).
  try {
    const started = await $.agent
      .spawn({
        subagentType: REVIEWER_TYPE,
        name: REVIEWER,
        description: REVIEW_DESCRIPTION,
        prompt: brief,
        // The call takes an alias as its `model`.
        ...(isFullId(spawned.choice) ? {} : { model: spawned.choice }),
      })
      .catch(async (err: unknown) => {
        await unroute($, plan.epoch, number)
        await releaseRejected($, brief)
        throw err
      })
    if (started.deny !== undefined) {
      if (!isStoppedRefusal(started.deny)) {
        await unroute($, plan.epoch, number)
        throw new Error(`reviewer spawn refused: ${started.deny}`)
      }
      await unflightBrief($, brief)
      return true
    }
    // The landing's one change, under the plan's epoch (`epoch`): `land` decides the id and whether the spawn stands in as the reviewer (`spawnsInFlight`).
    const landed: { id?: string; model?: string; stale: boolean; released?: string } = { stale: false }
    await change($, c => {
      const landing = land(c, brief, number, plan.epoch, started)
      landed.id = landing.id
      landed.model = landing.id === undefined ? undefined : landing.next.reviewerModels[landing.id]
      landed.stale = landing.stale
      // A stale spawn, or one whose review closed since under no reviewer of its own (`dispatchIdle` gave it up), is let go.
      const { next, released } = landing.stood ? { next: landing.next, released: undefined } : letGo(landing.next, 'stale landing', landing.id)
      landed.released = released
      return next
    })
    // The full id the spawn resolved to, which the spawn hook recorded for the reviewer (the call's own result names only the model it asked for), is what the choice resolved to: kept for the chain from a choice to an id.
    await storeModelId($, spawned.choice, landed.model ?? '')
    // A stale landing with no id stops nothing. No catch takes its brief out of flight, so it leaves here.
    if (landed.id === undefined && landed.stale) {
      await unflightBrief($, brief)
      return false
    }
    if (landed.id === undefined) {
      throw new Error('reviewer spawn returned no agent id')
    }
    await stopReviewer($, landed.released, true)
    return false
  } finally {
    await releaseSpawn($, brief)
    await stopReviewer($, spawned.released, true)
  }
}

// A review whose brief the stopped session refused is given back: its entries go to the front of the record, the interrupt mark is set so nothing is dispatched until the user's next plain prompt, and the review is logged incomplete with its own reason; its number is not reused. It fails nothing and stops no reviewer. Only while the plan's review is still the open one, at the plan's epoch: a reset has already dropped and logged it.
const giveBack = async ($: Scope, sessionId: string, log: boolean, plan: Plan): Promise<void> => {
  const got: { review?: OpenReview; models: ReviewModels } = { models: { configured: null, resolved: null } }
  const after = await change($, c => {
    got.review = undefined
    if (c.epoch !== plan.epoch || c.review?.number !== plan.number) return c
    got.review = c.review
    got.models = reviewModels(c, c.review.number)
    // The user's prompt taken since this dispatch began (`dispatchesAtPrompt` reached its number) already ended the stopped state and cleared the mark; setting it now would hold the later turns until yet another prompt.
    return { ...c, review: undefined, record: withEntriesFirst(c.review.record, c.record), ...(plan.number > c.dispatchesAtPrompt ? { interrupted: true } : {}) }
  })
  if (got.review === undefined) return
  // The reviewer stays, idle since its latest turn end (or since now, had it none), so it is timed from there.
  await leftIdle($, after, undefined, true)
  await logIncomplete($, sessionId, log, withoutRoute(got.review), got.models, GIVEN_BACK)
  $.ui.log(`${PLUGIN}: review ${plan.number}'s brief was refused while the session was stopped, so the review is given back until the user's next prompt`, { to: 'debug' })
}

// A dispatch error marks the reviewer failing (`markFailed`) whether or not its review is still open; only an open review is logged, and only its reviewer is let go.
const failReview = async ($: Scope, sessionId: string, log: boolean, plan: Plan, reason: string): Promise<void> => {
  const taken = await takeReview($, r => r.number === plan.number, () => true, () => false, () => true)
  // As in settle, the stop is issued last whatever the bookkeeping does: a reviewer let go is never left running by a throw.
  try {
    await markFailed($, reason, plan.epoch, 'not dispatched')
    if (taken === undefined) return
    await logIncomplete($, sessionId, log, taken.review, taken.models, reason)
  } finally {
    await stopReviewer($, taken?.released, true)
  }
}

// Switches the auditor (`switched`) and returns the state after. A switch to off releases the reviewer it lets go, so a review under way ends now, and logs that review as incomplete.
const toggle = async ($: Scope, log: boolean, off: (c: Conversation) => boolean): Promise<Conversation> => {
  // Read before the switch, so a /clear in between leaves the review's log in the session it was dispatched in. A failed read costs only that log: the switch still lands.
  const sessionId = await $.session.id().catch((err: unknown) => {
    recordFailed($, 'toggle session read', err)
    return undefined
  })
  const before: { c?: Conversation } = {}
  const { after } = await release($, c => {
    before.c = c
    return switched(c, off(c))
  }, true)
  const was = before.c
  if (was === undefined || was.off || !after.off) return after
  if (sessionId !== undefined) await logDropped($, sessionId, log, was, 'the auditor was switched off')
  return after
}

// Whether the caller is the reviewer: the one gate of the reviewer's tools. A caller no stored reviewer id names may be the reviewer whose spawn result has not landed yet, so it is looked up by name (`adoptByName`).
const isReviewerCaller = async ($: Pick<Scope, 'agent' | 'state' | 'ui' | 'clock'>, c: Conversation, agentId: string | undefined): Promise<boolean> =>
  standingOf(c, agentId) === 'current' || (agentId !== undefined && (await adoptByName($, agentId)))

const reviewerAgent = async ($: Pick<Scope, 'state'>, agentId: string | undefined): Promise<boolean> =>
  standingOf(await readConversation($), agentId) === 'current'

// The agent list names the caller by its spawn name and as this plugin's spawn (`reviewerNameOf`), and `adopt` stores its id. A failed list or clock read adopts nobody, so the caller is refused.
const adoptByName = async ($: Pick<Scope, 'agent' | 'state' | 'ui' | 'clock'>, agentId: string): Promise<boolean> => {
  const listed = await listAgents($)
  const name = reviewerNameOf(IDENTITY, listed?.find(a => a.id === agentId))
  if (name === undefined) return false
  const now = await $.clock.now().catch((err: unknown) => {
    recordFailed($, 'adoption clock read', err)
    return undefined
  })
  const after = await change($, c => adopt(c, agentId, name, now, SPAWN_TIMEOUT_MS))
  return standingOf(after, agentId) === 'current'
}

// What `$.agent.list()` says of a subagent id: its label when the list names it as the worker's, `other` when it does not name it or names it as this plugin's spawn (a reviewer whose id has not landed yet), `unlisted` when the list rejects. A rejected list still records the call, since a lost list costs one stray entry, not a worker's entry; only an id named as the worker's is kept.
const listedLabel = async ($: Pick<Scope, 'agent' | 'ui'>, agentId: string): Promise<Label | 'other' | 'unlisted'> => {
  const listed = await listAgents($)
  if (listed === undefined) return 'unlisted'
  const found = listed.find(a => a.id === agentId)
  return found === undefined || originOf(PLUGIN, { from: 'listed', agent: found }) === 'spawned' ? 'other' : { type: found.type ?? '', name: found.name ?? '' }
}

// What started a worker turn, by the prompt that starts it. A user prompt that joins a running turn makes that turn the user's; any other prompt joining one leaves the turn's start as it was. A user prompt that joins a notice turn starts recording there: the notice's own entries and the turn's earlier replies stay out of the record, so the review covers what follows.
const turnStartOf = (c: Conversation, e: { text: string; origin: { kind: string } }): TurnStart => {
  if (isUserKind(e.origin.kind)) return 'user'
  if (c.midTurn) return c.turnStart ?? 'other'
  return isNotice(IDENTITY, e) ? 'notice' : 'other'
}

const promptEntry = (kind: string, text: string): string => (isUserKind(kind) ? `USER: ${text}` : `PROMPT (${kind}): ${text}`)

// Runs the lookup a call asks for as a host command, and answers with what it found, or with why it did not run.
const lookUp = async ($: Pick<Scope, 'process' | 'ui'>, transcript: string | null, input: Record<string, unknown>): Promise<string> => {
  const parsed = lookupOf(input)
  if ('refusal' in parsed) return parsed.refusal
  if (transcript === null) return NO_TRANSCRIPT
  const { lookup } = parsed
  let run: ProcessRunResult
  try {
    run = await $.process.run(lookup.kind === 'search' ? searchCommand(transcript, lookup.term) : lineCommand(transcript, lookup.line), { timeoutMs: LOOKUP_TIMEOUT_MS })
  } catch (err) {
    recordFailed($, 'transcript lookup', err)
    return NO_LOOKUP
  }
  if (run.exitCode !== 0) {
    $.ui.log(`${PLUGIN}: transcript lookup exited ${run.exitCode}`, { to: 'debug' })
    return NO_LOOKUP
  }
  if (lookup.kind === 'search') {
    const found = parseSearch(run.stdout)
    if (found === null) {
      $.ui.log(`${PLUGIN}: transcript search printed output it could not read`, { to: 'debug' })
      return NO_LOOKUP
    }
    return renderSearch(lookup.term, found)
  }
  if (run.isStdoutTruncated) return `line ${lookup.line} is too large to read`
  if (run.stdout === '') return `line ${lookup.line} is empty or past the end of the session transcript`
  const digest = digestOf(run.stdout)
  if (digest === null) return `line ${lookup.line} is not valid JSON, so it has no digest`
  if (!lookup.full) return clip(digest, DIGEST_CHARS)
  const blocks = digestBlocks(digest)
  if (lookup.from > blocks.length) return `Line ${lookup.line} has ${blocks.length} entries; there are none from entry ${lookup.from} on.`
  return pageOf(`Line ${lookup.line} of the session transcript`, blocks, lookup.from)
}

export const register: Register = (on, options) => {
  const log = options['log'] === true

  on('session.start', async ($, e, next) => {
    // The footer button's twin for every surface: a phone draws no footer, but its typed commands run here and their answer shows there.
    await $.command.register({ name: 'auditor', description: 'Turn the auditor reviewer on or off for this session, say which it is and what it has cost, or print its memory of the notes delivered', argumentHint: '[on|off|memory]', immediate: true })
    await $.tool.register({
      name: 'entries',
      description: "Returns the calling auditor reviewer's record for its open review, or the entries the worker recorded after that review's dispatch, as they are at the call, one page at a time from entry `from`.",
      inputSchema: {
        type: 'object',
        properties: {
          which: { type: 'string', enum: ['record', 'live'], description: "'record': the record as it stood at the review's dispatch; 'live': the entries recorded since, as they are at the call" },
          from: { type: 'integer', minimum: 1, default: 1, description: 'the first entry of the page, numbered from 1' },
        },
        required: ['which'],
      },
      isDeferred: true,
    })
    await $.tool.register({
      name: 'transcript',
      description: "Searches the session transcript for a term, or shows one of its lines: a search answers each matching line's number with a snippet around its first match; a line answers with a bounded digest, whole and paged only when full is set.",
      inputSchema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: `a term to find, matched case-insensitively as plain text, at most ${SEARCH_TERM_CHARS} characters` },
          line: { type: 'integer', minimum: 1, description: 'the line to show, numbered from 1' },
          full: { type: 'boolean', default: false, description: 'with line: the whole digest, paged' },
          from: { type: 'integer', minimum: 1, default: 1, description: 'with line and full: the first entry of the page, numbered from 1' },
        },
      },
      isDeferred: true,
    })
    // Registered as `memory`, which the engine names MEMORY: a test holds the two together, since nothing else does.
    await $.tool.register({
      name: 'memory',
      description: `Changes one entry of the calling auditor reviewer's memory during its open review, and adds none: ${MEMORY_ACTION.settle} marks the entry settled, with ${MEMORY_FIELD.why} as its reason, touched at this review, whether it was settled before or not; ${MEMORY_ACTION.remove} takes it out of the memory. The answer names the entry and its new state, or why nothing changed.`,
      inputSchema: {
        type: 'object',
        properties: {
          [MEMORY_FIELD.action]: { type: 'string', enum: [MEMORY_ACTION.settle, MEMORY_ACTION.remove], description: `'${MEMORY_ACTION.settle}': the worker countered the entry's finding and there is no new evidence; '${MEMORY_ACTION.remove}': its findings are fixed or moot, or new evidence means a settled finding must be raised again` },
          [MEMORY_FIELD.review]: { type: 'integer', minimum: 1, description: 'the review number the entry is kept under, as the memory states it' },
          [MEMORY_FIELD.why]: { type: 'string', description: `at most ${WHY_CHARS} characters: for ${MEMORY_ACTION.settle}, the worker's counter and where it is, a transcript line or a record entry; for ${MEMORY_ACTION.remove}, which cause and how, or the new evidence` },
        },
        required: [MEMORY_FIELD.action, MEMORY_FIELD.review, MEMORY_FIELD.why],
      },
      isDeferred: true,
    })
    await $.agent.register({
      name: 'reviewer',
      description: 'auditor reviewer: audits the worker session each turn',
      prompt: REVIEWER_PROMPT,
      // SendMessage carries the review's one note to the worker; the gate (`session.send`) refuses every other send.
      tools: ['Read', 'Glob', 'Grep', 'SendMessage', ENTRIES, TRANSCRIPT, MEMORY],
      // Only the default: the conversation's choice rides each spawn, since a registration is process-wide and would move every conversation in the process at once.
      model: DEFAULT_MODEL,
      effort: REVIEWER_EFFORT,
      autoCompactWindow: 100_000,
    })
    void leftIdleAtLoad($)
    return next(e)
  })

  // The session's start carries its transcript path, which a /clear renews; the lookup tool reads it from state.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      await change($, c => withTranscript(c, e.transcript_path))
    } catch (err) {
      recordFailed($, 'transcript path', err)
    }
    return next(e)
  })

  // A reviewer's spawn result reaches its hook, not the plugin's caller, so the id is taken here, and a full-id choice is set here (`withChoice`), since the call refuses one. Who spawned it decides, not its type or name: a worker may spawn its own agent of the reviewer's type, under the reviewer's name, and it keeps its default.
  on('agent.spawn', async ($, e, next) => {
    const own = originOf(PLUGIN, { from: 'hook', origin: next.origin }) === 'own'
    const started = await next(own ? await withChoice($, e) : e)
    try {
      if (own) {
        await recordSpawnedId($, e.prompt, started)
      } else if (started.deny === undefined && started.agentId !== undefined) {
        const label = { type: subagentTypeOf(e), name: e.name ?? '' }
        const agentId = started.agentId
        await change($, c => ({ ...c, subagents: { ...c.subagents, [agentId]: label } }))
      }
    } catch (err) {
      recordFailed($, 'subagent bookkeeping', err)
    }
    return started
  })

  on('command.run', { command: 'auditor' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    // Read-only: the memory is printed as stored, on or off.
    if (wanted === 'memory') return { text: printMemory((await readConversation($)).memory) }
    if (wanted !== '' && wanted !== 'on' && wanted !== 'off') return { text: 'Usage: /auditor [on|off|memory]' }
    const after = wanted === '' ? await readConversation($) : await toggle($, log, () => wanted === 'off')
    return { text: answerOf(await figuresOf($, after)) }
  })

  // A compaction of a reviewer's own conversation keeps what its judgement rests on; the worker's is left as it is.
  // Its own summarizing request is the auditor's spend, counted when core reports it (`withCompaction`), at the model the compacting reviewer ran on (`compactionModel`): a former reviewer's too, so a switch or a /clear does not move a late compaction onto another model's price.
  on('session.compact', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined || standingOf(await readConversation($), agentId) === 'neither') return next(e)
    const result = await next({ ...e, instructions: e.instructions === undefined ? REVIEWER_COMPACTION : `${e.instructions}\n\n${REVIEWER_COMPACTION}` })
    try {
      if (result.skip === undefined && result.usage !== undefined) {
        // The stored ids are read only where the chain is needed: for a reviewer whose spawn result never landed.
        const ids = compactionModel(await readConversation($), agentId, {}) === undefined ? await readModelIds($) : {}
        await change($, c => withCompaction(c, result.usage, compactionModel(c, agentId, ids)))
      }
    } catch (err) {
      recordFailed($, 'compaction cost', err)
    }
    return result
  })

  // A known reviewer's verified end-of-run notice is consumed where it arrives, so no "Teammate … finished" row is drawn and the worker spends no turn on it; a reviewer from before a /clear included. Any other verified delivery from a known reviewer is logged and passed on, so a shape no one has measured is seen, not swallowed. A note never arrives here: it reaches the worker as a peer prompt. The sender is the delivery's verified team name, never words in its body, since a consumed delivery is gone.
  on('session.receive', async ($, e, next) => {
    const { origin } = e
    if (e.agentId !== undefined || !('teammate' in origin) || !origin.isVerified) return next(e)
    try {
      if (!(await knownReviewerName($, origin.teammate))) return next(e)
    } catch (err) {
      recordFailed($, 'reviewer traffic check', err)
      return next(e)
    }
    if (isEndNotice(e.text)) {
      $.ui.log(`${PLUGIN}: consumed the end-of-run notice of reviewer ${origin.teammate}`, { to: 'debug' })
      return { consumed: END_NOTICE }
    }
    $.ui.log(`${PLUGIN}: a delivery from reviewer ${origin.teammate} that is not its end-of-run notice was passed on: ${clip(firstLine(e.text), PUSH_CHARS)}`, { to: 'debug' })
    return next(e)
  })

  // The gate on every send of a reviewer this plugin spawned, current or former, by its origin alone (`originOf`): it reads no agent list. It admits only a note for the open review (`admitSend`), and refuses the rest before the chain below runs, silently to the user: the reviewer reads the reason as its tool result, and the debug log names the reason and the send's review number, never its body. An admitted note is booked once the chain reports it delivered (`book`). A send the chain refuses in the engine's stopped-session state, or refuses while the interrupt mark is set, holds the note for the user's next prompt; any other send not delivered releases its slot, so a resend in the same turn may be admitted (`holdOrRelease`). Every other send passes untouched: the main conversation's, the worker's own agents', and this plugin's briefs.
  on('session.send', async ($, e, next) => {
    if (originOf(PLUGIN, { from: 'send', origin: e.origin, agentId: e.agentId }) !== 'spawned') return next(e)
    const sent = readSend(e.to, e.text)
    const of = sent.number === null ? '' : ` (review ${sent.number})`
    let verdict: Verdict
    try {
      verdict = await admit($, sent)
    } catch (err) {
      // Fails closed: an unchecked message never reaches the worker.
      $.ui.log(`${PLUGIN}: a reviewer send${of} was refused, since its check could not read the conversation: ${reasonOf(err)}`, { to: 'debug' })
      return { isDelivered: false, reason: UNCHECKED }
    }
    if (!verdict.admitted) {
      $.ui.log(`${PLUGIN}: a reviewer send${of} was refused: ${verdict.reason}`, { to: 'debug' })
      return { isDelivered: false, reason: verdict.reason }
    }
    const { number, epoch } = verdict
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } catch (err) {
      recordFailed($, `review ${number}'s note send`, err)
      await holdOrRelease($, { number, epoch, sent, reason: undefined, filling: false })
      return { isDelivered: false, reason: `the message was not sent: ${reasonOf(err)}` }
    }
    if (!result.isDelivered) {
      $.ui.log(`${PLUGIN}: review ${number}'s note was not delivered: ${result.reason}`, { to: 'debug' })
      await holdOrRelease($, { number, epoch, sent, reason: result.reason, filling: false })
      return result
    }
    // The note reached the worker's queue, so a failure here leaves its slot filled, and a resend stays refused.
    try {
      await book($, sent, number, epoch)
    } catch (err) {
      recordFailed($, `review ${number}'s note booking`, err)
    }
    return result
  })

  // A session end lets the current reviewer go (`letGo`), forgets its open review and that review's note slot, so a late turn end from it matches nothing and its late sends are refused; its open review is logged as incomplete. The reviewer markers are kept: they mark traffic, not a review.
  on('session.end', async ($, e, next) => {
    const ended = { conversation: undefined as Conversation | undefined }
    // An exiting process ends the reviewer with it, so no stop is attempted (the engine has no session to take one in by then).
    const exiting = EXIT_REASONS.includes(e.reason)
    let released: string | undefined
    try {
      // The forgotten reviewer is stopped first, before the log is written: the session end's hooks run under a short wall-clock bound, and issued first the stop has all of it before an abort can cut it off.
      const done = await release($, c => {
        ended.conversation = c
        const gone = letGo(c, 'session end', c.reviewer?.id)
        // The toggle is the session's: a /clear keeps it off. The reviewer markers are kept, so a pre-/clear reviewer's late end notice is still consumed, its calls stay out of the record and its task row stays hidden; so is the reason the reviewer was let go. Everything else starts over, and the epoch moves on (`epoch`). The spawns still in flight are kept for their dispatches to settle (`spawnsInFlight`).
        return { next: { ...fresh(), dispatches: c.dispatches, dispatchesAtPrompt: c.dispatches, off: c.off, epoch: c.epoch + 1, spawnsInFlight: c.spawnsInFlight, ...markers(c), lastLetGo: gone.next.lastLetGo }, released: gone.released }
      }, false, !exiting)
      released = done.released
    } catch (err) {
      recordFailed($, 'session end', err)
      // The reset did not land, so the state still holds the session as it was: read it, for the stop and the log. A read that fails too is logged, and the session end goes on without them. The state still names the reviewer it forgot, so the stop passes false (`stopReviewer`).
      try {
        ended.conversation = await readConversation($)
        released = letGo(ended.conversation, 'session end', ended.conversation.reviewer?.id).released
        if (!exiting) await stopReviewer($, released, false)
      } catch (readErr) {
        recordFailed($, 'session end read', readErr)
      }
    }
    const closing = ended.conversation
    if (exiting && released !== undefined) $.ui.log(`${PLUGIN}: the session is exiting, which ends the reviewer with it, so it is not stopped`, { to: 'debug' })
    if (closing !== undefined) await logDropped($, e.sessionId, log, closing, `session ended: ${e.reason}`)
    return next(e)
  })

  // Every prompt the worker receives goes into the record where it arrives, a reviewer's note among them: it arrives as a peer prompt carrying the reviewer's agent message, and passes on unchanged. A prompt a later hook drops never entered. The one note the plugin itself delivers is a held one (`holdOrRelease`): it rides beside the user's next own prompt.
  on('prompt.submit', async ($, e, next) => {
    // A reviewer's hand-back reaches prompt submission only in a session without agent teams, where the reviewer is a plain subagent: it is bookkeeping, not the worker's, and is dropped rather than start a worker turn. No note is ever dropped here, since a drop always shows the user a "Prompt dropped by a hook" row.
    if (isHandBack(IDENTITY, e)) return { drop: 'reviewer bookkeeping' }
    // The held notes ride beside the user's next own prompt; never beside a slash command, which may not reach the model, nor a plugin's or a peer's prompt.
    const carries = isUserKind(e.origin.kind) && e.command === undefined
    let taken: TakenNotes = { notes: [], epoch: 0 }
    // Whether this prompt took the held notes, none or some: only then does it clear the interrupt mark.
    let took = false
    if (carries) {
      try {
        taken = await takePending($)
        took = true
      } catch (err) {
        // A failed take carries none, and they wait for the next prompt.
        recordFailed($, 'held notes', err)
      }
    }
    const held = taken.notes
    const notesText = framedOf(held)
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(held.length === 0 ? e : { ...e, context: [...(e.context ?? []), notesText] })
    } catch (err) {
      if (held.length > 0) await restorePending($, taken)
      throw err
    }
    // A dropped prompt never entered, so its notes go back as they were.
    if ('drop' in result) {
      if (held.length > 0) await restorePending($, taken)
      return result
    }
    try {
      // The prompt entered, so the worker is mid-turn until its turn ends; a note's peer prompt too. A plugin's own submission reaches this hook too. The user's own prompt ends the stall guard; one that took the held notes, whether or not any were waiting, clears the interrupt mark.
      await change($, c => ({ ...c, midTurn: true, turnStart: turnStartOf(c, e), ...(isUserKind(e.origin.kind) ? { nudged: false, dispatchesAtPrompt: c.dispatches } : {}), ...(took ? { interrupted: false } : {}) }))
      await appendEntry($, promptEntry(e.origin.kind, result.text))
      // The notes enter the record as the plugin's own prompt, so the reviewer sees what it already said.
      if (held.length > 0) await appendEntry($, promptEntry('plugin', notesText))
    } catch (err) {
      recordFailed($, 'turn record', err)
    }
    if (held.length > 0) $.ui.log(`${PLUGIN}: attached the held notes of reviews ${held.map(n => n.number).join(', ')} beside the user's prompt`, { to: 'debug' })
    return result
  })

  // Every tool call of the worker's loops goes into the record, except the reviewers' own and the plugin's own briefs and pushes.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    try {
      const c = await readConversation($)
      // A reviewer's calls, a retired one's included, are not the worker's.
      if (standingOf(c, e.agentId) !== 'neither') return result
      const { tool, tool_use_id: _id, agentId, ...input } = e
      // A brief's own call leaves flight whichever origin the engine tags it with.
      const brief = briefCalled(c, tool, input)
      if (brief !== undefined) {
        await unflightBrief($, brief)
        return result
      }
      // Nor is a call this plugin's own hook made (its push, its stops) the worker's.
      if (next.origin.plugin === PLUGIN) return result
      // A subagent loop's call is the worker's only if `$.agent.list()` names its id as the worker's: the engine's forks (compaction, memory) carry ids no list names (index.d.ts:199-200). The label a list gives is kept, so the id's later calls read no list.
      const known = agentId === undefined ? undefined : c.subagents[agentId]
      const listed = agentId === undefined || known !== undefined ? undefined : await listedLabel($, agentId)
      if (listed === 'other') return result
      const learned = typeof listed === 'object' ? listed : undefined
      const failed = result.deny !== undefined || result.isError === true
      const line = toolLine({
        tool,
        input,
        agent: agentId === undefined ? undefined : describeAgent(agentId, known ?? learned),
        text: result.deny ?? result.text ?? '',
        isError: failed,
      })
      // A subagent's call is not the worker's own main loop, so it leaves the guard as the worker's last call set it.
      await change($, s => withEntry(agentId === undefined ? { ...s, lastAsked: asksUser(tool, input), messaged: sentTo(s.messaged, tool, input, failed) } : learned === undefined ? s : { ...s, subagents: { ...s.subagents, [agentId]: learned } }, line))
    } catch (err) {
      recordFailed($, 'turn record', err)
    }
    return result
  })

  // The reviewer's tool answers from the open review's record, or the entries since its dispatch, as they are at the call. Registered after the recorder, so the recorder sees the call first and skips the reviewer's own.
  on('tool.call', { tool: ENTRIES }, async ($, e) => {
    const c = await readConversation($)
    if (!(await isReviewerCaller($, c, e.agentId))) return { deny: REFUSED }
    const which = e['which']
    const from = e['from'] ?? 1
    if (which !== 'record' && which !== 'live') return { result: 'which must be record or live' }
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) return { result: 'from must be a whole entry number, 1 or more' }
    const review = c.review
    if (review === undefined) return { result: 'auditor has no review in progress for this reviewer, so there is no record to return' }
    const blocks = which === 'record' ? review.record : c.record.blocks
    const title = which === 'record' ? `Record of auditor review ${review.number}` : `Live entries recorded after auditor review ${review.number} was dispatched`
    if (which === 'live' && blocks.length === 0) return { result: `No entries have been recorded since auditor review ${review.number} was dispatched.` }
    if (from > blocks.length) return { result: `${title} has ${blocks.length} entries; there are none from entry ${from} on.` }
    return { result: pageOf(title, blocks, from) }
  })

  // The reviewer's lookup into the session transcript, behind the same gate as the entries tool.
  on('tool.call', { tool: TRANSCRIPT }, async ($, e) => {
    const c = await readConversation($)
    if (!(await isReviewerCaller($, c, e.agentId))) return { deny: REFUSED }
    return { result: await lookUp($, c.transcript, e) }
  })

  // The reviewer's memory tool, behind the same gate as the entries tool: one call settles or removes one entry (`changeMemory`). The gate reads the conversation once, and a /clear, a switch or the review's settle can land before the write, so the change judges the call again, with the test the settle's take uses: it writes only while the caller is still the stored reviewer and the review the gate read is still open in the gate's epoch, and otherwise changes nothing and answers REVIEW_ENDED. The debug line is written once the change lands, never inside it, since a compare-and-set change can run more than once. The result is the reviewer's alone: nothing here reaches the worker, and the recorder leaves the call out of the record, as it does every reviewer call.
  on('tool.call', { tool: MEMORY }, async ($, e) => {
    const c = await readConversation($)
    if (!(await isReviewerCaller($, c, e.agentId))) return { deny: REFUSED }
    const acted = c.review?.number
    const got: { judged?: MemoryChange } = {}
    await change($, s => {
      got.judged = undefined
      if (s.epoch !== c.epoch || s.review?.number !== acted || standingOf(s, e.agentId) !== 'current') return s
      const judged = changeMemory(s.memory, s.review?.number, e)
      got.judged = judged
      return 'refusal' in judged ? s : { ...s, memory: judged.memory }
    })
    const { judged } = got
    if (judged === undefined) return { result: REVIEW_ENDED }
    if ('refusal' in judged) return { result: judged.refusal }
    $.ui.log(`${PLUGIN}: ${judged.logged}`, { to: 'debug' })
    return { result: judged.answer }
  })

  // The worker's own model replies go into the record. A reviewer's request is not one of them: its usage is the tally's (`withResponse`), every reviewer's, a retired one's late response included, and the current reviewer's context, which rotation reads. The read gates the write, so a worker's subagent steps write nothing.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (e.agentId === undefined) {
        if (result.answer !== '') await appendEntry($, `ASSISTANT: ${result.answer}`)
      } else if (result.usage !== null && standingOf(await readConversation($), e.agentId) !== 'neither') {
        const { usage } = result
        await change($, c => {
          const counted = withResponse(c, usage)
          return standingOf(c, e.agentId) === 'current' ? { ...counted, reviewerContext: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens } : counted
        })
      }
    } catch (err) {
      recordFailed($, 'turn record', err)
    }
    return result
  })

  // The toggle sits among the footer's mode labels, where terminal and desktop draw it, and switches the reviewer off or on for this session (`switched`).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const figures = await figuresOf($, await readConversation($))
    const press = async (): Promise<void> => {
      await toggle($, log, c => !c.off)
    }
    const beneath = await next(e)
    // The separator stands between the button and what is drawn beneath, and only where something is: judged from what the hooks beneath
    // drew, since a plugin beneath may draw a label where the engine draws no mode. Core's own node draws the mode labels.
    const separator = wordsOf(beneath, e.props.modes.join(' & ')).trim() === '' ? [] : [Text({ dimColor: true, children: [' · '] })]
    return Box({
      flexDirection: 'row',
      children: [
        beneath,
        ...separator,
        buttonOf({ Box, Button, Text }, TOGGLE, figures, press),
      ],
    })
  })

  // Hidden unless the transcript is expanded: a reviewer's task row, whatever its status, for any reviewer this session has spawned (a
  // failure shows in the footer label instead).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { isExpanded, origin, task } = e.props
    if (isExpanded) return next(e)
    if (origin.kind !== 'task-notification' || task?.id === undefined) return next(e)
    if (standingOf(await readConversation($), task.id) === 'neither') return next(e)
    const { Box } = $.ui.resolve(e)
    return Box({})
  })

  // Stop and the main loop's turn end are both dispatch points.
  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    await atTurnEnd($, async () => {
      // The agent list is read before the state change, and only when the auditor is on and no guard withholds the fact.
      const prior = await readConversation($)
      const listed = prior.off || withheld(prior) ? undefined : await listAgents($)
      const before = await change($, c => withTranscript({ ...c, lastMessage: e.last_assistant_message ?? '', wake: stallFact(c, e, listed) }, e.transcript_path))
      if (before.review !== undefined && before.reviewer === undefined) {
        $.ui.log(`${PLUGIN}: the reviewer has an open review but no reviewer id: its spawn result did not name it`, { to: 'debug' })
      }
      await dispatchAtTurnEnd($, log)
    })
    return next(e)
  })

  // A reviewer's turn end settles its review inline: it closes it, or gives it its one follow-up and leaves it open. The worker's own turn end, which every outcome reaches, ends its mid-turn and dispatches.
  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        // Stop does not fire when the user aborts a turn, and its answer comes back empty (observed live), so an aborted turn's last message is its answer or the interruption.
        const last = e.answer !== '' ? e.answer : e.isAborted ? NONE_INTERRUPTED : null
        // An aborted turn has no Stop, so its end clears the stall fact the last Stop left and sets the interrupt mark; every turn end resets the last-tool-call guard and the addresses messaged in the turn.
        await change($, c => ({ ...c, midTurn: false, lastAsked: false, messaged: [], ...(e.isAborted ? { wake: null, interrupted: true } : {}), ...(last === null ? {} : { lastMessage: last }) }))
        if (e.isAborted) await appendEntry($, INTERRUPTED)
        // Stop and this turn end both dispatch: a turn with no Stop, or a reviewer settling between Stop and this end, is dispatched nowhere else. An aborted turn's end dispatches nothing, since it has just set the interrupt mark (`eligible`).
        await atTurnEnd($, () => dispatchAtTurnEnd($, log))
      } else if (await reviewerAgent($, e.agentId)) {
        await settle($, log, e.agentId, e)
      }
    } catch (err) {
      recordFailed($, 'review settlement', err)
    }
    return next(e)
  })
}
