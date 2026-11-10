import { describe, expect, test } from 'claude-code/testing'
import { LOOKUP_TIMEOUT_MS, lineCommand, searchCommand } from './transcript'
import { MEMORY, MEMORY_ACTION, MEMORY_FIELD, REVIEW_ENDED, printMemory, renderMemory } from './memory'
import { followUpText } from './notes'
import { PRICED_MODEL } from './pricing'
import { learn } from './reviewer'
import type { MemoryEntry } from '../types/index'
import { REVIEWER_PROMPT } from './prompt'
import * as register from './register'

const ON = { options: { log: true } }
// The error the engine throws from $.tool.call where no session is bound, as the plugin sees it: a HooksError whose message the plugin's name prefixes (the debug logs of the reviewer-memory live runs show it).
const NO_SESSION_BOUND_MESSAGE = 'auditor: $.tool.call is not available in this mode: no session is bound in this process (the REPL has not mounted and no headless session is built); catch it and carry on'

const stop = { stop_hook_active: false, last_assistant_message: 'Done.', transcript_path: '/tmp/w.jsonl' }
const QUIET_STOP = { ...stop, background_tasks: [], session_crons: [] }
const STALL_NOTE = 'Stalled: you said you would update the config and ended the turn; nothing will wake you.'
// Resolves on a timer, once every microtask under way has run: a plugin's own call that is not awaited settles beside the calls around it.
const drained = (): Promise<void> => new Promise(resolve => (globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }).setTimeout(resolve, 0))

// The session is s1, and the dispatch numbers name the log files.
const DIR = '/home/test/.claude/auditor/s1'
const ENTRIES = 'mcp__auditor__entries'
const TRANSCRIPT = 'mcp__auditor__transcript'
const NO_TRANSCRIPT = 'auditor has no session transcript to look in yet, so there is nothing to find'
const REFUSED = "this tool serves only auditor's reviewers their open review's record; it is not for this agent"
const NO_REVIEW = 'auditor has no review in progress for this reviewer, so there is no record to return'
const LOG_1 = `${DIR}/0001.json`
const LOG_2 = `${DIR}/0002.json`
const TEN_MINUTES = 10 * 60 * 1000

type Env = Record<string, string>
type SpawnHold = { until: Promise<void>; reached?: () => void; result?: unknown }
type Opts = {
  spawn?: unknown
  // The reviewer spawn throws this message rather than answering.
  spawnThrows?: string
  // The reviewer spawn throws this message after its hook learned the agent's id: the spawn hook's write is staged by applying `learn` to the first conversation read after the throw, since the test's hooks sit beneath the plugin's and cannot throw above it.
  spawnThrowsAfterLearning?: string
  spawnNoId?: boolean
  reviewerIds?: string[]
  agents?: { id: string; name?: string; type?: string; status?: string; description?: string; teammateId?: string; spawnedBy?: string }[]
  listFails?: boolean
  // What a tool answers, by name: `isError` fails the call and `deny` refuses it, and the record counts either as a failed call.
  tools?: Record<string, { text: string; isError?: boolean; deny?: string }>
  // A call that fails whatever its tool's answer says, picked by its input.
  failsCall?: (call: any) => boolean
  // The canned answer of every host command; the fields not given keep a clean run's values.
  run?: { stdout?: string; exitCode?: number; isStdoutTruncated?: boolean }
  sendFails?: string
  sendThrows?: string
  // A note's send to main, below the plugin's gate: the sends numbered in `noteFailsAt` (1-based) are refused, every one throws with `noteThrows`, and the first is held until `until` once `reached` is called.
  noteFailsAt?: number[]
  noteThrows?: boolean
  noteHold?: { until: Promise<void>; reached?: () => void }
  // The reason the engine gives for every refused send, a note's or a message to the reviewer: 'main is gone' for a note, 'refused' for a message when not given.
  refusal?: string
  // The first prompt that carries context is dropped, or throws.
  contextPrompt?: 'drop' | 'throw'
  // Every conversation write whose value satisfies this is refused.
  writeRefusedWhen?: (c: any) => boolean
  writeFails?: string
  clockFails?: boolean
  // The clock read with this number (1 for the first) rejects, and the rest answer.
  clockFailsAt?: number
  stateFails?: string
  // The conversation a state written before this build holds, until the plugin first writes one.
  stateSeed?: unknown
  // The first conversation read made while `when` holds for the conversation last written calls reached, then waits for `until` before it reads.
  getHold?: { when: (c: any) => boolean; until: Promise<void>; reached?: () => void }
  // The first conversation write made while `when` holds calls `reached`, then waits for `until` before it lands: a write made meanwhile moves the state's version, so the held one misses and its change runs again.
  holdWrite?: { when: () => boolean; until: Promise<void>; reached: () => void }
  // Each write whose path contains `path` calls reached, then waits for `until` before it lands.
  hold?: { path: string; until: Promise<void>; reached?: () => void }
  // Each $.session.send calls reached, then waits for `until` before the engine answers it.
  sendHold?: { until: Promise<void>; reached?: () => void }
  // Each $.tool.call of this tool rejects.
  toolThrows?: string
  // Each TaskStop call is refused with this reason, or only the first `stopRefusals` of them when that is given.
  stopRefuses?: string
  stopRefusals?: number
  // What the agent list answers, given how many TaskStop calls had been made: the way to stage a reviewer that a stop does, or does not, take off the list.
  agentsAfterStops?: (stops: number) => NonNullable<Opts['agents']>
  // The first agent list call made after a TaskStop calls reached, then waits for until before the engine answers it.
  listHold?: { until: Promise<void>; reached?: () => void }
  // A spawn a hold covers calls its `reached`, then waits for `until` before its result lands (`result` when given, else the reviewer's id). A single hold covers the spawns numbered `from` (1-based, 1 by default) through `to` when given; an array holds the spawn numbered i + 1 by its entry i, and an undefined entry holds none.
  spawnHold?: (SpawnHold & { from?: number; to?: number }) | (SpawnHold | undefined)[]
  // From the reviewer spawn numbered `spawnThrowsFrom` (1-based) on, the spawn throws; from `spawnDeniesFrom` on, it is refused.
  spawnThrowsFrom?: number
  spawnDeniesFrom?: number
  // The reason a denied reviewer spawn gives: 'spawn refused' when not given.
  spawnDenyReason?: string
  // Once the reviewer spawn numbered `writesFailFromSpawn` (1-based) has been made, every conversation write is refused.
  writesFailFromSpawn?: number
  // With `listFailsAt`, the agent list call with that number (1 for the first) rejects and the rest answer.
  listFailsAt?: number
  // Every agent list call made after a TaskStop rejects.
  listFailsAfterStop?: boolean
  // Each session id read calls reached, then waits for `until` before the engine answers it; a hold covers the reads numbered `from` (1-based, 1 by default) through `to` when given.
  sessionIdHold?: { until: Promise<void>; reached?: () => void; from?: number; to?: number }
  // Each $.tool.call of `tool`, in the order the calls arrive, waits for its gate in `untils` before the engine answers it.
  toolHolds?: { tool: string; untils: Promise<void>[] }
  // What the session's cost ledger answers ($.session.usage): the dollars (100 when not given), no `cost` at all, or a non-finite figure. A rejection or no answer cannot be staged here: the reader's own tests stage them.
  ledger?: number | 'absent' | 'nan'
  // The `usage` the bottom of every compaction reports, as core does when it made a summarizing request.
  compactUsage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
}

// The hold that covers the reviewer spawn numbered `n` (1-based), when one does.
const heldAt = (hold: Opts['spawnHold'], n: number): SpawnHold | undefined => {
  if (Array.isArray(hold)) return hold[n - 1]
  if (hold === undefined || n < (hold.from ?? 1) || n > (hold.to ?? Infinity)) return undefined
  return hold
}

// The running test's engine record, so a helper given only `$` reads the conversation as the plugin last wrote it. Module-level, as STEP is: the tests of a file run one at a time.
const current: { seen?: { conversation: any }; seed?: any } = {}

// The engine's answers. The reviewer spawns as agent ag1; any other subagent spawns as sub1.
// The files map backs $.fs.read and $.fs.write, so a log can be read back as the worker's plugin would see it.
const engine = (on: any, opts: Opts = {}) => {
  const env: Env = { HOME: '/home/test' }
  const tools = opts.tools ?? {}
  const files: Record<string, string> = {}
  const seen = {
    spawns: [] as any[], sends: [] as any[], notes: [] as any[], prompts: [] as string[], contexts: [] as any[], toasts: [] as string[],
    conversation: undefined as any,
    registered: [] as any[], commands: [] as any[], registeredTools: [] as any[], runs: [] as any[], logs: [] as any[], reads: [] as string[], writes: [] as { path: string; text: string }[], appends: [] as any[], received: [] as any[], toolCalls: [] as any[], compactions: [] as any[],
    files, clock: 1000,
    // Each timer the plugin set with $.clock.after, in order: the wait asked and the call that makes it fire. None fires unless a test fires it.
    timers: [] as { ms: number; fire: () => void }[],
    flights: [] as string[][], clockHold: undefined as { until: Promise<void>; reached: () => void } | undefined, clockCalls: 0, stripBriefs: false,
    session: 's1',
    listCalls: 0, conversations: [] as any[],
    // Each TaskStop call, with how many agents had been spawned when it was made.
    stops: [] as { task_id: string; spawns: number }[],
    // The number of files written when each TaskStop call was made, in the order the stops were made.
    stopWrites: [] as number[],
    // The conversation writes attempted so far, and the attempt number (1-based) that is refused.
    stateWriteAttempts: 0,
    stateWritesFailAt: undefined as number | undefined,
    // The cost ledger reads made so far.
    ledgerReads: 0,
  }
  current.seen = seen
  current.seed = opts.stateSeed
  // The reviewer's spawns take the ids in reviewerIds in order, then ag1.
  let reviewerSpawns = 0
  const learnedOnThrow: { pending?: (c: any) => any } = {}
  const reviewerId = (): string => opts.reviewerIds?.[reviewerSpawns++] ?? 'ag1'
  on('classic.Stop', () => ({}))
  on('classic.PostToolBatch', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.version', () => ({ value: { version: '2.1.293', base: '2.1.293', builtAt: '2026-10-01T00:00:00Z' } }))
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('clock.now', async () => {
    if (opts.clockFails === true) throw new Error('clock unavailable')
    seen.clockCalls++
    if (seen.clockCalls === opts.clockFailsAt) throw new Error('clock unavailable')
    seen.clockHold?.reached()
    if (seen.clockHold !== undefined) await seen.clockHold.until
    return { value: seen.clock++ }
  })
  let sessionIdCalls = 0
  on('session.id', async () => {
    sessionIdCalls++
    const hold = opts.sessionIdHold
    if (hold !== undefined && sessionIdCalls >= (hold.from ?? 1) && sessionIdCalls <= (hold.to ?? Infinity)) {
      hold.reached?.()
      await hold.until
    }
    return { value: seen.session }
  })
  let listHeld = false
  on('agent.list', () => {
    seen.listCalls++
    if (seen.listCalls === opts.listFailsAt) throw new Error('agent list unavailable')
    if (opts.listFails === true || (opts.listFailsAfterStop === true && seen.stops.length > 0)) throw new Error('agent list unavailable')
    const answer = { value: opts.agentsAfterStops?.(seen.stops.length) ?? opts.agents ?? [] }
    if (opts.listHold === undefined || listHeld || seen.stops.length === 0) return answer
    listHeld = true
    opts.listHold.reached?.()
    return opts.listHold.until.then(() => answer)
  })
  on('fs.read', (_$: any, e: any) => {
    seen.reads.push(e.path)
    return e.path in files ? { value: files[e.path] } : { deny: 'no such file' }
  })
  on('fs.write', async (_$: any, e: any) => {
    if (opts.writeFails !== undefined && e.path.includes(opts.writeFails)) throw new Error('disk full')
    if (opts.hold !== undefined && e.path.includes(opts.hold.path)) {
      opts.hold.reached?.()
      await opts.hold.until
    }
    seen.writes.push({ path: e.path, text: e.text })
    files[e.path] = e.text
    return { value: undefined }
  })
  // Every append is recorded, so a test can show the plugin appends no row.
  on('session.append', async (_$: any, e: any, next: any) => {
    seen.appends.push(structuredClone(e.message))
    return next(e)
  })
  // The bottom of the delivery chain: a delivery that reaches it is queued as it arrived, and recorded.
  on('session.receive', (_$: any, e: any) => (seen.received.push(e), { text: e.text }))
  on('ui.toast', (_$: any, e: any) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.log', (_$: any, e: any) => (seen.logs.push(e), { value: undefined }))
  let toolHeldCalls = 0
  on('tool.call', async (_$: any, e: any) => {
    seen.toolCalls.push(e)
    if (opts.toolHolds !== undefined && opts.toolHolds.tool === e.tool) await opts.toolHolds.untils[toolHeldCalls++]
    if (e.tool === 'TaskStop') {
      seen.stops.push({ task_id: e.task_id, spawns: seen.spawns.length })
      seen.stopWrites.push(seen.writes.length)
    }
    if (e.tool === 'TaskStop' && opts.stopRefuses !== undefined && seen.stops.length <= (opts.stopRefusals ?? Infinity)) return { deny: opts.stopRefuses }
    if (e.tool === opts.toolThrows) return Promise.reject(new Error('tool unavailable'))
    const answer = tools[e.tool] ?? { text: `ran ${e.tool}` }
    return answer.deny === undefined ? { ref: 1, result: null, text: answer.text, isError: answer.isError || opts.failsCall?.(e) === true } : { deny: answer.deny }
  })
  let getHeld = false
  on('state.get', async (_$: any, e: any, next: any) => {
    if (e.key === 'conversation' && learnedOnThrow.pending !== undefined && seen.conversation !== undefined) {
      const answer = await next(e)
      const learns = learnedOnThrow.pending
      learnedOnThrow.pending = undefined
      return { ...answer, value: { ...answer.value, value: learns(answer.value.value) } }
    }
    if (e.key === 'conversation' && opts.getHold !== undefined && !getHeld && opts.getHold.when(seen.conversation)) {
      getHeld = true
      opts.getHold.reached?.()
      await opts.getHold.until
    }
    return opts.stateFails !== undefined && e.key === opts.stateFails ? { deny: 'state unavailable' } : opts.stateSeed !== undefined && e.key === 'conversation' && seen.conversation === undefined ? { value: { value: opts.stateSeed } } : next(e)
  })
  // The conversation as the plugin last wrote it; stripBriefs writes it as a state from before briefsInFlight existed.
  let writeHeld = false
  on('state.set', async (_$: any, e: any, next: any) => {
    if (e.key === 'conversation' && opts.holdWrite !== undefined && !writeHeld && opts.holdWrite.when()) {
      writeHeld = true
      opts.holdWrite.reached()
      await opts.holdWrite.until
    }
    if (e.key === 'conversation') seen.stateWriteAttempts++
    if (e.key === 'conversation' && opts.writesFailFromSpawn !== undefined && seen.spawns.filter(sp => typeOf(sp) === 'auditor:reviewer').length >= opts.writesFailFromSpawn) return { deny: 'state write unavailable' }
    if (e.key === 'conversation' && seen.stateWriteAttempts === seen.stateWritesFailAt) return { deny: 'state write unavailable' }
    if (e.key === 'conversation' && opts.writeRefusedWhen?.(e.value) === true) return { deny: 'state write unavailable' }
    if (e.key === 'conversation') {
      seen.conversation = e.value
      seen.conversations.push(e.value)
    }
    return next(seen.stripBriefs && e.key === 'conversation' ? { ...e, value: { ...e.value, briefsInFlight: undefined } } : e)
  })
  on('process.run', (_$: any, e: any) => (seen.runs.push(e), { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...opts.run } }))
  on('agent.register', (_$: any, e: any) => (seen.registered.push(e), { value: { agent: e.name } }))
  on('command.register', (_$: any, e: any) => (seen.commands.push(e), { value: { command: e.name } }))
  on('tool.register', (_$: any, e: any) => (seen.registeredTools.push(e), { value: { tool: `mcp__auditor__${e.name}` } }))
  on('agent.spawn', async (_$: any, e: any) => {
    seen.spawns.push(e)
    seen.flights.push([...(seen.conversation?.briefsInFlight ?? [])])
    const type = e.subagent_type ?? e.subagentType
    if (type === 'auditor:reviewer') {
      if (opts.spawnThrows !== undefined) throw new Error(opts.spawnThrows)
      if (opts.spawnThrowsAfterLearning !== undefined) {
        const id = reviewerId()
        learnedOnThrow.pending = c => learn(c, e.prompt, id, 'm', 'auditor-reviewer')
        throw new Error(opts.spawnThrowsAfterLearning)
      }
      const reviewersSpawned = seen.spawns.filter(s => typeOf(s) === 'auditor:reviewer').length
      if (opts.spawnThrowsFrom !== undefined && reviewersSpawned >= opts.spawnThrowsFrom) throw new Error('spawn down')
      if (opts.spawnDeniesFrom !== undefined && reviewersSpawned >= opts.spawnDeniesFrom) return { deny: opts.spawnDenyReason ?? 'spawn refused' }
      const hold = heldAt(opts.spawnHold, reviewersSpawned)
      if (hold !== undefined) {
        hold.reached?.()
        await hold.until
        if (hold.result !== undefined) return hold.result
      }
      return opts.spawn ?? (opts.spawnNoId === true ? { model: 'm' } : { model: 'm', agentId: reviewerId() })
    }
    return { model: 'm', agentId: 'sub1' }
  })
  // A send to the main conversation is a reviewer's note, kept apart from the briefs in `notes`; the note options shape its answer.
  on('session.send', async (_$: any, e: any) => {
    if (e.to === 'main') {
      seen.notes.push(e)
      const n = seen.notes.length
      if (opts.noteHold !== undefined && n === 1) {
        opts.noteHold.reached?.()
        await opts.noteHold.until
      }
      if (opts.noteThrows === true) throw new Error('note send threw')
      return opts.noteFailsAt?.includes(n) === true ? { isDelivered: false, reason: opts.refusal ?? 'main is gone' } : { isDelivered: true }
    }
    seen.sends.push(e)
    seen.flights.push([...(seen.conversation?.briefsInFlight ?? [])])
    if (opts.sendHold !== undefined) {
      opts.sendHold.reached?.()
      await opts.sendHold.until
    }
    return e.to === opts.sendThrows ? Promise.reject(new Error('send threw')) : e.to === opts.sendFails ? { isDelivered: false, reason: opts.refusal ?? 'refused' } : { isDelivered: true }
  })
  let contextRefused = false
  on('prompt.submit', async (_$: any, e: any) => {
    // The first prompt that carries context is dropped, or throws, as another plugin's hook below the auditor's might.
    if (e.context !== undefined && opts.contextPrompt !== undefined && !contextRefused) {
      contextRefused = true
      if (opts.contextPrompt === 'throw') throw new Error('prompt hook failed')
      return { drop: 'another hook dropped it' }
    }
    seen.prompts.push(e.text)
    seen.contexts.push(e.context)
    return { text: e.text, context: e.context }
  })
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: STEP, toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE }
  })
  // The bottom of a compaction: each one that reaches it is recorded, and answered with the messages it was given, since a compaction leaves at least one.
  on('session.compact', (_$: any, e: any) => (seen.compactions.push(e), { messages: e.messages, usage: opts.compactUsage }))
  // A timer the plugin sets fires only when a test fires it (the ledger reader's one-second bound is staged in its own tests).
  on('clock.after', async (_$: any, e: any) => {
    const fired = gate()
    seen.timers.push({ ms: e.ms, fire: fired.open })
    await fired.until
    return { value: undefined }
  })
  // The ledger: the figures the status line totals, with the context and rate-limit fields the call always carries.
  on('session.usage', () => {
    seen.ledgerReads++
    const ledger = opts.ledger ?? 100
    const base = { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] }
    return { value: ledger === 'absent' ? base : { ...base, cost: { usd: ledger === 'nan' ? Number.NaN : ledger } } }
  })
  return seen
}

// The writes into a record or live directory: no entry is written to a file, so there are none.
const entryWrites = (seen: { writes: { path: string }[] }) => seen.writes.filter(w => /\/(record|live)\//.test(w.path))

// The entries as a page carries them, each as its own block.
const BLOCKS = (...entries: string[]) => entries.map((entry, i) => `[${i + 1}] ${entry}\n\n`).join('')

// The one page of review n's record that holds every entry given.
const RECORD_OF = (n: number, ...entries: string[]) => `Record of auditor review ${n}: entries 1-${entries.length} of ${entries.length}\n\n${BLOCKS(...entries)}`

// The one page of the live entries after review n's dispatch that holds every entry given.
const LIVE_OF = (n: number, ...entries: string[]) => `Live entries recorded after auditor review ${n} was dispatched: entries 1-${entries.length} of ${entries.length}\n\n${BLOCKS(...entries)}`

// The live answer while no entry has been recorded since review n's dispatch.
const NONE_SINCE = (n: number) => `No entries have been recorded since auditor review ${n} was dispatched.`

// The reviewer's tool, called as the reviewer (ag1) unless told otherwise: the text it answers with.
const entriesOf = async ($: any, args: { which: 'record' | 'live'; from?: number }, agentId = 'ag1') => (await $.tool.call({ tool: ENTRIES, agentId, ...args })).result

// A promise and the call that resolves it, for a write or spawn a test holds open.
const gate = () => {
  let open = (): void => undefined
  const until = new Promise<void>(resolve => { open = resolve })
  return { until, open }
}

// A reviewer spawn held open from the spawn numbered `from` on: `hold` is the engine option, `reached` resolves once the spawn is under way, and `land` lets its result, with the id, land.
const heldSpawn = (from = 1) => {
  const release = gate()
  const reached = gate()
  return { hold: { from, until: release.until, reached: reached.open }, reached: reached.until, land: release.open }
}

// A review's log file, parsed; undefined when no file was written.
const logOf = (seen: { files: Record<string, string> }, path: string): any => (path in seen.files ? JSON.parse(seen.files[path] ?? 'null') : undefined)

// The debug lines logged so far that contain `text`.
const debugLines = (seen: { logs: { text: string }[] }, text: string): string[] => seen.logs.map(line => line.text).filter(line => line.includes(text))

// The lines logged to the transcript so far, as text.
const transcriptLines = (seen: { logs: { text: string; to: string }[] }): string[] => seen.logs.filter(line => line.to === 'transcript').map(line => line.text)

// A reviewer's final report as it arrives at prompt.submit in a session without agent teams: the hand-back marker opening the first line, which names the reviewer.
const HANDBACK = (body: string) => ({
  text: `[Subagent hand-back] auditor-reviewer done\n${body}`,
  wait: false,
  origin: { kind: 'peer' as const },
})

// The reviewer's turn ending, with its answer.
const TURN_END = (agentId: string, answer = '', usage?: unknown) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId, usage }) as any

// The report a hand-back carries: the lines after its marker's line.
const REPORT = (hand: { text: string }): string => {
  const lines = hand.text.split('\n')
  return lines.slice(lines.findIndex(line => line.includes('[Subagent hand-back]')) + 1).join('\n')
}

// A note as the reviewer sends it: its first line names its review.
const FRAMED = (number: number, text: string): string => `auditor, review ${number}:\n${text}`

// The engine's stamp on a send from the model inside an agent this plugin spawned.
const REVIEWER_ORIGIN = { kind: 'plugin' as const, name: 'auditor' }

// A reviewer's SendMessage, as its session.send arrives: to main, its text the review line for `number`, then the body.
const SEND = (number: number, body: string, agentId = 'ag1', to = 'main') => ({ to, text: FRAMED(number, body), origin: REVIEWER_ORIGIN, agentId }) as any

// The texts that reached the bottom of the send chain for the main conversation: the notes the gate let through.
const toMain = (seen: { notes: { text: string }[] }): string[] => seen.notes.map(s => s.text)

// A delivered note arriving at the worker, as Task 1 measured it: a peer prompt carrying the reviewer's agent message.
const ARRIVED = (number: number, body: string, from = 'auditor-reviewer') => ({ text: `<agent-message from="${from}">\n${FRAMED(number, body)}\n</agent-message>`, wait: false, origin: { kind: 'peer' as const }, isMeta: true }) as any

// The review number a reviewer sends its note under: its open review's while it is the stored reviewer, else 0, a number no review has, as a former reviewer's older number is refused.
const sendNumber = (agentId: string): number => {
  const c = current.seen?.conversation ?? current.seed
  return c?.reviewer?.id === agentId ? (c?.review?.number ?? 0) : 0
}

// A reviewer sends `body` as its note to main with SendMessage, under `number` when given; resolves to the send's result.
const noteSent = async ($: any, body: string, agentId = 'ag1', number?: number) => $.session.send(SEND(number ?? sendNumber(agentId), body, agentId))

// Whether an answer is a note: neither empty nor the quiet status.
const isNote = (answer: string): boolean => answer.trim() !== '' && answer.trim() !== 'Nothing to note.'

const ESCALATED_TOAST = 'auditor: the reviewer escalated a disagreement; see its note to the worker'

// A named agent's end-of-run status notice as the team mailbox carries it to session.receive, in the shape measured live.
const END_NOTICE = (from: string, result = 'Nothing to note.') => JSON.stringify({ type: 'idle_notification', from, timestamp: '2026-10-28T07:55:44.204Z', idleReason: 'available', result })

// What the receive hook answers for a known reviewer's end-of-run notice.
const CONSUMED = { consumed: 'auditor reviewer end-of-run notice' }

// The worker's turn ending on the main loop (no agentId), with its answer.
const mainTurnEnd = ($: any) => $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

const COMPOSER = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }

// The live shape of a reviewer's hand-back: the spawn name alone on the envelope's first line, the hand-back wording on the next.
const LIVE_HANDBACK = (body: string) => ({
  text: `<agent-message from="auditor-reviewer">\n[Subagent hand-back] auditor-reviewer done\n${body}`,
  wait: false,
  origin: { kind: 'peer' as const },
})

// A note the reviewer sent back in a hand-back.
const NOTE = () => HANDBACK('a.ts:4 swallows it.')

// A reviewer's task notification as it arrives at prompt.submit: its summary names the reviewer's description and how the task ended.
// The shape is from a live failed notice captured 2026-10-23.
const NOTICE = (summary: string) => {
  const status = summary.includes(' failed') ? 'failed' : 'completed'
  return { text: `<task-notification><task-id>ag1</task-id><tool-use-id>tu1</tool-use-id><output-file>ag1.output</output-file><status>${status}</status><summary>${summary}</summary><note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note></task-notification>`, wait: false, origin: { kind: 'task-notification' as const } }
}

// A background command's notification alone, which names no reviewer.
const BG_NOTICE = { text: '<task-notification><task-id>bg1</task-id><summary>Background command "npm test" completed</summary></task-notification>', wait: false, origin: { kind: 'task-notification' as const } }

// The reviewer's notice and a background command's, batched into one prompt.
const BATCH = { text: `${NOTICE('Agent "auditor review" finished').text}\n${BG_NOTICE.text}`, wait: false, origin: { kind: 'task-notification' as const } }

// A helper's message: a peer that names no reviewer, so the worker reads it as an ordinary prompt.
const HELPER = { text: 'Another Claude session sent a message: helper done', wait: false, origin: { kind: 'peer' as const } }

const typeOf = (spawn: any): string => spawn.subagent_type ?? spawn.subagentType

const WORKER_CALL = (tool: string, input: Record<string, unknown>) => ({ tool, ...input }) as any

// The text the mock's model request answers with, and the usage it reports (null: no usage, as for a failed request).
let STEP = ''
let STEP_USAGE: unknown = null

// One model request of a turn, through the streaming hook; the engine's answer carries the text the test set.
const step = async ($: any, answer: string, agentId?: string) => {
  STEP = answer
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, agentId })) {
    // the chunks are not read
  }
}

// A worker turn that ends: its reply is what the record gains, and it lifts nothing.
const workerTurn = async ($: any, answer = 'Done.') => {
  await step($, 'working')
  await $.classic.Stop({ ...stop, last_assistant_message: answer })
}

// A worker turn the user starts that is still running when a review settles: its Stop dispatches the review, and the turn ends later.
const busyWorker = async ($: any) => {
  await $.prompt.submit(COMPOSER('fix the parser'))
  await $.classic.Stop(stop)
}

// A reviewer ends its review in a session without agent teams: a report that is a note is sent first with SendMessage, then the hand-back arrives and is dropped, and the turn ends with the quiet status: the review settles at that turn end.
const reviewed = async ($: any, hand: any, agentId: string) => {
  const report = REPORT(hand)
  if (isNote(report)) await noteSent($, report, agentId)
  await $.prompt.submit(hand)
  await $.turn.complete(TURN_END(agentId, 'Nothing to note.', USAGE))
}

// A reviewer ends its review: an answer that is a note is sent first with SendMessage, as the prompt tells it, then its turn ends with the given answer.
const turnEnded = async ($: any, agentId: string, answer = '') => {
  if (isNote(answer)) await noteSent($, answer, agentId)
  await $.turn.complete(TURN_END(agentId, answer))
}

// A reviewer's turn ends on an error rather than an answer, having sent nothing: its review fails.
const turnFailed = async ($: any, agentId: string) => {
  await $.turn.complete({ ...TURN_END(agentId, ''), reason: 'error' })
}

// The footer's SessionMode, beside Claude Code's own mode label.
const MODE_PROPS = { modes: ['auto mode on'] }
const mountMode = ($: any, surface = 'terminal') => $.ui.mount({ plugin: 'auditor', surface, component: 'SessionMode', props: MODE_PROPS })
// What Claude Code draws after this mod, which the hook's next(e) answers.
const otherMods = (on: any, text = 'drawn by Claude Code') => on('ui.render', () => ({ type: 'Text', props: {}, children: [text] }))
// Core's own drawing, which next(e) answers as an opaque node when no mod draws beneath: its words are the mode labels, not in the tree.
const coreDraws = (on: any) => on('ui.render', () => ({ type: 'engine', ref: 0 }))
// Whether the footer draws the dim separator before the button: a Text of exactly ` · `, which the popup's rows (they hold that sign inside longer words) do not make.
const separated = async (ui: any): Promise<boolean> => JSON.stringify(await ui.drawn()).includes('"children":[" · "]')
// The button as drawn: its label says whether the reviewer is on, off or failing.
const buttonReads = async (ui: any, state: 'on' | 'off' | 'failing') => {
  expect(await ui.find({ key: 'auditor-toggle' })).toMatchObject({ props: { plain: true, label: `auditor ${state}` } })
}


// Whether two dollar figures agree to a billionth: the kit's expect has no toBeCloseTo.
const closeTo = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9

describe('auditor', () => {
  test('a fresh install with no settings reviews a worker turn', async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    expect(seen.spawns.map(s => s.name)).toEqual(['auditor-reviewer'])
    expect(seen.spawns.map(typeOf)).toEqual(['auditor:reviewer'])
  })

  test('the reviewer registers on claude-haiku-5-5 at high effort', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registered.length).toBe(1)
    expect(seen.registered[0]).toMatchObject({ name: 'reviewer', model: 'claude-haiku-5-5', effort: 'high' })
  })

  test('the reviewer is told to read the edited regions and search large references, and still to read every fresh edit', () => {
    expect(REVIEWER_PROMPT).not.toContain('Inspect the full file')
    expect(REVIEWER_PROMPT).not.toContain('an extra Read is cheap')
    expect(REVIEWER_PROMPT).toContain('the edited region')
    expect(REVIEWER_PROMPT).toContain('never Read it whole')
    expect(REVIEWER_PROMPT).toContain('you may not answer until you have Read the edited source')
  })

  test('the reviewer speaks only to change course or to catch a bug, and never sends a withdrawal, a confirmation or a reason for silence', () => {
    expect(REVIEWER_PROMPT).toContain('send one only when the worker needs to change course, or when staying silent would leave a bug in the code unnoticed')
    expect(REVIEWER_PROMPT).toContain('Never send a note to withdraw or concede an earlier finding')
    expect(REVIEWER_PROMPT).not.toContain('state it as a fresh observation')
    expect(REVIEWER_PROMPT).not.toContain('you owe a specific response')
  })

  test('a review that settles with turns pending is briefed at once, and not again at the worker\'s next stop', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await workerTurn($, 'Second.')
    expect(seen.sends.length).toBe(0)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-1,')
    await workerTurn($, 'Third.')
    expect(seen.sends.length).toBe(1)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'ASSISTANT: working'))
  })

  test('a settled review with nothing accumulated is not followed by a brief', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    // The settle finds nothing recorded since the dispatch, so there is nothing to brief the reviewer with.
    expect(seen.sends.length).toBe(0)
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(0)
  })

  test('a settle briefs nothing when a user prompt enters while it settles', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    // The second session id read is the settle's own, for its log: the dispatch made the first.
    const seen = engine(on, { sessionIdHold: { from: 2, to: 2, until: release.until, reached: reached.open } })
    await workerTurn($)
    const settling = reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await reached.until
    await $.prompt.submit(COMPOSER('carry on'))
    release.open()
    await settling
    expect(seen.sends.map(s => s.to)).toEqual([])
  })

  test('a review settling with entries pending and the worker idle is briefed at once, once', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await step($, 'working')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-1,')
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(1)
  })

  test('a review settling while the worker is mid-turn is briefed once, at that turn\'s end', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await step($, 'working')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.length).toBe(0)
    await $.classic.Stop(stop)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    await mainTurnEnd($)
    expect(seen.sends.length).toBe(1)
  })

  test('a subagent turn is not reviewed', ON, async ($, on) => {
    const seen = engine(on)
    await $.classic.Stop({ ...stop, agent_id: 'someone' })
    expect(seen.spawns.length).toBe(0)
  })

  test('a Stop that names an agent, even an empty id, is a subagent\'s and reviews nothing', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, agent_id: '' })
    expect(seen.spawns.length).toBe(0)
  })

  test('a note the reviewer sends goes on to main unchanged, and the plugin submits, appends and prints nothing for it, busy or idle', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    expect(await noteSent($, 'a.ts:4 swallows it.')).toEqual({ isDelivered: true })
    expect(seen.notes).toEqual([SEND(1, 'a.ts:4 swallows it.')])
    await $.turn.complete(TURN_END('ag1', 'Sent.', USAGE))
    await $.classic.PostToolBatch({ tool_calls: [] })
    await mainTurnEnd($)
    await workerTurn($)
    await turnEnded($, 'ag1', 'b.ts:2 also.')
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 swallows it.'), FRAMED(2, 'b.ts:2 also.')])
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(seen.appends).toEqual([])
    expect(transcriptLines(seen)).toEqual([])
    expect(seen.logs.map((line: { text: string }) => line.text).filter(text => text.includes('auditor note'))).toEqual([])
  })

  test('a note arriving as a peer prompt passes on unchanged and enters the record once, as any peer prompt does', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 swallows it.')
    const arrived = ARRIVED(1, 'a.ts:4 swallows it.')
    expect(await $.prompt.submit(arrived)).toMatchObject({ text: arrived.text })
    expect(seen.prompts).toEqual([arrived.text])
    await workerTurn($)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, `PROMPT (peer): ${arrived.text}`, 'ASSISTANT: working'))
  })

  test('a note whose body quotes "Subagent hand-back" reaches the worker unchanged', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const body = 'The [Subagent hand-back] marker at a.ts:4 is matched anywhere in the text.'
    await turnEnded($, 'ag1', body)
    expect(toMain(seen)).toEqual([FRAMED(1, body)])
    const arrived = ARRIVED(1, `[Subagent hand-back] ${body}`)
    await $.prompt.submit(arrived)
    expect(seen.prompts).toEqual([arrived.text])
  })

  test('a reviewer turn end with no review open dispatches nothing, though entries wait for the next review', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await $.prompt.submit(COMPOSER('next'))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.spawns.length).toBe(1)
    expect(seen.sends.length).toBe(0)
    expect(JSON.stringify(seen.logs)).toContain('ended a turn with no review in progress')
  })

  test('after the user interrupts the worker, a note is let through at once and nothing holds it for the user\'s next prompt', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await turnEnded($, 'ag1', 'a.ts:4 after the Esc.')
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 after the Esc.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 after the Esc.', note_delivered: true })
    await $.prompt.submit(COMPOSER('more'))
    expect(seen.contexts.at(-1)).toBeUndefined()
    expect(seen.prompts).toEqual(['carry on', 'more'])
  })

  test('an aborted turn\'s last message is the one its next review is briefed with when the turn after it ends with no Stop and no answer', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await step($, 'working')
    await $.turn.complete({ answer: 'Partial reply.', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('second'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].prompt).toContain('Worker last message:\nPartial reply.')
  })

  test('an aborted turn\'s record ends with the INTERRUPTED entry, after the entries that turn made', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await step($, 'working')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: first', 'ASSISTANT: working', 'INTERRUPTED: the user stopped this turn before it finished.', 'USER: second'))
  })

  test('an escalation toasts once, inside the reviewer\'s turn as its note is delivered, whether or not the worker has read it', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await noteSent($, 'Escalation: Disagreement on auth. Escalating.')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await $.turn.complete(TURN_END('ag1', 'Sent.', USAGE))
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true, escalation: true, stall: false })
  })

  test('an aborted worker turn while the review is open puts the INTERRUPTED entry in that review\'s live entries, after the turn\'s entries', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await step($, 'working')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, 'ASSISTANT: working', 'INTERRUPTED: the user stopped this turn before it finished.'))
  })

  test('a reviewer\'s own aborted turn adds no INTERRUPTED entry to the worker\'s record', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.prompt.submit(COMPOSER('mid-review'))
    await $.turn.complete({ ...TURN_END('ag1', 'a.ts:4 cut off.'), isAborted: true, reason: 'aborted' })
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: first', 'USER: mid-review'))
  })

  test('an aborted turn with an empty answer briefs its reviewer with the interruption, not an earlier turn\'s message', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop({ ...stop, last_assistant_message: 'Earlier done.' })
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    await step($, 'working')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' } as any)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await $.prompt.submit(COMPOSER('third'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).toContain('Worker last message:\n(none: the user interrupted the turn)')
  })

  test('a turn end with an empty answer keeps the last message its Stop gave', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    await step($, 'working')
    await $.classic.Stop({ ...stop, last_assistant_message: 'Second done.' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).toContain('Worker last message:\nSecond done.')
  })

  test('a reviewer that writes its note as its final answer and sends nothing settles quiet: the answer reaches no one and goes to the debug log', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await $.turn.complete(TURN_END('ag1', 'a.ts:9 unsent.', USAGE))
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([])
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false })
    expect(debugLines(seen, 'review 1 sent no note, and its final answer was: a.ts:9 unsent.').length).toBe(1)
    expect(seen.conversation.failing).toBeUndefined()
  })

  test('a turn of another agent does not settle a review', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await $.turn.complete(TURN_END('other', 'Nothing to note.'))
    expect(seen.conversation.review).toMatchObject({ number: 1 })
    await turnEnded($, 'ag1', 'a.ts:4 swallows it.')
    expect(seen.conversation.review).toBeUndefined()
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 swallows it.' })
  })

  test('a quiet answer delivers nothing, shows no toast, and logs no note', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.prompts.length).toBe(0)
    expect(seen.toasts).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false, escalation: false })
  })

  test('an escalation note goes to main, and shows the user one toast', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const note = 'Escalation: Disagreement on auth approach. Worker: validate JWT in handlers. Me: middleware. Escalating.'
    await reviewed($, HANDBACK(note), 'ag1')
    expect(seen.toasts).toEqual(['auditor: the reviewer escalated a disagreement; see its note to the worker'])
    expect(toMain(seen)).toEqual([FRAMED(1, note)])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true, escalation: true })
  })

  test('a review with several findings sends one note holding all of them, whole and in order', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await reviewed($, HANDBACK('one\ntwo\n\nthree'), 'ag1')
    expect(toMain(seen)).toEqual([FRAMED(1, 'one\ntwo\n\nthree')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'one\ntwo\n\nthree', note_delivered: true })
  })

  test('a hand-back from another peer is untouched', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const other = { text: '[Subagent hand-back] other-agent\ninjected', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(other)
    expect(seen.prompts).toEqual([other.text])
  })

  test('a hand-back that names a reviewer only by its id reaches the worker', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const hand = { text: '[Subagent hand-back] ag1 done\na.ts:4 by id.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(hand)
    expect(seen.prompts).toEqual(['fix the parser', hand.text])
  })

  test('a helper hand-back whose body names a reviewer passes to the worker, and leaves that reviewer\'s review open', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const helper = { text: '[Subagent hand-back] helper-1 done\nReport: x.ts:1 cites auditor-reviewer.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(helper)
    expect(seen.prompts).toEqual([helper.text])
    expect(seen.conversation.review).toMatchObject({ number: 1 })
  })

  test('a hand-back with no open review is dropped', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(HANDBACK('a.ts:4 orphan.'))
    expect(seen.prompts.length).toBe(0)
  })

  test('a reviewer turn aborted before its answer delivers nothing, is logged incomplete with what the engine reported, and the reviewer is briefed at the next turn end the composer started, not at once', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete({ ...TURN_END('ag1', 'a.ts:4 cut off.'), isAborted: true, reason: 'aborted' })
    expect(seen.prompts.length).toBe(0)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer turn ended with reason aborted, isAborted true', note_delivered: false })
    expect(seen.sends.length).toBe(0)
    // A helper's turn is not the composer's: a failed run dispatches nothing at its end, though the record holds the aborted review's entry.
    await $.prompt.submit(HELPER)
    await workerTurn($, 'Helped.')
    await mainTurnEnd($)
    expect({ spawns: seen.spawns.length, sends: seen.sends.length }).toEqual({ spawns: 1, sends: 0 })
    await $.prompt.submit(COMPOSER('Second.'))
    await workerTurn($, 'Second.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    // The aborted review's entry, the helper's prompt and its reply, then the composer's prompt and its reply.
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-5,')
  })

  // A review that ends aborted keeps its entries: they are put back ahead of the one recorded while it was open.
  test('a review aborted mid-turn puts its entries back ahead of those recorded since, and the next record numbers them in order', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.prompt.submit(COMPOSER('mid-review'))
    await $.turn.complete({ ...TURN_END('ag1', 'a.ts:4 cut off.'), isAborted: true, reason: 'aborted' })
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', number: 1 })
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: first', 'USER: mid-review'))
  })

  // A dispatch whose spawn is refused leaves its entries in the record, so the next review reads them with those recorded since.
  test('a dispatch whose spawn is refused puts its entries back, and the next review reads them with those recorded since', ON, async ($, on) => {
    const opts: Opts = { spawn: { deny: 'no' } }
    const seen = engine(on, opts)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn refused: no' })
    opts.spawn = undefined
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: first', 'USER: second'))
  })

  test('a reviewer turn that ends on an error rather than its answer delivers nothing and is logged incomplete', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete({ ...TURN_END('ag1', 'a.ts:4 cut off.'), reason: 'error' })
    expect(seen.prompts.length).toBe(0)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer turn ended with reason error, isAborted false', note_delivered: false })
  })

  // A review that let no note through and whose turn answered with a non-empty body settles complete and quiet: nothing fails, no entry goes back, and only an answer that is not the quiet status reaches the debug log.
  for (const [answer, logged] of [['Nothing to note.', false], ['auditor, review 1:\nNothing to note.', false], ['a.ts:4 unsent.', true], ['auditor, review 2:\na.ts:4 unsent.', true]] as const) {
    test(`a review that let no note through and answered ${JSON.stringify(answer)} settles complete and quiet, puts no entry back, and ${logged ? 'logs' : 'does not log'} its answer`, ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', answer))
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false, escalation: false, stall: false })
      expect(seen.conversation.failing).toBeUndefined()
      expect(seen.conversation.record.blocks).toEqual([])
      expect(debugLines(seen, 'sent no note, and its final answer was').length).toBe(logged ? 1 : 0)
      expect(toMain(seen)).toEqual([])
    })
  }

  // An answer that is only whitespace, or only copies of the review line, is empty: it fails its review the same way.
  for (const answer of ['', ' \n\t', 'auditor, review 1:\n'] as const) {
    test(`a reviewer turn that ends with the answer ${JSON.stringify(answer)} and sends no note fails its review: the footer reads failing, the entries go back, and the debug log gives the empty answer as the reason`, ON, async ($, on) => {
      const seen = engine(on)
      otherMods(on)
      await $.prompt.submit(COMPOSER('first'))
      await $.classic.Stop(stop)
      await turnEnded($, 'ag1', answer)
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete' })
      expect(debugLines(seen, 'auditor: review failed: reviewer ended its turn with an empty answer').length).toBe(1)
      await buttonReads(await mountMode($), 'failing')
      await $.prompt.submit(COMPOSER('second'))
      await $.classic.Stop(stop)
      expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: first', 'USER: second'))
    })
  }

  test('a review whose note was let through settles complete with it, and a later abnormal end of the reviewer\'s turn does not fail it or put its entries back', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await noteSent($, 'a.ts:4 sent.')
    await $.turn.complete({ ...TURN_END('ag1', ''), isAborted: true, reason: 'aborted' })
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 sent.', note_delivered: true })
    expect(seen.conversation.failing).toBeUndefined()
    expect(seen.conversation.record.blocks).toEqual([])
  })

  test('a review whose note was let through and delivered, then dropped by /auditor off before its reviewer\'s turn ends, is logged incomplete with that note as delivered', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    expect(await noteSent($, 'a.ts:4 delivered.')).toEqual({ isDelivered: true })
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', note: 'a.ts:4 delivered.', note_delivered: true })
  })

  test('a note whose send is still held when its review is dropped by /auditor off is logged with its body, not as delivered', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const sending = noteSent($, 'a.ts:4 held.')
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', note: 'a.ts:4 held.', note_delivered: false })
    const logged = seen.files[LOG_1]
    expect(debugLines(seen, 'delivered after its review closed')).toEqual([])
    release.open()
    expect(await sending).toEqual({ isDelivered: true })
    expect(debugLines(seen, 'review 1\'s note was delivered after its review closed')).toHaveLength(1)
    expect(seen.files[LOG_1]).toBe(logged)
    expect(seen.writes.filter(w => w.path === LOG_1)).toHaveLength(1)
  })

  test('a review that settles complete while its note\'s send is still held logs the note with note_delivered false', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const sending = noteSent($, 'a.ts:4 held.')
    await reached.until
    await $.turn.complete(TURN_END('ag1', 'Sent.', USAGE))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 held.', note_delivered: false })
    const logged = seen.files[LOG_1]
    release.open()
    expect(await sending).toEqual({ isDelivered: true })
    expect(debugLines(seen, 'review 1\'s note was delivered after its review closed')).toHaveLength(1)
    expect(seen.files[LOG_1]).toBe(logged)
    expect(seen.writes.filter(w => w.path === LOG_1)).toHaveLength(1)
  })

  test('a note delivered while its review is open writes no after-close debug line', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await noteSent($, 'a.ts:4 sent.')
    expect(debugLines(seen, 'delivered after its review closed')).toEqual([])
  })

  // In a session without agent teams the reviewer is a plain subagent, and its hand-back reaches prompt submission after its note: the drop keeps it from the worker.
  test('a reviewer\'s hand-back after its note is dropped, and the note still reached main', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await noteSent($, 'a.ts:4 late.')
    await $.turn.complete(TURN_END('ag1', 'Sent.', USAGE))
    expect(await $.prompt.submit(HANDBACK('Sent.'))).toEqual({ drop: 'reviewer bookkeeping' })
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 late.')])
  })

  // A review dispatched after the first one's turn end is open when the first one's hand-back arrives: that hand-back is dropped, and the second review stays open.
  test('a hand-back that arrives after the next review is dispatched is dropped, and leaves that review open', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await workerTurn($, 'Second.')
    expect(seen.sends.length).toBe(1)
    await $.prompt.submit(HANDBACK('Nothing to note.'))
    expect(seen.prompts.length).toBe(0)
    expect(seen.conversation.review).toMatchObject({ number: 2 })
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete' })
  })

  // A message naming the reviewer only in its body, with no hand-back wording, passes to the worker.
  test('a message naming the reviewer only in its body passes to the worker', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const reworded = { text: 'Another Claude session sent a message: a helper finished\nx.ts:1 reworded, for auditor-reviewer.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(reworded)
    expect(seen.prompts).toEqual([reworded.text])
  })

  test('every review runs when its hand-back is dropped, however many turns it closes', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    for (let i = 0; i < 3; i++) {
      await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
      await workerTurn($)
    }
    expect(seen.sends.length).toBe(3)
  })

  test('a second dispatch does not close an open review', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await workerTurn($, 'Second.')
    expect(seen.files[LOG_1]).toBeUndefined()
    expect(seen.sends.length).toBe(0)
  })

  test('the review number is the dispatch number, and its log names the size of its record', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(logOf(seen, LOG_1)).toMatchObject({ number: 1, record_entries: 1 })
    expect(logOf(seen, LOG_2)).toMatchObject({ number: 2, record_entries: 1 })
  })

  test('a /clear forgets the reviewer: the next dispatch spawns a new one', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await workerTurn($)
    expect(seen.spawns.map(s => s.name)).toEqual(['auditor-reviewer', 'auditor-reviewer'])
    expect(seen.sends.length).toBe(0)
  })

  test('after /clear a late turn end from the old reviewer matches nothing and is ignored, and dispatch numbers carry on', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await workerTurn($)
    expect(await entriesOf($, { which: 'record' }, 'ag2')).toBe(RECORD_OF(2, 'ASSISTANT: working'))
    await $.turn.complete(TURN_END('ag1', 'stale.ts:1 old.', USAGE))
    expect(seen.prompts.length).toBe(0)
    expect(logOf(seen, LOG_2)).toBeUndefined()
    await $.turn.complete(TURN_END('ag2', 'Nothing to note.', USAGE))
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', number: 2 })
  })

  // A review is open while these arrive: none of them names the reviewer, so none is its delivery.
  test('other peers and other task notifications pass through unchanged', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    for (let i = 0; i < 4; i++) {
      await $.prompt.submit({ text: 'Another Claude session sent a message: [Subagent hand-back] other-agent', wait: false, origin: { kind: 'peer' as const } })
      await $.prompt.submit({ text: '<agent-message from="worker-helper">\n[Subagent hand-back] sub1 done', wait: false, origin: { kind: 'peer' as const } })
      await $.prompt.submit({ text: '<task-notification>background agent ag2 finished</task-notification>', wait: false, origin: { kind: 'task-notification' as const } })
    }
    expect(seen.prompts.length).toBe(12)
    expect(seen.toasts.length).toBe(0)
  })

  // A worker subagent's hand-back passes to the worker.
  test('a worker subagent hand-back passes to the worker', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const helper = { text: '<agent-message from="worker-helper">\n[Subagent hand-back] sub1 done', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(helper)
    expect(seen.prompts).toEqual([helper.text])
  })

  test('a refused spawn does not block the worker, toasts nothing, and logs the refusal as its review\'s reason', ON, async ($, on) => {
    const seen = engine(on, { spawn: { deny: 'no' } })
    await workerTurn($)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review failed: reviewer spawn refused: no')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn refused: no' })
    expect(seen.spawns.map(typeOf)).toEqual(['auditor:reviewer'])
  })

  test('a worker turn end with no Stop whose dispatch throws is logged, and dispatches nothing', ON, async ($, on) => {
    const seen = engine(on, { clockFails: true })
    await $.prompt.submit(COMPOSER('first'))
    await step($, 'working')
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review dispatch failed')
    expect(seen.spawns.length).toBe(0)
  })

  test('a Stop whose dispatch throws is logged, and dispatches nothing', ON, async ($, on) => {
    const seen = engine(on, { clockFails: true })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review dispatch failed')
    expect(seen.spawns.length).toBe(0)
  })

  test('the reviewer hand-back is dropped before it reaches the worker, its marker opening the first line or the line after a reviewer\'s envelope', ON, async ($, on) => {
    const seen = engine(on)
    expect(await $.prompt.submit({ text: '[Subagent hand-back] auditor-reviewer done', wait: false, origin: { kind: 'peer' } })).toEqual({ drop: 'reviewer bookkeeping' })
    expect(await $.prompt.submit({ text: '<agent-message from="auditor-reviewer-2">\n[Subagent hand-back] auditor-reviewer-2 done\nNothing to note.', wait: false, origin: { kind: 'peer' } })).toEqual({ drop: 'reviewer bookkeeping' })
    expect(seen.prompts.length).toBe(0)
  })

  test('the hand-back wording anywhere else in a reviewer\'s text is not a hand-back: a note quoting it, or the marker past the first line, passes', ON, async ($, on) => {
    const seen = engine(on)
    const passing = [
      'Another Claude session sent a message: [Subagent hand-back] auditor-reviewer done',
      '<agent-message from="auditor-reviewer">\nauditor, review 3:\n[Subagent hand-back] is quoted here.',
      '<agent-message from="auditor-reviewer">\nauditor, review 3:\nSubagent hand-back is quoted here.\n</agent-message>',
      'auditor-reviewer says: see the [Subagent hand-back] frame',
    ]
    for (const text of passing) await $.prompt.submit({ text, wait: false, origin: { kind: 'peer' } })
    expect(seen.prompts).toEqual(passing)
  })

  test('a hand-back from a helper whose name only begins with the reviewer\'s name reaches the worker', async ($, on) => {
    const seen = engine(on)
    const helper = { text: '[Subagent hand-back] auditor-reviewer-x done\nx.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(helper)
    expect(seen.prompts).toEqual([helper.text])
  })

  test('a peer message that names a reviewer without the hand-back wording passes to the worker, and every review still runs and sends its note', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const reworded = { text: 'Another Claude session sent a message: auditor-reviewer finished\na.ts:4 swallows it.', wait: false, origin: { kind: 'peer' as const } }
    for (let i = 0; i < 3; i++) {
      await $.prompt.submit(reworded)
      await turnEnded($, 'ag1', 'a.ts:4 swallows it.')
      await mainTurnEnd($)
      await workerTurn($)
    }
    expect(seen.prompts.filter(p => p === reworded.text).length).toBe(3)
    expect(toMain(seen).length).toBe(3)
    expect(seen.sends.length).toBe(3)
  })

  // A background task notification passes through.
  test('a background task notification passes through', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, NOTE(), 'ag1')
    await $.prompt.submit({ text: '<task-notification>background agent ag1 finished</task-notification>', wait: false, origin: { kind: 'task-notification' } })
    expect(seen.prompts.at(-1)).toContain('background agent ag1 finished')
  })

  test('the brief names the entries tool, the review and its entry count, and never reads the transcript', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    const prompt = seen.spawns[0].prompt as string
    expect(prompt).toContain('Review 1. Its record holds entries 1-1,')
    expect(prompt).toContain(`${ENTRIES} tool, which: 'record', page by page`)
    expect(prompt).toContain('Worker last message:\nDone.')
    expect(prompt).not.toContain('transcript')
    expect(seen.reads).toEqual([])
  })

  test('the record holds the prompt, the worker\'s reply and the tool call, in order, and no file is written for it', ON, async ($, on) => {
    const seen = engine(on, { tools: { Edit: { text: 'edited' } } })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await step($, 'I will edit p.ts.')
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix the parser', 'ASSISTANT: I will edit p.ts.', 'TOOL Edit(file_path="p.ts" {}) -> edited'))
    expect(entryWrites(seen)).toEqual([])
  })

  test('the worker\'s replies are recorded in the order they arrive, between its tool calls', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' } } })
    await $.prompt.submit(COMPOSER('fix'))
    await step($, 'Editing now.')
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await step($, 'Multi-line\nreply.')
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix', 'ASSISTANT: Editing now.', 'TOOL Edit(file_path="p.ts" {}) -> edited', 'ASSISTANT: Multi-line\nreply.'))
  })

  test('a reviewer\'s own model requests are not recorded as the worker\'s replies', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('fix'))
    await step($, 'reviewer text', 'ag1')
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix'))
  })

  test('a failed tool call is marked as an error in the record', ON, async ($, on) => {
    engine(on, { tools: { Bash: { text: 'no such file', isError: true } } })
    await $.prompt.submit(COMPOSER('list it'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL Bash({"command":"ls"}) -> ERROR no such file')
  })

  // A prompt typed over a running turn is queued into it, so no turn starts for it; the record shows it where it arrived.
  test('a prompt typed mid-turn is recorded where it arrives, between the tool calls around it', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' }, Grep: { text: 'hit' } } })
    await $.prompt.submit(COMPOSER('first'))
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await $.prompt.submit(COMPOSER('mid-turn'))
    await $.tool.call(WORKER_CALL('Grep', { pattern: 'x' }))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: first', 'TOOL Edit(file_path="p.ts" {}) -> edited', 'USER: mid-turn', 'TOOL Grep({"pattern":"x"}) -> hit'))
  })

  test('two tool calls that run at once both reach the record', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' }, Grep: { text: 'hit' } } })
    await $.prompt.submit(COMPOSER('fix'))
    await Promise.all([
      $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' })),
      $.tool.call(WORKER_CALL('Grep', { pattern: 'x' })),
    ])
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix', 'TOOL Edit(file_path="p.ts" {}) -> edited', 'TOOL Grep({"pattern":"x"}) -> hit'))
  })

  test('the record page names its entries and the total at the top, and keeps every entry as its own block', ON, async ($, on) => {
    engine(on, { tools: { Grep: { text: 'hit' } } })
    await $.prompt.submit(COMPOSER('search'))
    for (let i = 0; i < 29; i++) await $.tool.call(WORKER_CALL('Grep', { pattern: `p${i}` }))
    await $.classic.Stop(stop)
    const text: string = await entriesOf($, { which: 'record' })
    expect(text.startsWith('Record of auditor review 1: entries 1-30 of 30\n\n[1] USER: search\n\n[2] TOOL Grep(')).toBe(true)
    expect(text.match(/^\[\d+\] /gm)?.length).toBe(30)
    expect(text.endsWith('[30] TOOL Grep({"pattern":"p28"}) -> hit\n\n')).toBe(true)
  })

  test('a tool call a reviewer makes is not recorded', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'ag1' } as any)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await $.prompt.submit(COMPOSER('next'))
    await $.classic.Stop(stop)
    // The next dispatch carries only the worker's turn: the reviewer's call reached no record.
    expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(RECORD_OF(2, 'USER: next'))
  })

  test('a worker\'s own SendMessage to a reviewer and its own Agent spawn of a reviewer type are recorded', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'SendMessage', to: 'ag1', message: 'Look at the parser.' } as any)
    await $.tool.call({ tool: 'Agent', prompt: 'Look at the tests.', subagent_type: 'auditor:reviewer', description: 'd' } as any)
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1,
      'TOOL SendMessage({"to":"ag1","message":"Look at the parser."}) -> ran SendMessage',
      'TOOL Agent({"prompt":"Look at the tests.","subagent_type":"auditor:reviewer","description":"d"}) -> ran Agent'))
  })

  test('a dispatch by spawn and one by send leave no entry for their brief in the next record', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    // The engine raises the plugin's own spawn as an Agent call, carrying the brief.
    const spawn = seen.spawns[0]
    await $.tool.call({ tool: 'Agent', prompt: spawn.prompt, description: spawn.description, subagent_type: spawn.subagentType, name: spawn.name } as any)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    // The engine raises the plugin's own send as a SendMessage call, carrying the brief.
    await $.tool.call({ tool: 'SendMessage', to: 'ag1', message: seen.sends[0].text } as any)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: second'))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('third'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'SendMessage', to: 'ag1', message: seen.sends[1].text } as any)
    expect(seen.sends.length).toBe(2)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(3, 'USER: third'))
  })

  test('each brief is in flight before the engine runs its spawn or send', ON, async ($, on) => {
    const seen = engine(on)
    const flights: string[][] = seen.flights
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    expect(flights).toEqual([[seen.spawns[0].prompt]])
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(flights.length).toBe(2)
    expect(flights[1]).toContain(seen.sends[0].text)
  })

  test('a brief leaves flight when its call is raised: the same text again is a worker call', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    const call = { tool: 'Agent', prompt: seen.spawns[0].prompt, description: 'd', subagent_type: 'auditor:reviewer' } as any
    await $.tool.call(call)
    expect(seen.conversation.briefsInFlight).toEqual([])
    expect(await entriesOf($, { which: 'live' })).toBe(NONE_SINCE(1))
    await $.tool.call(call)
    const live = await entriesOf($, { which: 'live' })
    expect(live).toContain('entries 1-1 of 1')
    expect(live).toContain('[1] TOOL Agent(')
  })

  test('a call that is not exactly a brief in flight is the worker\'s: a suffix, a first line, a cut', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    const brief: string = seen.spawns[0].prompt
    await $.tool.call({ tool: 'SendMessage', to: 'ag1', message: `${brief}\nplus` } as any)
    await $.tool.call({ tool: 'SendMessage', to: 'ag1', message: brief.split('\n')[0] } as any)
    await $.tool.call({ tool: 'Agent', prompt: brief.slice(0, -1), description: 'd' } as any)
    expect(await entriesOf($, { which: 'live' })).toContain('entries 1-3 of 3')
    expect(seen.conversation.briefsInFlight).toEqual([brief])
  })

  test('a /clear forgets the briefs in flight', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    const old: string = seen.spawns[0].prompt
    expect(seen.conversation.briefsInFlight).toEqual([old])
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.briefsInFlight).toEqual([])
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Agent', prompt: old, description: 'd' } as any)
    expect(await entriesOf($, { which: 'live' }, 'ag2')).toContain('entries 1-1 of 1')
  })

  test('a note that wakes an idle worker whose review settles before that turn ends: the next review is briefed at that turn\'s end, not at the settle', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await noteSent($, STALL_NOTE)
    // The note wakes the worker: its peer prompt starts a turn of its own.
    await $.prompt.submit(ARRIVED(1, STALL_NOTE))
    await $.turn.complete(TURN_END('ag1', 'Sent.', USAGE))
    expect({ notes: toMain(seen), sends: seen.sends.length, mid: seen.conversation.midTurn }).toEqual({ notes: [FRAMED(1, STALL_NOTE)], sends: 0, mid: true })
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-1,')
    await mainTurnEnd($)
    expect(seen.sends.length).toBe(1)
  })

  test('a note that wakes an idle worker whose turn ends before the review settles: the next review is briefed at the settle', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await noteSent($, 'a.ts:4 swallows it.')
    await $.prompt.submit(ARRIVED(1, 'a.ts:4 swallows it.'))
    await workerTurn($, 'Fixed a.ts:4.')
    await mainTurnEnd($)
    // The review is still open, so the woken turn's end briefed nothing.
    expect(seen.sends.length).toBe(0)
    await $.turn.complete(TURN_END('ag1', 'Sent.', USAGE))
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-2,')
  })

  test('a settle whose brief send is refused spawns a new reviewer in the same dispatch, and toasts nothing', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1' })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await step($, 'working')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.length).toBe(1)
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain('Review 2. Its record holds entries 1-1,')
    expect(seen.toasts).toEqual([])
    expect(seen.conversation.failing).toBeUndefined()
  })

  test('two dispatch paths running at once brief the reviewer once', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await step($, 'working')
    await Promise.all([$.turn.complete(TURN_END('ag1', 'Nothing to note.', USAGE)), $.classic.Stop(stop)])
    expect(seen.sends.length).toBe(1)
  })

  test('a brief its refused send hands to the spawn stays in flight until that spawn call is recorded', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1' })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[0].prompt, description: 'auditor review' } as any)
    await mainTurnEnd($)
    await step($, 'working')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.briefsInFlight).toEqual([seen.spawns[1].prompt])
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[1].prompt, description: 'auditor review' } as any)
    expect(seen.conversation.briefsInFlight).toEqual([])
  })

  test('a busy worker\'s turn end after a note was let through briefs the reviewer', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await step($, 'working')
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 swallows it.')])
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-1,')
  })

  test('a brief whose send throws is not left in flight', ON, async ($, on) => {
    const seen = engine(on, { sendThrows: 'ag1' })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await step($, 'working')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.length).toBe(1)
    expect(seen.flights.at(-1)).toContain(seen.sends[0].text)
    expect(seen.conversation.briefsInFlight).not.toContain(seen.sends[0].text)
  })

  test('a refused reviewer spawn takes its brief out of briefsInFlight', ON, async ($, on) => {
    const seen = engine(on, { spawn: { deny: 'no' } })
    await workerTurn($)
    expect(seen.spawns.length).toBe(1)
    expect(seen.flights[0]).toContain(seen.spawns[0].prompt)
    expect(seen.conversation.briefsInFlight).not.toContain(seen.spawns[0].prompt)
  })

  // Core always names the started agent; a spawn another plugin's hook answered without `next` started none, and nothing would settle its review.
  test('a reviewer spawn that answers with no agent id fails its dispatch, so its review does not stay open', ON, async ($, on) => {
    const opts: Opts = { spawnNoId: true }
    const seen = engine(on, opts)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn returned no agent id' })
    expect(seen.conversation.review).toBeUndefined()
    expect(seen.conversation.failing).toBe('not dispatched')
    expect(seen.conversation.briefsInFlight).toEqual([])
    opts.spawnNoId = false
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(seen.spawns.length).toBe(2)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: first', 'USER: second'))
  })

  test('a refused send, then a spawn that is denied, leaves no brief in flight, and the worker\'s identical Agent call is recorded', ON, async ($, on) => {
    const opts: Opts = {}
    const seen = engine(on, opts)
    await busyWorker($)
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[0].prompt, description: 'auditor review' } as any)
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    opts.sendFails = 'ag1'
    opts.spawn = { deny: 'no' }
    await workerTurn($, 'Second.')
    expect(seen.spawns.at(-1).prompt).toBe(seen.sends.at(-1).text)
    expect(seen.flights.at(-1)).toContain(seen.spawns.at(-1).prompt)
    expect(seen.conversation.briefsInFlight).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review failed: reviewer spawn refused: no')
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns.at(-1).prompt, description: 'auditor review' } as any)
    expect(seen.conversation.record.blocks.at(-1)).toContain('TOOL Agent(')
  })

  test('a refused send, then a spawn that throws, leaves no brief in flight, and the worker\'s identical Agent call is recorded', ON, async ($, on) => {
    const opts: Opts = {}
    const seen = engine(on, opts)
    await busyWorker($)
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[0].prompt, description: 'auditor review' } as any)
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    opts.sendFails = 'ag1'
    opts.spawnThrows = 'spawn broke'
    await workerTurn($, 'Second.')
    expect(seen.spawns.at(-1).prompt).toBe(seen.sends.at(-1).text)
    expect(seen.flights.at(-1)).toContain(seen.spawns.at(-1).prompt)
    expect(seen.conversation.briefsInFlight).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review dispatch failed')
    expect(JSON.stringify(seen.logs)).not.toContain('reviewer spawn refused')
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns.at(-1).prompt, description: 'auditor review' } as any)
    expect(seen.conversation.record.blocks.at(-1)).toContain('TOOL Agent(')
  })

  test('two dispatch paths past their first check brief the reviewer once', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await step($, 'working')
    const held = gate()
    const reached = gate()
    seen.clockHold = { until: held.until, reached: () => { if (seen.clockCalls === 2) reached.open() } }
    seen.clockCalls = 0
    const both = [$.classic.Stop(stop), $.classic.Stop(stop)]
    await reached.until
    expect(seen.clockCalls).toBe(2)
    held.open()
    await Promise.all(both)
    expect(seen.sends.length).toBe(1)
  })

  test('a conversation state written before briefsInFlight existed still dispatches', ON, async ($, on) => {
    const seen = engine(on)
    seen.stripBriefs = true
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    expect(seen.spawns.length).toBe(1)
  })

  test('a state written before subagents and dispatches were stored reads them as none: a subagent call is recorded, and the first dispatch is review 1', ON, async ($, on) => {
    // A state with neither field: its defaults are an empty subagent map and no dispatch.
    const seen = engine(on, { stateSeed: {}, agents: [{ id: 'sub7', name: '' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'sub7' } as any)
    await $.classic.Stop(stop)
    expect(seen.spawns[0].prompt).toContain('Review 1. Its record holds entries 1-2,')
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix the parser', 'TOOL [agent sub7] Read({"file_path":"a.ts"}) -> ran Read'))
  })

  test('a tool call the worker\'s own subagent makes is recorded, named by its id when no label is known', ON, async ($, on) => {
    engine(on, { agents: [{ id: 'sub7', name: '' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'sub7' } as any)
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL [agent sub7] Read({"file_path":"a.ts"}) -> ran Read')
  })

  test('a subagent spawned by the worker is labelled with its type and name, keyed by its id', ON, async ($, on) => {
    engine(on)
    await $.agent.spawn({ subagentType: 'Explore', name: 'scan', description: 'd', prompt: 'p' } as any)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'sub1' } as any)
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL [agent sub1 (Explore, scan)] Grep({"pattern":"x"}) -> ran Grep')
  })

  test('the live snake_case spelling of a model-made subagent\'s type and name is read too', ON, async ($, on) => {
    engine(on)
    await $.agent.spawn({ subagent_type: 'general-purpose', name: 'fix', description: 'd', prompt: 'p' } as any)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'sub1' } as any)
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('[agent sub1 (general-purpose, fix)]')
  })

  // A fork of the engine's own loop (compaction, memory) is no worker's work, and its denied entries call is not the worker's either.
  test('a subagent loop no list names is not recorded, the denied entries call a fork made included', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    expect(await $.tool.call({ tool: ENTRIES, which: 'record', agentId: 'fork1' })).toMatchObject({ deny: REFUSED })
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'fork1' } as any)
    expect(await entriesOf($, { which: 'live' })).toBe(NONE_SINCE(1))
  })

  test('a subagent loop the list names is recorded though the worker never spawned it', ON, async ($, on) => {
    engine(on, { agents: [{ id: 'fork2', name: '' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'fork2' } as any)
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, 'TOOL [agent fork2] Read({"file_path":"a.ts"}) -> ran Read'))
  })

  test('a subagent loop is recorded when the agent list rejects', ON, async ($, on) => {
    engine(on, { listFails: true })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'fork3' } as any)
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, 'TOOL [agent fork3] Read({"file_path":"a.ts"}) -> ran Read'))
  })

  test('a subagent loop the list names is looked up once: its label is kept, and its later calls read no list', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'team1', name: 'helper', type: 'general-purpose' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'team1' } as any)
    const lists = seen.listCalls
    await $.tool.call({ tool: 'Read', file_path: 'b.ts', agentId: 'team1' } as any)
    expect(seen.listCalls).toBe(lists)
    expect(seen.conversation.subagents['team1']).toEqual({ type: 'general-purpose', name: 'helper' })
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL [agent team1 (general-purpose, helper)] Read({"file_path":"b.ts"}) -> ran Read')
  })

  test('a subagent loop recorded while the agent list rejects is not kept as the worker\'s: the next call asks the list again', ON, async ($, on) => {
    const seen = engine(on, { listFailsAt: 1 })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'fork4' } as any)
    expect(seen.conversation.subagents['fork4']).toBeUndefined()
    const lists = seen.listCalls
    await $.tool.call({ tool: 'Read', file_path: 'b.ts', agentId: 'fork4' } as any)
    expect(seen.listCalls).toBe(lists + 1)
  })

  test('a worker\'s spawn under the reviewer\'s name but of another type is the worker\'s subagent, not the reviewer', ON, async ($, on) => {
    const seen = engine(on)
    await $.agent.spawn({ subagentType: 'general-purpose', name: 'auditor-reviewer', description: 'd', prompt: 'p' } as any)
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.reviewerIds).toEqual([])
    expect(seen.conversation.subagents['sub1']).toEqual({ type: 'general-purpose', name: 'auditor-reviewer' })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'sub1' } as any)
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL [agent sub1 (general-purpose, auditor-reviewer)] Read({"file_path":"a.ts"}) -> ran Read')
  })

  test('a worker\'s own spawn of the reviewer type is the worker\'s subagent: only the auditor\'s spawn is stored as the reviewer', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['wk1', 'ag1'] })
    await $.agent.spawn({ subagentType: 'auditor:reviewer', name: 'auditor-reviewer', description: 'd', prompt: 'p' } as any)
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.reviewerIds).toEqual([])
    expect(seen.conversation.subagents['wk1']).toEqual({ type: 'auditor:reviewer', name: 'auditor-reviewer' })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'wk1' } as any)
    await $.classic.Stop(stop)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL [agent wk1 (auditor:reviewer, auditor-reviewer)] Read({"file_path":"a.ts"}) -> ran Read')
  })

  test('a state written before lastMessage was stored briefs no last message as none', ON, async ($, on) => {
    const seen = engine(on, { stateSeed: {} })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(seen.spawns[0].prompt).toContain('Worker last message:\n(none)')
  })

  test('a dispatch empties the record, so a turn\'s calls are not repeated in the next one', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' } } })
    await $.prompt.submit(COMPOSER('first'))
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await $.classic.Stop(stop)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: second'))
  })

  test('a background subagent\'s call between dispatches lands in the next record', ON, async ($, on) => {
    engine(on, { agents: [{ id: 'sub1', name: '' }] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Read', file_path: 'bg.ts', agentId: 'sub1' } as any)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toContain('TOOL [agent sub1] Read({"file_path":"bg.ts"}) -> ran Read')
  })

  test('a /clear empties the record', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' } } })
    await $.prompt.submit(COMPOSER('before'))
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await $.prompt.submit(COMPOSER('after'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: after'))
  })

  test('a subagent turn writes nothing into the record', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const written = seen.writes.length
    await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', agentId: 'sub1' } as any)
    expect(seen.writes.length).toBe(written)
  })

  test('each dispatch freezes its record: an entry after it does not change the review\'s record', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('first ask'))
    await $.classic.Stop(stop)
    await $.prompt.submit(COMPOSER('mid-review'))
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: first ask'))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await $.prompt.submit(COMPOSER('second ask'))
    await $.classic.Stop({ ...stop, last_assistant_message: 'two' })
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: mid-review', 'USER: second ask'))
  })

  // The review log.
  test('the finished review file carries its fields, and the turn end\'s usage', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await reviewed($, HANDBACK('a.ts:4 swallows it.'), 'ag1')
    await mainTurnEnd($)
    const line = logOf(seen, LOG_1)
    expect(line).toMatchObject({
      status: 'complete',
      number: 1,
      reason: null,
      record_entries: 1,
      model_configured: 'claude-haiku-5-5',
      model_resolved: 'm',
      usage: { input_tokens: 10, output_tokens: 5, model: 'm' },
      note: 'a.ts:4 swallows it.',
      note_delivered: true,
      escalation: false,
    })
    expect(typeof line.dispatched_at).toBe('number')
    for (const field of ['hand_back_line', 'effort_configured', 'effort_requested', 'effort_applied', 'effort_source']) expect(line).not.toHaveProperty(field)
  })

  test('a review whose turn end reports no usage logs usage as null', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(HANDBACK('Nothing to note.'))
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', usage: null })
  })

  test('the review log keeps the reviewer turn end\'s answer, reason and duration', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(HANDBACK('Nothing to note.'))
    await $.turn.complete({ ...TURN_END('ag1', 'Nothing to note.', USAGE), durationMs: 42, reason: 'answer' })
    const line = logOf(seen, LOG_1)
    expect(line.turn_end).toMatchObject({ answer: 'Nothing to note.', reason: 'answer', duration_ms: 42 })
    expect(line.turn_end.at).toBeGreaterThan(line.dispatched_at)
  })

  test('the debug log says the spawn result gave a reviewer its id and the name it runs under', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    expect(JSON.stringify(seen.logs)).toContain('reviewer id ag1 (auditor-reviewer) from its spawn result')
  })

  test('the debug log names an open review whose reviewer has no id when the worker stops', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold })
    const first = workerTurn($)
    await held.reached
    await workerTurn($, 'Second.')
    expect(JSON.stringify(seen.logs)).toContain('has an open review but no reviewer id')
    held.land()
    await first
  })

  test('a log is written only when the log switch is on, and it is off by default', async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(Object.keys(seen.files).filter(p => p.startsWith(DIR))).toEqual([])
  })

  test('a peer message that names a reviewer without the hand-back wording reaches the worker, and the reviewer\'s note goes to main beside it', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const passed = { text: 'Another Claude session sent a message: auditor-reviewer finished\na.ts:4 raw.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(passed)
    await turnEnded($, 'ag1', 'a.ts:4 raw.')
    expect(seen.prompts).toEqual([passed.text])
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 raw.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 raw.', note_delivered: true })
  })

  test('a /clear writes the open review as incomplete under the session it ended', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', number: 1, reason: 'session ended: clear' })
  })

  test('a resume ends the session like a clear: its open review is logged incomplete, and nothing carries over', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.end({ reason: 'resume', sessionId: 's1' } as any)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: resume' })
    await workerTurn($)
    expect(seen.spawns.map(s => s.name)).toEqual(['auditor-reviewer', 'auditor-reviewer'])
  })

  test('the open review of a session that exits is logged incomplete', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1' } as any)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: prompt_input_exit' })
  })

  test('a session end whose log write fails still forgets the reviewer, and the failure is logged', ON, async ($, on) => {
    const seen = engine(on, { writeFails: LOG_1 })
    await workerTurn($)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review log failed')
    await workerTurn($)
    expect(seen.spawns.map(s => s.name)).toEqual(['auditor-reviewer', 'auditor-reviewer'])
  })

  test('a refused send forgets the reviewer: the spawn that replaces it is the reviewer the next dispatch sends to', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect({ spawns: seen.spawns.length, reviewer: seen.conversation.reviewer?.id }).toEqual({ spawns: 2, reviewer: 'ag2' })
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', number: 2 })
    await workerTurn($, 'Third.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1', 'ag2'])
  })

  test('two escalations toast once each, as each note is delivered', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'Escalation: one. Escalating.')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await step($, 'working')
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'Escalation: two. Escalating.')
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([FRAMED(1, 'Escalation: one. Escalating.'), FRAMED(2, 'Escalation: two. Escalating.')])
    expect(seen.toasts).toEqual([ESCALATED_TOAST, ESCALATED_TOAST])
  })

  test('the review log names the Claude Code version, and a log that cannot be written does not stop the reviewer', ON, async ($, on) => {
    const seen = engine(on, { writeFails: LOG_1 })
    await busyWorker($)
    await reviewed($, HANDBACK('a.ts:1 x.'), 'ag1')
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:1 x.')])
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, 'auditor: review log failed').length).toBe(1)
    await workerTurn($, 'Second.')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', claude_code_version: '2.1.293' })
  })

  test('a subagent spawn whose bookkeeping fails still spawns, and the failure is logged', ON, async ($, on) => {
    const seen = engine(on, { stateFails: 'conversation' })
    const started = await $.agent.spawn({ subagentType: 'Explore', name: 'scan', description: 'd', prompt: 'p' } as any)
    expect(started).toMatchObject({ agentId: 'sub1' })
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('subagent bookkeeping failed')
  })

  // The shape measured live in a session without agent teams: the reviewer's envelope, then the hand-back marker on the next line.
  test('a live-shaped reviewer hand-back is dropped at the prompt, and starts no worker turn', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    expect(await $.prompt.submit(LIVE_HANDBACK('Nothing to note.'))).toEqual({ drop: 'reviewer bookkeeping' })
    expect(seen.prompts).toEqual([])
    expect(seen.conversation.midTurn).toBe(false)
  })

  test('a reviewer turn end that cannot be settled is logged, and the worker\'s turn goes on', ON, async ($, on) => {
    const seen = engine(on, { stateFails: 'conversation' })
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.', USAGE))
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review settlement failed')
  })

  test('a review settling between the worker\'s Stop and its turn end is briefed at that turn end, once', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await step($, 'working')
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.sends.length).toBe(0)
    await mainTurnEnd($)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-1,')
  })

  test('a Stop that briefed the reviewer is followed by one brief only at the worker\'s turn end', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    expect({ spawns: seen.spawns.length, sends: seen.sends.length }).toEqual({ spawns: 1, sends: 0 })
  })

  test('the registered prompt sends a note to main with SendMessage, opening with its review line, and sends nothing for a quiet review', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    expect(prompt).toContain('sends its note with SendMessage, `to: "main"`, as one message whose first line is the review\'s own line from the brief, `auditor, review N:`')
    expect(prompt).toContain('When nothing deviates, send nothing.')
    expect(prompt).toContain('exactly `Nothing to note.` for a review that sent nothing')
    expect(prompt).toContain('opens with `Escalation:`')
    // The line is named in the Output protocol, as the notes' heading and in echo recognition; each must match the plugin's.
    expect(prompt.split('`auditor, review N:`').length - 1).toBe(3)
  })

  test('the registered prompt describes no delivery by submitted prompt, appended row or held note, and no final answer as the note', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    for (const gone of ['Your final answer is your note', 'send corrections in your final answer', 'Your answer reaches the worker whole', 'as the prompt of a turn of its own', 'at its next tool call', 'beside the user\'s next prompt', 'the note waits for the user', 'since your note was submitted', 'as a row added', 'as prompts headed']) expect(prompt).not.toContain(gone)
    expect(prompt).toContain('A note written in your final answer instead of sent reaches no one.')
    expect(prompt).toContain('appear in the worker\'s record as peer prompts carrying your agent message')
  })

  test('the registered prompt recognises both shapes of an earlier note: a peer prompt with its envelope, and a held note as the plugin\'s own prompt without one', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    expect(prompt).toContain('a note held after the user interrupted appears as the plugin\'s own prompt, with no agent-message envelope')
    expect(prompt).toContain('Either opens with `auditor, review N:`, after any envelope.')
    expect(prompt).not.toContain('its first line `auditor, review N:`')
    expect(prompt).toContain('Your notes reach the worker opening with that line, inside the agent message that carries them from you or, for a note held after the user interrupted, with no envelope.')
  })

  test('the registered prompt names the entries tool it registers, and keeps the live-entries rule for a missing write', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    expect(prompt).toContain(`\`mcp__auditor__${seen.registeredTools[0].name}\``)
    expect(prompt).toContain('Before a finding claims that a file on disk has no matching write, or does not match what the worker reported, fetch the live entries')
    expect(prompt).toContain('a write there is the worker\'s later work')
    expect(prompt).toContain('plus the live entries before any missing-write claim')
    expect(prompt).not.toContain('Each file opens')
    expect(prompt).not.toContain('4 MiB')
    expect(prompt).not.toContain('live file')
  })

  test('the registered prompt sends the reviewer to the transcript tool it registers for anything older than its record, by a specific search and a bounded line', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    const tool = seen.registeredTools[1]
    expect(prompt).toContain(`\`mcp__auditor__${tool.name}\``)
    // The inputs the prompt names are the ones the tool takes.
    for (const input of ['search', 'line', 'full', 'from']) {
      expect(prompt).toContain(`\`${input}`)
      expect(tool.inputSchema.properties[input]).toBeDefined()
    }
    expect(prompt).toContain('The record covers only the entries since your previous review')
    expect(prompt).toContain('above all a rule or instruction the user stated many turns ago')
    expect(prompt).toContain('Search it before concluding that a step an earlier instruction plausibly governs breaks no rule: a commit, push, deletion or dispatch, a file or command outside the task the user or the plan set, or a claim of done.')
    // The gate before alleging what the user said is stated once, in the allegation paragraph.
    expect(prompt).not.toContain('the user never said something')
    expect(prompt).toContain('a specific term, such as a phrase from the rule, a file name or a command, not a broad word')
    expect(prompt).toContain('the first ten matching lines come back')
    expect(prompt).toContain('with the characters cut before and after it, and the answer says how many match in all')
    expect(prompt).toContain('read only the lines you need with `line`, one at a time')
    expect(prompt).toContain('ending in `…+N characters` when cut')
    expect(prompt).toContain('Ask for the whole digest with `full: true` only when the bounded part cannot settle the question; it comes in pages, and each page\'s header names the `from` of the next.')
    expect(prompt).toContain('never with Glob, Read or Grep on a transcript file')
    expect(prompt).toContain('so search the session transcript for a user statement or approval from before it')
    expect(prompt).toContain('plus the transcript searches an earlier rule or user statement needs')
    expect(prompt).not.toContain('must not be searched for')
  })

  test('the registered prompt says what the transcript lacks, what a no-match rules out and whose words a line holds, and counts the transcript as evidence', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    expect(prompt).toContain('The transcript holds the worker\'s own conversation since the last `/clear`: not its subagents\' calls, which only this review\'s record shows, and nothing from before a `/clear`, so a search that finds nothing is not proof.')
    expect(prompt).toContain('A search matches exact text, so a no-match rules out only that wording: try the step\'s own command, file name or a single distinctive word before concluding.')
    expect(prompt).toContain('A snippet does not show who wrote its line, so attribute a statement to the user only from its line\'s digest. A line labelled `USER:` is the user\'s.')
    expect(prompt).toContain('A line labelled `PROMPT (...)`, such as an earlier reviewer\'s note, another agent\'s message or a task notification, is not the user\'s by its label, but it can relay a decision the user made')
    expect(prompt).toContain('already visible in the record, the transcript or on disk')
    expect(prompt).toContain('when you can quote the record, transcript or file text that makes it true')
    expect(prompt).toContain('read the cut text in the transcript when it holds the call. A claim that depends on text neither shows is interpretation-dependent')
    expect(prompt).not.toContain('Anything older than the record is in the session transcript')
  })

  test('the registered prompt names the transcript tool by its exact name, and the reviewer is given that tool', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registered[0].prompt).toContain('`mcp__auditor__transcript`')
    expect(seen.registered[0].tools).toContain(TRANSCRIPT)
  })

})

describe('the stall nudge', () => {
  const NOTHING = 'Nothing will wake the worker: no background task or scheduled wake-up is in flight.'
  // Stop's task list says a subagent or teammate is running, but the agent list is what says whether it works.
  const SUBAGENT = { id: 'sub9', type: 'subagent', status: 'running', description: 'Find the bug' }
  const SHELL = { id: 'sh1', type: 'shell', status: 'running', description: 'npm test' }
  const CRON = { id: 'c1', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' }
  const WORKING_SUB = { id: 'sub9', type: 'general-purpose', status: 'running', description: 'Find the bug' }
  const TEAMMATE = { id: 't1', teammateId: 'helper@team', type: 'teammate', name: 'helper', status: 'idle', description: 'Fix the lexer' }

  test('a stop with nothing in flight briefs the review that nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a stop with a working subagent, a shell and a scheduled wake-up in flight says what will wake the worker', ON, async ($, on) => {
    const seen = engine(on, { agents: [WORKING_SUB] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [SHELL], session_crons: [CRON] })
    expect(seen.spawns[0].prompt).toContain('Will wake the worker: subagent "Find the bug", shell "npm test"; 1 scheduled wake-up(s).')
    expect(seen.spawns[0].prompt).not.toContain(NOTHING)
  })

  test('a stop whose task list shows a subagent the agent list does not show as working says nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [SUBAGENT], session_crons: [] })
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a working teammate and a pending subagent wake the worker, and a task type not yet seen counts too', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ ...WORKING_SUB, status: 'pending' }, { ...TEAMMATE, status: 'running' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [{ id: 'x1', type: 'mcp', status: 'running', description: 'lookup' }], session_crons: [] })
    expect(seen.spawns[0].prompt).toContain('Will wake the worker: subagent "Find the bug", teammate "Fix the lexer", mcp "lookup".')
  })

  test('an agent the list shows as idle, completed, failed or killed wakes nothing, and neither do the reviewer\'s current and retired agents', ON, async ($, on) => {
    const seen = engine(on, {
      stateSeed: { reviewerIds: ['ag1', 'old1'] },
      agents: [
        { id: 'ag1', name: 'auditor-reviewer', type: 'general-purpose', status: 'running', description: 'auditor review' },
        { id: 'old1', name: 'auditor-reviewer-2', type: 'general-purpose', status: 'running', description: 'auditor review' },
        { ...TEAMMATE, status: 'idle' },
        { id: 's2', type: 'general-purpose', status: 'completed', description: 'done' },
        { id: 's3', type: 'general-purpose', status: 'failed', description: 'broke' },
        { id: 's4', type: 'general-purpose', status: 'killed', description: 'stopped' },
      ],
    })
    await $.prompt.submit(COMPOSER('fix the parser'))
    // The engine lists every agent the session spawned as running in Stop's tasks, idle or not: the agent list tells them apart.
    await $.classic.Stop({
      ...stop,
      background_tasks: [
        { id: 't1', type: 'teammate', status: 'running', description: 'Fix the lexer' },
        { id: 's2', type: 'subagent', status: 'running', description: 'done' },
        { id: 's3', type: 'subagent', status: 'running', description: 'broke' },
        { id: 's4', type: 'subagent', status: 'running', description: 'stopped' },
        { id: 'ag1', type: 'subagent', status: 'running', description: 'auditor review' },
      ],
      session_crons: [],
    })
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a reviewer this plugin spawned whose id is not stored yet wakes nothing, since the list names it as this plugin\'s spawn', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'ag7', name: 'auditor-reviewer', type: 'auditor:reviewer', status: 'running', description: 'auditor review', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('an idle agent\'s task under a label other than teammate or subagent is still set aside by its id', ON, async ($, on) => {
    const seen = engine(on, { agents: [TEAMMATE] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [{ id: 't1', type: 'in_process_teammate', status: 'running', description: 'Fix the lexer' }], session_crons: [] })
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a subagent or teammate the list shows as waiting, on its own background work, wakes the worker', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 's5', type: 'general-purpose', status: 'waiting', description: 'Run the suite' }, { ...TEAMMATE, status: 'waiting', description: 'Wait for CI' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain('Will wake the worker: subagent "Run the suite", teammate "Wait for CI".')
  })

  test('a stop right after the worker messaged an idle teammate names it as a waker, whatever its status', ON, async ($, on) => {
    const seen = engine(on, { agents: [TEAMMATE, { id: 's2', name: 'scan', type: 'general-purpose', status: 'completed', description: 'Scan the docs' }] })
    await $.prompt.submit(COMPOSER('ask the helper'))
    await $.tool.call({ tool: 'SendMessage', to: 'helper', message: 'Look at the lexer.' } as any)
    await $.tool.call({ tool: 'SendMessage', to: 'scan', message: 'Also the docs.' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain('Will wake the worker: teammate "Fix the lexer", subagent "Scan the docs".')
  })

  test('a teammate messaged by its listed name with its ref appended wakes the worker', ON, async ($, on) => {
    const seen = engine(on, { agents: [TEAMMATE] })
    await $.prompt.submit(COMPOSER('ask the helper'))
    await $.tool.call({ tool: 'SendMessage', to: 'helper [t1]', message: 'Look at the lexer.' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain('Will wake the worker: teammate "Fix the lexer".')
  })

  test('a SendMessage that failed wakes no one, so its idle recipient is not in flight', ON, async ($, on) => {
    const seen = engine(on, { agents: [TEAMMATE], tools: { SendMessage: { text: 'no such recipient', isError: true } } })
    await $.prompt.submit(COMPOSER('ask the helper'))
    await $.tool.call({ tool: 'SendMessage', to: 'helper', message: 'Look at the lexer.' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a turn whose main loop broadcasts states no stall fact, and the stall note its review sends is refused', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('tell the team to stop'))
    await $.tool.call({ tool: 'SendMessage', to: '*', message: 'Stop for the day.' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).not.toContain('wake the worker')
    await mainTurnEnd($)
    const sent = await noteSent($, STALL_NOTE)
    expect(sent.isDelivered).toBe(false)
    expect(sent.reason).toContain('did not say nothing will wake the worker')
    expect(toMain(seen)).toEqual([])
  })

  test('the turn after a broadcast, which sends none, says nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('tell the team to stop'))
    await $.tool.call({ tool: 'SendMessage', to: '*', message: 'Stop for the day.' } as any)
    await $.classic.Stop(QUIET_STOP)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('thanks'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('a broadcast that failed wakes no one, so its turn still says nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on, { tools: { SendMessage: { text: 'no such recipient', isError: true } } })
    await $.prompt.submit(COMPOSER('tell the team to stop'))
    await $.tool.call({ tool: 'SendMessage', to: '*', message: 'Stop for the day.' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a broadcast the engine refused wakes no one, so its turn still says nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on, { tools: { SendMessage: { text: 'refused', deny: 'SendMessage is not allowed' } } })
    await $.prompt.submit(COMPOSER('tell the team to stop'))
    await $.tool.call({ tool: 'SendMessage', to: '*', message: 'Stop for the day.' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a broadcast from a listed subagent of the worker withholds nothing, so its turn says nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'sub7', name: 'helper', type: 'general-purpose', status: 'completed', description: 'Scan the docs' }] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call({ tool: 'SendMessage', to: '*', message: 'Stop for the day.', agentId: 'sub7' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a teammate the worker messaged in an earlier turn does not wake it in a later one', ON, async ($, on) => {
    const seen = engine(on, { agents: [TEAMMATE] })
    await $.prompt.submit(COMPOSER('ask the helper'))
    await $.tool.call({ tool: 'SendMessage', to: 'helper', message: 'Look at the lexer.' } as any)
    await $.classic.Stop(QUIET_STOP)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('thanks'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('a stop at which the agent list cannot be read gives no wake line', ON, async ($, on) => {
    const seen = engine(on, { listFails: true })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [SHELL], session_crons: [] })
    expect(seen.spawns[0].prompt).not.toContain('wake the worker')
  })

  test('scheduled wake-ups alone are counted, and say they will wake the worker', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [], session_crons: [CRON, CRON] })
    expect(seen.spawns[0].prompt).toContain('Will wake the worker: 2 scheduled wake-up(s).')
  })

  test('a stop that omits its task and cron lists states no stall fact: absent is unknown, not empty', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    expect(seen.spawns[0].prompt).not.toContain('wake the worker')
  })

  test('the reviewer\'s own task is not in flight: a stop with only it running says nothing will wake the worker', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('again'))
    await $.classic.Stop({ ...stop, background_tasks: [{ id: 'ag1', type: 'subagent', status: 'running', description: 'auditor review' }], session_crons: [] })
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('a turn whose last tool call asked the user states no stall fact', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('pick one'))
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).not.toContain('wake the worker:')
  })

  test('a turn whose last tool call filed a human-plugin item for the user states no stall fact', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('file it'))
    await $.tool.call({ tool: 'mcp__human-plugin__human_items', action: 'add', title: 'Decide X' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).not.toContain('wake the worker:')
  })

  test('a human-plugin call that is not an add, made after an ask, leaves the stall fact in place', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('file it'))
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
    await $.tool.call({ tool: 'mcp__human-plugin__human_items', action: 'update', title: 'Decide X' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain(NOTHING)
  })

  test('a subagent\'s tool call after the worker\'s question keeps the guard: the stop states no stall fact', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'sub7', name: 'helper' }] })
    await $.prompt.submit(COMPOSER('pick one'))
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'sub7' } as any)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).not.toContain('wake the worker')
  })

  test('an ask in one turn does not guard the next turn, which ends with no tool call', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('pick one'))
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as any)
    await $.classic.Stop(QUIET_STOP)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('next'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('an aborted turn\'s brief states no stall fact, though the Stop before it stated one', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(QUIET_STOP)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('third'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).not.toContain('wake the worker:')
  })

  test('a delivered stall note sets the once-per-stall guard at its send: the next stop, with no prompt from the user, states no stall fact', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await noteSent($, STALL_NOTE)
    expect(seen.conversation.nudged).toBe(true)
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(toMain(seen)).toEqual([FRAMED(1, STALL_NOTE)])
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).not.toContain('wake the worker:')
  })

  test('a busy worker\'s stall note sets the once-per-stall guard too', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(QUIET_STOP)
    await turnEnded($, 'ag1', STALL_NOTE)
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).not.toContain('wake the worker:')
  })

  test('a stall note from a review dispatched before the user\'s latest prompt does not set the guard: the next stop states its stall fact', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('the config too'))
    await turnEnded($, 'ag1', STALL_NOTE)
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([FRAMED(1, STALL_NOTE)])
    expect(seen.conversation.nudged).toBe(false)
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('a stall note from a review dispatched after the user\'s latest prompt sets the guard: the next stop states no stall fact', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(QUIET_STOP)
    await turnEnded($, 'ag1', STALL_NOTE)
    await mainTurnEnd($)
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.length).toBe(2)
    expect(seen.sends[0].text).toContain(NOTHING)
    expect(seen.sends[1].text).not.toContain('wake the worker')
  })

  test('a stall note from a review whose brief stated no stall fact is refused: it reaches no one, and the guard is not set', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    const sent = await noteSent($, STALL_NOTE)
    expect(sent.isDelivered).toBe(false)
    expect(sent.reason).toContain('did not say nothing will wake the worker')
    expect(toMain(seen)).toEqual([])
    expect(seen.conversation.nudged).toBe(false)
    expect(debugLines(seen, 'a reviewer send (review 1) was refused: this review\'s brief did not say nothing will wake the worker').length).toBe(1)
  })

  test('a reviewer that always sends a stall note is held to one: the second idle stop, with no prompt from the user, says nothing of waking, so its stall note is refused', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', STALL_NOTE)
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends[0].text).not.toContain('wake the worker')
    await turnEnded($, 'ag1', STALL_NOTE)
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([FRAMED(1, STALL_NOTE)])
  })

  test('a note that is not a stall leaves the next stop\'s stall fact in place', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'a.ts:4 swallows it.')
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('the user\'s next prompt re-arms the stall fact after a stall note', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', STALL_NOTE)
    await $.prompt.submit(COMPOSER('the config too'))
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends[0].text).toContain(NOTHING)
  })

  test('a /clear re-arms the stall fact: the new conversation\'s first stop states it', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', STALL_NOTE)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await $.prompt.submit(HELPER)
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain(NOTHING)
  })

  test('a /clear carries the dispatch count into the prompt mark, so no review dispatched before it is after the user\'s latest prompt', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.dispatches).toBe(1)
    expect(seen.conversation.dispatchesAtPrompt).toBe(1)
  })

  test('the reviewer prompt makes the two stall cases findings under a brief that says nothing will wake the worker, and names the marker', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    const STALL_EXCEPTION = `**The stall exception.** When the brief says nothing will wake the worker, two cases are findings even though no rule broke: the worker's last turn ended on an open commitment with no tool call after it ("next I'll update the config", then nothing), or it says it is waiting on work the brief shows is not in flight. Nothing else will resume the worker, so your note is what does. Open its text after the review line with \`Stalled:\` and say plainly what is left undone: \`Stalled: you said you would update the config and ended the turn; nothing will wake you.\` or \`Stalled: you are waiting on the test run, but nothing is in flight.\` These are not stalls: a turn that ends by asking the user something or handing them a decision, a turn whose last message reports the work done and announces nothing more (a report that ends on a next step not taken, such as \`Next: …\`, is still a stall), and a turn whose closing line the user asked for word for word. If the brief has no line about waking, there is no stall exception.`
    expect(prompt).toContain(STALL_EXCEPTION)
    expect(prompt).toContain('An open commitment is not a finding.')
  })
})

describe('the entries tool', () => {
  const EDIT = 'TOOL Edit(file_path="p.ts" {}) -> ran Edit'
  const bytes = (text: string) => new TextEncoder().encode(text).length

  // Every page of a list, in order: each page's next-page line names the next page's from, and the last page names none. Bounded: a walk longer than the entries, or a next page that does not advance, fails here instead of hanging.
  const everyPage = async ($: any, which: 'record' | 'live', entries: number): Promise<string[]> => {
    const pages: string[] = []
    let from = 1
    while (from > 0) {
      expect(pages.length).toBeLessThan(entries)
      const text: string = await entriesOf($, { which, from })
      pages.push(text)
      const next = /next page: from=(\d+)/.exec(text)
      const following = next === null ? 0 : Number(next[1])
      expect(following === 0 || following > from).toBe(true)
      from = following
    }
    return pages
  }

  test('the entries tool is registered deferred, and the reviewer is given it, the transcript tool and the memory tool beside Read, Glob, Grep and SendMessage', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registeredTools).toMatchObject([{ name: 'entries', isDeferred: true, inputSchema: { required: ['which'] } }, { name: 'transcript', isDeferred: true }, { name: 'memory', isDeferred: true }])
    expect(seen.registered[0].tools).toEqual(['Read', 'Glob', 'Grep', 'SendMessage', ENTRIES, TRANSCRIPT, MEMORY])
  })

  test('the registered input schema pins which to record or live, and from to a whole number from 1', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registeredTools[0].inputSchema.properties.which.enum).toEqual(['record', 'live'])
    expect(seen.registeredTools[0].inputSchema.properties.from).toMatchObject({ type: 'integer', minimum: 1 })
  })

  test('the live entries hold every entry the worker recorded after the dispatch, up to the call, and none of the record\'s', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('fix'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'live' })).toBe(NONE_SINCE(1))
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, EDIT))
    await step($, 'more')
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, EDIT, 'ASSISTANT: more'))
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix'))
  })

  // 'é' is two bytes in UTF-8: a 20,000-character entry is 40,000 bytes, so two of them overflow a 50,000-byte page, though their 40,000 characters would fit one.
  test('a record past one page splits by bytes: every entry in exactly one page, each page names the next, and the last names none', ON, async ($, on) => {
    engine(on)
    const TEXT = 'é'.repeat(20000)
    await $.prompt.submit(COMPOSER(TEXT))
    await $.prompt.submit(COMPOSER(TEXT))
    await $.classic.Stop(stop)
    const pages = await everyPage($, 'record', 2)
    expect(pages).toEqual([
      `Record of auditor review 1: entries 1-1 of 2\nnext page: from=2\n\n[1] USER: ${TEXT}\n\n`,
      `Record of auditor review 1: entries 2-2 of 2\n\n[2] USER: ${TEXT}\n\n`,
    ])
    expect(pages.every(page => bytes(page) <= 50000)).toBe(true)
  })

  test('an entry over a page alone is clipped to fit a page and marked, with nothing after it', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('é'.repeat(30000)))
    await $.classic.Stop(stop)
    const pages = await everyPage($, 'record', 1)
    expect(pages.length).toBe(1)
    expect(bytes(pages[0] ?? '')).toBeLessThanOrEqual(50000)
    expect(pages[0]).toMatch(/ …\+\d+ characters\n\n$/)
  })

  test('twelve one-entry pages are walked in order, each numbered truly, and the walk ends', ON, async ($, on) => {
    engine(on)
    for (let i = 0; i < 12; i++) await $.prompt.submit(COMPOSER('é'.repeat(20000) + i))
    await $.classic.Stop(stop)
    const pages = await everyPage($, 'record', 12)
    expect(pages.map(p => Number(/entries (\d+)-/.exec(p)?.[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  test('a from past the last entry says there are none, and a which that is neither record nor live is refused', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('one'))
    await $.prompt.submit(COMPOSER('two'))
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record', from: 3 })).toBe('Record of auditor review 1 has 2 entries; there are none from entry 3 on.')
    expect(await entriesOf($, { which: 'live' })).toBe(NONE_SINCE(1))
    expect(await entriesOf($, { which: 'both' } as any)).toBe('which must be record or live')
    expect(await entriesOf($, { which: ['record'] } as any)).toBe('which must be record or live')
  })

  test('a call with no agent id, or from an agent that is not a reviewer, is refused with the reason', ON, async ($, on) => {
    engine(on)
    await workerTurn($)
    expect(await $.tool.call({ tool: ENTRIES, which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(await $.tool.call({ tool: ENTRIES, which: 'record', agentId: 'sub1' })).toMatchObject({ deny: REFUSED })
  })

  test('a refused worker call is recorded once, as an error carrying the refusal', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('one'))
    await $.classic.Stop(stop)
    expect(await $.tool.call({ tool: ENTRIES, which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, `TOOL ${ENTRIES}({"which":"record"}) -> ERROR ${REFUSED}`))
  })

  test('a reviewer whose id is not yet stored is served, found by its spawn name, and its own calls are not recorded', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, EDIT))
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, EDIT))
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix'))
    held.land()
    await stopping
  })

  test('a reviewer whose id is not yet stored is not recorded when its first call is not the entries tool', ON, async ($, on) => {
    const held = heldSpawn()
    engine(on, { spawnHold: held.hold, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: 'ag1' } as any)
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(1, EDIT))
    held.land()
    await stopping
  })

  test('a caller the agent list names otherwise, or does not name, is refused and adopts no reviewer', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'sub9', name: 'helper' }, { id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'sub9', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'zz', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(RECORD_OF(1, 'USER: fix'))
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    held.land()
    await stopping
  })

  test('a worker subagent of another type under a reviewer\'s name is refused before any reviewer is stored, adopts no reviewer, and its call is recorded', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'sub9', name: 'auditor-reviewer', type: 'general-purpose' }, { id: 'ag1', name: 'auditor-reviewer-2', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'sub9', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.reviewerIds).not.toContain('sub9')
    expect(await entriesOf($, { which: 'live' }, 'ag1')).toBe(LIVE_OF(1, `TOOL [agent sub9 (general-purpose, auditor-reviewer)] ${ENTRIES}({"which":"record"}) -> ERROR ${REFUSED}`))
    held.land()
    await stopping
  })

  test('a worker\'s own agent of the reviewer type under a reviewer\'s name is refused before any reviewer is stored, and adopts no reviewer', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'wk9', name: 'auditor-reviewer', type: 'auditor:reviewer' }, { id: 'ag1', name: 'auditor-reviewer-2', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'wk9', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.reviewerIds).not.toContain('wk9')
    held.land()
    await stopping
  })

  test('a second agent under a reviewer\'s spawn name does not displace the stored reviewer id', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }, { id: 'ag9', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    await $.classic.Stop(stop)
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'ag9', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1', model: 'm' })
  })

  test('a failed agent list refuses the reviewer call with the reason, and logs the failure', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, listFails: true, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'ag1', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(JSON.stringify(seen.logs)).toContain('agent list failed')
    expect(seen.toasts).toEqual([])
    expect(seen.conversation.reviewer).toBeUndefined()
    held.land()
    await stopping
  })

  test('an invalid from is refused, not served: zero, a negative number, a fraction, a string and a boolean', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('one'))
    await $.prompt.submit(COMPOSER('two'))
    await $.classic.Stop(stop)
    for (const from of [0, -1, 1.5, '1', true] as any[]) expect(await entriesOf($, { which: 'record', from })).toBe('from must be a whole entry number, 1 or more')
  })

  test('with no open review, the tool says so for both lists', ON, async ($, on) => {
    engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(await entriesOf($, { which: 'record' })).toBe(NO_REVIEW)
    expect(await entriesOf($, { which: 'live' })).toBe(NO_REVIEW)
  })

  test('a reviewer\'s own calls are answered and never recorded', ON, async ($, on) => {
    engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(await entriesOf($, { which: 'record' })).toBe(NO_REVIEW)
    await workerTurn($, 'Second.')
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'ASSISTANT: working'))
  })

  test('entries recorded after a review settles open the next review\'s record, and the settled review\'s list is no longer served', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('fix'))
    await $.classic.Stop(stop)
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(await entriesOf($, { which: 'live' })).toBe(NO_REVIEW)
    await step($, 'after')
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, EDIT, 'ASSISTANT: after'))
  })

  test('the brief names the entries tool, the review and its entry count, and no file path', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix'))
    await step($, 'ok')
    await $.classic.Stop(stop)
    const prompt = seen.spawns[0].prompt as string
    expect(prompt).toContain('Review 1. Its record holds entries 1-2,')
    expect(prompt).toContain(`${ENTRIES} tool, which: 'record'`)
    expect(prompt).toContain(`which: 'live'`)
    expect(prompt).not.toContain('/record/')
    expect(prompt).not.toContain('/live/')
    expect(prompt).not.toContain('.txt')
  })

  test('no record or live file is ever written, and the review log counts the record\'s entries', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix'))
    await step($, 'ok')
    await $.classic.Stop(stop)
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(entryWrites(seen)).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', record_entries: 2 })
    expect(Object.keys(logOf(seen, LOG_1))).not.toContain('record_files')
  })
})

describe('the transcript tool', () => {
  const TURN_FAILURE = 'auditor: review failed: reviewer turn ended with reason error, isAborted false'
  const TRANSCRIPT_PATH = '/home/test/.claude/projects/p/s1.jsonl'
  const NEW_PATH = '/home/test/.claude/projects/p/s2.jsonl'
  const SESSION = { ...stop, transcript_path: TRANSCRIPT_PATH }
  const DIGEST_USER = 'USER: Keep the parser pure: no I/O in parse_line.'
  const ROW_USER = JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'Keep the parser pure: no I/O in parse_line.' } })
  const bytes = (text: string) => new TextEncoder().encode(text).length
  const last = (seen: any) => seen.runs[seen.runs.length - 1]
  const ask = ($: any, input: Record<string, unknown>, agentId?: string) => $.tool.call({ tool: TRANSCRIPT, agentId, ...input })
  const answer = async ($: any, input: Record<string, unknown>) => (await ask($, input, 'ag1')).result
  // The worker's turn that dispatches review 1, so the reviewer (ag1) is known.
  const reviewed = async ($: any) => {
    await $.prompt.submit(COMPOSER('fix'))
    await $.classic.Stop(SESSION)
  }

  test('the transcript tool is registered deferred, after the entries tool', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registeredTools[1]).toMatchObject({ name: 'transcript', isDeferred: true, inputSchema: { properties: { search: { type: 'string' }, line: { type: 'integer', minimum: 1 } } } })
  })

  test('a search answers each matching line with its number and a snippet, with the characters cut before and after it', ON, async ($, on) => {
    const seen = engine(on, { run: { stdout: '12\t100\t40\t"the parser pure: no I/O in parse_line"\ntotal\t1\n' } })
    await reviewed($)
    expect(await answer($, { search: 'PURE' })).toBe('1 line matches "PURE":\nline 12: …+100 characters before the parser pure: no I/O in parse_line …+40 characters after')
    expect(last(seen).argv).toEqual(searchCommand(TRANSCRIPT_PATH, 'PURE'))
    expect(seen.conversation.transcript).toBe(TRANSCRIPT_PATH)
  })

  test('a search prints the window around its match, with the count cut on each side', ON, async ($, on) => {
    // The host returns the window: 99 characters either side of the match, the rest of the 6,006-character line counted.
    engine(on, { run: { stdout: `7\t2900\t2900\t"${'y'.repeat(99)} pure ${'y'.repeat(99)}"\ntotal\t1\n` } })
    await reviewed($)
    expect(await answer($, { search: 'pure' })).toBe(`1 line matches "pure":\nline 7: …+2900 characters before ${'y'.repeat(99)} pure ${'y'.repeat(99)} …+2900 characters after`)
  })

  test('a search shows at most ten matching lines, and says how many lines match in all', ON, async ($, on) => {
    const rows = Array.from({ length: 11 }, (_, i) => `${i + 1}\t0\t0\t"pure ${i + 1}"\n`).join('')
    engine(on, { run: { stdout: `${rows}total\t25\n` } })
    await reviewed($)
    const text: string = await answer($, { search: 'pure' })
    expect(text.split('\n')).toHaveLength(11)
    expect(text.startsWith('25 lines match "pure"; the first 10 are shown:\nline 1: pure 1\n')).toBe(true)
    expect(text).not.toContain('line 11:')
  })

  test('a term with regex and shell metacharacters is searched as the one argument it is', ON, async ($, on) => {
    const term = 'a.*(b)|$(rm -rf ~) `x`'
    const seen = engine(on, { run: { stdout: 'total\t0\n' } })
    await reviewed($)
    expect(await answer($, { search: term })).toBe(`No line of the session transcript matches "${term}".`)
    expect(last(seen).argv).toEqual(searchCommand(TRANSCRIPT_PATH, term))
    expect(last(seen).argv[0]).toBe('perl')
  })

  test('a term with a NUL is refused as a plain result, and no process runs', ON, async ($, on) => {
    const seen = engine(on, { run: { stdout: 'total\t0\n' } })
    await reviewed($)
    const runs = seen.runs.length
    expect(await answer($, { search: 'a\0b' })).toBe('search must not contain a NUL character')
    expect(seen.runs.length).toBe(runs)
  })

  test('a line without full is bounded, and the cut characters are counted after the digest', ON, async ($, on) => {
    const LONG = JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'x'.repeat(2500) } })
    const seen = engine(on, { run: { stdout: `${LONG}\n` } })
    await reviewed($)
    // The digest is 2,506 characters: 2,000 are kept, and the 506 after them are counted.
    expect(await answer($, { line: 7 })).toBe(`USER: ${'x'.repeat(1994)} …+506 characters`)
    expect(last(seen).argv).toEqual(lineCommand(TRANSCRIPT_PATH, 7))
  })

  test('a line whose digest is uncut is answered whole, with no marker', ON, async ($, on) => {
    engine(on, { run: { stdout: `${ROW_USER}\n` } })
    await reviewed($)
    expect(await answer($, { line: 3 })).toBe(DIGEST_USER)
  })

  test('a line with full returns the whole digest in pages within the page limit, each page naming the next', ON, async ($, on) => {
    const BIG = JSON.stringify({ type: 'user', message: { role: 'user', content: 'é'.repeat(25000) } })
    engine(on, { run: { stdout: `${BIG}\n` } })
    await reviewed($)
    const first: string = await answer($, { line: 7, full: true })
    expect(first.startsWith('Line 7 of the session transcript: entries 1-2 of 3\nnext page: from=3\n\n')).toBe(true)
    const second: string = await answer($, { line: 7, full: true, from: 3 })
    expect(second.startsWith('Line 7 of the session transcript: entries 3-3 of 3\n\n')).toBe(true)
    expect(bytes(first) <= 50000 && bytes(second) <= 50000).toBe(true)
    expect(first.split('é').length - 1 + (second.split('é').length - 1)).toBe(25000)
  })

  test('a line past the end of the transcript is refused as empty or past its end', ON, async ($, on) => {
    engine(on, { run: { stdout: '' } })
    await reviewed($)
    expect(await answer($, { line: 9000, full: true })).toBe('line 9000 is empty or past the end of the session transcript')
  })

  test('a line that is not JSON is refused as having no digest', ON, async ($, on) => {
    engine(on, { run: { stdout: 'not json\n' } })
    await reviewed($)
    expect(await answer($, { line: 2 })).toBe('line 2 is not valid JSON, so it has no digest')
  })

  test('a line too large to read is refused', ON, async ($, on) => {
    engine(on, { run: { stdout: '{"type":"user"', isStdoutTruncated: true } })
    await reviewed($)
    expect(await answer($, { line: 2 })).toBe('line 2 is too large to read')
  })

  test('a search and a line lookup both run under the lookup timeout', ON, async ($, on) => {
    const seen = engine(on, { run: { stdout: '' } })
    await reviewed($)
    await answer($, { search: 'pure' })
    expect(last(seen).init).toEqual({ timeoutMs: LOOKUP_TIMEOUT_MS })
    await answer($, { line: 2 })
    expect(last(seen).init).toEqual({ timeoutMs: LOOKUP_TIMEOUT_MS })
  })

  test('a lookup before any transcript path is known says so, and does not run a command', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    expect(await answer($, { search: 'pure' })).toBe(NO_TRANSCRIPT)
    expect(seen.runs).toEqual([])
  })

  test('only a reviewer is served: a worker call and another agent\'s call are refused without running a command', ON, async ($, on) => {
    const seen = engine(on)
    await reviewed($)
    expect(await ask($, { search: 'pure' })).toMatchObject({ deny: REFUSED })
    expect(await ask($, { search: 'pure' }, 'sub1')).toMatchObject({ deny: REFUSED })
    expect(seen.runs).toEqual([])
  })

  test('the transcript path is in no brief, no registered prompt and no refusal', ON, async ($, on) => {
    const seen = engine(on)
    await reviewed($)
    const refusal = await ask($, { search: 'pure' }, 'sub1')
    const shown = JSON.stringify({ registered: seen.registered, registeredTools: seen.registeredTools, spawns: seen.spawns, sends: seen.sends, refusal })
    expect(seen.spawns.length).toBe(1)
    expect(shown).not.toContain(TRANSCRIPT_PATH)
  })

  // The reviewer after the /clear is a new one: the old one's id stays a reviewer marker, and is not adopted again.
  test('a session end forgets the transcript path, and a session start that reports one again sets it', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }, { id: 'ag2', name: 'auditor-reviewer-2', type: 'auditor:reviewer', spawnedBy: 'auditor' }], run: { stdout: 'total\t0\n' } })
    await $.classic.SessionStart({ transcript_path: TRANSCRIPT_PATH } as any)
    expect(await answer($, { search: 'pure' })).toBe('No line of the session transcript matches "pure".')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect((await ask($, { search: 'pure' }, 'ag2')).result).toBe(NO_TRANSCRIPT)
    await $.classic.SessionStart({ transcript_path: NEW_PATH } as any)
    await ask($, { search: 'pure' }, 'ag2')
    expect(last(seen).argv).toEqual(searchCommand(NEW_PATH, 'pure'))
  })

  test('after a /clear the reviewer before it is refused the transcript tool: its id still marks a reviewer, so it is not adopted again', ON, async ($, on) => {
    engine(on, { agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.classic.SessionStart({ transcript_path: TRANSCRIPT_PATH } as any)
    expect(await answer($, { search: 'pure' })).toBeDefined()
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(await ask($, { search: 'pure' }, 'ag1')).toMatchObject({ deny: REFUSED })
  })

  // A failed review's notice starts a worker turn, and that turn's end dispatches the next review: here neither dispatches.
  test('a failed review\'s notice, and a turn no composer started, dispatch nothing: the record keeps the failed entries', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    otherMods(on)
    await workerTurn($)
    await mainTurnEnd($)
    await turnFailed($, 'ag1')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, TURN_FAILURE).length).toBe(1)
    await buttonReads(await mountMode($), 'failing')
    for (let i = 0; i < 3; i++) {
      await $.prompt.submit(NOTICE('Agent "auditor review" failed: 429'))
      await workerTurn($, 'Noticed.')
      await mainTurnEnd($)
    }
    await $.prompt.submit({ text: 'Another Claude session sent a message: helper done', wait: false, origin: { kind: 'peer' as const } })
    await workerTurn($)
    await mainTurnEnd($)
    expect({ spawns: seen.spawns.length, sends: seen.sends.length }).toEqual({ spawns: 1, sends: 0 })
    // The failed entry, then the peer's turn: its prompt and its reply. The notices' turns recorded nothing.
    expect(seen.conversation.record.blocks.length).toBe(3)
    await $.prompt.submit(COMPOSER('retry'))
    await workerTurn($)
    // The failed review let its reviewer go, so the retry spawns a fresh one.
    expect({ spawns: seen.spawns.length, sends: seen.sends.length }).toEqual({ spawns: 2, sends: 0 })
    expect(seen.spawns[1].prompt).toContain('Review 2. Its record holds entries 1-5,')
  })

  test('a finished notice after a successful review starts a turn that records nothing and dispatches nothing', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await mainTurnEnd($)
    await $.prompt.submit(HANDBACK('Nothing to note.'))
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.', USAGE))
    await $.prompt.submit(NOTICE('Agent "auditor review" finished'))
    await workerTurn($, 'Noticed.')
    await mainTurnEnd($)
    expect({ spawns: seen.spawns.length, sends: seen.sends.length, prompts: seen.prompts.length }).toEqual({ spawns: 1, sends: 0, prompts: 1 })
    expect(seen.conversation.record.blocks.length).toBe(0)
  })

  test('each failure of a run is logged with its reason, toasts nothing, and leaves the footer reading auditor failing', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    otherMods(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnFailed($, 'ag1')
    await $.prompt.submit(COMPOSER('retry'))
    await workerTurn($)
    expect(seen.spawns.length).toBe(2)
    // The record tool serves only an open review, so it is read while review 2 is open, before its failure.
    expect(await entriesOf($, { which: 'record' }, 'ag2')).toBe(RECORD_OF(2, 'USER: first', 'USER: retry', 'ASSISTANT: working'))
    await turnFailed($, 'ag2')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, TURN_FAILURE).length).toBe(2)
    await buttonReads(await mountMode($), 'failing')
  })

  test('a successful review ends the failing run, and the next failure is logged and reads auditor failing again', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnFailed($, 'ag1')
    await $.prompt.submit(COMPOSER('retry'))
    await workerTurn($)
    await turnFailed($, 'ag1')
    await $.prompt.submit(COMPOSER('again'))
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ui = await mountMode($)
    await buttonReads(ui, 'on')
    await $.prompt.submit(COMPOSER('next'))
    await workerTurn($)
    await turnFailed($, 'ag1')
    await buttonReads(ui, 'failing')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, TURN_FAILURE).length).toBe(3)
  })

  test('a batch of the reviewer\'s notice and a background command\'s is a normal turn: it is recorded, and its turn end dispatches', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(BATCH)
    await workerTurn($, 'Noticed.')
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].prompt).toContain('Review 1. Its record holds entries 1-2,')
  })

  test('a background command\'s notice at idle is recorded, and its turn end dispatches as any worker turn does', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(BG_NOTICE)
    await workerTurn($, 'Noticed.')
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].prompt).toContain('Review 1. Its record holds entries 1-2,')
  })

  test('a helper\'s prompt that joins a composer turn leaves it the composer\'s, so after a failure the turn\'s end dispatches', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnFailed($, 'ag1')
    await $.prompt.submit(HELPER)
    await workerTurn($)
    expect(seen.sends).toEqual([])
    expect(seen.spawns[1].prompt).toContain('Review 2. Its record holds entries 1-3,')
  })

  test('a composer prompt typed into a notice turn starts the record there, so the review covers what follows', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(NOTICE('Agent "auditor review" finished'))
    await $.prompt.submit(COMPOSER('typed mid-turn'))
    await workerTurn($, 'Done.')
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].prompt).toContain('Review 1. Its record holds entries 1-2,')
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: typed mid-turn', 'ASSISTANT: working'))
  })

  test('a refused send spawns a new reviewer in the same dispatch, and toasts nothing', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1' })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await $.prompt.submit(COMPOSER('second'))
    await workerTurn($)
    expect(seen.sends.length).toBe(1)
    expect(seen.spawns.length).toBe(2)
    expect(seen.toasts).toEqual([])
  })

  test('a /clear ends a failure run: the next worker turn end dispatches to a new reviewer, and the next failure is logged again', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(HELPER)
    await workerTurn($)
    await turnFailed($, 'ag1')
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, TURN_FAILURE).length).toBe(1)
    const ui = await mountMode($)
    await buttonReads(ui, 'failing')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await buttonReads(ui, 'on')
    await workerTurn($)
    expect(seen.spawns.length).toBe(2)
    await turnFailed($, 'ag1')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, TURN_FAILURE).length).toBe(2)
    await buttonReads(ui, 'failing')
  })
})

describe('the reviewer\'s task rows', () => {
  const TASK_ROW = (text: string, origin: { kind: 'task-notification' } | { kind: 'composer' } | { kind: 'plugin'; name: string }, task: { id?: string; status?: string } | undefined, isExpanded = false) => ({ text, origin, isExpanded, task })
  const DRAWN = 'drawn by Claude Code'
  const FINISHED = 'Agent "auditor review" finished'

  test('the reviewer\'s task row is not drawn unless the transcript is expanded, whatever its status; other rows draw', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on, DRAWN)
    await workerTurn($)
    const mount = (props: ReturnType<typeof TASK_ROW>) => $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'UserMessage', props })
    expect(await (await mount(TASK_ROW(FINISHED, { kind: 'task-notification' }, { id: 'ag1', status: 'completed' }))).find({ type: 'Text', text: DRAWN })).toBeUndefined()
    expect(await (await mount(TASK_ROW(FINISHED, { kind: 'task-notification' }, { id: 'ag1', status: 'completed' }, true))).find({ type: 'Text', text: DRAWN })).toBeDefined()
    expect(await (await mount(TASK_ROW('Agent "auditor review" failed: 429', { kind: 'task-notification' }, { id: 'ag1', status: 'failed' }))).find({ type: 'Text', text: DRAWN })).toBeUndefined()
    expect(await (await mount(TASK_ROW('Agent "auditor review" stopped', { kind: 'task-notification' }, { id: 'ag1', status: 'stopped' }))).find({ type: 'Text', text: DRAWN })).toBeUndefined()
    expect(await (await mount(TASK_ROW('Agent "bg" finished', { kind: 'task-notification' }, { id: 'bg1', status: 'completed' }))).find({ type: 'Text', text: DRAWN })).toBeDefined()
    expect(await (await mount(TASK_ROW('hello', { kind: 'composer' }, undefined))).find({ type: 'Text', text: DRAWN })).toBeDefined()
    expect(seen.spawns.length).toBe(1)
  })

  test('a prompt row of the auditor\'s own origin is drawn, expanded or not; another plugin\'s prompt row draws too', ON, async ($, on) => {
    engine(on)
    otherMods(on, DRAWN)
    const mount = (props: ReturnType<typeof TASK_ROW>) => $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'UserMessage', props })
    const NOTE_ROW = 'auditor, review 1:\na.ts:4 swallows it.'
    expect(await (await mount(TASK_ROW(NOTE_ROW, { kind: 'plugin', name: 'auditor' }, undefined))).find({ type: 'Text', text: DRAWN })).toBeDefined()
    expect(await (await mount(TASK_ROW(NOTE_ROW, { kind: 'plugin', name: 'auditor' }, undefined, true))).find({ type: 'Text', text: DRAWN })).toBeDefined()
    expect(await (await mount(TASK_ROW('#3 is done: Pick a db', { kind: 'plugin', name: 'human-plugin' }, undefined))).find({ type: 'Text', text: DRAWN })).toBeDefined()
  })

  test('a respawned reviewer\'s finished row is not drawn either: every reviewer this conversation spawned is hidden', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    otherMods(on, DRAWN)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await $.prompt.submit(COMPOSER('second'))
    await workerTurn($)
    await $.prompt.submit(COMPOSER('third'))
    await workerTurn($)
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewerIds).toEqual(['ag1', 'ag2'])
    const mount = (props: ReturnType<typeof TASK_ROW>) => $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'UserMessage', props })
    expect(await (await mount(TASK_ROW(FINISHED, { kind: 'task-notification' }, { id: 'ag1', status: 'completed' }))).find({ type: 'Text', text: DRAWN })).toBeUndefined()
    expect(await (await mount(TASK_ROW(FINISHED, { kind: 'task-notification' }, { id: 'ag2', status: 'completed' }))).find({ type: 'Text', text: DRAWN })).toBeUndefined()
    expect(await (await mount(TASK_ROW('Agent "bg" finished', { kind: 'task-notification' }, { id: 'bg1', status: 'completed' }))).find({ type: 'Text', text: DRAWN })).toBeDefined()
  })
})

describe('the session mode button', () => {
  test('the footer shows auditor on by default, on the terminal and the desktop app', ON, async ($, on) => {
    engine(on)
    otherMods(on)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountMode($, surface)
      await buttonReads(ui, 'on')
      await ui.unmount()
    }
  })

  test('Claude Code\'s mode labels still appear beside the button, with a dim separator', ON, async ($, on) => {
    engine(on)
    otherMods(on, 'auto mode on')
    const ui = await mountMode($)
    expect(await ui.find({ type: 'Text', text: 'auto mode on' })).toBeDefined()
    expect(await separated(ui)).toBe(true)
    await buttonReads(ui, 'on')
  })

  test('Claude Code\'s own drawing of its mode labels, with no mod beneath, is separated from the button', ON, async ($, on) => {
    engine(on)
    coreDraws(on)
    const ui = await mountMode($)
    expect(await separated(ui)).toBe(true)
    await buttonReads(ui, 'on')
  })

  test('Claude Code\'s own drawing with no mode label, and no mod beneath, leaves the button alone', ON, async ($, on) => {
    engine(on)
    coreDraws(on)
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    expect(await separated(ui)).toBe(false)
    await buttonReads(ui, 'on')
  })

  test('a Markdown label drawn beneath, whose words are in its props, is separated from the button', ON, async ($, on) => {
    engine(on)
    on('ui.render', () => ({ type: 'Markdown', props: { text: '**plan** mode' } }))
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    expect(await separated(ui)).toBe(true)
    await buttonReads(ui, 'on')
  })

  test('with nothing drawn beneath it, the button stands alone, with no separator leading it', ON, async ($, on) => {
    engine(on)
    otherMods(on, '')
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    await buttonReads(ui, 'on')
    expect(await separated(ui)).toBe(false)
  })

  test('a label drawn beneath the button, with no mode label of Claude Code\'s own, is separated from it, never glued', ON, async ($, on) => {
    engine(on)
    otherMods(on, 'cache ▰▰▰▰▱ 3:12')
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('"children":["cache ▰▰▰▰▱ 3:12"]')).toBeLessThan(drawn.indexOf('"children":[" · "]'))
    expect(drawn.indexOf('"children":[" · "]')).toBeLessThan(drawn.indexOf('"label":"auditor on"'))
    await buttonReads(ui, 'on')
  })

  test('pressing the button turns the reviewer off: a worker turn end dispatches nothing, and a tool call is not recorded', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await buttonReads(ui, 'off')
    await $.tool.call(WORKER_CALL('Bash', { command: 'pwd' }))
    await workerTurn($)
    expect(seen.conversation.off).toBe(true)
    expect(seen.spawns.length).toBe(0)
    expect(seen.sends.length).toBe(0)
    expect(seen.conversation.record.blocks.length).toBe(2)
  })

  test('pressing again turns the reviewer on: the next turn end dispatches a review whose record holds only the entries after the press', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('before off'))
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await buttonReads(ui, 'off')
    await $.prompt.submit(COMPOSER('while off'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await ui.press({ key: 'auditor-toggle' })
    await buttonReads(ui, 'on')
    await $.prompt.submit(COMPOSER('after on'))
    await workerTurn($)
    expect(seen.spawns.length).toBe(1)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: after on', 'ASSISTANT: working'))
  })

  test('pressing the button off and on ends a failure run: a helper\'s turn end dispatches again', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(HELPER)
    await workerTurn($)
    await turnFailed($, 'ag1')
    await mainTurnEnd($)
    expect({ sends: seen.sends.length, toasts: seen.toasts }).toEqual({ sends: 0, toasts: [] })
    const ui = await mountMode($)
    await buttonReads(ui, 'failing')
    await ui.press({ key: 'auditor-toggle' })
    await buttonReads(ui, 'off')
    await ui.press({ key: 'auditor-toggle' })
    await buttonReads(ui, 'on')
    await $.prompt.submit(HELPER)
    await workerTurn($)
    // Off let the reviewer go, so the review goes to a fresh one.
    expect(seen.sends.length).toBe(0)
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain('Review 2. Its record holds entries 1-2,')
  })

  test('a /clear keeps the reviewer off: the next worker turn end dispatches no review, and the button still reads off', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('before off'))
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await $.prompt.submit(COMPOSER('after the clear'))
    await workerTurn($)
    expect(seen.spawns.length).toBe(0)
    await buttonReads(ui, 'off')
  })

  test('a review in flight when the reviewer is turned off is dropped: its late turn end settles nothing, and no review is chained after it', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await step($, 'working')
    expect(seen.spawns.length).toBe(1)
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.sends.length).toBe(0)
    expect(seen.spawns.length).toBe(1)
  })

  test('pressing the button clears the stall guard: after a stall note, the next stop states a stall fact again', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop({ ...stop, background_tasks: [], session_crons: [] })
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'Stalled: you said you would update the config and ended the turn; nothing will wake you.')
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await ui.press({ key: 'auditor-toggle' })
    expect(seen.conversation.dispatchesAtPrompt).toBe(1)
    await $.prompt.submit(HELPER)
    await $.classic.Stop({ ...stop, background_tasks: [], session_crons: [] })
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain('Nothing will wake the worker:')
  })

  test('the band above the prompt draws nothing from this mod', ON, async ($, on) => {
    engine(on)
    otherMods(on, 'human-plugin: 2 open')
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
    expect(await ui.find({ key: 'auditor-toggle' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'auditor reviewer: on' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'human-plugin: 2 open' })).toBeDefined()
  })

  test('turning the reviewer off stops a review in flight at once: the reviewer is stopped, its review is logged incomplete, and its late note reaches no one', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await busyWorker($)
    expect(seen.spawns.length).toBe(1)
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'the auditor was switched off' })
    // Its review was dropped, so the note it sends under its own number is refused.
    expect(await noteSent($, 'Escalation: a.ts:4 cut off.', 'ag1', 1)).toMatchObject({ isDelivered: false })
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([])
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(seen.toasts).toEqual([])
    expect(seen.spawns.length).toBe(1)
  })

  test('/auditor off stops a review in flight the same way', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(await noteSent($, 'a.ts:4 cut off.', 'ag1', 1)).toMatchObject({ isDelivered: false })
    await mainTurnEnd($)
    expect(toMain(seen)).toEqual([])
  })

  test('a note let through before the reviewer is turned off that arrives after it reaches the worker, and the new epoch carries nothing of it', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    const sending = noteSent($, `Escalation: ${STALL_NOTE}`)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    expect(await sending).toEqual({ isDelivered: true })
    const arrived = ARRIVED(1, `Escalation: ${STALL_NOTE}`)
    await $.prompt.submit(arrived)
    expect(seen.prompts).toEqual(['fix the parser', arrived.text])
    expect(seen.conversation).toMatchObject({ memory: [], nudged: false })
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', note: `Escalation: ${STALL_NOTE}`, note_delivered: false })
  })

  test('a note let through before a /clear that arrives after it reaches the worker, and the new conversation carries nothing of it', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const sending = noteSent($, 'a.ts:4 before the clear.')
    await reached.until
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    release.open()
    expect(await sending).toEqual({ isDelivered: true })
    await $.prompt.submit(ARRIVED(1, 'a.ts:4 before the clear.'))
    expect(seen.conversation.memory).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', note: 'a.ts:4 before the clear.', note_delivered: false })
  })

  test('turning the reviewer off with no review open stops the idle reviewer and logs nothing', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete' })
  })

  test('a reviewer whose spawn lands after the reviewer is turned off is not adopted by its tool call, and is stopped', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    const ending = workerTurn($)
    await held.reached
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect((await $.tool.call({ tool: ENTRIES, agentId: 'ag1', which: 'record' })).deny).toBe(REFUSED)
    held.land()
    await ending
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
  })

  test('a reviewer whose spawn lands after the reviewer is turned off and on again is stopped, and the next review goes to a fresh one', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold })
    const ending = workerTurn($)
    await held.reached
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    held.land()
    await ending
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
    await workerTurn($)
    expect(seen.sends.length).toBe(0)
    expect(seen.spawns.length).toBe(2)
  })

  test('after the reviewer is turned off and on, a dispatch does not wait for a spawn still in flight: the next turn end spawns its reviewer at once', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { reviewerIds: ['ag2'], spawnHold: { to: 1, until: release.until, reached: reached.open, result: { model: 'm', agentId: 'ag1' } } })
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain('Review 2.')
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    release.open()
    await ending
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  // Two spawns in flight across a /clear: each carries the epoch it was planned in, so the first to land is judged by the epoch it was made in, not by arrival order.
  test('a /clear mid-spawn, then a second spawn that lands before the first: the second is the reviewer, the first is stopped, and the next review goes to the second', ON, async ($, on) => {
    const firstLands = gate()
    const secondLands = gate()
    const firstReached = gate()
    const secondReached = gate()
    const seen = engine(on, {
      spawnHold: [
        { until: firstLands.until, reached: firstReached.open, result: { model: 'm', agentId: 'ag1' } },
        { until: secondLands.until, reached: secondReached.open, result: { model: 'm', agentId: 'ag2' } },
      ],
    })
    const first = workerTurn($)
    await firstReached.until
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    const second = workerTurn($, 'Second.')
    await secondReached.until
    secondLands.open()
    await second
    firstLands.open()
    await first
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', number: 2 })
    await workerTurn($, 'Third.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag2'])
    expect(seen.sends[0].text).toContain('Review 3.')
  })

  test('a /clear mid-spawn, then a second spawn that lands after the first: the first is stopped as it lands, the second is the reviewer, and the next review goes to the second', ON, async ($, on) => {
    const firstLands = gate()
    const secondLands = gate()
    const firstReached = gate()
    const secondReached = gate()
    const seen = engine(on, {
      spawnHold: [
        { until: firstLands.until, reached: firstReached.open, result: { model: 'm', agentId: 'ag1' } },
        { until: secondLands.until, reached: secondReached.open, result: { model: 'm', agentId: 'ag2' } },
      ],
    })
    const first = workerTurn($)
    await firstReached.until
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    const second = workerTurn($, 'Second.')
    await secondReached.until
    firstLands.open()
    await first
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    secondLands.open()
    await second
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', number: 2 })
    await workerTurn($, 'Third.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag2'])
    expect(seen.sends[0].text).toContain('Review 3.')
  })

  test('a /clear mid-spawn: the spawn calling the entries tool before it lands is not adopted, and is stopped as it lands', ON, async ($, on) => {
    const firstLands = gate()
    const firstReached = gate()
    const seen = engine(on, {
      spawnHold: [{ until: firstLands.until, reached: firstReached.open, result: { model: 'm', agentId: 'ag1' } }],
      agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }],
    })
    const first = workerTurn($)
    await firstReached.until
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'ag1', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(seen.conversation.reviewer).toBeUndefined()
    firstLands.open()
    await first
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.spawnsInFlight).toEqual([])
  })

  test('a spawn that lands after the epoch moved, with no agent id and no review open, leaves its brief out of flight, so the worker\'s identical send is recorded', ON, async ($, on) => {
    const lands = gate()
    const reached = gate()
    const seen = engine(on, { spawnHold: { to: 1, until: lands.until, reached: reached.open, result: { model: 'm' } } })
    const ending = workerTurn($)
    await reached.until
    const brief: string = seen.spawns[0].prompt
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(seen.conversation.review).toBeUndefined()
    lands.open()
    await ending
    await drained()
    expect(seen.conversation.briefsInFlight).toEqual([])
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await $.tool.call({ tool: 'SendMessage', to: 'ag1', message: brief } as any)
    expect(seen.conversation.record.blocks.at(-1)).toContain('TOOL SendMessage(')
  })

  test('a spawn whose result names no agent, after its reviewer was adopted by name, keeps that reviewer and its review open', ON, async ($, on) => {
    const lands = gate()
    const reached = gate()
    const seen = engine(on, {
      spawnHold: { to: 1, until: lands.until, reached: reached.open, result: { model: 'm' } },
      agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }],
    })
    const ending = workerTurn($)
    await reached.until
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'ag1', which: 'record' })).not.toMatchObject({ deny: REFUSED })
    lands.open()
    await ending
    await drained()
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(seen.conversation.review).toMatchObject({ number: 1 })
    expect(seen.conversation.failing).toBeUndefined()
    expect(seen.stops).toEqual([])
  })

  test('a spawn held past ten minutes after a /clear no longer blocks adoption by name of a later reviewer, and when it lands it is stopped and is not the reviewer', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'ag2', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    seen.clock += TEN_MINUTES + 1
    try {
      expect(await entriesOf($, { which: 'record' }, 'ag2')).toBe(NO_REVIEW)
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    } finally {
      held.land()
    }
    await stopping
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
  })

  test('a stale spawn whose agent was adopted by name in the current epoch is not stopped, and stays the reviewer', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    const first = workerTurn($)
    await held.reached
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    seen.clock += TEN_MINUTES + 1
    try {
      expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(NO_REVIEW)
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    } finally {
      held.land()
    }
    await first
    await drained()
    expect(seen.stops).toEqual([])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
  })

  test('an older spawn still in flight blocks adoption by name unless its hook named another id or it is past ten minutes', ON, async ($, on) => {
    const agents = [{ id: 'agY', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }]
    const older = (extra: object) => ({ epoch: 1, spawnsInFlight: [{ brief: 'b', epoch: 0, number: 1, startedAt: 1000, ...extra }] })
    const blocked = engine(on, { agents, stateSeed: older({}) })
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'agY', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(blocked.conversation?.reviewer).toBeUndefined()
  })

  test('an older spawn whose hook named another id blocks no adoption by name', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'agY', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }], stateSeed: { epoch: 1, spawnsInFlight: [{ brief: 'b', epoch: 0, number: 1, startedAt: 1000, id: 'agX' }] } })
    expect(await entriesOf($, { which: 'record' }, 'agY')).toBe(NO_REVIEW)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'agY' })
  })

  test('an older spawn past ten minutes blocks no adoption by name', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'agY', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }], stateSeed: { epoch: 1, spawnsInFlight: [{ brief: 'b', epoch: 0, number: 1, startedAt: 1000 }] } })
    seen.clock += TEN_MINUTES + 1
    expect(await entriesOf($, { which: 'record' }, 'agY')).toBe(NO_REVIEW)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'agY' })
  })

  test('a spawn held past ten minutes with no reset fails its review at the next turn end, which logs that review incomplete and dispatches a new one', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: { ...held.hold, to: 1 } })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    seen.clock += TEN_MINUTES + 1
    try {
      await $.prompt.submit(COMPOSER('again'))
      await $.classic.Stop(stop)
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', number: 1, reason: 'reviewer spawn did not settle in 10 minutes' })
      expect(JSON.stringify(seen.logs)).toContain('review failed: reviewer spawn did not settle in 10 minutes')
      expect(seen.spawns.filter(sp => typeOf(sp) === 'auditor:reviewer').length).toBe(2)
    } finally {
      held.land()
    }
    await stopping
    await drained()
  })



  test('a spawn given up after its review settled does not fail the auditor when it lands, while the next review is open', ON, async ($, on) => {
    const lands = gate()
    const reached = gate()
    const seen = engine(on, {
      spawnHold: { to: 1, until: lands.until, reached: reached.open, result: { model: 'm', agentId: 'ag1' } },
      reviewerIds: ['ag2'],
      sendFails: 'ag1',
      agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }],
    })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await reached.until
    await entriesOf($, { which: 'live' })
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    const hand = HANDBACK('a.ts:4 swallows it.')
    await $.prompt.submit(hand)
    await $.turn.complete(TURN_END('ag1', REPORT(hand), USAGE))
    await drained()
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', number: 1 })
    seen.clock += TEN_MINUTES + 1
    await $.prompt.submit(COMPOSER('again'))
    await $.classic.Stop(stop)
    await drained()
    expect(seen.conversation.review).toMatchObject({ number: 2 })
    lands.open()
    await stopping
    await drained()
    expect(seen.conversation.failing).toBeUndefined()
  })


  test('a late hook for a spawn whose review was given up stands nothing in while another reviewer spawn is in flight unnamed', ON, async ($, on) => {
    const aLands = gate()
    const aReached = gate()
    const bLands = gate()
    const bReached = gate()
    const seen = engine(on, {
      spawnHold: [
        { until: aLands.until, reached: aReached.open, result: { model: 'm', agentId: 'agA' } },
        { until: bLands.until, reached: bReached.open, result: { model: 'm', agentId: 'agB' } },
      ],
    })
    await $.prompt.submit(COMPOSER('fix'))
    const first = $.classic.Stop(stop)
    await aReached.until
    seen.clock += TEN_MINUTES + 1
    await $.prompt.submit(COMPOSER('again'))
    const second = $.classic.Stop(stop)
    await bReached.until
    aLands.open()
    await first
    await drained()
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.spawnsInFlight.map((s: { id?: string }) => s.id)).toEqual([undefined])
    bLands.open()
    await second
    await drained()
    expect(seen.conversation.reviewer).toMatchObject({ id: 'agB' })
  })

  test('a note whose send fails below the gate after its review has closed leaves the next review\'s note slot as it was', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open }, noteFailsAt: [1] })
    await workerTurn($)
    await step($, 'working')
    const sending = noteSent($, 'a.ts:4 first.')
    await reached.until
    // The slot is filled, so the turn end completes review 1 with it and the idle worker's next review goes out.
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(await noteSent($, 'b.ts:1 second.')).toEqual({ isDelivered: true })
    release.open()
    expect(await sending).toMatchObject({ isDelivered: false })
    expect(seen.conversation.review).toMatchObject({ number: 2, note: 'b.ts:1 second.' })
    expect(seen.conversation.memory).toEqual([{ number: 2, text: 'b.ts:1 second.' }])
  })

  test('a spawn that never settles, then the reviewer turned off and on: the next turn end dispatches again', ON, async ($, on) => {
    // The held spawn is let land at the end: a call left pending is aborted by the engine when the test's own 5 s run out, in whichever later test is running then, and its dispatch's failure handling writes that test's state.
    const release = gate()
    const reached = gate()
    const seen = engine(on, { spawnHold: { to: 1, until: release.until, reached: reached.open } })
    const first = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    release.open()
    await first
    await drained()
  })

  test('a spawn that lands with no agent id after the reviewer is turned off and on stops no reviewer: the next turn end\'s review reaches a live one', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { reviewerIds: ['ag2'], spawnHold: { to: 1, until: release.until, reached: reached.open, result: { model: 'm' } } })
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    release.open()
    await ending
    await drained()
    await workerTurn($, 'Third.')
    expect(seen.spawns.length).toBe(2)
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', number: 2 })
    expect(seen.stops).toEqual([])
  })

  test('a spawn that lands after the next reviewer\'s, once the reviewer is turned off and on, does not displace that reviewer: the next turn end\'s review reaches a live one', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { reviewerIds: ['ag2'], spawnHold: { to: 1, until: release.until, reached: reached.open, result: { model: 'm', agentId: 'ag1' } } })
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    release.open()
    await ending
    await drained()
    await workerTurn($, 'Third.')
    expect(seen.spawns.length).toBe(2)
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', number: 2 })
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a note delivered while the reviewer is turned off and on again books nothing in the new epoch', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    const sending = noteSent($, STALL_NOTE)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    release.open()
    expect(await sending).toEqual({ isDelivered: true })
    expect(seen.conversation).toMatchObject({ memory: [], nudged: false })
  })

  test('a brief whose send is refused after the reviewer is turned off spawns no reviewer', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { sendFails: 'ag1', sendHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    await ending
    expect(seen.spawns.length).toBe(1)
    expect(seen.conversation.briefsInFlight.filter((b: string) => b.includes('Review 2.'))).toEqual([])
    expect(seen.conversation.reviewer).toBeUndefined()
  })

  test('a brief whose send is refused after the reviewer is turned off and on again spawns no reviewer for the dropped review', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { sendFails: 'ag1', sendHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    release.open()
    await ending
    expect(seen.spawns.length).toBe(1)
    expect(seen.conversation.briefsInFlight.filter((b: string) => b.includes('Review 2.'))).toEqual([])
  })

  test('a brief whose send is refused after the reviewer is turned off stops that refused reviewer again, and spawns no reviewer', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { sendFails: 'ag1', sendHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    release.open()
    await ending
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
    expect(seen.spawns.length).toBe(1)
  })

  test('a brief delivered to the stored reviewer after the reviewer is turned off stops that reviewer again, so the brief runs no review', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { sendHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ending = workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    release.open()
    await ending
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
    expect(seen.spawns.length).toBe(1)
  })

  test('a delivered brief whose epoch re-check cannot read is logged, and its review stays open and not failing', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const opts: Opts = { sendHold: { until: release.until, reached: reached.open } }
    const seen = engine(on, opts)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ending = workerTurn($)
    await reached.until
    opts.stateFails = 'conversation'
    release.open()
    await ending
    expect(seen.conversation.review).toMatchObject({ number: 2 })
    expect(seen.conversation.failing).toBeUndefined()
    expect(debugLines(seen, 'reviewer send bookkeeping failed').length).toBe(1)
  })

  test('turning the reviewer on stops nothing', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await workerTurn($)
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await ui.press({ key: 'auditor-toggle' })
    expect(seen.stops.length).toBe(1)
  })

  test('after the reviewer is turned off and on, the reviewer it let go is refused, and the fresh reviewer\'s note goes through', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    otherMods(on)
    await busyWorker($)
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await ui.press({ key: 'auditor-toggle' })
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await $.classic.Stop(stop)
    expect(await noteSent($, 'a.ts:4 stale.', 'ag1', 1)).toMatchObject({ isDelivered: false })
    await turnEnded($, 'ag2', 'b.ts:1 second.')
    expect(toMain(seen)).toEqual([FRAMED(2, 'b.ts:1 second.')])
  })
})

describe('reviewer traffic', () => {
  // The agent list's entry for the reviewer: its deliveries carry this name as their teammate.
  const LISTED = [{ id: 'ag1', name: 'auditor-reviewer' }]
  // A delivery the team's mailbox carries from `teammate`, by default its end-of-run notice as measured live; `isVerified` says whether the harness wrote the entry.
  const MAILED = (teammate: string, isVerified: boolean, text = END_NOTICE(teammate)) => ({ text, origin: { kind: 'peer' as const, teammate, isVerified } })

  test('a delivery from the reviewer is consumed once its spawn is listed: the engine never sees it and no prompt is submitted', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    expect(await $.session.receive(MAILED('auditor-reviewer', true))).toEqual(CONSUMED)
    expect(seen.received).toEqual([])
    expect(seen.prompts).toEqual([])
  })

  test('a renamed reviewer is known by the name the agent list gives it: its deliveries are consumed, and the old name\'s pass on', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'ag1', name: 'auditor-reviewer-2' }] })
    await workerTurn($)
    expect(await $.session.receive(MAILED('auditor-reviewer-2', true))).toEqual(CONSUMED)
    const old = MAILED('auditor-reviewer', true)
    expect(await $.session.receive(old)).toEqual({ text: old.text })
    expect(seen.received.map(e => e.text)).toEqual([old.text])
  })

  test('a reviewer whose spawn lookup failed is named by a later agent list: its verified delivery is consumed, a reviewer-shaped name on another id passes on, and a helper is not looked up', ON, async ($, on) => {
    // The Stop's read is the first list call, so the spawn lookup is the second.
    const seen = engine(on, { listFailsAt: 2, agents: [{ id: 'ag1', name: 'auditor-reviewer-3' }, { id: 'sub9', name: 'auditor-reviewer-9' }] })
    await workerTurn($)
    expect(seen.conversation.reviewerNames).toEqual(['auditor-reviewer'])
    expect(await $.session.receive(MAILED('auditor-reviewer-3', true))).toEqual(CONSUMED)
    expect(seen.conversation.reviewerNames).toEqual(['auditor-reviewer', 'auditor-reviewer-3'])
    const other = MAILED('auditor-reviewer-9', true)
    expect(await $.session.receive(other)).toEqual({ text: other.text })
    expect(seen.conversation.reviewerNames).not.toContain('auditor-reviewer-9')
    const helper = MAILED('helper', true)
    const lists = seen.listCalls
    expect(await $.session.receive(helper)).toEqual({ text: helper.text })
    expect(seen.listCalls).toBe(lists)
    expect(seen.received.map(e => e.text)).toEqual([other.text, helper.text])
  })

  test('an unverified delivery is not the reviewer\'s, though it names it: it passes on unchanged', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    const unverified = MAILED('auditor-reviewer', false)
    expect(await $.session.receive(unverified)).toEqual({ text: unverified.text })
    expect(seen.received.map(e => e.text)).toEqual([unverified.text])
  })

  test('a delivery with no teammate is not the reviewer\'s, though its body names it: it passes on unchanged', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    const named = { text: 'Another Claude session sent a message: auditor-reviewer finished\na.ts:4 swallows it.', origin: { kind: 'peer' as const } }
    expect(await $.session.receive(named)).toEqual({ text: named.text })
    expect(seen.received.map(e => e.text)).toEqual([named.text])
  })

  test('a delivery from another teammate passes on unchanged', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    const helper = MAILED('helper', true)
    expect(await $.session.receive(helper)).toEqual({ text: helper.text })
    expect(seen.received.map(e => e.text)).toEqual([helper.text])
  })

  test('a delivery that carries an agent id passes on unchanged, even from the reviewer', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    const toAgent = { ...MAILED('auditor-reviewer', true), agentId: 'sub1' }
    expect(await $.session.receive(toAgent)).toEqual({ text: toAgent.text })
    expect(seen.received.map(e => e.text)).toEqual([toAgent.text])
  })

  test('an end-of-run notice after its review settled is consumed and logged, and the review log records nothing for it', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const written = seen.writes.length
    expect(await $.session.receive(MAILED('auditor-reviewer', true))).toEqual(CONSUMED)
    expect(seen.writes.length).toBe(written)
    expect(debugLines(seen, 'consumed the end-of-run notice of reviewer auditor-reviewer').length).toBe(1)
    expect(seen.prompts).toEqual([])
  })

  test('a known reviewer\'s verified delivery that is not its end-of-run notice is passed on and logged to the debug log', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    for (const text of ['[Subagent hand-back] auditor-reviewer done\na.ts:4 x.', 'a.ts:4 swallows it.', '{"type":"shutdown_request"}', '{not json']) {
      expect(await $.session.receive(MAILED('auditor-reviewer', true, text))).toEqual({ text })
    }
    expect(seen.received.length).toBe(4)
    expect(debugLines(seen, 'a delivery from reviewer auditor-reviewer that is not its end-of-run notice was passed on').length).toBe(4)
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete' })
  })

  test('no end-of-run notice of any reviewer the plugin spawned reaches the worker: a retired one\'s, a stopped one\'s, and one arriving after a /clear', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2', 'ag3'], agents: [{ id: 'ag1', name: 'auditor-reviewer' }, { id: 'ag2', name: 'auditor-reviewer-2' }, { id: 'ag3', name: 'auditor-reviewer-3' }] })
    await workerTurn($)
    // The first reviewer is let go by a switch off and on, so the next review goes to a second one.
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await workerTurn($)
    for (const name of ['auditor-reviewer', 'auditor-reviewer-2', 'auditor-reviewer-3']) expect(await $.session.receive(MAILED(name, true))).toEqual(CONSUMED)
    expect(seen.received).toEqual([])
    expect(seen.prompts).toEqual([])
  })

  test('a verified delivery from an unknown name shaped like a reviewer\'s is consumed while the agent list rejects', ON, async ($, on) => {
    const seen = engine(on, { listFails: true })
    await workerTurn($)
    expect(await $.session.receive(MAILED('auditor-reviewer-3', true))).toEqual(CONSUMED)
    expect(seen.received).toEqual([])
  })

  test('a verified delivery from a teammate with a name no reviewer has passes on, and no agent list is read for it', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    const lists = seen.listCalls
    const helper = MAILED('auditor-reviewer-x', true)
    expect(await $.session.receive(helper)).toEqual({ text: helper.text })
    expect(seen.listCalls).toBe(lists)
    expect(seen.received.map(e => e.text)).toEqual([helper.text])
  })
})

describe('the note gate', () => {
  // A body no log line may carry.
  const SECRET = 'a.ts:4 SECRET-BODY.'
  // What a refused send shows the user: nothing, and no line.
  const showsNothing = (seen: any) => {
    expect(toMain(seen)).toEqual([])
    expect(seen.toasts).toEqual([])
    expect(seen.prompts).toEqual([])
    expect(seen.appends).toEqual([])
    expect(transcriptLines(seen)).toEqual([])
    expect(seen.logs.filter((line: { text: string }) => line.text.includes('SECRET-BODY'))).toEqual([])
  }

  test('each send the gate refuses comes back with its reason, logs the reason and its review number but never its body, and shows the user nothing', ON, async ($, on) => {
    const cases: [string, any, string, string][] = [
      ['the quiet status', SEND(1, 'Nothing to note.'), 'a quiet review sends nothing', '(review 1)'],
      ['an empty body', SEND(1, ' \n\t'), 'nothing after its review line', '(review 1)'],
      ['a whitespace-only body after the line on its first line', { ...SEND(1, ''), text: 'auditor, review 1:   ' }, 'nothing after its review line', '(review 1)'],
      ['no review line', { ...SEND(1, ''), text: SECRET }, 'auditor, review N:', 'a reviewer send was refused'],
      ['another review\'s number', SEND(2, SECRET), 'review 2 is not the open review', '(review 2)'],
      ['an address other than main', SEND(1, SECRET, 'ag1', 'team-lead'), '"main" only', '(review 1)'],
      ['a stall note from a review whose brief did not say nothing wakes the worker', SEND(1, `Stalled: ${SECRET}`), 'sends no "Stalled:" note', '(review 1)'],
    ]
    const seen = engine(on)
    await workerTurn($)
    seen.logs.length = 0
    for (const [what, send, reason, logged] of cases) {
      const sent = await $.session.send(send)
      expect({ what, isDelivered: sent.isDelivered }).toEqual({ what, isDelivered: false })
      expect(sent.reason).toContain(reason)
      expect(debugLines(seen, logged).length).toBe(1)
      seen.logs.length = 0
    }
    showsNothing(seen)
    expect(seen.conversation.review.note).toBeUndefined()
    expect(seen.spawns.length + seen.sends.length).toBe(1)
  })

  test('with no review open, a send is refused', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const sent = await $.session.send(SEND(1, SECRET))
    expect(sent).toMatchObject({ isDelivered: false })
    expect(sent.reason).toContain('no review open')
    expect(debugLines(seen, 'a reviewer send (review 1) was refused: auditor has no review open').length).toBe(1)
    showsNothing(seen)
  })

  test('a send from a reviewer switched off, forgotten on /clear, or whose review was given up is refused: its number is not the open review\'s, or none is open', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2', 'ag3'] })
    await workerTurn($)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect((await $.session.send(SEND(1, SECRET, 'ag1'))).reason).toContain('no review open')
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await workerTurn($)
    expect(seen.conversation.review).toMatchObject({ number: 3 })
    for (const [number, agentId] of [[1, 'ag1'], [2, 'ag2']] as const) expect((await $.session.send(SEND(number, SECRET, agentId))).reason).toContain(`review ${number} is not the open review`)
    expect(seen.conversation.review.note).toBeUndefined()
    expect(toMain(seen)).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('a send from a reviewer whose spawn result has not landed is gated by the verdict: a note for another review is refused, and one for the open review is admitted', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    expect(seen.conversation.reviewer).toBeUndefined()
    expect((await $.session.send(SEND(2, SECRET, 'ag1'))).reason).toContain('review 2 is not the open review')
    expect(toMain(seen)).toEqual([])
    expect(await $.session.send(SEND(1, 'a.ts:1 idle.', 'ag1'))).toEqual({ isDelivered: true })
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:1 idle.')])
    held.land()
    await stopping
  })

  test('a second note in one review is refused, while the first is still out and after it was delivered', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const first = noteSent($, 'a.ts:4 first.')
    await reached.until
    const whileOut = await noteSent($, SECRET)
    expect(whileOut).toMatchObject({ isDelivered: false })
    expect(whileOut.reason).toContain('one note already')
    release.open()
    expect(await first).toEqual({ isDelivered: true })
    const after = await noteSent($, SECRET)
    expect(after.reason).toContain('one note already')
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 first.')])
    expect(debugLines(seen, 'a reviewer send (review 1) was refused: this review has sent its one note already').length).toBe(2)
    expect(seen.logs.filter((line: { text: string }) => line.text.includes('SECRET-BODY'))).toEqual([])
  })

  test('two notes sent at once in one review: exactly one reaches main, the other gets a refusal, and the user sees nothing of it', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const results = await Promise.all([noteSent($, 'a.ts:4 one.'), noteSent($, 'b.ts:1 two.')])
    expect(results.filter(r => r.isDelivered).length).toBe(1)
    expect(results.find(r => !r.isDelivered)?.reason).toContain('one note already')
    expect(toMain(seen).length).toBe(1)
    expect(seen.toasts).toEqual([])
    expect(seen.prompts).toEqual([])
  })

  test('a reviewer send whose state read throws is refused, nothing reaches main, and the debug log says why', ON, async ($, on) => {
    const opts: Opts = {}
    const seen = engine(on, opts)
    await workerTurn($)
    opts.stateFails = 'conversation'
    const sent = await noteSent($, SECRET, 'ag1', 1)
    expect(sent).toEqual({ isDelivered: false, reason: 'auditor could not check this message, so it was not sent' })
    expect(debugLines(seen, 'a reviewer send (review 1) was refused, since its check could not read the conversation').length).toBe(1)
    showsNothing(seen)
  })

  test('a send from the main conversation, one carrying the plugin\'s own brief, and one from a worker\'s own agent pass unchanged, and no agent list is read for any', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const lists = seen.listCalls
    const sends = [
      { to: 'helper', text: 'main conversation message', origin: { kind: 'model' as const } },
      { to: 'ag1', text: 'a brief', origin: REVIEWER_ORIGIN },
      { to: 'main', text: 'a worker subagent\'s message, with no review line', origin: { kind: 'model' as const }, agentId: 'sub1' },
      { to: 'main', text: 'another plugin\'s agent', origin: { kind: 'plugin' as const, name: 'other' }, agentId: 'ag9' },
    ]
    for (const send of sends) expect(await $.session.send(send as any)).toEqual({ isDelivered: true })
    expect(seen.listCalls).toBe(lists)
    expect([...seen.sends, ...seen.notes].slice(-sends.length).map(s => s.text)).toEqual(sends.map(s => s.text))
    expect(seen.conversation.review.note).toBeUndefined()
  })

  // A review whose brief said nothing will wake the worker, so a stall note is admitted, with an escalation sent on it that the chain below the gate then refuses or throws on.
  const unsent = async ($: any, seen: any) => {
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    const sent = await noteSent($, 'Escalation: a.ts:4 unsent.')
    expect(sent.isDelivered).toBe(false)
    expect(seen.toasts).toEqual([])
    expect(seen.toolCalls.filter((c: { tool: string }) => c.tool === 'PushNotification')).toEqual([])
    expect(seen.conversation).toMatchObject({ nudged: false, memory: [] })
    expect(seen.conversation.review.note).toBeUndefined()
  }

  test('a note the rest of the chain refuses raises no toast or push, arms no guard, enters no memory, and a resend is admitted and booked: its stall guard armed, no memory entry', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1] })
    await unsent($, seen)
    expect(debugLines(seen, 'review 1\'s note was not delivered: main is gone').length).toBe(1)
    expect(await noteSent($, STALL_NOTE)).toEqual({ isDelivered: true })
    expect(seen.conversation).toMatchObject({ nudged: true, memory: [] })
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ note: STALL_NOTE, note_delivered: true, stall: true, escalation: false })
  })

  test('a note whose send throws below the gate raises no toast or push, arms no guard, enters no memory, and is logged undelivered at the turn end', ON, async ($, on) => {
    const seen = engine(on, { noteThrows: true })
    await unsent($, seen)
    expect(debugLines(seen, 'review 1\'s note send failed').length).toBe(1)
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false })
  })

  test('a failure writing a delivered note\'s effects is logged with its stack, and a resend in that review is refused', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    // The admission is the next conversation write, and the booking the one after it.
    seen.stateWritesFailAt = seen.stateWriteAttempts + 2
    expect(await noteSent($, 'a.ts:4 delivered.')).toEqual({ isDelivered: true })
    const failed = debugLines(seen, 'review 1\'s note booking failed')
    expect(failed.length).toBe(1)
    expect(failed[0]).toMatch(/\n\s+at /)
    expect(seen.conversation.memory).toEqual([])
    expect((await noteSent($, 'a.ts:4 again.')).reason).toContain('one note already')
    expect(toMain(seen)).toEqual([FRAMED(1, 'a.ts:4 delivered.')])
  })

  test('a delivered escalation whose booking write throws still raises the toast once and the push once, and its failure is logged', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    // The admission is the next conversation write, and the booking the one after it.
    seen.stateWritesFailAt = seen.stateWriteAttempts + 2
    expect(await noteSent($, 'Escalation: auth belongs in middleware.\nWorker: handlers.')).toEqual({ isDelivered: true })
    await drained()
    const failed = debugLines(seen, 'review 1\'s note booking failed')
    expect(failed.length).toBe(1)
    expect(failed[0]).toMatch(/\n\s+at /)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(seen.toolCalls.filter((c: { tool: string }) => c.tool === 'PushNotification').map((c: { message: string }) => c.message)).toEqual(['auditor escalated: Escalation: auth belongs in middleware.'])
  })

  test('a delivered escalation raises the toast once and the push once, carrying the body\'s first line', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await noteSent($, 'Escalation: auth belongs in middleware.\nWorker: handlers.')
    await drained()
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(seen.toolCalls.filter((c: { tool: string }) => c.tool === 'PushNotification').map((c: { message: string }) => c.message)).toEqual(['auditor escalated: Escalation: auth belongs in middleware.'])
  })

  test('an escalation admitted, then switched off before its booking, still raises the toast once and the push once, and books no memory entry or stall guard', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const sending = noteSent($, 'Escalation: auth belongs in middleware.\nWorker: handlers.')
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    expect(await sending).toEqual({ isDelivered: true })
    await drained()
    expect(toMain(seen)).toEqual([FRAMED(1, 'Escalation: auth belongs in middleware.\nWorker: handlers.')])
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(seen.toolCalls.filter((c: { tool: string }) => c.tool === 'PushNotification').map((c: { message: string }) => c.message)).toEqual(['auditor escalated: Escalation: auth belongs in middleware.'])
    expect(seen.conversation).toMatchObject({ memory: [], nudged: false })
  })

  test('a state stored in the older shape reads its open review with an empty slot, not delivered; its held notes ride beside the user\'s next own prompt with no toast, push or memory entry, and its interrupt mark holds a refused note until that prompt', ON, async ($, on) => {
    const seed = { dispatches: 1, reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], review: { number: 1, record: ['USER: x'], dispatchedAt: 1, nothingWakes: false }, pendingNotes: [{ number: 0, text: 'Escalation: an old held note.', stall: true }], interrupted: true }
    const seen = engine(on, { stateSeed: seed, noteFailsAt: [1] })
    // The stored mark holds a note refused for another reason, until the user's prompt.
    expect((await noteSent($, 'a.ts:4 fresh.', 'ag1', 1)).isDelivered).toBe(false)
    expect(seen.conversation.pendingNotes).toEqual([{ number: 0, text: 'Escalation: an old held note.', stall: true }, { number: 1, text: 'a.ts:4 fresh.' }])
    expect(seen.conversation.review).not.toHaveProperty('delivered')
    await $.prompt.submit(COMPOSER('carry on'))
    expect(seen.contexts).toEqual([[`${FRAMED(0, 'Escalation: an old held note.')}\n\n${FRAMED(1, 'a.ts:4 fresh.')}`]])
    expect(seen.conversation).toMatchObject({ pendingNotes: [], interrupted: false, nudged: false })
    // The old note raised nothing and joined no memory: only the fresh note's hold booked.
    expect(seen.toasts).toEqual([])
    expect(seen.conversation.memory).toEqual([{ number: 1, text: 'a.ts:4 fresh.' }])
  })

  test('a state stored in the older shape reads its open review as having had no follow-up yet', ON, async ($, on) => {
    const seed = { dispatches: 1, reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], review: { number: 1, record: ['USER: x'], dispatchedAt: 1, nothingWakes: false } }
    const seen = engine(on, { stateSeed: seed })
    await $.turn.complete(TURN_END('ag1', FRAMED(1, 'a.ts:4 swallows it.')))
    expect(seen.sends.map(s => ({ to: s.to, text: s.text }))).toEqual([{ to: 'ag1', text: followUpText(1) }])
  })
})

describe('reviewer rotation', () => {
  const FINISHED = 'The worker finished a turn.'
  // A brief that carries these entries: the memory's rendering, a blank line, then the brief's own first line.
  const REMEMBERING = (...entries: MemoryEntry[]): string => `${renderMemory(entries)}\n\n${FINISHED}`
  // A reviewer's usage whose context is `tokens` of input, with no cache reads or writes.
  const contextOf = (tokens: number) => ({ ...USAGE, input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  // The reviewer's request, answered with `usage`. STEP_USAGE is module-level, so it is reset after the request.
  const requestWith = async ($: any, usage: unknown, agentId = 'ag1'): Promise<void> => {
    STEP_USAGE = usage
    try {
      await step($, '', agentId)
    } finally {
      STEP_USAGE = null
    }
  }
  // A worker turn the user starts, which dispatches a review at its Stop. The reviewer then makes a request, with `usage` when given, and its turn ends with `answer`, settling the review while the worker is idle.
  const reviewCycle = async ($: any, prompt: string, answer: string, usage?: unknown): Promise<void> => {
    await $.prompt.submit(COMPOSER(prompt))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    if (usage !== undefined) await requestWith($, usage)
    await turnEnded($, 'ag1', answer)
  }

  test('a reviewer whose last request held over 80,000 tokens of context is retired when its review settles, and the next dispatch spawns a new reviewer rather than sending to it', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    // Input, cache-read and cache-write tokens make the context: 80,001 here.
    await requestWith($, { ...USAGE, input_tokens: 10_000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 10_001 })
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.map(typeOf)).toEqual(['auditor:reviewer', 'auditor:reviewer'])
    expect(seen.sends.length).toBe(0)
  })

  test('a reviewer past 80,000 tokens is retired in the same state write that closes its review, and the next dispatch spawns', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    // The first write that finds no open review is the one that closes it: its reviewer and context are gone with it.
    const closing = seen.conversations.find((c, i) => i > 0 && seen.conversations[i - 1].review !== undefined && c.review === undefined)
    expect(closing?.reviewer).toBeUndefined()
    expect(closing?.reviewerContext).toBe(0)
    expect(seen.conversation.review).toBeUndefined()
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.reviewerContext).toBe(0)
    await workerTurn($, 'Second.')
    expect(seen.spawns.map(typeOf)).toEqual(['auditor:reviewer', 'auditor:reviewer'])
    expect(seen.sends.length).toBe(0)
  })

  test('a reviewer at exactly 80,000 tokens of context is kept: the next dispatch sends to it, and output tokens are not in its context', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, { ...USAGE, input_tokens: 10_000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 10_000, output_tokens: 50_000 })
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(1)
  })

  test('the context is the last request\'s: a reviewer whose last request is under the limit is kept, though an earlier request was over it', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(90_000))
    await requestWith($, contextOf(1_000))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(1)
  })

  test('the very first reviewer of a conversation, with no notes delivered, is briefed with no memory heading', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    expect(seen.spawns[0].prompt.split('\n')[0]).toBe(FINISHED)
  })

  test('a reviewer that replaces a retired one, with no notes delivered, is briefed with no memory heading', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns[1].prompt.split('\n')[0]).toBe(FINISHED)
  })

  test('a fresh reviewer is briefed with every entry of the memory, under its heading, each with its review number and text', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await reviewCycle($, 'first', 'a.ts:1 idle.')
    await reviewCycle($, 'second', 'a.ts:2 idle.', contextOf(80_001))
    // The third prompt carries the second note, so both notes are in the memory before the fresh reviewer's brief is written.
    await $.prompt.submit(COMPOSER('third'))
    await $.classic.Stop(stop)
    const lead = REMEMBERING({ number: 1, text: 'a.ts:1 idle.' }, { number: 2, text: 'a.ts:2 idle.' })
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt.slice(0, lead.length)).toBe(lead)
  })

  test('the reviewer that is kept is briefed with the whole memory too, so its re-brief carries every entry', ON, async ($, on) => {
    const seen = engine(on)
    await reviewCycle($, 'first', 'a.ts:1 idle.')
    await reviewCycle($, 'second', 'a.ts:2 idle.')
    await $.prompt.submit(COMPOSER('third'))
    await $.classic.Stop(stop)
    expect(seen.spawns.length).toBe(1)
    const lead = REMEMBERING({ number: 1, text: 'a.ts:1 idle.' }, { number: 2, text: 'a.ts:2 idle.' })
    expect(seen.sends.map(s => s.to)).toEqual(['ag1', 'ag1'])
    expect(seen.sends[0].text.startsWith(REMEMBERING({ number: 1, text: 'a.ts:1 idle.' }))).toBe(true)
    expect(seen.sends[1].text.slice(0, lead.length)).toBe(lead)
  })

  test('a brief carries a delivered note once, its body only, though the reviewer repeated the review line', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await requestWith($, contextOf(80_001))
    expect(await $.session.send({ ...SEND(1, ''), text: `${FRAMED(1, '')}\n${FRAMED(1, 'a.ts:1 idle.')}` })).toEqual({ isDelivered: true })
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    const lead = REMEMBERING({ number: 1, text: 'a.ts:1 idle.' })
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt.slice(0, lead.length)).toBe(lead)
    expect(logOf(seen, LOG_1)).toMatchObject({ note: 'a.ts:1 idle.', note_delivered: true })
  })

  test('a refused send to the stored reviewer spawns one that sends the brief as planned, memory included, and the spawn\'s Agent call is not a worker entry', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(2)
    const lead = REMEMBERING({ number: 1, text: 'a.ts:4 idle.' })
    expect(seen.spawns[1].prompt).toBe(seen.sends[0].text)
    expect(seen.spawns[1].prompt.slice(0, lead.length)).toBe(lead)
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[1].prompt, description: 'auditor review' } as any)
    expect(await entriesOf($, { which: 'live' }, 'ag2')).toBe(NONE_SINCE(2))
  })

  test('after rotation the retired reviewer\'s entries call is refused, and the new reviewer is served the record its review was dispatched with', ON, async ($, on) => {
    engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'ag1', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(await entriesOf($, { which: 'record' }, 'ag2')).toBe(RECORD_OF(2, 'ASSISTANT: working'))
    // The retired reviewer's refused call is not a worker entry.
    expect(await entriesOf($, { which: 'live' }, 'ag2')).toBe(NONE_SINCE(2))
  })

  test('a new reviewer whose spawn names no id yet is adopted under its agent-list name, and an agent under that name whose id is a retired reviewer\'s is refused', ON, async ($, on) => {
    const held = heldSpawn(2)
    const seen = engine(on, { spawnHold: held.hold, reviewerIds: ['ag1', 'ag2'], agents: [{ id: 'ag1', name: 'auditor-reviewer-2', type: 'auditor:reviewer', spawnedBy: 'auditor' }, { id: 'ag2', name: 'auditor-reviewer-2', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    const second = workerTurn($, 'Second.')
    await held.reached
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(await $.tool.call({ tool: ENTRIES, agentId: 'ag1', which: 'record' })).toMatchObject({ deny: REFUSED })
    expect(await entriesOf($, { which: 'record' }, 'ag2')).toBe(RECORD_OF(2, 'ASSISTANT: working'))
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    held.land()
    await second
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2', model: 'm' })
  })

  test('a reviewer adopted by name and retired before its spawn result lands is not stood in again by the landing', ON, async ($, on) => {
    const held = heldSpawn(1)
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    const first = workerTurn($)
    await held.reached
    expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(RECORD_OF(1, 'ASSISTANT: working'))
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.conversation.reviewer).toBeUndefined()
    held.land()
    await first
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.reviewerIds).toEqual(['ag1'])
  })

  test('a retired reviewer\'s verified end-of-run notice is still consumed', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    const late = { text: END_NOTICE('auditor-reviewer'), origin: { kind: 'peer' as const, teammate: 'auditor-reviewer', isVerified: true } }
    expect(await $.session.receive(late)).toEqual(CONSUMED)
    expect(seen.received).toEqual([])
  })

  test('a reviewer retired when its review settles with a note is stopped once, by its agent id', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, NOTE(), 'ag1')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a reviewer retired when its review settles with no note is stopped once, by its agent id', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a reviewer retired when its turn ends with no answer is stopped once, by its agent id', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await turnFailed($, 'ag1')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a reviewer retired by a failed dispatch is stopped once, by its agent id', ON, async ($, on) => {
    const seen = engine(on, { sendThrows: 'ag1', stateSeed: { reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerContext: 80_001 } })
    await workerTurn($)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a reviewer at or under the threshold is not stopped when its review settles', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_000))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.stops).toEqual([])
  })

  test('a stop the engine refuses is logged, and the next dispatch still spawns the fresh reviewer', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], stopRefuses: 'no such task' })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop')
  })

  test('a stop that returns an error is logged, and the next dispatch still spawns the fresh reviewer', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], tools: { TaskStop: { text: 'no such task', isError: true } } })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop')
  })

  test('a stop that throws is logged, and the next dispatch still spawns the fresh reviewer', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], toolThrows: 'TaskStop' })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop failed')
  })

  test('a rotation whose settle spawns the fresh reviewer makes one stop of the retired id, after that spawn; the fresh reviewer\'s later reviews make none', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    // A worker entry after the dispatch gives the settle's own dispatch a record to brief.
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
    await mainTurnEnd($)
    await requestWith($, contextOf(80_001))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 2 }])
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('the stop reaches no worker record and starts no worker turn', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await reviewCycle($, 'first', 'Nothing to note.', contextOf(80_001))
    expect(seen.stops.length).toBe(1)
    expect(JSON.stringify(seen.conversations)).not.toContain('TaskStop')
    // Only the user's own prompt is submitted: the stop starts no worker turn.
    expect(seen.prompts).toEqual(['first'])
  })

  test('a fresh reviewer whose agent id equals a retired one\'s gets the reviewer\'s tools and its reviews', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag1'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(RECORD_OF(2, 'ASSISTANT: working'))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete' })
  })

  test('a rotation whose settle spawns a fresh reviewer under the retired id makes no stop: the id is the current reviewer\'s', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag1'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
    await mainTurnEnd($)
    await requestWith($, contextOf(80_001))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.stops).toEqual([])
  })

  test('a stop that never answers holds neither the turn end nor the next dispatch', ON, async ($, on) => {
    // The held stop is answered at the end, so no call is left pending past the test (see the spawn that never settles).
    const answer = gate()
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], toolHolds: { tool: 'TaskStop', untils: [answer.until] } })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    answer.open()
    await drained()
  })

  test('a retiring settle whose dispatch throws still makes one stop of the retired id', ON, async ($, on) => {
    // The clock reads, in order: the dispatch at the first Stop, the dispatch at the worker's turn end, then the settle's turn end, the third.
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], clockFailsAt: 3 })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
    await mainTurnEnd($)
    await requestWith($, contextOf(80_001))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(JSON.stringify(seen.logs)).toContain('review settlement failed')
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 1 }])
  })
  test('a rotation whose replacing spawn leaves the state unwritable: the stop\'s state read fails, is logged, and the settle carries on', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], writesFailFromSpawn: 2 })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
    await mainTurnEnd($)
    await requestWith($, contextOf(80_001))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.stops).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop failed')
  })
})

describe('a reviewer stop with no session bound', () => {
  // The test engine cannot stage this: a tool.call hook that throws is skipped, and the plugin then sees "no implementation for tool.call". So the stop is staged with a hand-made `$` and the error as the engine throws it.
  const NO_SESSION_BOUND = Object.assign(new Error(NO_SESSION_BOUND_MESSAGE), { name: 'HooksError' })
  const dollar = (reject: unknown) => {
    const logs: string[] = []
    const calls: unknown[] = []
    const $ = { tool: { call: (e: unknown) => (calls.push(e), Promise.reject(reject)) }, ui: { log: (text: string) => logs.push(text) } } as any
    return { $, logs, calls }
  }
  // The stop is not awaited, so its rejection is handled a few microtasks after the helper resolves.
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  test('the engine\'s no-session-bound error is logged as one plain line with no stack', async () => {
    const { $, logs, calls } = dollar(NO_SESSION_BOUND)
    await register.stopReviewer($, 'ag1', false)
    await settled()
    expect(calls).toEqual([{ tool: 'TaskStop', task_id: 'ag1' }])
    expect(logs).toEqual(['auditor: reviewer stop skipped: no session is bound in this mode'])
  })

  test('any other error is logged as a failure with its stack', async () => {
    const { $, logs } = dollar(new Error('tool unavailable'))
    await register.stopReviewer($, 'ag1', false)
    await settled()
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain('auditor: reviewer stop failed')
    expect(logs[0]).toContain('tool unavailable')
    expect(logs[0]).toContain('at ')
  })
})

describe('a reviewer stop is checked against the agent list and retried once', () => {
  const listed = (status: string) => [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', status }]
  // The agent list shows ag1 as `status` until `taken` stops have been made, and not at all after.
  const staysUntil = (taken: number, status = 'idle') => (stops: number) => (stops >= taken ? [] : listed(status))
  const leftRunning = (seen: { logs: { text: string }[] }) => debugLines(seen, 'left running')
  const retried = (seen: { logs: { text: string }[] }) => debugLines(seen, 'stopping it once more')
  // A rotation: the reviewer's context passes the threshold, its review settles, and the settle stops it.
  const rotated = async ($: any): Promise<void> => {
    await workerTurn($)
    STEP_USAGE = { ...USAGE, input_tokens: 80_001 }
    try {
      await step($, '', 'ag1')
    } finally {
      STEP_USAGE = null
    }
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await drained()
  }

  test('a stop the engine refuses is issued once more, and a retry the engine takes logs no left-running line', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], stopRefuses: 'no such task', stopRefusals: 1 })
    await rotated($)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
    expect(retried(seen).length).toBe(1)
    expect(leftRunning(seen)).toEqual([])
  })

  test('a stop the engine refuses twice logs one line naming the reviewer as left running, and issues no third stop', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], stopRefuses: 'no such task' })
    await rotated($)
    await workerTurn($, 'Second.')
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
    expect(leftRunning(seen)).toEqual(['auditor: reviewer ag1 left running: two stops did not end it'])
  })

  for (const status of ['idle', 'running', 'waiting', 'pending']) {
    test(`a stop after which the list still shows the reviewer ${status} is issued once more, and a retry the list then shows ended logs no left-running line`, ON, async ($, on) => {
      const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], agentsAfterStops: staysUntil(2, status) })
      await rotated($)
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
      expect(retried(seen).length).toBe(1)
      expect(leftRunning(seen)).toEqual([])
    })
  }

  test('a reviewer the list shows not ended after both stops is logged as left running once, and stopped no third time', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], agentsAfterStops: () => listed('idle') })
    await rotated($)
    await workerTurn($, 'Second.')
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
    expect(leftRunning(seen)).toEqual(['auditor: reviewer ag1 left running: two stops did not end it'])
  })

  for (const status of ['killed', 'completed', 'failed']) {
    test(`a stopped reviewer the list shows ${status} is not stopped again`, ON, async ($, on) => {
      const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], agentsAfterStops: () => listed(status) })
      await rotated($)
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
      expect(retried(seen)).toEqual([])
      expect(leftRunning(seen)).toEqual([])
    })
  }

  test('a stopped reviewer absent from the list is not stopped again', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], agentsAfterStops: () => [] })
    await rotated($)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(retried(seen)).toEqual([])
  })

  test('a list read that rejects leaves the stop alone and is logged', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], listFailsAfterStop: true, agentsAfterStops: () => listed('idle') })
    await rotated($)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(JSON.stringify(seen.logs)).toContain('agent list')
    expect(leftRunning(seen)).toEqual([])
  })

  test('a stop whose call throws is logged as failed and not retried', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], toolThrows: 'TaskStop', agentsAfterStops: () => listed('idle') })
    await rotated($)
    await drained()
    expect(seen.stops.length).toBe(1)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop failed')
    expect(retried(seen)).toEqual([])
  })

  test('a retry does not stop an id that became the current reviewer since the first stop', ON, async ($, on) => {
    const check = gate()
    const reached = gate()
    const seen = engine(on, { reviewerIds: ['ag1', 'ag1'], stopRefuses: 'no such task', stopRefusals: 1, listHold: { until: check.until, reached: reached.open } })
    await workerTurn($)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await reached.until
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    check.open()
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(retried(seen)).toEqual([])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
  })

  describe('nothing waits on the check', () => {
    test('a settle that rotates the reviewer completes, and spawns the next, while the check is held', ON, async ($, on) => {
      const check = gate()
      const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], listHold: { until: check.until } })
      await rotated($)
      await workerTurn($, 'Second.')
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
      expect(seen.spawns.length).toBe(2)
      check.open()
      await drained()
    })

    test('a dispatch whose brief is refused completes, and spawns the next reviewer, while the check is held', ON, async ($, on) => {
      const check = gate()
      const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], sendFails: 'ag1', listHold: { until: check.until } })
      await workerTurn($)
      await turnEnded($, 'ag1', 'Nothing to note.')
      await workerTurn($, 'Second.')
      await drained()
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
      expect(seen.spawns.length).toBe(2)
      check.open()
      await drained()
    })

    test('the toggle completes while the check is held', ON, async ($, on) => {
      const check = gate()
      const seen = engine(on, { reviewerIds: ['ag1'], listHold: { until: check.until } })
      await workerTurn($)
      await $.command.run({ command: 'auditor', args: 'off' } as any)
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
      expect(seen.conversation.off).toBe(true)
      check.open()
      await drained()
    })
  })

  test('a session end issues its stop and checks nothing, so a refused stop is not retried', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], stopRefuses: 'no such task', agentsAfterStops: () => listed('idle') })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    const lists = seen.listCalls
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.listCalls).toBe(lists)
    expect(retried(seen)).toEqual([])
    expect(leftRunning(seen)).toEqual([])
  })
})

describe('a reviewer the auditor forgets', () => {
  test('a session end with a stored reviewer stops it once, by its id, before the session\'s log is written, and starts no worker turn', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    const written = seen.writes.length
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.stopWrites).toEqual([written])
    expect(seen.writes.length).toBeGreaterThan(written)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: clear' })
    expect(seen.prompts).toEqual(['fix the parser'])
  })

  for (const reason of ['prompt_input_exit', 'other']) {
    test(`a session end with reason ${reason} issues no stop and logs one plain line that the exiting process ends the reviewer`, ON, async ($, on) => {
      const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
      await $.prompt.submit(COMPOSER('fix the parser'))
      await $.classic.Stop(stop)
      await $.session.end({ reason, sessionId: 's1' } as any)
      expect(seen.toolCalls.filter((c: any) => c.tool === 'TaskStop')).toEqual([])
      expect(debugLines(seen, 'exiting')).toEqual(['auditor: the session is exiting, which ends the reviewer with it, so it is not stopped'])
      expect(seen.conversation.reviewer).toBeUndefined()
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: `session ended: ${reason}` })
    })
  }

  test('a session end with reason resume stops the reviewer as a clear does', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.session.end({ reason: 'resume', sessionId: 's1' } as any)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a session end with no stored reviewer stops nothing', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.stops).toEqual([])
  })

  test('a session end whose stop is refused is logged, and the session end still forgets the reviewer and writes its log', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], stopRefuses: 'no such task' })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop refused')
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: clear' })
  })

  test('a session end whose stop throws is logged, and the session end still forgets the reviewer and writes its log', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], toolThrows: 'TaskStop' })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop failed')
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: clear' })
  })

  test('a session end needs no state write after its reset: a write refused after the reset leaves the stop and the review log intact', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    seen.stateWritesFailAt = seen.stateWriteAttempts + 2
    expect(await $.session.end({ reason: 'clear', sessionId: 's1' } as any)).toEqual({ sessionId: 's1' })
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: clear' })
  })

  test('a session end whose reset write fails still stops the stored reviewer, logs its open review as incomplete from the state as it stood, and reaches next', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    seen.stateWritesFailAt = seen.stateWriteAttempts + 1
    expect(await $.session.end({ reason: 'clear', sessionId: 's1' } as any)).toEqual({ sessionId: 's1' })
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(JSON.stringify(seen.logs)).toContain('session end failed')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'session ended: clear' })
  })

  test('a refused brief whose replacing spawn leaves the state unwritable: the stop\'s state read fails, is logged, and the dispatch carries on', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'], writesFailFromSpawn: 2 })
    await workerTurn($)
    await step($, 'more')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(2)
    expect(seen.stops).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop failed')
  })

  test('a refused brief stops the reviewer it was refused by, once, after the spawn that replaces it, and starts no worker turn', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await step($, 'more')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(2)
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 2 }])
    expect(seen.prompts).toEqual([])
  })

  test('a refused brief whose replacing spawn is refused stops the refused reviewer after the refusal', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'], spawnDeniesFrom: 2 })
    await workerTurn($)
    await step($, 'more')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 2 }])
  })

  test('a refused brief whose replacing spawn throws stops the refused reviewer after the throw', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'], spawnThrowsFrom: 2 })
    await workerTurn($)
    await step($, 'more')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 2 }])
    expect(JSON.stringify(seen.logs)).toContain('review dispatch failed')
  })

  test('a respawn under the refused id makes no stop: the id is the current reviewer\'s', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag1'] })
    await workerTurn($)
    await step($, 'more')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.stops).toEqual([])
  })

  test('a refused stop on the refused-brief path is logged, and the dispatch still spawns the replacement', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'], stopRefuses: 'no such task' })
    await workerTurn($)
    await step($, 'more')
    await turnEnded($, 'ag1', 'Nothing to note.')
    await drained()
    expect(seen.spawns.length).toBe(2)
    expect(JSON.stringify(seen.logs)).toContain('reviewer stop refused')
  })
})

describe('the reviewer\'s compaction', () => {
  // A compaction the plugin raises over one message, since a compaction leaves at least one; with the instructions and the agent whose conversation it compacts, when given.
  const ONE_MESSAGE = [{ role: 'user' as const, text: 'fix the parser', toolUses: [] }]
  const compacting = (fields: { instructions?: string; agentId?: string } = {}) => ({ trigger: 'plugin' as const, messages: ONE_MESSAGE, ...fields })

  test('the reviewer is registered with a 100,000-token auto-compaction window', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registered[0]).toMatchObject({ name: 'reviewer', autoCompactWindow: 100_000 })
  })

  test('a compaction of the reviewer keeps the instructions it came with, and appends what the reviewer keeps', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.compact(compacting({ instructions: 'keep the plan', agentId: 'ag1' }))
    expect(seen.compactions[0].instructions.startsWith('keep the plan\n\nYou are the auditor reviewer. Keep:')).toBe(true)
  })

  test('a compaction of the reviewer with no instructions of its own is told what the reviewer keeps', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.compact(compacting({ agentId: 'ag1' }))
    expect(seen.compactions[0].instructions.startsWith('You are the auditor reviewer. Keep:')).toBe(true)
  })

  test('a compaction of the reviewer keeps the user\'s instructions with where they were given, drops quiet reviews, and asks it to keep neither its notes nor open disagreements', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.compact(compacting({ agentId: 'ag1' }))
    const told = seen.compactions[0].instructions
    expect(told).toContain('Keep: every instruction, rule and preference of the user you have found, with where it was given.')
    expect(told).toContain('Drop: the details of reviews that found nothing to note')
    expect(told).not.toMatch(/disagree|dispute/)
    expect(told).not.toMatch(/note you gave|each note|your notes/)
  })

  test('a compaction with no agent id, or of an agent that is not a reviewer, passes its instructions unchanged', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.session.compact(compacting({ instructions: 'keep the plan' }))
    await $.session.compact(compacting({ instructions: 'keep the plan', agentId: 'sub1' }))
    await $.session.compact(compacting())
    expect(seen.compactions.map(e => e.instructions)).toEqual(['keep the plan', 'keep the plan', undefined])
  })
})

describe('the /auditor command', () => {
  // The command's answer to `args`; bare when none is given.
  const run = async ($: any, args = ''): Promise<string | undefined> => (await $.command.run({ command: 'auditor', args })).text
  // The answer's first line: the label the footer draws. The popup's rows follow it (see the cost tests).
  const label = async ($: any, args = ''): Promise<string | undefined> => (await run($, args))?.split('\n')[0]

  test('the command is registered as immediate, with an on, off or memory argument hint', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.commands.find(c => c.name === 'auditor')).toMatchObject({ name: 'auditor', immediate: true, argumentHint: '[on|off|memory]' })
  })

  test('bare, the command says whether the reviewer is on, as the footer button does', ON, async ($, on) => {
    engine(on)
    otherMods(on)
    expect(await label($)).toBe('auditor on')
    await buttonReads(await mountMode($), 'on')
  })

  test('off turns the reviewer off: the next worker turn end dispatches no review, a tool call is not recorded, and the footer reads off', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    expect(await label($, 'off')).toBe('auditor off')
    await $.tool.call(WORKER_CALL('Bash', { command: 'pwd' }))
    await workerTurn($)
    expect(seen.spawns.length).toBe(0)
    expect(seen.sends.length).toBe(0)
    expect(seen.conversation.record.blocks.length).toBe(2)
    await buttonReads(await mountMode($), 'off')
  })

  test('on after off starts an empty record: the next turn end dispatches a review whose record holds only the entries after the switch', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('before off'))
    expect(await label($, 'off')).toBe('auditor off')
    await $.prompt.submit(COMPOSER('while off'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    expect(await label($, 'on')).toBe('auditor on')
    await $.prompt.submit(COMPOSER('after on'))
    await workerTurn($)
    expect(seen.spawns.length).toBe(1)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: after on', 'ASSISTANT: working'))
  })

  test('off twice is idempotent: each answers off, the argument is read whatever its case or spacing, and nothing is dispatched', ON, async ($, on) => {
    const seen = engine(on)
    expect(await label($, 'off')).toBe('auditor off')
    expect(await label($, ' OFF ')).toBe('auditor off')
    await workerTurn($)
    expect(seen.spawns.length).toBe(0)
    expect(await label($)).toBe('auditor off')
  })

  test('an argument that is neither on, off nor memory is refused with its usage, and changes nothing', ON, async ($, on) => {
    engine(on)
    expect(await run($, 'bogus')).toBe('Usage: /auditor [on|off|memory]')
    expect(await label($)).toBe('auditor on')
  })

  test('after a failed review, bare reads auditor failing, and a switch off and then on clears the failure', ON, async ($, on) => {
    engine(on)
    await workerTurn($)
    await turnFailed($, 'ag1')
    expect(await label($)).toBe('auditor failing')
    expect(await label($, 'off')).toBe('auditor off')
    expect(await label($, 'on')).toBe('auditor on')
  })
})

describe('the escalation push', () => {
  const ESCALATION = 'Escalation: Disagreement on auth. Escalating.'
  // The PushNotification calls the plugin has made, as the mock recorded them.
  const pushes = (seen: { toolCalls: any[] }): any[] => seen.toolCalls.filter(call => call.tool === 'PushNotification')

  test('an escalation pushes one proactive notification of its first line as its review settles, beside the toast', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', ESCALATION)
    expect(pushes(seen)).toMatchObject([{ message: `auditor escalated: ${ESCALATION}`, status: 'proactive' }])
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    // The plugin's own push is not a worker entry, so it summons no review.
    expect(seen.sends.length).toBe(0)
    expect(seen.spawns.length).toBe(1)
  })

  test('an escalation and a plain note each go to main as sent, the plugin submits nothing for either, and each log says delivered', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', ESCALATION)
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    expect(toMain(seen)).toEqual([FRAMED(1, ESCALATION), FRAMED(2, 'a.ts:4 idle.')])
    expect(seen.prompts).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true, escalation: true })
    expect(logOf(seen, LOG_2)).toMatchObject({ note_delivered: true, escalation: false })
  })

  test('a push is cut at 180 characters, with the cut counted after them', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', `Escalation: ${'x'.repeat(300)}`)
    // 'auditor escalated: Escalation: ' is 31 characters, so 149 of the escalation's own fit, and the 151 cut are counted.
    expect(pushes(seen)).toMatchObject([{ message: `auditor escalated: Escalation: ${'x'.repeat(149)} …+151 characters` }])
  })

  test('a push carries only the first line of a multi-line escalation', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', `${ESCALATION}\nWorker: validate in handlers. Me: middleware.`)
    expect(pushes(seen)).toMatchObject([{ message: `auditor escalated: ${ESCALATION}` }])
  })

  test('a plain note and a quiet answer push nothing', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 swallows it.')
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(pushes(seen)).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('a push that throws is logged to debug, and the escalation still settles: its toast shows and its note reaches the worker', ON, async ($, on) => {
    const seen = engine(on, { toolThrows: 'PushNotification' })
    await workerTurn($)
    await turnEnded($, 'ag1', ESCALATION)
    expect(debugLines(seen, 'escalation push failed').length).toBe(1)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', escalation: true })
    expect(toMain(seen)).toEqual([FRAMED(1, ESCALATION)])
  })

  test('two identical escalations in flight at once: each push leaves the flight count when its own call settles, so neither is a worker entry', ON, async ($, on) => {
    const first = gate()
    const second = gate()
    const seen = engine(on, { toolHolds: { tool: 'PushNotification', untils: [first.until, second.until] } })
    await workerTurn($)
    await turnEnded($, 'ag1', ESCALATION)
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag1', ESCALATION)
    await drained()
    expect(pushes(seen).length).toBe(2)
    // The first push settles while the second is still in flight, and the second settles after it.
    first.open()
    await drained()
    second.open()
    await drained()
    await mainTurnEnd($)
    await workerTurn($, 'Third.')
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(3, 'ASSISTANT: working'))
  })
})


describe('rc regression tests', () => {
  test('a reviewer its spawn hook stood in is not given up as a spawn that never started: past ten minutes its review lapses as one that never finished', ON, async ($, on) => {
    const seen = engine(on, {
      stateSeed: {
        dispatches: 1,
        reviewer: { id: 'ag1', model: 'm' },
        reviewerIds: ['ag1'],
        review: { number: 1, record: ['[1] USER: fix\n\n'], dispatchedAt: 1000, nothingWakes: false },
        spawnsInFlight: [{ brief: 'a brief', epoch: 0, number: 1, startedAt: 1000, id: 'ag1', model: 'm' }],
      },
    })
    seen.clock = 1000 + TEN_MINUTES + 1
    await workerTurn($, 'Second.')
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.conversation.failing).toBe('no finish')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer did not finish in 10 minutes' })
  })

  test('a reviewer its spawn hook stood in settles with its note while its review is under ten minutes old', ON, async ($, on) => {
    const seen = engine(on, {
      stateSeed: {
        dispatches: 1,
        reviewer: { id: 'ag1', model: 'm' },
        reviewerIds: ['ag1'],
        review: { number: 1, record: ['[1] USER: fix\n\n'], dispatchedAt: 1000, nothingWakes: false },
        spawnsInFlight: [{ brief: 'a brief', epoch: 0, number: 1, startedAt: 1000, id: 'ag1', model: 'm' }],
      },
    })
    seen.clock = 1000 + TEN_MINUTES
    await workerTurn($, 'Second.')
    await drained()
    expect(seen.stops).toEqual([])
    expect(seen.conversation.failing).toBeUndefined()
    await turnEnded($, 'ag1', 'a.ts:4 swallows the error.')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 swallows the error.' })
  })

  test('a spawn whose review was given up at a turn end is stopped when it lands late, and the reviewer spawned since stays', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: { ...held.hold, to: 1 }, reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    seen.clock += TEN_MINUTES + 1
    await $.prompt.submit(COMPOSER('again'))
    await $.classic.Stop(stop)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn did not settle in 10 minutes' })
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    held.land()
    await stopping
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag2'])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
  })
})


describe('rc session end ids', () => {
  test('a /clear keeps the reviewer markers, so a pre-/clear reviewer\'s end-of-run notice is still consumed', ON, async ($, on) => {
    const seen = engine(on, {
      agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }],
      stateSeed: {
        dispatches: 1,
        reviewer: { id: 'ag1', model: 'm' },
        reviewerIds: ['ag1'],
        reviewerNames: ['auditor-reviewer'],
        review: { number: 1, record: ['[1] USER: fix\n\n'], dispatchedAt: 1000, nothingWakes: false },
        spawnsInFlight: [{ brief: 'a brief', epoch: 0, number: 1, startedAt: 1000, id: 'ag1', model: 'm' }],
      },
    })
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.reviewerIds).toEqual(['ag1'])
    expect(seen.conversation.reviewerNames).toEqual(['auditor-reviewer'])
    expect(await $.session.receive({ text: END_NOTICE('auditor-reviewer'), origin: { kind: 'peer' as const, teammate: 'auditor-reviewer', isVerified: true } } as any)).toEqual(CONSUMED)
  })
})

describe('the follow-up to a note written as the answer', () => {
  // Review 1's reviewer writes its note as its final answer, opening with the review's own line.
  const WRITTEN = FRAMED(1, 'a.ts:4 swallows it.')
  const ATTEMPT = 'review 1 wrote its note as its final answer'
  const UNSENT = 'review 1\'s follow-up could not be sent'
  const QUIET_LOGGED = 'sent no note, and its final answer was'
  // The sends that reached the bottom of the chain to a reviewer, as their address and text.
  const sentTo = (seen: { sends: { to: string; text: string }[] }) => seen.sends.map(s => ({ to: s.to, text: s.text }))
  const ONE_FOLLOW_UP = [{ to: 'ag1', text: followUpText(1) }]
  const pastRotation = { ...USAGE, input_tokens: 80_001 }
  const requestPast = async ($: any): Promise<void> => {
    STEP_USAGE = pastRotation
    try {
      await step($, '', 'ag1')
    } finally {
      STEP_USAGE = null
    }
  }

  test('a turn end with no note booked, in an answer opening with the open review\'s line and a body, sends the reviewer one follow-up naming that review, unchanged by the gate, and logs the first answer once', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(sentTo(seen)).toEqual(ONE_FOLLOW_UP)
    expect(seen.sends[0].agentId).toBeUndefined()
    expect(debugLines(seen, ATTEMPT)).toEqual([`auditor: ${ATTEMPT}, so its reviewer is asked once to send it; the answer was: ${WRITTEN}`])
    expect(seen.conversation.review).toMatchObject({ number: 1, followedUp: true })
    expect(logOf(seen, LOG_1)).toBeUndefined()
    expect(toMain(seen)).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('a padded quiet status after the review line gets the follow-up too', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', FRAMED(1, 'Nothing to note. The worker left a.ts:4 as it was.')))
    expect(sentTo(seen)).toEqual(ONE_FOLLOW_UP)
  })

  // Each answer lacks the trigger: no review line, another review's number, an empty body, or a body that is exactly the quiet status.
  for (const answer of ['a.ts:4 swallows it.', FRAMED(2, 'a.ts:4 swallows it.'), FRAMED(1, ''), FRAMED(1, 'Nothing to note.')]) {
    test(`a turn end answering ${JSON.stringify(answer)} sends no follow-up and settles the review`, ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', answer))
      expect(seen.sends).toEqual([])
      expect(seen.conversation.review).toBeUndefined()
      expect(debugLines(seen, ATTEMPT)).toEqual([])
    })
  }

  test('a booked note, or a turn that ends without an answer, sends no follow-up', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await noteSent($, 'a.ts:4 swallows it.')
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 swallows it.' })
    await workerTurn($, 'Second.')
    await $.turn.complete({ ...TURN_END('ag1', FRAMED(2, 'b.ts:1 cut off.')), isAborted: true, reason: 'aborted' })
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete' })
    expect(seen.sends.map(s => s.text)).not.toContain(followUpText(1))
    expect(seen.sends.map(s => s.text)).not.toContain(followUpText(2))
  })

  test('the follow-up is in flight until its call reaches the recorder, which leaves it out of the worker\'s record', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(seen.conversation.briefsInFlight).toContain(followUpText(1))
    await $.tool.call(WORKER_CALL('SendMessage', { to: 'ag1', message: followUpText(1) }))
    expect(seen.conversation.briefsInFlight).not.toContain(followUpText(1))
    expect(await entriesOf($, { which: 'live' })).toBe(NONE_SINCE(1))
  })

  test('while its follow-up is out the review stays open: no review is dispatched, its entries stay out of the record, and a reviewer past rotation is not retired', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestPast($)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    await workerTurn($, 'Second.')
    await drained()
    expect(sentTo(seen)).toEqual(ONE_FOLLOW_UP)
    expect(seen.spawns.length).toBe(1)
    expect(seen.conversation.review).toMatchObject({ number: 1, followedUp: true })
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(seen.conversation.record.blocks.length).toBe(1)
    expect(seen.stops).toEqual([])
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'ASSISTANT: working'))
  })

  test('a note sent after the follow-up is admitted and booked, and settles the review complete with it', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(await noteSent($, 'a.ts:4 swallows it.')).toEqual({ isDelivered: true })
    expect(toMain(seen)).toEqual([WRITTEN])
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 swallows it.', note_delivered: true })
    expect(sentTo(seen)).toEqual(ONE_FOLLOW_UP)
  })

  for (const [second, logged] of [[WRITTEN, true], ['Nothing to note.', false]] as const) {
    test(`a second turn end answering ${JSON.stringify(second)} gets no second follow-up and settles the review complete and quiet, ${logged ? 'with' : 'without'} its answer in the debug log`, ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', WRITTEN))
      await $.turn.complete(TURN_END('ag1', second))
      expect(sentTo(seen)).toEqual(ONE_FOLLOW_UP)
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false })
      expect(seen.conversation.review).toBeUndefined()
      expect(seen.conversation.failing).toBeUndefined()
      expect(debugLines(seen, QUIET_LOGGED).length).toBe(logged ? 1 : 0)
      expect(debugLines(seen, ATTEMPT).length).toBe(1)
    })
  }

  for (const [how, opts] of [['is refused', { sendFails: 'ag1' }], ['throws', { sendThrows: 'ag1' }]] as const) {
    test(`a follow-up whose send ${how} leaves flight and settles the review complete and quiet, with one line saying so, the first answer logged once, no resend, the failure cleared and the next review dispatched on an idle worker`, ON, async ($, on) => {
      const seen = engine(on, { ...opts, stateSeed: { failing: true } })
      await $.prompt.submit(COMPOSER('first'))
      await $.classic.Stop(stop)
      await mainTurnEnd($)
      await step($, 'more')
      await $.turn.complete(TURN_END('ag1', WRITTEN))
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false, turn_end: { answer: WRITTEN } })
      expect(debugLines(seen, UNSENT).length).toBe(1)
      expect(debugLines(seen, ATTEMPT).length).toBe(1)
      expect(debugLines(seen, QUIET_LOGGED)).toEqual([])
      // The settle cleared the failure before it dispatched; a brief that throws the same way fails review 2 afterwards.
      expect(seen.conversations.some(c => c.failing === undefined)).toBe(true)
      expect(seen.conversation.briefsInFlight).not.toContain(followUpText(1))
      // The follow-up once, then review 2's brief to the same reviewer, at once on the idle worker.
      expect(seen.sends.map(s => s.text).filter(t => t === followUpText(1)).length).toBe(1)
      expect(seen.sends.filter(s => s.text.includes('Review 2.')).length).toBe(1)
    })

    test(`a follow-up whose send ${how} stops a reviewer past rotation, as any settle does`, ON, async ($, on) => {
      const seen = engine(on, { ...opts, reviewerIds: ['ag1', 'ag2'] })
      await workerTurn($)
      await requestPast($)
      await $.turn.complete(TURN_END('ag1', WRITTEN))
      await drained()
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
      expect(seen.conversation.reviewer).toBeUndefined()
    })
  }

  test('a reset while a delivered follow-up is in flight stops the reviewer again', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { sendHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const ending = $.turn.complete(TURN_END('ag1', WRITTEN))
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    await ending
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1', 'ag1'])
  })

  test('a reset while a failed follow-up\'s send is out leaves its settle closing nothing, with a debug line', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { sendFails: 'ag1', sendHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const ending = $.turn.complete(TURN_END('ag1', WRITTEN))
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    await ending
    expect(debugLines(seen, UNSENT).length).toBe(1)
    expect(debugLines(seen, 'ended a turn with no review in progress').length).toBe(1)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'the auditor was switched off' })
  })

  for (const [reset, run] of [['switched off', ($: any) => $.command.run({ command: 'auditor', args: 'off' } as any)], ['cleared', ($: any) => $.session.end({ reason: 'clear', sessionId: 's1' } as any)]] as const) {
    test(`a review ${reset} before its follow-up goes out gets none, and its reviewer's later turn end closes nothing`, ON, async ($, on) => {
      const release = gate()
      const reached = gate()
      const seen = engine(on, { getHold: { when: c => c?.review?.followedUp === true, until: release.until, reached: reached.open } })
      await workerTurn($)
      const ending = $.turn.complete(TURN_END('ag1', WRITTEN))
      await reached.until
      await run($)
      release.open()
      await ending
      expect(seen.sends).toEqual([])
      expect(seen.conversation.briefsInFlight).not.toContain(followUpText(1))
      const logged = seen.files[LOG_1]
      await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
      expect(seen.files[LOG_1]).toBe(logged)
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete' })
      expect(seen.conversation.review).toBeUndefined()
    })
  }
})

describe('a note held after an interrupt', () => {
  // The engine's refusal of a send while the session is stopped, in the two measured wordings.
  const STOPPED_MAIN = 'The main conversation was not messaged: the session was stopped and nobody has sent input since.'
  const STOPPED_TEAMMATE = 'Teammate "auditor-reviewer" was not messaged: the session was stopped and nobody has sent input since.'
  const BODY = 'a.ts:4 after the Esc.'
  const SLASH = (text: string, name: string) => ({ text, wait: false, origin: { kind: 'composer' as const }, command: { name, args: '' } })
  const PLUGIN_PROMPT = { text: 'another plugin speaking', wait: false, origin: { kind: 'plugin' as const, name: 'other' } } as any
  const WRITTEN = FRAMED(1, BODY)
  const HELD = 'so it is held for the user\'s next prompt'
  const pushes = (seen: any) => seen.toolCalls.filter((c: { tool: string }) => c.tool === 'PushNotification').map((c: { message: string }) => c.message)
  // The worker's turn ends aborted: the user pressed Esc.
  const abort = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
  // Review 1 is dispatched at the worker's Stop; the user then prompts and presses Esc.
  const interrupted = async ($: any) => {
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await abort($)
  }
  const switchOff = ($: any) => $.command.run({ command: 'auditor', args: 'off' } as any)
  const switchOn = ($: any) => $.command.run({ command: 'auditor', args: 'on' } as any)

  for (const [who, wording] of [['main', STOPPED_MAIN], ['a teammate', STOPPED_TEAMMATE]] as const) {
    test(`a note refused with the stopped-session wording naming ${who} is held while the interrupt mark is unset: the reviewer reads the engine's refusal, a resend is refused as a second note, and the review settles complete with it, not delivered`, ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1], refusal: wording })
      await workerTurn($)
      expect(seen.conversation.interrupted).toBe(false)
      expect(await noteSent($, BODY)).toEqual({ isDelivered: false, reason: wording })
      expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
      expect(seen.conversation.review).toMatchObject({ number: 1, note: BODY })
      expect(seen.conversation.review).not.toHaveProperty('delivered')
      expect(debugLines(seen, HELD).length).toBe(1)
      expect((await noteSent($, 'a.ts:4 again.')).reason).toContain('one note already')
      await $.turn.complete(TURN_END('ag1', 'Sent.'))
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: BODY, note_delivered: false })
      expect(seen.toasts).toEqual([])
      expect(seen.appends).toEqual([])
    })
  }

  test('a note refused for another reason while the interrupt mark is set is held', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1] })
    await interrupted($)
    expect(seen.conversation.interrupted).toBe(true)
    expect(await noteSent($, BODY)).toEqual({ isDelivered: false, reason: 'main is gone' })
    expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
    expect(seen.conversation.review).toMatchObject({ note: BODY })
  })

  test('a note refused for another reason while the interrupt mark is unset releases the slot, holds nothing, and a resend is admitted', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1] })
    await workerTurn($)
    expect((await noteSent($, BODY)).isDelivered).toBe(false)
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.conversation.review.note).toBeUndefined()
    expect(await noteSent($, BODY)).toEqual({ isDelivered: true })
    expect(debugLines(seen, HELD)).toEqual([])
  })

  test('a note whose send throws, with the interrupt mark set, is released, not held: a throw is no refusal', ON, async ($, on) => {
    const seen = engine(on, { noteThrows: true })
    await interrupted($)
    expect((await noteSent($, BODY)).isDelivered).toBe(false)
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.conversation.review.note).toBeUndefined()
  })

  test('the interrupt mark is set by the worker\'s aborted turn end, and cleared only by the user\'s next own prompt: a slash command, a plugin\'s prompt and a peer prompt leave it set and carry nothing', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await workerTurn($)
    await noteSent($, BODY)
    await abort($)
    expect(seen.conversation.interrupted).toBe(true)
    await $.prompt.submit(SLASH('/status', 'status'))
    await $.prompt.submit(PLUGIN_PROMPT)
    await $.prompt.submit(HELPER)
    expect(seen.conversation.interrupted).toBe(true)
    expect(seen.contexts).toEqual([undefined, undefined, undefined])
    expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
    await $.prompt.submit(COMPOSER('now'))
    expect(seen.conversation.interrupted).toBe(false)
    expect(seen.contexts.at(-1)).toEqual([WRITTEN])
  })

  test('switching on clears the interrupt mark, so a note refused for another reason after an Esc in an off period is released', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1] })
    await switchOff($)
    await $.prompt.submit(COMPOSER('first'))
    await abort($)
    expect(seen.conversation.interrupted).toBe(true)
    await switchOn($)
    expect(seen.conversation.interrupted).toBe(false)
    await workerTurn($)
    expect((await noteSent($, BODY)).isDelivered).toBe(false)
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.conversation.review.note).toBeUndefined()
  })

  test('a /clear clears the interrupt mark', ON, async ($, on) => {
    const seen = engine(on)
    await interrupted($)
    expect(seen.conversation.interrupted).toBe(true)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.interrupted).toBe(false)
  })

  test('a follow-up refused with the teammate wording holds the note the reviewer wrote as its answer, its body after the review line, and the review settles complete with it, not delivered', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE })
    await workerTurn($)
    expect(seen.conversation.interrupted).toBe(false)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: BODY, note_delivered: false })
    expect(debugLines(seen, 'review 1\'s follow-up could not be sent').length).toBe(1)
    expect(debugLines(seen, 'sent no note, and its final answer was')).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('a follow-up refused for another reason while the interrupt mark is set holds the note too', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1' })
    await interrupted($)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: BODY, note_delivered: false })
  })

  test('a follow-up refused with neither signal holds nothing, leaves the slot empty and settles the review quiet', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1' })
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', WRITTEN))
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false })
  })

  test('in a review whose brief did not say nothing will wake the worker, a stall-marked answer whose follow-up is refused after an Esc is not held: the review settles quiet, and the debug log gives the reason', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE })
    await interrupted($)
    await $.turn.complete(TURN_END('ag1', FRAMED(1, STALL_NOTE)))
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.conversation.nudged).toBe(false)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false })
    expect(debugLines(seen, 'its note was not held').length).toBe(1)
    expect(debugLines(seen, 'did not say nothing will wake the worker').length).toBe(1)
  })

  test('a brief refused for another reason holds nothing: the review fails', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', spawnDeniesFrom: 2 })
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
    await $.prompt.submit(COMPOSER('more'))
    await step($, 'working')
    await $.classic.Stop(stop)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.conversation.failing).toBe('not dispatched')
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete' })
  })

  test('at the hold, an escalation raises its toast and push once, and the next review\'s brief carries the note', ON, async ($, on) => {
    const escalation = 'Escalation: auth belongs in middleware.\nWorker: handlers.'
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await workerTurn($)
    await noteSent($, escalation)
    await drained()
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(pushes(seen)).toEqual(['auditor escalated: Escalation: auth belongs in middleware.'])
    expect(seen.conversation.memory).toEqual([{ number: 1, text: 'Escalation: auth belongs in middleware. Worker: handlers.' }])
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    await $.prompt.submit(COMPOSER('more'))
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).toContain('Review 1 (in flight, last touched in review 1): Escalation: auth belongs in middleware. Worker: handlers.')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
  })

  test('at the hold, a stall note arms the stall guard', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await noteSent($, STALL_NOTE)
    expect(seen.conversation).toMatchObject({ nudged: true, pendingNotes: [{ number: 1, text: STALL_NOTE }] })
  })

  test('a hold that finds its epoch moved writes nothing and logs no held line, though an escalation is still announced', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN, noteHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const sending = noteSent($, 'Escalation: auth belongs in middleware.')
    await reached.until
    await switchOff($)
    release.open()
    expect((await sending).isDelivered).toBe(false)
    await drained()
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.conversation.memory).toEqual([])
    expect(debugLines(seen, HELD)).toEqual([])
    expect(debugLines(seen, 'nothing is held').length).toBe(1)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
  })

  test('a failure of the hold change at the gate is logged with its stack, the slot stays filled so a resend is refused, and an escalation is still announced', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN, writeRefusedWhen: c => c.pendingNotes.length > 0 })
    await workerTurn($)
    expect((await noteSent($, 'Escalation: auth belongs in middleware.')).isDelivered).toBe(false)
    await drained()
    const failed = debugLines(seen, 'review 1\'s note hold or release failed')
    expect(failed.length).toBe(1)
    expect(failed[0]).toMatch(/\n\s+at /)
    expect(seen.conversation.pendingNotes).toEqual([])
    expect((await noteSent($, 'a.ts:4 again.')).reason).toContain('one note already')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(pushes(seen)).toEqual(['auditor escalated: Escalation: auth belongs in middleware.'])
  })

  test('a failure of the hold change at the follow-up is logged with its stack, the review settles quiet, and an escalation is still announced', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE, writeRefusedWhen: c => c.pendingNotes.length > 0 })
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', FRAMED(1, 'Escalation: auth belongs in middleware.')))
    await drained()
    const failed = debugLines(seen, 'review 1\'s note hold or release failed')
    expect(failed.length).toBe(1)
    expect(failed[0]).toMatch(/\n\s+at /)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null })
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(pushes(seen)).toEqual(['auditor escalated: Escalation: auth belongs in middleware.'])
  })

  test('the held note is attached as context beside the user\'s next own prompt, framed as its review line then its body, once, with no plugin row or line, and the next review\'s record shows it', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await interrupted($)
    await noteSent($, BODY)
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
    await $.prompt.submit(COMPOSER('next'))
    await $.prompt.submit(COMPOSER('and again'))
    expect(seen.prompts).toEqual(['carry on', 'next', 'and again'])
    expect(seen.contexts).toEqual([undefined, [WRITTEN], undefined])
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.appends).toEqual([])
    expect(transcriptLines(seen)).toEqual([])
    expect(debugLines(seen, 'attached the held notes of reviews 1 beside').length).toBe(1)
    // No review was dispatched while the note was held; the turn end after the prompts dispatches review 2, whose record holds them.
    await mainTurnEnd($)
    expect(await entriesOf($, { which: 'record' })).toContain(`PROMPT (plugin): ${WRITTEN}`)
  })

  for (const how of ['drop', 'throw'] as const) {
    test(`a prompt that a later hook ${how === 'drop' ? 'drops' : 'throws on'} leaves the note held for the next user prompt`, ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN, contextPrompt: how })
      await workerTurn($)
      await noteSent($, BODY)
      let thrown = false
      try {
        await $.prompt.submit(COMPOSER('next'))
      } catch {
        thrown = true
      }
      expect(thrown).toBe(how === 'throw')
      expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: BODY }])
      await $.prompt.submit(COMPOSER('again'))
      expect(seen.contexts.at(-1)).toEqual([WRITTEN])
      expect(seen.conversation.pendingNotes).toEqual([])
    })
  }

  test('switching off empties the held list and a /clear starts it empty: a note held before either is never attached', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await workerTurn($)
    await noteSent($, BODY)
    await switchOff($)
    expect(seen.conversation.pendingNotes).toEqual([])
    await switchOn($)
    await $.prompt.submit(COMPOSER('after the switch'))
    expect(seen.contexts).toEqual([undefined])
  })

  test('a /clear starts the held list empty: a note held before it is never attached', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await workerTurn($)
    await noteSent($, BODY)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.pendingNotes).toEqual([])
    await $.prompt.submit(COMPOSER('fresh'))
    expect(seen.contexts).toEqual([undefined])
  })
})

describe('after an Esc, no review is dispatched until the user types a plain prompt', () => {
  const STOPPED_MAIN = 'The main conversation was not messaged: the session was stopped and nobody has sent input since.'
  const STOPPED_TEAMMATE = 'Teammate "auditor-reviewer" was not messaged: the session was stopped and nobody has sent input since.'
  const STOPPED_SPAWN = 'Agent "auditor-reviewer" was not spawned: the session was stopped and nobody has sent input since.'
  const GIVEN_BACK = 'given back: the session was stopped'
  const INTERRUPTION = 'INTERRUPTED: the user stopped this turn before it finished.'
  const abort = ($: any) => $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
  // Review 1 is dispatched at the worker's Stop; the user then prompts and presses Esc.
  const interrupted = async ($: any) => {
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await abort($)
  }
  const SLASH = { text: '/status', wait: false, origin: { kind: 'composer' as const }, command: { name: 'status', args: '' } }
  const bodiesOf = (seen: any): string[] => seen.conversation.record.blocks
  const switchTo = ($: any, args: string) => $.command.run({ command: 'auditor', args } as any)

  test('an aborted worker turn end dispatches nothing and leaves its entries in the record', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await step($, 'working')
    await abort($)
    expect(seen.spawns).toEqual([])
    expect(seen.sends).toEqual([])
    expect(seen.conversation.review).toBeUndefined()
    expect(seen.conversation.failing).toBeUndefined()
    expect(bodiesOf(seen).length).toBe(3)
  })

  test('a settle while the interrupt mark is set dispatches nothing and leaves the record\'s entries in place', ON, async ($, on) => {
    const seen = engine(on)
    await interrupted($)
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete' })
    expect(seen.spawns.length).toBe(1)
    expect(seen.sends).toEqual([])
    expect(seen.conversation.review).toBeUndefined()
    expect(bodiesOf(seen).length).toBe(2)
  })

  test('a settle while a note is held and the interrupt mark is unset dispatches nothing', ON, async ($, on) => {
    const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
    await workerTurn($)
    await step($, 'more work')
    await noteSent($, 'a.ts:4 after the Esc.')
    expect(seen.conversation.interrupted).toBe(false)
    expect(seen.conversation.pendingNotes.length).toBe(1)
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(seen.spawns.length).toBe(1)
    expect(seen.sends).toEqual([])
    expect(seen.conversation.review).toBeUndefined()
    expect(bodiesOf(seen).length).toBe(1)
  })

  test('the next plain prompt after an Esc, then its turn end, dispatches one review whose record holds the aborted turn\'s entries followed by the new turn\'s', ON, async ($, on) => {
    const seen = engine(on)
    await interrupted($)
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
    await $.prompt.submit(COMPOSER('now'))
    expect(seen.sends).toEqual([])
    await step($, 'working again')
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(1)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: carry on', INTERRUPTION, 'USER: now', 'ASSISTANT: working again'))
  })

  test('a slash command leaves the gate shut: its turn end dispatches nothing, and the next plain prompt opens it', ON, async ($, on) => {
    const seen = engine(on)
    await interrupted($)
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
    await $.prompt.submit(SLASH)
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    expect(seen.sends).toEqual([])
    expect(seen.conversation.interrupted).toBe(true)
    await $.prompt.submit(COMPOSER('now'))
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(1)
  })

  test('switching the auditor on opens the gate', ON, async ($, on) => {
    const seen = engine(on)
    await switchTo($, 'off')
    await $.prompt.submit(COMPOSER('first'))
    await abort($)
    await switchTo($, 'on')
    await workerTurn($)
    expect(seen.spawns.length).toBe(1)
  })

  test('a /clear opens the gate', ON, async ($, on) => {
    const seen = engine(on)
    await interrupted($)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await workerTurn($)
    expect(seen.spawns.length).toBe(2)
  })

  describe('the edited paths in the brief', () => {
    const LINE = 'Paths the record edits, first edit first:'
    const editedLine = (brief: string): string | undefined => brief.split('\n').find(l => l.startsWith(LINE))

    test('a record with edits, a write, a subagent edit and a failed edit lists the paths that were written, once each, in first-edit order', ON, async ($, on) => {
      const seen = engine(on, { agents: [{ id: 'sub7', name: '' }], failsCall: call => call.file_path === 'c.ts' })
      await $.prompt.submit(COMPOSER('fix the parser'))
      await $.tool.call(WORKER_CALL('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }))
      await $.tool.call(WORKER_CALL('Edit', { file_path: 'a.ts', old_string: 'y', new_string: 'z' }))
      await $.tool.call(WORKER_CALL('Edit', { file_path: 'c.ts', old_string: 'x', new_string: 'y' }))
      await $.tool.call({ tool: 'Edit', file_path: 'b.ts', old_string: 'x', new_string: 'y', agentId: 'sub7' } as any)
      await $.tool.call(WORKER_CALL('Write', { file_path: 'a.ts', content: 'w' }))
      await $.classic.Stop(stop)
      expect(editedLine(seen.spawns[0].prompt)).toBe(`${LINE} "a.ts", "b.ts".`)
    })

    test('an edit whose input is longer than 300 characters still lists its path', ON, async ($, on) => {
      const seen = engine(on)
      const path = `${'dir/'.repeat(30)}long.ts`
      await $.prompt.submit(COMPOSER('fix the parser'))
      await $.tool.call(WORKER_CALL('Edit', { old_string: 'x'.repeat(2000), new_string: 'y'.repeat(2000), file_path: path }))
      await $.classic.Stop(stop)
      expect(editedLine(seen.spawns[0].prompt)).toBe(`${LINE} ${JSON.stringify(path)}.`)
    })

    test('a record with no successful edit has no list line', ON, async ($, on) => {
      const seen = engine(on, { failsCall: call => call.tool === 'Edit' || call.file_path === 'bad.ts' })
      await $.prompt.submit(COMPOSER('fix the parser'))
      await $.tool.call(WORKER_CALL('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }))
      await $.tool.call(WORKER_CALL('Read', { file_path: 'r.ts' }))
      await $.tool.call(WORKER_CALL('Bash', { command: 'echo x > w.ts' }))
      await $.classic.Stop(stop)
      expect(seen.spawns[0].prompt).not.toContain(LINE)
    })

    test('21 edited paths give a line of 20 that says 1 more was left out', ON, async ($, on) => {
      const seen = engine(on)
      await $.prompt.submit(COMPOSER('refactor'))
      for (let i = 1; i <= 21; i++) await $.tool.call(WORKER_CALL('Write', { file_path: `f${i}.ts`, content: 'x' }))
      await $.classic.Stop(stop)
      const line = editedLine(seen.spawns[0].prompt) ?? ''
      expect(line).toBe(`${LINE} ${Array.from({ length: 20 }, (_, i) => `"f${i + 1}.ts"`).join(', ')}. 1 more left out.`)
    })

    test('a review that fails gives its paths back with its entries, and the next brief lists them', ON, async ($, on) => {
      const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE })
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
      await $.prompt.submit(COMPOSER('more'))
      await $.tool.call(WORKER_CALL('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }))
      await $.classic.Stop(stop)
      expect(editedLine(seen.sends[0].text)).toBe(`${LINE} "a.ts".`)
      await $.prompt.submit(COMPOSER('again'))
      await $.tool.call(WORKER_CALL('Write', { file_path: 'b.ts', content: 'x' }))
      await $.classic.Stop(stop)
      expect(editedLine(seen.sends[1].text)).toBe(`${LINE} "a.ts", "b.ts".`)
    })
  })

  describe('a brief the stopped session refuses is given back', () => {
    // Review 2's brief goes to the stored reviewer, which the engine refuses.
    const refusedBrief = async ($: any, on: any, opts: Parameters<typeof engine>[1]) => {
      const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE, ...opts })
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
      await $.prompt.submit(COMPOSER('more'))
      await step($, 'working')
      await $.classic.Stop(stop)
      return seen
    }

    test('by the stored reviewer: nothing is spawned or failed, the entries are back at the front, the mark is set, the reviewer is kept, and the log reads incomplete with the reason', ON, async ($, on) => {
      const seen = await refusedBrief($, on, {})
      expect(seen.sends.map((s: any) => s.to)).toEqual(['ag1'])
      expect(seen.spawns.length).toBe(1)
      expect(seen.conversation.failing).toBeUndefined()
      expect(seen.conversation.review).toBeUndefined()
      expect(seen.conversation.interrupted).toBe(true)
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
      expect(seen.conversation.briefsInFlight.filter((b: string) => b.includes('Review 2.'))).toEqual([])
      expect(bodiesOf(seen).length).toBe(2)
      expect(seen.stops).toEqual([])
      expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: GIVEN_BACK, number: 2, record_entries: 2, note_delivered: false })
      expect(debugLines(seen, 'review failed')).toEqual([])
    })

    test('the next plain prompt\'s turn end then dispatches one review, numbered after the given-back one', ON, async ($, on) => {
      const seen = await refusedBrief($, on, {})
      await $.prompt.submit(COMPOSER('again'))
      await $.classic.Stop(stop)
      expect(seen.sends.length).toBe(2)
      expect(seen.sends[1].text).toContain('Review 3. Its record holds entries 1-3,')
      expect(seen.spawns.length).toBe(1)
    })

    test('by a spawn denied with that wording: nothing is failed, the entries are back, the mark is set, and the log reads incomplete with the reason', ON, async ($, on) => {
      const seen = engine(on, { spawnDeniesFrom: 1, spawnDenyReason: STOPPED_SPAWN })
      await $.prompt.submit(COMPOSER('first'))
      await $.classic.Stop(stop)
      expect(seen.spawns.length).toBe(1)
      expect(seen.conversation.failing).toBeUndefined()
      expect(seen.conversation.review).toBeUndefined()
      expect(seen.conversation.interrupted).toBe(true)
      expect(seen.conversation.briefsInFlight).toEqual([])
      expect(seen.conversation.spawnsInFlight).toEqual([])
      expect(bodiesOf(seen).length).toBe(1)
      expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: GIVEN_BACK, note_delivered: false })
      expect(debugLines(seen, 'review failed')).toEqual([])
    })

    test('by a spawn denied with that wording after the stored reviewer refused the brief for another reason: nothing is failed, and the reviewer it refused is stopped as it is today', ON, async ($, on) => {
      const seen = await refusedBrief($, on, { refusal: 'refused', spawnDeniesFrom: 2, spawnDenyReason: STOPPED_SPAWN })
      expect(seen.conversation.failing).toBeUndefined()
      expect(seen.conversation.interrupted).toBe(true)
      expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: GIVEN_BACK })
      expect(seen.stops.map((s: any) => s.task_id)).toEqual(['ag1'])
    })

    test('with the auditor switched off while the refusal was out: nothing is put back, and the one log is the switch\'s', ON, async ($, on) => {
      const release = gate()
      const reached = gate()
      const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE, sendHold: { until: release.until, reached: reached.open } })
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
      await $.prompt.submit(COMPOSER('more'))
      const stopping = $.classic.Stop(stop)
      await reached.until
      await switchTo($, 'off')
      release.open()
      await stopping
      expect(seen.conversation.interrupted).toBe(false)
      expect(seen.conversation.record.blocks).toEqual([])
      expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: 'the auditor was switched off' })
    })

    test('with the user\'s next plain prompt taken while the refusal was out: the entries are back and the review is logged, but the mark stays unset, so the next turn end dispatches', ON, async ($, on) => {
      const release = gate()
      const reached = gate()
      const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE, sendHold: { until: release.until, reached: reached.open } })
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', 'Nothing to note.'))
      await $.prompt.submit(COMPOSER('more'))
      await step($, 'working')
      const stopping = $.classic.Stop(stop)
      await reached.until
      await $.prompt.submit(COMPOSER('typed meanwhile'))
      release.open()
      await stopping
      expect(seen.conversation.interrupted).toBe(false)
      expect(seen.conversation.review).toBeUndefined()
      expect(seen.conversation.failing).toBeUndefined()
      expect(bodiesOf(seen).length).toBeGreaterThan(2)
      expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: GIVEN_BACK })
      await $.classic.Stop(stop)
      expect(seen.sends.length).toBe(2)
    })

    test('a brief refused for any other reason behaves as today: a new reviewer is spawned', ON, async ($, on) => {
      const seen = await refusedBrief($, on, { refusal: 'refused', reviewerIds: ['ag1', 'ag2'] })
      expect(seen.spawns.length).toBe(2)
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
      expect(seen.conversation.interrupted).toBe(false)
    })

    test('a spawn denied for any other reason fails the review as today: the footer reads failing, the mark stays unset, and nothing is given back', ON, async ($, on) => {
      const seen = await refusedBrief($, on, { refusal: 'refused', spawnDeniesFrom: 2, spawnDenyReason: 'spawn refused' })
      expect(seen.conversation.failing).toBe('not dispatched')
      expect(seen.conversation.interrupted).toBe(false)
      expect(seen.conversation.review).toBeUndefined()
      expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn refused: spawn refused' })
    })
  })
})

describe('the reviewer\'s memory', () => {
  const STOPPED_MAIN = 'The main conversation was not messaged: the session was stopped and nobody has sent input since.'
  const FINISHED = 'The worker finished a turn.'
  const ADDED = 'memory entry added'
  const BOUND = 'memory entries'
  const off = ($: any) => $.command.run({ command: 'auditor', args: 'off' } as any)
  const on_ = ($: any) => $.command.run({ command: 'auditor', args: 'on' } as any)
  const printed = async ($: any): Promise<string | undefined> => (await $.command.run({ command: 'auditor', args: 'memory' })).text
  const entry = (number: number, text = `a.ts:${number} note.`): MemoryEntry => ({ number, text })
  // An in-flight entry as the brief and the printout state it.
  const inFlight = (number: number, text = `a.ts:${number} note.`): string => `Review ${number} (in flight, last touched in review ${number}): ${text}`
  // The memory part of a brief: everything before the brief's own first line.
  const memoryOf = (brief: string): string => brief.slice(0, Math.max(0, brief.indexOf(`\n\n${FINISHED}`)))
  // A stored conversation with no open review, no reviewer and a record to dispatch, holding `memory` after `dispatches` reviews.
  const stored = (memory: MemoryEntry[], dispatches: number, more: object = {}) => ({ dispatches, reviewerIds: [], memory, record: { blocks: ['[1] USER: x\n\n'] }, lastMessage: 'Done.', ...more })
  // The compare-and-set trap: armed from a callback the engine makes just before the change under test, it holds that change's write at `reached` until `open`, so a write made meanwhile makes it miss and run again.
  const trap = () => {
    const armed = { on: false }
    const held = gate()
    const reached = gate()
    return { arm: () => { armed.on = true }, hold: { when: () => armed.on, until: held.until, reached: reached.open }, reached: reached.until, open: held.open }
  }

  describe('adding entries', () => {
    test('a delivered note adds one in-flight entry holding its body under its review number', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, 'a.ts:4 swallows it.')
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
    })

    test('a held note adds one too, with the entry it would have had delivered', ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
      await workerTurn($)
      await noteSent($, 'a.ts:4 after the Esc.')
      expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: 'a.ts:4 after the Esc.' }])
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 after the Esc.')])
    })

    test('an escalation adds one entry', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, 'Escalation: auth belongs in middleware.')
      expect(seen.conversation.memory).toEqual([entry(1, 'Escalation: auth belongs in middleware.')])
    })

    test('a stall note adds none though it arms the guard', ON, async ($, on) => {
      const seen = engine(on)
      await $.prompt.submit(COMPOSER('fix the parser'))
      await $.classic.Stop(QUIET_STOP)
      await mainTurnEnd($)
      expect(await noteSent($, STALL_NOTE)).toEqual({ isDelivered: true })
      expect(seen.conversation).toMatchObject({ nudged: true })
      expect(seen.conversation.memory).toEqual([])
    })

    test('a note refused at the gate, one refused below it and a quiet status add none', ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1] })
      await workerTurn($)
      expect((await noteSent($, 'Nothing to note.')).isDelivered).toBe(false)
      expect((await noteSent($, 'a.ts:4 refused below.')).isDelivered).toBe(false)
      expect(seen.conversation.memory).toEqual([])
      expect((await noteSent($, 'a.ts:4 resent.')).isDelivered).toBe(true)
      expect((await noteSent($, 'a.ts:4 second in one review.')).isDelivered).toBe(false)
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 resent.')])
    })

    test('an entry is clipped to 2,000 characters', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, 'x'.repeat(2_500))
      expect(seen.conversation.memory).toEqual([entry(1, `${'x'.repeat(2_000)} …+500 characters`)])
    })

    test('a note booked while the auditor is off, after a switch, adds none', ON, async ($, on) => {
      const release = gate()
      const reached = gate()
      const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
      await workerTurn($)
      const sending = noteSent($, 'a.ts:4 before the switch.')
      await reached.until
      await off($)
      release.open()
      expect(await sending).toEqual({ isDelivered: true })
      expect(seen.conversation.memory).toEqual([])
    })
  })

  describe('the add line', () => {
    test('a delivered note writes one line with its review number and its text clipped to 180 characters', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, 'y'.repeat(300))
      const lines = debugLines(seen, ADDED)
      expect(lines.length).toBe(1)
      expect(lines[0]).toContain('review 1')
      expect(lines[0]).toContain(`${'y'.repeat(180)} …+120 characters`)
    })

    test('a held note writes one line', ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
      await workerTurn($)
      await noteSent($, 'a.ts:4 after the Esc.')
      expect(debugLines(seen, ADDED).length).toBe(1)
    })

    test('a stall note, a refused note and a released note write none', ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1] })
      await $.prompt.submit(COMPOSER('fix the parser'))
      await $.classic.Stop(QUIET_STOP)
      await mainTurnEnd($)
      expect((await noteSent($, STALL_NOTE)).isDelivered).toBe(false)
      expect((await noteSent($, 'Nothing to note.')).isDelivered).toBe(false)
      expect(await noteSent($, STALL_NOTE)).toEqual({ isDelivered: true })
      expect(debugLines(seen, ADDED)).toEqual([])
    })

    test('a booking under a moved epoch writes none, and neither does a hold found stale', ON, async ($, on) => {
      const release = gate()
      const reached = gate()
      const seen = engine(on, { noteHold: { until: release.until, reached: reached.open } })
      await workerTurn($)
      const sending = noteSent($, 'a.ts:4 before the switch.')
      await reached.until
      await off($)
      await on_($)
      release.open()
      expect(await sending).toEqual({ isDelivered: true })
      expect(debugLines(seen, ADDED)).toEqual([])
      expect(seen.conversation.memory).toEqual([])
    })

    test('a hold found stale writes no add line', ON, async ($, on) => {
      const release = gate()
      const reached = gate()
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN, noteHold: { until: release.until, reached: reached.open } })
      await workerTurn($)
      const sending = noteSent($, 'a.ts:4 before the switch.')
      await reached.until
      await off($)
      release.open()
      expect((await sending).isDelivered).toBe(false)
      expect(debugLines(seen, ADDED)).toEqual([])
      expect(debugLines(seen, 'nothing is held').length).toBe(1)
    })

    test('a booking whose compare-and-set misses and runs again writes its line once, and adds its entry once', ON, async ($, on) => {
      const t = trap()
      const release = gate()
      const seen = engine(on, { noteHold: { until: release.until, reached: t.arm }, holdWrite: t.hold })
      await workerTurn($)
      const sending = noteSent($, 'a.ts:4 swallows it.')
      await drained()
      release.open()
      await t.reached
      await $.prompt.submit(COMPOSER('meanwhile'))
      t.open()
      expect(await sending).toEqual({ isDelivered: true })
      expect(seen.conversation.record.blocks.join('')).toContain('USER: meanwhile')
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, ADDED).length).toBe(1)
    })

    test('a hold whose compare-and-set misses and runs again writes its line once', ON, async ($, on) => {
      const t = trap()
      const release = gate()
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN, noteHold: { until: release.until, reached: t.arm }, holdWrite: t.hold })
      await workerTurn($)
      const sending = noteSent($, 'a.ts:4 after the Esc.')
      await drained()
      release.open()
      await t.reached
      await $.prompt.submit(COMPOSER('meanwhile'))
      t.open()
      expect((await sending).isDelivered).toBe(false)
      expect(seen.conversation.record.blocks.join('')).toContain('USER: meanwhile')
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 after the Esc.')])
      expect(debugLines(seen, ADDED).length).toBe(1)
    })
  })

  describe('the bound at a dispatch', () => {
    test('an entry more than 30 reviews below the new review is dropped before the brief is built, and one exactly 30 below is kept', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(1), entry(2), entry(31)], 31) })
      await $.classic.Stop(stop)
      expect(seen.conversation.review).toMatchObject({ number: 32 })
      expect(seen.conversation.memory).toEqual([entry(2), entry(31)])
      const brief = memoryOf(seen.spawns[0].prompt)
      expect(brief).not.toContain('Review 1 (')
      expect(brief).toContain(inFlight(2))
      expect(brief).toContain(inFlight(31))
    })

    test('a memory over 12,000 code points loses its oldest entries first until the brief\'s memory part holds at most 12,000', ON, async ($, on) => {
      const big = (n: number): MemoryEntry => ({ number: n, text: `${n}`.repeat(2_000).slice(0, 2_000) })
      const entries = [20, 21, 22, 23, 24, 25, 26, 27].map(big)
      const seen = engine(on, { stateSeed: stored(entries, 27) })
      await $.classic.Stop(stop)
      const kept = seen.conversation.memory.map((e: MemoryEntry) => e.number)
      expect(kept).toEqual([23, 24, 25, 26, 27])
      expect(kept.length).toBeLessThan(entries.length)
      const part = memoryOf(seen.spawns[0].prompt)
      expect(part).toBe(renderMemory(seen.conversation.memory))
      expect(Array.from(part).length).toBeLessThanOrEqual(12_000)
      // One entry more would not have fitted.
      expect(Array.from(renderMemory([big(22), ...seen.conversation.memory])).length).toBeGreaterThan(12_000)
    })

    test('a dispatch that ages out and evicts writes one line with the review number and both counts', ON, async ($, on) => {
      const big = (n: number): MemoryEntry => ({ number: n, text: `${n}`.repeat(2_000).slice(0, 2_000) })
      const seen = engine(on, { stateSeed: stored([entry(1), entry(2), ...[20, 21, 22, 23, 24, 25, 26, 27].map(big)], 27 + 5) })
      await $.classic.Stop(stop)
      // Review 33: entries 1 and 2 are more than 30 below it; of the eight large ones, three fall to the cap.
      expect(debugLines(seen, BOUND)).toEqual([expect.stringContaining("review 33's dispatch aged out 2 and evicted 3 memory entries")])
    })

    test('a dispatch that drops nothing writes no bound line', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(1)], 3) })
      await $.classic.Stop(stop)
      expect(debugLines(seen, BOUND)).toEqual([])
      expect(seen.conversation.memory).toEqual([entry(1)])
    })

    test('a dispatch whose compare-and-set misses and runs again writes its bound line once', ON, async ($, on) => {
      const t = trap()
      const seen = engine(on, { stateSeed: stored([entry(1), entry(2)], 31), sessionIdHold: { from: 1, to: 1, until: Promise.resolve(), reached: t.arm }, holdWrite: t.hold })
      const stopping = $.classic.Stop(stop)
      await t.reached
      await $.prompt.submit(COMPOSER('meanwhile'))
      t.open()
      await stopping
      expect(debugLines(seen, BOUND)).toEqual([expect.stringContaining("review 32's dispatch aged out 1 and evicted 0 memory entries")])
      expect(seen.conversation.memory).toEqual([entry(2)])
      expect(seen.conversation.review).toMatchObject({ number: 32 })
    })

    test('a dispatch that plans no review bounds nothing', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(1)], 40, { record: { blocks: [] } }) })
      await $.classic.Stop(stop)
      expect(seen.spawns).toEqual([])
      expect(seen.conversation.memory).toEqual([entry(1)])
      expect(debugLines(seen, BOUND)).toEqual([])
    })
  })

  describe('the briefs', () => {
    test('a brief with an empty memory carries no memory heading', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      expect(seen.spawns[0].prompt).not.toContain(renderMemory([entry(1)]).split('\n')[0])
      expect(seen.spawns[0].prompt.split('\n')[0]).toBe(FINISHED)
    })

    test('a spawn\'s brief and a re-brief each carry every entry, with its review number and text', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(4, 'a.ts:4 first.'), entry(5, 'a.ts:5 second.')], 6) })
      await $.classic.Stop(stop)
      await turnEnded($, 'ag1', 'Nothing to note.')
      await $.prompt.submit(COMPOSER('again'))
      await $.classic.Stop(stop)
      for (const brief of [seen.spawns[0].prompt, seen.sends[0].text]) {
        expect(memoryOf(brief)).toBe(renderMemory([entry(4, 'a.ts:4 first.'), entry(5, 'a.ts:5 second.')]))
        expect(memoryOf(brief)).toContain(inFlight(4, 'a.ts:4 first.'))
        expect(memoryOf(brief)).toContain(inFlight(5, 'a.ts:5 second.'))
      }
    })

    test('no memory text reaches the worker: the notes held for it carry the reviewer\'s note alone', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(1, 'a.ts:1 earlier.')], 1) })
      await $.classic.Stop(stop)
      await $.prompt.submit(COMPOSER('carry on'))
      expect(seen.contexts).toEqual([undefined])
      expect(seen.prompts.join('\n')).not.toContain('a.ts:1 earlier.')
    })
  })

  describe('its lifetime', () => {
    const withEntries = async ($: any, on: any) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, 'a.ts:4 swallows it.')
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      return seen
    }

    test('a /clear leaves it empty', ON, async ($, on) => {
      const seen = await withEntries($, on)
      await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
      expect(seen.conversation.memory).toEqual([])
    })

    test('a switch to on leaves it empty, and a switch to off leaves it as it was, and `/auditor memory` prints its entries while off', ON, async ($, on) => {
      const seen = await withEntries($, on)
      await off($)
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(await printed($)).toContain(inFlight(1, 'a.ts:4 swallows it.'))
      await on_($)
      expect(seen.conversation.memory).toEqual([])
    })

    test('a /compact of the worker leaves it as it was', ON, async ($, on) => {
      const seen = await withEntries($, on)
      await $.session.compact({ trigger: 'plugin' as const, messages: [{ role: 'user' as const, text: 'fix the parser', toolUses: [] }] } as any)
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
    })

    test('while the auditor is off no entry is taken, since no note is booked', ON, async ($, on) => {
      const seen = await withEntries($, on)
      await off($)
      await workerTurn($, 'Second.')
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
    })
  })

  describe('a state stored before the memory', () => {
    test('reads with an empty memory and dispatches as usual, its stored delivered notes read by nothing', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: { dispatches: 1, reviewerIds: [], deliveredNotes: ['auditor, review 1:\na.ts:4 old.'], record: { blocks: ['[1] USER: x\n\n'] }, lastMessage: 'Done.' } })
      await $.classic.Stop(stop)
      expect(seen.spawns.length).toBe(1)
      expect(seen.spawns[0].prompt.split('\n')[0]).toBe(FINISHED)
      expect(seen.spawns[0].prompt).not.toContain('a.ts:4 old.')
      expect(seen.conversation.memory).toEqual([])
      expect(await printed($)).toBe('auditor memory is empty')
    })
  })

  describe('/auditor memory', () => {
    test('prints a count line, then every stored entry with its review number and text', ON, async ($, on) => {
      engine(on, { stateSeed: stored([entry(4, 'a.ts:4 first.'), entry(5, 'a.ts:5 second.\nMore.')], 6) })
      expect(await printed($)).toBe(`auditor memory holds 2 entries, 2 in flight and 0 settled:\n\n${inFlight(4, 'a.ts:4 first.')}\n\n${inFlight(5, 'a.ts:5 second. More.')}`)
    })

    test('says so when the memory is empty', ON, async ($, on) => {
      engine(on)
      expect(await printed($)).toBe('auditor memory is empty')
    })

    test('changes nothing, on or off: no state is written, and the memory, the toggle and every other field stay as they were', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(4)], 6) })
      await $.classic.Stop(stop)
      for (const switchOff of [false, true]) {
        if (switchOff) await off($)
        const before = structuredClone(seen.conversation)
        const writes = seen.conversations.length
        await printed($)
        expect(seen.conversations.length).toBe(writes)
        expect(seen.conversation).toEqual(before)
        expect(seen.conversation.off).toBe(switchOff)
        expect(seen.conversation.memory).toEqual([entry(4)])
      }
    })
  })

  describe('the memory tool', () => {
    const SETTLE = MEMORY_ACTION.settle
    const REMOVE = MEMORY_ACTION.remove
    const CHANGED = 'memory entry for review'
    // The reviewer (ag1 unless told otherwise; null for the main loop) calls the memory tool; resolves to the tool's answer.
    const memoryCall = ($: any, action: unknown, review: unknown, why: unknown, agentId: string | null = 'ag1') =>
      $.tool.call({ tool: MEMORY, ...(agentId === null ? {} : { agentId }), [MEMORY_FIELD.action]: action, [MEMORY_FIELD.review]: review, [MEMORY_FIELD.why]: why })
    const settled = (number: number, touched: number, why: string, text = `a.ts:${number} note.`): MemoryEntry => ({ number, text, kind: 'settled', touched, why })
    // Review 1 open under ag1, its note booked as an in-flight entry.
    const noted = async ($: any, on: any, opts: Opts = {}) => {
      const seen = engine(on, opts)
      await workerTurn($)
      await noteSent($, 'a.ts:4 swallows it.')
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      return seen
    }
    // Review 1's note is booked and review 1 ends, then review 2 opens under ag1: an entry review 1 booked is one review 2 may settle.
    const notedThenNext = async ($: any, on: any, opts: Opts = {}) => {
      const seen = await noted($, on, opts)
      await turnEnded($, 'ag1', '')
      await $.prompt.submit(COMPOSER('next'))
      await $.classic.Stop(stop)
      expect(seen.conversation.review).toMatchObject({ number: 2 })
      return seen
    }

    test('is registered deferred under the short name the engine names MEMORY, with the fields and actions memory.ts names, all required', ON, async ($, on) => {
      const seen = engine(on)
      await $.session.start({ cwd: '/', surface: null, isInteractive: true })
      const tool = seen.registeredTools.find(t => `mcp__auditor__${t.name}` === MEMORY)
      expect(tool).toMatchObject({ isDeferred: true })
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(Object.values(MEMORY_FIELD).sort())
      expect(tool.inputSchema.properties[MEMORY_FIELD.action].enum).toEqual([SETTLE, REMOVE])
      expect(tool.inputSchema.properties[MEMORY_FIELD.review]).toMatchObject({ type: 'integer', minimum: 1 })
      expect([...tool.inputSchema.required].sort()).toEqual(Object.values(MEMORY_FIELD).sort())
      expect(seen.registered[0].tools).toContain(MEMORY)
    })

    test('a caller that is not the current reviewer is denied with the reviewer tools\' refusal, and the memory is unchanged', ON, async ($, on) => {
      const seen = await noted($, on)
      for (const agentId of [null, 'sub1', 'zz']) {
        expect(await memoryCall($, SETTLE, 1, 'countered', agentId)).toMatchObject({ deny: REFUSED })
      }
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    test('a former reviewer, forgotten at a /clear, is denied, and the memory is unchanged', ON, async ($, on) => {
      const seen = await noted($, on)
      await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
      const writes = seen.conversations.length
      expect(await memoryCall($, REMOVE, 1, 'fixed')).toMatchObject({ deny: REFUSED })
      expect(seen.conversations.length).toBe(writes)
      expect(seen.conversation.memory).toEqual([])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    test('settle turns an in-flight entry settled with its reason, touched at the open review, and answers with its review number and new state', ON, async ($, on) => {
      const seen = await notedThenNext($, on)
      const why = 'the worker countered at transcript line 12: the error is rethrown by the caller'
      expect(await memoryCall($, SETTLE, 1, why)).toEqual({ result: `Review 1's entry is now settled, with the reason: ${why}` })
      expect(seen.conversation.memory).toEqual([settled(1, 2, why, 'a.ts:4 swallows it.')])
    })

    test('settling a settled entry again replaces its reason and moves its last touch to the open review, so it ages from there; remove takes either kind out', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([settled(2, 3, 'first counter'), entry(4)], 5) })
      await $.classic.Stop(stop)
      expect(seen.conversation.review).toMatchObject({ number: 6 })
      expect(await memoryCall($, SETTLE, 2, 'met again; the counter at line 40 holds')).toEqual({ result: "Review 2's entry is now settled, with the reason: met again; the counter at line 40 holds" })
      expect(seen.conversation.memory).toEqual([settled(2, 6, 'met again; the counter at line 40 holds'), entry(4)])
      expect(await memoryCall($, REMOVE, 4, 'fixed: a.ts:4 now rethrows, read at line 9')).toEqual({ result: "Review 4's entry is removed." })
      expect(await memoryCall($, REMOVE, 2, 'new evidence: c.test.ts:30 fails')).toEqual({ result: "Review 2's entry is removed." })
      expect(seen.conversation.memory).toEqual([])
    })

    test('an entry settled again is kept at a dispatch more than 30 reviews after its key and within 30 of its last touch', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(2)], 31) })
      await $.classic.Stop(stop)
      await memoryCall($, SETTLE, 2, 'countered at line 5')
      await turnEnded($, 'ag1', '')
      await $.prompt.submit(COMPOSER('again'))
      await $.classic.Stop(stop)
      // Review 33 is 31 past the entry's key, which would age it out; settling at review 32 moved its touch.
      expect(seen.conversation.review).toMatchObject({ number: 33 })
      expect(seen.conversation.memory).toEqual([settled(2, 32, 'countered at line 5')])
    })

    test('a dispatch ages a settled entry by its last touch: kept at 30 reviews past it, while an in-flight entry with a later key is dropped', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([settled(2, 21, 'countered at line 5'), entry(3)], 50) })
      await $.classic.Stop(stop)
      expect(seen.conversation.memory).toEqual([settled(2, 21, 'countered at line 5')])
    })

    test('each refusal reaches the reviewer as its reason, leaves the memory unchanged and writes no debug line', ON, async ($, on) => {
      const seen = await noted($, on)
      const cases: [unknown, unknown, unknown, string][] = [
        ['reopen', 1, 'ok', 'action must be settle or remove, so the memory was not changed'],
        [undefined, 1, 'ok', 'action must be settle or remove, so the memory was not changed'],
        [SETTLE, undefined, 'ok', 'review is missing: give the review number of the entry to change, so the memory was not changed'],
        [SETTLE, '1', 'ok', 'review must be a whole review number, so the memory was not changed'],
        [SETTLE, 1.5, 'ok', 'review must be a whole review number, so the memory was not changed'],
        [REMOVE, 7, 'ok', 'the memory holds no entry for review 7, so it was not changed'],
        [SETTLE, 1, undefined, 'why is missing or blank, so the memory was not changed'],
        [SETTLE, 1, '   ', 'why is missing or blank, so the memory was not changed'],
        [SETTLE, 1, 'w'.repeat(401), 'why is 401 characters, over the 400 allowed, so the memory was not changed'],
        [SETTLE, 1, 'ok', "review 1 is this review's own entry, which the worker has not answered yet, and a settle needs the worker's counter, so the memory was not changed"],
      ]
      for (const [action, review, why, refusal] of cases) expect(await memoryCall($, action, review, why)).toEqual({ result: refusal })
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    test('with no open review, the call is refused and the memory unchanged', ON, async ($, on) => {
      const seen = await noted($, on)
      await turnEnded($, 'ag1', '')
      expect(seen.conversation.review).toBeUndefined()
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
      expect(await memoryCall($, SETTLE, 1, 'countered')).toEqual({ result: 'auditor has no review in progress for this reviewer, so the memory was not changed' })
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    // The call's change reads the review open, and its write is held while `meanwhile` lands; the change then runs again on the state `meanwhile` left.
    const landsAfter = async ($: any, on: any, meanwhile: () => Promise<unknown>) => {
      const t = trap()
      const seen = await notedThenNext($, on, { holdWrite: t.hold })
      t.arm()
      const calling = memoryCall($, SETTLE, 1, 'countered at line 3')
      await t.reached
      await meanwhile()
      t.open()
      return { seen, answer: await calling }
    }

    test('a call that lands after a /clear changes nothing, and its result is the review-ended text', ON, async ($, on) => {
      const { seen, answer } = await landsAfter($, on, () => $.session.end({ reason: 'clear', sessionId: 's1' } as any))
      expect(answer).toEqual({ result: REVIEW_ENDED })
      expect(seen.conversation.memory).toEqual([])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    test('a call that lands after a switch changes nothing, and its result is the review-ended text', ON, async ($, on) => {
      const { seen, answer } = await landsAfter($, on, () => off($))
      expect(answer).toEqual({ result: REVIEW_ENDED })
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    test('a call that lands after its review\'s settle changes nothing, and its result is the review-ended text, though the next review is open under the same reviewer', ON, async ($, on) => {
      const { seen, answer } = await landsAfter($, on, async () => {
        await turnEnded($, 'ag1', '')
        await $.prompt.submit(COMPOSER('next'))
        await $.classic.Stop(stop)
      })
      expect(seen.conversation.review).toMatchObject({ number: 3 })
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
      expect(answer).toEqual({ result: REVIEW_ENDED })
      expect(seen.conversation.memory).toEqual([entry(1, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, CHANGED)).toEqual([])
    })

    test('a settle writes one debug line with the review number, the change and its why clipped to 180, also when its compare-and-set ran more than once', ON, async ($, on) => {
      const why = 'w'.repeat(300)
      const t = trap()
      const seen = await notedThenNext($, on, { holdWrite: t.hold })
      t.arm()
      const calling = memoryCall($, SETTLE, 1, why)
      await t.reached
      await $.prompt.submit(COMPOSER('meanwhile'))
      t.open()
      expect((await calling).result).toContain("Review 1's entry is now settled")
      expect(seen.conversation.record.blocks.join('')).toContain('USER: meanwhile')
      expect(seen.conversation.memory).toEqual([settled(1, 2, why, 'a.ts:4 swallows it.')])
      expect(debugLines(seen, CHANGED)).toEqual([`auditor: memory entry for review 1 settled: ${'w'.repeat(180)} …+120 characters`])
    })

    test('a remove writes one debug line with the review number, the change, the removed entry\'s text and its why, each clipped to 180', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, 't'.repeat(200))
      await memoryCall($, REMOVE, 1, 'fixed: read at a.ts:9')
      expect(debugLines(seen, CHANGED)).toEqual([`auditor: memory entry for review 1 removed: ${'t'.repeat(180)} …+20 characters; why: fixed: read at a.ts:9`])
    })

    test('no memory call enters the worker\'s record, and no memory text reaches the worker', ON, async ($, on) => {
      const why = 'the worker countered at transcript line 12'
      const seen = await notedThenNext($, on)
      await memoryCall($, SETTLE, 1, why)
      await memoryCall($, SETTLE, 9, 'refused')
      expect(seen.conversation.record.blocks.join('')).not.toContain(MEMORY)
      expect(await entriesOf($, { which: 'live' })).toBe(NONE_SINCE(2))
      await turnEnded($, 'ag1', 'Nothing to note.')
      await $.prompt.submit(COMPOSER('carry on'))
      await $.classic.Stop(stop)
      // Review 3's brief, the second send to the reviewer, carries the entry settled in review 2; the worker's prompts and notes carry none of it.
      expect(seen.sends[1].text).toContain(why)
      expect([...seen.prompts, ...seen.contexts.flat().filter((c: unknown) => c !== undefined), ...toMain(seen)].join('\n')).not.toContain(why)
      expect(seen.conversation.record.blocks.join('')).not.toContain(MEMORY)
    })

    test('the brief and `/auditor memory` show each entry\'s kind, both review numbers and a settled entry\'s reason, in-flight entries first', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(2, 'a.ts:2 first.'), entry(4, 'a.ts:4 second.')], 5) })
      await $.classic.Stop(stop)
      await memoryCall($, SETTLE, 2, 'countered at line 8')
      const settledLine = 'Review 2 (settled, last touched in review 6; the reason: countered at line 8): a.ts:2 first.'
      expect(await printed($)).toBe(`auditor memory holds 2 entries, 1 in flight and 1 settled:\n\n${inFlight(4, 'a.ts:4 second.')}\n\n${settledLine}`)
      await turnEnded($, 'ag1', 'Nothing to note.')
      await $.prompt.submit(COMPOSER('again'))
      await $.classic.Stop(stop)
      expect(memoryOf(seen.sends[0].text).split('\n\n').slice(1)).toEqual([inFlight(4, 'a.ts:4 second.'), settledLine])
    })

    test('a memory stored before kinds reads with every entry in flight and touched at its key, and its entries settle', ON, async ($, on) => {
      const seen = engine(on, { stateSeed: stored([entry(1), entry(3)], 31) })
      expect(await printed($)).toBe(`auditor memory holds 2 entries, 2 in flight and 0 settled:\n\n${inFlight(1)}\n\n${inFlight(3)}`)
      await $.classic.Stop(stop)
      // Review 32: entry 1, touched at its key, is more than 30 below it.
      expect(seen.conversation.memory).toEqual([entry(3)])
      expect(await memoryCall($, SETTLE, 3, 'countered')).toMatchObject({ result: "Review 3's entry is now settled, with the reason: countered" })
      expect(seen.conversation.memory).toEqual([settled(3, 32, 'countered')])
    })
  })
})

describe('the prompt on the memory', () => {
  const { settle: SETTLE, remove: REMOVE } = MEMORY_ACTION
  const { action: ACTION, review: REVIEW, why: WHY } = MEMORY_FIELD
  // The after-challenge state whose line opens with `name`.
  const stateLine = (name: string): string => REVIEWER_PROMPT.split('\n').find(line => line.startsWith(`- **${name}**`)) ?? ''
  // The memory section: from its heading to the next.
  const section = (): string => {
    const start = REVIEWER_PROMPT.indexOf('### Your memory')
    const end = REVIEWER_PROMPT.indexOf('\n#', start + 1)
    return start < 0 ? '' : REVIEWER_PROMPT.slice(start, end < 0 ? undefined : end)
  }

  test('names the memory tool, its two actions and its fields by the names the tool accepts, as the registered reviewer reads it', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    const tool = seen.registeredTools.find(t => `mcp__auditor__${t.name}` === MEMORY)
    expect(prompt).toContain(`\`${MEMORY}\``)
    for (const action of [SETTLE, REMOVE]) {
      expect(prompt).toContain(`\`${ACTION}: "${action}"\``)
      expect(tool.inputSchema.properties[ACTION].enum).toContain(action)
    }
    for (const field of [REVIEW, WHY]) {
      expect(prompt).toContain(`\`${field}\``)
      expect(tool.inputSchema.properties[field]).toBeDefined()
    }
  })

  test('says the memory is the reviewer\'s own, never delivered to the worker, and not a note', () => {
    expect(section()).toContain('The memory is your own: it is never delivered to the worker, and it is not a note.')
  })

  test('Addressed and resolved removes the entry; Addressed with specifics, an accepted answer, calls nothing and leaves it in flight; neither state says both', () => {
    const resolved = stateLine('Addressed and resolved')
    const disputed = stateLine('Addressed with specifics (disputed)')
    expect(resolved).toContain('remove its entry from your memory')
    expect(disputed).toContain('A finding you drop because you accept the worker\'s answer calls no memory action: its entry stays in flight and ages out like any other.')
    expect(resolved).not.toMatch(/stays in flight|calls no memory action/)
    expect(disputed).not.toMatch(/remove/)
  })

  test('a settle happens at a re-raise without new evidence, each later meeting settles again, and both send nothing', () => {
    const memory = section()
    expect(memory).toContain('When you are about to raise a finding the worker already countered in the transcript, and you have no new evidence, do not raise it: settle its entry')
    expect(memory).toContain('and send nothing about it. Each later time you meet a finding a settled entry covers, settle that entry again, which refreshes its age, and send nothing about it.')
    expect(memory).toContain('A finding you drop when the worker answers it calls nothing: a silent drop is not a settle, and its entry stays in flight.')
  })

  test('a settle is the reviewer\'s claim for the whole note: settled only when every finding is answered or settled, and a partly answered note stays in flight', () => {
    const memory = section()
    expect(memory).toContain('An entry is one whole note, every finding in it. Settle an entry only when every finding in it is answered or settled; a partly answered note stays in flight')
    expect(memory).toContain(`the \`${WHY}\` of the settle that comes names what was answered`)
  })

  test('an entry is removed when met, for one of two causes, never as a sweep, and the reviewer is not asked to check every entry', () => {
    const memory = section()
    expect(memory).toContain('Remove an entry when you meet its finding, for one of two causes.')
    expect(memory).toContain('Your own review work shows its findings fixed or moot')
    expect(memory).toContain('Or you have new evidence that a settled finding must be raised again')
    expect(memory).toContain('Never remove entries as a sweep, and do not check every entry each review')
    expect(REVIEWER_PROMPT).not.toMatch(/check (each|every) entry (of|in) (the|your) memory/)
  })

  test('a settled finding is raised again only after removing its entry with a why naming new evidence, and the note then cites it', () => {
    const memory = section()
    expect(memory).toContain(`remove the settled entry with a \`${WHY}\` naming that evidence, then raise the finding in your note, citing it. A settled finding is not raised again otherwise.`)
  })

  test('a countered finding with no entry is judged as it would be with no memory', () => {
    expect(section()).toContain('A finding the worker countered that has no entry, because its entry aged out or was evicted, is judged as it would be with no memory: you may raise it once more if the worker\'s counter does not hold.')
  })
})

describe('the auditor\'s cost', () => {
  const HAIKU = 'claude-haiku-5-5'
  const PINNED = { model: HAIKU, agentId: 'ag1' }
  const billed = (over: Record<string, unknown> = {}) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: HAIKU, ...over })
  // A response that costs `n` dollars at the standard rates: output is $0.50 per million tokens.
  const worth = (n: number) => billed({ output_tokens: Math.round(n * 2_000_000) })
  const request = async ($: any, usage: unknown, agentId = 'ag1'): Promise<void> => {
    STEP_USAGE = usage
    try {
      await step($, '', agentId)
    } finally {
      STEP_USAGE = null
    }
  }
  const labelOf = async ($: any): Promise<string> => (await (await mountMode($)).find({ key: 'auditor-toggle' })).props.label
  const run = async ($: any, args = ''): Promise<string | undefined> => (await $.command.run({ command: 'auditor', args })).text
  const ONE_MESSAGE = [{ role: 'user' as const, text: 'fix the parser', toolUses: [] }]
  const compacting = (agentId: string) => ({ trigger: 'auto' as const, messages: ONE_MESSAGE, agentId }) as any

  test('the reviewer\'s model is the one pricing.ts has rates for', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registered[0].model).toBe(PRICED_MODEL)
  })

  test('each reviewer response adds its price to the tally, output included, and the label shows the dollars and the share of the ledger', ON, async ($, on) => {
    const seen = engine(on, { spawn: PINNED, ledger: 100 })
    otherMods(on)
    await workerTurn($)
    await request($, worth(0.5))
    await request($, worth(0.25))
    expect(closeTo(seen.conversation.spent, 0.75)).toBe(true)
    expect(await labelOf($)).toBe('auditor on ($0.75, 0.8%)')
  })

  test('with nothing spent yet the label reads auditor on and the ledger is not read', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    expect(await labelOf($)).toBe('auditor on')
    expect(seen.ledgerReads).toBe(0)
  })

  test('a tally of $50 against a ledger of $100 is 50%: the ledger counts the reviewer, so the share is not over the ledger plus the tally', ON, async ($, on) => {
    engine(on, { ledger: 100 })
    otherMods(on)
    await workerTurn($)
    await request($, worth(50))
    expect(await labelOf($)).toBe('auditor on ($50, 50%)')
  })

  test('a tally over the ledger reads 100%, never more', ON, async ($, on) => {
    engine(on, { ledger: 10 })
    otherMods(on)
    await workerTurn($)
    await request($, worth(50))
    expect(await labelOf($)).toBe('auditor on ($50, 100%)')
  })

  test('a response over 100,000 tokens of prompt is priced whole at the higher rates, and a large output under it is not', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await request($, billed({ cache_read_input_tokens: 100_001, output_tokens: 1_000_000 }))
    expect(closeTo(seen.conversation.spent, 100_001 * 0.05 / 1_000_000 + 2.5)).toBe(true)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await workerTurn($)
    await request($, billed({ cache_read_input_tokens: 99_999, output_tokens: 1_000_000 }))
    expect(closeTo(seen.conversation.spent, 99_999 * 0.01 / 1_000_000 + 0.5)).toBe(true)
  })

  test('a response reporting the pinned id with a date suffix is priced as the pinned model', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await request($, billed({ model: `${HAIKU}-20261001`, output_tokens: 1_000_000 }))
    expect(seen.conversation).toMatchObject({ unpriced: null })
    expect(closeTo(seen.conversation.spent, 0.5)).toBe(true)
  })

  test('a response reporting any other id leaves the cost unknown: the label drops the figures, the popup names the model, and later responses do not make it known', ON, async ($, on) => {
    const seen = engine(on, { ledger: 100 })
    otherMods(on)
    await workerTurn($)
    await request($, worth(1))
    await request($, billed({ model: 'haiku', output_tokens: 10 }))
    await request($, worth(1))
    expect(seen.conversation).toMatchObject({ unpriced: 'haiku' })
    const ui = await mountMode($)
    await buttonReads(ui, 'on')
    expect(await ui.find({ type: 'Text', text: 'cost unknown: no price for haiku' })).toBeDefined()
  })

  test('a late response of a reviewer retired before it landed adds to the tally and leaves the current reviewer\'s tracked context alone', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], spawn: undefined })
    await workerTurn($)
    await request($, billed({ input_tokens: 80_001 }))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.conversation.reviewer.id).toBe('ag2')
    await request($, billed({ input_tokens: 5_000 }), 'ag2')
    const before = seen.conversation
    await request($, worth(1), 'ag1')
    expect(closeTo(seen.conversation.spent, before.spent + 1)).toBe(true)
    expect(seen.conversation.reviewerContext).toBe(before.reviewerContext)
  })

  test('a follow-up turn\'s response of the current reviewer counts like any other', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await request($, worth(0.1))
    await request($, worth(0.2))
    expect(closeTo(seen.conversation.spent, 0.3)).toBe(true)
    expect(seen.conversation.reviewerContext).toBe(0)
  })

  test('a response from an agent that is not a reviewer adds nothing', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await request($, worth(5), 'sub1')
    await step($, 'the worker answers')
    expect(seen.conversation.spent).toBe(0)
  })

  test('a reviewer compaction with usage adds it at the reviewer\'s model, and one without adds nothing', ON, async ($, on) => {
    const withUsage = engine(on, { spawn: PINNED, compactUsage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    await workerTurn($)
    await $.session.compact(compacting('ag1'))
    expect(closeTo(withUsage.conversation.spent, 0.01)).toBe(true)
  })

  test('a reviewer compaction without usage leaves the tally unchanged', ON, async ($, on) => {
    const seen = engine(on, { spawn: PINNED })
    await workerTurn($)
    await request($, worth(1))
    await $.session.compact(compacting('ag1'))
    expect(closeTo(seen.conversation.spent, 1)).toBe(true)
  })

  test('a compaction of the worker\'s own conversation adds nothing', ON, async ($, on) => {
    const seen = engine(on, { spawn: PINNED, compactUsage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    await workerTurn($)
    await $.session.compact({ trigger: 'manual' as const, messages: ONE_MESSAGE } as any)
    expect(seen.conversation.spent).toBe(0)
  })

  test('switching off empties the tally, a response landing while off adds nothing, and switching on starts from zero', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await workerTurn($)
    await request($, worth(2))
    await run($, 'off')
    expect(seen.conversation).toMatchObject({ spent: 0, unpriced: null })
    expect(await labelOf($)).toBe('auditor off')
    await request($, worth(2))
    expect(seen.conversation.spent).toBe(0)
    await run($, 'on')
    expect(seen.conversation.spent).toBe(0)
    expect(await labelOf($)).toBe('auditor on')
  })

  test('switching off clears an unknown cost too', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await request($, billed({ model: 'haiku' }))
    await run($, 'off')
    await run($, 'on')
    expect(seen.conversation.unpriced).toBeNull()
  })

  test('the toggle button purges the tally the same way', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await workerTurn($)
    await request($, worth(2))
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    expect(seen.conversation.spent).toBe(0)
  })

  test('failing keeps the figures', ON, async ($, on) => {
    engine(on, { ledger: 100 })
    otherMods(on)
    await workerTurn($)
    await request($, worth(2))
    await turnFailed($, 'ag1')
    expect(await labelOf($)).toBe('auditor failing ($2.00, 2%)')
  })

  test('a /clear or a resume empties the tally', ON, async ($, on) => {
    const seen = engine(on)
    for (const reason of ['clear', 'resume'] as const) {
      await workerTurn($)
      await request($, worth(2))
      expect(seen.conversation.spent).toBeGreaterThan(0)
      await $.session.end({ reason, sessionId: 's1' } as any)
      expect(seen.conversation.spent).toBe(0)
    }
  })

  test('a session start of any source keeps a non-zero tally unchanged', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await request($, worth(2))
    const spent = seen.conversation.spent
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      await $.classic.SessionStart({ source, transcript_path: '/tmp/w.jsonl' } as any)
      expect(seen.conversation.spent).toBe(spent)
    }
  })

  test('a conversation stored before the tally existed reads with a zero tally', ON, async ($, on) => {
    const seen = engine(on, { stateSeed: { dispatches: 3, off: false, epoch: 1 } })
    otherMods(on)
    expect(await labelOf($)).toBe('auditor on')
    await workerTurn($)
    await request($, worth(1))
    expect(closeTo(seen.conversation.spent, 1)).toBe(true)
  })

  describe('the ledger reader', () => {
    test('a ledger with no cost leaves the share unknown: the label shows the dollars alone', ON, async ($, on) => {
      const seen = engine(on, { ledger: 'absent' })
      otherMods(on)
      await workerTurn($)
      await request($, worth(5))
      expect(await labelOf($)).toBe('auditor on ($5.00)')
      expect(debugLines(seen, 'session cost read')).toEqual([])
    })

    test('a non-finite figure leaves the share unknown', ON, async ($, on) => {
      const seen = engine(on, { ledger: 'nan' })
      otherMods(on)
      await workerTurn($)
      await request($, worth(5))
      expect(await labelOf($)).toBe('auditor on ($5.00)')
      expect(debugLines(seen, 'session cost read')).toEqual([])
    })

    test('a negative figure leaves the share unknown', ON, async ($, on) => {
      const seen = engine(on, { ledger: -3 })
      otherMods(on)
      await workerTurn($)
      await request($, worth(5))
      expect(await labelOf($)).toBe('auditor on ($5.00)')
      expect(debugLines(seen, 'session cost read')).toEqual([])
    })

    // The reader with a hand-made `$`: the test engine cannot make a hook's call reject, so the rejection and the silence are staged here.
    const dollar = (usage: () => Promise<unknown>, after: (ms: number, fn: () => void) => { cancel: () => void }) => {
      const logs: string[] = []
      const $ = { session: { usage }, clock: { after }, ui: { log: (text: string) => logs.push(text) } } as any
      return { $, logs }
    }
    const never = () => ({ cancel: () => undefined })

    test('a rejected call reads unknown and is logged with its cause and stack', async () => {
      const { $, logs } = dollar(() => Promise.reject(new Error('ledger unavailable')), never)
      expect(await register.readLedger($)).toBeUndefined()
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain('auditor: session cost read failed')
      expect(logs[0]).toContain('ledger unavailable')
    })

    test('a call that does not answer when the one-second timer fires reads unknown, is logged, and cancels nothing it did not set', async () => {
      let fired = 0
      let cancelled = 0
      const { $, logs } = dollar(() => new Promise(() => undefined), (ms, fn) => {
        expect(ms).toBe(1000)
        fired++
        fn()
        return { cancel: () => { cancelled++ } }
      })
      expect(await register.readLedger($)).toBeUndefined()
      expect({ fired, cancelled }).toEqual({ fired: 1, cancelled: 1 })
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain('no answer within 1000 ms')
    })

    test('an answer cancels the timer and reads the dollars', async () => {
      let cancelled = 0
      const { $, logs } = dollar(async () => ({ cost: { usd: 12.5 } }), () => ({ cancel: () => { cancelled++ } }))
      expect(await register.readLedger($)).toBe(12.5)
      expect(cancelled).toBe(1)
      expect(logs).toEqual([])
    })

    test('a timer that cannot be set reads unknown and is logged', async () => {
      const { $, logs } = dollar(async () => ({ cost: { usd: 1 } }), () => { throw new Error('clock unavailable') })
      expect(await register.readLedger($)).toBeUndefined()
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain('clock unavailable')
    })
  })

  describe('the popup', () => {
    // The popup's texts, in the order the tree draws them.
    const rowsDrawn = async (ui: any): Promise<string[]> => {
      const drawn = JSON.stringify(await ui.drawn())
      return [...drawn.matchAll(/"key":"(cost|reviews|press|state)"[^]*?"children":\["([^"]+)"\]/g)].map(m => m[2] ?? '')
    }

    test('on: the cost row, the reviews row, then the press row, in order', ON, async ($, on) => {
      engine(on, { ledger: 410.27 })
      otherMods(on)
      await workerTurn($)
      await request($, worth(12.4))
      const ui = await mountMode($)
      expect(await rowsDrawn(ui)).toEqual(['auditor $12.40 since on · session $410.27 · 3% · API list prices', 'no reviews yet', 'click to switch off'])
    })

    test('with the share unknown the cost row has no session figure', ON, async ($, on) => {
      engine(on, { ledger: 'absent' })
      otherMods(on)
      await workerTurn($)
      await request($, worth(12.4))
      expect(await rowsDrawn(await mountMode($))).toEqual(['auditor $12.40 since on · API list prices', 'no reviews yet', 'click to switch off'])
    })

    test('off: no reviews, no figures, then click to switch on', ON, async ($, on) => {
      engine(on)
      otherMods(on)
      await run($, 'off')
      expect(await rowsDrawn(await mountMode($))).toEqual(['off: no reviews, no figures until switched on', 'click to switch on'])
    })

    test('the popup is out of the flow and shown on hover only, and never has more than four rows', ON, async ($, on) => {
      engine(on)
      otherMods(on)
      const ui = await mountMode($)
      const drawn = JSON.stringify(await ui.drawn())
      for (const part of ['"position":"absolute"', '"display":"none"', '"bottom":1', '"right":0', '"hover":{"display":"flex"}']) expect(drawn).toContain(part)
      expect((await rowsDrawn(ui)).length).toBeLessThanOrEqual(4)
    })

    test('a press on the button still switches the auditor, and the popup changes nothing on press', ON, async ($, on) => {
      const seen = engine(on)
      otherMods(on)
      const ui = await mountMode($)
      await ui.press({ key: 'auditor-toggle' })
      expect(seen.conversation.off).toBe(true)
      await buttonReads(ui, 'off')
    })
  })

  describe('/auditor', () => {
    test('bare answers the label the footer draws, then the popup rows', ON, async ($, on) => {
      engine(on, { ledger: 410.27 })
      otherMods(on)
      await workerTurn($)
      await request($, worth(12.4))
      const answer = await run($)
      expect(answer).toBe('auditor on ($12, 3%)\nauditor $12.40 since on · session $410.27 · 3% · API list prices\nno reviews yet\nclick to switch off')
      expect(answer?.split('\n')[0]).toBe(await labelOf($))
    })

    test('on and off answer the new state the same way', ON, async ($, on) => {
      engine(on)
      otherMods(on)
      expect(await run($, 'off')).toBe('auditor off\noff: no reviews, no figures until switched on\nclick to switch on')
      expect(await run($, 'on')).toBe('auditor on\nauditor $0.00 since on · API list prices\nno reviews yet\nclick to switch off')
    })

    test('failing and an unknown cost read as the footer does', ON, async ($, on) => {
      engine(on)
      otherMods(on)
      await workerTurn($)
      await request($, billed({ model: 'haiku' }))
      await turnFailed($, 'ag1')
      expect(await run($)).toBe('auditor failing\ncost unknown: no price for haiku\nno reviews yet\nclick to switch off\nfailing: the reviewer ended a turn without an answer')
    })

    test('the usage line and the memory print are unchanged, and the description names the cost', ON, async ($, on) => {
      const seen = engine(on)
      await $.session.start({ cwd: '/', surface: null, isInteractive: true })
      expect(await run($, 'bogus')).toBe('Usage: /auditor [on|off|memory]')
      expect(await run($, 'memory')).toBe(printMemory([]))
      expect(seen.commands.find(c => c.name === 'auditor').description).toMatch(/cost/)
    })
  })
})

describe('the review facts', () => {
  const run = async ($: any, args = ''): Promise<string> => (await $.command.run({ command: 'auditor', args })).text
  // The answer's rows after its label line.
  const rowsOf = async ($: any, args = ''): Promise<string[]> => (await run($, args)).split('\n').slice(1)
  const reviewsRow = async ($: any): Promise<string | undefined> => (await rowsOf($)).find(r => /reviews? yet|^\d+ reviews?/.test(r))
  const NOON = new Date(2026, 10, 9, 14, 32).getTime()
  const QUIET = 'Nothing to note.'
  const STOPPED_MAIN = 'The main conversation was not messaged: the session was stopped and nobody has sent input since.'
  const BODY = 'a.ts:4 swallows it.'
  // The popup's rows as the footer draws them.
  const popupRows = async ($: any): Promise<string[]> => {
    const drawn = JSON.stringify(await (await mountMode($)).drawn())
    return [...drawn.matchAll(/"key":"(cost|reviews|press|state)"[^]*?"children":\["([^"]+)"\]/g)].map(m => m[2] ?? '')
  }

  describe('the reviews row', () => {
    test('a conversation with no review completed says so, and a state stored before the counters existed reads the same', ON, async ($, on) => {
      engine(on, { stateSeed: { dispatches: 3, off: false, epoch: 1 } })
      expect(await reviewsRow($)).toBe('no reviews yet')
    })

    test('a quiet review adds one review and no note, at the close time', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      seen.clock = NOON
      await $.turn.complete(TURN_END('ag1', QUIET))
      expect(seen.conversation).toMatchObject({ reviews: 1, notes: 0, last: { note: false } })
      expect(await reviewsRow($)).toBe('1 review · no notes · last at 14:32, quiet')
    })

    test('a review with a note adds a review and a note, and says so', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      seen.clock = NOON
      await turnEnded($, 'ag1', BODY)
      expect(seen.conversation).toMatchObject({ reviews: 1, notes: 1, last: { note: true } })
      expect(await reviewsRow($)).toBe('1 review · 1 note · last at 14:32, note sent')
    })

    test('the counts grow by review, and the last review is the latest', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await turnEnded($, 'ag1', BODY)
      await workerTurn($, 'More.')
      await $.turn.complete(TURN_END('ag1', QUIET))
      await workerTurn($, 'Again.')
      seen.clock = NOON
      await $.turn.complete(TURN_END('ag1', QUIET))
      expect(await reviewsRow($)).toBe('3 reviews · 1 note · last at 14:32, quiet')
    })

    test('a review that ends without an answer is not counted', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await turnFailed($, 'ag1')
      expect(seen.conversation.reviews).toBe(0)
      expect(await reviewsRow($)).toBe('no reviews yet')
    })

    test('switching off and on, or a /clear, restarts the facts', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await turnEnded($, 'ag1', BODY)
      expect(await reviewsRow($)).toMatch(/^1 review/)
      await run($, 'off')
      await run($, 'on')
      expect(await reviewsRow($)).toBe('no reviews yet')
      expect(seen.conversation).toMatchObject({ reviews: 0, notes: 0 })
      await workerTurn($)
      await turnEnded($, 'ag1', BODY)
      expect(await reviewsRow($)).toMatch(/^1 review/)
      await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
      expect(await reviewsRow($)).toBe('no reviews yet')
      expect(seen.conversation.last).toBeUndefined()
    })

    test('off shows no review facts, in /auditor or the popup', ON, async ($, on) => {
      engine(on)
      otherMods(on)
      await workerTurn($)
      await turnEnded($, 'ag1', BODY)
      await run($, 'off')
      expect(await rowsOf($)).toEqual(['off: no reviews, no figures until switched on', 'click to switch on'])
      expect(await popupRows($)).toEqual(['off: no reviews, no figures until switched on', 'click to switch on'])
    })
  })

  describe('notes held', () => {
    test('a note held for the next prompt counts as given and shows in the held row until a prompt attaches it', ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
      otherMods(on)
      await workerTurn($)
      await noteSent($, BODY)
      expect(seen.conversation).toMatchObject({ notes: 1, pendingNotes: [{ number: 1, text: BODY }] })
      expect((await rowsOf($)).at(-1)).toBe('1 note held for your next prompt')
      seen.clock = NOON
      await $.turn.complete(TURN_END('ag1', 'Sent.'))
      expect(await reviewsRow($)).toBe('1 review · 1 note · last at 14:32, note sent')
      await $.prompt.submit(COMPOSER('carry on'))
      expect(seen.conversation.pendingNotes).toEqual([])
      expect((await rowsOf($)).some(r => r.includes('held'))).toBe(false)
      expect(seen.conversation.notes).toBe(1)
    })

    test('a delivered note is counted once and shows no held row', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await noteSent($, BODY)
      expect(seen.conversation.notes).toBe(1)
      expect((await rowsOf($)).some(r => r.includes('held'))).toBe(false)
    })

    test('a switch off drops the held notes and their row', ON, async ($, on) => {
      const seen = engine(on, { noteFailsAt: [1], refusal: STOPPED_MAIN })
      await workerTurn($)
      await noteSent($, BODY)
      await run($, 'off')
      await run($, 'on')
      expect(seen.conversation.pendingNotes).toEqual([])
      expect((await rowsOf($)).some(r => r.includes('held'))).toBe(false)
    })
  })

  describe('the failure cause', () => {
    const stateRow = async ($: any): Promise<string | undefined> => (await rowsOf($)).find(r => r.startsWith('failing'))

    test('a turn end without an answer fails with the no-answer cause', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await turnFailed($, 'ag1')
      expect(seen.conversation.failing).toBe('no answer')
      expect(await stateRow($)).toBe('failing: the reviewer ended a turn without an answer')
    })

    const dispatches: [string, Opts][] = [['a spawn that is refused', { spawnDeniesFrom: 1 }], ['a spawn that throws', { spawnThrows: 'spawn broke' }], ['a spawn that returns no agent', { spawnNoId: true }], ['a brief whose send throws', { sendThrows: 'ag1', reviewerIds: ['ag1', 'ag2'], spawnThrowsFrom: 2 }]]
    for (const [how, opts] of dispatches) {
      test(`${how} fails with the not-dispatched cause`, ON, async ($, on) => {
        const seen = engine(on, opts)
        await workerTurn($)
        if ('sendThrows' in opts) {
          await $.turn.complete(TURN_END('ag1', QUIET))
          await workerTurn($, 'More.')
        }
        expect(seen.conversation.failing).toBe('not dispatched')
        expect(await stateRow($)).toBe('failing: a review could not be handed to a reviewer')
      })
    }

    test('a spawn that does not settle in ten minutes fails with the no-start cause', ON, async ($, on) => {
      const held = heldSpawn()
      const seen = engine(on, { spawnHold: { ...held.hold, to: 1 }, reviewerIds: ['ag1', 'ag2'] })
      await $.prompt.submit(COMPOSER('fix'))
      const stopping = $.classic.Stop(stop)
      await held.reached
      seen.clock += TEN_MINUTES + 1
      await $.prompt.submit(COMPOSER('again'))
      await $.classic.Stop(stop)
      expect(seen.conversation.failing).toBe('no start')
      expect(await stateRow($)).toBe('failing: the reviewer did not start in 10 minutes')
      held.land()
      await stopping
      await drained()
    })

    test('a conversation stored with failing true reads as the unknown cause', ON, async ($, on) => {
      engine(on, { stateSeed: { failing: true } })
      expect(await stateRow($)).toBe('failing: cause unknown; see the debug log')
    })

    test('a conversation stored with failing false is not failing', ON, async ($, on) => {
      engine(on, { stateSeed: { failing: false } })
      expect(await stateRow($)).toBeUndefined()
      expect((await run($)).split('\n')[0]).toBe('auditor on')
    })

    test('a brief the stored reviewer refuses, followed by a successful spawn, is not a failure', ON, async ($, on) => {
      const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
      await workerTurn($)
      await $.turn.complete(TURN_END('ag1', QUIET))
      await workerTurn($, 'More.')
      expect(seen.spawns.length).toBe(2)
      expect(seen.conversation.failing).toBeUndefined()
      expect(await stateRow($)).toBeUndefined()
    })

    test('a completed review clears the cause', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await turnFailed($, 'ag1')
      expect(seen.conversation.failing).toBe('no answer')
      await $.prompt.submit(COMPOSER('go on'))
      await workerTurn($, 'More.')
      await $.turn.complete(TURN_END('ag1', QUIET))
      expect(seen.conversation.failing).toBeUndefined()
      expect(await stateRow($)).toBeUndefined()
    })

    test('a switch off and on clears the cause', ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await turnFailed($, 'ag1')
      await run($, 'off')
      await run($, 'on')
      expect(seen.conversation.failing).toBeUndefined()
      expect(await stateRow($)).toBeUndefined()
    })
  })

  describe('the popup and /auditor agree', () => {
    test('failing with two notes held draws four rows in order, and /auditor answers the same four after its label', ON, async ($, on) => {
      engine(on, { stateSeed: { failing: 'no answer', reviews: 2, notes: 2, last: { at: NOON, note: true }, pendingNotes: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] } })
      otherMods(on)
      const expected = [
        'auditor $0.00 since on · API list prices',
        '2 reviews · 2 notes · last at 14:32, note sent',
        'click to switch off',
        'failing: the reviewer ended a turn without an answer · 2 notes held',
      ]
      expect(await popupRows($)).toEqual(expected)
      expect(await rowsOf($)).toEqual(expected)
    })

    test('every state draws the rows /auditor answers, never more than four', ON, async ($, on) => {
      engine(on, { stateSeed: { failing: true, reviews: 1, notes: 0, last: { at: NOON, note: false } } })
      otherMods(on)
      for (const args of ['', 'off', 'on']) {
        const answered = await rowsOf($, args)
        expect(await popupRows($)).toEqual(answered)
        expect(answered.length).toBeLessThanOrEqual(4)
      }
    })
  })
})

// Every let-go of the stored reviewer notes its reason in `lastLetGo` beside its stop.
describe('the reason the last reviewer was let go', () => {
  const contextOf = (tokens: number) => ({ ...USAGE, input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  // The reviewer's request, answered with `usage`. STEP_USAGE is module-level, so it is reset after the request.
  const requestWith = async ($: any, usage: unknown): Promise<void> => {
    STEP_USAGE = usage
    try {
      await step($, '', 'ag1')
    } finally {
      STEP_USAGE = null
    }
  }

  test('a conversation no reviewer was let go in has no reason', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.conversation.lastLetGo).toBeUndefined()
  })

  test('a rotation at a settle notes rotation and stops the retired id', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.conversation.lastLetGo).toBe('rotation')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a rotation by a failed dispatch notes rotation too', ON, async ($, on) => {
    const seen = engine(on, { sendThrows: 'ag1', stateSeed: { reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerContext: 80_001 } })
    await workerTurn($)
    expect(seen.conversation.lastLetGo).toBe('rotation')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a reviewer under the rotation limit leaves no reason', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await requestWith($, contextOf(80_000))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.conversation.lastLetGo).toBeUndefined()
  })

  test('a switch off notes switch off and stops the stored reviewer', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(seen.conversation.lastLetGo).toBe('switch off')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a switch off with no stored reviewer, and a switch on, leave the reason as it was', ON, async ($, on) => {
    const seen = engine(on, { stateSeed: { lastLetGo: 'rotation' } })
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    expect(seen.conversation.lastLetGo).toBe('rotation')
    expect(seen.stops).toEqual([])
  })

  test('a refused brief notes refused brief, and stops the refused reviewer after the spawn that replaces it', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await workerTurn($, 'Second.')
    expect(seen.conversation).toMatchObject({ reviewer: { id: 'ag2' }, lastLetGo: 'refused brief' })
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 2 }])
  })

  test('a spawn that lands after a switch off notes stale landing and is stopped', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold })
    const ending = workerTurn($)
    await held.reached
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    held.land()
    await ending
    await drained()
    expect(seen.conversation.lastLetGo).toBe('stale landing')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
  })

  test('a stale spawn whose agent was adopted by name in the current epoch is not let go', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }] })
    const first = workerTurn($)
    await held.reached
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    seen.clock += TEN_MINUTES + 1
    try {
      expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(NO_REVIEW)
    } finally {
      held.land()
    }
    await first
    await drained()
    expect(seen.conversation.lastLetGo).toBeUndefined()
    expect(seen.stops).toEqual([])
  })

  for (const reason of ['clear', 'resume', 'logout']) {
    test(`a session end with reason ${reason} notes session end and stops the stored reviewer`, ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await $.session.end({ reason, sessionId: 's1' } as any)
      expect(seen.conversation.lastLetGo).toBe('session end')
      expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    })
  }

  for (const reason of ['prompt_input_exit', 'other']) {
    test(`a session end with reason ${reason} notes session end and stops nothing`, ON, async ($, on) => {
      const seen = engine(on)
      await workerTurn($)
      await $.session.end({ reason, sessionId: 's1' } as any)
      expect(seen.conversation.lastLetGo).toBe('session end')
      expect(seen.toolCalls.filter((c: any) => c.tool === 'TaskStop')).toEqual([])
    })
  }

  test('a session end with no stored reviewer leaves the reason as it was', ON, async ($, on) => {
    const seen = engine(on, { stateSeed: { lastLetGo: 'switch off' } })
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.lastLetGo).toBe('switch off')
  })

  test('the reason reads the same after a /clear that lets no reviewer go', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.conversation.lastLetGo).toBe('rotation')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(seen.conversation.lastLetGo).toBe('rotation')
    expect(seen.conversation.reviewer).toBeUndefined()
  })
})

// What the review log says of the brief's wake-up line, of where the brief went and why, and of the follow-up.
describe('the fields of the review log that audit the brief', () => {
  const SHELL = { id: 'sh1', type: 'shell', status: 'running', description: 'npm test' }
  const requestPast = async ($: any): Promise<void> => {
    STEP_USAGE = { ...USAGE, input_tokens: 80_001 }
    try {
      await step($, '', 'ag1')
    } finally {
      STEP_USAGE = null
    }
  }
  // Review 1 is briefed and settles quiet; review 2 is then briefed, and the log of the second is the one read.
  const secondReview = async ($: any): Promise<void> => {
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await workerTurn($, 'Second.')
  }

  test('a brief that says nothing will wake the worker logs nothing_wakes true, one that names what will, or none, logs false', ON, async ($, on) => {
    const seen = engine(on)
    const rounds = [QUIET_STOP, { ...stop, background_tasks: [SHELL], session_crons: [] }, stop]
    for (const [i, facts] of rounds.entries()) {
      await $.prompt.submit(COMPOSER(`ask ${i}`))
      await $.classic.Stop(facts)
      await turnEnded($, 'ag1', 'Nothing to note.')
    }
    expect(seen.spawns[0].prompt).toContain('Nothing will wake the worker')
    expect(seen.sends[0].text).toContain('Will wake the worker')
    expect(logOf(seen, LOG_1)).toMatchObject({ nothing_wakes: true })
    expect(logOf(seen, LOG_2)).toMatchObject({ nothing_wakes: false })
    expect(logOf(seen, `${DIR}/0003.json`)).toMatchObject({ nothing_wakes: false })
  })

  test('a review whose reviewer wrote its note as its answer logs followed_up true, any other false', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete(TURN_END('ag1', FRAMED(1, 'a.ts:4 swallows it.')))
    await $.turn.complete(TURN_END('ag1', 'Sent.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', followed_up: true })
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', followed_up: false })
  })

  test('the first brief of a conversation goes to a spawn because there was no reviewer yet, and the next goes to the stored reviewer', ON, async ($, on) => {
    const seen = engine(on)
    await secondReview($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(logOf(seen, LOG_1)).toMatchObject({ brief_to: 'spawn: no reviewer yet' })
    expect(logOf(seen, LOG_2)).toMatchObject({ brief_to: 'stored' })
  })

  test('a brief after a rotation goes to a spawn because of the rotation', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestPast($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ brief_to: 'spawn: rotation' })
  })

  test('a brief the stored reviewer refused goes to a spawn because of the refusal', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await secondReview($)
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', brief_to: 'spawn: refused brief' })
  })

  test('a brief after a /clear goes to a spawn because the session ended', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ brief_to: 'spawn: session end' })
  })

  test('a brief after the auditor was switched off and on goes to a spawn because of the switch', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ brief_to: 'spawn: switch off' })
  })

  test('a brief whose spawn landed after a switch off goes, after the switch on, to a spawn because the landing was stale', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: held.hold, reviewerIds: ['ag1', 'ag2'] })
    const ending = workerTurn($)
    await held.reached
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    held.land()
    await ending
    await drained()
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ brief_to: 'spawn: stale landing' })
  })

  test('a log carries no route older than its own review: a legacy open review, stored without one, logs brief_to null', ON, async ($, on) => {
    const seed = { dispatches: 1, reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], review: { number: 1, record: ['USER: x'], dispatchedAt: 1, nothingWakes: false } }
    const seen = engine(on, { stateSeed: seed })
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', nothing_wakes: false, followed_up: false, brief_to: null })
  })

  test('an incomplete review whose reviewer gave no answer carries the three fields', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await turnFailed($, 'ag1')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', nothing_wakes: true, followed_up: false, brief_to: 'spawn: no reviewer yet' })
  })

  test('a review dropped by a switch off or a session end after its brief went out carries its route, the wake-up line and the follow-up', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'the auditor was switched off', nothing_wakes: true, followed_up: false, brief_to: 'spawn: no reviewer yet' })
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await $.prompt.submit(COMPOSER('more'))
    await $.classic.Stop(stop)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: 'session ended: clear', nothing_wakes: false, followed_up: false, brief_to: 'spawn: switch off' })
  })

  test('a review whose dispatch failed before any brief went out carries the three fields, brief_to null', ON, async ($, on) => {
    const seen = engine(on, { sendThrows: 'ag1', stateSeed: { reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'] } })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', nothing_wakes: true, followed_up: false, brief_to: null })
  })

  test('a review whose dispatch failed after its brief went out keeps its route: a spawn that answers with no agent id logs its spawn route', ON, async ($, on) => {
    const seen = engine(on, { spawnNoId: true })
    await workerTurn($)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn returned no agent id', brief_to: 'spawn: no reviewer yet' })
  })

  test('a refused spawn that fails its dispatch logs brief_to null', ON, async ($, on) => {
    const seen = engine(on, { spawn: { deny: 'no' } })
    await workerTurn($)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', nothing_wakes: false, followed_up: false, brief_to: null })
  })

  test('a review given back because the stopped session refused its brief logs brief_to null', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: 'Teammate "auditor-reviewer" was not messaged: the session was stopped and nobody has sent input since.' })
    await secondReview($)
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: 'given back: the session was stopped', nothing_wakes: false, followed_up: false, brief_to: null })
  })
})


// A reviewer spawn that rejects after its hook learned the agent's id: the id is let go and stopped. The engine skips a test hook that throws and rejects the call with this reason.
const NO_SPAWN = 'no implementation for agent.spawn'
describe('a rejected spawn', () => {
  test('whose hook learned an id stops that id, stores no reviewer, notes rejected spawn, and the next dispatch spawns fresh', ON, async ($, on) => {
    const opts: Opts = { spawnThrowsAfterLearning: 'spawn broke', reviewerIds: ['ag1', 'ag2'] }
    const seen = engine(on, opts)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await drained()
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 1 }])
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation).toMatchObject({ reviewerContext: 0, lastLetGo: 'rejected spawn', spawnsInFlight: [], briefsInFlight: [] })
    expect(seen.conversation.reviewerIds).toEqual(['ag1'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: NO_SPAWN, brief_to: null })
    opts.spawnThrowsAfterLearning = undefined
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(seen.sends).toEqual([])
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    expect(seen.conversation.review.briefTo).toBe('spawn: rejected spawn')
  })

  test('whose id was learned has a late turn end that settles nothing', ON, async ($, on) => {
    const opts: Opts = { spawnThrowsAfterLearning: 'spawn broke', reviewerIds: ['ag1', 'ag2'] }
    const seen = engine(on, opts)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    opts.spawnThrowsAfterLearning = undefined
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(seen.conversation.review).toMatchObject({ number: 2 })
    expect(logOf(seen, LOG_2)).toBeUndefined()
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete' })
  })

  test('before any id was learned stops nothing, notes no reason, and fails the review as before', ON, async ($, on) => {
    const seen = engine(on, { spawnThrows: 'spawn broke' })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await drained()
    expect(seen.stops).toEqual([])
    expect(seen.conversation.lastLetGo).toBeUndefined()
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: NO_SPAWN, brief_to: null })
    expect(seen.conversation.failing).toBe('not dispatched')
  })

  test('whose let-go cannot be written is logged and leaves the spawn\'s error the one the review logs', ON, async ($, on) => {
    const seen = engine(on, { spawnThrowsAfterLearning: 'spawn broke', writeRefusedWhen: c => c.lastLetGo === 'rejected spawn' })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await drained()
    // The failed review lets the learned id go instead, as the reviewer it stood in as.
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 1 }])
    expect(seen.conversation.lastLetGo).toBe('failed review')
    expect(JSON.stringify(seen.logs)).toContain('spawn bookkeeping failed')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: NO_SPAWN })
  })
})


// A review that ends failed or incomplete lets its stored reviewer go, unless the reviewer's turn was aborted.
describe('a failed or incomplete review', () => {
  // Review 1 is dispatched to the spawned reviewer ag1 and the next worker turn is the composer's; a reviewer spawned since is ag2.
  const afterwards = async ($: any, seen: any) => {
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 1 }])
    expect(seen.conversation.lastLetGo).toBe('failed review')
    await $.prompt.submit(COMPOSER('second'))
    await workerTurn($, 'Second.')
    expect(seen.sends).toEqual([])
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    expect(seen.conversation.review.briefTo).toBe('spawn: failed review')
  }

  test('whose reviewer ends its turn with an empty answer lets that reviewer go: stopped, not stored, the no-answer cause, and the next dispatch spawns', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', '')
    await drained()
    expect(seen.conversation.failing).toBe('no answer')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer ended its turn with an empty answer' })
    await afterwards($, seen)
  })

  test('whose reviewer ends its turn with an error reason lets that reviewer go: stopped, not stored, the no-answer cause, and the next dispatch spawns', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnFailed($, 'ag1')
    await drained()
    expect(seen.conversation.failing).toBe('no answer')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer turn ended with reason error, isAborted false' })
    await afterwards($, seen)
  })

  test('whose brief delivery throws lets the stored reviewer go: stopped, not stored, the not-dispatched cause, and the next dispatch spawns', ON, async ($, on) => {
    const seen = engine(on, { sendThrows: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await $.prompt.submit(COMPOSER('more'))
    await workerTurn($, 'More.')
    await drained()
    expect(seen.conversation.failing).toBe('not dispatched')
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete' })
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 1 }])
    expect(seen.conversation.lastLetGo).toBe('failed review')
    // The one send is the brief that threw.
    expect(seen.sends.length).toBe(1)
    await $.prompt.submit(COMPOSER('third'))
    await workerTurn($, 'Third.')
    expect(seen.sends.length).toBe(1)
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.review.briefTo).toBe('spawn: failed review')
  })

  test('whose reviewer\'s turn ended aborted fails with the no-answer cause and keeps that reviewer', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.turn.complete({ ...TURN_END('ag1', ''), isAborted: true, reason: 'aborted' })
    await drained()
    expect(seen.conversation.failing).toBe('no answer')
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(seen.conversation.lastLetGo).toBeUndefined()
    expect(seen.stops).toEqual([])
  })

  test('that completes keeps its reviewer and notes no let-go', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await drained()
    expect(seen.conversation.failing).toBeUndefined()
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(seen.conversation.lastLetGo).toBeUndefined()
    expect(seen.stops).toEqual([])
  })

  test('whose reviewer is past the rotation limit is let go as a rotation, once', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], stateSeed: { reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerContext: 80_001 } })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnFailed($, 'ag1')
    await drained()
    expect(seen.conversation.lastLetGo).toBe('rotation')
    expect(seen.stops).toEqual([{ task_id: 'ag1', spawns: 0 }])
  })
})

describe('an open review whose stored reviewer never ends its turn', () => {
  const REASON = 'reviewer did not finish in 10 minutes'
  // Review 1 is dispatched to the spawned reviewer ag1, then ten minutes and a moment pass; a reviewer spawned since is ag2.
  const stuck = async ($: any, on: any, opts: Opts = {}) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], ...opts })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    expect(seen.conversation.review).toMatchObject({ number: 1 })
    seen.clock += TEN_MINUTES + 1
    return seen
  }

  test('is given up at the next worker turn end: its entries go back, the failure has the no-finish cause, the reviewer is stopped and not stored, and the log is incomplete with that reason', ON, async ($, on) => {
    const seen = await stuck($, on)
    await $.prompt.submit(HELPER)
    await $.classic.Stop(stop)
    await drained()
    expect(seen.conversation.review).toBeUndefined()
    expect(seen.conversation.failing).toBe('no finish')
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.lastLetGo).toBe('lapsed')
    expect(seen.conversation.record.blocks.join('')).toContain('USER: first')
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', number: 1, reason: REASON })
    expect(JSON.stringify(seen.logs)).toContain(`review failed: ${REASON}`)
    expect(seen.spawns.length).toBe(1)
  })

  test('a review with no stored reviewer lapses as before: the no-start cause, and nothing is stopped', ON, async ($, on) => {
    const held = heldSpawn()
    const seen = engine(on, { spawnHold: { ...held.hold, to: 1 }, reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('fix'))
    const stopping = $.classic.Stop(stop)
    await held.reached
    seen.clock += TEN_MINUTES + 1
    await $.prompt.submit(HELPER)
    await $.classic.Stop(stop)
    expect(seen.conversation.failing).toBe('no start')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer spawn did not settle in 10 minutes' })
    expect(seen.conversation.lastLetGo).toBeUndefined()
    held.land()
    await stopping
    await drained()
  })

  test('under ten minutes old stays open, and nothing is dispatched', ON, async ($, on) => {
    const seen = await stuck($, on)
    seen.clock -= 100
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    await drained()
    expect(seen.conversation.review).toMatchObject({ number: 1 })
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(seen.conversation.failing).toBeUndefined()
    expect(seen.stops).toEqual([])
    expect(seen.spawns.length).toBe(1)
    expect(seen.sends).toEqual([])
    expect(logOf(seen, LOG_1)).toBeUndefined()
  })

  test('has a late turn end that settles nothing, and a late note send that is refused', ON, async ($, on) => {
    const seen = await stuck($, on)
    await $.prompt.submit(HELPER)
    await $.classic.Stop(stop)
    await drained()
    const refused = await noteSent($, 'a.ts:4 swallows it.', 'ag1', 1)
    expect(refused).toMatchObject({ isDelivered: false })
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: REASON })
    expect(seen.conversation.failing).toBe('no finish')
    expect(toMain(seen)).toEqual([])
  })

  test('shows its cause in the popup', ON, async ($, on) => {
    otherMods(on)
    await stuck($, on)
    await $.prompt.submit(HELPER)
    await $.classic.Stop(stop)
    await drained()
    const drawn = JSON.stringify(await (await mountMode($)).drawn())
    expect(drawn).toContain('failing: the reviewer did not finish in 10 minutes')
  })

  test('is followed by a fresh spawn at the next user-started turn end, whose success clears the failure', ON, async ($, on) => {
    const seen = await stuck($, on)
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    await drained()
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    expect(seen.conversation.review).toMatchObject({ number: 2, briefTo: 'spawn: lapsed' })
    expect(seen.conversation.failing).toBe('no finish')
    await turnEnded($, 'ag2', 'Nothing to note.')
    expect(seen.conversation.failing).toBeUndefined()
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'complete', brief_to: 'spawn: lapsed' })
  })
})

describe('an idle reviewer', () => {
  const CACHE_LIFE = 5 * 60 * 1000
  const STOPPED_TEAMMATE = 'Teammate "auditor-reviewer" was not messaged: the session was stopped and nobody has sent input since.'
  const NOTE_1 = 'a.ts:4 swallows it.'
  // The reap timers the plugin has set: those counting the cache's life (the ledger's own one-second bound is another wait).
  const reaps = (seen: any) => seen.timers.filter((t: any) => t.ms > 1000)
  const stopped = (seen: any): string[] => seen.stops.map((s: any) => s.task_id)
  // The reviewer's request, answered with `usage`.
  const requestWith = async ($: any, usage: unknown, agentId = 'ag1'): Promise<void> => {
    STEP_USAGE = usage
    try {
      await step($, '', agentId)
    } finally {
      STEP_USAGE = null
    }
  }
  // Review 1 is dispatched at the worker's Stop and settles with a note, which the memory then holds.
  const noted = async ($: any, on: any, opts: Opts = {}) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], ...opts })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', NOTE_1)
    await drained()
    return seen
  }
  // The worker's next turn: a prompt and its Stop, which dispatches review 2.
  const nextTurn = async ($: any, prompt = 'second') => {
    await $.prompt.submit(COMPOSER(prompt))
    await $.classic.Stop(stop)
    await drained()
  }

  test('after a complete review it is let go once the cache life has passed: stopped, not stored, and the next dispatch spawns a reviewer whose brief carries the memory', ON, async ($, on) => {
    const seen = await noted($, on)
    expect(reaps(seen).length).toBe(1)
    expect(stopped(seen)).toEqual([])
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.lastLetGo).toBe('reaped idle')
    await mainTurnEnd($)
    await nextTurn($)
    expect(seen.sends).toEqual([])
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain(NOTE_1)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
    expect(seen.conversation.review).toMatchObject({ number: 2, briefTo: 'spawn: reaped idle' })
    expect(stopped(seen)).toEqual(['ag1'])
  })

  test('after a review given back because the session was stopped it is let go once the cache life has passed, and the old timer, from before the give-back, changes nothing', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE })
    await workerTurn($)
    await turnEnded($, 'ag1', NOTE_1)
    await $.prompt.submit(COMPOSER('more'))
    await $.classic.Stop(stop)
    await drained()
    expect(logOf(seen, LOG_2)).toMatchObject({ status: 'incomplete', reason: 'given back: the session was stopped' })
    expect(reaps(seen).length).toBe(2)
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual([])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    reaps(seen)[1].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.lastLetGo).toBe('reaped idle')
    await $.prompt.submit(COMPOSER('again'))
    await $.classic.Stop(stop)
    await drained()
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt).toContain(NOTE_1)
    expect(seen.conversation.review).toMatchObject({ number: 3, briefTo: 'spawn: reaped idle' })
  })

  test('a given-back review times the reviewer from its latest turn end: the cache life less the time since', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE })
    await workerTurn($)
    await turnEnded($, 'ag1', NOTE_1)
    await drained()
    expect(reaps(seen)[0].ms).toBe(CACHE_LIFE)
    seen.clock += 60_000
    await $.prompt.submit(COMPOSER('more'))
    await $.classic.Stop(stop)
    await drained()
    expect(reaps(seen).length).toBe(2)
    expect(reaps(seen)[1].ms).toBeGreaterThan(CACHE_LIFE - 60_100)
    expect(reaps(seen)[1].ms).toBeLessThanOrEqual(CACHE_LIFE - 60_000)
  })

  test('a given-back review whose reviewer\'s cache has already expired fires its timer at once', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE })
    await workerTurn($)
    await turnEnded($, 'ag1', NOTE_1)
    await drained()
    seen.clock += CACHE_LIFE + 1
    await $.prompt.submit(COMPOSER('more'))
    await $.classic.Stop(stop)
    await drained()
    expect(reaps(seen).length).toBe(1)
    expect(seen.timers.at(-1)?.ms).toBe(0)
  })

  test('a given-back review whose reviewer has had no turn end is timed from the give-back: the whole cache life', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', refusal: STOPPED_TEAMMATE, stateSeed: { dispatches: 1, reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'] } })
    seen.clock += CACHE_LIFE
    await workerTurn($)
    await drained()
    expect(logOf(seen, `${DIR}/0002.json`)).toMatchObject({ reason: 'given back: the session was stopped' })
    expect(reaps(seen).map((t: any) => t.ms)).toEqual([CACHE_LIFE])
  })

  test('after a reviewer turn that ended aborted it is let go once the cache life has passed, and the next user-started dispatch spawns', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await $.turn.complete({ ...TURN_END('ag1', ''), isAborted: true, reason: 'aborted' })
    await drained()
    expect(reaps(seen).length).toBe(1)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
    expect(seen.conversation.failing).toBe('no answer')
    await mainTurnEnd($)
    await nextTurn($)
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.review).toMatchObject({ number: 2, briefTo: 'spawn: reaped idle' })
  })

  test('a reviewer let go for another reason starts no timer', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnFailed($, 'ag1')
    await drained()
    expect(seen.conversation.lastLetGo).toBe('failed review')
    expect(reaps(seen)).toEqual([])
  })

  test('a dispatch before the cache life sends to the stored reviewer, and the timer\'s later fire changes nothing: while that review is open and after it settles', ON, async ($, on) => {
    const seen = await noted($, on)
    await mainTurnEnd($)
    await nextTurn($)
    expect(seen.sends.map((s: any) => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(1)
    expect(seen.conversation.review).toMatchObject({ number: 2, briefTo: 'stored' })
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual([])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    expect(seen.conversation.review).toMatchObject({ number: 2 })
    await turnEnded($, 'ag1', 'Nothing to note.')
    await drained()
    expect(reaps(seen).length).toBe(2)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
  })

  test('a timer from before a dispatch changes nothing once that review has settled, and the timer started at its settle lets the reviewer go', ON, async ($, on) => {
    const seen = await noted($, on)
    await mainTurnEnd($)
    await nextTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await drained()
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual([])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
    reaps(seen)[1].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toBeUndefined()
  })

  test('a fire after a /clear changes nothing more: the reviewer was let go and stopped once, by the session end', ON, async ($, on) => {
    const seen = await noted($, on)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.lastLetGo).toBe('session end')
  })

  test('a fire after a switch off and on changes nothing more', ON, async ($, on) => {
    const seen = await noted($, on)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.lastLetGo).toBe('switch off')
  })

  test('a fire after a rotation changes nothing more', ON, async ($, on) => {
    const seen = await noted($, on)
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    await requestWith($, { ...USAGE, input_tokens: 80_001 })
    await turnEnded($, 'ag1', 'Nothing to note.')
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.lastLetGo).toBe('rotation')
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
  })

  test('a fire with a spawn in flight changes nothing', ON, async ($, on) => {
    const held = heldSpawn(2)
    const seen = await noted($, on, { sendFails: 'ag1', spawnHold: held.hold })
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    const dispatching = $.classic.Stop(stop)
    await held.reached
    expect(seen.conversation.spawnsInFlight.length).toBe(1)
    reaps(seen)[0].fire()
    await drained()
    expect(stopped(seen)).toEqual([])
    held.land()
    await dispatching
    await drained()
    expect(stopped(seen)).toEqual(['ag1'])
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
  })

  describe('a dispatch and the fire racing for the state', () => {
    const trap = (when: () => boolean) => {
      const held = gate()
      const reached = gate()
      return { hold: { when, until: held.until, reached: reached.open }, reached: reached.until, open: held.open }
    }

    test('a dispatch whose change lands just before the fire\'s keeps the reviewer, and the fire changes nothing', ON, async ($, on) => {
      const armed = { on: false }
      const t = trap(() => armed.on)
      const seen = await noted($, on, { holdWrite: t.hold })
      await mainTurnEnd($)
      await $.prompt.submit(COMPOSER('second'))
      armed.on = true
      reaps(seen)[0].fire()
      await t.reached
      await $.classic.Stop(stop)
      t.open()
      await drained()
      expect(seen.sends.map((s: any) => s.to)).toEqual(['ag1'])
      expect(seen.spawns.length).toBe(1)
      expect(stopped(seen)).toEqual([])
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
      expect(seen.conversation.review).toMatchObject({ number: 2, briefTo: 'stored' })
    })

    test('a dispatch whose change lands just after the fire\'s spawns fresh, and the review is never left open with no reviewer', ON, async ($, on) => {
      const t = trap(() => current.seen?.conversation?.lastMessage === 'raced')
      const seen = await noted($, on, { holdWrite: t.hold })
      await mainTurnEnd($)
      await $.prompt.submit(COMPOSER('second'))
      const dispatching = $.classic.Stop({ ...stop, last_assistant_message: 'raced' })
      await t.reached
      reaps(seen)[0].fire()
      await drained()
      expect(stopped(seen)).toEqual(['ag1'])
      t.open()
      await dispatching
      await drained()
      expect(seen.sends).toEqual([])
      expect(seen.spawns.length).toBe(2)
      expect(seen.conversation.reviewer).toMatchObject({ id: 'ag2' })
      expect(seen.conversation.review).toMatchObject({ number: 2, briefTo: 'spawn: reaped idle' })
      expect(stopped(seen)).toEqual(['ag1'])
    })
  })
})
