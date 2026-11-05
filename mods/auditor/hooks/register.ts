import type { AgentInfo, AgentSpawnResult, CoreEngineInterface, ProcessRunResult, Register, TurnUsage } from 'claude-code'
import { update } from 'claude-code'
import type { Conversation, OpenReview, PendingNote, ReviewUsage, TurnEnd, TurnRecord, TurnStart, Wake } from '../types/index'
import { MAIN, admitSend, decideRefusal, followUpText, frameNote, marksOf, readSend, settleOutcome } from './notes'
import type { Decided, Outcome, Refusal, Sent, Verdict } from './notes'
import { REVIEWER_PROMPT } from './prompt'
import { clip, entryBlock, pageOf, renumberBlock, toolLine } from './record'
import { DIGEST_CHARS, LOOKUP_TIMEOUT_MS, SEARCH_TERM_CHARS, digestBlocks, digestOf, lineCommand, lookupOf, parseSearch, renderSearch, searchCommand } from './transcript'

const PLUGIN = 'auditor'
const REVIEWER = 'auditor-reviewer'
const REVIEWER_TYPE = `${PLUGIN}:reviewer`
const REVIEWER_MODEL = 'claude-haiku-5-5'
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
// A reviewer's spawn name, or the engine's rename of it when the name was taken (`auditor-reviewer-2`).
const NAMED = /(?<![\w-])auditor-reviewer(?:-\d+)?(?![\w-])/
const REVIEWER_NAME = /^auditor-reviewer(?:-\d+)?$/
// A reviewer whose context passed this many tokens is retired when its review is taken (`takeReview`), not at a turn end that gives the review its follow-up: under Haiku 5.5's 100,000-token price tier and the reviewer's compaction point, with room for one review's growth.
const ROTATE_AT = 80_000
// How many of the latest delivered notes a fresh reviewer's first brief carries.
const CARRIED_NOTES = 5
// How long a reviewer spawn may stay in flight before it is given up (`spawnsInFlight`).
const SPAWN_TIMEOUT_MS = 10 * 60 * 1000
// The reason a review is logged incomplete with when no spawn stood a reviewer in for it in SPAWN_TIMEOUT_MS (`dispatchIdle`).
const SPAWN_LAPSED = `reviewer spawn did not settle in ${SPAWN_TIMEOUT_MS / 60_000} minutes`
// What a compaction of the reviewer's own conversation keeps: the facts its judgement rests on, not the reviews that found nothing.
const REVIEWER_COMPACTION = 'You are the auditor reviewer. Keep: every instruction, rule and preference of the user you have found, with where it was given; each note you gave the worker and whether it acted on it; any disagreement still open. Drop: the details of reviews that found nothing to note.'
// A plain subagent's final report reaches prompt submission opening with this marker.
const HAND_BACK = '[Subagent hand-back]'
// The envelope an agent message arrives in, naming its sender.
const ENVELOPE = '<agent-message from='
// The reason a known reviewer's end-of-run notice is consumed with.
const END_NOTICE = 'auditor reviewer end-of-run notice'
// The reason the reviewer reads when its send is refused because the gate could not read the conversation.
const UNCHECKED = 'auditor could not check this message, so it was not sent'
// A reviewer's task notification names the reviewer's description in its summary.
const REVIEW_NOTICE = 'Agent "auditor review"'
const INTERRUPTED = 'INTERRUPTED: the user stopped this turn before it finished.'
const NONE_INTERRUPTED = '(none: the user interrupted the turn)'
const EMPTY_RECORD: TurnRecord = { blocks: [] }

type Scope = Pick<CoreEngineInterface, 'state' | 'ui' | 'clock' | 'fs' | 'env' | 'session' | 'prompt' | 'agent' | 'process' | 'tool'>
// A complete review's `note`: the body the gate let through for it, or null for a quiet review.
type Ending = { status: 'complete'; note: string | null } | { status: 'incomplete'; reason: string }
// Held notes taken for an attach, and the `epoch` at the take.
type TakenNotes = { notes: readonly PendingNote[]; epoch: number }
// `retired`: the reviewer the take retired, when it did. `epoch`: the epoch at the take.
type Taken = { review: OpenReview; model: string | null; retired: string | undefined; epoch: number }
type Closed = { review: OpenReview; model: string | null; turnEnd: TurnEnd | null }
type Finished = { answer: string; reason: string; isAborted: boolean; durationMs: number; usage?: TurnUsage }
// `epoch`: the epoch at the plan; `at`: the clock's time at the plan.
type Plan = { number: number; brief: string; send: string | undefined; epoch: number; at: number }
type Spawn = Conversation['spawnsInFlight'][number]

const fresh = (): Conversation => ({ dispatches: 0, off: false, epoch: 0, midTurn: false, pendingNotes: [], interrupted: false, lastMessage: '', transcript: null, record: EMPTY_RECORD, subagents: {}, briefsInFlight: [], failing: false, turnStart: null, reviewerIds: [], reviewerNames: [], reviewerContext: 0, deliveredNotes: [], spawnsInFlight: [], wake: null, lastAsked: false, messaged: [], nudged: false, dispatchesAtPrompt: 0 })

// The toggle, by the footer button or `/auditor`. Off stops the auditor at once: the open review is dropped with its note slot, the held notes are dropped and the reviewer is let go (`toggle` stops it), so the gate refuses every reviewer send from then on; a note let through before the switch may still arrive. Its ids still mark its traffic and rows, and its late turn end matches no reviewer. On starts an empty record and a fresh run, so no entry from the off period or before it is briefed, a failure before it no longer holds the reviewer back, and an interrupt mark from before it holds no note refused for another reason. Either clears the stall guard. A switch moves the epoch (`epoch`); setting the state it already has changes nothing.
const switched = (c: Conversation, off: boolean): Conversation =>
  c.off === off
    ? c
    : {
        ...c,
        epoch: c.epoch + 1,
        nudged: false,
        dispatchesAtPrompt: c.dispatches,
        ...(off ? { off: true, review: undefined, reviewer: undefined, reviewerContext: 0, pendingNotes: [] } : { off: false, record: EMPTY_RECORD, failing: false, interrupted: false }),
      }

// What the footer label and `/auditor` say: off by the toggle, failing until a review succeeds, else on.
const stateOf = (c: Conversation): 'on' | 'off' | 'failing' => (c.off ? 'off' : c.failing ? 'failing' : 'on')

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

const isReviewerId = (c: Conversation, agentId: string | undefined): boolean => agentId !== undefined && c.reviewer?.id === agentId

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? ''

// A reviewer's hand-back, by its own frame alone: the hand-back marker opening the first line, which names the reviewer, or opening the line right after a reviewer's agent-message envelope. A note's first line is the envelope and its second the review line, so no note matches, whatever it quotes.
const isReviewerHandBack = (text: string): boolean => {
  const [first = '', second = ''] = text.split('\n', 2)
  if (!NAMED.test(first)) return false
  return first.startsWith(HAND_BACK) || (first.startsWith(ENVELOPE) && second.startsWith(HAND_BACK))
}

// A teammate's end-of-run status notice, as the team mailbox carries it: a JSON object whose type is `idle_notification`.
const isEndNotice = (text: string): boolean => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A body that is not JSON is not a status notice; nothing failed.
    return false
  }
  return typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'idle_notification'
}

const sessionDir = async ($: Pick<CoreEngineInterface, 'env'>, sessionId: string): Promise<string> => {
  const home = await $.env.get('HOME')
  if (home === undefined) throw new Error('HOME is unset, so there is no per-session directory')
  return `${home}/.claude/auditor/${sessionId}`
}

const numbered = (n: number): string => String(n).padStart(4, '0')

// A failed record or log write must not fail the worker's turn or re-run its call: log it with its stack. Nothing is shown: only an escalation and a failing reviewer (the footer label) reach the user.
const recordFailed = ($: Pick<Scope, 'ui'>, what: string, err: unknown): void => {
  $.ui.log(`${PLUGIN}: ${what} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, { to: 'debug' })
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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
  const { review, model, turnEnd } = closed
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
      model_configured: REVIEWER_MODEL,
      model_resolved: model,
      turn_end: turnEnd === null ? null : { at: turnEnd.at, answer: turnEnd.answer, reason: turnEnd.reason, duration_ms: turnEnd.durationMs },
      note,
      // Delivered as the gate saw it: the note's send reported delivered while its review was still open, which is not the worker having read it. A review that closed before its send reported delivery, dropped or settled while the send was out, logs its note as not delivered, though the note may still reach the worker.
      note_delivered: review.delivered === true,
      escalation: marks.escalation,
      stall: marks.stall,
    }
    await $.fs.write(`${await sessionDir($, sessionId)}/${numbered(review.number)}.json`, JSON.stringify(body))
  } catch (err) {
    recordFailed($, 'review log', err)
  }
}

// Logs a review that closed with no reviewer turn end as incomplete.
const logIncomplete = ($: Scope, sessionId: string, log: boolean, review: OpenReview, model: string | null, reason: string): Promise<void> =>
  logReview($, sessionId, log, { review, model, turnEnd: null }, { status: 'incomplete', reason })

// Logs as incomplete the open review a conversation dropped (a switch to off, a session end), when it had one.
const logDropped = async ($: Scope, sessionId: string, log: boolean, c: Conversation, reason: string): Promise<void> => {
  if (c.review !== undefined) await logIncomplete($, sessionId, log, c.review, c.reviewer?.model || null, reason)
}

// The entries of a review that ended without an answer go back to the front of the record, ahead of those recorded since.
const withEntriesFirst = (entries: readonly string[], record: TurnRecord): TurnRecord => {
  const { blocks } = record
  return { blocks: [...entries, ...blocks.map((block, i) => renumberBlock(block, entries.length + i + 1))] }
}

// The conversation as it is now: read through a change, which writes the state back unchanged. A plain get answers the dispatch's starting moment; no read in the dispatch sees the writes made since it began, its own or another dispatch's, except a change.
const currentConversation = ($: Pick<Scope, 'state'>): Promise<Conversation> => change($, c => c)

const currentReviewerId = async ($: Pick<Scope, 'state'>): Promise<string | undefined> => (await currentConversation($)).reviewer?.id

// Stops a reviewer the auditor lets go (one a take retired, one a session end forgot, one a refused brief dropped, or one the toggle switched off or whose spawn landed after it), so it does not sit idle for the rest of the session; each caller says when it issues it. The engine call is not awaited, so no caller's settle or dispatch waits on it; the helper resolves once the stop is issued. Any failure, the state read included, is logged and leaves the reviewer idle, and the caller goes on. Where a respawn can follow (`mayRespawn`), an id the state holds as the current reviewer is not stopped: a fresh reviewer can come back under a forgotten id, and the stop would end it. A session end spawns none, and when its reset failed the state still names the reviewer it forgot, so it passes false.
const stopReviewer = async ($: Pick<Scope, 'state' | 'tool' | 'ui'>, id: string | undefined, mayRespawn: boolean): Promise<void> => {
  if (id === undefined) return
  try {
    // A plain get would miss a spawn this dispatch made under the id (currentReviewerId).
    if (mayRespawn && (await currentReviewerId($)) === id) return
    void $.tool.call({ tool: 'TaskStop', task_id: id }).then(
      result => {
        if (result.deny !== undefined || result.isError === true) $.ui.log(`${PLUGIN}: reviewer stop refused: ${result.deny ?? result.text ?? ''}`, { to: 'debug' })
      },
      (err: unknown) => recordFailed($, 'reviewer stop', err),
    )
  } catch (err) {
    recordFailed($, 'reviewer stop', err)
  }
}

// Takes the open review if `ready`, judged on the conversation the change reads; where `back` holds for the review taken, its entries are put back in the record in the same change. Where `mark` holds instead, the review is not taken but marked as followed up (`followedUp`), in the same change: it stays open with its entries held, and its reviewer is not retired. The dispatch failure never asks for a mark.
const takeReview = async ($: Pick<Scope, 'state'>, ready: (r: OpenReview, c: Conversation) => boolean, back: (r: OpenReview) => boolean, mark: (r: OpenReview) => boolean = () => false): Promise<Taken | undefined> => {
  const got: { taken?: Taken } = {}
  await change($, c => {
    got.taken = undefined
    const open = c.review
    if (open === undefined || !ready(open, c)) return c
    if (mark(open)) {
      got.taken = { review: open, model: c.reviewer?.model || null, retired: undefined, epoch: c.epoch }
      return { ...c, review: { ...open, followedUp: true } }
    }
    // A reviewer past ROTATE_AT is retired in the same change that ends its review, so no dispatch can plan a brief to it in between. The retired one's ids and name still mark its traffic and rows, and its tools refuse it; the caller stops it.
    const retiring = c.reviewerContext > ROTATE_AT
    got.taken = { review: open, model: c.reviewer?.model || null, retired: retiring ? c.reviewer?.id : undefined, epoch: c.epoch }
    const retire = retiring ? { reviewer: undefined, reviewerContext: 0 } : {}
    return { ...c, ...retire, review: undefined, record: back(open) ? withEntriesFirst(open.record, c.record) : c.record }
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

// A review that ends without an answer fails: the footer reads `auditor is failing` until a review succeeds, and the reason goes to the debug log. A review taken or planned under an older epoch (`epoch`) does not fail.
const markFailed = async ($: Pick<Scope, 'state' | 'ui'>, reason: string, epoch: number): Promise<void> => {
  await change($, inEpoch(epoch, c => ({ ...c, failing: true })))
  $.ui.log(`${PLUGIN}: review failed: ${reason}`, { to: 'debug' })
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

// Whether a send is a reviewer's: from the model inside an agent this plugin spawned, which the engine stamps with this plugin's origin and the agent's id. The plugin's own briefs carry no agent id.
const isReviewerSend = (e: { origin: { kind: string; name?: string }; agentId?: string }): boolean => e.origin.kind === 'plugin' && e.origin.name === PLUGIN && e.agentId !== undefined

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

// What a note's booking writes into the conversation, delivered or held, with the marks from the send's own read: a fresh reviewer's carried notes gain it, and a stall note arms the stall guard.
const withBooked = (c: Conversation, number: number, sent: Sent): Conversation => ({ ...withStallGuard(c, number, sent.stall), deliveredNotes: [...c.deliveredNotes, frameNote(number, sent.body)].slice(-CARRIED_NOTES) })

// What a delivered note triggers: its booking state, only while the conversation is still at the send's epoch (`epoch`), and in that same change its review marked delivered, while it is still open (`delivered`). An escalation is announced whatever the epoch, and even when the booking write throws: the note was delivered. The change says whether it found the review; when it found none (the review was taken, or the epoch moved), the review's log was written with `note_delivered` false and stays so, and one debug line names the review.
const book = async ($: Scope, sent: Sent, number: number, epoch: number): Promise<void> => {
  announce($, sent)
  const got = { found: false }
  await change($, c => {
    got.found = false
    return inEpoch(epoch, s => {
      got.found = s.review?.number === number
      return { ...withBooked(s, number, sent), ...(s.review?.number === number ? { review: { ...s.review, delivered: true } } : {}) }
    })(c)
  })
  if (!got.found) $.ui.log(`${PLUGIN}: review ${number}'s note was delivered after its review closed, so its log keeps note_delivered false`, { to: 'debug' })
}

// The one hold-or-release step for a note whose send was not delivered (`decideRefusal`), run in one change: the gate's note, whose slot admission filled (`filling` false), and the follow-up's, which the step admits itself (`filling` true). `reason` is the engine's refusal, absent for a send that threw. A held note gets the booking effects a delivered one gets, bar the delivered mark, and an escalation is announced then. If the change throws, nothing is held or released: the failure is logged with its stack, the slot stays as it was, and an escalation is still announced, as for a failed booking. Returns what the change decided, or undefined when it threw.
const holdOrRelease = async ($: Scope, refusal: Refusal): Promise<Decided | undefined> => {
  const { number, sent } = refusal
  const got: { decided?: Decided } = {}
  try {
    await change($, c => {
      got.decided = decideRefusal(c, refusal, state => withBooked(state, number, sent))
      return got.decided.next
    })
  } catch (err) {
    recordFailed($, `review ${number}'s note hold or release`, err)
    announce($, sent)
    return undefined
  }
  if (got.decided?.outcome === 'hold') {
    announce($, sent)
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
  const taken = await takeReview($, (_r, c) => isReviewerId(c, agentId), r => outcomeOf(r).status === 'incomplete', r => outcomeOf(r).status === 'follow-up')
  if (taken === undefined) {
    $.ui.log(`${PLUGIN}: the reviewer ended a turn with no review in progress; not recorded`, { to: 'debug' })
    return
  }
  const { review, model, retired, epoch } = taken
  const outcome = outcomeOf(review)
  if (outcome.status === 'follow-up') {
    await followUp($, log, agentId, done, review.number, epoch)
    return
  }
  // The stop is issued last whatever the close or dispatch does: a retired reviewer is never left running by a throw.
  try {
    const turnEnd: TurnEnd = { at: await $.clock.now(), answer: done.answer, reason: done.reason, durationMs: done.durationMs, usage: usageOf(done.usage) }
    const sessionId = await $.session.id()
    const closed: Closed = { review, model, turnEnd }
    if (outcome.status === 'incomplete') {
      // settleOutcome fails an answer only when it is empty.
      const reason = done.reason === 'answer' ? 'reviewer ended its turn with an empty answer' : `reviewer turn ended with reason ${done.reason}, isAborted ${done.isAborted}`
      await markFailed($, reason, epoch)
      await logReview($, sessionId, log, closed, { status: 'incomplete', reason })
      // Its restored entries wait for the worker's next turn end.
      return
    }
    // An answer the reviewer wrote instead of sending reaches no one: it is kept here, in the debug log alone, once.
    if (outcome.logAnswer && !unsent) $.ui.log(`${PLUGIN}: review ${review.number} sent no note, and its final answer was: ${done.answer}`, { to: 'debug' })
    await logReview($, sessionId, log, closed, { status: 'complete', note: outcome.note })
    // The failure clears under the take's epoch (`epoch`), and a moved epoch dispatches nothing.
    const after = await change($, inEpoch(epoch, c => ({ ...c, failing: false })))
    if (after.epoch !== epoch) return
    // An idle worker gets the next brief at once; a busy one's turn end dispatches. midTurn is read through a change (currentConversation), since a plain get answers the dispatch's starting moment and misses a prompt that entered while this settle ran, a note's own among them.
    if (!(await currentConversation($)).midTurn) await dispatchIdle($, log)
  } finally {
    await stopReviewer($, retired, true)
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

// A guard withholds the stall fact: the turn's last tool call asked the user, or a stall note on a review dispatched since the user's last prompt was delivered.
const withheld = (c: Conversation): boolean => c.lastAsked || c.nudged

// The agent list's statuses that are in flight. A waiting agent is held on background work it owns, or on a plan's approval, and resumes by itself or by a message it can send the worker.
const WORKING = ['pending', 'running', 'waiting']
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
  const agents = listed.filter(a => !c.reviewerIds.includes(a.id) && (WORKING.includes(a.status) || c.messaged.some(to => addressedBy(a, to))))
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

// The notes earlier reviewers delivered, which a fresh reviewer's first brief carries; it finds the user's rules again itself.
const carriedLines = (notes: readonly string[]): string[] =>
  notes.length === 0 ? [] : ['You are a fresh reviewer of this conversation. The notes earlier reviewers gave the worker, oldest first:', ...notes, 'Find the user\'s instructions again with your transcript tool before you judge.']

// What the review is told: its number, the entries its record covers, how to fetch them and the entries recorded since, the wake-up line, and the worker's last message; a fresh reviewer is told the earlier notes first.
const briefOf = (number: number, entries: number, lastMessage: string, wake: Wake | null, carried: readonly string[] = []): string => [
  ...carriedLines(carried),
  'The worker finished a turn.',
  `Review ${number}. Its record holds entries 1-${entries}, everything recorded since the previous review was dispatched. Fetch it with the ${ENTRIES} tool, which: 'record', page by page as each page's header says.`,
  `The worker may have kept working since this dispatch. Its later entries come from the same tool, which: 'live', read as they are at each call.`,
  ...wakeLines(wake),
  'Worker last message:',
  lastMessage === '' ? '(none)' : lastMessage,
].join('\n')

// After a failed review only a turn the user's own prompt started dispatches: a notice, a peer's message or a plugin's own prompt does not.
const eligible = (c: Conversation): boolean => !c.off && c.review === undefined && c.record.blocks.length > 0 && !(c.failing && c.turnStart !== 'user')

// The brief a SendMessage's message or an Agent call's prompt is, when it is exactly one in flight: the plugin's own call, which the record leaves out.
const briefCalled = (c: Conversation, tool: string, input: Record<string, unknown>): string | undefined => {
  const text = tool === 'SendMessage' ? input['message'] : tool === 'Agent' ? input['prompt'] : undefined
  return typeof text === 'string' && c.briefsInFlight.includes(text) ? text : undefined
}

// The reviewer gets one brief when it has no open review and turns since its last dispatch.
// Eligibility is judged in the change alone: a get reads the dispatch's starting moment, so a settle's own take of the open review is invisible to it.
const dispatchIdle = async ($: Scope, log: boolean): Promise<void> => {
  const now = await $.clock.now()
  // Read before the review opens, so a failed read leaves none open that no brief went out for; and before the brief goes out, so a /clear while it is in flight leaves a failed review's log in the session it was dispatched in.
  const sessionId = await $.session.id()
  // Set by the change's last run alone: a compare-and-set retry plans again from the state it read.
  const planned: { plan?: Plan; lapsed?: OpenReview } = {}
  await change($, c => {
    planned.plan = undefined
    // The one place a spawn is given up: a review still open with no reviewer stored SPAWN_TIMEOUT_MS after its dispatch has no spawn left that will stand one in, so it fails here, its entries put back.
    const open = c.review
    planned.lapsed = open !== undefined && c.reviewer === undefined && now - open.dispatchedAt > SPAWN_TIMEOUT_MS ? open : undefined
    const d = planned.lapsed === undefined ? c : { ...c, review: undefined, failing: true, record: withEntriesFirst(planned.lapsed.record, c.record) }
    if (!eligible(d)) return d
    const number = d.dispatches + 1
    const { blocks } = d.record
    planned.plan = { number, brief: briefOf(number, blocks.length, d.lastMessage, d.wake, d.reviewer === undefined ? d.deliveredNotes : []), send: d.reviewer?.id, epoch: d.epoch, at: now }
    return { ...d, dispatches: number, review: blankReview(number, now, blocks, wakesNothing(d.wake)), record: EMPTY_RECORD }
  })
  const { plan, lapsed } = planned
  if (lapsed !== undefined) {
    await logIncomplete($, sessionId, log, lapsed, null, SPAWN_LAPSED)
    $.ui.log(`${PLUGIN}: review failed: ${SPAWN_LAPSED}`, { to: 'debug' })
  }
  if (plan === undefined) return
  try {
    await deliverBrief($, plan)
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

// Whether an older epoch's spawn still in flight blocks adoption of `agentId` by name at `now` (`spawnsInFlight`): one whose hook named another id does not, nor one past SPAWN_TIMEOUT_MS. With no clock reading every such spawn blocks.
const blocksAdoption = (c: Conversation, s: Spawn, agentId: string, now: number | undefined): boolean =>
  s.epoch !== c.epoch && (s.id === undefined || s.id === agentId) && (now === undefined || now - s.startedAt <= SPAWN_TIMEOUT_MS)

// The entry a spawn hook's brief names, matched as `spawnsInFlight` states.
const matchSpawn = (spawns: readonly Spawn[], brief: string): Spawn | undefined => spawns.find(s => s.brief === brief)

// A reviewer spawn's id, as the spawn hook sees it, and the team name it runs under: the agent list's, since the engine renames a taken name, else the name it was spawned under. The id and name mark the reviewer's traffic and rows from here on. The id and the model the spawn resolved to are kept on the spawn's entry in `spawnsInFlight` for the spawning dispatch, which has the last word on whether the spawn stays the reviewer (`deliverBrief`). The spawn stands in as the reviewer at once where `spawnsInFlight` allows it, so its calls and turn end are the reviewer's before its dispatch resumes.
const recordSpawnedId = async ($: Pick<Scope, 'state' | 'ui' | 'agent'>, brief: string, started: AgentSpawnResult): Promise<void> => {
  if (started.deny !== undefined || started.agentId === undefined) return
  const { agentId: id, model } = started
  const listed = await listAgents($)
  const name = listed?.find(a => a.id === id)?.name ?? REVIEWER
  await change($, c => {
    const own = matchSpawn(c.spawnsInFlight, brief)
    const standsIn = !c.off && c.reviewer === undefined && own !== undefined && own.epoch === c.epoch && own.number === c.review?.number
    return { ...c, spawnsInFlight: c.spawnsInFlight.map(s => (s === own ? { ...s, id, model } : s)), ...(standsIn ? { reviewer: { id, model } } : {}), reviewerIds: c.reviewerIds.includes(id) ? c.reviewerIds : [...c.reviewerIds, id], reviewerNames: c.reviewerNames.includes(name) ? c.reviewerNames : [...c.reviewerNames, name] }
  })
  $.ui.log(`${PLUGIN}: reviewer id ${id} (${name}) from its spawn result`, { to: 'debug' })
}

// The agent list, or undefined when it rejects: each caller says what a lost list means.
const listAgents = ($: Pick<Scope, 'agent' | 'ui'>): Promise<AgentInfo[] | undefined> =>
  $.agent.list().catch((err: unknown) => {
    recordFailed($, 'agent list', err)
    return undefined
  })

// Whether a verified team name is one of this conversation's reviewers. A name shaped like a reviewer's that is not yet known (its spawn result's list lookup failed or lagged) is looked up again by the agent list: it is learned when the list gives it to one of this conversation's reviewer ids.
const knownReviewerName = async ($: Pick<Scope, 'state' | 'agent' | 'ui'>, name: string): Promise<boolean> => {
  const c = await readConversation($)
  if (c.reviewerNames.includes(name)) return true
  if (!REVIEWER_NAME.test(name)) return false
  // A failed list takes the name as a reviewer's: a verified sender under a reviewer's name is this plugin's, and its traffic to the worker is clutter either way.
  const listed = await listAgents($)
  if (listed === undefined) return true
  const owner = listed.find(a => a.name === name && c.reviewerIds.includes(a.id))
  if (owner === undefined) return false
  await change($, s => (s.reviewerNames.includes(name) ? s : { ...s, reviewerNames: [...s.reviewerNames, name] }))
  return true
}

// Takes `brief`'s entry out of `spawnsInFlight`. A failed write is logged and leaves the entry, which blocks no adoption past SPAWN_TIMEOUT_MS (`blocksAdoption`).
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

// The one step that sends a plugin message, a brief or a follow-up, to the stored reviewer `to`. It goes out only while the conversation is still at the epoch (`epoch`) and open review `number` it was planned under, and is 'stale' otherwise. It is held in flight (`briefsInFlight`) until its call reaches the recorder, which takes it out and leaves the call out of the record; a refused or thrown send takes it out here. It carries no agent id, so the send gate passes it untouched. Each caller decides what a refusal means.
const sendToReviewer = async ($: Scope, to: string, text: string, epoch: number, number: number): Promise<Delivery> => {
  const ours = (c: Conversation): boolean => c.epoch === epoch && c.review?.number === number
  const queued = await change($, c => (ours(c) ? { ...c, briefsInFlight: [...c.briefsInFlight, text] } : c))
  if (!ours(queued)) return { status: 'stale' }
  const sent = await $.session.send({ to, text }).catch(async (err: unknown) => {
    await leaveFlight($, text)
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

const deliverBrief = async ($: Scope, plan: Plan): Promise<void> => {
  const { send, brief, number } = plan
  // The plan's review must still be the open one, at the plan's epoch (`epoch`); otherwise its brief goes to no reviewer, stored or spawned.
  const ours = (c: Conversation): boolean => c.epoch === plan.epoch && c.review?.number === number
  if (send !== undefined) {
    const sent = await sendToReviewer($, send, brief, plan.epoch, number)
    if (sent.status !== 'refused') return
    // The stored reviewer did not take the brief, so it is no longer the reviewer: this dispatch spawns one.
    $.ui.log(`${PLUGIN}: the reviewer's send was refused, so a new reviewer is spawned: ${sent.reason}`, { to: 'debug' })
  }
  // A fresh reviewer is told the notes earlier reviewers delivered: a brief planned for the stored reviewer gains them here. The spawn's brief enters flight in this change, until its Agent call reaches the recorder.
  // A plan whose review was dropped, before the spawn or while the send was refused, spawns no reviewer and stops the refused reviewer there as well. The spawn is committed in this change as an entry in `spawnsInFlight` under the plan's epoch (`epoch`), which the finally takes out.
  const spawned = { brief, dropped: false }
  await change($, c => {
    spawned.dropped = !ours(c)
    if (spawned.dropped) return c
    spawned.brief = send === undefined ? brief : [...carriedLines(c.deliveredNotes), brief].join('\n')
    return { ...c, reviewer: undefined, reviewerContext: 0, spawnsInFlight: [...c.spawnsInFlight, { brief: spawned.brief, epoch: plan.epoch, number, startedAt: plan.at }], briefsInFlight: [...c.briefsInFlight, spawned.brief] }
  })
  if (spawned.dropped) {
    await stopReviewer($, send, true)
    return
  }
  // The plan's catch takes its own brief out of flight; a brief rewritten for the spawn is taken out here when the spawn throws or is refused.
  const unflight = async (): Promise<void> => {
    if (spawned.brief !== brief) await unflightBrief($, spawned.brief)
  }
  // However the spawn settles, the finally takes its entry out of `spawnsInFlight`, with what the spawn hook kept on it, and stops the refused stored reviewer (`send` is set only when its send was refused).
  try {
    const started = await $.agent.spawn({
      subagentType: REVIEWER_TYPE,
      name: REVIEWER,
      description: 'auditor review',
      prompt: spawned.brief,
    }).catch(async (err: unknown) => {
      await unflight()
      throw err
    })
    if (started.deny !== undefined) {
      await unflight()
      throw new Error(`reviewer spawn refused: ${started.deny}`)
    }
    // The landing's one change, under the plan's epoch (`epoch`): its id is the result's, else its entry's, else the stored reviewer's; a spawn that is not stale stands in as the reviewer while its review is open (`spawnsInFlight`).
    const landed: { id?: string; stale: boolean; stood: boolean } = { stale: false, stood: false }
    await change($, c => {
      const kept = matchSpawn(c.spawnsInFlight, spawned.brief)
      landed.stale = c.epoch !== plan.epoch
      landed.stood = false
      // Under the plan's epoch (`epoch`) a reviewer stored since the spawn change can only be this spawn, adopted by name before its hook stood it in.
      const id = started.agentId ?? kept?.id ?? (landed.stale ? undefined : c.reviewer?.id)
      landed.id = id
      if (id === undefined) return c
      // The id marks the spawn's traffic and rows even when the spawn hook never saw it.
      const known = c.reviewerIds.includes(id) ? c : { ...c, reviewerIds: [...c.reviewerIds, id] }
      // A review that already closed, with another reviewer or none stored, means this spawn was retired or replaced since: it is not stood in again.
      landed.stood = !landed.stale && (c.review?.number === number || c.reviewer?.id === id)
      if (landed.stood) return { ...known, reviewer: { id, model: kept?.id === id && kept.model !== undefined ? kept.model : (started.model ?? '') } }
      // Otherwise the stored reviewer stays as it is: a stale spawn stored as the reviewer was adopted by name in the current epoch and may hold a later review, which clearing it would leave open with no reviewer to settle it. The landing then stops a stale id that is not the stored reviewer; `stopReviewer` skips the stored one, so the adopted reviewer runs on.
      return known
    })
    // A stale landing with no id stops nothing. No catch takes its brief out of flight, so it leaves here.
    if (landed.id === undefined && landed.stale) {
      await unflightBrief($, spawned.brief)
      return
    }
    if (landed.id === undefined) {
      await unflight()
      throw new Error('reviewer spawn returned no agent id')
    }
    // A stale spawn, or one whose review closed since under no reviewer of its own (`dispatchIdle` gave it up), is let go.
    if (!landed.stood) await stopReviewer($, landed.id, true)
  } finally {
    await releaseSpawn($, spawned.brief)
    await stopReviewer($, send, true)
  }
}

// A dispatch error marks the reviewer failing (`markFailed`) whether or not its review is still open; only an open review is logged.
const failReview = async ($: Scope, sessionId: string, log: boolean, plan: Plan, reason: string): Promise<void> => {
  const taken = await takeReview($, r => r.number === plan.number, () => true)
  // As in settle, the stop is issued last whatever the bookkeeping does: a retired reviewer is never left running by a throw.
  try {
    await markFailed($, reason, plan.epoch)
    if (taken === undefined) return
    await logIncomplete($, sessionId, log, taken.review, taken.model, reason)
  } finally {
    await stopReviewer($, taken?.retired, true)
  }
}

// Switches the auditor (`switched`) and returns the state after. A switch to off stops the reviewer it let go, so a review under way ends now, and logs that review as incomplete.
const toggle = async ($: Scope, log: boolean, off: (c: Conversation) => boolean): Promise<Conversation> => {
  // Read before the switch, so a /clear in between leaves the review's log in the session it was dispatched in. A failed read costs only that log: the switch still lands.
  const sessionId = await $.session.id().catch((err: unknown) => {
    recordFailed($, 'toggle session read', err)
    return undefined
  })
  const before: { c?: Conversation } = {}
  const after = await change($, c => {
    before.c = c
    return switched(c, off(c))
  })
  const was = before.c
  if (was === undefined || was.off || !after.off) return after
  await stopReviewer($, was.reviewer?.id, true)
  if (sessionId !== undefined) await logDropped($, sessionId, log, was, 'the auditor was switched off')
  return after
}

// Whether the caller is the reviewer: the one gate of the reviewer's tools.
const isReviewerCaller = async ($: Pick<Scope, 'agent' | 'state' | 'ui' | 'clock'>, c: Conversation, agentId: string | undefined): Promise<boolean> =>
  isReviewerId(c, agentId) || (agentId !== undefined && (await adoptByName($, agentId)))

const reviewerAgent = async ($: Pick<Scope, 'state'>, agentId: string | undefined): Promise<boolean> =>
  isReviewerId(await readConversation($), agentId)

// A caller no stored reviewer id names may be the reviewer whose spawn result has not landed yet: the agent list names it by its spawn name and as this plugin's spawn (`spawnedBy`), and its id is stored here. A worker's own subagent under a reviewer's name, of the reviewer's type or another, is not adopted, so its calls stay in the record.
// Only a reviewer with no stored id is adopted: a second agent under the reviewer's name is refused, not swapped in. Nothing is adopted while off, nor while a spawn from an older epoch blocks it (`spawnsInFlight`): the caller could be that spawn's agent. One whose hook named another id cannot be the caller, so it blocks nothing.
const adoptByName = async ($: Pick<Scope, 'agent' | 'state' | 'ui' | 'clock'>, agentId: string): Promise<boolean> => {
  const listed = await listAgents($)
  const caller = listed?.find(a => a.id === agentId)
  if (caller?.name === undefined || !REVIEWER_NAME.test(caller.name) || caller.spawnedBy !== PLUGIN) return false
  const name = caller.name
  const now = await $.clock.now().catch((err: unknown) => {
    recordFailed($, 'adoption clock read', err)
    return undefined
  })
  const after = await change($, c => (!c.off && c.reviewer?.id === undefined && !c.reviewerIds.includes(agentId) && !c.spawnsInFlight.some(s => blocksAdoption(c, s, agentId, now)) ? { ...c, reviewer: { id: agentId, model: '' }, reviewerIds: [...c.reviewerIds, agentId], reviewerNames: c.reviewerNames.includes(name) ? c.reviewerNames : [...c.reviewerNames, name] } : c))
  return isReviewerId(after, agentId)
}

// What `$.agent.list()` says of a subagent id: its label when the list names it as the worker's, `other` when it does not name it or names it as this plugin's spawn (a reviewer whose id has not landed yet), `unlisted` when the list rejects. A rejected list still records the call, since a lost list costs one stray entry, not a worker's entry; only an id named as the worker's is kept.
const listedLabel = async ($: Pick<Scope, 'agent' | 'ui'>, agentId: string): Promise<Label | 'other' | 'unlisted'> => {
  const listed = await listAgents($)
  if (listed === undefined) return 'unlisted'
  const found = listed.find(a => a.id === agentId)
  return found === undefined || found.spawnedBy === PLUGIN ? 'other' : { type: found.type ?? '', name: found.name ?? '' }
}

// A reviewer's task notification (failed, stopped or finished), which the engine raises as a prompt of task-notification origin. A batch that holds another task's notification too is a normal turn: every block in it must name the reviewer. Text with no block at all is judged by its text, as before.
const TASK_BLOCK = /<task-notification>[\s\S]*?<\/task-notification>/g
const isReviewerNotice = (e: { text: string; origin: { kind: string } }): boolean => {
  if (e.origin.kind !== 'task-notification') return false
  const blocks = e.text.match(TASK_BLOCK)
  if (blocks === null) return e.text.includes(REVIEW_NOTICE)
  return blocks.every(block => block.includes(REVIEW_NOTICE))
}

// What started a worker turn, by the prompt that starts it. A user prompt that joins a running turn makes that turn the user's; any other prompt joining one leaves the turn's start as it was. A user prompt that joins a notice turn starts recording there: the notice's own entries and the turn's earlier replies stay out of the record, so the review covers what follows.
const turnStartOf = (c: Conversation, e: { text: string; origin: { kind: string } }): TurnStart => {
  if (isUserKind(e.origin.kind)) return 'user'
  if (c.midTurn) return c.turnStart ?? 'other'
  return isReviewerNotice(e) ? 'notice' : 'other'
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
    await $.command.register({ name: 'auditor', description: 'Turn the auditor reviewer on or off for this session, or say which it is', argumentHint: '[on|off]', immediate: true })
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
    await $.agent.register({
      name: 'reviewer',
      description: 'auditor reviewer: audits the worker session each turn',
      prompt: REVIEWER_PROMPT,
      // SendMessage carries the review's one note to the worker; the gate (`session.send`) refuses every other send.
      tools: ['Read', 'Glob', 'Grep', 'SendMessage', ENTRIES, TRANSCRIPT],
      model: REVIEWER_MODEL,
      effort: REVIEWER_EFFORT,
      autoCompactWindow: 100_000,
    })
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

  // A reviewer's spawn result reaches its hook, not the plugin's caller, so the id is taken here.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      // Who spawned it, not its type or name: a worker may spawn its own agent of the reviewer's type, under the reviewer's name.
      if (next.origin.plugin === PLUGIN) {
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
    if (wanted !== '' && wanted !== 'on' && wanted !== 'off') return { text: 'Usage: /auditor [on|off]' }
    const after = wanted === '' ? await readConversation($) : await toggle($, log, () => wanted === 'off')
    return { text: `auditor is ${stateOf(after)}` }
  })

  // A compaction of a reviewer's own conversation keeps what its judgement rests on; the worker's is left as it is.
  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined || !(await readConversation($)).reviewerIds.includes(e.agentId)) return next(e)
    return next({ ...e, instructions: e.instructions === undefined ? REVIEWER_COMPACTION : `${e.instructions}\n\n${REVIEWER_COMPACTION}` })
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

  // The gate on every send of a reviewer this plugin spawned, current or former, by its origin alone (`isReviewerSend`): it reads no agent list. It admits only a note for the open review (`admitSend`), and refuses the rest before the chain below runs, silently to the user: the reviewer reads the reason as its tool result, and the debug log names the reason and the send's review number, never its body. An admitted note is booked once the chain reports it delivered (`book`). A send the chain refuses in the engine's stopped-session state, or refuses while the interrupt mark is set, holds the note for the user's next prompt; any other send not delivered releases its slot, so a resend in the same turn may be admitted (`holdOrRelease`). Every other send passes untouched: the main conversation's, the worker's own agents', and this plugin's briefs.
  on('session.send', async ($, e, next) => {
    if (!isReviewerSend(e)) return next(e)
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

  // A session end forgets the current reviewer, its open review and that review's note slot, so a late turn end from it matches nothing and its late sends are refused; its open review is logged as incomplete. The reviewer markers are kept: they mark traffic, not a review.
  on('session.end', async ($, e, next) => {
    const ended = { conversation: undefined as Conversation | undefined }
    try {
      await change($, c => {
        ended.conversation = c
        // The toggle is the session's: a /clear keeps it off. The reviewer markers are kept, so a pre-/clear reviewer's late end notice is still consumed, its calls stay out of the record and its task row stays hidden. Everything else starts over, and the epoch moves on (`epoch`). The spawns still in flight are kept for their dispatches to settle (`spawnsInFlight`).
        return { ...fresh(), dispatches: c.dispatches, dispatchesAtPrompt: c.dispatches, off: c.off, epoch: c.epoch + 1, spawnsInFlight: c.spawnsInFlight, reviewerIds: c.reviewerIds, reviewerNames: c.reviewerNames }
      })
    } catch (err) {
      recordFailed($, 'session end', err)
      // The reset did not land, so the state still holds the session as it was: read it, for the stop and the log. A read that fails too is logged, and the session end goes on without them.
      try {
        ended.conversation = await readConversation($)
      } catch (readErr) {
        recordFailed($, 'session end read', readErr)
      }
    }
    const closing = ended.conversation
    // The forgotten reviewer is stopped first, before the log is written: the session end's hooks run under a short wall-clock bound, and issued first the stop has all of it before an abort can cut it off.
    await stopReviewer($, closing?.reviewer?.id, false)
    if (closing !== undefined) await logDropped($, e.sessionId, log, closing, `session ended: ${e.reason}`)
    return next(e)
  })

  // Every prompt the worker receives goes into the record where it arrives, a reviewer's note among them: it arrives as a peer prompt carrying the reviewer's agent message, and passes on unchanged. A prompt a later hook drops never entered. The one note the plugin itself delivers is a held one (`holdOrRelease`): it rides beside the user's next own prompt.
  on('prompt.submit', async ($, e, next) => {
    // A reviewer's hand-back reaches prompt submission only in a session without agent teams, where the reviewer is a plain subagent: it is bookkeeping, not the worker's, and is dropped rather than start a worker turn. No note is ever dropped here, since a drop always shows the user a "Prompt dropped by a hook" row.
    if (e.origin.kind === 'peer' && isReviewerHandBack(e.text)) return { drop: 'reviewer bookkeeping' }
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
      if (e.agentId !== undefined && c.reviewerIds.includes(e.agentId)) return result
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

  // The worker's own model replies go into the record. The reviewer's request is not one of them: its usage is the reviewer's context, which rotation reads.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      if (e.agentId === undefined) {
        if (result.answer !== '') await appendEntry($, `ASSISTANT: ${result.answer}`)
      } else if (await reviewerAgent($, e.agentId)) {
        const { usage } = result
        if (usage !== null) await change($, c => ({ ...c, reviewerContext: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens }))
      }
    } catch (err) {
      recordFailed($, 'turn record', err)
    }
    return result
  })

  // The toggle sits among the footer's mode labels, where terminal and desktop draw it, and switches the reviewer off or on for this session (`switched`).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const conversation = await readConversation($)
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
        Button({ key: TOGGLE, plain: true, dimColor: true, label: `auditor is ${stateOf(conversation)}`, onPress: press }),
      ],
    })
  })

  // Hidden unless the transcript is expanded: a reviewer's task row, whatever its status, for any reviewer this session has spawned (a
  // failure shows in the footer label instead).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { isExpanded, origin, task } = e.props
    if (isExpanded) return next(e)
    if (origin.kind !== 'task-notification' || task?.id === undefined) return next(e)
    if (!(await readConversation($)).reviewerIds.includes(task.id)) return next(e)
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
        // Stop and this turn end both dispatch: a turn with no Stop (an abort), or a reviewer settling between Stop and this end, is dispatched nowhere else.
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
