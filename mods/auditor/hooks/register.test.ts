import { describe, expect, test } from 'claude-code/testing'
import { LOOKUP_TIMEOUT_MS, lineCommand, searchCommand } from './transcript'
import { REVIEWER_PROMPT } from './prompt'
import * as register from './register'

const ON = { options: { log: true } }

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
  spawnNoId?: boolean
  reviewerIds?: string[]
  agents?: { id: string; name?: string; type?: string; status?: string; description?: string; teammateId?: string; spawnedBy?: string }[]
  listFails?: boolean
  tools?: Record<string, { text: string; isError?: boolean }>
  // The canned answer of every host command; the fields not given keep a clean run's values.
  run?: { stdout?: string; exitCode?: number; isStdoutTruncated?: boolean }
  sendFails?: string
  sendThrows?: string
  writeFails?: string
  clockFails?: boolean
  // The clock read with this number (1 for the first) rejects, and the rest answer.
  clockFailsAt?: number
  stateFails?: string
  dropText?: string
  // The conversation a state written before this build holds, until the plugin first writes one.
  stateSeed?: unknown
  submitFails?: boolean
  // Makes each $.session.append refuse with this reason.
  appendDenies?: string
  // Each $.session.append calls reached, then waits for `until` before the engine answers it.
  appendHold?: { until: Promise<void>; reached?: () => void }
  // With `submitFailsOnce`, only the first note prompt throws.
  submitFailsOnce?: boolean
  // Each write whose path contains `path` calls reached, then waits for `until` before it lands.
  hold?: { path: string; until: Promise<void>; reached?: () => void }
  // Each note prompt calls reached, then waits for `until` before the engine answers it.
  submitHold?: { until: Promise<void>; reached?: () => void }
  // Each $.session.send calls reached, then waits for `until` before the engine answers it.
  sendHold?: { until: Promise<void>; reached?: () => void }
  // Each $.tool.call of this tool rejects.
  toolThrows?: string
  // Each TaskStop call is refused with this reason.
  stopRefuses?: string
  // A spawn a hold covers calls its `reached`, then waits for `until` before its result lands (`result` when given, else the reviewer's id). A single hold covers the spawns numbered `from` (1-based, 1 by default) through `to` when given; an array holds the spawn numbered i + 1 by its entry i, and an undefined entry holds none.
  spawnHold?: (SpawnHold & { from?: number; to?: number }) | (SpawnHold | undefined)[]
  // From the reviewer spawn numbered `spawnThrowsFrom` (1-based) on, the spawn throws; from `spawnDeniesFrom` on, it is refused.
  spawnThrowsFrom?: number
  spawnDeniesFrom?: number
  // Once the reviewer spawn numbered `writesFailFromSpawn` (1-based) has been made, every conversation write is refused.
  writesFailFromSpawn?: number
  // With `listFailsAt`, the agent list call with that number (1 for the first) rejects and the rest answer.
  listFailsAt?: number
  // With `sessionIdFailsOnce`, the first session id read rejects.
  sessionIdFailsOnce?: boolean
  // Each session id read calls reached, then waits for `until` before the engine answers it; a hold covers the reads numbered `from` (1-based, 1 by default) through `to` when given.
  sessionIdHold?: { until: Promise<void>; reached?: () => void; from?: number; to?: number }
  // With `stateSetFailsOnce`, the first conversation write rejects.
  stateSetFailsOnce?: boolean
  // Each $.tool.call of `tool`, in the order the calls arrive, waits for its gate in `untils` before the engine answers it.
  toolHolds?: { tool: string; untils: Promise<void>[] }
}

// The hold that covers the reviewer spawn numbered `n` (1-based), when one does.
const heldAt = (hold: Opts['spawnHold'], n: number): SpawnHold | undefined => {
  if (Array.isArray(hold)) return hold[n - 1]
  if (hold === undefined || n < (hold.from ?? 1) || n > (hold.to ?? Infinity)) return undefined
  return hold
}

// The engine's answers. The reviewer spawns as agent ag1; any other subagent spawns as sub1.
// The files map backs $.fs.read and $.fs.write, so a log can be read back as the worker's plugin would see it.
const engine = (on: any, opts: Opts = {}) => {
  const env: Env = { HOME: '/home/test' }
  const tools = opts.tools ?? {}
  const files: Record<string, string> = {}
  const seen = {
    spawns: [] as any[], sends: [] as any[], prompts: [] as string[], contexts: [] as any[], toasts: [] as string[],
    conversation: undefined as any,
    registered: [] as any[], commands: [] as any[], registeredTools: [] as any[], runs: [] as any[], logs: [] as any[], reads: [] as string[], writes: [] as { path: string; text: string }[], appends: [] as any[], received: [] as any[], toolCalls: [] as any[], compactions: [] as any[],
    files, clock: 1000,
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
  }
  // The reviewer's spawns take the ids in reviewerIds in order, then ag1.
  let reviewerSpawns = 0
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
  let sessionIdFailsLeft = opts.sessionIdFailsOnce === true ? 1 : 0
  let sessionIdCalls = 0
  on('session.id', async () => {
    sessionIdCalls++
    if (sessionIdFailsLeft > 0) {
      sessionIdFailsLeft--
      return { deny: 'session id unavailable' }
    }
    const hold = opts.sessionIdHold
    if (hold !== undefined && sessionIdCalls >= (hold.from ?? 1) && sessionIdCalls <= (hold.to ?? Infinity)) {
      hold.reached?.()
      await hold.until
    }
    return { value: seen.session }
  })
  on('agent.list', () => {
    seen.listCalls++
    if (seen.listCalls === opts.listFailsAt) throw new Error('agent list unavailable')
    if (opts.listFails === true) throw new Error('agent list unavailable')
    return { value: opts.agents ?? [] }
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
  // Every attempt is recorded as it was sent, refused or not; an accepted row goes on to the conversation.
  on('session.append', async (_$: any, e: any, next: any) => {
    seen.appends.push(structuredClone(e.message))
    if (opts.appendHold !== undefined) {
      opts.appendHold.reached?.()
      await opts.appendHold.until
    }
    if (opts.appendDenies !== undefined) return { deny: opts.appendDenies }
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
    if (e.tool === 'TaskStop' && opts.stopRefuses !== undefined) return { deny: opts.stopRefuses }
    if (e.tool === opts.toolThrows) return Promise.reject(new Error('tool unavailable'))
    const answer = tools[e.tool] ?? { text: `ran ${e.tool}` }
    return { ref: 1, result: null, text: answer.text, isError: answer.isError }
  })
  on('state.get', (_$: any, e: any, next: any) => (opts.stateFails !== undefined && e.key === opts.stateFails ? { deny: 'state unavailable' } : opts.stateSeed !== undefined && e.key === 'conversation' && seen.conversation === undefined ? { value: { value: opts.stateSeed } } : next(e)))
  let conversationWritesFailLeft = opts.stateSetFailsOnce === true ? 1 : 0
  // The conversation as the plugin last wrote it; stripBriefs writes it as a state from before briefsInFlight existed.
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.key === 'conversation') seen.stateWriteAttempts++
    if (e.key === 'conversation' && opts.writesFailFromSpawn !== undefined && seen.spawns.filter(sp => typeOf(sp) === 'auditor:reviewer').length >= opts.writesFailFromSpawn) return { deny: 'state write unavailable' }
    if (e.key === 'conversation' && seen.stateWriteAttempts === seen.stateWritesFailAt) return { deny: 'state write unavailable' }
    if (e.key === 'conversation' && conversationWritesFailLeft > 0) {
      conversationWritesFailLeft--
      return { deny: 'state write unavailable' }
    }
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
      const reviewersSpawned = seen.spawns.filter(s => typeOf(s) === 'auditor:reviewer').length
      if (opts.spawnThrowsFrom !== undefined && reviewersSpawned >= opts.spawnThrowsFrom) throw new Error('spawn down')
      if (opts.spawnDeniesFrom !== undefined && reviewersSpawned >= opts.spawnDeniesFrom) return { deny: 'spawn refused' }
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
  on('session.send', async (_$: any, e: any) => {
    seen.sends.push(e)
    seen.flights.push([...(seen.conversation?.briefsInFlight ?? [])])
    if (opts.sendHold !== undefined) {
      opts.sendHold.reached?.()
      await opts.sendHold.until
    }
    return e.to === opts.sendThrows ? Promise.reject(new Error('send threw')) : e.to === opts.sendFails ? { isDelivered: false, reason: 'refused' } : { isDelivered: true }
  })
  let submitFailsLeft = opts.submitFailsOnce === true ? 1 : 0
  on('prompt.submit', async (_$: any, e: any) => {
    seen.prompts.push(e.text)
    seen.contexts.push(e.context)
    if (opts.submitHold !== undefined && e.text.startsWith('auditor, review')) {
      opts.submitHold.reached?.()
      await opts.submitHold.until
    }
    if (opts.submitFails === true && e.text.startsWith('auditor, review')) throw new Error('queue gone')
    if (submitFailsLeft > 0 && e.text.startsWith('auditor, review')) {
      submitFailsLeft--
      throw new Error('queue gone')
    }
    if (e.text === opts.dropText) return { drop: 'test' }
    return { text: e.text, context: e.context }
  })
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: STEP, toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE }
  })
  // The bottom of a compaction: each one that reaches it is recorded, and answered with the messages it was given, since a compaction leaves at least one.
  on('session.compact', (_$: any, e: any) => (seen.compactions.push(e), { messages: e.messages }))
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

// The reviewer's final SubagentHandback message, as it arrives at prompt.submit.
const HANDBACK = (body: string) => ({
  text: `Another Claude session sent a message: [Subagent hand-back] auditor-reviewer done\n${body}`,
  wait: false,
  origin: { kind: 'peer' as const },
})

// The reviewer's turn ending, with its answer.
const TURN_END = (agentId: string, answer = '', usage?: unknown) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId, usage }) as any

// The report a hand-back carries: the lines after its envelope, including the reviewer's own hand-back line. The turn end's answer is this report, verbatim.
const REPORT = (hand: { text: string }): string => {
  const lines = hand.text.split('\n')
  return lines.slice(lines.findIndex(line => line.includes('[Subagent hand-back]')) + 1).join('\n')
}

// The prompt a delivered note reaches the worker as: its first line names its review.
const FRAMED = (number: number, text: string): string => `auditor, review ${number}:\n${text}`

// The user row a tool batch appends the notes as, as the engine keeps it: a notice the user did not type.
const ROW = (text: string) => ({ type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }] })

const ESCALATED_TOAST = 'auditor: the reviewer escalated a disagreement; see its note to the worker'

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

// A reviewer hands back, and its turn ends with the report as its answer: the review settles at that turn end.
const reviewed = async ($: any, hand: any, agentId: string) => {
  await $.prompt.submit(hand)
  await $.turn.complete(TURN_END(agentId, REPORT(hand), USAGE))
}

// A reviewer's turn ends with the given answer, and no hand-back is involved.
const turnEnded = async ($: any, agentId: string, answer = '') => {
  await $.turn.complete(TURN_END(agentId, answer))
}

// The footer's SessionMode, beside Claude Code's own mode label.
const MODE_PROPS = { modes: ['auto mode on'] }
const mountMode = ($: any, surface = 'terminal') => $.ui.mount({ plugin: 'auditor', surface, component: 'SessionMode', props: MODE_PROPS })
// What Claude Code draws after this mod, which the hook's next(e) answers.
const otherMods = (on: any, text = 'drawn by Claude Code') => on('ui.render', () => ({ type: 'Text', props: {}, children: [text] }))
// Core's own drawing, which next(e) answers as an opaque node when no mod draws beneath: its words are the mode labels, not in the tree.
const coreDraws = (on: any) => on('ui.render', () => ({ type: 'engine', ref: 0 }))
// The button as drawn: its label says whether the reviewer is on, off or failing.
const buttonReads = async (ui: any, state: 'on' | 'off' | 'failing') => {
  expect(await ui.find({ key: 'auditor-toggle' })).toMatchObject({ props: { plain: true, label: `auditor is ${state}` } })
}


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

  test('a settle whose flush is under way briefs nothing when a user prompt enters before it finishes', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    // The third session id read is the settle's flush: the dispatch made the first, the settle's own log the second.
    const seen = engine(on, { sessionIdHold: { from: 3, to: 3, until: release.until, reached: reached.open } })
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

  test('a hand-back is dropped at the prompt, and its note is submitted, framed, at the worker\'s turn end', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const hand = HANDBACK('a.ts:4 swallows it.')
    await $.prompt.submit(hand)
    expect(seen.prompts).toEqual(['fix the parser'])
    await $.turn.complete(TURN_END('ag1', REPORT(hand), USAGE))
    expect(seen.prompts).toEqual(['fix the parser'])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 swallows it.')])
  })

  test('a note is submitted once, at the worker\'s turn end, and no later reviewer turn submits it again', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await reviewed($, NOTE(), 'ag1')
    expect(seen.prompts).toEqual(['fix the parser'])
    await mainTurnEnd($)
    await $.turn.complete(TURN_END('ag1'))
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 swallows it.')])
  })

  test('the turn-end flush submits its note as the prompt row and logs no transcript line for it', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 swallows it.')])
    expect(transcriptLines(seen)).toEqual([])
  })

  test('a note of several paragraphs appended at a tool batch logs its transcript line as one line', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 swallows it.\n\nb.ts:2 also.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'a.ts:4 swallows it.\n\nb.ts:2 also.'))])
    expect(transcriptLines(seen)).toEqual(['auditor note 1 to Claude: a.ts:4 swallows it. b.ts:2 also.'])
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

  test('a bundle another hook drops is logged, and its review logs not delivered', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 swallows it.') })
    await busyWorker($)
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('the held notes were dropped at the prompt')
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
  })

  test('an interrupted turn holds its notes until the user\'s next prompt, which carries them as context', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    expect(seen.prompts).toEqual(['carry on'])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
    await $.prompt.submit(COMPOSER('more'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 held.')])
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a review that settles after an interrupt holds its note until the user\'s next prompt, which carries it as context', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await reviewed($, NOTE(), 'ag1')
    expect(seen.prompts).toEqual(['carry on'])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
    await $.prompt.submit(COMPOSER('more'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 swallows it.')])
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a user prompt that carries held notes as context logs one transcript line per note', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('carry on'))
    expect(seen.contexts.at(-1)).toEqual([`${FRAMED(1, 'a.ts:4 first.')}\n\n${FRAMED(2, 'b.ts:1 second.')}`])
    expect(transcriptLines(seen)).toEqual(['auditor note 1 to Claude: a.ts:4 first.', 'auditor note 2 to Claude: b.ts:1 second.'])
  })

  test('a user prompt another hook drops logs no transcript line, and its held notes ride the next prompt', ON, async ($, on) => {
    const seen = engine(on, { dropText: 'carry on' })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('carry on'))
    expect(seen.prompts).toEqual(['fix the parser', 'carry on'])
    expect(transcriptLines(seen)).toEqual([])
    await $.prompt.submit(COMPOSER('more'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 held.')])
    expect(transcriptLines(seen)).toEqual(['auditor note 1 to Claude: a.ts:4 held.'])
  })

  test('a note submitted across a session change logs its delivery under the session it was held in', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { submitHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    const ending = mainTurnEnd($)
    await reached.until
    seen.session = 's2'
    release.open()
    await ending
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
    expect(Object.keys(seen.files).filter(path => path.includes('/s2/'))).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('an aborted turn with no Stop briefs its reviewer with that turn\'s last message', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await step($, 'working')
    await $.turn.complete({ answer: 'Partial reply.', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    expect(seen.spawns.length).toBe(1)
    expect(seen.spawns[0].prompt).toContain('Worker last message:\nPartial reply.')
  })

  test('an aborted turn\'s record ends with the INTERRUPTED entry, after the entries that turn made', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await step($, 'working')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: first', 'ASSISTANT: working', 'INTERRUPTED: the user stopped this turn before it finished.'))
  })

  test('a note pending at a main-agent tool batch is appended as one framed user row, and its log says delivered', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'a.ts:4 held.'))])
    expect(seen.prompts).toEqual(['carry on'])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('two notes pending at a tool batch go in one user row, oldest first', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await step($, 'working')
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(`${FRAMED(1, 'a.ts:4 first.')}\n\n${FRAMED(2, 'b.ts:1 second.')}`)])
  })

  test('each note appended at a tool batch logs one transcript line of its own', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await step($, 'working')
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(`${FRAMED(1, 'a.ts:4 first.')}\n\n${FRAMED(2, 'b.ts:1 second.')}`)])
    expect(transcriptLines(seen)).toEqual(['auditor note 1 to Claude: a.ts:4 first.', 'auditor note 2 to Claude: b.ts:1 second.'])
  })

  test('a subagent\'s tool batch appends nothing, and the note waits for the worker\'s turn end', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.classic.PostToolBatch({ tool_calls: [], agent_id: 'sub1' })
    expect(seen.appends).toEqual([])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 held.')])
  })

  test('a refused append leaves the note for the turn-end flush, which submits it', ON, async ($, on) => {
    const seen = engine(on, { appendDenies: 'refused' })
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends.length).toBe(1)
    expect(JSON.stringify(seen.logs)).toContain('the held notes were refused at the tool batch')
    expect(seen.prompts).toEqual(['carry on'])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 held.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a refused append logs no transcript line, and the turn-end flush that submits its note logs none either', ON, async ($, on) => {
    const seen = engine(on, { appendDenies: 'refused' })
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends.length).toBe(1)
    expect(transcriptLines(seen)).toEqual([])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 held.')])
    expect(transcriptLines(seen)).toEqual([])
  })

  test('a note appended at a tool batch is the reviewer\'s own in its record, labelled as the flush labels it', ON, async ($, on) => {
    engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.classic.PostToolBatch({ tool_calls: [] })
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, `PROMPT (plugin): ${FRAMED(1, 'a.ts:4 held.')}`))
  })

  test('a note appended at a tool batch adds nothing to the new record when a session end lands while the append is in flight', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { appendHold: { until: release.until, reached: reached.open } })
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    const delivering = $.classic.PostToolBatch({ tool_calls: [] })
    await reached.until
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    release.open()
    await delivering
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'a.ts:4 held.'))])
    expect({ epoch: seen.conversation.epoch, blocks: seen.conversation.record.blocks }).toEqual({ epoch: 1, blocks: [] })
  })

  test('an escalation toasts once when its review settles, and its delivery at a tool batch toasts nothing more', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'Escalation: Disagreement on auth. Escalating.')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'Escalation: Disagreement on auth. Escalating.'))])
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await $.classic.PostToolBatch({ tool_calls: [] })
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
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

  test('a note pending when the conversation ends is not submitted, and its log says not delivered', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 pending.')
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on'])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'a.ts:4 pending.', note_delivered: false })
  })

  test('a pending escalation toasts once, when its review settles, and not again at the flush', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'Escalation: Disagreement on auth. Escalating.')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await mainTurnEnd($)
    expect(seen.toasts.length).toBe(1)
  })

  test('a reviewer whose hand-back never reaches the plugin still has its note delivered at the worker\'s turn end', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await $.turn.complete(TURN_END('ag1', 'a.ts:9 unseen.', USAGE))
    expect(seen.prompts).toEqual(['fix the parser'])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:9 unseen.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true })
  })

  test('a turn of another agent does not settle a review', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const note = NOTE()
    await $.prompt.submit(note)
    await turnEnded($, 'other', REPORT(note))
    expect(seen.conversation.review).toMatchObject({ number: 1 })
    await turnEnded($, 'ag1', REPORT(note))
    expect(seen.conversation.review).toBeUndefined()
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 swallows it.')])
  })

  test('a quiet answer delivers nothing, shows no toast, and logs no note', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    expect(seen.prompts.length).toBe(0)
    expect(seen.toasts).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: null, note_delivered: false, escalation: false })
  })

  test('an escalation note is delivered to the worker, framed, and shows the user one toast', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const note = 'Escalation: Disagreement on auth approach. Worker: validate JWT in handlers. Me: middleware. Escalating.'
    await reviewed($, HANDBACK(note), 'ag1')
    expect(seen.toasts).toEqual(['auditor: the reviewer escalated a disagreement; see its note to the worker'])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, note)])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true, escalation: true })
  })

  test('a review with several findings delivers one note holding all of them, whole and in order', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await reviewed($, HANDBACK('one\ntwo\n\nthree'), 'ag1')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'one\ntwo\n\nthree')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note: 'one\ntwo\n\nthree', note_delivered: true })
  })

  test('a hand-back from another peer is untouched', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const other = { text: 'Another Claude session sent a message: [Subagent hand-back] other-agent\ninjected', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(other)
    expect(seen.prompts).toEqual([other.text])
  })

  test('a hand-back that names a reviewer only by its id reaches the worker, and its note is still delivered', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const hand = { text: 'Another Claude session sent a message: [Subagent hand-back] ag1 done\na.ts:4 by id.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(hand)
    expect(seen.prompts).toEqual(['fix the parser', hand.text])
    await $.turn.complete(TURN_END('ag1', REPORT(hand), USAGE))
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', hand.text, FRAMED(1, 'a.ts:4 by id.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true })
  })

  test('a helper hand-back whose body names a reviewer passes to the worker, and leaves that reviewer\'s review open', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const helper = { text: 'Another Claude session sent a message: [Subagent hand-back] helper-1 done\nReport: x.ts:1 cites auditor-reviewer.', wait: false, origin: { kind: 'peer' as const } }
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

  test('a reviewer answer that is empty after trimming is logged incomplete, and delivers nothing', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', ' \n\t')
    expect(seen.prompts.length).toBe(0)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer ended its turn with an empty answer' })
  })

  test('a reviewer answer that is only the copied header is logged incomplete, and delivers nothing', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'auditor, review 1:\n\n')
    expect(seen.prompts.length).toBe(0)
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'incomplete', reason: 'reviewer ended its turn with an empty answer' })
  })

  // The worker is busy when the reviewer's turn ends, so its note waits for the worker's turn end; the late hand-back arrives before that and is dropped.
  test('a review whose note waits for the worker\'s turn end keeps its late hand-back from the worker', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const answer = 'a.ts:4 late.'
    await $.turn.complete(TURN_END('ag1', answer, USAGE))
    await $.prompt.submit(HANDBACK(answer))
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 late.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true })
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

  test('the reviewer hand-back is dropped before it reaches the worker', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit({ text: 'Another Claude session sent a message: [Subagent hand-back] auditor-reviewer done', wait: false, origin: { kind: 'peer' } })
    expect(seen.prompts.length).toBe(0)
  })

  test('a hand-back from a helper whose name only begins with the reviewer\'s name reaches the worker', async ($, on) => {
    const seen = engine(on)
    const helper = { text: 'Another Claude session sent a message: [Subagent hand-back] auditor-reviewer-x done\nx.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(helper)
    expect(seen.prompts).toEqual([helper.text])
  })

  test('a peer message that names a reviewer without the hand-back wording passes to the worker, and every review still runs and delivers', ON, async ($, on) => {
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
    expect(seen.prompts.filter(p => p.startsWith('auditor, review')).length).toBe(3)
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
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix the parser', 'ASSISTANT: I will edit p.ts.', 'TOOL Edit({"file_path":"p.ts"}) -> edited'))
    expect(entryWrites(seen)).toEqual([])
  })

  test('the worker\'s replies are recorded in the order they arrive, between its tool calls', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' } } })
    await $.prompt.submit(COMPOSER('fix'))
    await step($, 'Editing now.')
    await $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' }))
    await step($, 'Multi-line\nreply.')
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix', 'ASSISTANT: Editing now.', 'TOOL Edit({"file_path":"p.ts"}) -> edited', 'ASSISTANT: Multi-line\nreply.'))
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
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: first', 'TOOL Edit({"file_path":"p.ts"}) -> edited', 'USER: mid-turn', 'TOOL Grep({"pattern":"x"}) -> hit'))
  })

  test('two tool calls that run at once both reach the record', ON, async ($, on) => {
    engine(on, { tools: { Edit: { text: 'edited' }, Grep: { text: 'hit' } } })
    await $.prompt.submit(COMPOSER('fix'))
    await Promise.all([
      $.tool.call(WORKER_CALL('Edit', { file_path: 'p.ts' })),
      $.tool.call(WORKER_CALL('Grep', { pattern: 'x' })),
    ])
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: fix', 'TOOL Edit({"file_path":"p.ts"}) -> edited', 'TOOL Grep({"pattern":"x"}) -> hit'))
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

  test('a stall note settling while the worker is idle is submitted at once, and the turn it starts briefs the next review at that turn\'s end, not at the settle', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', STALL_NOTE)
    expect({ prompts: seen.prompts, sends: seen.sends.length, mid: seen.conversation.midTurn }).toEqual({ prompts: ['first', FRAMED(1, STALL_NOTE)], sends: 0, mid: true })
    await $.classic.Stop(stop)
    expect(seen.sends.length).toBe(1)
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-')
    await mainTurnEnd($)
    expect(seen.sends.length).toBe(1)
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
    expect(seen.conversation.failing).toBe(false)
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

  test('a turn end whose note bundle another hook drops still briefs the reviewer', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 swallows it.') })
    await busyWorker($)
    await step($, 'working')
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 swallows it.')])
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-1,')
  })

  test('a turn end whose note submit throws still briefs the reviewer, and logs the failure', ON, async ($, on) => {
    const seen = engine(on, { submitFails: true })
    await busyWorker($)
    await step($, 'working')
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('note delivery failed')
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
    expect(seen.conversation.failing).toBe(true)
    expect(seen.conversation.briefsInFlight).toEqual([])
    opts.spawnNoId = false
    await $.prompt.submit(COMPOSER('second'))
    await $.classic.Stop(stop)
    expect(seen.spawns.length).toBe(2)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(2, 'USER: first', 'USER: second'))
  })

  test('a refused send, then a spawn that is denied, leaves no rewritten brief in flight, and the worker\'s identical Agent call is recorded', ON, async ($, on) => {
    const opts: Opts = {}
    const seen = engine(on, opts)
    await busyWorker($)
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[0].prompt, description: 'auditor review' } as any)
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    opts.sendFails = 'ag1'
    opts.spawn = { deny: 'no' }
    await workerTurn($, 'Second.')
    expect(seen.spawns.at(-1).prompt).toContain('You are a fresh reviewer')
    expect(seen.flights.at(-1)).toContain(seen.spawns.at(-1).prompt)
    expect(seen.conversation.briefsInFlight).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review failed: reviewer spawn refused: no')
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns.at(-1).prompt, description: 'auditor review' } as any)
    expect(seen.conversation.record.blocks.at(-1)).toContain('TOOL Agent(')
  })

  test('a refused send, then a spawn that throws, leaves no rewritten brief in flight, and the worker\'s identical Agent call is recorded', ON, async ($, on) => {
    const opts: Opts = {}
    const seen = engine(on, opts)
    await busyWorker($)
    await $.tool.call({ tool: 'Agent', prompt: seen.spawns[0].prompt, description: 'auditor review' } as any)
    await reviewed($, NOTE(), 'ag1')
    await mainTurnEnd($)
    opts.sendFails = 'ag1'
    opts.spawnThrows = 'spawn broke'
    await workerTurn($, 'Second.')
    expect(seen.spawns.at(-1).prompt).toContain('You are a fresh reviewer')
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

  test('a peer message that names a reviewer without the hand-back wording reaches the worker, and the plugin also delivers its framed note', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    const passed = { text: 'Another Claude session sent a message: auditor-reviewer finished\na.ts:4 raw.', wait: false, origin: { kind: 'peer' as const } }
    await $.prompt.submit(passed)
    await turnEnded($, 'ag1', 'a.ts:4 raw.')
    expect(seen.prompts).toEqual([passed.text])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual([passed.text, FRAMED(1, 'a.ts:4 raw.')])
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

  test('two escalations toast once each, as their reviews settle, and one bundle delivers both', ON, async ($, on) => {
    const seen = engine(on, { submitFailsOnce: true })
    await busyWorker($)
    await turnEnded($, 'ag1', 'Escalation: one. Escalating.')
    await step($, 'working')
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'Escalation: two. Escalating.')
    // The bundle's first submit throws once and restores both notes; the next turn end submits them together.
    await mainTurnEnd($)
    await mainTurnEnd($)
    expect(seen.prompts.at(-1)).toBe(`${FRAMED(1, 'Escalation: one. Escalating.')}\n\n${FRAMED(2, 'Escalation: two. Escalating.')}`)
    expect(seen.toasts).toEqual([ESCALATED_TOAST, ESCALATED_TOAST])
  })

  test('the review log names the Claude Code version, and a log that cannot be written does not stop the reviewer', ON, async ($, on) => {
    const seen = engine(on, { writeFails: LOG_1 })
    await busyWorker($)
    await reviewed($, HANDBACK('a.ts:1 x.'), 'ag1')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:1 x.')])
    // Two failures: the log's write, then its patch, which reads the file the write never made.
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, 'auditor: review log failed').length).toBe(2)
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

  test('a live-shaped reviewer hand-back is dropped at the prompt, and its note is submitted at the worker\'s turn end', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    const hand = LIVE_HANDBACK('a.ts:4 live.')
    await $.prompt.submit(hand)
    expect(seen.prompts).toEqual(['fix the parser'])
    await $.turn.complete(TURN_END('ag1', REPORT(hand), USAGE))
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 live.')])
  })

  test('a reviewer turn end that cannot be settled is logged, and the worker\'s turn goes on', ON, async ($, on) => {
    const seen = engine(on, { stateFails: 'conversation' })
    await $.turn.complete(TURN_END('ag1', 'Nothing to note.', USAGE))
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('review settlement failed')
  })

  test('a note settling after a worker turn end, with the worker idle, is submitted at once', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 idle.')])
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

  test('a worker turn that ends with no Stop, aborted, briefs the reviewer with entries pending', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    expect(seen.spawns.map(typeOf)).toEqual(['auditor:reviewer'])
  })

  test('a Stop that briefed the reviewer is followed by one brief only at the worker\'s turn end', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    expect({ spawns: seen.spawns.length, sends: seen.sends.length }).toEqual({ spawns: 1, sends: 0 })
  })

  test('a worker turn end whose flush submits a held note briefs nothing then', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 held.')])
    expect({ spawns: seen.spawns.length, sends: seen.sends.length }).toEqual({ spawns: 1, sends: 0 })
  })

  test('the turn a flush starts is mid-turn too, so a note settling during it waits for the next turn end', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:1 first.')
    await mainTurnEnd($)
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:1 first.')])
    await mainTurnEnd($)
    expect(seen.prompts.at(-1)).toBe(FRAMED(2, 'b.ts:1 second.'))
  })

  test('a bundle another hook drops is held again, the user\'s next prompt carries it as context, and no later turn end submits it', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 first.') })
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('second'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 first.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:5 second.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 first.'), 'second', FRAMED(2, 'a.ts:5 second.')])
  })

  test('a stall note whose turn-end flush is dropped waits for the user\'s next prompt, and arms the stall guard', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, STALL_NOTE) })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    expect(seen.spawns[0].prompt).toContain('Nothing will wake the worker')
    await turnEnded($, 'ag1', STALL_NOTE)
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, STALL_NOTE)])
    expect(seen.conversation).toMatchObject({ nudged: true, pendingNotes: [{ number: 1, text: STALL_NOTE, stall: true }] })
    expect(transcriptLines(seen)).toEqual([])
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).not.toContain('wake the worker:')
    await $.prompt.submit(COMPOSER('more'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, STALL_NOTE)])
  })

  test('an escalation whose turn-end flush is dropped is held for the user\'s next prompt, and no later turn end submits it', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'Escalation: disagree. Escalating.') })
    await busyWorker($)
    await turnEnded($, 'ag1', 'Escalation: disagree. Escalating.')
    await mainTurnEnd($)
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'Escalation: disagree. Escalating.')])
    expect(seen.conversation.pendingNotes).toEqual([{ number: 1, text: 'Escalation: disagree. Escalating.', stall: false }])
    await $.prompt.submit(COMPOSER('second'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'Escalation: disagree. Escalating.')])
  })

  test('a worker subagent turn end does not flush the notes held for the worker', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer', agentId: 'sub1' } as any)
    expect(seen.prompts).toEqual(['carry on'])
  })

  test('a failed submit is logged, its escalation toasts once when its review settles, and its review logs not delivered', ON, async ($, on) => {
    const seen = engine(on, { submitFails: true })
    await busyWorker($)
    await turnEnded($, 'ag1', 'Escalation: disagree. Escalating.')
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([ESCALATED_TOAST])
    expect(JSON.stringify(seen.logs)).toContain('note delivery failed')
    expect(logOf(seen, LOG_1)).toMatchObject({ escalation: true, note_delivered: false })
  })

  test('a note whose submit throws is submitted again by the next flush, once', ON, async ($, on) => {
    const seen = engine(on, { submitFailsOnce: true })
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([])
    expect(JSON.stringify(seen.logs)).toContain('note delivery failed')
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 held.'), FRAMED(1, 'a.ts:4 held.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
    await mainTurnEnd($)
    expect(seen.prompts.length).toBe(3)
  })

  // The restored note stays ahead of a note that settles after the failed flush, so the next flush submits them oldest first.
  test('a failed submit puts its notes in front of those that settled after it', ON, async ($, on) => {
    const seen = engine(on, { submitFailsOnce: true })
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await mainTurnEnd($)
    await $.prompt.submit(HELPER)
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 later.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual([
      'fix the parser',
      FRAMED(1, 'a.ts:4 held.'),
      HELPER.text,
      `${FRAMED(1, 'a.ts:4 held.')}\n\n${FRAMED(2, 'b.ts:1 later.')}`,
    ])
    expect(logOf(seen, LOG_2)).toMatchObject({ note_delivered: true })
  })

  test('a dropped bundle is also in the debug log', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 first.') })
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await mainTurnEnd($)
    expect(JSON.stringify(seen.logs)).toContain('dropped at the prompt')
  })

  test('the registered prompt names the quiet answer, the escalation opening and the header', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    const prompt: string = seen.registered[0].prompt
    expect(prompt).toContain('answer exactly `Nothing to note.`')
    expect(prompt).toContain('opens with `Escalation:`')
    // The header is named twice, as the notes' heading and in echo recognition; both must match the plugin's.
    expect(prompt.split('`auditor, review N:`').length - 1).toBe(2)
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

  test('a note that arrives while the worker is busy, whose turn ends before the note is held, is submitted at once, and delivered once', ON, async ($, on) => {
    const g = gate()
    const reached = gate()
    const seen = engine(on, { hold: { path: '/0001.json', until: g.until, reached: reached.open } })
    await workerTurn($)
    await $.prompt.submit(COMPOSER('carry on'))
    const settling = turnEnded($, 'ag1', 'a.ts:4 held.')
    await reached.until
    await mainTurnEnd($)
    g.open()
    await settling
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 held.')])
    expect(seen.toasts).toEqual([])
    await $.prompt.submit(COMPOSER('next'))
    expect(seen.contexts.filter(c => c !== undefined)).toEqual([])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a note whose review settles while the worker is idle, but whose user prompt enters before the note is held, is not submitted: the busy worker reads it at its tool call', ON, async ($, on) => {
    const g = gate()
    const reached = gate()
    const seen = engine(on, { hold: { path: '/0001.json', until: g.until, reached: reached.open } })
    await workerTurn($)
    const settling = turnEnded($, 'ag1', 'a.ts:4 held.')
    await reached.until
    await $.prompt.submit(COMPOSER('carry on'))
    g.open()
    await settling
    expect(seen.prompts).toEqual(['carry on'])
    await $.classic.PostToolBatch({ tool_calls: [] } as any)
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'a.ts:4 held.'))])
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
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).not.toContain('wake the worker:')
  })

  test('a delivered stall note sets the once-per-stall guard: the next stop, with no prompt from the user, states no stall fact', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(QUIET_STOP)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', STALL_NOTE)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, STALL_NOTE)])
    await step($, 'working')
    await $.classic.Stop(QUIET_STOP)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).not.toContain('wake the worker:')
  })

  test('a stall note appended at a tool batch sets the once-per-stall guard too', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('carry on'))
    await $.classic.Stop(QUIET_STOP)
    await turnEnded($, 'ag1', STALL_NOTE)
    await $.classic.PostToolBatch({ tool_calls: [] })
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
    expect(seen.prompts).toEqual(['fix the parser', 'the config too', FRAMED(1, STALL_NOTE)])
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

  test('a stall note from a review whose brief stated no stall fact is dropped: nothing is delivered, and the guard is not set', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', STALL_NOTE)
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(seen.conversation.nudged).toBe(false)
    expect(JSON.stringify(seen.logs)).toContain('review 1 gave a stall note, but its brief did not say nothing will wake the worker')
  })

  test('a reviewer that always answers with a stall note is held to one: the second idle stop, with no prompt from the user, delivers no second note', ON, async ($, on) => {
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
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, STALL_NOTE)])
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
    const STALL_EXCEPTION = `**The stall exception.** When the brief says nothing will wake the worker, two cases are findings even though no rule broke: the worker's last turn ended on an open commitment with no tool call after it ("next I'll update the config", then nothing), or it says it is waiting on work the brief shows is not in flight. Nothing else will resume the worker, so your note is what does. Open it with \`Stalled:\` and say plainly what is left undone: \`Stalled: you said you would update the config and ended the turn; nothing will wake you.\` or \`Stalled: you are waiting on the test run, but nothing is in flight.\` These are not stalls: a turn that ends by asking the user something or handing them a decision, a turn whose last message reports the work done and announces nothing more (a report that ends on a next step not taken, such as \`Next: …\`, is still a stall), and a turn whose closing line the user asked for word for word. If the brief has no line about waking, there is no stall exception.`
    expect(prompt).toContain(STALL_EXCEPTION)
    expect(prompt).toContain('An open commitment is not a finding.')
  })
})

describe('the entries tool', () => {
  const EDIT = 'TOOL Edit({"file_path":"p.ts"}) -> ran Edit'
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

  test('the entries tool is registered deferred, and the reviewer is given it and the transcript tool beside Read, Glob and Grep', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.registeredTools).toMatchObject([{ name: 'entries', isDeferred: true, inputSchema: { required: ['which'] } }, { name: 'transcript', isDeferred: true }])
    expect(seen.registered[0].tools).toEqual(['Read', 'Glob', 'Grep', ENTRIES, TRANSCRIPT])
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
  const EMPTY_FAILURE = 'auditor: review failed: reviewer ended its turn with an empty answer'
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

  test('a session end forgets the transcript path, and a session start that reports one again sets it', ON, async ($, on) => {
    const seen = engine(on, { agents: [{ id: 'ag1', name: 'auditor-reviewer', type: 'auditor:reviewer', spawnedBy: 'auditor' }], run: { stdout: 'total\t0\n' } })
    await $.classic.SessionStart({ transcript_path: TRANSCRIPT_PATH } as any)
    expect(await answer($, { search: 'pure' })).toBe('No line of the session transcript matches "pure".')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    expect(await answer($, { search: 'pure' })).toBe(NO_TRANSCRIPT)
    await $.classic.SessionStart({ transcript_path: NEW_PATH } as any)
    await answer($, { search: 'pure' })
    expect(last(seen).argv).toEqual(searchCommand(NEW_PATH, 'pure'))
  })

  // A failed review's notice starts a worker turn, and that turn's end dispatches the next review: here neither dispatches.
  test('a failed review\'s notice, and a turn no composer started, dispatch nothing: the record keeps the failed entries', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await workerTurn($)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', '')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, EMPTY_FAILURE).length).toBe(1)
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
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-5,')
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

  test('each failure of a run is logged with its reason, toasts nothing, and leaves the footer reading auditor is failing', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', '')
    await $.prompt.submit(COMPOSER('retry'))
    await workerTurn($)
    expect(seen.sends.length).toBe(1)
    // The record tool serves only an open review, so it is read while review 2 is open, before its failure.
    expect(await entriesOf($, { which: 'record' }, 'ag1')).toBe(RECORD_OF(2, 'USER: first', 'USER: retry', 'ASSISTANT: working'))
    await turnEnded($, 'ag1', '')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, EMPTY_FAILURE).length).toBe(2)
    await buttonReads(await mountMode($), 'failing')
  })

  test('a successful review ends the failing run, and the next failure is logged and reads auditor is failing again', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', '')
    await $.prompt.submit(COMPOSER('retry'))
    await workerTurn($)
    await turnEnded($, 'ag1', '')
    await $.prompt.submit(COMPOSER('again'))
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const ui = await mountMode($)
    await buttonReads(ui, 'on')
    await $.prompt.submit(COMPOSER('next'))
    await workerTurn($)
    await turnEnded($, 'ag1', '')
    await buttonReads(ui, 'failing')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, EMPTY_FAILURE).length).toBe(3)
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
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', '')
    await $.prompt.submit(HELPER)
    await workerTurn($)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.sends[0].text).toContain('Review 2. Its record holds entries 1-3,')
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
    await turnEnded($, 'ag1', '')
    await mainTurnEnd($)
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, EMPTY_FAILURE).length).toBe(1)
    const ui = await mountMode($)
    await buttonReads(ui, 'failing')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    await buttonReads(ui, 'on')
    await workerTurn($)
    expect(seen.spawns.length).toBe(2)
    await turnEnded($, 'ag1', '')
    expect(seen.toasts).toEqual([])
    expect(debugLines(seen, EMPTY_FAILURE).length).toBe(2)
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

  test('the prompt row of a note the auditor submits is drawn, expanded or not; another plugin\'s prompt row draws too', ON, async ($, on) => {
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
  test('the footer shows auditor is on by default, on the terminal and the desktop app', ON, async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: ' · ' })).toBeDefined()
    await buttonReads(ui, 'on')
  })

  test('Claude Code\'s own drawing of its mode labels, with no mod beneath, is separated from the button', ON, async ($, on) => {
    engine(on)
    coreDraws(on)
    const ui = await mountMode($)
    expect(await ui.find({ type: 'Text', text: ' · ' })).toBeDefined()
    await buttonReads(ui, 'on')
  })

  test('Claude Code\'s own drawing with no mode label, and no mod beneath, leaves the button alone', ON, async ($, on) => {
    engine(on)
    coreDraws(on)
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    expect(await ui.find({ type: 'Text', text: ' · ' })).toBeUndefined()
    await buttonReads(ui, 'on')
  })

  test('a Markdown label drawn beneath, whose words are in its props, is separated from the button', ON, async ($, on) => {
    engine(on)
    on('ui.render', () => ({ type: 'Markdown', props: { text: '**plan** mode' } }))
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    expect(await ui.find({ type: 'Text', text: ' · ' })).toBeDefined()
    await buttonReads(ui, 'on')
  })

  test('with nothing drawn beneath it, the button stands alone, with no separator leading it', ON, async ($, on) => {
    engine(on)
    otherMods(on, '')
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    await buttonReads(ui, 'on')
    expect(await ui.find({ type: 'Text', text: ' · ' })).toBeUndefined()
  })

  test('a label drawn beneath the button, with no mode label of Claude Code\'s own, is separated from it, never glued', ON, async ($, on) => {
    engine(on)
    otherMods(on, 'cache ▰▰▰▰▱ 3:12')
    const ui = await $.ui.mount({ plugin: 'auditor', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('"children":["cache ▰▰▰▰▱ 3:12"]')).toBeLessThan(drawn.indexOf('"children":[" · "]'))
    expect(drawn.indexOf('"children":[" · "]')).toBeLessThan(drawn.indexOf('"label":"auditor is on"'))
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
    await turnEnded($, 'ag1', '')
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
    await turnEnded($, 'ag1', 'Escalation: a.ts:4 cut off.')
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(seen.appends.length).toBe(0)
    expect(seen.toasts).toEqual([])
    expect(seen.spawns.length).toBe(1)
  })

  test('/auditor off stops a review in flight the same way', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    expect(seen.stops.map(s => s.task_id)).toEqual(['ag1'])
    await turnEnded($, 'ag1', 'a.ts:4 cut off.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser'])
  })

  test('a note held when the reviewer is turned off is dropped: no tool batch, turn end or prompt delivers it', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 cut off.')
    expect(seen.conversation.pendingNotes.length).toBe(1)
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await mainTurnEnd($)
    await $.prompt.submit(COMPOSER('next'))
    expect(seen.prompts).toEqual(['fix the parser', 'next'])
    expect(seen.appends.length).toBe(0)
    expect(transcriptLines(seen).filter(l => l.startsWith('auditor note'))).toEqual([])
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

  test('a note whose submit fails after the reviewer is turned off stays dropped: turning it on again delivers nothing', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { submitFails: true, submitHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const settling = turnEnded($, 'ag1', 'a.ts:4 cut off.')
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    await settling
    expect(seen.conversation.pendingNotes).toEqual([])
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await $.prompt.submit(COMPOSER('next'))
    expect(seen.contexts.at(-1)).toBeUndefined()
    expect(transcriptLines(seen).filter(l => l.startsWith('auditor note'))).toEqual([])
  })

  test('a submit dropped after the reviewer is turned off leaves no hold: after it is turned on again, a new note on an idle worker is submitted at once', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 cut off.'), submitHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const settling = turnEnded($, 'ag1', 'a.ts:4 cut off.')
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    release.open()
    await settling
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    expect(seen.prompts).toEqual([FRAMED(1, 'a.ts:4 cut off.'), FRAMED(2, 'b.ts:1 second.')])
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
    expect(seen.conversation.failing).toBe(false)
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
    expect(seen.conversation.failing).toBe(false)
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

  test('a /clear mid-submit whose submit then fails: the notes stay dropped, and none is kept as delivered', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { submitFails: true, submitHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const settling = turnEnded($, 'ag1', 'a.ts:4 cut off.')
    await reached.until
    await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
    release.open()
    await settling
    expect(seen.conversation.pendingNotes).toEqual([])
    expect(seen.conversation.deliveredNotes).toEqual([])
    await $.prompt.submit(COMPOSER('next'))
    expect(seen.contexts.at(-1)).toBeUndefined()
  })

  test('a spawn that never settles, then the reviewer turned off and on: the next turn end dispatches again', ON, async ($, on) => {
    const reached = gate()
    const seen = engine(on, { spawnHold: { to: 1, until: new Promise<void>(() => {}), reached: reached.open } })
    void workerTurn($)
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
    expect(seen.conversation.reviewer).toMatchObject({ id: 'ag1' })
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

  test('a note whose submit fails while the reviewer is turned off and on again stays dropped', ON, async ($, on) => {
    const release = gate()
    const reached = gate()
    const seen = engine(on, { submitFails: true, submitHold: { until: release.until, reached: reached.open } })
    await workerTurn($)
    const settling = turnEnded($, 'ag1', 'a.ts:4 cut off.')
    await reached.until
    await $.command.run({ command: 'auditor', args: 'off' } as any)
    await $.command.run({ command: 'auditor', args: 'on' } as any)
    release.open()
    await settling
    expect(seen.conversation.pendingNotes).toEqual([])
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
    expect(seen.conversation.failing).toBe(false)
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

  test('turning the reviewer off ends a dropped submit\'s hold: after off and on, a new note on an idle worker is submitted at once', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 first.') })
    otherMods(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 first.')])
    const ui = await mountMode($)
    await ui.press({ key: 'auditor-toggle' })
    await ui.press({ key: 'auditor-toggle' })
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 first.'), FRAMED(2, 'b.ts:1 second.')])
  })
})

describe('reviewer traffic', () => {
  const CONSUMED = { consumed: 'auditor reviewer traffic' }
  // The agent list's entry for the reviewer: its deliveries carry this name as their teammate.
  const LISTED = [{ id: 'ag1', name: 'auditor-reviewer' }]
  // A delivery the team's mailbox carries from `teammate`; `isVerified` says whether the harness wrote the entry.
  const MAILED =(teammate: string, isVerified: boolean, text = 'a.ts:4 swallows it.') => ({ text, origin: { kind: 'peer' as const, teammate, isVerified } })

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

  test('a consumed delivery after its review settled is consumed, and the review log records nothing for it', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    const written = seen.writes.length
    expect(await $.session.receive(MAILED('auditor-reviewer', true, '[Subagent hand-back] auditor-reviewer done\na.ts:4 late.'))).toEqual(CONSUMED)
    expect(seen.writes.length).toBe(written)
  })

  test('a consumed delivery while its review is open is consumed, and the review log records nothing for it', ON, async ($, on) => {
    const seen = engine(on, { agents: LISTED })
    await workerTurn($)
    const written = seen.writes.length
    expect(await $.session.receive(MAILED('auditor-reviewer', true, '[Subagent hand-back] auditor-reviewer done\na.ts:4 x.'))).toEqual(CONSUMED)
    expect(await $.session.receive(MAILED('auditor-reviewer', true, '[Subagent hand-back] auditor-reviewer second\na.ts:5 y.'))).toEqual(CONSUMED)
    expect(seen.writes.length).toBe(written)
    await turnEnded($, 'ag1', 'Nothing to note.')
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete' })
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

describe('note timing', () => {
  const SLASH = (text: string, name: string) => ({ text, wait: false, origin: { kind: 'composer' as const }, command: { name, args: '' } })
  const BRIDGE = (text: string) => ({ text, wait: false, origin: { kind: 'bridge' as const } })

  test('a note settling while the worker is idle starts a worker turn that carries it as the plugin\'s own prompt, and the user\'s next prompt carries nothing of it', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    expect(seen.prompts).toEqual([FRAMED(1, 'a.ts:4 idle.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ status: 'complete', note_delivered: true })
    await $.prompt.submit(COMPOSER('fix the parser'))
    expect(seen.contexts.at(-1)).toBeUndefined()
  })

  test('a note on a review of a turn the auditor\'s own submit started is submitted at once, and starts a turn too', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    expect(seen.prompts).toEqual([FRAMED(1, 'a.ts:4 first.'), FRAMED(2, 'b.ts:1 second.')])
    expect(logOf(seen, LOG_2)).toMatchObject({ note_delivered: true })
  })

  test('a note whose submit throws at an idle settle is submitted again by the next settle or turn end, once', ON, async ($, on) => {
    const seen = engine(on, { submitFailsOnce: true })
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    expect(JSON.stringify(seen.logs)).toContain('note delivery failed')
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
    await mainTurnEnd($)
    expect(seen.prompts).toEqual([FRAMED(1, 'a.ts:4 idle.'), FRAMED(1, 'a.ts:4 idle.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
    await mainTurnEnd($)
    expect(seen.prompts.length).toBe(2)
  })

  test('an interrupt is released by the user\'s next prompt even when no note waits: a note settling in the turn it starts goes out at that turn\'s end', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('carry on'))
    await turnEnded($, 'ag1', 'a.ts:4 busy.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['carry on', FRAMED(1, 'a.ts:4 busy.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a dropped submit is released by the user\'s next prompt even when a tool batch already took its notes', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 first.') })
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await mainTurnEnd($)
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'a.ts:4 first.'))])
    await $.prompt.submit(COMPOSER('next'))
    expect(seen.contexts.at(-1)).toBeUndefined()
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'b.ts:1 second.')
    expect(seen.prompts.at(-1)).toBe(FRAMED(2, 'b.ts:1 second.'))
  })

  test('a user prompt another hook drops while the worker is busy puts its notes back for that turn\'s end', ON, async ($, on) => {
    const seen = engine(on, { dropText: 'also this' })
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 busy.')
    await $.prompt.submit(COMPOSER('also this'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 busy.')])
    await mainTurnEnd($)
    expect(seen.prompts.at(-1)).toBe(FRAMED(1, 'a.ts:4 busy.'))
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a dropped submit holds the waiting notes from every submit: a settle after it submits nothing, and a tool batch appends them all', ON, async ($, on) => {
    const seen = engine(on, { dropText: FRAMED(1, 'a.ts:4 first.') })
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 first.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 first.')])
    // A worker entry after the dropped dispatch gives the next review a record to brief.
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' } as any)
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:5 second.')
    expect(seen.prompts.length).toBe(2)
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(`${FRAMED(1, 'a.ts:4 first.')}\n\n${FRAMED(2, 'a.ts:5 second.')}`)])
  })

  test('a bridge prompt, sent from a Remote Control client, carries the held note as the user\'s own', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(BRIDGE('from the phone'))
    expect(seen.prompts).toEqual(['fix the parser', 'from the phone'])
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 held.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
    await $.classic.Stop(stop)
    expect(await entriesOf($, { which: 'live' })).toBe(LIVE_OF(2, 'USER: from the phone', `PROMPT (plugin): ${FRAMED(1, 'a.ts:4 held.')}`))
  })

  test('a note settling mid-turn goes out at that turn\'s end, and not before', ON, async ($, on) => {
    const seen = engine(on)
    await busyWorker($)
    await turnEnded($, 'ag1', 'a.ts:4 busy.')
    expect(seen.prompts).toEqual(['fix the parser'])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', FRAMED(1, 'a.ts:4 busy.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('two notes settling mid-turn go out together at that turn\'s end, and not before', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(HELPER)
    await turnEnded($, 'ag1', 'a.ts:4 busy.')
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'b.ts:1 busy.')
    expect(seen.prompts).toEqual([HELPER.text])
    await mainTurnEnd($)
    expect(seen.prompts).toEqual([HELPER.text, `${FRAMED(1, 'a.ts:4 busy.')}\n\n${FRAMED(2, 'b.ts:1 busy.')}`])
  })

  test('a note settling during a turn some other prompt started goes out at the next tool batch', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await $.prompt.submit(HELPER)
    await turnEnded($, 'ag1', 'a.ts:4 busy.')
    expect(seen.contexts.at(-1)).toBeUndefined()
    await $.classic.PostToolBatch({ tool_calls: [] })
    expect(seen.appends).toEqual([ROW(FRAMED(1, 'a.ts:4 busy.'))])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a stall note settling while the worker is idle is submitted at once', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('first'))
    await $.classic.Stop(stop)
    await mainTurnEnd($)
    await turnEnded($, 'ag1', 'Nothing to note.')
    await step($, 'working')
    // Review 2's brief says nothing will wake the worker, so its stall note is kept.
    await $.classic.Stop(QUIET_STOP)
    await turnEnded($, 'ag1', STALL_NOTE)
    expect(seen.prompts).toEqual(['first', FRAMED(2, STALL_NOTE)])
    expect(logOf(seen, LOG_2)).toMatchObject({ note_delivered: true })
  })

  test('a slash command releases no interrupt-held note: a settle after it submits nothing, and the next plain prompt carries the notes', ON, async ($, on) => {
    const seen = engine(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(SLASH('/help', 'help'))
    expect(seen.contexts.at(-1)).toBeUndefined()
    // The slash command's own turn is busy, so its note is due at that turn's end, were the interrupt not holding it.
    await turnEnded($, 'ag1', 'b.ts:1 busy.')
    await mainTurnEnd($)
    expect(seen.prompts).toEqual(['fix the parser', '/help'])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
    await $.prompt.submit(COMPOSER('fix the parser again'))
    expect(seen.contexts.at(-1)).toEqual([`${FRAMED(1, 'a.ts:4 held.')}\n\n${FRAMED(2, 'b.ts:1 busy.')}`])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a user prompt a later hook drops returns its held note, and the next user prompt carries it', ON, async ($, on) => {
    const seen = engine(on, { dropText: 'carry on' })
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    await turnEnded($, 'ag1', 'a.ts:4 held.')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' } as any)
    await $.prompt.submit(COMPOSER('carry on'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 held.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: false })
    await $.prompt.submit(COMPOSER('again'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 held.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  // A note held for the user's next prompt, seeded as the conversation's state so that the prompt is the first call of the failing read or write.
  const HELD = { number: 1, text: 'a.ts:4 idle.', stall: false }

  test('a failed session id read lets the prompt through with no context, and the held note stays for the next prompt', ON, async ($, on) => {
    const seen = engine(on, { sessionIdFailsOnce: true, stateSeed: { pendingNotes: [HELD] } })
    seen.files[LOG_1] = JSON.stringify({ status: 'complete', note_delivered: false })
    await $.prompt.submit(COMPOSER('fix the parser'))
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(seen.contexts).toEqual([undefined])
    expect(seen.conversation.pendingNotes).toEqual([HELD])
    expect(debugLines(seen, 'held notes failed').length).toBe(1)
    await $.prompt.submit(COMPOSER('again'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 idle.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })

  test('a failed write while the held notes are taken lets the prompt through with no context, and the held note stays for the next prompt', ON, async ($, on) => {
    const seen = engine(on, { stateSetFailsOnce: true, stateSeed: { pendingNotes: [HELD] } })
    seen.files[LOG_1] = JSON.stringify({ status: 'complete', note_delivered: false })
    await $.prompt.submit(COMPOSER('fix the parser'))
    expect(seen.prompts).toEqual(['fix the parser'])
    expect(seen.contexts).toEqual([undefined])
    expect(seen.conversation.pendingNotes).toEqual([HELD])
    expect(debugLines(seen, 'held notes failed').length).toBe(1)
    await $.prompt.submit(COMPOSER('again'))
    expect(seen.contexts.at(-1)).toEqual([FRAMED(1, 'a.ts:4 idle.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
  })
})

describe('reviewer rotation', () => {
  const FRESH = 'You are a fresh reviewer of this conversation. The notes earlier reviewers gave the worker, oldest first:'
  const FIND_AGAIN = 'Find the user\'s instructions again with your transcript tool before you judge.'
  const FINISHED = 'The worker finished a turn.'
  // The opening of a fresh reviewer's brief that carries these notes, through the brief's first line.
  const CARRIED = (...notes: string[]): string => [FRESH, ...notes, FIND_AGAIN, FINISHED].join('\n')
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

  test('the very first reviewer of a conversation, with no notes delivered, is briefed with none of the carried lines', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    expect(seen.spawns[0].prompt.split('\n')[0]).toBe(FINISHED)
    expect(seen.spawns[0].prompt).not.toContain(FRESH)
  })

  test('a reviewer that replaces a retired one, with no notes delivered, is briefed with none of the carried lines', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns[1].prompt.split('\n')[0]).toBe(FINISHED)
    expect(seen.spawns[1].prompt).not.toContain(FRESH)
  })

  test('a fresh reviewer is briefed with the notes earlier reviewers delivered, oldest first and framed, then the line that sends it to the transcript', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await reviewCycle($, 'first', 'a.ts:1 idle.')
    await reviewCycle($, 'second', 'a.ts:2 idle.', contextOf(80_001))
    // The third prompt carries the second note, so both notes are delivered before the fresh reviewer's brief is written.
    await $.prompt.submit(COMPOSER('third'))
    await $.classic.Stop(stop)
    const lead = CARRIED(FRAMED(1, 'a.ts:1 idle.'), FRAMED(2, 'a.ts:2 idle.'))
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt.slice(0, lead.length)).toBe(lead)
  })

  test('a fresh reviewer carries at most the last five delivered notes', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    for (let n = 1; n <= 6; n++) await reviewCycle($, `turn ${n}`, `a.ts:${n} idle.`, n === 6 ? contextOf(80_001) : undefined)
    await $.prompt.submit(COMPOSER('turn 7'))
    await $.classic.Stop(stop)
    const lead = CARRIED(...[2, 3, 4, 5, 6].map(n => FRAMED(n, `a.ts:${n} idle.`)))
    expect(seen.spawns.length).toBe(2)
    expect(seen.spawns[1].prompt.slice(0, lead.length)).toBe(lead)
  })

  test('a refused send to the stored reviewer spawns one told the notes delivered earlier, and the spawn\'s Agent call is not a worker entry', ON, async ($, on) => {
    const seen = engine(on, { sendFails: 'ag1', reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.classic.Stop(stop)
    expect(seen.sends.map(s => s.to)).toEqual(['ag1'])
    expect(seen.spawns.length).toBe(2)
    const lead = CARRIED(FRAMED(1, 'a.ts:4 idle.'))
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

  test('a retired reviewer\'s verified delivery is still consumed', ON, async ($, on) => {
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'] })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    const late = { text: 'a.ts:4 late.', origin: { kind: 'peer' as const, teammate: 'auditor-reviewer', isVerified: true } }
    expect(await $.session.receive(late)).toEqual({ consumed: 'auditor reviewer traffic' })
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
    await turnEnded($, 'ag1', '')
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
    const seen = engine(on, { reviewerIds: ['ag1', 'ag2'], toolHolds: { tool: 'TaskStop', untils: [new Promise<void>(() => {})] } })
    await workerTurn($)
    await requestWith($, contextOf(80_001))
    await reviewed($, HANDBACK('Nothing to note.'), 'ag1')
    await workerTurn($, 'Second.')
    expect(seen.spawns.length).toBe(2)
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

  test('the command is registered as immediate, with an on-or-off argument hint', ON, async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: true })
    expect(seen.commands.find(c => c.name === 'auditor')).toMatchObject({ name: 'auditor', immediate: true, argumentHint: '[on|off]' })
  })

  test('bare, the command says whether the reviewer is on, as the footer button does', ON, async ($, on) => {
    engine(on)
    otherMods(on)
    expect(await run($)).toBe('auditor is on')
    await buttonReads(await mountMode($), 'on')
  })

  test('off turns the reviewer off: the next worker turn end dispatches no review, a tool call is not recorded, and the footer reads off', ON, async ($, on) => {
    const seen = engine(on)
    otherMods(on)
    await $.prompt.submit(COMPOSER('fix the parser'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    expect(await run($, 'off')).toBe('auditor is off')
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
    expect(await run($, 'off')).toBe('auditor is off')
    await $.prompt.submit(COMPOSER('while off'))
    await $.tool.call(WORKER_CALL('Bash', { command: 'ls' }))
    expect(await run($, 'on')).toBe('auditor is on')
    await $.prompt.submit(COMPOSER('after on'))
    await workerTurn($)
    expect(seen.spawns.length).toBe(1)
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(1, 'USER: after on', 'ASSISTANT: working'))
  })

  test('off twice is idempotent: each answers off, the argument is read whatever its case or spacing, and nothing is dispatched', ON, async ($, on) => {
    const seen = engine(on)
    expect(await run($, 'off')).toBe('auditor is off')
    expect(await run($, ' OFF ')).toBe('auditor is off')
    await workerTurn($)
    expect(seen.spawns.length).toBe(0)
    expect(await run($)).toBe('auditor is off')
  })

  test('an argument that is neither on nor off is refused with its usage, and changes nothing', ON, async ($, on) => {
    engine(on)
    expect(await run($, 'bogus')).toBe('Usage: /auditor [on|off]')
    expect(await run($)).toBe('auditor is on')
  })

  test('after a failed review, bare reads auditor is failing, and a switch off and then on clears the failure', ON, async ($, on) => {
    engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', '')
    expect(await run($)).toBe('auditor is failing')
    expect(await run($, 'off')).toBe('auditor is off')
    expect(await run($, 'on')).toBe('auditor is on')
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

  test('an escalation settling while the worker is idle is submitted at once', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', ESCALATION)
    expect(seen.prompts).toEqual([FRAMED(1, ESCALATION)])
  })

  test('a plain note settling while the worker is idle is submitted at once, and its log says delivered', ON, async ($, on) => {
    const seen = engine(on)
    await workerTurn($)
    await turnEnded($, 'ag1', 'a.ts:4 idle.')
    expect(seen.prompts).toEqual([FRAMED(1, 'a.ts:4 idle.')])
    expect(logOf(seen, LOG_1)).toMatchObject({ note_delivered: true })
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
    // An escalation settling on an idle worker is submitted at once, so the user reads it as the worker answers it.
    expect(seen.prompts).toContain(FRAMED(1, ESCALATION))
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
    expect(await entriesOf($, { which: 'record' })).toBe(RECORD_OF(3, `PROMPT (plugin): ${FRAMED(2, ESCALATION)}`, 'ASSISTANT: working'))
  })
})


describe('rc regression tests', () => {
  test('a reviewer its spawn hook stood in is not given up while it reviews past ten minutes: its review settles with its note', ON, async ($, on) => {
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
    expect(seen.stops).toEqual([])
    expect(seen.conversation.failing).toBe(false)
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
  test('a /clear keeps the ids of reviewer spawns still in flight, so their traffic stays the reviewer\'s', ON, async ($, on) => {
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
    expect(await $.session.receive({ text: 'a.ts:4 swallows it.', origin: { kind: 'peer' as const, teammate: 'auditor-reviewer', isVerified: true } } as any)).toEqual({ consumed: 'auditor reviewer traffic' })
  })
})
