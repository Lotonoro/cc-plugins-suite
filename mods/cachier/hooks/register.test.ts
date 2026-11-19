import { describe, expect, mock, test } from 'claude-code/testing'
import { assistant, CHUNK_BYTES, drawnLabels, fakeFiles, LABELS, lines, mislabelled, UNLABELLED, user, withoutLabel } from './fixture'
import { HISTORY_BOUND, keyOf } from './history'
import { INITIAL as INITIAL_KEEPALIVE } from './keepalive'
import { COMPACT_FLOOR_TOKENS, stepNoticeOf, windowNoticeOf } from './night'
import { NOTICES_KEY } from './nightstep'
import { alarmOf, learnTranscript, pressCountdown, pressOnce, restoreState, STATE_SHAPE, unitFrom } from './register'
import { INITIAL_STATS } from './stats'

const PATH = '/home/test/.claude/projects/p/s1.jsonl'
const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const FIVE = { five: 18551, one: 0 }
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

// The official pricing page, cut to the table these tests read: Opus 5.5 at $4 input, $5 and $8 writes, $0.20 read per million.
const PRICING_PAGE = [
  '## Model pricing',
  '',
  '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
  '| :--- | :--- | :--- | :--- | :--- | :--- |',
  '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |',
  '',
].join('\n')

// The engine's answers beneath the plugin: the transcript (its text read from `doc`, so a test can grow it), the status
// line, the debug log, and each host read the reader makes. `runs` counts the reads.
const world = (on: any, doc: { text: string; broken?: boolean; exists?: boolean; hold?: Promise<void>; deny?: string; blockFault?: 'exit' | 'truncated'; pricing?: string; pricingStatus?: number; pricingHold?: Promise<void>; fork?: unknown; forkSends?: { reply: unknown; delayMs: number }[]; clock?: { sleep: (ms: number) => Promise<void> }; forkHold?: Promise<void>; switchHold?: Promise<void>; compactHold?: Promise<void>; forkThrows?: boolean; dropPrompt?: boolean; promptThrows?: boolean; store?: Record<string, unknown>; auditor?: boolean; markdown?: boolean; engineNode?: boolean; openThrows?: boolean; openUnplaced?: boolean; closeKeeps?: boolean; closeThrows?: boolean; panesThrow?: boolean; listUnplaced?: boolean; keysThrows?: boolean; keysHold?: Promise<void>; getHold?: { key: string; hold: Promise<void>; nth?: number }; getHeldDenied?: { key: string; hold: Promise<void>; deny: string }; setHold?: { key: string; hold: Promise<void> }; getDenied?: Set<string>; setDenied?: Set<string>; deleteDenied?: Set<string>; getGate?: (key: string, nth: number) => Promise<string | undefined> | undefined; onSet?: (key: string) => void; compact?: (e: any, rec: any) => unknown }) => {
  const rec = {
    status: [] as (string | undefined)[],
    logs: [] as string[],
    runs: 0,
    exists: 0,
    invalidations: [] as string[],
    forks: [] as string[],
    toasts: [] as string[],
    // The keys of the store's reads, in order.
    gets: [] as string[],
    // The URLs the plugin fetched.
    fetches: [] as string[],
    // The plugin's store, as the engine keeps it across sessions: values as JSON reads them back.
    store: new Map<string, unknown>(Object.entries(doc.store ?? {})),
    // The details pane as the engine holds it: the ids opened and not closed, and the calls that opened and closed them.
    panes: new Set<string>(),
    opens: [] as any[],
    closes: [] as any[],
    // The commands the plugin registered, as it registered them.
    commands: [] as any[],
    // The compactions the plugin asked the engine for, as the engine received them.
    compacts: [] as any[],
  }
  // `getHold` holds the `nth` read of its key, the first by default: the value is read at once and answered when the hold settles, so a
  // write that lands meanwhile is not in the answer.
  let getReads = 0
  on('store.get', async (_$: any, e: any) => {
    rec.gets.push(e.key)
    // `getGate` is asked about each read with its count for that key: a promise it returns holds the read, and refuses it with the
    // reason the promise settles to, if any.
    const gated = doc.getGate?.(e.key, rec.gets.filter((key) => key === e.key).length)
    if (gated !== undefined) {
      const deny = await gated
      if (deny !== undefined) return { deny }
    }
    // `getDenied` refuses every read of the keys it holds while they are in it: a test empties it to let reads through again.
    if (doc.getDenied?.has(e.key) === true) return { deny: 'read refused' }
    // `getHeldDenied` holds every read of its key until the hold settles, then refuses it with its own reason.
    if (doc.getHeldDenied !== undefined && e.key === doc.getHeldDenied.key) {
      await doc.getHeldDenied.hold
      return { deny: doc.getHeldDenied.deny }
    }
    const value = rec.store.get(e.key)
    if (doc.getHold !== undefined && e.key === doc.getHold.key && ++getReads === (doc.getHold.nth ?? 1)) {
      await doc.getHold.hold
    }
    return { value }
  })
  // `setHold` holds every write to its key until the hold settles, so a read made meanwhile is answered without it.
  on('store.set', async (_$: any, e: any) => {
    if (doc.setHold !== undefined && e.key === doc.setHold.key) await doc.setHold.hold
    // `setDenied` refuses every write to the keys it holds.
    if (doc.setDenied?.has(e.key) === true) return { deny: 'write refused' }
    rec.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    // `onSet` is told of each write that lands, in order: the store's answer is registered once, so a test cannot hook it a second time.
    doc.onSet?.(e.key)
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => {
    // `deleteDenied` refuses every delete of the keys it holds.
    if (doc.deleteDenied?.has(e.key) === true) return { deny: 'delete refused' }
    rec.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => {
    if (doc.keysHold !== undefined) await doc.keysHold
    if (doc.keysThrows === true) return { deny: 'keys refused' }
    return { value: [...rec.store.keys()] }
  })
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => {
    rec.commands.push(e)
    return { value: undefined }
  })
  on('ui.invalidate', (_$: any, e: any, next: any) => {
    rec.invalidations.push(e.event)
    return next(e)
  })
  // What answers beneath the plugins: the classic hooks the tests raise, and the turn completion.
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', async () => {
    if (doc.switchHold !== undefined) await doc.switchHold
    return {}
  })
  on('classic.PostCompact', async () => {
    if (doc.compactHold !== undefined) await doc.compactHold
    return {}
  })
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  // A compaction the plugin asks for: what the test gives as `compact` answers it (a throw refuses it), else it is skipped. The engine's side of a compaction that stands, the classic hooks
  // and the session start, is raised by the test itself where it matters.
  on('session.compact', async (_$: any, e: any) => {
    rec.compacts.push(e)
    return doc.compact === undefined ? { skip: 'this world does not compact' } : doc.compact(e, rec)
  })
  // What the footer draws beneath the plugins: the mode labels, with `auditor` another plugin's label after them, and with `markdown` only
  // another plugin's Markdown, its words in a prop. It is
  // registered ahead of the bare text below, which would otherwise answer for the footer.
  on('ui.render', { component: 'SessionMode' }, ($: any, e: any) => {
    // The engine's own footer, as core answers next(e) when no plugin beneath draws: an opaque node it draws from the props.
    if (doc.engineNode === true) return { type: 'engine', ref: 0 }
    const { Box, Button, Text, Markdown } = $.ui.resolve(e)
    if (doc.markdown === true) return Markdown({ text: 'another plugin' })
    const modes = Text({ children: [e.props.modes.join(' & ')] })
    return doc.auditor === true ? Box({ flexDirection: 'row', children: [modes, Button({ key: 'auditor', plain: true, dimColor: true, label: 'auditor is on', onPress: () => {} })] }) : modes
  })
  // What a surface draws beneath the plugins' message rows: a bare text.
  on('ui.render', () => ({ type: 'Text', children: ['reply'] }))
  on('ui.toast', (_$: any, e: any) => {
    rec.toasts.push(e.text)
    return { value: undefined }
  })
  // An open the test refuses throws, or comes back unplaced; any other open draws the pane.
  on('ui.open', (_$: any, e: any) => {
    rec.opens.push(e)
    if (doc.openThrows === true) throw new Error('open refused')
    if (doc.openUnplaced === true) return { value: { isPlaced: false, reason: 'no room' } }
    rec.panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$: any, e: any) => {
    rec.closes.push(e)
    if (doc.closeThrows === true) throw new Error('close broke')
    // A close another plugin refuses leaves the pane open and the call resolved.
    if (doc.closeKeeps !== true) rec.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => {
    if (doc.panesThrow === true) return { deny: 'panes refused' }
    return { value: [...rec.panes].map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: doc.listUnplaced !== true })) }
  })
  // The pricing page: the rows these tests read, unless the doc serves another body or status.
  on('http.fetch', async (_$: any, e: any) => {
    rec.fetches.push(e.url)
    if (doc.pricingHold !== undefined) await doc.pricingHold
    const status = doc.pricingStatus ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: doc.pricing ?? PRICING_PAGE } }
  })
  // No config dir and no home: cachier finds no overrides file, so these tests' file reads are their own.
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', (_$: any, e: any) => {
    rec.exists++
    return { value: doc.exists !== false }
  })
  on('fs.stat', (_$: any, _e: any) => {
    if (doc.broken === true) return { deny: 'stat refused' }
    if (doc.exists === false) return { deny: 'no such file' }
    return { value: fakeFiles(doc.text).stat() }
  })
  on('process.run', async (_$: any, e: any) => {
    rec.runs++
    if (doc.deny !== undefined) return { deny: doc.deny }
    if (doc.hold !== undefined) await doc.hold
    const run = fakeFiles(doc.text).run(e.argv)
    // `blockFault` answers every block read with the refusal the reader tells apart from an engine's: a nonzero exit with no output, or its stdout cut.
    if (doc.blockFault === 'exit') return { value: { ...run, exitCode: 1, stdout: '' } }
    if (doc.blockFault === 'truncated') return { value: { ...run, isStdoutTruncated: true } }
    return { value: run }
  })
  // A keepalive ping's fork: the next reply the test queues in `forkSends`, which comes its own delay after the send on the test's clock
  // (the engine refuses a test hook's own `$.clock` wait); else what the test set as `doc.fork`, else nothing to fork.
  on('model.fork', async (_$: any, e: any) => {
    rec.forks.push(e.prompt)
    if (doc.forkHold !== undefined) await doc.forkHold
    if (doc.forkThrows === true) throw new Error('fork broke')
    const send = doc.forkSends?.shift()
    if (send !== undefined) {
      await doc.clock?.sleep(send.delayMs)
      return { value: send.reply }
    }
    return { value: doc.fork ?? { isAnswered: false, reason: 'nothing-to-fork' } }
  })
  on('ui.status', (_$: any, e: any) => {
    rec.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    rec.logs.push(JSON.stringify(e))
    return { value: undefined }
  })
  return rec
}

// The status line after the reader and the countdown have run: one tick past the call.
const lastStatus = (rec: { status: (string | undefined)[] }) => rec.status[rec.status.length - 1]

// The countdown's words: the Button's label, as the plugin draws it. Test bodies have no state of their own, so the words are
// read off a drawing; a test that holds a drawing reads that one, since a second mount of the same site is refused.
const mountHint = ($: any, modes: string[] = []) => $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'SessionMode', props: { modes } } as any)
const hintOf = async (m: any) => (await m.find({ type: 'Button', key: 'details' }))?.text ?? ''
const hint = async ($: any) => {
  const m = await mountHint($)
  const words = await hintOf(m)
  await m.unmount()
  return words
}
// The debug lines a marker names, as their objects: the mod's debug sink, one line per event.
const debugOf = (rec: { logs: string[] }, marker: string): any[] =>
  rec.logs
    .map((l) => JSON.parse(l) as { text: string; to: string })
    .filter((e) => e.to === 'debug' && e.text.startsWith(`${marker} `))
    .map((e) => JSON.parse(e.text.slice(marker.length + 1)))

// Everything the footer line draws, as text: the pie and its time, and the details pane's lines. Off, paused or stopped the pie is still
// drawn, and no refresh is drawn beyond its hover. The pie is green with keepalive on, paused or stopped as well as refreshing, and is not
// green off. The drawing cannot tell paused from stopped, so the bare command does.
const expectCountdownOnly = async ($: any, state: 'off' | 'stopped' | 'paused') => {
  const drawn = await drawnHint($)
  expect(drawn).toContain('"key":"pie"')
  expect(drawn).not.toContain('ping')
  if (state === 'off') expect(drawn).not.toContain('"color":"success"')
  else expect(drawn).toContain('"color":"success"')
  expect(await toggle($, '')).toContain(`Keepalive  ${state}`)
}
// The details pane, as a click on the line opens it: its id and the props its mount takes, the title the plugin gives it.
const PANE_ID = 'cachier-details'
const PANE_PROPS = { title: 'Prompt cache', isFocused: false, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
const mountPane = ($: any) => $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'Pane', requestId: PANE_ID, props: PANE_PROPS } as any)
// The pie, pressed on the footer line: keepalive's switch, as a click on it is.
const pressPie = async ($: any) => {
  const m = await mountHint($)
  await m.press({ key: 'pie' })
  await m.unmount()
}
// Everything the line and the details draw, as text: the footer's drawing, then the pane's. A colour in it may be the pane's (the Keepalive state word,
// the Cache line's pie in the footer's own tone, and `amber` and `red` in the pie line, in the warning and error colours), so a pie-colour assertion that
// the pie is drawn in a colour reads the footer alone, with `pieDrawn`; one that denies a colour reads both, since the pane's pie is drawn in the footer's tone.
const drawnHint = async ($: any) => {
  const m = await mountHint($)
  const pane = await mountPane($)
  const drawn = JSON.stringify(await m.drawn()) + JSON.stringify(await pane.drawn())
  await pane.unmount()
  await m.unmount()
  return drawn
}

describe('countdown', () => {
  test('the footer line shows the countdown from the last touch and is redrawn each tick', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 59000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('3:59')
    await clock.advance(1000)
    expect(await hint($)).toBe('3:58')
  })

  test('a main-thread turn step reads the transcript; a subagent step does not', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    on('turn.step', async function* (_$: any, _e: any) {
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const before = rec.runs
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'sub9' } as any)) {
      // no chunks read
    }
    await clock.settle()
    expect(rec.runs).toBe(before)
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await clock.settle()
    expect(rec.runs).toBeGreaterThan(before)
  })

  test('a turn step passes its input through to the engine unchanged', async ($, on) => {
    const doc = { text: '' }
    world(on, doc)
    mock.clock(on, { now: T0 })
    let downstream: unknown
    on('turn.step', async function* (_$: any, e: any) {
      downstream = e
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const input = { turnId: 't', index: 0, model: 'm', messageCount: 1 } as any
    for await (const _c of $.turn.step(input)) {
      // no chunks read
    }
    expect(downstream).toEqual(input)
  })

  test('a transcript with no cache activity draws no countdown', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('')
  })

  test('a transcript file not yet written draws no countdown', async ($, on) => {
    const doc = { text: '', exists: false }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('')
    expect(rec.logs).toEqual([])
  })

  test('a write with no readable tag draws no countdown, as there is no lifetime to count', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 9 })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('')
  })

  test('a countdown past its TTL shows the cache expired, and what the next prompt pays', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(300000)
    expect(await hint($)).toBe('<1k tokens to rebuild')
  })

  test('a failed transcript read shows TTL unread and logs the error', async ($, on) => {
    const doc = { text: '', broken: true }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBe('TTL unread; see the debug log')
    expect(rec.logs.join('\n')).toContain('stat refused')
  })

  test('a model switch before the first prompt draws no countdown, and the first reply starts it', async ($, on) => {
    const doc = { text: '' }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: false, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    expect(await hint($)).toBe('')
    doc.text += lines([user({ uuid: 'u1', parent: null, ts: iso(T0 + 2000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 + 2500), write: 5, tags: FIVE })])
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
    expect(debugOf(rec, 'cachier switch')).toEqual([{ prompt_cache_warm: false, reading: 'none' }])
    expect(rec.logs.filter((l) => !l.includes('cachier switch'))).toEqual([])
  })

  for (const [what, from, source] of [['a resume restoring the session\'s model', 'a', 'resume'], ['a switch to the model already in use', 'b', 'command']] as const) {
    test(`${what} leaves the cache warm`, async ($, on) => {
      const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
      world(on, doc)
      const clock = mock.clock(on, { now: T0 })
      await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
      await clock.advance(10000)
      await $.classic.PostModelSwitch({ from_model: from, to_model: 'b', requested_model: 'b', source, prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
      await clock.advance(1000)
      expect(await hint($)).toBe('4:49')
    })
  }

  test('a model switch shows no cache until a response after it touches the cache', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10000)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    expect(await hint($)).toBe('reset')
    expect(rec.logs.filter((l) => !l.includes('cachier switch'))).toEqual([])
    doc.text += lines([user({ uuid: 'u2', parent: 'a1', ts: iso(T0 + 11000) }), assistant({ uuid: 'a2', parent: 'u2', ts: iso(T0 + 11500), read: 9 })])
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
  })

  test('a compaction shows no cache after compaction', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(1000)
    expect(await hint($)).toBe('reset')
  })

  test('a clear draws no countdown, and a resume reads the cache from the transcript it resumed', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 120000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 120000), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('2:59')
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('')
  })

  test('only the first block of a reply is stamped; a later block of the same reply is drawn as the engine drew it', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 60000), read: 9 })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const drawnOf = async (requestId: string, isFirstOfReply: boolean) => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text: 'reply', isFirstOfReply, isExpanded: true } } as any)
      const tree = JSON.stringify(await m.drawn())
      await m.unmount()
      return tree
    }
    await drawnOf('a1', true)
    await clock.advance(1000)
    expect(rec.logs).toEqual([])
    expect(await drawnOf('a1', false)).not.toContain(hhmm(T0 - 60000))
    expect(await drawnOf('a1', true)).toContain(hhmm(T0 - 60000))
  })

  test('a stamp is drawn at the right of a reply\'s first line once its row is looked up; an older reply shows its date', async ($, on) => {
    const oldMs = T0 - 3 * 86400000
    const doc = {
      text: lines([
        user({ uuid: 'u0', parent: null, ts: iso(oldMs) }),
        assistant({ uuid: 'old1', parent: 'u0', ts: iso(oldMs + 60000), write: 5, tags: FIVE }),
        user({ uuid: 'u1', parent: 'old1', ts: iso(T0 - 60000) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 60000), read: 9 }),
      ]),
    }
    world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const drawnOf = async (requestId: string) => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'AssistantMessage', requestId, props: { text: 'reply', isFirstOfReply: true, isExpanded: true } } as any)
      const tree = JSON.stringify(await m.drawn())
      await m.unmount()
      return tree
    }
    expect(await drawnOf('a1')).not.toContain(hhmm(T0 - 60000))
    await clock.advance(1000)
    expect(await drawnOf('a1')).toContain(hhmm(T0 - 60000))
    const d = new Date(oldMs + 60000)
    await drawnOf('old1')
    await clock.advance(1000)
    expect(await drawnOf('old1')).toContain(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(oldMs + 60000)}`)
  })

  test('a main-thread request start moves the countdown to its own start', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 59000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    on('turn.step', async function* (_$: any, _e: any) {
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(60000)
    await clock.advance(1000)
    expect(await hint($)).toBe('2:59')
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
  })

  test('a transcript touch older than a later live request start does not move the countdown back', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 59000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    on('turn.step', async function* (_$: any, _e: any) {
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(60000)
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
  })

  test('a stamp for a row the transcript has not flushed yet appears once the transcript grows, and no read runs before that', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 120000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const drawnOf = async (requestId: string) => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId, props: { text: 'prompt', isExpanded: true, origin: { kind: 'composer' } } } as any)
      const tree = JSON.stringify(await m.drawn())
      await m.unmount()
      return tree
    }
    await drawnOf('late')
    await clock.advance(1000)
    const readsBefore = rec.runs
    await clock.advance(5000)
    expect(rec.runs).toBe(readsBefore)
    doc.text += lines([user({ uuid: 'late', parent: 'u1', ts: iso(T0 - 60000) })])
    await drawnOf('late')
    await clock.advance(1000)
    expect(await drawnOf('late')).toContain(hhmm(T0 - 60000))
  })

  test('two session starts leave one countdown ticker: one status line per second', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const before = rec.status.length
    await clock.advance(3000)
    expect(rec.status.length - before).toBe(3)
  })

  test('ending the session stops the countdown', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.session.end({ reason: 'exit', sessionId: 's' } as any)
    const before = rec.status.length
    await clock.advance(3000)
    expect(rec.status.length).toBe(before)
  })

  test('a classic hook that carries a transcript path starts the countdown mid-session, with no session start', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 59000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.UserPromptSubmit({ transcript_path: PATH, prompt: 'hi' } as any)
    await clock.advance(1000)
    expect(await hint($)).toBe('3:59')
  })

  test('a stamp taken before midnight is a time, and after midnight the same row shows its date', async ($, on) => {
    const rowMs = new Date(2026, 9, 18, 23, 58).getTime()
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(rowMs) }), assistant({ uuid: 'x1', parent: 'u1', ts: iso(rowMs), read: 9 })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: new Date(2026, 9, 18, 23, 59).getTime() })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const drawnOf = async () => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'AssistantMessage', requestId: 'x1', props: { text: 'reply', isFirstOfReply: true, isExpanded: true } } as any)
      const tree = JSON.stringify(await m.drawn())
      await m.unmount()
      return tree
    }
    await drawnOf()
    await clock.advance(1000)
    expect(rec.logs).toEqual([])
    expect(await drawnOf()).toContain('"23:58"')
    await clock.advance(120000)
    expect(await drawnOf()).toContain('2026-10-18 23:58')
  })

  test('a stamp read from one transcript is not reused for another', async ($, on) => {
    const first = new Date(2026, 9, 18, 9, 15).getTime()
    const second = new Date(2026, 9, 18, 14, 40).getTime()
    const doc = { text: lines([user({ uuid: 'x1', parent: null, ts: iso(first) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: new Date(2026, 9, 18, 20, 0).getTime() })
    const drawnOf = async () => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'x1', props: { text: 'prompt', isExpanded: true, origin: { kind: 'composer' } } } as any)
      const tree = JSON.stringify(await m.drawn())
      await m.unmount()
      return tree
    }
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await drawnOf()
    await clock.advance(1000)
    expect(await drawnOf()).toContain('"09:15"')
    doc.text = lines([user({ uuid: 'x1', parent: null, ts: iso(second) })])
    await $.classic.SessionStart({ source: 'resume', transcript_path: `${PATH}.other` })
    await clock.advance(1000)
    await drawnOf()
    await clock.advance(1000)
    expect(rec.logs).toEqual([])
    expect(await drawnOf()).toContain('"14:40"')
  })

  test('several stamps asked in one tick are looked up in one pass over the transcript', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'x1', parent: null, ts: iso(T0 - 60000) }), user({ uuid: 'y1', parent: 'x1', ts: iso(T0 - 30000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const drawnOf = async (requestId: string) => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId, props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
      await m.drawn()
      await m.unmount()
    }
    await drawnOf('x1')
    await drawnOf('y1')
    const before = rec.runs
    await clock.advance(1000)
    expect(rec.runs - before).toBe(1)
  })

  test('a tick that finds its lookup still running starts no second lookup', async ($, on) => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const doc: { text: string; hold?: Promise<void> } = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'later', props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
    await m.drawn()
    await m.unmount()
    doc.hold = hold
    const before = rec.runs
    void clock.advance(1000)
    await clock.settle()
    // The transcript grows while the pass is held: a second tick must not start a pass over it.
    doc.text += lines([user({ uuid: 'g1', parent: 'u1', ts: iso(T0 - 30000) })])
    await clock.advance(1000)
    const during = rec.runs
    release()
    await clock.settle()
    expect(during - before).toBe(1)
  })

  test('a live request start in one session does not count into a session resumed after it', async ($, on) => {
    const cached = lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 400000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 399000), write: 18551, tags: FIVE })])
    const doc = { text: cached }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    on('turn.step', async function* (_$: any, _e: any) {
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
    await $.session.end({ reason: 'resume', sessionId: 'a' } as any)
    doc.text = lines([user({ uuid: 'v1', parent: null, ts: iso(T0 - 400000) }), assistant({ uuid: 'b1', parent: 'v1', ts: iso(T0 - 399000), write: 18551, tags: FIVE })])
    await $.classic.SessionStart({ source: 'resume', transcript_path: `${PATH}.resumed` })
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('~19k tokens to rebuild')
  })

  test('a classic hook that carries a new transcript path drops the live touch of the session it replaces', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 400000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 399000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    on('turn.step', async function* (_$: any, _e: any) {
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await clock.settle()
    await $.classic.UserPromptSubmit({ transcript_path: `${PATH}.other`, prompt: 'hi' } as any)
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('~19k tokens to rebuild')
  })

  test('a second session start in the same moment makes one read of the transcript', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    const before = rec.exists
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(rec.exists - before).toBe(1)
  })

  test('the status line keeps ticking while a stamp lookup is held', async ($, on) => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const doc: { text: string; hold?: Promise<void> } = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'later', props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
    await m.drawn()
    await m.unmount()
    doc.hold = hold
    await clock.advance(1000)
    const shown = rec.status.length
    await clock.advance(3000)
    expect(rec.status.length - shown).toBe(3)
    release()
    await clock.settle()
  })

  test('a row drawn again while the transcript keeps its size is not looked up again', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const draw = async () => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'placeholder', props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
      await m.drawn()
      await m.unmount()
    }
    await draw()
    await clock.advance(1000)
    const afterMiss = rec.runs
    await draw()
    await clock.advance(3000)
    expect(rec.runs).toBe(afterMiss)
  })

  test('a read requested while one is held is merged into a single read after it', async ($, on) => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const doc: { text: string; hold?: Promise<void> } = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    doc.hold = hold
    // One read is one fs.exists; its own host reads (the walk and the reply start) are not counted here.
    const before = rec.exists
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any)
    for (let i = 0; i < 100; i++) await Promise.resolve()
    expect(rec.exists - before).toBe(1)
    release()
    await clock.settle()
    expect(rec.exists - before).toBe(2)
  })
  test('ending a session forgets its live touch, even when the next session starts on the same transcript', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 400000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0 - 399000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    on('turn.step', async function* (_$: any, _e: any) {
      return { turnId: 't', index: 0, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    for await (const _c of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
    await $.session.end({ reason: 'resume', sessionId: 'a' } as any)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('~19k tokens to rebuild')
  })

  test('a failing lookup is retried only when the transcript changes size, not on every tick', async ($, on) => {
    const doc: { text: string; deny?: string } = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    doc.deny = 'boom'
    const draw = async () => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'x', props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
      await m.drawn()
      await m.unmount()
    }
    await draw()
    await clock.advance(1000)
    const failed = rec.runs
    expect(rec.logs.filter((l) => l.includes('boom')).length).toBe(1)
    await clock.advance(3000)
    expect(rec.runs).toBe(failed)
    doc.text += lines([user({ uuid: 'g0', parent: 'u1', ts: iso(T0 - 60000) })])
    await clock.advance(1000)
    expect(rec.runs).toBeGreaterThan(failed)
  })

  test('a stamp already found is not looked up again as the transcript grows', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'u1', props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
    await m.drawn()
    await m.unmount()
    await clock.advance(1000)
    // Two growths with nothing to look up. Each costs the same runs: the reread. A lookup re-run on growth would make the first cost more.
    const before = rec.runs
    doc.text += lines([user({ uuid: 'u2', parent: 'u1', ts: iso(T0 - 30000) })])
    await clock.advance(3000)
    const first = rec.runs - before
    const mid = rec.runs
    doc.text += lines([user({ uuid: 'u3', parent: 'u2', ts: iso(T0 - 20000) })])
    await clock.advance(3000)
    const second = rec.runs - mid
    expect(first).toBeGreaterThan(0)
    expect(first).toBe(second)
  })

  test('a read that throws after its stat is not repeated on every tick', async ($, on) => {
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    doc.deny = 'read refused'
    doc.text += lines([user({ uuid: 'u2', parent: 'u1', ts: iso(T0 - 30000) })])
    const before = rec.runs
    await clock.advance(1000)
    const once = rec.runs
    expect(once).toBeGreaterThan(before)
    await clock.advance(5000)
    expect(rec.runs).toBe(once)
  })

  test('a clear whose new transcript another hook already learned draws no countdown', async ($, on) => {
    const next = `${PATH}.next`
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Once armed, the write of the transcript path waits for the gate.
    let armed = false
    on('state.set', (_$: any, e: any, next: any) => (armed && e.key === 'transcript' ? gate.then(() => next(e)) : next(e)))
    const doc = { text: lines([user({ uuid: 'v1', parent: null, ts: iso(T0 - 1000) }), assistant({ uuid: 'b1', parent: 'v1', ts: iso(T0 - 1000), write: 18551, tags: FIVE })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    armed = true
    // One session start carries the new path to two handlers: the start itself, and the path learning of every classic
    // hook. The first to learn is held mid-write; the other must wait for it before it marks the session cleared.
    const cleared = $.classic.SessionStart({ source: 'clear', transcript_path: next } as any)
    for (let i = 0; i < 200; i++) await Promise.resolve()
    release()
    await cleared
    await clock.settle()
    await clock.advance(1000)
    expect(await hint($)).toBe('')
  })

  test('a transcript that cannot be stat-ed is logged once when it starts failing and once when it is readable again, not every tick', async ($, on) => {
    const doc: { text: string; broken?: boolean } = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const refused = () => rec.logs.filter((l) => l.includes('stat refused')).length
    doc.broken = true
    await clock.advance(5000)
    expect(refused()).toBe(1)
    doc.broken = false
    await clock.advance(1000)
    expect(rec.logs.filter((l) => l.includes('readable again')).length).toBe(1)
    doc.broken = true
    await clock.advance(3000)
    expect(refused()).toBe(2)
  })

  test('an id drawn under an earlier transcript is dropped when the path changes, not looked up in the new one', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'late', props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
    await m.drawn()
    await m.unmount()
    await $.classic.UserPromptSubmit({ transcript_path: `${PATH}.next`, prompt: 'hi' } as any)
    await clock.settle()
    const before = rec.runs
    await clock.advance(3000)
    expect(rec.runs).toBe(before)
  })
})

// A stamp pass whose backward walk ends unread writes a `cachier stamps` line, then only at the 1st, 2nd, 4th, 8th pass and so on of a stretch of passes that end for one
// reason; the first pass that reads through after a written stretch says so once. The lines are bounded for the load: a transcript path has a budget of 20, and the pass that would write
// its 21st writes one `muted` line instead, whichever kind the 21st would have been, and nothing after it. A change of path does not renew a budget. At most 32 paths are held, a path from its
// first line, and the first pass that would write a line for a 33rd writes one `muted` line of its own, with `paths` 32, and nothing after it for any path not already held; the paths already
// held keep their own budgets and their own `muted` lines. Each test starts with a fresh load of the mod, so no stretch or budget carries over from an earlier test.
describe('the stamp pass: a walk that ends unread is written to the debug log', () => {
  type Doc = Parameters<typeof world>[1]
  // Ids and text of the transcript that no debug line may hold. Each is distinctive, so no other text holds one by chance.
  const BAD = 'wanted-bad-4c1e9a'
  const NEWER = 'wanted-newer-7d02f1'
  const LATE = 'wanted-late-5be80c'
  const AGAIN = 'wanted-again-2f6a17'
  const PLANTED = 'planted-text-b83c5e'
  const PARSE = 'a row naming a wanted id did not parse'
  const ONE_READ = { asked: 1, still_wanted: 1, blocks_read: 1 }
  // A row naming `id` that is cut off before it closes, so it does not parse; its text is one no line may repeat.
  const unparsable = (id: string) => `{"type":"user","uuid":"${id}","note":"${PLANTED}"`
  const filler = (n: number) => user({ uuid: `filler-${n}-91d3`, parent: null, ts: iso(T0 - 90000) })
  // A row no id asks for: the transcript grows by it, which changes its size and so asks for another pass.
  const grow = (doc: Doc) => {
    doc.text += lines([user({ uuid: `grown-${doc.text.length}-6d0b`, parent: null, ts: iso(T0 - 1000) })])
  }
  // Draws the message of `requestId`, which asks for its time, and returns the drawing: the time is in it once a pass has found the row.
  const draw = async ($: any, requestId: string) => {
    const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId, props: { text: 'p', isExpanded: true, origin: { kind: 'composer' } } } as any)
    const tree = JSON.stringify(await m.drawn())
    await m.unmount()
    return tree
  }
  // The world with the session started on PATH over the transcript `doc` holds, before its first tick.
  const started = async ($: any, on: any, doc: Doc) => {
    const rec = world(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    return { rec, clock }
  }
  // The `cachier stamps` lines written so far. Reading them also checks what no debug line may hold: an id or text of the transcript, and, in these lines, its path.
  const stamps = (rec: { logs: string[] }) => {
    const all = rec.logs.join('\n')
    for (const secret of [BAD, NEWER, LATE, AGAIN, PLANTED]) expect(all).not.toContain(secret)
    const written = debugOf(rec, 'cachier stamps')
    expect(JSON.stringify(written)).not.toContain(PATH)
    return written
  }
  // A pass over a transcript that has just grown, run by the next tick.
  const nextPass = async (clock: ReturnType<typeof mock.clock>, doc: Doc) => {
    grow(doc)
    await clock.advance(1000)
  }

  type Clock = ReturnType<typeof mock.clock>
  const FAILED = 'a block read failed'
  const TRUNCATED = 'a block read was truncated'
  // The lines a pass writes over one wanted id and a walk of one block. The `read_through` line here closes a stretch of one or two passes, every one of them written.
  const unreadLine = (reason: string, passes = 1) => ({ ended: 'unread', reason, passes, ...ONE_READ })
  const readThroughLine = (reason: string, passes = 1) => ({ ended: 'read_through', reason, passes, suppressed: 0, ...ONE_READ })
  // The line that ends a path's budget of 20, and the one that ends the paths: the 33rd path to be held, with 32 held.
  const MUTED = { ended: 'muted', lines: 20 }
  const NO_MORE_PATHS = { ended: 'muted', paths: 32 }
  // A pass that ends unread, because a block read fails or is cut short; and one that reads through, the file covered with the id still missing.
  const unread = (clock: Clock, doc: Doc, fault: 'exit' | 'truncated' = 'exit') => {
    doc.blockFault = fault
    return nextPass(clock, doc)
  }
  const readsThrough = (clock: Clock, doc: Doc) => {
    doc.blockFault = undefined
    return nextPass(clock, doc)
  }
  // Passes `from` to `to` that end unread for one reason and then the other: each starts a stretch of its own, so each is written at once.
  const alternating = async (clock: Clock, doc: Doc, from: number, to: number) => {
    for (let pass = from; pass <= to; pass++) await unread(clock, doc, pass % 2 === 1 ? 'exit' : 'truncated')
  }
  const alternatingLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => unreadLine((from + i) % 2 === 1 ? FAILED : TRUNCATED))
  // The session moves to the transcript at `path`. The tick after it drops the ids drawn under the old one, so a message is drawn again for a pass to run.
  const switchTo = async ($: any, clock: Clock, path: string) => {
    await $.classic.SessionStart({ source: 'resume', transcript_path: path })
    await clock.advance(1000)
  }
  const pathOf = (n: number) => `${PATH}.${n}`
  // 32 paths held. PATH and a second path only read through, so they write nothing and take no slot; on each of 32 paths after them a message is drawn and a pass ends unread, which writes the
  // path's first line.
  const hold32 = async ($: any, clock: Clock, doc: Doc) => {
    await draw($, LATE)
    await readsThrough(clock, doc)
    for (let n = 1; n <= 32; n++) {
      if (n === 17) {
        await switchTo($, clock, `${PATH}.reads-through`)
        await draw($, LATE)
        await readsThrough(clock, doc)
      }
      await switchTo($, clock, pathOf(n))
      await draw($, LATE)
      await unread(clock, doc)
    }
  }
  // The last step of a test that stopped a path's lines: the fault is lifted and the row of the wanted `id` made readable, so the next pass finds it and its message draws the time. A pass that
  // did not run, or was skipped for this path, leaves the message without one.
  const timeAfterMute = async ($: any, clock: Clock, doc: Doc, id: string) => {
    expect(await draw($, id)).not.toContain(hhmm(T0 - 60000))
    doc.blockFault = undefined
    doc.deny = undefined
    doc.text += lines([user({ uuid: id, parent: null, ts: iso(T0 - 60000) })])
    await clock.advance(1000)
    expect(await draw($, id)).toContain(hhmm(T0 - 60000))
  }

  test('a walk that meets a row naming a wanted id that does not parse is written once, with the counts of the pass and nothing of the transcript', async ($, on) => {
    // The bad row is in the older of two blocks, behind a padded row and the newer row: the pass reads both, finds the newer id and ends unread at the bad one.
    const doc: Doc = { text: lines([filler(1), unparsable(BAD), user({ uuid: 'pad-5a7e', parent: null, ts: iso(T0 - 80000), pad: CHUNK_BYTES }), user({ uuid: NEWER, parent: null, ts: iso(T0 - 60000) })]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, BAD)
    await draw($, NEWER)
    await clock.advance(1000)
    expect(stamps(rec)).toEqual([{ ended: 'unread', reason: PARSE, passes: 1, asked: 2, still_wanted: 1, blocks_read: 2 }])
  })

  const refusals: [what: string, doc: () => Doc, reason: string, blocksRead: number][] = [
    ['a block read that fails', () => ({ text: lines([filler(1), filler(2)]), blockFault: 'exit' }), 'a block read failed', 1],
    ['a block read that is truncated', () => ({ text: lines([filler(1), filler(2)]), blockFault: 'truncated' }), 'a block read was truncated', 1],
    // The row is carried back through four blocks and passes the cap in the fifth read, where it is whole.
    ['a row over 4 MiB', () => ({ text: lines([user({ uuid: 'big-row-3f0b', parent: null, ts: iso(T0 - 90000), pad: 4194304 + 10 }), filler(1)]) }), 'a row is over the 4 MiB cap', 5],
  ]
  for (const [what, doc, reason, blocksRead] of refusals) {
    test(`a walk that meets ${what} is written with its own reason`, async ($, on) => {
      const { rec, clock } = await started($, on, doc())
      await draw($, LATE)
      await clock.advance(1000)
      expect(stamps(rec)).toEqual([{ ended: 'unread', reason, passes: 1, asked: 1, still_wanted: 1, blocks_read: blocksRead }])
    })
  }

  test('a stretch of passes that end unread for one reason is written at its 1st, 2nd, 4th and 8th pass, each line giving the count', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), unparsable(BAD), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, BAD)
    await clock.advance(1000)
    for (let pass = 2; pass <= 8; pass++) await nextPass(clock, doc)
    expect(stamps(rec)).toEqual([1, 2, 4, 8].map((passes) => ({ ended: 'unread', reason: PARSE, passes, ...ONE_READ })))
  })

  test('a pass that throws writes no line and leaves the stretch as it was', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), unparsable(BAD), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, BAD)
    await clock.advance(1000)
    await nextPass(clock, doc)
    expect(stamps(rec).map((l) => l.passes)).toEqual([1, 2])
    doc.deny = 'refused-by-test-8f4a'
    await nextPass(clock, doc)
    expect(rec.logs.some((l) => l.includes('refused-by-test-8f4a'))).toBe(true)
    expect(stamps(rec).map((l) => l.passes)).toEqual([1, 2])
    doc.deny = undefined
    // The throwing pass did not count: this is the stretch's 3rd pass, which is not written, and the next its 4th.
    await nextPass(clock, doc)
    expect(stamps(rec).map((l) => l.passes)).toEqual([1, 2])
    await nextPass(clock, doc)
    expect(stamps(rec)).toEqual([1, 2, 4].map((passes) => ({ ended: 'unread', reason: PARSE, passes, ...ONE_READ })))
  })

  const readThroughs: [what: string, change: (doc: Doc) => void, counts: { still_wanted: number; blocks_read: number }][] = [
    ['covers the file with its id still missing', (doc) => { doc.blockFault = undefined; grow(doc) }, { still_wanted: 1, blocks_read: 1 }],
    ['stops with every id found', (doc) => { doc.blockFault = undefined; doc.text += lines([user({ uuid: LATE, parent: null, ts: iso(T0 - 60000) })]) }, { still_wanted: 0, blocks_read: 1 }],
    ['reads an empty file, though a block read would still fail', (doc) => { doc.text = '' }, { still_wanted: 1, blocks_read: 0 }],
  ]
  for (const [what, change, counts] of readThroughs) {
    test(`the first pass that ${what} after a written stretch says so, with the stretch's reason, passes and unwritten passes; a later unread pass starts a new stretch`, async ($, on) => {
      const doc: Doc = { text: lines([filler(1), filler(2)]), blockFault: 'exit' }
      const { rec, clock } = await started($, on, doc)
      await draw($, LATE)
      await clock.advance(1000)
      await nextPass(clock, doc)
      await nextPass(clock, doc)
      change(doc)
      await clock.advance(1000)
      expect(stamps(rec)).toEqual([
        { ended: 'unread', reason: 'a block read failed', passes: 1, ...ONE_READ },
        { ended: 'unread', reason: 'a block read failed', passes: 2, ...ONE_READ },
        { ended: 'read_through', reason: 'a block read failed', passes: 3, suppressed: 1, asked: 1, ...counts },
      ])
      await draw($, AGAIN)
      doc.blockFault = 'exit'
      await nextPass(clock, doc)
      expect(stamps(rec).slice(3)).toMatchObject([{ ended: 'unread', reason: 'a block read failed', passes: 1 }])
    })
  }

  test('a pass that ends unread for another reason starts a new stretch, written at once, and the stretch it cut short gets no line', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]), blockFault: 'exit' }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    // Three passes end unread because a block read fails, the 3rd not written; then three end unread because one is truncated, which is a new stretch.
    await clock.advance(1000)
    await nextPass(clock, doc)
    await nextPass(clock, doc)
    doc.blockFault = 'truncated'
    await nextPass(clock, doc)
    await nextPass(clock, doc)
    await nextPass(clock, doc)
    // The pass that reads through gives the new stretch's own count: its 3 passes, 1 of them not written.
    doc.blockFault = undefined
    await nextPass(clock, doc)
    expect(stamps(rec)).toEqual([
      { ended: 'unread', reason: 'a block read failed', passes: 1, ...ONE_READ },
      { ended: 'unread', reason: 'a block read failed', passes: 2, ...ONE_READ },
      { ended: 'unread', reason: 'a block read was truncated', passes: 1, ...ONE_READ },
      { ended: 'unread', reason: 'a block read was truncated', passes: 2, ...ONE_READ },
      { ended: 'read_through', reason: 'a block read was truncated', passes: 3, suppressed: 1, ...ONE_READ },
    ])
  })

  test('a change of transcript ends the stretch with no line: the first unread pass on the new one is its 1st', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), unparsable(BAD), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, BAD)
    await clock.advance(1000)
    await nextPass(clock, doc)
    expect(stamps(rec).map((l) => l.passes)).toEqual([1, 2])
    await $.classic.SessionStart({ source: 'resume', transcript_path: `${PATH}.other` })
    await clock.advance(1000)
    await draw($, BAD)
    await nextPass(clock, doc)
    expect(stamps(rec)).toEqual([1, 2, 1].map((passes) => ({ ended: 'unread', reason: PARSE, passes, ...ONE_READ })))
  })

  test('a pass that reads through when no stretch was written writes no line, and the next one that ends unread is written', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    // It covers the file: the id is not in it yet.
    await clock.advance(1000)
    expect(stamps(rec)).toEqual([])
    // It stops: the id is found.
    doc.text += lines([user({ uuid: LATE, parent: null, ts: iso(T0 - 60000) })])
    await clock.advance(1000)
    expect(stamps(rec)).toEqual([])
    await draw($, AGAIN)
    doc.blockFault = 'truncated'
    await nextPass(clock, doc)
    expect(stamps(rec)).toEqual([{ ended: 'unread', reason: 'a block read was truncated', passes: 1, ...ONE_READ }])
  })

  test('an id drawn while a pass runs is not among the ids the pass leaves wanted', async ($, on) => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const doc: Doc = { text: lines([filler(1), filler(2)]), blockFault: 'exit' }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    doc.hold = hold
    void clock.advance(1000)
    await clock.settle()
    await draw($, AGAIN)
    release()
    await clock.settle()
    expect(stamps(rec)).toEqual([{ ended: 'unread', reason: 'a block read failed', passes: 1, ...ONE_READ }])
  })

  test('a pass that alternates unread and read through writes 20 lines, then one muted line in the 21st place, then nothing', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    // Seventeen cycles: ten fill the 20 lines, the 11th cycle's unread pass is the 21st line's place, and six cycles follow it.
    for (let cycle = 1; cycle <= 17; cycle++) {
      await unread(clock, doc)
      await readsThrough(clock, doc)
    }
    const written = Array.from({ length: 10 }, () => [unreadLine(FAILED), readThroughLine(FAILED)]).flat()
    expect(stamps(rec)).toEqual([...written, MUTED])
    await timeAfterMute($, clock, doc, LATE)
    expect(stamps(rec)).toEqual([...written, MUTED])
  })

  test('two reasons that alternate write 20 unread lines, then the muted line, and a pass that reads through after it writes nothing', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    // 27 passes: the 21st is the muted line's place and six follow it.
    await alternating(clock, doc, 1, 27)
    const written = alternatingLines(1, 20)
    expect(stamps(rec)).toEqual([...written, MUTED])
    // The last pass ended unread, so a stretch stands, and a path with budget left would get a read_through line; this path's budget is spent, so nothing is written.
    await readsThrough(clock, doc)
    await timeAfterMute($, clock, doc, LATE)
    expect(stamps(rec)).toEqual([...written, MUTED])
  })

  test('the muted line takes the 21st place when that line would have been a read_through line', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    // Two unread passes of one stretch, both written, then nine pairs of a pass that reads through and one that ends unread: the 20th line is unread and the 21st would be a read_through.
    const written = [unreadLine(FAILED, 1), unreadLine(FAILED, 2)]
    await unread(clock, doc)
    await unread(clock, doc)
    for (let pair = 1; pair <= 9; pair++) {
      await readsThrough(clock, doc)
      await unread(clock, doc)
      written.push(readThroughLine(FAILED, pair === 1 ? 2 : 1), unreadLine(FAILED, 1))
    }
    expect(stamps(rec)).toEqual(written)
    await readsThrough(clock, doc)
    expect(stamps(rec)).toEqual([...written, MUTED])
    for (let cycle = 1; cycle <= 6; cycle++) {
      await unread(clock, doc)
      await readsThrough(clock, doc)
    }
    await timeAfterMute($, clock, doc, LATE)
    expect(stamps(rec)).toEqual([...written, MUTED])
  })

  test('a muted path stays muted when the session goes to another path and back, and the other path has a budget of its own', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await draw($, LATE)
    // Path A: 21 passes that end unread, for one reason and then the other; the 21st is muted.
    await alternating(clock, doc, 1, 21)
    // Path B: its first unread pass is its 1st, and written.
    await switchTo($, clock, pathOf(2))
    await draw($, AGAIN)
    await unread(clock, doc)
    // Path A again: its budget is as it was left, so passes that end unread and one that reads through write nothing.
    await switchTo($, clock, PATH)
    await draw($, LATE)
    await unread(clock, doc)
    await readsThrough(clock, doc)
    await alternating(clock, doc, 1, 5)
    await timeAfterMute($, clock, doc, LATE)
    expect(stamps(rec)).toEqual([...alternatingLines(1, 20), MUTED, unreadLine(FAILED, 1)])
  })

  test('a path that only ever reads through is not held: after 32 of them, the next path\'s first unread pass writes its own line, not the line for the paths', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    // PATH and 31 more paths: on each a message is drawn and a pass reads through with no stretch standing, which writes nothing.
    await draw($, LATE)
    await readsThrough(clock, doc)
    for (let n = 1; n <= 31; n++) {
      await switchTo($, clock, pathOf(n))
      await draw($, LATE)
      await readsThrough(clock, doc)
    }
    expect(stamps(rec)).toEqual([])
    // A 33rd path: its first unread pass writes its own line, and its next pass, for another reason, writes another under its budget.
    await switchTo($, clock, pathOf(32))
    await draw($, LATE)
    await unread(clock, doc)
    await unread(clock, doc, 'truncated')
    expect(stamps(rec)).toEqual([unreadLine(FAILED), unreadLine(TRUNCATED)])
  })

  test('the 33rd path to be held gets one muted line for the paths, and nothing is written for it or for a 34th after it', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await hold32($, clock, doc)
    // Each of the 32 paths wrote its first line before the 33rd is tried; the two that only read through wrote none.
    const held = Array.from({ length: 32 }, () => unreadLine(FAILED))
    expect(stamps(rec)).toEqual(held)
    // The 33rd path's first unread pass writes the line for the paths in place of its own.
    await switchTo($, clock, pathOf(33))
    await draw($, LATE)
    await unread(clock, doc)
    expect(stamps(rec)).toEqual([...held, NO_MORE_PATHS])
    await readsThrough(clock, doc)
    await unread(clock, doc, 'truncated')
    await unread(clock, doc)
    await readsThrough(clock, doc)
    await timeAfterMute($, clock, doc, LATE)
    // A 34th path: the same silence, and its passes run.
    await switchTo($, clock, pathOf(34))
    await draw($, AGAIN)
    await unread(clock, doc)
    await readsThrough(clock, doc)
    await unread(clock, doc, 'truncated')
    await timeAfterMute($, clock, doc, AGAIN)
    expect(stamps(rec)).toEqual([...held, NO_MORE_PATHS])
  })

  test('after the line for the paths, a path held before keeps its own budget and is muted at its own 21st line', async ($, on) => {
    const doc: Doc = { text: lines([filler(1), filler(2)]) }
    const { rec, clock } = await started($, on, doc)
    await hold32($, clock, doc)
    const held = Array.from({ length: 32 }, () => unreadLine(FAILED))
    await switchTo($, clock, pathOf(33))
    await draw($, LATE)
    await unread(clock, doc)
    // The 2nd path held has one line written of its 20. Back on it, the next 19 passes that end unread write theirs, and the 20th is muted.
    await switchTo($, clock, pathOf(2))
    await draw($, AGAIN)
    await alternating(clock, doc, 1, 20)
    expect(stamps(rec)).toEqual([...held, NO_MORE_PATHS, ...alternatingLines(1, 19), MUTED])
    await alternating(clock, doc, 21, 26)
    await readsThrough(clock, doc)
    await timeAfterMute($, clock, doc, AGAIN)
    expect(stamps(rec)).toEqual([...held, NO_MORE_PATHS, ...alternatingLines(1, 19), MUTED])
  })

  // The fault lines of the stamp lookup, the size read and the cache read: each name has a budget of 20 lines a load, and the 21st is replaced by one `cachier faults` line naming the writer.
  describe('a fault that lasts: the stamp lookup\'s, the size read\'s and the cache read\'s lines are bounded, each name by its own budget', () => {
    // The text of the errors the denied block reads and the refused size reads raise.
    const DENIED = 'denied-by-test-3c9e41'
    const REFUSED = 'stat refused'
    const muted = (writer: string) => ({ writer, ended: 'muted', lines: 20 })
    const reports = (n: number) => Array.from({ length: n }, () => 'report')
    // What a flipping size read writes while its budget lasts: a report, then the line that it is readable again.
    const flips = (n: number) => Array.from({ length: n }, () => ['report', 'readable again']).flat()
    // The fault lines written so far, in order: a failure report as 'report', the size read's recovery line as 'readable again', and a `cachier faults` line as its object.
    const faultLines = (rec: { logs: string[] }) =>
      rec.logs
        .map((l) => JSON.parse(l) as { text: string; to: string })
        .filter((e) => e.to === 'debug')
        .flatMap((e) => {
          if (e.text.startsWith('cachier faults ')) return [JSON.parse(e.text.slice('cachier faults '.length))]
          if (e.text === 'cachier: transcript readable again') return ['readable again']
          return e.text.includes(DENIED) || e.text.includes(REFUSED) ? ['report'] : []
        })
    // `n` passes, each after a growth: each asks one cache read and, with a message wanted, one lookup.
    const passes = async (clock: Clock, doc: Doc, n: number) => {
      for (let pass = 1; pass <= n; pass++) await nextPass(clock, doc)
    }
    // A turn's step and end, each of which asks a cache read.
    const turn = async ($: any, clock: Clock) => {
      await mainStep($)
      await turnEnd($)
      await clock.settle()
    }
    // `n` flips of the size read: refused for a tick, readable again for the next. The file does not change, so neither tick asks a read.
    const flipping = async (clock: Clock, doc: Doc, n: number) => {
      for (let flip = 1; flip <= n; flip++) {
        doc.broken = true
        await clock.advance(1000)
        doc.broken = false
        await clock.advance(1000)
      }
    }

    test('a cache read that throws every time writes 20 reports across its triggers, one muted line, then nothing, and still lands once the fault lifts', async ($, on) => {
      // The world answers a turn's step, which `started` leaves unanswered.
      const doc: Doc = cached()
      const rec = kaWorld(on, doc)
      const clock = mock.clock(on, { now: T0 })
      await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
      await clock.settle()
      doc.deny = DENIED
      // Eight reads from four turns, then twelve from ticks that follow growth.
      for (let n = 1; n <= 4; n++) await turn($, clock)
      await passes(clock, doc, 12)
      expect(faultLines(rec)).toEqual(reports(20))
      // The 21st read's report is the muted line, and five more reads of each kind write nothing.
      await passes(clock, doc, 1)
      await turn($, clock)
      await passes(clock, doc, 3)
      expect(faultLines(rec)).toEqual([...reports(20), muted('cache read')])
      expect(lastStatus(rec)).toContain('TTL unread')
      // The next read lands, and the tick after it draws the countdown from the cache it read.
      await timeAfterMute($, clock, doc, LATE)
      await clock.advance(1000)
      expect(await hint($)).toMatch(/^\d+:\d\d$/)
    })

    test('with a message wanted, the stamp lookup and the cache read each write 20 reports and one muted line of their own, and no more over later passes', async ($, on) => {
      const doc: Doc = cached()
      const { rec, clock } = await started($, on, doc)
      await draw($, LATE)
      doc.deny = DENIED
      // The 21st pass is each name's 21st line; five more passes follow.
      await passes(clock, doc, 26)
      const written = faultLines(rec)
      // The two writers' reports read alike, so the 40 reports precede both muted lines, one for each writer.
      expect(written.slice(0, 40)).toEqual(reports(40))
      expect(written.slice(40)).toHaveLength(2)
      expect(written.slice(40)).toEqual(expect.arrayContaining([muted('stamp lookup'), muted('cache read')]))
      await timeAfterMute($, clock, doc, LATE)
    })

    test('a size read that flaps writes its report and its readable-again line 10 times, then one muted line, then nothing', async ($, on) => {
      const doc: Doc = cached()
      const { rec, clock } = await started($, on, doc)
      await flipping(clock, doc, 10)
      expect(faultLines(rec)).toEqual(flips(10))
      // The 11th flip's report is the 21st line; the line that it is readable again and five more flips write nothing.
      await flipping(clock, doc, 6)
      expect(faultLines(rec)).toEqual([...flips(10), muted('transcript size')])
      await timeAfterMute($, clock, doc, LATE)
    })

    test('a muted size read and a muted cache read leave the stamp lookup its own budget', async ($, on) => {
      const doc: Doc = cached()
      const { rec, clock } = await started($, on, doc)
      await flipping(clock, doc, 11)
      doc.deny = DENIED
      await passes(clock, doc, 21)
      await draw($, LATE)
      await passes(clock, doc, 26)
      expect(faultLines(rec)).toEqual([...flips(10), muted('transcript size'), ...reports(20), muted('cache read'), ...reports(20), muted('stamp lookup')])
      await timeAfterMute($, clock, doc, LATE)
    })

    test('a muted stamp lookup and a muted cache read leave the size read its own budget', async ($, on) => {
      const doc: Doc = cached()
      const { rec, clock } = await started($, on, doc)
      await draw($, LATE)
      doc.deny = DENIED
      await passes(clock, doc, 26)
      const before = faultLines(rec)
      expect(before.filter((l) => typeof l === 'object')).toHaveLength(2)
      await flipping(clock, doc, 16)
      expect(faultLines(rec).slice(before.length)).toEqual([...flips(10), muted('transcript size')])
      await timeAfterMute($, clock, doc, LATE)
    })

    test('a throw that escapes a read, a state-store fault, is reported under the cache read budget the failed reads spend', async ($, on) => {
      let refused = false
      on('state.set', (_$: any, e: any, next: any) => (refused && e.key === 'view' ? { deny: DENIED } : next(e)))
      const doc: Doc = cached()
      const { rec, clock } = await started($, on, doc)
      // Ten reads fail in the read, ten more escape it: the budget is one.
      doc.deny = DENIED
      await passes(clock, doc, 10)
      doc.deny = undefined
      refused = true
      await passes(clock, doc, 16)
      expect(faultLines(rec)).toEqual([...reports(20), muted('cache read')])
      refused = false
      await timeAfterMute($, clock, doc, LATE)
    })
  })
})

// Keepalive: the toggle and the ping, with the engine answering beneath. A ping's fork is recorded in `rec.forks`.
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ANSWERED = { isAnswered: true, text: 'ok', usage: { ...ZERO, cache_read_input_tokens: 18551 } }
const ONE_HOUR = { five: 0, one: 5 }
const MIN = 60000

// A main thread whose last request was sent at T0 and wrote the cache with the given tags.
const cached = (tags: { five: number; one: number } = FIVE) => ({
  text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags })]),
})

// A ping is answered from the cache unless the test sets `doc.fork` otherwise.
const kaWorld = (on: any, doc: any) => {
  doc.fork ??= ANSWERED
  const rec = world(on, doc)
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'x', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('prompt.submit', (_$: any, e: any) => {
    if (doc.promptThrows === true) throw new Error('prompt broke')
    return doc.dropPrompt === true ? { drop: 'test' } : { text: e.text, origin: e.origin }
  })
  return rec
}

// Each main-thread turn has its own id, as the engine gives it. The last one started is the turn a turn end closes.
let turnSeq = 0
let lastTurnId = 't0'
// A main-thread request (its step starts a touch, and holds the idle gap shut) and the turn's end (which opens it).
const mainStep = async ($: any) => {
  lastTurnId = `t${++turnSeq}`
  for await (const _c of $.turn.step({ turnId: lastTurnId, index: 0, model: 'm', messageCount: 1 } as any)) {
    // no chunks read
  }
}
const turnEnd = ($: any, agentId?: string) => $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: lastTurnId, reason: 'answer', agentId } as any)
// The command's text read as one line: an answer wraps its sections, so a figure is matched whole. Structure is read from `commandText`.
const toggle = async ($: any, args: string) => (await commandText($, args)).replace(/\n\s*/g, ' ')
const commandText = async ($: any, args: string): Promise<string> => (await $.command.run({ command: 'keepalive', args, origin: { kind: 'composer' } } as any)).text
const userPrompt = ($: any) => $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as any)

describe('keepalive', () => {
  test('a ping served without the cache stops keepalive in one status clause, and its read and write go to the debug log', async ($, on) => {
    const doc: any = cached()
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    expect(lastStatus(rec)).toBe('keepalive stopped: reply not served from cache')
    expect(debugOf(rec, 'cachier ping')[0].usage).toMatchObject({ read: 0, write: 18000 })
  })

  test('an empty reply whose usage reads the cache is served: keepalive stays on, the next refresh is scheduled, and the touch moves', { options: { keepalive_lead_s: 60, keepalive_count: 9 } }, async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 9')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    expect(await toggle($, '')).toContain('Keepalive  on, refreshing')
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_read_input_tokens: 336000 } }
    await clock.advance(241000)
    expect(lastStatus(rec)).toBeUndefined()
    expect(debugOf(rec, 'cachier ping').at(-1).usage).toMatchObject({ read: 336000 })
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, refreshing')
    expect(text).toContain('next in ')
    expect(text).toMatch(/Cache ● warm · (4:\d\d|5:00) left · 5m TTL/)
  })

  test('the debug line of an empty reply that read the cache says empty reply, and keepalive stays on', { options: { keepalive_lead_s: 60, keepalive_count: 9 } }, async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 9')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_read_input_tokens: 336000 } }
    await clock.advance(241000)
    expect(debugOf(rec, 'cachier ping').at(-1)).toMatchObject({ outcome: 'empty reply', usage: { read: 336000 } })
    expect(await toggle($, '')).toContain('Keepalive  on, refreshing')
  })

  test('a response stamped 20 s ahead of the clock counts as now: the countdown and the next refresh read the same time', { options: { keepalive_lead_s: 60, keepalive_count: 2 } }, async ($, on) => {
    const ahead = T0 + 20000
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(ahead) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(ahead), write: 18551, tags: FIVE })]) }
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
    expect(await toggle($, '')).toContain('next in 3:59')
  })

  test('a reread before the clock catches up with a stamp ahead of it keeps the touch the first read gave', { options: { keepalive_lead_s: 60, keepalive_count: 2 } }, async ($, on) => {
    const ahead = T0 + 20000
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(ahead) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(ahead), write: 18551, tags: FIVE })]) }
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await clock.advance(10000)
    // The transcript grows with no new response: the tick reads it again while the stamp is still ahead of the clock.
    doc.text += lines([user({ uuid: 'u2', parent: 'a1', ts: iso(ahead) })])
    await clock.advance(1000)
    await clock.advance(1000)
    expect(await hint($)).toBe('4:48')
    // After the clock passes the stamp, a reread still keeps the first read's touch: the stamp ran ahead of this clock, so it is no
    // later a time on it than when it was first read.
    await clock.advance(18000)
    doc.text += lines([user({ uuid: 'u3', parent: 'u2', ts: iso(ahead) })])
    await clock.advance(1000)
    await clock.advance(1000)
    expect(await hint($)).toBe('4:28')
  })

  test('a new session starts with keepalive off, and an idle hour sends no fork', { timeoutMs: 60000 }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await mainStep($)
    await turnEnd($)
    await clock.advance(3600000)
    await expectCountdownOnly($, 'off')
    expect(rec.forks).toEqual([])
  })

  test('enabling without a lead is refused and changes nothing', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    expect(await toggle($, 'on')).toMatch(/^usage:/)
    await clock.advance(1000)
    await expectCountdownOnly($, 'off')
  })

  test('enabling without pings sends the break-even count, and with no price for the model the fixed count', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(await toggle($, 'on 60')).toContain('keepalive on: lead 60 s, 3 refreshes.')
  })

  test('enabling shows keepalive on with its cost, the tokens each ping reads and how often, and starts no fork', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const text = await toggle($, 'on 60 2')
    expect(text).toContain('keepalive on: lead 60 s, 2 refreshes.')
    expect(text).toContain('A refresh reads the warm cache: ~19k cached')
    expect(text).toContain('if it goes cold, your next prompt rebuilds it: ~19k written')
    expect(text).toContain('every 4 min')
    expect(text).toContain('can also write')
    expect(rec.forks).toEqual([])
    await clock.advance(1000)
    expect(await drawnHint($)).toContain('keep warm ~19k read/refresh · if cold ~19k tokens rebuild')
  })

  test('a ping is due the lead before the TTL after the last touch, a ping counts as a touch, and the count bounds the pings', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(1000)
    expect(await hint($)).toContain('4:59')
    await clock.advance(239000)
    expect(rec.forks.length).toBe(2)
    await clock.advance(600000)
    expect(rec.forks.length).toBe(2)
    expect(await toggle($, '')).toContain('Keepalive  paused count used · resumes on next prompt')
  })

  test('no fork starts during a turn: a due ping waits for the turn to end', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('refresh due · waits for turn end')
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.forks.length).toBe(1)
  })

  test('a subagent turn ending does not open the idle gap for the main thread', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(240000)
    await turnEnd($, 'sub9')
    await clock.advance(1000)
    expect(rec.forks).toEqual([])
  })

  test('a lapsed cache is never pinged: a turn that ends after the TTL stops keepalive as expired', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(310000)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  paused cache expired · resumes on next prompt')
  })

  test('a failed ping shows its reason and sends no further fork until a user prompt re-arms it with the full count', async ($, on) => {
    const doc: any = cached()
    doc.fork = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('keepalive stopped: API error 529 (overloaded)')
    await clock.advance(120000)
    expect(rec.forks.length).toBe(1)
    doc.fork = ANSWERED
    await userPrompt($)
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('2 left')
  })

  test('a ping that throws stops keepalive, and is not retried on the next tick', async ($, on) => {
    const doc: any = cached()
    doc.forkThrows = true
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    await clock.advance(5000)
    expect(rec.forks.length).toBe(1)
    expect(lastStatus(rec)).toContain('keepalive stopped: refresh threw · see debug log')
  })

  test('a fork answered without any cache read stops keepalive as not served from the cache', async ($, on) => {
    const doc: any = cached()
    doc.fork = { isAnswered: true, text: 'ok', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('keepalive stopped: reply not served from cache')
    // The unserved ping moved no touch: the countdown still runs from the turn's own request.
    expect(await hint($)).toContain('0:59')
  })

  test('with no transcript, or no cache yet, nothing is scheduled and no fork is sent before the first response', async ($, on) => {
    const rec = kaWorld(on, { text: '', exists: false })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await clock.advance(600000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  on, no count no live cache · nothing scheduled')
    // The footer's word and the heading's state name one state: the heading's line is `on, ` and the footer's word.
    const word = await hint($)
    expect(word).toBe('no count')
    const heading = (await commandText($, '')).split('\n').find((l: string) => l.startsWith('Keepalive'))
    expect(heading).toBe(`Keepalive  on, ${word}`)
  })

  test('enabling with no transcript path shows no cost and sends no fork', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup' } as any)
    expect(await toggle($, 'on 60 2')).toContain('No live cache to count from yet, so nothing is scheduled until there is one.')
    await clock.advance(600000)
    expect(rec.forks).toEqual([])
  })

  test('a write with no readable tag schedules nothing', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5 })]) }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(600000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  on, no count no live cache · nothing scheduled')
  })

  test('a /clear with keepalive on: the line under the on, no count heading says there is no cache until the next reply, and no sentence', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60 2')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, no count no live cache · nothing scheduled · cache from next reply')
    expect(text).not.toContain('pie: amber')
  })

  test('nothing written yet, with keepalive on: the line under the on, no count heading says there is no cache until the next reply', async ($, on) => {
    kaWorld(on, { text: '' })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60 2')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, no count no live cache · nothing scheduled · cache from next reply')
    expect(text).not.toContain('pie: amber')
  })

  test('an unread view with keepalive on: the line under the on, no count heading has no clause', async ($, on) => {
    kaWorld(on, { text: '', broken: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60 2')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, no count no live cache · nothing scheduled')
    expect(text).not.toContain('there is no cache until the next reply')
  })

  test('a TTL-unknown view with keepalive on: the line under the on, no count heading has no clause', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 5 })]) }
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(600000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, no count no live cache · nothing scheduled')
    expect(text).not.toContain('there is no cache until the next reply')
  })

  test('a TTL change that leaves the lead at or above the TTL pauses keepalive and says why', async ($, on) => {
    const doc: any = cached(ONE_HOUR)
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 400 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  on, refreshing refresh ~19k cached · every')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('next in ')
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('keepalive paused: lead 400s ≥ 300s TTL')
    expect(await toggle($, '')).toContain('Keepalive  paused lead 400s ≥ 300s TTL')
    await clock.advance(600000)
    expect(rec.forks).toEqual([])
  })

  test('a ping is not sent while the cache is cold after a model switch, and waits for a turn to touch it again', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  on, no count no live cache · nothing scheduled · cache from next reply')
  })

  test('a compaction leaves the cache cold: no ping is sent until a main-thread write lands', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  on, no count no live cache · nothing scheduled · cache from next reply')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
  })

  test('the next turn\'s start closes the idle gap again: a ping due during that turn waits for its end', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(100000)
    await mainStep($)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('refresh due · waits for turn end')
  })

  test('a ping still running is not joined by a second one from a later tick', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 30000)
    expect(rec.forks.length).toBe(1)
    release()
    await clock.advance(1000)
    expect(rec.forks.length).toBe(1)
  })

  test('a refresh sent now reads on, refreshing on the heading with the running figure beneath it, while its fork is in flight with a refresh still left', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 30000)
    expect(rec.forks.length).toBe(1)
    const text = await commandText($, '')
    expect(text).toContain('\nKeepalive  on, refreshing\n  refresh ~19k cached · every 4 min\n  if cold: rebuild ~19k written')
    expect(text.split('\n').filter((line: string) => line.startsWith('Keepalive'))).toEqual(['Keepalive  on, refreshing'])
    expect(text).not.toContain('refresh due')
    expect(text).not.toContain('next in ')
    release()
    await clock.advance(1000)
  })

  test('between the last refresh\'s count and its count-used stop being recorded, the heading reads paused and the pie is green, and recording the stop leaves the pie green', async ($, on) => {
    const rec = kaWorld(on, cached())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'keepalive' && e.value?.stop === 'count used' && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 500)
    expect(rec.forks.length).toBe(1)
    const advancing = clock.advance(1000)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      expect(await toggle($, '')).toContain('Keepalive  paused count used · resumes on next prompt')
      expect((await pieDrawn($)).pie).toContain('"color":"success"')
    } finally {
      release()
    }
    await advancing
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  paused count used · resumes on next prompt')
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
  })

  test('a competing write to the keepalive state between a tick\'s read and its commit fails that commit: no fork then, and the next tick forks', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    // The first ping's commit is held until the test releases it, so the test can write the state in between.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (!held && e.key === 'keepalive' && e.value?.seq === 1) {
        held = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(held).toBe(true)
    // The user's own toggle writes the state while the commit waits: the commit's version is now stale.
    await toggle($, 'on 60 2')
    release()
    await clock.settle()
    expect(rec.forks.length).toBe(0)
    // The competing toggle stands: its state is the one the next tick draws, and no ping followed the stale commit.
    await clock.advance(1000)
    expect(rec.forks.length).toBe(1)
  })

  test('a keepalive state write that fails inside a turn hook does not reach the engine: the turn streams, the failure is logged, and no fork follows', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let failing = false
    on('state.set', (_$: any, e: any, next: any) => (failing && e.key === 'keepalive' ? { value: { isSet: false } } : next(e)))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    failing = true
    await mainStep($)
    expect(rec.logs.some((l) => l.includes('keepalive state changed on every write attempt'))).toBe(true)
    await turnEnd($)
    // The writes work again: only the broken gap keeps the ping from forking.
    failing = false
    await clock.advance(240000 + 30000)
    expect(rec.forks.length).toBe(0)
    expect(lastStatus(rec)).toContain('a state write failed')
  })

  test('a toggle the user did not make, from a plugin or a schedule, does not turn keepalive on', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const text = (await $.command.run({ command: 'keepalive', args: 'on 60 2', origin: { kind: 'plugin', name: 'other' } } as any)).text
    expect(text).toBe("keepalive stays off: only the user's own /keepalive turns it on.")
    await clock.advance(1000)
    await expectCountdownOnly($, 'off')
  })

  test('a session end and the next session start both leave keepalive off', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await $.session.end({ reason: 'exit', sessionId: 's' } as any)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    await expectCountdownOnly($, 'off')
    await mainStep($)
    await turnEnd($)
    await clock.advance(600000)
    expect(rec.forks).toEqual([])
  })

  test('a clear starts a session with keepalive off, so a fork before the first response is never sent', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
    await clock.advance(600000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  off')
    expect(await hint($)).toBe('')
  })
})

// A refusal the engine reports as a rate limit: the status it carries (null for no response) and the kind it classifies it with.
const LIMITED = (status: number | null = 429) => ({ isAnswered: false, reason: 'api-error', status, error: 'rate_limit', usage: ZERO })
// The last value each state key was written with, read by key: the count left, the stop, the lead and the touch.
const watchState = (on: any) => {
  const written = new Map<string, unknown>()
  on('state.set', async (_$: any, e: any, next: any) => {
    const result = await next(e)
    written.set(e.key, e.value === undefined ? undefined : JSON.parse(JSON.stringify(e.value)))
    return result
  })
  return (key: string): any => written.get(key)
}
// A keepalive run on the cache the main thread's request wrote at T0 (expiry 5 min on), turned on by `command`, whose sends get the queued
// replies in turn, each after its own delay from the send.
const armedRun = async ($: any, on: any, command: string, sends: { reply: unknown; delayMs: number }[]) => {
  const doc: any = cached()
  doc.forkSends = sends
  const rec = kaWorld(on, doc)
  const clock = mock.clock(on, { now: T0 })
  doc.clock = clock
  const state = watchState(on)
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.settle()
  await toggle($, command)
  await mainStep($)
  await turnEnd($)
  return { rec, clock, state }
}

// Keepalive's refresh is due at the expiry less the lead: at T0 + 285 s for the 15 s lead of these tests, sent on the tick at that moment.
describe('keepalive: a refresh refused as a rate limit is retried until shortly before the cache expires', () => {
  test('the retry goes at the first tick after the refusal\'s reply; the refusal writes no stop; an answered retry moves the touch and leaves the count one less', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 1500 }, { reply: ANSWERED, delayMs: 1500 }])
    await clock.advance(285000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(1000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(500)
    // At the reply (286.5 s) the count is given back, no stop is written, and the status line is still empty.
    expect(state('keepalive')).toMatchObject({ remaining: 2, stop: null })
    expect(lastStatus(rec)).toBeUndefined()
    await clock.advance(500)
    expect(rec.forks.length).toBe(2)
    await clock.advance(2000)
    expect(lastStatus(rec)).toBeUndefined()
    expect(state('touch')).toBe(T0 + 287000)
    expect(state('keepalive')).toMatchObject({ remaining: 1, stop: null })
    expect(await toggle($, '')).toContain('next in 4:43 · 1 left')
    expect(debugOf(rec, 'cachier ping').map((l) => l.retry)).toEqual(['allowed', null])
    // The next refresh is due at the expiry from the new touch less the lead (572 s), and none is sent before it.
    await clock.advance(282000)
    expect(rec.forks.length).toBe(2)
    await clock.advance(1000)
    expect(rec.forks.length).toBe(3)
  })

  test('with every attempt refused, the run ends at the window\'s close with its stop, its count given back, and no send later than half the lead before the expiry', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [1, 2, 3, 4].map(() => ({ reply: LIMITED(), delayMs: 1500 })))
    await clock.advance(300000)
    expect(rec.forks.length).toBe(4)
    const sent = debugOf(rec, 'cachier ping')
    expect(sent.map((l) => l.retry)).toEqual(['allowed', 'allowed', 'allowed', 'none'])
    // The first refresh at 285 s, then three retries 2 s apart; the last send is no later than the 292.5 s that is half the lead before the expiry.
    expect(sent.map((l) => Date.parse(l.time) - T0)).toEqual([285000, 287000, 289000, 291000])
    expect(Math.max(...sent.map((l) => Date.parse(l.time)))).toBeLessThanOrEqual(T0 + 292500)
    expect(state('keepalive')).toMatchObject({ remaining: 2, stop: "API error 429 (rate_limit), no retry before expiry" })
    expect(lastStatus(rec)).toContain("keepalive stopped: API error 429 (rate_limit), no retry before expiry")
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  stopped')
    expect(text).toContain("API error 429 (rate_limit), no retry before expiry · restarts on next prompt")
    expect(text).toContain('pause: 4 refreshes · ')
    expect(text).toContain('session: 4 refreshes · ')
  })

  test('at a 60 s lead the same refusals are retried 14 times, and the fifteenth ends the run', async ($, on) => {
    const { rec, clock } = await armedRun($, on, 'on 60 2', Array.from({ length: 15 }, () => ({ reply: LIMITED(), delayMs: 1500 })))
    await clock.advance(300000)
    expect(rec.forks.length).toBe(15)
    const sent = debugOf(rec, 'cachier ping')
    expect(sent.filter((l) => l.retry === 'allowed').length).toBe(14)
    expect(sent.at(-1).retry).toBe('none')
    expect(lastStatus(rec)).toContain("keepalive stopped: API error 429 (rate_limit), no retry before expiry")
  })

  test('a refusal with no response is retried as one with status 429', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(null), delayMs: 1500 }, { reply: ANSWERED, delayMs: 1500 }])
    await clock.advance(290000)
    expect(rec.forks.length).toBe(2)
    expect(state('keepalive')).toMatchObject({ stop: null })
    expect(lastStatus(rec)).toBeUndefined()
  })

  test('a refusal with no response and no retry left stops with that reason, with no response named', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(null), delayMs: 8000 }])
    // The reply lands at 293 s, 8 s after the send; the stop is written then, with the count given back.
    await clock.advance(293000)
    expect(state('keepalive')).toMatchObject({ remaining: 2, stop: "API error, no response (rate_limit), no retry before expiry" })
    expect(await toggle($, '')).toContain('Keepalive  stopped')
    await clock.advance(7000)
    expect(rec.forks.length).toBe(1)
    expect(lastStatus(rec)).toContain("keepalive stopped: API error, no response (rate_limit), no retry before expiry")
  })

  test('a refusal does not raise the lead, whatever its round trip: one past half the TTL ends the run with its own stop', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 160000 }])
    await clock.advance(450000)
    expect(rec.forks.length).toBe(1)
    expect(state('keepalive')).toMatchObject({ config: { leadMs: 15000, count: 2 }, stop: "API error 429 (rate_limit), no retry before expiry" })
    expect(debugOf(rec, 'cachier lead')).toEqual([])
    expect(debugOf(rec, 'cachier ping')[0].retry).toBe('none')
  })

  test('a refusal leaves the last refresh\'s read and the count where they were', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 3', [{ reply: ANSWERED, delayMs: 1500 }, { reply: LIMITED(), delayMs: 1500 }])
    await clock.advance(286500)
    expect(state('keepalive')).toMatchObject({ remaining: 2, last: { read: 18551, write: 0 } })
    // The next refresh is due at 570 s: the expiry from the answered refresh's touch at 285 s, less the lead.
    await clock.advance(283500)
    expect(rec.forks.length).toBe(2)
    await clock.advance(1500)
    expect(state('keepalive')).toMatchObject({ remaining: 2, stop: null, last: { read: 18551, write: 0 } })
    expect(await toggle($, '')).toContain('last refresh: 18551 read · 0 written')
  })

  test('with the last count pinned, between attempts the heading reads on, refreshing', async ($, on) => {
    const { rec, clock } = await armedRun($, on, 'on 15 1', [{ reply: LIMITED(), delayMs: 1500 }, { reply: ANSWERED, delayMs: 1500 }])
    await clock.advance(286500)
    expect(rec.forks.length).toBe(1)
    expect(await toggle($, '')).toContain('Keepalive  on, refreshing')
  })

  test('after a refusal that allowed a retry, /keepalive off sends no fork', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 1500 }])
    await clock.advance(286500)
    expect(state('keepalive')).toMatchObject({ stop: null, remaining: 2 })
    await toggle($, 'off')
    await clock.advance(10000)
    expect(rec.forks.length).toBe(1)
  })

  test('after a refusal that allowed a retry, a session start other than a compaction sends no fork', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 1500 }])
    await clock.advance(286500)
    expect(state('keepalive')).toMatchObject({ stop: null, remaining: 2 })
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(10000)
    expect(rec.forks.length).toBe(1)
  })

  test('after a refusal that allowed a retry, a compaction sends no fork', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 1500 }])
    await clock.advance(286500)
    expect(state('keepalive')).toMatchObject({ stop: null, remaining: 2 })
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(10000)
    expect(rec.forks.length).toBe(1)
  })

  test('a user prompt and its turn send no retry: the run waits for its own schedule from the turn\'s touch', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 1500 }])
    await clock.advance(286500)
    expect(state('keepalive')).toMatchObject({ stop: null, remaining: 2 })
    await userPrompt($)
    await mainStep($)
    await turnEnd($)
    await clock.advance(4000)
    expect(rec.forks.length).toBe(1)
    // The turn's request touched the cache at 286.5 s, so the next refresh is due at 571.5 s.
    await clock.advance(280500)
    expect(rec.forks.length).toBe(1)
    await clock.advance(1000)
    expect(rec.forks.length).toBe(2)
  })

  test('a refusal whose reply comes after a user prompt moved the generation gives no count back, writes no stop and leaves the state as it was', async ($, on) => {
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply: LIMITED(), delayMs: 3000 }])
    await clock.advance(286000)
    await userPrompt($)
    await mainStep($)
    await turnEnd($)
    const before = JSON.stringify(state('keepalive'))
    await clock.advance(2000)
    expect(JSON.stringify(state('keepalive'))).toBe(before)
    expect(rec.forks.length).toBe(1)
    expect(debugOf(rec, 'cachier ping')).toMatchObject([{ stale: true, retry: null }])
  })

  test('a refusal of any other kind stops keepalive at once, whatever its status', async ($, on) => {
    const reply = { isAnswered: false, reason: 'api-error', status: null, error: 'server_error', usage: ZERO }
    const { rec, clock, state } = await armedRun($, on, 'on 15 2', [{ reply, delayMs: 1500 }])
    await clock.advance(286500)
    expect(state('keepalive')).toMatchObject({ stop: 'API error, no response (server_error)' })
    await clock.advance(20000)
    expect(rec.forks.length).toBe(1)
    expect(lastStatus(rec)).toContain('keepalive stopped: API error, no response (server_error)')
  })
})

// A user's or another source's prompt, submitted through the engine's prompt.submit.
const submit = ($: any, kind: string, text = 'next') => $.prompt.submit({ text, origin: { kind } } as any)

describe('keepalive: the queue and the race', () => {
  test('with nothing broken the status line is empty, with keepalive off and with it on and its cost shown', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await clock.advance(1000)
    expect(rec.status.length).toBeGreaterThan(0)
    expect(lastStatus(rec)).toBeUndefined()
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    expect(lastStatus(rec)).toBeUndefined()
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    expect(lastStatus(rec)).toBeUndefined()
  })

  test('with nothing broken the status line is empty while keepalive waits for its cost', async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.status.length).toBeGreaterThan(0)
    expect(lastStatus(rec)).toBeUndefined()
  })

  test('keepalive turned on before the cache is known refreshes once the cache is known and due, and no tick toasts', async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    expect(rec.forks).toEqual([])
    expect(lastStatus(rec)).toBeUndefined()
    await clock.advance(300000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
  })

  test('keepalive turned on before the cache is known, with a status answer before the cache, refreshes when due and no tick toasts', async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    expect(await toggle($, '')).toContain('Keepalive  on, no count no live cache')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(100000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('refresh ~19k cached')
    expect(rec.toasts).toEqual([])
    await clock.advance(150000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
  })

  test('/keepalive on while the cost is known states the cost in its answer, and the first ping follows with no hint drawn', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(await toggle($, 'on 60 2')).toContain('A refresh reads the warm cache: ~19k cached')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
  })

  test('a /keepalive answer while a cold mark is being written says the cache reset is being recorded, and keeps the running figure', async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'cold' && e.value !== null && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.settle()
    expect(holding).toBe(true)
    expect(await toggle($, '')).toContain('paused recording cache reset')
    expect(await toggle($, '')).toContain('refresh ~19k cached · every 4 min')
    release()
    await switching
    await clock.advance(1000)
    // The mark has landed over a known cache: the footer reads `reset`.
    expect(await hint($)).toBe('reset')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('refresh ~19k cached')
  })

  test('a cold mark whose write throws before the mark is set keeps the running figure under the pending reason until the next turn begins', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let failing = false
    // A thrown hook is skipped by the engine, so the write would land; a refused write is how a write fails here.
    on('state.set', (_$: any, e: any, next: any) => (failing && e.key === 'cold' && e.value !== null ? { deny: 'cold write refused' } : next(e)))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    failing = true
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    failing = false
    await clock.advance(1000)
    const held = await toggle($, '')
    expect(held).toContain('Keepalive  paused recording cache reset refresh ~19k cached · every 4 min')
    expect(held).not.toContain('next in ')
    expect(lastStatus(rec)).toContain('a state write failed')
    await mainStep($)
    await clock.advance(1000)
    expect(await toggle($, '')).not.toContain('recording cache reset')
  })

  test('a cost not yet shown with figures does not hold the first refresh: it is sent when due, and no tick toasts', async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await clock.settle()
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    expect(await drawnHint($)).toContain('keep warm ~19k read/refresh')
    expect(rec.forks).toEqual([])
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
    await clock.settle()
  })

  test('keepalive turned on with its lead already begun refreshes at the next tick, with no stop for a cost shown late', async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await clock.settle()
    await clock.advance(250000)
    // The cache appears only now, so its first read is after the lead has begun.
    doc.exists = undefined
    doc.text = cached().text
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
  })

  test('enabling with the figures known shows them on the spot, and sends no fork', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    const text = await toggle($, 'on 60 2')
    expect(text).toContain('A refresh reads the warm cache: ~19k cached')
    expect(rec.forks).toEqual([])
  })

  test('no cachier cost line reaches the debug log, whichever surface turns keepalive on', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 3')
    await toggle($, 'off')
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    await toggle($, 'off')
    await toggle($, 'on 15 3')
    await clock.advance(1000)
    expect(rec.logs.filter((l: string) => l.includes('cachier cost'))).toEqual([])
  })

  test('no tick shows a toast, in any state: off, on before the cache is known, on once it is, and on past the TTL', { options: { keepalive_lead_s: 60, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await clock.advance(5000)
    expect(rec.toasts).toEqual([])
    await toggle($, 'on 60 2')
    await clock.advance(5000)
    expect(rec.toasts).toEqual([])
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    await clock.advance(200000)
    expect(rec.toasts).toEqual([])
    await clock.advance(200000)
    expect(rec.toasts).toEqual([])
    await toggle($, 'off')
    await clock.advance(5000)
    expect(rec.toasts).toEqual([])
  })

  test('a submitted prompt closes the idle gap: a due ping waits, since no turn has started', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await submit($, 'composer')
    await clock.advance(240000 + 30000)
    expect(rec.forks).toEqual([])
  })

  test('a submitted prompt another hook drops reopens the idle gap, so a due ping forks', async ($, on) => {
    const doc: any = cached()
    doc.dropPrompt = true
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await submit($, 'composer')
    await clock.advance(240000 + 30000)
    expect(rec.forks.length).toBe(1)
  })

  test('a submitted prompt whose entry throws reopens the idle gap, so a due ping forks', async ($, on) => {
    const doc: any = cached()
    doc.promptThrows = true
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await submit($, 'composer').then(
      () => undefined,
      () => undefined,
    )
    await clock.advance(240000 + 30000)
    expect(rec.forks.length).toBe(1)
  })

  test('a session end whose keepalive write fails does not throw into the engine, and the next session starts off', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let failing = false
    on('state.set', (_$: any, e: any, next: any) => (failing && e.key === 'keepalive' ? { value: { isSet: false } } : next(e)))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    failing = true
    await $.session.end({ reason: 'exit', sessionId: 's' } as any)
    expect(rec.logs.some((l) => l.includes('keepalive state changed on every write attempt'))).toBe(true)
    failing = false
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    await expectCountdownOnly($, 'off')
  })

  test('a failed main-thread write stays flagged after a user prompt lands: only a main-thread write clears it', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let failing = false
    on('state.set', (_$: any, e: any, next: any) => (failing && e.key === 'keepalive' ? { value: { isSet: false } } : next(e)))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    failing = true
    await mainStep($)
    failing = false
    await submit($, 'composer')
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('a state write failed')
  })

  test('a due ping that runs while a model switch is marking the cache cold, before the mark lands, sends no fork', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let watching = false
    let writeHeld = false
    let releaseWrite: () => void = () => {}
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    // The switch's cold-mark write holds, so the due tick runs inside the window between the switch's start and its mark.
    on('state.set', async (_$: any, e: any, next: any) => {
      if (watching && !writeHeld && e.key === 'cold') {
        writeHeld = true
        await writeGate
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    watching = true
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    for (let i = 0; i < 200 && !writeHeld; i++) await clock.advance(0)
    expect(writeHeld).toBe(true)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(0)
    releaseWrite()
    await switching
    await clock.advance(1000)
    expect(rec.forks.length).toBe(0)
  })

  test('a cache that expires while the cold mark of a model switch is being written records no stop', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const stops: string[] = []
    let watching = false
    let writeHeld = false
    let releaseWrite: () => void = () => {}
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    // The switch's cold-mark write holds before the mark is set, so the tick runs past the cache's expiry while the write is pending.
    on('state.set', async (_$: any, e: any, next: any) => {
      if (e.key === 'keepalive' && typeof e.value?.stop === 'string') stops.push(e.value.stop)
      if (watching && !writeHeld && e.key === 'cold') {
        writeHeld = true
        await writeGate
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    // The turn stays open: the gap stays shut, so no refresh goes out before the expiry, and the tick past it has a stop to write.
    await mainStep($)
    watching = true
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    for (let i = 0; i < 200 && !writeHeld; i++) await clock.advance(0)
    expect(writeHeld).toBe(true)
    await clock.advance(301000)
    expect(stops).toEqual([])
    expect(rec.forks.length).toBe(0)
    releaseWrite()
    await switching
    await clock.advance(1000)
  })

  test('a model switch marks the cache cold before the hooks beneath it run: a due ping sends no fork while one of them holds the switch', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let release: () => void = () => {}
    doc.switchHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    release()
    await switching
    await clock.advance(1000)
    expect(rec.forks).toEqual([])
  })

  test('a compaction marks the cache cold before the hooks beneath it run: a due ping sends no fork while one of them holds the compaction', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let release: () => void = () => {}
    doc.compactHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    const compacting = $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    release()
    await compacting
    await clock.advance(1000)
    expect(rec.forks).toEqual([])
  })

  test('a cold mark whose completing write fails sends no fork, and the next main-thread write lets keepalive ping again', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    // The switch's first keepalive write (coldBegun) lands; every later one misses, so the COLD write lands and coldLanded fails.
    let failing = false
    let writesDuringSwitch = 0
    on('state.set', (_$: any, e: any, next: any) =>
      failing && e.key === 'keepalive' && ++writesDuringSwitch > 1 ? { value: { isSet: false } } : next(e),
    )
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    failing = true
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    failing = false
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
    expect(lastStatus(rec)).toContain('a state write failed')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
  })

  test('a failed user-prompt write stays flagged: a turn end that changes no state clears nothing, and the due ping still waits', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    let failing = false
    on('state.set', (_$: any, e: any, next: any) => (failing && e.key === 'keepalive' ? { value: { isSet: false } } : next(e)))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    failing = true
    await submit($, 'composer')
    failing = false
    // A further step of the turn already counted changes no state, so it clears nothing either.
    for await (const _c of $.turn.step({ turnId: lastTurnId, index: 1, model: 'm', messageCount: 1 } as any)) {
      // no chunks read
    }
    await turnEnd($)
    await clock.advance(240000 + 30000)
    expect(rec.forks.length).toBe(0)
    expect(lastStatus(rec)).toContain('a state write failed')
  })

  test('a ping in flight when a new main-thread turn starts settles stale: an empty reply changes no state and is logged as stale', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 10000)
    expect(rec.forks.length).toBe(1)
    await mainStep($)
    release()
    await clock.advance(1000)
    expect(lastStatus(rec) ?? '').not.toContain('keepalive stopped')
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1]).toMatchObject({ stale: true })
  })

  test('a ping in flight when a new main-thread turn starts settles stale: a fork that throws changes no state and is logged as stale', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkThrows = true
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 10000)
    expect(rec.forks.length).toBe(1)
    await mainStep($)
    release()
    await clock.advance(1000)
    expect(lastStatus(rec) ?? '').not.toContain('keepalive stopped')
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1]).toMatchObject({ stale: true })
  })

  test('a user prompt during a ping, with no turn started, makes the ping stale: its late failure is logged as stale', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.fork = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    await submit($, 'composer')
    release()
    await clock.advance(1000)
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1]).toMatchObject({ stale: true })
  })

  test('a prompt during a ping: the ping\'s late failure is stale, changes nothing, and the re-arm stands', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.fork = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    await submit($, 'composer')
    await mainStep($)
    release()
    await clock.advance(2000)
    expect(lastStatus(rec) ?? '').not.toContain('keepalive stopped')
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1]).toMatchObject({ stale: true })
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('2 left')
  })

  test('a slow ping raises the lead to twice its round trip, and the pane and the debug log name the raise', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(8000)
    release()
    await clock.advance(1000)
    expect(debugOf(rec, 'cachier lead')[0]).toMatchObject({ from_s: 15 })
    expect(debugOf(rec, 'cachier lead')[0].to_s).toBeGreaterThanOrEqual(16)
    expect(lastStatus(rec) ?? '').not.toContain('keepalive stopped')
    await clock.advance(1000)
    const answer = await toggle($, '')
    expect(answer).toContain('lead raised to 16s (slow refresh)')
    // The Settings row names the same raise, beside the Keepalive section's row, in the answer and in the pane.
    const row = 'lead: 16s (raised: slow refresh) · /keepalive on <lead_s>'
    expect(answer).toContain(row)
    expect(await drawnPane($)).toContain(row)
    expect(await drawnPane($)).toContain('lead raised to 16s (slow refresh)')
  })

  test('a faster ping after a raise never lowers the lead', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 3')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    await clock.advance(8000)
    release()
    await clock.advance(1000)
    expect(debugOf(rec, 'cachier lead')).toHaveLength(1)
    // The next ping is due a raised lead before the TTL, 16 s, and it is fast: the lead it is sent under stays raised.
    await clock.advance(284000)
    expect(rec.forks.length).toBe(2)
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1].lead_s).toBeGreaterThanOrEqual(16)
    expect(debugOf(rec, 'cachier lead')).toHaveLength(1)
  })

  test('a new /keepalive on clears the raised-lead note from the details pane', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 3')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    await clock.advance(8000)
    release()
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('lead raised to 16s (slow refresh)')
    const raised = await drawnPane($)
    expect(await toggle($, 'on 30 3')).toContain('lead 30 s')
    await clock.advance(1000)
    expect(await drawnHint($)).not.toContain('lead raised')
    // The Settings row goes with the note: the new lead and no raise, where the row before it named one.
    const cleared = await drawnPane($)
    expect(cleared).not.toContain('raised')
    expect(cleared).toContain('lead: 30s · /keepalive on <lead_s>')
    expect(raised).toContain('lead: 16s (raised: slow refresh) · /keepalive on <lead_s>')
    expect(rec.forks.length).toBe(1)
  })

  test('a round trip under half the lead raises nothing, and the ping is answered', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(2000)
    release()
    await clock.advance(1000)
    expect(debugOf(rec, 'cachier lead')).toEqual([])
    expect(debugOf(rec, 'cachier ping')[0]).toMatchObject({ outcome: 'answered', stale: false, lead_s: 15 })
    expect(lastStatus(rec) ?? '').not.toContain('keepalive stopped')
    expect(await drawnHint($)).toContain('keep warm ~19k read/refresh')
    expect(await drawnHint($)).not.toContain('lead raised')
  })

  test('a fast ping with a configured lead above half the TTL does not stop keepalive', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 160 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(140000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(2000)
    release()
    await clock.advance(1000)
    expect(debugOf(rec, 'cachier ping')[0]).toMatchObject({ outcome: 'answered', stale: false, lead_s: 160 })
    expect(debugOf(rec, 'cachier lead')).toEqual([])
    expect(lastStatus(rec) ?? '').not.toContain('keepalive stopped')
  })

  test('a raise past half the TTL stops keepalive, and the status line names the round trip and the lead it needs', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    await clock.advance(160000)
    release()
    await clock.advance(1000)
    expect(lastStatus(rec)).toBe('keepalive stopped: 160.0s round trip needs 320s lead > ½ of 300s TTL')
    expect(debugOf(rec, 'cachier lead')).toEqual([])
  })

  test('a reply after the TTL lapses stops keepalive; the late reply is logged and changes nothing', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    await clock.advance(15000)
    expect(lastStatus(rec)).not.toContain('keepalive stopped')
    await clock.advance(300000)
    expect(lastStatus(rec)).toContain('keepalive stopped: round trip over 300s TTL, no reply yet')
    release()
    await clock.advance(1000)
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1]).toMatchObject({ stale: true, outcome: 'answered' })
    expect(await toggle($, '')).toContain('session: 1 refresh · ~19k read')
    expect(debugOf(rec, 'cachier lead')).toEqual([])
  })

  test('a ping in flight when a user prompt arrives counts into the session, not the pause that prompt started', async ($, on) => {
    let release: () => void = () => {}
    const doc: any = cached()
    doc.forkHold = new Promise<void>((resolve) => {
      release = resolve
    })
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 3')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    await userPrompt($)
    release()
    await clock.advance(1000)
    const status = await toggle($, '')
    expect(status).not.toMatch(/(^|\s)pause: /)
    expect(status).toContain('session: 1 refresh · ~19k read')
    // The Settings row `refreshes/pause: …` is no pause tally: the anchor wants a space or the start before `pause:`.
    expect(status).toContain('refreshes/pause: ')
  })

  test('each ping leaves one debug line: its time, lead, TTL, generation, round trip, usage, and outcome', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    const pings = debugOf(rec, 'cachier ping')
    expect(pings).toHaveLength(1)
    expect(pings[0]).toMatchObject({ seq: 1, lead_s: 60, ttl_s: 300, outcome: 'answered', stale: false })
    expect(pings[0].usage).toEqual({ read: 18551, write: 0, input: 0, output: 0 })
    expect(typeof pings[0].round_trip_ms).toBe('number')
    expect(pings[0].generation).toBeGreaterThanOrEqual(0)
  })

  test('the details pane tallies this pause and this session; a user prompt clears the pause and keeps the session', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    expect(rec.forks.length).toBe(1)
    expect(await toggle($, '')).toContain('pause: 1 refresh · ~19k read')
    expect(await drawnPane($)).toContain('session: 1 refresh · ~19k read')
    await userPrompt($)
    await clock.advance(1000)
    expect(await drawnPane($)).not.toMatch(/(^|\s)pause: /)
    expect(await drawnPane($)).toContain('session: 1 refresh · ~19k read')
    expect(await drawnPane($)).toContain('refreshes/pause: ')
  })

  test('a bridge prompt re-arms an armed keepalive; a peer prompt does not', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    await expectCountdownOnly($, 'paused')
    expect(lastStatus(rec) ?? '').not.toContain('keepalive')
    await submit($, 'peer')
    await clock.advance(1000)
    await expectCountdownOnly($, 'paused')
    await submit($, 'bridge')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('1 left')
  })

  test('the bare command reads the state, and off turns keepalive off', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    expect(await toggle($, '')).toContain('Keepalive  off')
    await clock.settle()
    await toggle($, 'on 60 2')
    expect(await toggle($, '')).toContain('keepalive on')
    expect(await toggle($, 'off')).toBe('keepalive off')
    await clock.advance(1000)
    await expectCountdownOnly($, 'off')
  })

  test('a compaction keeps the toggle; a new session starts off', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await $.classic.SessionStart({ source: 'compact', transcript_path: PATH })
    await clock.advance(1000)
    expect(await drawnHint($)).toContain('keep warm ~19k read/refresh')
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await expectCountdownOnly($, 'off')
  })
})

describe('the low-key UI: the footer line, the click, the gutter, and what the status line keeps', () => {
  test('the pie is drawn after the engine\'s mode labels, with a dim separator between, the refresh cost in a hover popup, and the status line is clear', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($, ['focus'])
    const drawn = JSON.stringify(await m.drawn())
    expect(await hintOf(m)).toBe('4:59')
    await m.unmount()
    expect(drawn.indexOf('"children":["focus"]')).toBeLessThan(drawn.indexOf('"children":[" · "]'))
    expect(drawn.indexOf('"children":[" · "]')).toBeLessThan(drawn.indexOf('"key":"pie"'))
    expect(drawn).toContain('"hover":{"display":"flex"}')
    expect(drawn.match(/absolute/g)).toHaveLength(2)
    expect(drawn).not.toContain('ping')
    expect(lastStatus(rec)).toBeUndefined()
  })

  test('cachier draws nothing in the engine\'s hint row: the countdown is not there, and the row is the engine\'s', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const hintRow = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'PromptHint', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as any)
    expect(await hintRow.find({ type: 'Button', key: 'pie' })).toBeUndefined()
    expect(JSON.stringify(await hintRow.drawn())).toContain('reply')
    await hintRow.unmount()
  })

  test('another plugin\'s label beneath the line, with no engine modes, is separated from it, never glued', async ($, on) => {
    kaWorld(on, { ...cached(), auditor: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const drawn = JSON.stringify(await m.drawn())
    await m.unmount()
    expect(drawn.indexOf('"auditor is on"')).toBeLessThan(drawn.indexOf('"children":[" · "]'))
    expect(drawn.indexOf('"children":[" · "]')).toBeLessThan(drawn.indexOf('"key":"pie"'))
  })

  test('another plugin\'s Markdown beneath the line, its words in a prop, is separated from it, never glued', async ($, on) => {
    kaWorld(on, { ...cached(), markdown: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const drawn = JSON.stringify(await m.drawn())
    await m.unmount()
    expect(drawn.indexOf('"another plugin"')).toBeGreaterThan(-1)
    expect(drawn.indexOf('"another plugin"')).toBeLessThan(drawn.indexOf('"children":[" · "]'))
    expect(drawn.indexOf('"children":[" · "]')).toBeLessThan(drawn.indexOf('"key":"pie"'))
  })

  test('the engine\'s own footer node, which shows no words to the plugin, is separated from the line while it has modes', async ($, on) => {
    kaWorld(on, { ...cached(), engineNode: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const withModes = await mountHint($, ['focus'])
    const drawn = JSON.stringify(await withModes.drawn())
    await withModes.unmount()
    expect(drawn).toContain('"children":[" · "]')
    const without = await mountHint($)
    const bare = JSON.stringify(await without.drawn())
    await without.unmount()
    expect(bare).not.toContain('"children":[" · "]')
    expect(bare).toContain('"key":"pie"')
  })

  test('with no engine modes and nothing beneath, no separator leads the countdown', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const drawn = JSON.stringify(await m.drawn())
    await m.unmount()
    expect(drawn).not.toContain('"children":[" · "]')
    expect(drawn).toContain('"key":"pie"')
  })

  test('with no line to draw, the footer is what the engine drew: the mode labels, and no countdown', async ($, on) => {
    kaWorld(on, { text: '', exists: false })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const m = await mountHint($, ['focus'])
    const drawn = JSON.stringify(await m.drawn())
    await m.unmount()
    expect(drawn).toContain('"children":["focus"]')
    expect(drawn).not.toContain('"children":[" · "]')
    expect(drawn).not.toContain('"key":"pie"')
  })

  test('the time carries the refresh cost on hover while keepalive runs, and the pane lines for the cost show only then',{ options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const countdown = /^\d:\d\d$/
    expect(await hintOf(m)).toMatch(countdown)
    expect(JSON.stringify(await m.drawn())).not.toContain('ping')
    expect(JSON.stringify(await m.drawn())).not.toContain('refresh ~19k cached')
    await pressPie($)
    await clock.advance(1000)
    expect(await hintOf(m)).toMatch(countdown)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh')
    expect(await m.find({ type: 'Button', key: 'unit' })).toBeFalsy()
    const pane = await mountPane($)
    const running = JSON.stringify(await m.drawn()) + flatOf(await rowsOf(pane))
    await pane.unmount()
    expect(running).toContain('keep warm ~19k read/refresh')
    expect(running).toContain('refresh ~19k cached')
    expect(running).toContain('every 4:45')
    expect(running).not.toContain('Turn keepalive')
    expect(running).not.toContain('Click the line')
    await pressPie($)
    await clock.advance(1000)
    expect(await hintOf(m)).toMatch(countdown)
    expect(JSON.stringify(await m.drawn())).not.toContain('ping')
    expect(JSON.stringify(await m.drawn())).not.toContain('refresh ~19k cached')
    await m.unmount()
    expect(lastStatus(rec)).toBeUndefined()
  })

  test('a paused keepalive hovers the refresh figure it would resume at, as an off one does', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    await clock.advance(2000)
    expect(await drawnPane($)).toContain('Keepalive  paused ')
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh')
    await m.unmount()
  })

  test('a paused keepalive is turned off by a press, as a running one is',{ options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(2000)
    expect(await toggle($, '')).toContain('Keepalive  paused count used')
    expect(lastStatus(rec)).toBeUndefined()
    const m = await mountHint($)
    expect(await drawnPane($)).toContain('Keepalive  paused count used')
    await pressPie($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  off')
    await m.unmount()
  })

  test('the next user prompt re-arms a paused keepalive with its full count',{ options: { keepalive_lead_s: 15, keepalive_count: 1 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(285000)
    expect(rec.forks.length).toBe(1)
    await clock.advance(2000)
    expect(await toggle($, '')).toContain('Keepalive  paused count used')
    await userPrompt($)
    expect(await toggle($, '')).not.toContain('paused')
    expect(await toggle($, '')).toContain('keepalive on')
  })

  test('a press whose lead began before the press refreshes at the next tick, with no stop for a cost shown late', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(283500)
    await pressPie($)
    await clock.advance(1000)
    await m.drawn()
    await clock.advance(2000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
    await m.unmount()
  })

  test('a press on a paused keepalive turns it on paused, with no toast; a second press turns it off', { options: { keepalive_lead_s: 300, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    expect(await drawnPane($)).toContain('Keepalive  paused ')
    expect(lastStatus(rec)).toContain('keepalive paused: lead 300s ≥ 300s TTL')
    expect(await toggle($, '')).toContain('Keepalive  paused lead 300s ≥ 300s TTL')
    await pressPie($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  off')
    await m.unmount()
  })

  test('a refresh due after a press is sent even when the hint unmounts first', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(281000)
    await pressPie($)
    await m.unmount()
    await clock.advance(3000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
  })

  test('a refresh due after a press follows a draw of the cost, with no toast', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    await m.drawn()
    await pressPie($)
    await clock.advance(280000)
    await pressPie($)
    await m.unmount()
    await clock.advance(3000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
  })

  test('a run that has not sent its first refresh names no kept count: a model switch that changes the count before the first refresh is not the one the pause started with', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60')
    // The model is switched before any refresh: the cache is cold, and the count the run sends was worked out for the warm cache.
    await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'claude-sonnet-5-5', source: 'command', prompt_cache_warm: false, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    const text = await toggle($, '')
    expect(text).not.toContain('kept from pause start')
    expect(text).toContain('refreshes/pause: break-even')
  })

  test('a cache miss in the transcript shows in the pane with keepalive off, and no refresh figure on the line',async ($, on) => {
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1' })]) }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    // The first reading starts the history at its newest response, so the miss comes with the next one.
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const drawn = JSON.stringify(await m.drawn()) + (await drawnPane($))
    expect(await toggle($, '')).toContain('misses: 1 (lapse 1) · ~20k tokens rewritten')
    // Off, the line names no refresh figure; the pane's Keepalive section states it is off, and its Cache section the miss.
    expect(await hintOf(m)).not.toContain('refresh')
    expect(await drawnPane($)).toContain('misses: 1 (lapse 1) · ~20k tokens rewritten')
    expect(drawn).toContain('Keepalive  off')
    await m.unmount()
    expect(lastStatus(rec)).toBeUndefined()
  })

  test('a whole-context write after a model switch is a cold miss, named by the bare command', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    doc.text = lines([
      user({ uuid: 'u1', parent: null, ts: iso(T0) }),
      assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1' }),
      assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 5000), write: 20000, tags: FIVE, msg: 'm2' }),
    ])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('misses: 1 (switch/compaction 1) · ~20k tokens rewritten')
    const misses = debugOf(rec, 'cachier miss')
    expect(misses.map((m: any) => m.cause)).toEqual(['cold'])
    expect(Object.keys(misses[0])).not.toContain('tokens')
  })

  test('a new transcript starts its stats again: the misses of the old one are not shown on its pane', async ($, on) => {
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1' })]) }
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('misses: 1')
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/other/session.jsonl' })
    await clock.advance(1000)
    expect(await toggle($, '')).not.toContain('misses:')
  })

  test('a model switch during a pinged pause is a cold miss, and the pause is not counted as ran out', { options: { keepalive_lead_s: 60, keepalive_count: 3 } }, async ($, on) => {
    const doc: any = cached()
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 3')
    await clock.advance(320000)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    await userPrompt($)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 321000), write: 40000, tags: FIVE, msg: 'm2' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const status = await toggle($, '')
    expect(status).toContain('misses: 1 (switch/compaction 1)')
    expect(status).not.toContain('ran out')
    expect(status).not.toContain('earlier:')
  })

  test('a pause its pings kept warm, ended by a prompt after the cache would have expired, is saved when the first response reads the cache', { options: { keepalive_lead_s: 60, keepalive_count: 3 } }, async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 3')
    await clock.advance(320000)
    expect(rec.forks.length).toBeGreaterThan(0)
    await userPrompt($)
    doc.text = lines([
      user({ uuid: 'u1', parent: null, ts: iso(T0) }),
      assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1' }),
      assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 321000), read: 40000, write: 1000, tags: FIVE, msg: 'm2' }),
    ])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('1 saved')
  })

  test('a press while the cache is cold turns a running keepalive off, since the pie is green for it',{ options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain('"color":"success"')
    await pressPie($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  off')
    expect(JSON.stringify(await m.drawn())).not.toContain('"color":"success"')
    await m.unmount()
  })

  test('a press shows no toast and puts no cost on the status line, and the first refresh is sent when due', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(lastStatus(rec) ?? '').not.toContain('warm cache')
    await pressPie($)
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    expect(lastStatus(rec) ?? '').not.toContain('warm cache')
    await m.drawn()
    await clock.advance(285000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
    await m.unmount()
  })

  test('a click turns keepalive on with the plugin defaults and shows no toast; a second click turns it off', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh')
    expect(await toggle($, '')).toContain('3 left')
    expect(rec.toasts).toEqual([])
    expect(rec.forks).toEqual([])
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).not.toContain('ping')
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh')
    expect(rec.toasts).toEqual([])
    await m.unmount()
  })

  test('the plugin options set the click\'s lead and count when no command has set them', { options: { keepalive_lead_s: 30, keepalive_count: 5 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    expect(await toggle($, '')).toContain('5 left')
    expect(await toggle($, '')).toContain('lead: 30s')
    await m.unmount()
  })

  test('a click after a command uses the lead and count that command set, and shows no toast', { options: { keepalive_lead_s: 60, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 30 5')
    await toggle($, 'off')
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    await m.drawn()
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('5 left')
    expect(await toggle($, '')).toContain('lead: 30s')
    expect(rec.toasts).toEqual([])
    await m.unmount()
  })

  test('a command that turns keepalive on while the cache is unknown sends no fork', async ($, on) => {
    const rec = kaWorld(on, { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) })]) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await clock.advance(400000)
    expect(await hint($)).toBe('no count')
    expect(rec.forks).toEqual([])
  })

  test('a task-notification row is stamped at the right of its first line, as any user message is', async ($, on) => {
    world(on, { text: lines([user({ uuid: 'n1', parent: null, ts: iso(T0 - 60000) })]) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const drawn = async () => {
      const m = await $.ui.mount({ plugin: 'cachier', surface: 'terminal', component: 'UserMessage', requestId: 'n1', props: { text: 'task done', isExpanded: true, origin: { kind: 'task-notification' } } } as any)
      const tree = JSON.stringify(await m.drawn())
      await m.unmount()
      return tree
    }
    await drawn()
    await clock.advance(1000)
    expect(await drawn()).toContain(hhmm(T0 - 60000))
    expect(await drawn()).toContain('"position":"absolute"')
  })

  test('figures that become known after the enable show on the footer, with no toast, and the refresh is sent when due', { options: { keepalive_lead_s: 60, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(await toggle($, 'on 60 2')).toContain('No live cache')
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    expect(lastStatus(rec) ?? '').not.toContain('warm cache')
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh')
    await m.unmount()
    expect(rec.forks).toEqual([])
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
  })

  test('a details pane drawn with its cost line shows no toast: the refresh is sent when due', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    let mounted: any = null
    // The pane is mounted inside the tick's state write and drawn after it: an awaited draw there would wait on the tick that made it.
    on('state.set', async (_$: any, e: any, next: any) => {
      const result = await next(e)
      if (e.key === 'hint' && e.value?.cost && mounted === null) mounted = await mountPane($)
      return result
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 3')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(mounted).not.toBeNull()
    expect(textOf(await mounted.drawn())).toContain('refresh ~19k cached')
    await mounted.unmount()
    expect(rec.toasts).toEqual([])
    await clock.advance(300000)
    expect(rec.forks.length).toBe(1)
  })

  test('a footer draw alone shows no toast, and the refresh is sent when due', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    const rec = kaWorld(on, doc)
    let drawn = false
    let mounted: any = null
    // The footer is mounted inside the tick's hint write, so its draw runs during the tick.
    on('state.set', async (_$: any, e: any, next: any) => {
      const result = await next(e)
      if (e.key === 'hint' && e.value?.cost && !drawn) {
        drawn = true
        mounted = await mountHint($)
      }
      return result
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 15 3')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(drawn).toBe(true)
    expect(await mounted.drawn()).toBeDefined()
    await mounted.unmount()
    expect(rec.toasts).toEqual([])
  })

  test('a click follows keepalive as it stands, not the hint it last drew: on turns off even when stopped, off turns on over a drawn cost', async () => {
    const values = new Map<string, unknown>()
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
      clock: { now: async () => T0 },
      ui: { toast: () => undefined, log: () => undefined },
    } as any
    const defaults = { leadMs: 15000, count: null, cap: 3 }
    const cost = { label: 'keep warm $0.006/refresh · if cold ~$0.09 rebuild' }
    const running = {
      config: { leadMs: 15000, count: 3 },
      remaining: 0,
      stop: 'count used',
      last: null,
      seq: 3,
      active: false,
      gap: true,
      coldPending: false,
      lastTurn: null,
      generation: 2,
      lastUsed: { leadMs: 15000, count: 3 },
      pauseEpoch: 0,
    }
    // On and stopped, with a cost still drawn on the hint: the click turns keepalive off.
    values.set('keepalive', running)
    values.set('hint', { reading: null, cost, offer: null, paused: null, warmth: '', breakEven: '' })
    await pressCountdown(fake, defaults)
    expect(values.get('keepalive')).toMatchObject({ config: null })
    // Off, with a drawn cost left on the hint from before: the click turns keepalive on with the values last used.
    values.set('keepalive', { ...running, config: null, stop: null, remaining: 0, generation: 3 })
    await pressCountdown(fake, defaults)
    expect(values.get('keepalive')).toMatchObject({ config: { leadMs: 15000, count: 3 }, remaining: 3, stop: null })
  })

  // The overlap is forced where the guard is: the first press's read of the keepalive state is held, and a second press comes in
  // meanwhile. The kit cannot force it: a press returns when its chain settles, and its work runs in the background.
  test('two presses that overlap turn keepalive on once, with no toast', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = true
    const values = new Map<string, unknown>()
    const toasts: string[] = []
    const fake = {
      state: {
        get: async (k: { key: string }) => {
          if (holding && k.key === 'keepalive') {
            holding = false
            await gate
          }
          return { value: values.get(k.key), version: 1 }
        },
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
      clock: { now: async () => T0 },
      ui: { toast: (text: string) => toasts.push(text), log: () => undefined },
    } as any
    const defaults = { leadMs: 15000, count: null, cap: 3 }
    const first = pressOnce(() => pressCountdown(fake, defaults))
    const second = pressOnce(() => pressCountdown(fake, defaults))
    release()
    await Promise.all([first, second])
    expect(toasts).toEqual([])
    expect(values.get('keepalive')).toMatchObject({ config: { leadMs: 15000, count: null } })
  })

  // The kit cannot drive a press to throw: a refused toast is dropped by the engine, and a refused state write is retried.
  // So the press's failure is tested where it lives: the countdown's press and the status text, given a state that refuses
  // every write, then one that takes them.
  test('a press whose state write is refused says so on the status line until a press completes', async () => {
    const values = new Map<string, unknown>()
    let refuse = true
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          if (refuse) return { isSet: false }
          values.set(k.key, value)
          return { isSet: true }
        },
      },
      clock: { now: async () => T0 },
      ui: { toast: () => undefined, log: () => undefined },
    } as any
    const defaults = { leadMs: 15000, count: null, cap: 3 }
    await pressCountdown(fake, defaults)
    expect(await alarmOf(fake, { kind: 'no-cache' })).toContain('the countdown press failed; see the debug log')
    refuse = false
    await pressCountdown(fake, defaults)
    expect(await alarmOf(fake, { kind: 'no-cache' })).not.toContain('the countdown press failed')
  })

  test('a failed ping shows on the status line and leaves the countdown; a prompt re-arms keepalive and clears the failure from the status line', async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    doc.fork = { isAnswered: false, reason: 'nothing-to-fork' }
    await turnEnd($)
    await clock.advance(240000 + 1000)
    expect(rec.forks.length).toBe(1)
    expect(lastStatus(rec)).toContain('keepalive stopped: nothing to fork yet')
    await expectCountdownOnly($, 'stopped')
    expect(await toggle($, '')).toContain('Keepalive  stopped nothing to fork yet · restarts on next prompt')
    doc.fork = ANSWERED
    await userPrompt($)
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(lastStatus(rec) ?? '').not.toContain('nothing to fork')
  })
})

// The text a drawn element holds, its strings in order: the rows a pane draws are the texts of its children.
const textOf = (el: any): string => (typeof el === 'string' ? el : (el?.children ?? el?.props?.children ?? []).map(textOf).join(''))
// The details pane's rows as drawn: one text per row.
const paneRows = async ($: any): Promise<string[]> => {
  const pane = await mountPane($)
  const rows = await rowsOf(pane)
  await pane.unmount()
  return rows
}
// The columns a pane asks for: its longest row.
const widthOf = (rows: string[]) => Math.max(...rows.map((row) => row.length))
// The rows and columns the pane asks for: the bare command's answer, its row count and longest row, for the same content.
const answerSize = async ($: any) => {
  const rows = (await commandText($, '')).split('\n')
  return { rows: rows.length, columns: widthOf(rows) }
}
// Rows or lines as the words they hold: the pane draws whole sentences and the command wraps them, so the two are compared joined on whitespace.
const wordsOf = (rows: string[]) => rows.join(' ').split(/\s+/).filter(Boolean).join(' ')
// The details pane's drawing, as text, as the command's answer is read in these tests: a wrapped sentence joined into one line, a section's
// lines after its heading. The pane's rows are whole lines already, so they are joined as they are.
const flatOf = (rows: string[]) => rows.join(' ')
const drawnPane = async ($: any): Promise<string> => flatOf(await paneRows($))
// A mounted pane whose state reads of `key` (the tally unless another is named) are refused while `failing.on` is set; `redraw` runs the
// render chain again. `startFailing` refuses them from the mount's own draw on, so the first draw fails; the session start reads normally.
// `reads` lists every key the hook is asked for, in order.
const failingPane = async ($: any, on: any, startFailing = false, key = 'tally') => {
  const rec = kaWorld(on, cached())
  const clock = mock.clock(on, { now: T0 })
  const failing = { on: false }
  const reads: string[] = []
  on('state.get', (_$: any, e: any, next: any) => {
    reads.push(e.key)
    return failing.on && e.key === key ? { deny: `${key} refused` } : next(e)
  })
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.advance(1000)
  failing.on = startFailing
  const pane = await mountPane($)
  const refused = () => rec.logs.filter((l: string) => l.includes(`${key} refused`)).length
  return { rec, failing, pane, refused, reads }
}

describe('the details pane draw: a state read that fails', () => {
  test('a failing state read during the draw reports once and still draws the last rows', async ($, on) => {
    const { failing, pane, refused } = await failingPane($, on)
    const good = (await pane.drawn()) as any
    expect(good.children.length).not.toBe(0)
    failing.on = true
    await pane.redraw()
    expect(refused()).toBe(1)
    expect(await pane.drawn()).toEqual(good)
    await pane.unmount()
  })

  test('two failures in a row report once', async ($, on) => {
    const { failing, pane, refused } = await failingPane($, on)
    await pane.drawn()
    failing.on = true
    await pane.redraw()
    await pane.redraw()
    expect(refused()).toBe(1)
    await pane.unmount()
  })

  test('a failure, a success and a failure report twice', async ($, on) => {
    const { failing, pane, refused } = await failingPane($, on)
    await pane.drawn()
    failing.on = true
    await pane.redraw()
    failing.on = false
    await pane.redraw()
    failing.on = true
    await pane.redraw()
    expect(refused()).toBe(2)
    await pane.unmount()
  })

  test('a failure with no previous draw does not throw, reports once and draws one row saying the details could not be read', async ($, on) => {
    const { pane, refused } = await failingPane($, on, true)
    expect(refused()).toBe(1)
    expect(await rowsOf(pane)).toEqual(['The details could not be read; see the debug log.'])
    await pane.unmount()
  })

  test('a failing hint state read during the draw reports once and still draws the last rows', async ($, on) => {
    const { failing, pane, refused } = await failingPane($, on, false, 'hint')
    const good = (await pane.drawn()) as any
    expect(good.children.length).not.toBe(0)
    failing.on = true
    await pane.redraw()
    expect(refused()).toBe(1)
    expect(await pane.drawn()).toEqual(good)
    await pane.unmount()
  })
})

describe('the details pane draw: its state is read in its own hook, and an in-memory change asks an open pane to draw again', () => {
  const OTHER = '/home/test/.claude/projects/p/s2.jsonl'
  const LATER = '/home/test/.claude/projects/p/s3.jsonl'
  // The draws the mod asked for: the `ui.invalidate` calls for `ui.render`, as `world` records them.
  const rendersAsked = (rec: { invalidations: string[] }) => rec.invalidations.filter((event) => event === 'ui.render').length

  test('the details pane reads the keys its draw uses in its own hook, before the gather reads them', async ($, on) => {
    const { pane, reads } = await failingPane($, on)
    reads.length = 0
    await pane.redraw()
    expect(reads).toEqual([
      'hint', 'keepalive', 'touch', 'view', 'cold', 'unit', 'tally', 'stats', 'judged', 'cue',
      'keepalive', 'touch', 'view', 'cold', 'unit', 'tally', 'stats', 'judged',
    ])
    await pane.unmount()
  })

  // A transcript learned resets the session's pauses in memory, which no state write covers, so an open pane is asked to draw again. A
  // compaction's session start under a new path makes that reset and also asks for draws of its own, the same with the pane shut or open,
  // so the test compares the two counts, taken once the clock has moved a second and the start's work has run.
  const learnDrawsAsked = async ($: any, clock: any, rec: { invalidations: string[] }, path: string) => {
    const before = rendersAsked(rec)
    await $.classic.SessionStart({ source: 'compact', transcript_path: path })
    await clock.advance(1000)
    return rendersAsked(rec) - before
  }

  test('a transcript learned asks for one more draw while the details pane is open than while it is shut', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const shut = await learnDrawsAsked($, clock, rec, OTHER)
    await m.press({ key: 'details' })
    const open = await learnDrawsAsked($, clock, rec, LATER)
    expect(open - shut).toBe(1)
    await m.unmount()
  })

  // A pause a prompt ends is written to the history in memory, which no state write covers. The gap is open after the turn's end.
  const promptAsked = async ($: any, on: any, open: boolean) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    if (open) await m.press({ key: 'details' })
    const before = rendersAsked(rec)
    await userPrompt($)
    const asked = rendersAsked(rec) - before
    await m.unmount()
    return asked
  }

  test('a pause a prompt ends while the details pane is open asks for a draw', async ($, on) => {
    expect(await promptAsked($, on, true)).toBe(1)
  })

  test('a pause a prompt ends while the details pane is shut asks for no draw', async ($, on) => {
    expect(await promptAsked($, on, false)).toBe(0)
  })
})

describe('the details pane: a click on the time opens it at its size, a second click closes it, and the pie is the switch', () => {
  test('a click on the time opens the pane at the rows and columns its last draw took, Esc closes it, and keepalive is left as it is', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const rows = await paneRows($)
    await m.press({ key: 'details' })
    expect(rec.opens.map((o: any) => o.id)).toEqual([PANE_ID])
    expect(rec.opens[0]).toMatchObject({ title: 'Prompt cache', closeOnEscape: true })
    expect(rows.length).toBeGreaterThan(0)
    expect(rec.opens[0]).toMatchObject(await answerSize($))
    expect(await toggle($, '')).toContain('Keepalive  off')
    await m.unmount()
  })

  test('a click on the time asks for the pane within the press, with nothing awaited first', async ($, on) => {
    // An open made after an await is not counted as asked for, and a narrow terminal leaves such a pane undrawn (pane.ts).
    const rec = kaWorld(on, cached())
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let holding = false
    // Every state read the mod makes once the footer is drawn is held: a click that reads anything before it opens never opens.
    on('state.get', async (_$: any, e: any, next: any) => {
      if (holding && e.plugin === 'cachier') await hold
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    holding = true
    await m.press({ key: 'details' })
    expect(rec.opens.map((o: any) => o.id)).toEqual([PANE_ID])
    holding = false
    release()
    await clock.settle()
    await m.unmount()
  })

  test('a click while the pane is open closes it, and keepalive stays as it was', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.press({ key: 'details' })
    expect(rec.opens.map((o: any) => o.id)).toEqual([PANE_ID])
    expect(rec.closes.map((c: any) => c.id)).toEqual([PANE_ID])
    expect(rec.panes.size).toBe(0)
    expect(await toggle($, '')).toContain('keepalive on')
    await m.unmount()
  })

  test('a click after a close opens the pane again', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.press({ key: 'details' })
    await m.press({ key: 'details' })
    expect(rec.opens.map((o: any) => o.id)).toEqual([PANE_ID, PANE_ID])
    expect(rec.closes.map((c: any) => c.id)).toEqual([PANE_ID])
    await m.unmount()
  })

  test('after a reload that keeps the pane open, the next click closes it, as the engine\'s record says it is open', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    // The reload: the engine keeps the pane, and its record lists it when the session starts again.
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    const opened = rec.opens.length
    const again = await mountHint($)
    await again.press({ key: 'details' })
    expect(rec.opens.length).toBe(opened)
    expect(rec.closes.map((c: any) => c.id)).toEqual([PANE_ID])
    await again.unmount()
  })

  test('a click while keepalive is on opens the pane, and keepalive stays on', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    const m = await mountHint($)
    const opened = rec.opens.length
    await m.press({ key: 'details' })
    expect(rec.opens.slice(opened).map((o: any) => o.id)).toEqual([PANE_ID])
    expect(await toggle($, '')).toContain('keepalive on')
    await m.unmount()
  })

  test('the details hold the Cache section first, then keepalive\'s state, and no history sentence', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const rows = await paneRows($)
    expect(rows[0]).toBe('Cache')
    expect(rows.find((row) => /^[○◔◑◕●] warm · /.test(row))).toMatch(/^● warm · \d+:\d\d left · 5m TTL$/)
    expect(rows.indexOf('Keepalive  off')).toBeGreaterThan(1)
    expect(JSON.stringify(rows)).not.toMatch(/earlier:|learned|long pauses:|misses:/)
  })

  test('the pie switches keepalive as the command does, and the pane has no switch to press', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await pressPie($)
    expect(await toggle($, '')).toContain('keepalive on')
    const pane = await mountPane($)
    expect(JSON.stringify(await pane.drawn())).not.toContain('Turn keepalive')
    expect(await pane.find({ type: 'Button', key: 'keepalive' })).toBeUndefined()
    await pane.unmount()
    await pressPie($)
    expect(await toggle($, '')).toContain('Keepalive  off')
  })

  test('while keepalive is off the pane\'s Settings state the lead the last run used', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, 'on 240 3')).toContain('keepalive on')
    expect(await toggle($, 'off')).toContain('keepalive off')
    await clock.advance(1000)
    expect(await drawnPane($)).toContain('lead: 240s · /keepalive on <lead_s>')
  })

  test('after a pie press, the next tick re-opens an open pane at the rows and columns its new draw took', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    await pressPie($)
    expect(rec.opens.length).toBe(1)
    const rows = await paneRows($)
    await clock.advance(1000)
    expect(rec.opens.length).toBe(2)
    expect(rec.opens[1]).toMatchObject({ id: PANE_ID, ...(await answerSize($)) })
    expect(rec.closes).toEqual([])
  })

  test('a tick that finds the drawn size changed re-opens an open pane at its new size', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    const off = await paneRows($)
    const offSize = await answerSize($)
    await clock.advance(1000)
    expect(rec.opens.length).toBe(2)
    expect(rec.opens[1]).toMatchObject({ id: PANE_ID, ...offSize })
    expect(await toggle($, 'on 15 3')).toContain('keepalive on')
    await clock.advance(1000)
    const on3 = await paneRows($)
    const onSize = await answerSize($)
    expect(on3.length).not.toBe(off.length)
    expect(onSize.rows).not.toBe(offSize.rows)
    await clock.advance(1000)
    expect(rec.opens.length).toBe(3)
    expect(rec.opens[2]).toMatchObject({ id: PANE_ID, ...onSize })
  })

  test('with the pane shut, a pie press or a tick opens nothing', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    expect(rec.opens).toEqual([])
  })

  test('an open the engine refuses is named on the status line, until an open lands', async ($, on) => {
    const doc = { ...cached(), openThrows: true }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBe('the details pane did not open; see the debug log')
    doc.openThrows = false
    await m.press({ key: 'details' })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBeUndefined()
    await m.unmount()
  })

  test('an open the engine does not place names no failure, and the next press asks the pane open', async ($, on) => {
    const rec = kaWorld(on, { ...cached(), openUnplaced: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBeUndefined()
    await m.press({ key: 'details' })
    expect(rec.opens.length).toBe(2)
    expect(rec.closes).toEqual([])
    await m.unmount()
  })

  test('after a refused open has been named, an open the engine does not place leaves no failure on the status line', async ($, on) => {
    const doc = { ...cached(), openThrows: true, openUnplaced: false }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBe('the details pane did not open; see the debug log')
    doc.openThrows = false
    doc.openUnplaced = true
    await m.press({ key: 'details' })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBeUndefined()
    await m.unmount()
  })

  test('the pane draws no hover element and nothing absolutely positioned', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    const pane = await mountPane($)
    const drawn = JSON.stringify(await pane.drawn())
    await pane.unmount()
    await m.unmount()
    expect(drawn).not.toContain('absolute')
    expect(drawn).not.toContain('hover')
  })
})

// How many times the plugin's state key has been read: the footer, the tick and a press are told apart from the pane's draw by what each reads.
const countReads = (on: any, keys: string[]) => {
  const reads: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]))
  on('state.get', async (_$: any, e: any, next: any) => {
    if (e.plugin === 'cachier' && e.key in reads) reads[e.key]!++
    return next(e)
  })
  return reads
}
// A drawing's text, row by row, from a mounted pane that stays mounted: each call is a fresh draw of what the engine last asked.
// A blank row is drawn as one space, and read back as the empty row the command's answer has.
const rowsOf = async (pane: any): Promise<string[]> => ((await pane.drawn()) as any).children.map(textOf).map((row: string) => (row === ' ' ? '' : row))
const boldRows = async (pane: any): Promise<string[]> => ((await pane.drawn()) as any).children.filter((row: any) => JSON.stringify(row).includes('"bold":true')).map(textOf)
// The Keepalive heading's row in a drawing of the pane, and the props a drawn element sets, none when it sets none.
const keepaliveRow = (tree: any): any => tree.children.find((row: any) => textOf(row).startsWith('Keepalive'))
const propsOf = (el: any): Record<string, unknown> => el.props ?? {}
// The Cache line's row in a drawing of the pane, the row under the Cache heading, or undefined where there is no Cache section; its pie, the first of the
// two Texts nested in the line's Text; and the row without its pie.
const cacheRow = (tree: any): any => {
  const at = tree.children.findIndex((row: any) => textOf(row) === 'Cache')
  return at < 0 ? undefined : tree.children[at + 1]
}
const pieOfRow = (row: any): any => row.children[0].children[0]
// The details pane as drawn now: its tree, read through a mount that is shut again.
const paneTree = async ($: any): Promise<any> => {
  const pane = await mountPane($)
  const tree = await pane.drawn()
  await pane.unmount()
  return tree
}
const withoutPie = (row: any): any => ({ ...row, children: [{ ...row.children[0], children: row.children[0].children.slice(1) }] })
// The pie line, which the Keepalive section words while keepalive is off: its row in a drawing of the pane, or undefined where the pane shows none (a test
// finds the row by its words; the drawing reads none); and the row without its `amber` and `red`, for a negative that denies any other colour or dim. The helper
// only strips the two words; their tones are pinned by the pie line describe block below and by the countdown tests.
const PIE_LINE = 'pie: amber ≤¼ TTL left, red ≤⅒'
const pieLineRow = (tree: any): any => tree.children.find((row: any) => textOf(row) === PIE_LINE)
const withoutColourWords = (row: any): any => ({
  ...row,
  children: [{ ...row.children[0], children: row.children[0].children.filter((piece: any) => !['amber', 'red'].includes(textOf(piece))) }],
})
// The rows of a drawing of the pane with every piece that may carry a colour or a dim taken out: the Keepalive heading's state word, the Cache line's pie, the pie
// line's `amber` and `red`, and each row's label. What is left is drawn with no colour, dim or background, and has as many rows as the drawing.
const withoutTones = (tree: any): any[] => {
  const heading = keepaliveRow(tree)
  const cache = cacheRow(tree)
  const line = pieLineRow(tree)
  return [
    ...tree.children.filter((row: any) => row !== heading && row !== cache && row !== line).map(withoutLabel),
    heading.children[0],
    ...(cache === undefined ? [] : [withoutPie(cache)]),
    ...(line === undefined ? [] : [withoutLabel(withoutColourWords(line))]),
  ]
}
const NO_TONE = /"color"|"dimColor"|"backgroundColor"/

describe('the details pane draws the sections /keepalive answers with, built by its draw alone', () => {
  const opts = { options: { keepalive_lead_s: 15, keepalive_count: 3 } }

  test('open, it shows the rows /keepalive answers, in the same order with the same words, in each state keepalive is in', opts, async ($, on) => {
    const doc: any = cached()
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    for (const args of ['off', 'on 15 3', 'on 400 3']) {
      await toggle($, args)
      await clock.settle()
      const answer = (await commandText($, '')).split('\n')
      expect(wordsOf(await rowsOf(pane))).toBe(wordsOf(answer))
      expect(answer[0]).toBe('Cache')
    }
    await clock.advance(400000)
    await toggle($, 'on 15 3')
    await clock.settle()
    expect(wordsOf(await rowsOf(pane))).toBe(wordsOf((await commandText($, '')).split('\n')))
    await pane.unmount()
  })

  test('each section heading is drawn bold, and no row is bold or coloured otherwise but the Keepalive state word, the pie line\'s amber and red, and each row\'s dim label', opts, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    const rows = await rowsOf(pane)
    const headings = rows.filter((row) => /^(Cache|Keepalive(  .+)?|This session|Advice|Settings)$/.test(row))
    expect(headings.length).toBeGreaterThanOrEqual(3)
    expect(await boldRows(pane)).toEqual(headings)
    // The coloured pieces are named: keepalive is off here, so its state word is dim, and the pie line shows with `amber` and `red` coloured. Every other row, the
    // heading's title and the rest of the pie line carry no colour; the Cache line's pie too, since a calm warm cache with keepalive off is drawn in the normal
    // colour.
    const tree = (await pane.drawn()) as any
    const heading = keepaliveRow(tree)
    expect(heading.children).toHaveLength(2)
    expect(propsOf(heading.children[1])).toEqual({ dimColor: true })
    const line = pieLineRow(tree)
    const rest = [...tree.children.filter((row: any) => row !== heading && row !== line).map(withoutLabel), heading.children[0], ...(line === undefined ? [] : [withoutLabel(withoutColourWords(line))])]
    expect(rest).toHaveLength(tree.children.length)
    expect(JSON.stringify(rest)).not.toMatch(NO_TONE)
    expect(mislabelled(tree)).toEqual([])
    // The labels taken out of `rest` are drawn dim: the pie line's, the figures' of an offer, the learned rest's, the session fallback's, the tokens note's and each setting's name.
    const labels = drawnLabels(tree)
    expect(labels.map(([label]) => label)).toEqual(['pie:', 'refresh', 'if cold:', 'rest:', 'session:', 'in tokens:', 'TTL:', 'lead:', 'refreshes/pause:', 'start mode:', 'unit:', 'night stop:'])
    for (const [, props] of labels) expect(props).toEqual({ dimColor: true })
    await pane.unmount()
  })

  // The five states the Keepalive heading names, each with how a session reaches it, the props its state word is drawn in, and the glyph and props the Cache
  // line's pie is drawn in there, as the footer's pie is (`null` where the state has no Cache line). The pie is green with keepalive on, in every state, and
  // follows the cache's time with it off, so it does not follow the heading: the paused and stopped states, a calm warm cache and one in its last quarter, draw it
  // green beside the heading's amber and red, and the off state draws the normal colour.
  type Pie = { glyph: string; props: Record<string, string | boolean> }
  const HEADING_STATES: { word: string; props: Record<string, string | boolean>; pie: Pie | null; reach: ($: any, on: any) => Promise<unknown> }[] = [
    { word: 'off', props: { dimColor: true }, pie: { glyph: '●', props: {} }, reach: ($, on) => startedWorld($, on) },
    {
      word: 'on, refreshing',
      props: { color: 'success' },
      pie: { glyph: '●', props: { color: 'success' } },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 15')
        await clock.advance(1000)
      },
    },
    {
      word: 'on, no count',
      props: { color: 'warning' },
      pie: null,
      reach: async ($, on) => {
        const clock = await startedWorld($, on, { text: '', exists: false })
        await toggle($, 'on 15')
        await clock.advance(1000)
      },
    },
    {
      word: 'paused',
      props: { color: 'warning' },
      pie: { glyph: '●', props: { color: 'success' } },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 400')
        await clock.advance(1000)
      },
    },
    {
      word: 'stopped',
      props: { color: 'error' },
      pie: { glyph: '◔', props: { color: 'success' } },
      reach: async ($, on) => {
        const doc: any = opusCached()
        doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
        const clock = await startedWorld($, on, doc)
        await toggle($, 'on 60 2')
        await mainStep($)
        await turnEnd($)
        await clock.advance(241000)
      },
    },
  ]
  for (const s of HEADING_STATES) {
    test(`keepalive ${s.word}: the Keepalive heading is one bold Text, its title untoned and its state word in the state's tone, and no other row is coloured but the Cache line's pie, the pie line's amber and red, and each row's dim label`, async ($, on) => {
      await s.reach($, on)
      const pane = await mountPane($)
      const tree = (await pane.drawn()) as any
      const heading = keepaliveRow(tree)
      expect(textOf(heading)).toBe(`Keepalive  ${s.word}`)
      expect(heading.type).toBe('Text')
      expect(propsOf(heading)).toEqual({ bold: true, wrap: 'wrap' })
      expect(heading.children).toHaveLength(2)
      const [title, state] = heading.children
      expect(title).toMatchObject({ type: 'Text', children: ['Keepalive  '] })
      expect(propsOf(title)).toEqual({})
      expect(state).toMatchObject({ type: 'Text', children: [s.word] })
      expect(propsOf(state)).toEqual(s.props)
      // The Cache line's pie is the glyph and the props the state names, or the state has no Cache line. Every other row, whole, the title, the Cache line
      // without its pie, the pie line without its `amber` and `red`, where the state shows that line, and each labelled row without its label, are drawn with no
      // colour or dim, and no row that opens with a listed label is left a plain string.
      const cache = cacheRow(tree)
      if (s.pie === null) expect(cache).toBeUndefined()
      else {
        expect(textOf(pieOfRow(cache))).toBe(s.pie.glyph)
        expect(propsOf(pieOfRow(cache))).toEqual(s.pie.props)
      }
      const rest = withoutTones(tree)
      expect(rest).toHaveLength(tree.children.length)
      expect(rest).toContain(title)
      expect(JSON.stringify(rest)).not.toMatch(NO_TONE)
      expect(mislabelled(tree)).toEqual([])
      const labels = drawnLabels(tree)
      expect(labels.length).toBeGreaterThan(0)
      for (const [, props] of labels) expect(props).toEqual({ dimColor: true })
      // The learned rest's row stands in every state, with the label dim: with no pause stored it says none is seen.
      expect(labels.map(([label]) => label)).toContain('rest:')
      expect(tree.children.map(textOf)).toContain('rest: 0 of 7 seen')
      // The bare answer names the state in the same words, as plain text, and states the row once in its Keepalive section.
      const answer = await commandText($, '')
      expect(answer.split('\n')).toContain(`Keepalive  ${s.word}`)
      expect(sectionLines(answer, 'Keepalive')?.filter((line) => line === 'rest: 0 of 7 seen')).toHaveLength(1)
      await pane.unmount()
    })
  }

  test('the pane\'s rows are the command\'s answer: the same snapshot is gathered once per surface and laid out alike', opts, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const rows = await paneRows($)
    expect(wordsOf(rows)).toBe(wordsOf((await commandText($, '')).split('\n')))
  })

  test('with the pane shut, a footer draw, a tick and a pie press build no section text; the pane\'s draw does', opts, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    const reads = countReads(on, ['judged', 'tally'])
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(3000)
    const ticked = { ...reads }
    const m = await mountHint($)
    await m.unmount()
    expect(reads.tally).toBe(ticked.tally)
    await pressPie($)
    await clock.advance(3000)
    expect(reads.judged).toBe(0)
    await paneRows($)
    expect(reads.judged).toBeGreaterThan(0)
  })

  test('with the pane open and not yet drawn, a tick and a pie press build no section text either', opts, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    const reads = countReads(on, ['judged', 'tally'])
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const shutFrom = reads.tally!
    await clock.advance(3000)
    const shut = reads.tally! - shutFrom
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    expect(rec.opens).toHaveLength(1)
    const openFrom = reads.tally!
    await clock.advance(3000)
    // A tick reads the tally no more with the pane open than it does shut: nothing but the pane's draw builds its rows.
    expect(reads.tally! - openFrom).toBe(shut)
    await pressPie($)
    await clock.advance(3000)
    expect(reads.judged).toBe(0)
  })

  test('the open pane\'s countdown advances each second', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    const left = async () => {
      const rows = await rowsOf(pane)
      expect(rows[0]).toBe('Cache')
      const match = rows.find((row) => row.includes('left'))!.match(/(\d+):(\d\d) left/)!
      return Number(match[1]) * 60 + Number(match[2])
    }
    const first = await left()
    await clock.advance(1000)
    expect(await left()).toBe(first - 1)
    await clock.advance(1000)
    expect(await left()).toBe(first - 2)
    await pane.unmount()
  })

  test('the hint state holds the reading and the labels of the cost and the offer, and nothing the pane\'s lines were built from', opts, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    let latest: any
    on('state.set', async (_$: any, e: any, next: any) => {
      if (e.plugin === 'cachier' && e.key === 'hint') latest = e.value
      return next(e)
    })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const stored = latest
    expect(Object.keys(stored).sort()).toEqual(['cost', 'offer', 'reading'])
    expect(stored.cost).toBeNull()
    expect(stored.offer).toEqual({ label: 'keep warm ~19k read/refresh · if cold ~19k tokens rebuild' })
    await toggle($, 'on 15 3')
    await clock.advance(1000)
    const running = latest
    expect(Object.keys(running).sort()).toEqual(['cost', 'offer', 'reading'])
    expect(running.cost).toEqual({ label: 'keep warm ~19k read/refresh · if cold ~19k tokens rebuild' })
  })

  test('a click on the time opens the pane at 12 rows by 48 columns before any draw, and at the size its last draw recorded after one, a close between them included', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    expect(rec.opens).toHaveLength(1)
    expect(rec.opens[0]).toMatchObject({ id: PANE_ID, rows: 12, columns: 48 })
    await m.press({ key: 'details' })
    const rows = await paneRows($)
    await m.press({ key: 'details' })
    expect(rec.opens).toHaveLength(2)
    expect(rec.opens[1]).toMatchObject({ id: PANE_ID, ...(await answerSize($)) })
    await m.unmount()
  })

  test('with the pane open, a tick re-opens it at the size its draw recorded when that differs from the size last asked, once, and a stale size is re-opened by the next tick', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    // Asked at the provisional size, and nothing drawn yet: ticks leave it.
    await clock.advance(2000)
    expect(rec.opens).toHaveLength(1)
    const rows = await paneRows($)
    expect((await answerSize($)).rows).not.toBe(12)
    await clock.advance(1000)
    expect(rec.opens).toHaveLength(2)
    expect(rec.opens[1]).toMatchObject({ id: PANE_ID, ...(await answerSize($)) })
    await clock.advance(2000)
    expect(rec.opens).toHaveLength(2)
    expect(rec.closes).toEqual([])
  })

  test('after a session start with the pane open, no tick re-opens it before its first draw, and the first tick after that draw re-opens it once at the size the draw recorded', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    await paneRows($)
    await clock.advance(1000)
    const before = rec.opens.length
    await $.session.start({ cwd: '/home/test', surface: 'terminal', isInteractive: true } as any)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(3000)
    expect(rec.opens.length).toBe(before)
    const rows = await paneRows($)
    await clock.advance(1000)
    expect(rec.opens.length).toBe(before + 1)
    expect(rec.opens[before]).toMatchObject({ id: PANE_ID, ...(await answerSize($)) })
    await clock.advance(3000)
    expect(rec.opens.length).toBe(before + 1)
  })

  test('with the pane open and keepalive off, a pie press that turns it on in a state that pauses draws the pause\'s reason before the next tick', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    expect((await rowsOf(pane)).join('\n')).toContain('Keepalive  off')
    await pressPie($)
    const rows = await rowsOf(pane)
    const heading = rows.findIndex((row) => row.startsWith('Keepalive  '))
    expect(rows[heading]).toMatch(/^Keepalive  (paused|stopped)/)
    expect(rows[heading]).not.toContain('off')
    expect(rows[heading + 1]!.trim()).not.toBe('')
    expect(wordsOf(rows)).toBe(wordsOf((await commandText($, '')).split('\n')))
    await pane.unmount()
  })

  test('with the pane open, a pie press that turns keepalive off draws the off state before the next tick', opts, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    const pane = await mountPane($)
    expect((await rowsOf(pane)).join('\n')).toContain('Keepalive  on, refreshing')
    await pressPie($)
    const rows = await rowsOf(pane)
    expect(rows.some((row) => row === 'Keepalive  off')).toBe(true)
    expect(wordsOf(rows)).toBe(wordsOf((await commandText($, '')).split('\n')))
    await pane.unmount()
  })

  test('no state the judge can give puts "no refresh is due", or a paused or stopped heading with no reason under it, in the pane', opts, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    const seen: string[] = []
    for (const args of ['off', 'on 15 3', 'on 400 3', 'on 15 3']) {
      await toggle($, args)
      await clock.advance(1000)
      const rows = await rowsOf(pane)
      expect(rows.join('\n')).not.toContain('no refresh is due')
      const heading = rows.findIndex((row) => row.startsWith('Keepalive  '))
      seen.push(rows[heading]!)
      if (/paused|stopped/.test(rows[heading]!)) expect(rows[heading + 1]!.trim()).not.toBe('')
    }
    await clock.advance(400000)
    const rows = await rowsOf(pane)
    const heading = rows.findIndex((row) => row.startsWith('Keepalive  '))
    expect(rows.join('\n')).not.toContain('no refresh is due')
    expect(rows[heading + 1]!.trim()).not.toBe('')
    expect(seen.some((row) => /paused/.test(row))).toBe(true)
    await pane.unmount()
  })
})

describe('the details pane: the flag follows the engine\'s record of the pane', () => {
  // The pane opened by a click and left to settle, with the footer still drawn for the next press.
  const opened = async ($: any, on: any, doc: any = cached()) => {
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    return { rec, clock, m }
  }
  const panesRefused = (rec: any) => rec.logs.filter((l: string) => l.includes('panes refused')).length

  test('after the person closes the pane, the next press after the next tick opens it', async ($, on) => {
    const { rec, clock, m } = await opened($, on)
    // The kit cannot raise the person's close: the engine\'s record drops the pane, and the tick\'s read is what tells the mod.
    rec.panes.delete(PANE_ID)
    await clock.advance(1000)
    await m.press({ key: 'details' })
    expect(rec.opens.length).toBe(2)
    expect(rec.closes).toEqual([])
    await m.unmount()
  })

  test('after another plugin refuses the mod\'s own close, the pane stays open and the next press closes it', async ($, on) => {
    const doc = { ...cached(), closeKeeps: true }
    const { rec, m } = await opened($, on, doc)
    await m.press({ key: 'details' })
    expect(rec.panes.size).toBe(1)
    doc.closeKeeps = false
    await m.press({ key: 'details' })
    expect(rec.closes.length).toBe(2)
    expect(rec.opens.length).toBe(1)
    expect(rec.panes.size).toBe(0)
    await m.unmount()
  })

  test('after the mod\'s own close call rejects, the next press closes the pane', async ($, on) => {
    const doc = { ...cached(), closeThrows: true }
    const { rec, clock, m } = await opened($, on, doc)
    await m.press({ key: 'details' })
    await clock.settle()
    doc.closeThrows = false
    await m.press({ key: 'details' })
    expect(rec.closes.length).toBe(2)
    expect(rec.opens.length).toBe(1)
    expect(rec.panes.size).toBe(0)
    await m.unmount()
  })

  test('after a close the mod never hears, such as an earlier load\'s, the next press after the next tick opens the pane', async ($, on) => {
    const { rec, clock, m } = await opened($, on)
    // An earlier load\'s close: the engine\'s record drops the pane and no ui.close reaches this load.
    rec.panes.delete(PANE_ID)
    await clock.advance(1000)
    await m.press({ key: 'details' })
    expect(rec.opens.length).toBe(2)
    expect(rec.closes).toEqual([])
    await m.unmount()
  })

  test('a pane the engine lists but has not placed leaves the next press asking it open; once placed, the next press after the next tick closes it', async ($, on) => {
    const doc = { ...cached(), listUnplaced: true }
    const { rec, clock, m } = await opened($, on, doc)
    await m.press({ key: 'details' })
    expect(rec.opens.length).toBe(2)
    expect(rec.closes).toEqual([])
    doc.listUnplaced = false
    await clock.advance(1000)
    await m.press({ key: 'details' })
    expect(rec.closes.length).toBe(1)
    await m.unmount()
  })

  test('a read of the record that fails after a press is reported, and the next press acts as the mod last knew the pane', async ($, on) => {
    const doc = { ...cached(), panesThrow: false }
    const { rec, m } = await opened($, on, doc)
    doc.panesThrow = true
    await m.press({ key: 'details' })
    expect(panesRefused(rec)).toBe(1)
    expect(rec.panes.size).toBe(0)
    await m.press({ key: 'details' })
    expect(rec.opens.length).toBe(2)
    await m.unmount()
  })

  test('a read that fails after the mod\'s own close is reported once, and the close goes ahead', async ($, on) => {
    const doc = { ...cached(), panesThrow: false }
    const { rec, m } = await opened($, on, doc)
    doc.panesThrow = true
    await m.press({ key: 'details' })
    expect(panesRefused(rec)).toBe(1)
    expect(rec.panes.size).toBe(0)
    await m.unmount()
  })

  test('two failed tick reads in a row make one report; a failed, a successful and a failed one make two', async ($, on) => {
    const doc = { ...cached(), panesThrow: false }
    const { rec, clock, m } = await opened($, on, doc)
    doc.panesThrow = true
    await clock.advance(1000)
    await clock.advance(1000)
    expect(panesRefused(rec)).toBe(1)
    doc.panesThrow = false
    await clock.advance(1000)
    doc.panesThrow = true
    await clock.advance(1000)
    expect(panesRefused(rec)).toBe(2)
    await m.unmount()
  })

  test('failed reads after two closes are reported for each close, whatever the ticks between them reported', async ($, on) => {
    const doc = { ...cached(), panesThrow: true }
    const { rec, clock, m } = await opened($, on, doc)
    await clock.advance(1000)
    await clock.advance(1000)
    const before = panesRefused(rec)
    // The reads fail, so the flag stays as the mod's own calls left it; each press still reads once.
    await m.press({ key: 'details' })
    expect(panesRefused(rec) - before).toBe(1)
    await m.press({ key: 'details' })
    expect(panesRefused(rec) - before).toBe(2)
    await m.unmount()
  })

  test('after a re-open another plugin refuses on a pane that stays open, later ticks asking the same size do not re-open it', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const doc = { ...cached(), openThrows: false }
    const { rec, clock, m } = await opened($, on, doc)
    await m.unmount()
    doc.openThrows = true
    expect(await toggle($, 'on 15 3')).toContain('keepalive on')
    await paneRows($)
    await clock.advance(1000)
    const refused = rec.opens.length
    expect(refused).toBe(2)
    await clock.advance(1000)
    await clock.advance(1000)
    expect(rec.opens.length).toBe(refused)
  })
})

describe('the words the user reads: no /keepalive answer, status line or pane says ping, armed, cold or par', () => {
  test('across the states keepalive is in, none of them says those words', { options: { keepalive_lead_s: 60, keepalive_count: 1 } }, async ($, on) => {
    const doc: any = cached()
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    const said: string[] = []
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    said.push(await toggle($, ''))
    said.push(await toggle($, 'on 60 1'))
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    said.push(await toggle($, ''))
    doc.fork = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }
    await userPrompt($)
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    said.push(lastStatus(rec) ?? '')
    said.push(await toggle($, ''))
    said.push(await drawnHint($))
    await toggle($, 'off')
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    said.push(await toggle($, 'on 60 1'))
    said.push(await toggle($, ''))
    said.push(await drawnHint($))
    // A fresh reply re-warms the cache and lifts the cold mark; `on 300` re-arms the run at a lead at the TTL.
    await userPrompt($)
    await mainStep($)
    await turnEnd($)
    said.push(await toggle($, 'on 300'))
    said.push(await toggle($, ''))
    // Each state was reached, so the scan below covers it.
    expect(said[0]).toMatch(/Keepalive {2}off/)
    expect(said[2]).toContain('count used · resumes on next prompt')
    expect(said[3]).toContain('keepalive stopped: API error 529 (overloaded)')
    expect(said[4]).toContain('Keepalive  stopped API error 529 (overloaded) · restarts on next prompt')
    expect(said[8]).toContain('"children":[" reset · rebuild ~19k tokens"]')
    // The pair says cold only inside the two phrases that name it.
    for (const s of said) expect(s.replace(/if cold|if it goes cold/gi, '')).not.toMatch(/ping|armed|cold|\bpar\b/i)
    expect(said[0]).toMatch(/if cold: rebuild|if it goes cold/)
    expect(said[1]).toMatch(/if cold: rebuild|if it goes cold/)
    expect(said[2]).toMatch(/if cold: rebuild|if it goes cold/)
    expect(said[10]).toMatch(/if cold: rebuild|if it goes cold/)
    expect(said.find((s) => s.startsWith('keepalive on: lead 300 s'))).toContain('If it goes cold')
  })
})

// Live check 7, from the real artifact (live7-model-switch.jsonl): the turn-1 response phpay, a /model switch, a prompt, and the
// switched response inret, which is one API message of two rows. Times are the artifact's, as offsets from T0: phpay 05:38:29.010,
// /model 05:40:30, prompt 05:41:33, inret 05:41:35.755. The fixture's input is 8 tokens on every row, so the totals differ
// from the artifact's by that much; the read and write figures are the artifact's.
describe('live check 7: a real model switch records a cold miss', () => {
  const LIVE = { phpay: 11642, phpayWrite: 18533, inretRead: 11642, inretWrite: 19089 }
  const at = (s: number) => iso(T0 + s * 1000)
  const SWITCH = { from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any

  test('the switched response is a cold miss, and its stats are not reset by the switch', async ($, on) => {
    const doc: any = {
      text: lines([
        user({ uuid: 'u0', parent: null, ts: at(-60) }),
        assistant({ uuid: 'a0', parent: 'u0', ts: at(-59), write: 5, tags: FIVE, msg: 'm0' }),
        user({ uuid: 'u1', parent: 'a0', ts: at(0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: at(0.5), read: LIVE.phpay, write: LIVE.phpayWrite, tags: FIVE, msg: 'phpay' }),
      ]),
    }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 1000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)

    await clock.advance(120000)
    await $.classic.PostModelSwitch(SWITCH)
    await clock.advance(1000)

    await clock.advance(54000)
    doc.text += lines([
      user({ uuid: 'u2', parent: 'a1', ts: at(184) }),
      assistant({ uuid: 'b1', parent: 'u2', ts: at(185.755), read: LIVE.inretRead, write: LIVE.inretWrite, tags: FIVE, msg: 'inret' }),
      assistant({ uuid: 'b2', parent: 'b1', ts: at(185.9), read: LIVE.inretRead, write: LIVE.inretWrite, tags: FIVE, msg: 'inret' }),
    ])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const misses = debugOf(rec, 'cachier miss')
    expect(misses.map((m: any) => m.cause)).toEqual(['cold'])
    expect(await toggle($, '')).toContain('misses:')
  })

  test("a reply written after the turn's last read is folded on the next tick, with no further event", async ($, on) => {
    const doc: any = {
      text: lines([
        user({ uuid: 'u0', parent: null, ts: at(-60) }),
        assistant({ uuid: 'a0', parent: 'u0', ts: at(-59), write: 5, tags: FIVE, msg: 'm0' }),
        user({ uuid: 'u1', parent: 'a0', ts: at(0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: at(0.5), read: LIVE.phpay, write: LIVE.phpayWrite, tags: FIVE, msg: 'phpay' }),
      ]),
    }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 1000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    await $.classic.PostModelSwitch(SWITCH)
    await clock.advance(120000)
    // The reply lands after the turn's last read: no hook fires, only the file grows.
    doc.text += lines([
      user({ uuid: 'u2', parent: 'a1', ts: at(184) }),
      assistant({ uuid: 'b1', parent: 'u2', ts: at(185.755), read: LIVE.inretRead, write: LIVE.inretWrite, tags: FIVE, msg: 'inret' }),
    ])
    await clock.advance(1000)
    expect(debugOf(rec, 'cachier miss').map((m: any) => m.cause)).toEqual(['cold'])
  })

  test('growth while a main-thread turn is running causes no extra read', async ($, on) => {
    const doc: any = { text: lines([user({ uuid: 'u0', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(1000)
    const running = rec.runs
    doc.text += lines([user({ uuid: 'u1', parent: 'u0', ts: iso(T0 - 30000) })])
    await clock.advance(3000)
    expect(rec.runs).toBe(running)
  })
})

// Long pauses on the pane and in the debug log. The gap is 9.5 min: at 5 m TTL, 15 s lead covers it with 1 ping and 60 s with 2.
describe('long pauses: the debug line, and the pane ping count from the lead in use', () => {
  const GAP = 570000
  const longWorld = (on: any) => {
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1' })]) }
    return { doc, rec: kaWorld(on, doc) }
  }
  const pauseThenPane = async ($: any, doc: any, clock: any) => {
    const m = await mountHint($)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + GAP), read: 9, tags: FIVE, msg: 'm2' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const drawn = JSON.stringify(await m.drawn()) + (await drawnPane($))
    await m.unmount()
    return drawn
  }

  test('a long pause writes one cachier pause line with its time and gap, and shows on the pane with keepalive off', { options: { keepalive_lead_s: 15, keepalive_count: 2 } }, async ($, on) => {
    const { doc, rec } = longWorld(on)
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const drawn = await pauseThenPane($, doc, clock)
    expect(debugOf(rec, 'cachier pause')).toEqual([{ atMs: T0 + GAP, gapMs: GAP }])
    expect(drawn).not.toContain('Longest pause')
  })

  test('a stats alarm does not stop a due ping', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    on('state.set', (_$: any, e: any, next: any) => (e.key === 'stats' ? { value: { isSet: false } } : next(e)))
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await clock.advance(250000)
    expect(rec.forks.length).toBeGreaterThan(0)
    expect(lastStatus(rec)).toContain('stats write failed')
  })

  test("a refused reset is retried by the next hook that carries its path, and the old counts do not show on the new path", async ($, on) => {
    const PATH2 = `${PATH}.next`
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1' })]) }
    const rec = kaWorld(on, doc)
    let refuse = false
    on('state.set', (_$: any, e: any, next: any) => (refuse && e.key === 'stats' ? { value: { isSet: false } } : next(e)))
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('misses: 1 (lapse 1)')
    // The switch to the new path: its reset is refused, so the path is unlearned and the alarm says so.
    refuse = true
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog', transcript_path: PATH2 } as any)
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('stats write failed')
    // The writes land again, and the next hook carrying the new path retries the reset, which clears the old counts.
    refuse = false
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog', transcript_path: PATH2 } as any)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn()) + (await drawnPane($))).not.toContain('Lapse misses')
    await m.unmount()
  })

  test('a click on an expired cache while off turns keepalive on, paused: it sends no fork, and says what a refresh reads', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Keepalive  paused cache expired · resumes on next prompt refresh ~19k cached every 4 min')
  })

})

describe('the history read: a failure is reported once when two starts share the read', () => {
  test('two starts that share one failing history read report its failure once', async ($, on) => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const rec = kaWorld(on, { ...cached(), keysThrows: true, keysHold: hold })
    const clock = mock.clock(on, { now: T0 })
    const starts = Promise.all([$.classic.SessionStart({ source: 'startup', transcript_path: PATH }), $.classic.SessionStart({ source: 'startup', transcript_path: PATH })])
    // The second start joins the first's read while it is held, so the two callers share one read.
    await clock.settle()
    release()
    await starts
    await clock.settle()
    expect(rec.logs.filter((l: string) => l.includes('keys refused'))).toHaveLength(1)
  })
})

describe('the stats reset: a reset that does not land', () => {
  test('a refused reset raises the stats alarm, and the alarm clears once a stats write lands', async ($, on) => {
    const doc = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) })]) }
    const rec = world(on, doc)
    let refuse = true
    on('state.set', (_$: any, e: any, next: any) => (refuse && e.key === 'stats' ? { value: { isSet: false } } : next(e)))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('stats write failed')
    refuse = false
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog', transcript_path: PATH } as any)
    await clock.advance(1000)
    expect(lastStatus(rec)).not.toContain('stats write failed')
  })
})

describe('an expired cache clicked while keepalive is off: the hint press path', () => {
  test('a hint press turns keepalive on, paused: the line says so, the status line stays quiet, no fork is sent, and no toast', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('to rebuild')
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain('~19k tokens to rebuild')
    expect(lastStatus(rec)).toBeUndefined()
    expect(rec.toasts).toEqual([])
    expect(rec.forks).toEqual([])
    await m.unmount()
  })
})


// The main thread of `cached()`, its reply naming the model and speed that answered.
const opusCached = () => ({
  text: lines([
    user({ uuid: 'u1', parent: null, ts: iso(T0) }),
    assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, model: 'claude-opus-5-5', speed: 'standard' }),
  ]),
})

// The shared price record a session finds in the store, with Opus 5.5's read price and write rates doubled from the built-in
// table's, so a figure priced from it is distinguishable from one priced at the built-in table.
const storedPrices = () => ({
  models: {
    'claude-opus-5-5': {
      rates: { input: 4e-6, read: 0.4e-6, write5m: 10e-6, write1h: 16e-6, above: null },
      changedMs: null,
      missingSinceMs: null,
    },
  },
  lastSuccessMs: T0,
  lastChangeMs: null,
  attempt: { stampMs: T0, outcome: 'success', failures: 0, previous: null },
})

// The warm refresh price and the cold rebuild price, side by side on every surface that states a refresh price.
describe('the pair: keeping the cache warm against rebuilding it if it goes cold', () => {
  const opts = { options: { keepalive_lead_s: 15, keepalive_count: 3 } }
  const WARM = 'keep warm $0.004/refresh · if cold ~$0.09 rebuild'
  const started = async ($: any, on: any, doc: any, now = T0, advance = 1000) => {
    kaWorld(on, doc)
    const clock = mock.clock(on, { now })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(advance)
    return clock
  }

  test('a warm cache hovers the pair with keepalive off, and the stored offer holds the same label', opts, async ($, on) => {
    await started($, on, opusCached())
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain(WARM)
    await m.unmount()
  })

  test('a warm cache hovers the pair while keepalive refreshes, in the stored cost too', opts, async ($, on) => {
    let latest: any
    kaWorld(on, opusCached())
    on('state.set', async (_$: any, e: any, next: any) => {
      if (e.plugin === 'cachier' && e.key === 'hint') latest = e.value
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain(WARM)
    expect(latest.cost).toEqual({ label: WARM })
    expect(latest.offer).toEqual({ label: WARM })
    await m.unmount()
  })

  test('the hover, the section, the enable text and the footer quote one warm figure and one rebuild figure', opts, async ($, on) => {
    const clock = await started($, on, opusCached())
    const enabled = await toggle($, 'on 15 3')
    expect(enabled).toContain('A refresh reads the warm cache: $0.004 (~19k cached), every 4:45')
    expect(enabled).toContain('if it goes cold, your next prompt rebuilds it: ~$0.09 (~19k written)')
    const section = (await toggle($, '')).replace(/\n\s*/g, ' ')
    expect(section).toContain('refresh $0.004 (~19k cached) · every 4:45 if cold: rebuild ~$0.09 (~19k written) next in')
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain(WARM)
    await toggle($, 'off')
    await clock.advance(310000)
    expect(JSON.stringify(await m.drawn())).toContain('~$0.09 to rebuild')
    await m.unmount()
  })

  test('in tokens, no dollar figure appears in the pair', { options: { keepalive_lead_s: 15, keepalive_count: 3, cost_unit: 'tokens' } }, async ($, on) => {
    await started($, on, opusCached())
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh · if cold ~19k tokens rebuild')
    const text = await toggle($, 'on 15 3')
    expect(text).toContain('if it goes cold, your next prompt rebuilds it: ~19k written')
    expect(text).not.toContain('$')
    await m.unmount()
  })

  test('a model with no price states the pair in tokens', opts, async ($, on) => {
    const fable = {
      text: lines([
        user({ uuid: 'u1', parent: null, ts: iso(T0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, model: 'claude-nonesuch-1', speed: 'standard' }),
      ]),
    }
    await started($, on, fable)
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh · if cold ~19k tokens rebuild')
    expect(await toggle($, 'on 15 3')).toContain('if it goes cold, your next prompt rebuilds it: ~19k written')
    await m.unmount()
  })

  test('a price below half a tenth of a cent reads <$0.001, and the rebuild takes no tilde', opts, async ($, on) => {
    const tiny = {
      text: lines([
        user({ uuid: 'u1', parent: null, ts: iso(T0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 10, tags: { five: 10, one: 0 }, model: 'claude-opus-5-5', speed: 'standard' }),
      ]),
    }
    await started($, on, tiny)
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm <$0.001/refresh · if cold <$0.001 rebuild')
    await m.unmount()
  })

  test('an expired cache hovers and states the refresh alone, as before', opts, async ($, on) => {
    const clock = await started($, on, opusCached(), T0 + 400000)
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('$0.004/refresh')
    await pressPie($)
    await clock.advance(1000)
    const drawn = JSON.stringify(await m.drawn()) + (await drawnPane($))
    expect(drawn).toContain('$0.004/refresh')
    expect(drawn).not.toMatch(/keep warm|if cold:|cached\) · every/)
    expect(drawn).toContain('refresh $0.004 (~19k cached)')
    expect(drawn).toContain('every 4:45')
    await m.unmount()
  })

  test('/keepalive on over an expired cache answers as before', opts, async ($, on) => {
    await started($, on, opusCached(), T0 + 400000)
    expect(await toggle($, 'on 15 3')).toBe(
      'keepalive on: lead 15 s, 3 refreshes. Each refresh costs $0.004 (reads ~19k cached). Paused: the cache expired; it resumes after your next prompt.',
    )
  })

  test('/keepalive on at a lead at the TTL over an expired cache states the head and the lead sentence alone', { options: { keepalive_lead_s: 300 } }, async ($, on) => {
    await started($, on, opusCached(), T0 + 400000)
    expect(await toggle($, 'on 300')).toBe('keepalive on: lead 300 s, 24 refreshes. Paused: lead 300s ≥ 300s TTL.')
  })

  test('a lead at the TTL on a warm cache offers no refresh: with keepalive off the hover states the rebuild alone, with it on nothing, and the section the rebuild line alone', { options: { keepalive_lead_s: 300 } }, async ($, on) => {
    await started($, on, opusCached())
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('if cold ~$0.09 rebuild')
    expect(JSON.stringify(await m.drawn())).not.toContain('keep warm')
    const off = await toggle($, '')
    expect(off).not.toMatch(/(^|\s)(refresh [$~]|if cold:|every \d)/)
    expect(off).toContain('pie: amber ≤¼ TTL left, red ≤⅒')
    expect(await toggle($, 'on 300')).toBe(
      'keepalive on: lead 300 s, 24 refreshes. Paused: lead 300s ≥ 300s TTL. If it goes cold, your next prompt rebuilds it: ~$0.09 (~19k written).',
    )
    const section = (await toggle($, '')).replace(/\n\s*/g, ' ')
    expect(section).toContain('lead 300s ≥ 300s TTL')
    expect(section).toContain('if cold: rebuild ~$0.09 (~19k written)')
    expect(section).not.toMatch(/ refresh [$~]| next refresh /)
    await m.unmount()
  })

  test('with keepalive off and a learned count of 0, the hover states the rebuild alone; stored, cost is null and offer holds the label; keepalive on says nothing', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    let latest: any
    on('state.set', async (_$: any, e: any, next: any) => {
      if (e.plugin === 'cachier' && e.key === 'hint') latest = e.value
      return next(e)
    })
    const clock = await started($, on, { ...opusCached(), store: LONG_PAUSES })
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('if cold ~$0.09 rebuild')
    expect(JSON.stringify(await m.drawn())).not.toContain('keep warm')
    expect(latest.cost).toBeNull()
    expect(latest.offer).toEqual({ label: 'if cold ~$0.09 rebuild' })
    const learned0 = await toggle($, '')
    expect(learned0).not.toMatch(/(^|\s)(refresh [$~]|if cold:|every \d)/)
    expect(learned0).toContain('pie: amber ≤¼ TTL left, red ≤⅒')
    await toggle($, 'on 60')
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).not.toMatch(/keep warm|if cold/)
    await m.unmount()
  })

  test('under a cold mark, no refresh price and no rebuild price is stated, and the Cache section states the rebuild as before', opts, async ($, on) => {
    const clock = await started($, on, opusCached())
    await toggle($, 'on 15 3')
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).not.toMatch(/keep warm|if cold/)
    const text = (await toggle($, '')).replace(/\n\s*/g, ' ')
    expect(text).not.toMatch(/ refresh [$~]| if cold:| every \d/)
    expect(text).toContain('Cache ○ reset · rebuild')
    await m.unmount()
  })

  test('under a recorded cold mark at a lead at or above the TTL, the Keepalive section adds no rebuild price and the Cache section states the rebuild as before', { options: { keepalive_lead_s: 300, keepalive_count: 3 } }, async ($, on) => {
    const clock = await started($, on, opusCached())
    await toggle($, 'on 300 3')
    await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    const text = (await toggle($, '')).replace(/\n\s*/g, ' ')
    expect(text).toContain('Keepalive  on, no count')
    expect(text).not.toMatch(/ refresh [$~]| if cold:| every \d/)
    expect(text).toMatch(/Cache ○ reset · rebuild ~\$[\d.]+/)
  })
})

describe('the cost unit: dollars at list prices, or tokens, switched by /keepalive unit', () => {
  test("a refresh on a priced model is shown in dollars", { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    const running = JSON.stringify(await m.drawn()) + (await drawnPane($))
    // 18559 tokens read at $0.20 per million.
    expect(running).toContain('keep warm $0.004/refresh')
    expect(running).toContain('refresh $0.004 (~19k cached)')
    expect(running).not.toContain('in tokens:')
    await m.unmount()
  })

  test('the pricing page is read once, and its rows replace the built-in ones', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    // The page doubles Opus 5.5's read price to $0.40: a ping of 18559 tokens costs $0.007, not $0.004.
    const rec = kaWorld(on, { ...opusCached(), pricing: PRICING_PAGE.replace('$0.20 / MTok', '$0.40 / MTok') })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(rec.fetches).toEqual(['https://platform.claude.com/docs/en/about-claude/pricing.md'])
    expect(JSON.stringify(await m.drawn())).toContain('keep warm $0.007/refresh')
    await m.unmount()
  })

  test('a page that fails leaves the built-in prices in force, logs why, and a switch to dollars reads it again', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const doc: any = { ...opusCached(), pricing: 'oops', pricingStatus: 500 }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(rec.fetches.length).toBe(1)
    expect(rec.logs.join('\n')).toContain('the pricing page answered 500')
    expect(JSON.stringify(await m.drawn())).toContain('keep warm $0.004/refresh')
    await m.unmount()
  })

  test('/keepalive unit switches every figure on the line and the pane to the unit it names, and back',{ options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    const before = await toggle($, '')
    expect(JSON.stringify(await m.drawn())).toContain('keep warm $0.004/refresh')
    expect(await toggle($, 'unit tokens')).toBe('figures show in tokens for this session.')
    const tokens = JSON.stringify(await m.drawn()) + (await drawnPane($))
    expect(tokens).toContain('keep warm ~19k read/refresh')
    expect(await toggle($, '')).toContain('5m write ≈ 25 reads (claude-opus-5-5)')
    expect(tokens).not.toContain('$0.004/refresh')
    expect(await toggle($, '')).toContain('refresh ~19k cached')
    expect(await toggle($, 'unit dollars')).toBe('figures show in dollars for this session.')
    expect(JSON.stringify(await m.drawn())).toContain('keep warm $0.004/refresh')
    // Back in dollars, keepalive reads as it did before the switch: the unit is all that moved.
    expect(before).toContain('unit: dollars (cost_unit)')
    expect(await toggle($, '')).toBe(before.replace('unit: dollars (cost_unit)', 'unit: dollars (switched this session)'))
    await m.unmount()
  })

  test('/keepalive unit dollars after a failed price read reads the page again',{ options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const doc: any = { ...opusCached(), pricing: 'oops', pricingStatus: 500 }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(rec.fetches.length).toBe(1)
    // The page answers again; a switch to tokens reads nothing, the switch to dollars reads it once, and a later one does not read it again.
    doc.pricing = PRICING_PAGE.replace('$0.20 / MTok', '$0.40 / MTok')
    doc.pricingStatus = 200
    expect(await toggle($, 'unit tokens')).toBe('figures show in tokens for this session.')
    expect(rec.fetches.length).toBe(1)
    expect(await toggle($, 'unit dollars')).toBe('figures show in dollars for this session.')
    expect(rec.fetches.length).toBe(2)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm $0.007/refresh')
    expect(await toggle($, 'unit dollars')).toBe('figures show in dollars for this session.')
    expect(rec.fetches.length).toBe(2)
    await m.unmount()
  })

  describe('the price cue: a read running, landed or failed, after the footer words', () => {
    const tokensToDollars = async ($: any, on: any, extra: Record<string, unknown> = {}) => {
      let release: () => void = () => {}
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      // A fresh stored record: no scheduled read runs, so only the switch reads.
      const doc: any = { ...opusCached(), store: { prices: storedPrices() }, pricingHold: hold, ...extra }
      const rec = kaWorld(on, doc)
      const clock = mock.clock(on, { now: T0 })
      await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
      await clock.advance(1000)
      await toggle($, 'unit tokens')
      return { rec, clock, doc, release }
    }
    const opts = { options: { keepalive_lead_s: 15, keepalive_count: 3 } }
    // Each write to the cue's state, in order, from a hook on the state: the cue it leaves is the last one written, or null before any.
    const watchCue = (on: any): unknown[] => {
      const writes: unknown[] = []
      on('state.set', (_$: any, e: any, next: any) => {
        if (e.plugin === 'cachier' && e.key === 'cue') writes.push(e.value)
        return next(e)
      })
      return writes
    }
    const cueStanding = (writes: unknown[]) => writes[writes.length - 1] ?? null

    test('while a read from /keepalive unit dollars runs, a dim glyph follows the words; once it lands a check mark does, and 3 seconds later it is gone', opts, async ($, on) => {
      const { rec, clock, release } = await tokensToDollars($, on)
      const m = await mountHint($)
      expect(JSON.stringify(await m.drawn())).not.toMatch(/[⟳✓!]/)
      const switching = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(rec.fetches.length).toBe(1)
      const running = JSON.stringify(await m.drawn())
      expect(running).toContain('⟳')
      expect(running).not.toContain('✓')
      // The footer's words stay dim and clickable beside the cue.
      expect(await m.find({ type: 'Button', key: 'details' })).toBeTruthy()
      release()
      await switching
      await clock.advance(10)
      const landed = JSON.stringify(await m.drawn())
      expect(landed).toContain('✓')
      expect(landed).not.toContain('⟳')
      await clock.advance(2500)
      expect(JSON.stringify(await m.drawn())).toContain('✓')
      await clock.advance(600)
      expect(JSON.stringify(await m.drawn())).not.toMatch(/[⟳✓]/)
      expect(rec.toasts).toEqual([])
      await m.unmount()
    })

    test('a failed read shows an amber mark and no check mark, then clears', opts, async ($, on) => {
      const { clock, release } = await tokensToDollars($, on, { pricing: 'oops', pricingStatus: 500 })
      const m = await mountHint($)
      const switching = toggle($, 'unit dollars')
      release()
      await switching
      await clock.advance(10)
      const failed = JSON.stringify(await m.drawn())
      expect(failed).toContain('"color":"warning"')
      expect(failed).toContain(' !')
      expect(failed).not.toContain('✓')
      await clock.advance(3100)
      const after = JSON.stringify(await m.drawn())
      expect(after).not.toContain(' !')
      await m.unmount()
    })

    test('a new read while a check mark shows replaces it with the running glyph', opts, async ($, on) => {
      const { rec, clock, doc, release } = await tokensToDollars($, on)
      const m = await mountHint($)
      release()
      await toggle($, 'unit dollars')
      await clock.advance(10)
      expect(JSON.stringify(await m.drawn())).toContain('✓')
      let release2: () => void = () => {}
      doc.pricingHold = new Promise<void>((resolve) => {
        release2 = resolve
      })
      await toggle($, 'unit tokens')
      const again = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(rec.fetches.length).toBe(2)
      const running = JSON.stringify(await m.drawn())
      expect(running).toContain('⟳')
      expect(running).not.toContain('✓')
      release2()
      await again
      await m.unmount()
    })

    test('on a reset cache the cue follows the reset word', opts, async ($, on) => {
      const { clock, release } = await tokensToDollars($, on)
      await $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: false, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
      await clock.advance(1000)
      const m = await mountHint($)
      expect(await hintOf(m)).toBe('reset')
      const switching = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(JSON.stringify(await m.drawn())).toContain('⟳')
      release()
      await switching
      await m.unmount()
    })

    test('with no footer drawn there is no cue', async ($, on) => {
      // Keepalive off and nothing to count: the footer draws nothing, and a read draws no cue.
      const { clock, release } = await tokensToDollars($, on, { text: '' })
      const m = await mountHint($)
      const switching = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(JSON.stringify(await m.drawn())).not.toMatch(/[⟳✓!]/)
      release()
      await switching
      await m.unmount()
    })

    test('a reload during a check mark leaves no cue standing', opts, async ($, on) => {
      const { clock, release } = await tokensToDollars($, on)
      const m = await mountHint($)
      release()
      await toggle($, 'unit dollars')
      await clock.advance(10)
      expect(JSON.stringify(await m.drawn())).toContain('✓')
      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
      await clock.advance(10)
      expect(JSON.stringify(await m.drawn())).not.toContain('✓')
      await m.unmount()
    })

    test('a session end during a check mark clears the cue and its timer', opts, async ($, on) => {
      const { clock, release } = await tokensToDollars($, on)
      release()
      await toggle($, 'unit dollars')
      await clock.advance(10)
      const m = await mountHint($)
      expect(JSON.stringify(await m.drawn())).toContain('✓')
      await $.session.end({ reason: 'exit', sessionId: 's' } as any)
      await m.unmount()
      // The next start redraws the footer well inside the 3 seconds; the cue is not on it.
      await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
      await clock.advance(1000)
      const again = await mountHint($)
      expect(JSON.stringify(await again.drawn())).not.toContain('✓')
      await again.unmount()
    })

    test('a read still in flight when the session ends leaves no cue and arms no timer', opts, async ($, on) => {
      const writes = watchCue(on)
      const { rec, clock, release } = await tokensToDollars($, on)
      const switching = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(rec.fetches.length).toBe(1)
      expect(cueStanding(writes)).toBe('reading')
      await $.session.end({ reason: 'exit', sessionId: 's' } as any)
      expect(cueStanding(writes)).toBe(null)
      const writesAtEnd = writes.length
      // The page answers after the session has ended: the read's end writes no cue and arms no timer.
      release()
      await switching
      await clock.advance(10)
      expect(cueStanding(writes)).toBe(null)
      await clock.advance(3500)
      expect(writes.slice(writesAtEnd)).toEqual([])
    })

    test('a session end whose hint write throws still clears a standing reading cue', opts, async ($, on) => {
      const writes = watchCue(on)
      let refuseHint = false
      on('state.set', { plugin: 'cachier', key: 'hint' }, (_$: any, e: any, next: any) => (refuseHint ? { deny: 'hint refused' } : next(e)))
      const { rec, clock, release } = await tokensToDollars($, on)
      const switching = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(cueStanding(writes)).toBe('reading')
      // The end's hint write throws; the cue the read left standing must still be cleared by the steps after it.
      refuseHint = true
      await $.session.end({ reason: 'exit', sessionId: 's' } as any)
      refuseHint = false
      expect(rec.logs.filter((l: string) => l.includes('hint refused')).length).toBe(1)
      expect(cueStanding(writes)).toBe(null)
      release()
      await switching
      await clock.advance(10)
      expect(cueStanding(writes)).toBe(null)
    })

    test('after a new session start, a read shows its cue again', opts, async ($, on) => {
      const writes = watchCue(on)
      const { clock, doc } = await tokensToDollars($, on)
      await $.session.end({ reason: 'exit', sessionId: 's' } as any)
      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
      // The page is held again, so the read is seen running before it lands.
      let release: () => void = () => {}
      doc.pricingHold = new Promise<void>((resolve) => {
        release = resolve
      })
      await toggle($, 'unit tokens')
      const reading = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(cueStanding(writes)).toBe('reading')
      release()
      await reading
      await clock.advance(10)
      expect(cueStanding(writes)).toBe('landed')
    })

    test('after a /clear, a read in the new conversation shows its cue', opts, async ($, on) => {
      const writes = watchCue(on)
      const { clock, doc } = await tokensToDollars($, on)
      // A /clear ends the conversation and starts the new one with classic.SessionStart; no session.start fires for it.
      await $.session.end({ reason: 'clear', sessionId: 's' } as any)
      await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
      let release: () => void = () => {}
      doc.pricingHold = new Promise<void>((resolve) => {
        release = resolve
      })
      await toggle($, 'unit tokens')
      const reading = toggle($, 'unit dollars')
      await clock.advance(10)
      expect(cueStanding(writes)).toBe('reading')
      release()
      await reading
      await clock.advance(10)
      expect(cueStanding(writes)).toBe('landed')
    })

    test('the pie and the words stay pressable while a cue shows', opts, async ($, on) => {
      const { rec, clock, release } = await tokensToDollars($, on)
      const switching = toggle($, 'unit dollars')
      await clock.advance(10)
      const m = await mountHint($)
      expect(JSON.stringify(await m.drawn())).toContain('⟳')
      await m.press({ key: 'details' })
      expect(rec.opens.map((o: any) => o.id)).toEqual([PANE_ID])
      await m.press({ key: 'pie' })
      expect(await toggle($, '')).toContain('Keepalive  on')
      release()
      await switching
      await m.unmount()
    })
  })

  test('a bad /keepalive unit argument answers the usage and changes nothing', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    const before = await toggle($, '')
    const fetches = rec.fetches.length
    for (const bad of ['unit euros', 'unit', 'unit tokens extra']) expect(await toggle($, bad)).toMatch(/^usage: /)
    expect(await toggle($, '')).toBe(before)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm $0.004/refresh')
    expect(rec.fetches.length).toBe(fetches)
    await m.unmount()
  })

  test('the cost_unit option starts a session in tokens', { options: { keepalive_lead_s: 15, keepalive_count: 3, cost_unit: 'tokens' } }, async ($, on) => {
    kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain('keep warm ~19k read/refresh')
    expect(JSON.stringify(await m.drawn())).not.toContain('$0.004/refresh')
    await m.unmount()
  })

  test('a model the price table lacks leaves dollars unpriced, and the pane says why', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const fable = {
      text: lines([
        user({ uuid: 'u1', parent: null, ts: iso(T0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, model: 'claude-nonesuch-1', speed: 'standard' }),
      ]),
    }
    kaWorld(on, fable)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await pressPie($)
    await clock.advance(1000)
    const drawn = JSON.stringify(await m.drawn()) + (await drawnPane($))
    expect(drawn).toContain('keep warm ~19k read/refresh')
    // The reason is a row of its own in the Advice section.
    expect(sectionLines(await commandText($, ''), 'Advice')).toContain('in tokens: no price for claude-nonesuch-1')
    await m.unmount()
  })

  test('a stored price record prices the first fold after a reload, without reading the page', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    // The state an earlier load left: the stats counted the first reply, and a cursor stops the first pass at it.
    const stats = { ...INITIAL_STATS, transcript: PATH, cursor: 'm1', lastAtMs: T0, lastTotal: 18559, lastTtlMs: 300000 }
    const doc = {
      text: lines([
        user({ uuid: 'u1', parent: null, ts: iso(T0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1', model: 'claude-opus-5-5', speed: 'standard' }),
        assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' }),
      ]),
      store: { prices: storedPrices() },
    }
    const rec = kaWorld(on, doc)
    on('state.get', async (_$: any, e: any, next: any) => {
      const got = await next(e)
      return e.plugin === 'cachier' && e.key === 'stats' && got.value?.value === undefined ? { value: { ...got.value, value: stats } } : got
    })
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(rec.fetches).toEqual([])
    // The fold's write is priced at the stored $10 per million, not the built-in $5: 20,000 tokens cost $0.20.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain('misses: 1 (lapse 1) · $0.20 rewritten')
  })

  test('an unreadable price record prices the first fold at the built-in table and logs why', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const stats = { ...INITIAL_STATS, transcript: PATH, cursor: 'm1', lastAtMs: T0, lastTotal: 18559, lastTtlMs: 300000 }
    const doc = {
      text: lines([
        user({ uuid: 'u1', parent: null, ts: iso(T0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1', model: 'claude-opus-5-5', speed: 'standard' }),
        assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' }),
      ]),
      getDenied: new Set(['prices']),
    }
    const rec = kaWorld(on, doc)
    on('state.get', async (_$: any, e: any, next: any) => {
      const got = await next(e)
      return e.plugin === 'cachier' && e.key === 'stats' && got.value?.value === undefined ? { value: { ...got.value, value: stats } } : got
    })
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(rec.fetches).toEqual([])
    expect(rec.logs.join('\n')).toContain('read refused')
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain('misses: 1 (lapse 1) · $0.10 rewritten')
  })
})

describe("restoreState: a reload's session.start, over the state an earlier version left", () => {
  // The state 0.3.0 left, with no shape stamped: a hint with no marker, tallies and stats of its own shapes, keepalive on mid-turn.
  test('under a new shape every value but the transcript, keepalive and the unit starts over, keepalive keeps what fits, and the transcript is handed back', async () => {
    const values = new Map<string, unknown>([
      ['transcript', '/t.jsonl'],
      ['hint', { words: '4:41', cost: null, stats: [], armed: false, unit: 'dollars', notes: [] }],
      ['tally', { pause: { pings: 1, tokens: 19000 }, session: { pings: 3, tokens: 57000 }, raisedMs: null, epoch: 4 }],
      ['stats', { transcript: '/t.jsonl', cursor: 'a9' }],
      ['view', { kind: 'known', touchMs: 1, ttlMs: 300000, ttlLabel: '5m', promptTokens: 19000, outputTokens: 0 }],
      ['keepalive', { config: { leadMs: 15000, count: 3 }, remaining: 3, stop: null, last: null, disclosed: true, seq: 2, active: true, gap: false, coldPending: false, lastTurn: 't3', generation: 7, lastUsed: null, pauseEpoch: 4 }],
      ['touch', 123],
      ['cold', { reason: 'cleared', atMs: 100 }],
      ['unit', 'tokens'],
    ])
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
    } as any
    expect(await restoreState(fake)).toBe('/t.jsonl')
    expect(values.get('hint')).toBeNull()
    expect(values.get('view')).toEqual({ kind: 'no-cache' })
    expect(values.get('judged')).toEqual({ netUsd: 0, pauses: 0 })
    expect(values.get('tally')).toMatchObject({ pause: { pings: 0, spend: { usd: 0 } }, session: { pings: 0 }, epoch: 4 })
    expect(values.get('stats')).toMatchObject({ transcript: null, cursor: null })
    expect(values.get('keepalive')).toMatchObject({ config: { leadMs: 15000, count: 3 }, active: true, gap: false, lastTurn: 't3', generation: 8 })
    expect(values.get('shape')).toBe(STATE_SHAPE)
    // The rest starts over too: no live touch or cold mark,. The unit pressed stays.
    expect([values.get('touch'), values.get('cold'), values.get('unit')]).toEqual([null, null, 'tokens'])
  })

  test('a keepalive on under shape 11 is still on after a reload onto this shape, with its lead, count and the lead last used; the removed fields drop', async () => {
    const values = new Map<string, unknown>([
      ['shape', 11],
      ['transcript', '/t.jsonl'],
      ['keepalive', { config: { leadMs: 60000, count: 2 }, remaining: 1, stop: null, last: null, disclosed: true, stated: true, seq: 3, active: false, gap: true, coldPending: false, lastTurn: 't7', generation: 9, lastUsed: { leadMs: 60000, count: 2 }, pauseEpoch: 1, runCount: 2, runId: 4 }],
    ])
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
    } as any
    await restoreState(fake)
    expect(values.get('keepalive')).toMatchObject({ config: { leadMs: 60000, count: 2 }, remaining: 1, runCount: 2, lastUsed: { leadMs: 60000, count: 2 }, active: false, gap: true })
    expect(values.get('keepalive')).not.toHaveProperty('disclosed')
    expect(values.get('keepalive')).not.toHaveProperty('runId')
  })

  test('a reload under the same shape keeps the counts and the hint; keepalive still moves its generation on', async () => {
    const tally = { pause: { pings: 1, spend: { input: 0, read: 19000, write5m: 0, write1h: 0, usd: 0.004, why: null } }, session: { pings: 3, spend: { input: 0, read: 57000, write5m: 0, write1h: 0, usd: 0.011, why: null } }, raisedMs: null, epoch: 4 }
    const stats = { transcript: '/t.jsonl', cursor: 'a9' }
    const judged = { netUsd: 0.42, pauses: 3 }
    const hint = { words: '4:41', cost: null, stats: [], armed: false, unit: 'dollars', notes: [], marker: { verdict: 'par', line: '' }, session: { verdict: 'par', line: '' }, breakEven: '' }
    const view = { kind: 'known', touchMs: 1, ttlMs: 300000, ttlLabel: '5m', promptTokens: 19000, outputTokens: 0, model: null, speed: null }
    const values = new Map<string, unknown>([
      ['shape', STATE_SHAPE],
      ['transcript', '/t.jsonl'],
      ['tally', tally],
      ['stats', stats],
      ['judged', judged],
      ['hint', hint],
      ['view', view],
      ['keepalive', { ...INITIAL_KEEPALIVE, config: { leadMs: 15000, count: 3 }, generation: 7 }],
      ['touch', 123],
      ['cold', { reason: 'cleared', atMs: 100 }],
      ['unit', 'tokens'],
    ])
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
    } as any
    expect(await restoreState(fake)).toBe('/t.jsonl')
    expect([values.get('tally'), values.get('stats'), values.get('judged'), values.get('hint'), values.get('view')]).toEqual([tally, stats, judged, hint, view])
    expect([values.get('touch'), values.get('cold'), values.get('unit')]).toEqual([123, { reason: 'cleared', atMs: 100 }, 'tokens'])
    expect(values.get('keepalive')).toMatchObject({ config: { leadMs: 15000, count: 3 }, generation: 8 })
  })

  // A reload's module holds no path, so the path restoreState hands back is learned again: the live touch and cold mark the state
  // kept for that same transcript stay, and keepalive goes on counting from them.
  test('learning again the transcript the state already names keeps its live touch and cold mark', async () => {
    const path = '/reload/same.jsonl'
    const values = new Map<string, unknown>([
      ['transcript', path],
      ['touch', 123],
      ['cold', { reason: 'cleared', atMs: 100 }],
      ['stats', { transcript: path, cursor: 'a9' }],
    ])
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
      ui: { log: () => {}, status: () => {}, invalidate: () => {} },
    } as any
    await learnTranscript(fake, path)
    expect([values.get('touch'), values.get('cold')]).toEqual([123, { reason: 'cleared', atMs: 100 }])
    expect(values.get('stats')).toMatchObject({ transcript: path, cursor: 'a9' })
  })

  test('learning a transcript other than the one the state names forgets the old live touch and cold mark', async () => {
    const values = new Map<string, unknown>([
      ['transcript', '/reload/old.jsonl'],
      ['touch', 123],
      ['cold', { reason: 'cleared', atMs: 100 }],
    ])
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
      ui: { log: () => {}, status: () => {}, invalidate: () => {} },
    } as any
    await learnTranscript(fake, '/reload/new.jsonl')
    expect([values.get('transcript'), values.get('touch'), values.get('cold')]).toEqual(['/reload/new.jsonl', null, null])
  })

  test('in a new session there is no transcript to hand back, and the defaults are written', async () => {
    const values = new Map<string, unknown>()
    const fake = {
      state: {
        get: async (k: { key: string }) => ({ value: values.get(k.key), version: 1 }),
        set: async (k: { key: string }, value: unknown) => {
          values.set(k.key, value)
          return { isSet: true }
        },
      },
    } as any
    expect(await restoreState(fake)).toBeNull()
    expect(values.get('keepalive')).toMatchObject({ config: null, generation: 1 })
    expect(values.get('shape')).toBe(STATE_SHAPE)
    // No press, no unit: the option decides it on every load.
    expect(values.has('unit')).toBe(false)
  })
})

describe('unitFrom: the unit pressed, or the option\'s', () => {
  test('a pressed unit wins over the option', () => {
    expect(unitFrom('tokens', 'dollars')).toBe('tokens')
    expect(unitFrom('dollars', 'tokens')).toBe('dollars')
  })

  test('no press, or a value of another shape an earlier load left, is the option', () => {
    expect(unitFrom(undefined, 'tokens')).toBe('tokens')
    expect(unitFrom('usd', 'tokens')).toBe('tokens')
    expect(unitFrom({ unit: 'dollars' }, 'tokens')).toBe('tokens')
  })
})

describe('the default mode: the one a session starts in, set by /keepalive default and nothing else', () => {
  const DEFAULT_ON = { options: { keepalive_lead_s: 60, keepalive_default: 'on' } }

  test('with the default on, a session starts on and refreshes when due, with no toast', DEFAULT_ON, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toMatch(/Keepalive {2}on, refreshing/)
    await mainStep($)
    await turnEnd($)
    const m = await mountHint($)
    await clock.advance(1000)
    await clock.advance(239000)
    expect(rec.forks.length).toBe(1)
    expect(rec.toasts).toEqual([])
    await m.unmount()
  })

  test('with the default on, the first tick that knows the cost shows no toast, and the first refresh is sent when due', DEFAULT_ON, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(rec.toasts).toEqual([])
    expect(rec.forks).toEqual([])
    await clock.advance(300000)
    expect(rec.forks.length).toBe(1)
  })

  test("a session's toggle leaves the default: the next session starts in it again, and a compaction keeps the toggle", DEFAULT_ON, async ($, on) => {
    const sets: unknown[] = []
    on('config.set', (_$: any, e: any) => {
      sets.push(e.key)
      return { value: e.value }
    })
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    expect(await toggle($, 'off')).toBe('keepalive off')
    await $.classic.SessionStart({ source: 'compact', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toMatch(/Keepalive {2}off/)
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toMatch(/Keepalive {2}on, refreshing/)
    expect(sets).toEqual([])
  })

  test('/keepalive default sets the option through /config, leaves this session as it is, and says a refusal', async ($, on) => {
    const sets: [string, unknown][] = []
    on('config.set', (_$: any, e: any) => {
      sets.push([e.key, e.value])
      return e.value === 'off' ? { deny: 'policy' } : { value: e.value }
    })
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toMatch(/start mode: off \(keepalive_default\)/)
    expect(await toggle($, 'default on')).toBe('keepalive default: on. Sessions started from now on start with keepalive on; this one stays as it is.')
    expect(await toggle($, '')).toMatch(/Keepalive {2}off/)
    expect(await toggle($, 'default off')).toBe('keepalive default unchanged: policy')
    expect(sets).toEqual([['cachier.keepalive_default', 'on'], ['cachier.keepalive_default', 'off']])
  })

  test("only the user's own command sets the default on; anyone may set it off", async ($, on) => {
    const sets: unknown[] = []
    on('config.set', (_$: any, e: any) => {
      sets.push(e.value)
      return { value: e.value }
    })
    kaWorld(on, cached())
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    const run = async (args: string) => (await $.command.run({ command: 'keepalive', args, origin: { kind: 'plugin', name: 'other' } } as any)).text
    expect(await run('default on')).toBe("keepalive default stays: only the user's own /keepalive sets it on.")
    expect(await run('default off')).toMatch(/keepalive\ default:\ off\./)
    expect(sets).toEqual(['off'])
  })

  test('a run turned on before the prices are read takes the break-even count once they are, until its first ping', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    expect(await toggle($, 'on 60')).toContain('3 refreshes')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain(' · 24 left')
  })
})

describe('the pause history: each pause a prompt ends, kept in the store under the session', () => {
  const KEY = 'pauses/s1'

  test("a user's prompt after a pause records its start, length, TTL and price ratio, and nothing of the conversation", async ($, on) => {
    const rec = kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    const held = rec.store.get(KEY) as any[]
    // The context the transcript's last reply cached, all of it grown since this is the session's first pause.
    const at = new Date(T0)
    expect(held).toEqual([{ startMs: T0, pausedMs: 10 * MIN, hour: at.getHours(), weekday: at.getDay(), ratio: 24, ttlMs: 300000, contextTokens: 18559, grownTokens: 18559 }])
    expect(JSON.stringify(held)).not.toContain('next')
    // The next pause is appended after it. This transcript does not grow, so it counts from the same last touch.
    await mainStep($)
    await turnEnd($)
    await clock.advance(2 * MIN)
    await userPrompt($)
    expect((rec.store.get(KEY) as any[]).map((r) => r.pausedMs)).toEqual([10 * MIN, 12 * MIN])
  })

  test('with no price the ratio is null; a prompt during a turn, or from a peer, records nothing', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(MIN)
    await userPrompt($)
    expect((rec.store.get(KEY) as any[]).map((r) => r.ratio)).toEqual([null])
    await mainStep($)
    await userPrompt($)
    await turnEnd($)
    await clock.advance(MIN)
    await submit($, 'peer')
    expect((rec.store.get(KEY) as any[]).length).toBe(1)
  })

  test("a session start deletes the keys that hold only pauses older than the history keeps, and leaves this session's own and the shared price record", async ($, on) => {
    const old = { startMs: 1, pausedMs: MIN, hour: 0, weekday: 0, ratio: 24, ttlMs: 300000 }
    const recent = Array.from({ length: 2000 }, (_, i) => ({ ...old, startMs: 1000 + i }))
    const rec = kaWorld(on, { ...cached(), store: { 'pauses/old': [old], 'pauses/recent': recent, prices: storedPrices() } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect([...rec.store.keys()].sort()).toEqual(['pauses/recent', 'prices'])
  })

  test("a pause whose write was refused is the one the next pause's growth counts from, though the key never held it", async ($, on) => {
    const setDenied = new Set([KEY])
    const rec = kaWorld(on, { ...opusCached(), setDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    setDenied.clear()
    await mainStep($)
    await turnEnd($)
    await clock.advance(2 * MIN)
    await userPrompt($)
    // The transcript does not grow, so the second pause grew by none from the first, which only this load held.
    expect((rec.store.get(KEY) as any[]).map((r) => r.grownTokens)).toEqual([0])
  })

  test('a refused delete of a stale key leaves the other stale keys deleted, and the refusals are reported once', async ($, on) => {
    const old = { startMs: 1, pausedMs: MIN, hour: 0, weekday: 0, ratio: 24, ttlMs: 300000 }
    const recent = Array.from({ length: 2000 }, (_, i) => ({ ...old, startMs: 1000 + i }))
    const deleteDenied = new Set(['pauses/old0', 'pauses/old1'])
    const rec = kaWorld(on, { ...cached(), store: { 'pauses/old0': [old], 'pauses/old1': [old], 'pauses/old2': [old], 'pauses/recent': recent, prices: storedPrices() }, deleteDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect([...rec.store.keys()].sort()).toEqual(['pauses/old0', 'pauses/old1', 'pauses/recent', 'prices'])
    expect(rec.logs.filter((l: string) => l.includes('delete refused'))).toHaveLength(1)
  })
})

describe('the pause history: this load\'s pauses and the store agree at quiescence, whatever the reads and writes did', () => {
  const PATH_B = '/home/test/.claude/projects/p/s3.jsonl'
  const pause = (i: number) => ({ startMs: 1000 + i, pausedMs: 10 * MIN, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000, contextTokens: 100000, grownTokens: 1000000 })
  // Each row follows a start on PATH. `prompt` ends a pause; `fail-read` and `refuse-write` hit the held transcript's key until `land-read`
  // and `land-write` clear them. `reload` is a same-path resume, and `learn-b` and `learn-a` switch to the other transcript and back.
  const ROWS: string[][] = [
    ['prompt', 'prompt'],
    ['fail-read', 'prompt', 'land-read', 'prompt'],
    ['refuse-write', 'prompt', 'land-write', 'prompt'],
    ['prompt', 'learn-b', 'prompt', 'learn-a'],
    ['fail-read', 'learn-b', 'prompt', 'learn-a', 'land-read'],
    ['refuse-write', 'learn-b', 'prompt', 'learn-a', 'prompt'],
    ['prompt', 'reload', 'fail-read', 'prompt', 'land-read'],
    ['prompt', 'refuse-write', 'learn-b', 'fail-read', 'prompt', 'land-write', 'learn-a'],
    ['learn-b', 'fail-read', 'land-read', 'prompt', 'reload', 'prompt'],
    ['prompt', 'prompt', 'learn-b', 'prompt', 'prompt', 'learn-a', 'prompt'],
    ['fail-read', 'refuse-write', 'prompt', 'land-read', 'prompt', 'land-write', 'prompt'],
    ['refuse-write', 'prompt', 'learn-b', 'prompt', 'learn-a', 'land-write', 'prompt'],
    ['reload', 'fail-read', 'learn-b', 'land-read', 'refuse-write', 'prompt', 'learn-a', 'prompt'],
    ['prompt', 'fail-read', 'learn-a', 'land-read', 'prompt', 'prompt', 'prompt', 'prompt', 'prompt'],
  ]
  for (const row of ROWS) {
    test(`the sentence prices the store's pauses under the held key plus this load's, and the history likewise, after: ${row.join(', ')}`, async ($, on) => {
      const getDenied = new Set<string>()
      const setDenied = new Set<string>()
      const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 4 }, (_, i) => pause(i)) }, getDenied, setDenied })
      const clock = mock.clock(on, { now: T0 })
      // The pauses this load ended that the store did not take: a read or write refused when they were ended, so they are in memory only.
      const lost = new Map<string, number>()
      let current = PATH
      const learn = async (path: string, source: 'startup' | 'resume') => {
        current = path
        await $.classic.SessionStart({ source, transcript_path: path })
        await clock.advance(1000)
      }
      const step: Record<string, () => Promise<void> | void> = {
        prompt: async () => {
          const key = keyOf(current)
          if (getDenied.has(key) || setDenied.has(key)) lost.set(key, (lost.get(key) ?? 0) + 1)
          await mainStep($)
          await turnEnd($)
          await clock.advance(MIN)
          await userPrompt($)
        },
        'learn-b': () => learn(PATH_B, 'resume'),
        'learn-a': () => learn(PATH, 'resume'),
        reload: () => learn(current, 'resume'),
        'fail-read': () => void getDenied.add(keyOf(current)),
        'land-read': async () => {
          getDenied.clear()
          await clock.advance(1000)
        },
        'refuse-write': () => void setDenied.add(keyOf(current)),
        'land-write': () => void setDenied.clear(),
      }
      await learn(PATH, 'startup')
      for (const op of row) await step[op]!()
      // Quiescence: every read and write lands, and the tick reads the held transcript again if its read is still missing.
      getDenied.clear()
      setDenied.clear()
      await clock.advance(1000)
      const storedOf = (key: string): number => (rec.store.get(key) as unknown[] | undefined)?.length ?? 0
      const lostTotal = [...lost.values()].reduce((a, b) => a + b, 0)
      const own = storedOf(keyOf(current)) + (lost.get(keyOf(current)) ?? 0)
      const all = [...rec.store.keys()].reduce((n, key) => n + storedOf(key), 0) + lostTotal
      const want = own >= 5 ? { n: own, source: 'session' } : all >= 5 ? { n: Math.min(all, 50), source: 'recent' } : null
      const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
      const m = /\((\d+) (pauses this session|recent pauses)/.exec(text)
      const got = m === null ? null : { n: Number(m[1]), source: m[2] === 'recent pauses' ? 'recent' : 'session' }
      expect({ row: row.join(', '), got }).toEqual({ row: row.join(', '), got: want })
    })
  }

  test('a pause whose read fails after a switch back counts its growth from the records the store holds, not from the whole context', async ($, on) => {
    const getDenied = new Set<string>()
    kaWorld(on, { ...opusCached(), getDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    for (let i = 0; i < 5; i++) {
      await mainStep($)
      await turnEnd($)
      await clock.advance(MIN)
      await userPrompt($)
    }
    // The switch and back read the five pauses in, so none is unsaved and the store's records are the newest this load has.
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH_B })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    // The sixth pause's read fails, so it grew from the newest of the five, which the context did not grow past.
    getDenied.add(keyOf(PATH))
    await mainStep($)
    await turnEnd($)
    await clock.advance(MIN)
    await userPrompt($)
    getDenied.clear()
    await clock.advance(1000)
    // Priced by hand, Opus 5.5 (5 m write $5, 1 h write $8, read $0.20 per MTok; context 18,559 tokens). The 5 m TTL expires the pauses of
    // 300 s and 362 s, 24 ratio units each at 18,559 x $0.20 per MTok, $0.0891 each; the 1 h TTL expires none. The first pause's growth is
    // 18,559 tokens: $0.0928 at 5 m, $0.1485 at 1 h. Saving: 0.1781 + 0.0928 - 0.1485 = $0.1225, shown $0.12. Had the sixth grown from the
    // whole context, it would add $0.0928 at 5 m and $0.1485 at 1 h, a net of -$0.0557, and the line would show $0.07.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/other TTL: 1h\/off · would have saved \$0\.12 \(6 priced pauses, all sessions\)/)
  })
})

describe('the learned count: an unpinned run sends what the stored pauses say, a pinned one its own', () => {
  // Ten pauses of three hours: past any count, so no pings would have cost least.
  const LONG = { 'pauses/old': Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 })) }

  test('a history of pauses past any count learns no refreshes: the run sends none, and the pane says why',{ options: { keepalive_lead_s: 60 } }, async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: LONG })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  paused 0 refreshes this pause (learned: pauses rarely outlast TTL) · resumes on next prompt')
    expect(await toggle($, '')).toContain('learned: 0 refreshes · 0/10 pauses within 5:00 TTL')
    await clock.advance(10 * MIN)
    expect(rec.forks).toEqual([])
  })

  test('a pinned count is sent as pinned, and the pane shows no learned line', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: LONG })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain(' · 2 left')
    expect(await drawnHint($)).not.toContain('learned')
    expect(await toggle($, '')).toContain('max 2 refreshes/pause (pinned)')
    await clock.advance(239000)
    expect(rec.forks.length).toBe(1)
  })

  test('after /keepalive off, the pane names the count the next /keepalive on runs: the pinned one, not the learned count', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: LONG })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60 2')
    await toggle($, 'off')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('max 2 refreshes/pause (pinned)')
    expect(await drawnHint($)).not.toContain('learned')
  })

  test('a running run whose learned count moves after its first refresh: Settings names the count it keeps, not a source it did not come from', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    // Nine three-hour pauses and one six-minute one: a five-minute cache learns one refresh from them.
    const doc: any = { ...opusCached(), store: { 'pauses/old': [...Array.from({ length: 9 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 })), { startMs: 2000, pausedMs: 360000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 }] } }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    await clock.advance(239000)
    expect(rec.forks.length).toBe(1)
    // A response on a one-hour cache: the same history learns nothing there, so the live count is break-even, not one.
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 240000), write: 18551, tags: ONE_HOUR, msg: 'm2' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('refreshes/pause: 1 (kept from pause start; recounted next prompt)')
    // The whole row, in the pane and in the answer; the answer wraps the long source and moves the command whole to the row after it.
    const row = 'refreshes/pause: 1 (kept from pause start; recounted next prompt) · /keepalive on <lead_s> <count> or keepalive_count'
    expect(await toggle($, '')).toContain(row)
    expect(await drawnPane($)).toContain(row)
    expect(await commandText($, '')).toContain(['  refreshes/pause: 1 (kept from pause start;', '    recounted next prompt) ·', '    /keepalive on <lead_s> <count> or', '    keepalive_count'].join('\n'))
  })

  test('the count line says the count a pause started with when the learned count now differs from it, as Settings does', { timeoutMs: 60000, options: { keepalive_lead_s: 60, keepalive_count: 1 } }, async ($, on) => {
    // Ten minutes and three hours of pauses learn no refresh on a one-hour cache, but none on a five-minute one: one refresh a pause kept from
    // the one-hour cache is then no longer what the history gives.
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: ONE_HOUR, model: 'claude-opus-5-5', speed: 'standard' })]), store: { 'pauses/old': [{ startMs: 1000, pausedMs: 600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 }, { startMs: 1001, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 }] } }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    for (let i = 0; i < 90 && rec.forks.length === 0; i++) await clock.advance(60000)
    expect(rec.forks.length).toBe(1)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 3600000), write: 18551, tags: FIVE, model: 'claude-opus-5-5', speed: 'standard' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('max 1 refresh/pause (kept from pause start; recounted next prompt)')
    expect(text).toContain('refreshes/pause: 1 (kept from pause start; recounted next prompt)')
  })

  test('the count line says the count a pause started with when it equals break-even and a different learned count now stands', { options: { keepalive_lead_s: 60, keepalive_count: 24 } }, async ($, on) => {
    // On a one-hour cache these pauses learn nothing, so the run sends the break-even count, capped at 24, and keeps it through its first refresh.
    // On a five-minute cache the same pauses learn 2, so the break-even count is no longer what the history gives, though it is still 24.
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: ONE_HOUR, model: 'claude-opus-5-5', speed: 'standard' })]), store: { 'pauses/old': [{ startMs: 1000, pausedMs: 600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 }, { startMs: 1001, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 }, { startMs: 1002, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 }] } }
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    for (let i = 0; i < 90 && rec.forks.length === 0; i++) await clock.advance(60000)
    expect(rec.forks.length).toBe(1)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 3600000), write: 18551, tags: FIVE, model: 'claude-opus-5-5', speed: 'standard' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('max 24 refreshes/pause (kept from pause start; recounted next prompt)')
    expect(text).toContain('refreshes/pause: 24 (kept from pause start; recounted next prompt)')
  })
})

const SEVEN_HOURS = 7 * 60 * MIN
const DAY_MS = 24 * 60 * MIN
// A minute of activity at `startMs`, a pause one prompt ended: a moment on the timeline, whose gaps to the moments beside it are the rests.
const activeAt = (startMs: number) => ({ startMs, pausedMs: MIN, hour: new Date(startMs).getHours(), weekday: new Date(startMs).getDay(), ratio: 24, ttlMs: 300000 })
// The two minutes of activity either side of a rest of 7 hours that starts at `startMs`: one ends as the rest starts, the other starts as it ends.
const restAt = (startMs: number) => [activeAt(startMs - MIN), activeAt(startMs + SEVEN_HOURS)]
// The starts of `count` rests a day apart, the last at `lastMs`. The 17 hours from one rest's end to the next one's start are no rest.
const startsOf = (count: number, lastMs: number): number[] => Array.from({ length: count }, (_, i) => lastMs - (count - 1 - i) * DAY_MS)

describe('the learned rest: the Keepalive section states the daily rest the pauses of every session give', () => {
  const seven = startsOf(7, T0 - DAY_MS)
  const SEVEN = `rest: from ≤${hhmm(T0)} · back ≥${hhmm(T0 + SEVEN_HOURS)} · 7 rests`

  test('6 rests of one habit are 6 of the 7 a window needs: the row counts them, in the answer and in the pane', async ($, on) => {
    await startedWorld($, on, { ...opusCached(), store: { 'pauses/old': startsOf(6, T0 - DAY_MS).flatMap(restAt) } })
    expect(sectionLines(await commandText($, ''), 'Keepalive')).toContain('rest: 6 of 7 seen')
    expect(await drawnPane($)).toContain('rest: 6 of 7 seen')
  })

  test('7 rests of one habit give the window the figures name, from the pauses of two sessions read as one timeline', async ($, on) => {
    // Each night's last pause is one session's and the morning's first another's: neither key holds a gap of 5 hours alone.
    await startedWorld($, on, { ...opusCached(), store: { 'pauses/evenings': seven.map((s) => activeAt(s - MIN)), 'pauses/mornings': seven.map((s) => activeAt(s + SEVEN_HOURS)) } })
    expect(sectionLines(await commandText($, ''), 'Keepalive')).toContain(SEVEN)
    expect(await drawnPane($)).toContain(SEVEN)
  })

  test('the row stands after the break-even row and before the balance row, in the answer and in the pane', async ($, on) => {
    await withMiss($, on)
    const answer = sectionLines(await commandText($, ''), 'Keepalive') ?? []
    const pane = (await paneRows($)).map((row) => row.trim())
    for (const rows of [answer, pane]) {
      const at = (start: string) => rows.findIndex((row) => row.startsWith(start))
      expect(at('pays off if back in ')).toBeGreaterThanOrEqual(0)
      expect(at('rest: ')).toBe(at('pays off if back in ') + 1)
      expect(at('balance vs other setting: ')).toBe(at('rest: ') + 1)
    }
  })

  test('a prompt that ends a pause adds it to the timeline at once: the 6th rest becomes the 7th, and the pane and the answer agree through every draw between', async ($, on) => {
    // Six nights are stored, and the evening of the seventh: its rest ends at T0, where this session's pause begins (the touch of its last response).
    const evening = T0 - SEVEN_HOURS
    const clock = await startedWorld($, on, { ...opusCached(), store: { 'pauses/old': [...startsOf(6, evening - DAY_MS).flatMap(restAt), activeAt(evening - MIN)] } })
    const pane = await mountPane($)
    const seen = 'rest: 6 of 7 seen'
    for (let i = 0; i < 3; i++) {
      expect(flatOf(await rowsOf(pane))).toContain(seen)
      expect(await toggle($, '')).toContain(seen)
      await clock.advance(1000)
    }
    await mainStep($)
    await turnEnd($)
    await clock.advance(MIN)
    await userPrompt($)
    await clock.advance(1000)
    const row = `rest: from ≤${hhmm(evening)} · back ≥${hhmm(T0)} · 7 rests`
    for (let i = 0; i < 3; i++) {
      expect(flatOf(await rowsOf(pane))).toContain(row)
      expect(await toggle($, '')).toContain(row)
      await clock.advance(1000)
    }
    expect(flatOf(await rowsOf(pane))).not.toContain(seen)
    await pane.unmount()
  })

  test('a reload reads the store again: pauses it no longer holds are no longer rests', async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/old': seven.flatMap(restAt) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain(SEVEN)
    rec.store.delete('pauses/old')
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('rest: 0 of 7 seen')
    expect(await drawnPane($)).toContain('rest: 0 of 7 seen')
  })
})

// The rest stop. 14 January 2026 has no change of the clock in any zone, so a time of day reads as it is written wherever the tests run.
const NIGHT = new Date(2026, 0, 14, 3, 0).getTime()
// The session's last request, 30 minutes before 03:00: the idle time the step asks for, reached at 03:00.
const REQ = NIGHT - 30 * MIN
// The idle figure: 30 minutes.
const IDLE = 30 * MIN
// Seven rests of seven hours from 01:00, the last on the 13th: the window from 02:00 to 07:00.
const NIGHTS = { 'pauses/old': startsOf(7, NIGHT - 120 * MIN - DAY_MS).flatMap(restAt) }
// A session that starts with keepalive on, so no prompt or press of the user's is in its past.
const OVERNIGHT_ON = { keepalive_default: 'on', keepalive_lead_s: 60 }
const WINDOW = '02:00–07:00'
const REST_ROW = 'rest: from ≤01:00 · back ≥08:00 · 7 rests'
const OVERNIGHT_ROW = `overnight: ${WINDOW} · after 30m idle`
const RUNNING = 'Keepalive  on, refreshing'
const STOPPED = 'Keepalive  paused overnight · resumes on next prompt'

// The pricing page with a cache hit at $2 per million: a 1 h rewrite ($8) then costs 3 refreshes more than a refresh, so a stop repays it with 3 whole hours of the window left.
// Opus 5.5's own page (PRICING_PAGE) has 39, which no window holds.
const REPAYING_PAGE = PRICING_PAGE.replace('$0.20 / MTok', '$2 / MTok')
// The same with the cache hit at the base input price, $4: a 1 h rewrite then costs 1 refresh more than a refresh, so a stop repays it with a single whole hour of the window left.
const ONE_HOUR_REPAYS_PAGE = PRICING_PAGE.replace('$0.20 / MTok', '$4 / MTok')

// A main thread whose last request was sent at `requestMs` on the given TTL, with the seven nights of rests stored and what else a test stores. The 1 h TTL is priced by REPAYING_PAGE
// unless a test gives another page, so that a stop repays in the tests of the stop.
const nightDoc = (tags: { five: number; one: number }, store: Record<string, unknown> = {}, requestMs = REQ, pricing = tags.one > 0 ? REPAYING_PAGE : PRICING_PAGE, write = 18551): any => ({
  text: lines([
    user({ uuid: 'u1', parent: null, ts: iso(requestMs) }),
    assistant({ uuid: 'a1', parent: 'u1', ts: iso(requestMs), write, tags, model: 'claude-opus-5-5', speed: 'standard' }),
  ]),
  store: { ...NIGHTS, ...store },
  pricing,
})

// The mock clock with a record of the time it was run to, so a test can run it on to an instant a minute at a time.
const timed = (clock: any, startMs: number) => {
  let at = startMs
  const by = async (ms: number) => {
    await clock.advance(ms)
    at += ms
  }
  return {
    now: () => at,
    by,
    to: async (ms: number) => {
      while (at < ms) await by(Math.min(MIN, ms - at))
      await clock.settle()
    },
  }
}

// What the plugin did to the stop and to the session's two keys, in order: `stop` when a write of keepalive's state that landed took it from no overnight stop to the
// overnight stop (a write that carries the stop along, as a turn's or a prompt's edit does, is none), `mark` and `action` for a write of the step mark and of the action
// time that landed (the world tells the doc's `onSet` of each). The engine takes one hook of `state.set` from a test, so this is it: a test that needs a write of its own
// refused, or a draw at one, gives `around`, which answers the write in place of `next`.
type Around = (e: any, next: (e: any) => any) => any
const journalOf = (on: any, doc: any, around?: Around) => {
  const journal: string[] = []
  let standing = false
  on('state.set', async (_$: any, e: any, next: any) => {
    const out = await (around === undefined ? next(e) : around(e, next))
    if (e.key === 'keepalive' && out.value?.isSet === true) {
      const now = e.value?.stop === 'overnight'
      if (now && !standing) journal.push('stop')
      standing = now
    }
    return out
  })
  doc.onSet = (key: string) => {
    if (key === 'overnight/s1') journal.push('mark')
    if (key === 'prompted/s1') journal.push('action')
  }
  return journal
}

// A session started five seconds short of 03:00 on the 1 h TTL, its turn ended a second in (a live request keeps the cache warm for the hour, and the transcript's last
// request is 30 minutes old at 03:00). `around` is a test's own answer to a write of the state, which the engine takes only before the first call of `$` (journalOf).
const nearNight = async ($: any, on: any, doc: any = nightDoc(ONE_HOUR), startMs = NIGHT - 5000, around?: Around) => {
  const rec = kaWorld(on, doc)
  const journal = journalOf(on, doc, around)
  const clk = timed(mock.clock(on, { now: startMs }), startMs)
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clk.by(1000)
  await mainStep($)
  await turnEnd($)
  return { rec, clk, doc, journal }
}

// The 5 m TTL world a second after the last request, run on to a second short of 03:00: refreshes answered through the half hour, the stop not yet taken.
const longNight = async ($: any, on: any, doc: any = nightDoc(FIVE)) => {
  const rec = kaWorld(on, doc)
  const journal = journalOf(on, doc)
  const start = REQ + 1000
  const clk = timed(mock.clock(on, { now: start }), start)
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clk.by(1000)
  await mainStep($)
  await turnEnd($)
  await clk.to(NIGHT - 1000)
  return { rec, clk, doc, journal }
}

// The Keepalive section's lines as the answer states them, and the pane's rows trimmed.
const keepaliveRows = async ($: any): Promise<string[]> => sectionLines(await commandText($, ''), 'Keepalive') ?? []
const paneLines = async ($: any): Promise<string[]> => (await paneRows($)).map((row) => row.trim())
// The rest row and the overnight row as the answer and the pane state them.
const expectRows = async ($: any, rest: string, overnight: string) => {
  for (const rows of [await keepaliveRows($), await paneLines($)]) {
    expect(rows).toContain(rest)
    expect(rows).toContain(overnight)
  }
}

describe("the rest stop: inside the learned window, once a local day, keepalive stops for the user's rest", () => {
  test("inside the window, with refreshes answered since the last request 30 minutes ago and every session idle, one tick commits the overnight stop and then writes the step's time, and no refresh is sent while it holds", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await longNight($, on)
    // Refreshes were answered since the request, and nothing has stopped them yet.
    const sent = rec.forks.length
    expect(sent).toBeGreaterThanOrEqual(6)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(journal).toEqual([])
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    await clk.to(NIGHT + 2000)
    const step = rec.store.get('overnight/s1') as number
    expect(step).toBeGreaterThanOrEqual(NIGHT)
    expect(step).toBeLessThan(NIGHT + 3000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(debugOf(rec, 'cachier overnight')).toEqual([{ time: iso(step), window: WINDOW, idle_ms: step - REQ, newest_prompt: null }])
    expect(await toggle($, '')).toContain(STOPPED)
    expect(await drawnPane($)).toContain('paused overnight · resumes on next prompt')
    expect(lastStatus(rec)).toBeUndefined()
    // The next refresh was due at 03:02, and the cache would have lapsed at 03:03: none is sent.
    await clk.by(10 * MIN)
    expect(rec.forks.length).toBe(sent)
  })

  test("the user's return after the rest ends the stop and keepalive resumes; the rest's pause is counted as one whose refreshes ran out", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, doc } = await longNight($, on)
    await clk.to(NIGHT + 2000)
    expect(await toggle($, '')).toContain(STOPPED)
    const sent = rec.forks.length
    await clk.to(NIGHT + 15 * MIN)
    expect(rec.forks.length).toBe(sent)
    await userPrompt($)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(clk.now()), write: 20000, tags: FIVE, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' })])
    await mainStep($)
    await turnEnd($)
    await clk.by(1000)
    const text = await toggle($, '')
    expect(text).toContain(RUNNING)
    expect(text).not.toContain('overnight · resumes')
    expect(text).toContain('1 wasted, ran out')
    // The next refresh is due four minutes after the reply's request: keepalive resumed.
    await clk.by(5 * MIN)
    expect(rec.forks.length).toBe(sent + 1)
  })

  test('a tick whose stop commit loses its version check writes no mark, and the next tick steps', { options: OVERNIGHT_ON }, async ($, on) => {
    let lost = 0
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR), NIGHT - 5000, (e, next) => {
      if (e.key === 'keepalive' && e.value?.stop === 'overnight' && lost === 0) {
        lost++
        return { value: { isSet: false } }
      }
      return next(e)
    })
    await clk.to(NIGHT)
    expect(lost).toBe(1)
    expect(journal).toEqual([])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    // The pane states the decision the tick is to take again, and the row has no step to report.
    expect(await toggle($, '')).toContain(STOPPED)
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    await clk.by(1000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
    expect(await toggle($, '')).toContain(STOPPED)
    expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(rec.store.get('overnight/s1') as number)}`)
  })

  test('a step mark that cannot be written is reported once, the stop holds, and no second step is taken in that load', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR)
    doc.setDenied = new Set(['overnight/s1'])
    const { rec, clk, journal } = await nearNight($, on, doc)
    await clk.to(NIGHT + 2000)
    const refused = () => rec.logs.filter((l) => l.includes('write refused')).length
    expect(refused()).toBe(1)
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(journal).toContain('stop')
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
    expect(await toggle($, '')).toContain(STOPPED)
    // A start resets keepalive to on with no stop: the mark the load holds in memory ends the day's step, so the held fact stops it again and nothing is stepped or written anew.
    const stops = journal.filter((entry) => entry === 'stop').length
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(3000)
    expect(journal.filter((entry) => entry === 'stop')).toHaveLength(stops + 1)
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
    expect(refused()).toBe(1)
    expect(await toggle($, '')).toContain(STOPPED)
  })

  test('after the step, a keepalive state reset to on with no stop is stopped again by the next tick, with no second step, until a user prompt', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on)
    await clk.to(NIGHT + 2000)
    const step = rec.store.get('overnight/s1')
    expect(journal).toEqual(['stop', 'mark'])
    // A start resets keepalive and starts it on again, with no stop; the tick commits the stop anew.
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(3000)
    expect(journal).toEqual(['stop', 'mark', 'stop'])
    expect(rec.store.get('overnight/s1')).toBe(step)
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
    expect(await toggle($, '')).toContain(STOPPED)
    await clk.by(30 * 1000)
    expect(journal).toEqual(['stop', 'mark', 'stop'])
    await userPrompt($)
    await clk.by(10 * 1000)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(journal).toEqual(['stop', 'mark', 'stop', 'action'])
  })

  const ORIGINS: [name: string, origin: any, ends: boolean][] = [
    ["the user's own prompt", { kind: 'composer' }, true],
    ['a prompt from the phone', { kind: 'bridge' }, true],
    ["a peer's prompt", { kind: 'peer' }, false],
    ["another plugin's prompt", { kind: 'plugin', name: 'other' }, false],
    ['a background task notification', { kind: 'task-notification' }, false],
    ['a scheduled trigger', { kind: 'scheduled-trigger' }, false],
  ]
  for (const [name, origin, ends] of ORIGINS) {
    test(`${name} ${ends ? "clears the stop, so keepalive resumes, and its time is written as the session's action" : 'leaves the stop standing and writes no action time'}`, { options: OVERNIGHT_ON }, async ($, on) => {
      const { rec, clk, journal } = await nearNight($, on)
      await clk.to(NIGHT + 2000)
      const at = clk.now()
      await $.prompt.submit({ text: 'next', origin } as any)
      await clk.by(5000)
      const text = await toggle($, '')
      if (ends) {
        expect(text).toContain(RUNNING)
        expect(text).not.toContain('overnight · resumes')
        expect(rec.store.get('prompted/s1')).toBe(at)
        expect(journal).toEqual(['stop', 'mark', 'action'])
      } else {
        expect(text).toContain(STOPPED)
        expect(rec.store.has('prompted/s1')).toBe(false)
        expect(journal).toEqual(['stop', 'mark'])
      }
    })
  }

  test("another session's prompt inside the figure holds the step, and the store is not scanned again until that prompt's time plus the figure", { options: OVERNIGHT_ON }, async ($, on) => {
    const OTHER = NIGHT - 10 * MIN
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'prompted/other': OTHER }))
    const reads = () => rec.gets.filter((key) => key === 'prompted/other').length
    const loaded = reads()
    // Until every other condition holds, the store is not scanned.
    await clk.to(NIGHT - 1000)
    expect(reads()).toBe(loaded)
    await clk.to(NIGHT + 5000)
    expect(reads()).toBe(loaded + 1)
    expect(journal).toEqual([])
    // The prompt was 15 minutes ago; the fact is held off until it is 30 minutes old, with no scan between.
    await clk.to(OTHER + IDLE - 1000)
    expect(reads()).toBe(loaded + 1)
    expect(journal).toEqual([])
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    await clk.to(OTHER + IDLE + 2000)
    expect(reads()).toBe(loaded + 2)
    expect(journal).toEqual(['stop', 'mark'])
    const step = rec.store.get('overnight/s1') as number
    expect(debugOf(rec, 'cachier overnight')).toEqual([{ time: iso(step), window: WINDOW, idle_ms: step - REQ, newest_prompt: iso(OTHER) }])
  })

  test("the user's /keepalive on after the step leaves keepalive on through the next ten ticks and writes the session's action time", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on)
    await clk.to(NIGHT + 2000)
    const at = clk.now()
    await toggle($, 'on 60 24')
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(at)
    for (let i = 0; i < 10; i++) {
      await clk.by(1000)
      expect(await toggle($, '')).toContain(RUNNING)
    }
    expect(journal).toEqual(['stop', 'mark', 'action'])
  })

  test('a first click on the pie turns keepalive off and writes no action time; a second turns it on, writes the action time, and keepalive stays on through the next ten ticks', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on)
    await clk.to(NIGHT + 2000)
    await pressPie($)
    await clk.by(1000)
    expect(await toggle($, '')).toContain('Keepalive  off')
    expect(rec.store.has('prompted/s1')).toBe(false)
    const at = clk.now()
    await pressPie($)
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(at)
    for (let i = 0; i < 10; i++) {
      await clk.by(1000)
      expect(await toggle($, '')).toContain(RUNNING)
    }
    expect(journal).toEqual(['stop', 'mark', 'action'])
  })

  test("a tick run between the prompt's keepalive edit and its store write does not stop again", { options: OVERNIGHT_ON }, async ($, on) => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const doc = nightDoc(ONE_HOUR)
    doc.setHold = { key: 'prompted/s1', hold }
    const { rec, clk, journal } = await nearNight($, on, doc)
    await clk.to(NIGHT + 2000)
    const at = clk.now()
    await userPrompt($)
    for (let i = 0; i < 10; i++) {
      await clk.by(1000)
      expect(await toggle($, '')).toContain(RUNNING)
    }
    expect(rec.store.has('prompted/s1')).toBe(false)
    expect(journal).toEqual(['stop', 'mark'])
    release()
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(at)
    expect(journal).toEqual(['stop', 'mark', 'action'])
  })

  // Each write in the prompt's branch, made to throw once the prompt is made: an answer to the state's write that reads `failing`, or a denied key.
  type Failing = { on: boolean }
  const BRANCH: [what: string, answer: (failing: Failing) => Around | undefined, arm: (doc: any) => void][] = [
    ['stats', (failing) => (e, next) => (failing.on && e.key === 'stats' ? { value: { isSet: false } } : next(e)), () => {}],
    ['tally', (failing) => (e, next) => (failing.on && e.key === 'tally' ? { deny: 'write refused' } : next(e)), () => {}],
    ['judged', (failing) => (e, next) => (failing.on && e.key === 'judged' ? { deny: 'write refused' } : next(e)), () => {}],
    ['pause history', () => undefined, (doc) => doc.setDenied.add('pauses/s1')],
  ]
  for (const [what, answer, arm] of BRANCH) {
    test(`a ${what} write that throws in the prompt's branch leaves the action time set: the stop is not given again, and the time is written`, { options: OVERNIGHT_ON }, async ($, on) => {
      const doc = nightDoc(ONE_HOUR)
      doc.setDenied = new Set<string>()
      const failing: Failing = { on: false }
      const { rec, clk, journal } = await nearNight($, on, doc, NIGHT - 5000, answer(failing))
      await clk.to(NIGHT + 2000)
      const at = clk.now()
      failing.on = true
      arm(doc)
      await userPrompt($)
      for (let i = 0; i < 10; i++) {
        await clk.by(1000)
        expect(await toggle($, '')).toContain(RUNNING)
      }
      expect(rec.store.get('prompted/s1')).toBe(at)
      expect(journal).toEqual(['stop', 'mark', 'action'])
    })
  }

  // A draw of the answer made as the first write that leaves keepalive with no stop lands, once armed: the moment between the edit and everything that follows it.
  const drawnAtEdit = ($: any) => {
    const seen: { armed: boolean; drawn: string | undefined } = { armed: false, drawn: undefined }
    const around: Around = async (e, next) => {
      const out = await next(e)
      if (seen.armed && e.key === 'keepalive' && e.value?.stop === null && seen.drawn === undefined) {
        seen.drawn = ''
        seen.drawn = await toggle($, '')
      }
      return out
    }
    return { seen, around }
  }

  test("the action time is in memory before the prompt's keepalive edit: a draw made as the edit lands reads the stop gone and the step over", { options: OVERNIGHT_ON }, async ($, on) => {
    const { seen, around } = drawnAtEdit($)
    const { clk } = await nearNight($, on, nightDoc(ONE_HOUR), NIGHT - 5000, around)
    await clk.to(NIGHT + 2000)
    seen.armed = true
    await userPrompt($)
    expect(seen.drawn).toContain(RUNNING)
    expect(seen.drawn).not.toContain('overnight · resumes')
  })

  test("the action time is in memory before /keepalive on's edit: a draw made as the edit lands reads the stop gone and the step over", { options: OVERNIGHT_ON }, async ($, on) => {
    const { seen, around } = drawnAtEdit($)
    const { clk } = await nearNight($, on, nightDoc(ONE_HOUR), NIGHT - 5000, around)
    await clk.to(NIGHT + 2000)
    seen.armed = true
    await toggle($, 'on 60 24')
    expect(seen.drawn).toContain(RUNNING)
    expect(seen.drawn).not.toContain('overnight · resumes')
  })
})

describe('the rest stop across a reload, and the times it keeps in the store', () => {
  const AFTER = NIGHT + 40 * MIN - 5000
  // The reload's own last request, half an hour before it: the 1 h cache is warm, so only the rest decides.
  const reloaded = (store: Record<string, unknown>) => nightDoc(ONE_HOUR, store, AFTER - 30 * MIN)
  // The reload's state: it still names the transcript an earlier load learned, while this load has learned no path yet.
  const namesTranscript = (on: any) =>
    on('state.get', async (_$: any, e: any, next: any) => {
      const got = await next(e)
      return e.plugin === 'cachier' && e.key === 'transcript' && got.value?.value === undefined ? { value: { ...got.value, value: PATH } } : got
    })

  test("a reload after the step and before any prompt finds the held fact standing: the next tick stops again, with no second step, and the row reads done", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on, reloaded({ 'overnight/s1': NIGHT }), AFTER)
    await clk.by(3000)
    expect(journal).toEqual(['stop'])
    expect(rec.store.get('overnight/s1')).toBe(NIGHT)
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain(STOPPED)
    expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
    expect(await paneLines($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
  })

  test("a reload after a post-stop prompt reads the session's own action time and does not stop again: the step is over for the day, and the row reads done", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on, reloaded({ 'overnight/s1': NIGHT, 'prompted/s1': NIGHT + 2 * MIN }), AFTER)
    await clk.by(10 * 1000)
    expect(journal).toEqual([])
    expect(rec.store.get('overnight/s1')).toBe(NIGHT)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
    expect(await paneLines($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
    // Idle in the window all the while, with the day's step taken: later ticks take no second step.
    await clk.by(10 * MIN)
    expect(journal).toEqual([])
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
  })

  test("a step dated yesterday, with the user's prompt after it, does not hold today's step", { options: OVERNIGHT_ON }, async ($, on) => {
    const YESTERDAY = NIGHT - DAY_MS
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'overnight/s1': YESTERDAY, 'prompted/s1': YESTERDAY + 10 * MIN }))
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(rec.store.get('overnight/s1')).toBeGreaterThanOrEqual(NIGHT)
    expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
  })

  test('a time later than now in another session\'s key, in the own keys, or in the step mark holds nothing: the step is taken', { options: OVERNIGHT_ON }, async ($, on) => {
    const LATER = NIGHT + 60 * MIN
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'prompted/other': LATER, 'prompted/s1': LATER, 'overnight/s1': LATER }))
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(rec.store.get('overnight/s1')).toBeLessThan(LATER)
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
    expect(debugOf(rec, 'cachier overnight')[0].newest_prompt).toBeNull()
  })

  test("a prompt entered before the session's path is learned holds the held fact off at once, and is written once the path is learned", { options: OVERNIGHT_ON }, async ($, on) => {
    const NOW = NIGHT + 20 * MIN
    const doc = nightDoc(ONE_HOUR, { 'overnight/s1': NIGHT })
    const rec = kaWorld(on, doc)
    const journal = journalOf(on, doc)
    const clk = timed(mock.clock(on, { now: NOW }), NOW)
    await userPrompt($)
    await clk.by(1000)
    expect(rec.store.has('prompted/s1')).toBe(false)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(3000)
    expect(rec.store.get('prompted/s1')).toBe(NOW)
    expect(journal).toEqual(['action'])
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
  })

  test("a prompt entered after a reload, before any learn but with the state naming the session's transcript, is written at once", { options: OVERNIGHT_ON }, async ($, on) => {
    const rec = kaWorld(on, nightDoc(ONE_HOUR))
    namesTranscript(on)
    const clk = timed(mock.clock(on, { now: NIGHT }), NIGHT)
    await userPrompt($)
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(NIGHT)
  })

  // The pie's click turns keepalive on through the same core as the command, which this test calls.
  test("keepalive turned on after a reload, before any learn but with the state naming the session's transcript, writes the action time at once", { options: OVERNIGHT_ON }, async ($, on) => {
    const rec = kaWorld(on, nightDoc(ONE_HOUR))
    namesTranscript(on)
    const clk = timed(mock.clock(on, { now: NIGHT }), NIGHT)
    await toggle($, 'on 60 24')
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(NIGHT)
  })

  test("a history load that ends before the session's path is learned deletes no night key, and the learn then cleans: the session's own old keys stay, the others' go", { options: OVERNIGHT_ON }, async ($, on) => {
    const OLD = NIGHT - 9 * DAY_MS
    const rec = kaWorld(on, nightDoc(ONE_HOUR, { 'overnight/old': OLD, 'prompted/old': OLD, 'overnight/odd': 'x', 'prompted/young': NIGHT - DAY_MS, 'overnight/s1': OLD, 'prompted/s1': OLD }))
    const clk = timed(mock.clock(on, { now: NIGHT - 5000 }), NIGHT - 5000)
    const nightKeys = () => [...rec.store.keys()].filter((key) => key.startsWith('overnight/') || key.startsWith('prompted/')).sort()
    // A start whose session.start reads the history first, with no path to learn: the state names none.
    await $.session.start({ cwd: '/home/test', surface: 'terminal', isInteractive: true } as any)
    await clk.by(1000)
    expect(nightKeys()).toEqual(['overnight/odd', 'overnight/old', 'overnight/s1', 'prompted/old', 'prompted/s1', 'prompted/young'])
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(1000)
    expect(nightKeys()).toEqual(['overnight/s1', 'prompted/s1', 'prompted/young'])
  })

  test('every entered prompt of the user writes its time into the session\'s action key, the one that ends no recorded pause too, and a dropped prompt writes none', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR)
    const { rec, clk } = await nearNight($, on, doc)
    const first = clk.now()
    await userPrompt($)
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(first)
    expect(rec.store.get('pauses/s1')).toHaveLength(1)
    // A compaction leaves no cache to count a pause from: the next prompt ends none.
    await clk.by(MIN)
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clk.by(1000)
    const second = clk.now()
    await userPrompt($)
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(second)
    expect(rec.store.get('pauses/s1')).toHaveLength(1)
    // A prompt another hook drops is not entered.
    doc.dropPrompt = true
    await clk.by(MIN)
    await userPrompt($)
    await clk.by(1000)
    expect(rec.store.get('prompted/s1')).toBe(second)
  })

  test('the history load deletes the night keys of other sessions that are over two days old or of another shape, and keeps the session\'s own, the younger ones and every other key', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec } = await nearNight(
      $,
      on,
      nightDoc(ONE_HOUR, {
        'overnight/old': NIGHT - 3 * DAY_MS,
        'prompted/old': NIGHT - 3 * DAY_MS,
        'overnight/odd': 'x',
        'prompted/young': NIGHT - DAY_MS,
        'overnight/s1': NIGHT - 9 * DAY_MS,
        'prompted/s1': NIGHT - 9 * DAY_MS,
        'notice/old': NIGHT - 9 * DAY_MS,
      }),
    )
    expect([...rec.store.keys()].filter((key) => key !== 'prices').sort()).toEqual(['notice/old', 'overnight/s1', 'pauses/old', 'prompted/s1', 'prompted/young'])
  })

  test("with a store whose reads all fail, the pane and the tick agree on every tick: no stop, no step; each failure is reported once, and the first tick after the reads land steps", { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR, { 'prompted/other': NIGHT - 3 * 60 * MIN })
    // The session's own keys fail from its start; the history load has read the store by the time the other session's key fails too.
    doc.getDenied = new Set(['overnight/s1', 'prompted/s1'])
    const { rec, clk, journal } = await nearNight($, on, doc)
    doc.getDenied.add('prompted/other')
    const refused = () => rec.logs.filter((l) => l.includes('read refused')).length
    const agree = async () => {
      expect(await toggle($, '')).toContain(RUNNING)
      expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
      expect(await drawnPane($)).toContain(OVERNIGHT_ROW)
      expect(journal).toEqual([])
    }
    // The session's own keys cannot be read: the step mark is unread, and there is no fact whatever the clock says.
    for (let i = 0; i < 20; i++) {
      await clk.by(1000)
      await agree()
    }
    expect(refused()).toBe(1)
    // They can be read now, and the scan of every session's keys cannot.
    doc.getDenied.delete('overnight/s1')
    doc.getDenied.delete('prompted/s1')
    expect(doc.getDenied).toEqual(new Set(['prompted/other']))
    for (let i = 0; i < 20; i++) {
      await clk.by(1000)
      await agree()
    }
    expect(refused()).toBe(2)
    doc.getDenied.clear()
    await clk.by(2000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(await toggle($, '')).toContain(STOPPED)
  })
})

// At the 1 h TTL the stop saves the whole hours left in the window when it fires, and adds a rewrite that costs the break-even count of refreshes more than a refresh: it acts only
// where the hours are at least the count. REPAYING_PAGE gives 3 and Opus 5.5's own page 39; the window is from 02:00 to 07:00, so the last moment 3 hours are left is 04:00.
describe('the rest stop at the 1 h TTL acts only where the refreshes it saves repay the rewrite it adds', () => {
  const noOvernightRow = async ($: any) => {
    for (const rows of [await keepaliveRows($), await paneLines($)]) expect(rows.some((row) => row.startsWith('overnight:'))).toBe(false)
  }

  test("on Opus 5.5's own page a 1 h rewrite costs 39 refreshes more, which no window holds: no stop, no step and no scan, the refreshes go on, and the rows have no overnight row", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'prompted/other': NIGHT - 3 * 60 * MIN }, REQ, PRICING_PAGE))
    const nightReads = () => rec.gets.filter((key) => key.startsWith('prompted/') || key.startsWith('overnight/')).length
    const reads = nightReads()
    await clk.to(NIGHT + 5 * MIN)
    expect(journal).toEqual([])
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(nightReads()).toBe(reads)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(REST_ROW)
    expect(await paneLines($)).toContain(REST_ROW)
    await noOvernightRow($)
  })

  test('a 1 h cache of a model with no price repays nothing: no stop, no step, and no overnight row', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR)
    doc.text = doc.text.replace('claude-opus-5-5', 'claude-nonesuch-1')
    const { rec, clk, journal } = await nearNight($, on, doc)
    await clk.to(NIGHT + 5 * MIN)
    expect(journal).toEqual([])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(await toggle($, '')).toContain(RUNNING)
    await noOvernightRow($)
  })

  for (const [dueAt, steps] of [[new Date(2026, 0, 14, 3, 55).getTime(), true], [new Date(2026, 0, 14, 4, 5).getTime(), false]] as const) {
    test(`where 3 refreshes repay it, a session idle from ${hhmm(dueAt)} ${steps ? 'steps, with 3 hours 5 minutes of the window left' : 'takes no step, with 2 hours 55 minutes left'}, and the window row stands either way`, { options: OVERNIGHT_ON }, async ($, on) => {
      const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, {}, dueAt - IDLE), dueAt - 5000)
      await clk.to(dueAt + 10000)
      expect(journal).toEqual(steps ? ['stop', 'mark'] : [])
      expect(debugOf(rec, 'cachier overnight')).toHaveLength(steps ? 1 : 0)
      expect(await toggle($, '')).toContain(steps ? STOPPED : RUNNING)
      await expectRows($, REST_ROW, steps ? `overnight: done ${hhmm(dueAt)}` : OVERNIGHT_ROW)
    })
  }
})

describe('the rest stop reads the window the pane shows, and acts only where it is on and able', () => {
  test("after a history load the window the tick acts on is the one the pane's rest row shows: a store rewritten between two loads moves both", { options: OVERNIGHT_ON }, async ($, on) => {
    const HALF_ONE = new Date(2026, 0, 14, 1, 30).getTime()
    // The last request at 01:00, so the idle time is reached at 01:30, before the window from 02:00 opens.
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, {}, HALF_ONE - 30 * MIN), HALF_ONE - 5000)
    await clk.to(HALF_ONE + 5000)
    expect(journal).toEqual([])
    await expectRows($, REST_ROW, OVERNIGHT_ROW)
    // Seven rests from 23:00 give the window from 00:00 to 05:00, in which 01:30 falls.
    rec.store.set('pauses/old', startsOf(7, new Date(2026, 0, 12, 23, 0).getTime()).flatMap(restAt))
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(3000)
    expect(await keepaliveRows($)).toContain('rest: from ≤23:00 · back ≥06:00 · 7 rests')
    expect(journal).toEqual(['stop', 'mark'])
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ window: '00:00–05:00' }])
  })

  test("after a pause's write the window the tick acts on is the one the pane's rest row shows: the pause that ends an 8th rest narrows the window, and no step is taken outside it", { options: OVERNIGHT_ON }, async ($, on) => {
    const EVENING = new Date(2026, 0, 13, 22, 0).getTime()
    const FOUR = new Date(2026, 0, 14, 4, 0).getTime()
    // Another session's prompt five minutes before 04:00 keeps the step from the first ticks, which fall in the window from 02:00 to 07:00 the stored rests give. The page prices
    // a 1 h rewrite at one refresh, so that the window of an hour the pause gives still holds a stop that repays.
    const doc = nightDoc(ONE_HOUR, { 'prompted/other': FOUR - 5 * MIN }, EVENING, ONE_HOUR_REPAYS_PAGE)
    const { rec, clk, journal } = await nearNight($, on, doc, FOUR + 1000)
    await expectRows($, REST_ROW, OVERNIGHT_ROW)
    // The user returns at 04:00 after six hours: the pause is a rest, and with it the habit's window is from 02:00 to 03:00.
    await userPrompt($)
    await clk.by(1000)
    await expectRows($, 'rest: from ≤01:00 · back ≥04:00 · 8 rests', 'overnight: 02:00–03:00 · after 30m idle')
    doc.text += lines([
      user({ uuid: 'u2', parent: 'a1', ts: iso(clk.now()) }),
      assistant({ uuid: 'a2', parent: 'u2', ts: iso(clk.now()), write: 20000, tags: ONE_HOUR, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' }),
    ])
    await mainStep($)
    await turnEnd($)
    // Half an hour on, every session is idle, and 04:30 is inside the window the history held at the start and outside the one the pause gave.
    await clk.to(clk.now() + IDLE + 10000)
    expect(journal).toEqual(['action'])
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    expect(await toggle($, '')).toContain(RUNNING)
  })

  test('with the option off, no tick in the window stops keepalive, writes a step or reads the store for one, and no row or Settings value says it is on', { options: { ...OVERNIGHT_ON, overnight: 'off' } }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'prompted/other': NIGHT - 3 * 60 * MIN }))
    const nightReads = () => rec.gets.filter((key) => key.startsWith('prompted/') || key.startsWith('overnight/')).length
    const reads = nightReads()
    await clk.to(NIGHT + 5 * MIN)
    expect(journal).toEqual([])
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(nightReads()).toBe(reads)
    const text = await toggle($, '')
    expect(text).toContain(RUNNING)
    expect(text).toContain('night stop: off (overnight) · overnight')
    expect((await keepaliveRows($)).some((row) => row.startsWith('overnight:'))).toBe(false)
    expect((await paneLines($)).some((row) => row.startsWith('overnight:'))).toBe(false)
  })

  test('with a stop held, no tick reads the store for a scan, though every other condition of a step holds', { options: { ...OVERNIGHT_ON, keepalive_count: 1 } }, async ($, on) => {
    const { rec, clk, journal } = await longNight($, on, nightDoc(FIVE, { 'prompted/other': NIGHT - 3 * 60 * MIN }))
    expect(await toggle($, '')).toContain('Keepalive  paused count used')
    const reads = () => rec.gets.filter((key) => key === 'prompted/other').length
    const loaded = reads()
    // 03:00 is inside the window and the last request is 30 minutes old: with no stop held, a tick would scan now.
    await clk.to(NIGHT + 5 * MIN)
    expect(reads()).toBe(loaded)
    expect(journal).toEqual([])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(await toggle($, '')).toContain('Keepalive  paused count used')
  })

  test('with keepalive off, no tick in the window stops anything or writes a step, and the row says the window acts only with keepalive on', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'prompted/other': NIGHT - 3 * 60 * MIN }))
    const nightReads = () => rec.gets.filter((key) => key.startsWith('prompted/') || key.startsWith('overnight/')).length
    const reads = nightReads()
    await clk.to(NIGHT + 5 * MIN)
    expect(journal).toEqual([])
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
    expect(nightReads()).toBe(reads)
    expect(await toggle($, '')).toContain('Keepalive  off')
    expect(await keepaliveRows($)).toContain(`${OVERNIGHT_ROW} · only with keepalive on`)
    expect(await paneLines($)).toContain(`${OVERNIGHT_ROW} · only with keepalive on`)
  })

  test('with no window learned there is no overnight row, and no step is taken', { options: OVERNIGHT_ON }, async ($, on) => {
    const { clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { 'pauses/old': startsOf(6, NIGHT - 120 * MIN - DAY_MS).flatMap(restAt) }))
    await clk.to(NIGHT + 5000)
    expect(journal).toEqual([])
    expect(await keepaliveRows($)).toContain('rest: 6 of 7 seen')
    expect((await keepaliveRows($)).some((row) => row.startsWith('overnight:'))).toBe(false)
    expect((await paneLines($)).some((row) => row.startsWith('overnight:'))).toBe(false)
  })

  test('the overnight row stands directly after the rest row, in the answer and the pane: the window and the idle figure, then done with the step\'s time', { options: OVERNIGHT_ON }, async ($, on) => {
    const { clk } = await nearNight($, on)
    for (const rows of [await keepaliveRows($), await paneLines($)]) {
      const at = rows.findIndex((row) => row.startsWith('rest: '))
      expect(rows[at]).toBe(REST_ROW)
      expect(rows[at + 1]).toBe(OVERNIGHT_ROW)
    }
    await clk.to(NIGHT + 2000)
    for (const rows of [await keepaliveRows($), await paneLines($)]) {
      const at = rows.findIndex((row) => row.startsWith('rest: '))
      expect(rows[at + 1]).toBe(`overnight: done ${hhmm(NIGHT)}`)
      expect(rows).not.toContain(OVERNIGHT_ROW)
    }
  })

  test("during the stop the footer pie is green throughout, with almost the whole hour left, in its last quarter and tenth, and once the cache has lapsed; the heading and the overnight row say the step throughout, and the heading stops saying it at the prompt", { options: OVERNIGHT_ON }, async ($, on) => {
    const { clk } = await nearNight($, on)
    await clk.to(NIGHT + 2000)
    const tones = async () => {
      const { pie } = await pieDrawn($)
      return ['success', 'warning', 'error'].filter((tone) => pie.includes(`"color":"${tone}"`))
    }
    const says = async () => {
      expect(await toggle($, '')).toContain(STOPPED)
      expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
    }
    // Keepalive is on through the stop, so the pie is green at every step of the time left.
    expect(await tones()).toEqual(['success'])
    await says()
    await clk.to(NIGHT + 48 * MIN)
    expect(await tones()).toEqual(['success'])
    await says()
    await clk.to(NIGHT + 56 * MIN)
    expect(await tones()).toEqual(['success'])
    expect(propsOf(pieOfRow(cacheRow(await paneTree($))))).toEqual({ color: 'success' })
    await says()
    await clk.to(NIGHT + 62 * MIN)
    expect(await tones()).toEqual(['success'])
    expect(await toggle($, '')).toContain('Cache ○ expired')
    await says()
    await userPrompt($)
    await clk.by(3000)
    expect(await toggle($, '')).not.toContain('overnight · resumes')
  })
})

// The notices: the dim lines the plugin writes into the transcript. The world's `ui.log` hook keeps each event with where it was sent; the plugin's debug lines go to the debug log.
const noticesOf = (rec: { logs: string[] }): string[] =>
  rec.logs
    .map((l) => JSON.parse(l) as { text: string; to: string })
    .filter((e) => e.to === 'transcript')
    .map((e) => e.text)
// The first notice, for the window of the seven nights, from 02:00 to 07:00.
const WINDOW_NOTICE = windowNoticeOf({ opensMin: 2 * 60, closesMin: 7 * 60 })
// The session's last request ten minutes before 03:00: the idle figure is not reached before 03:20, so the first notice is tested clear of any step.
const EARLY = NIGHT - 10 * MIN
const PATH_2 = '/home/test/.claude/projects/p/s2.jsonl'
const gateOf = () => {
  let release: () => void = () => {}
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  return { hold, release }
}

// The world of nearNight with no journal, for the tests that watch the order of the notice lines against the store's writes: `events` holds each write of the notice record and of
// the step mark as it lands, with the value written and the number of notice lines the transcript held then.
const watched = async ($: any, on: any, doc: any = nightDoc(ONE_HOUR), startMs = NIGHT - 5000) => {
  const rec = kaWorld(on, doc)
  const events: string[] = []
  doc.onSet = (key: string) => {
    if (key === NOTICES_KEY || key === 'overnight/s1') events.push(`${key} ${JSON.stringify(rec.store.get(key))} after ${noticesOf(rec).length} lines`)
  }
  const clk = timed(mock.clock(on, { now: startMs }), startMs)
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clk.by(1000)
  await mainStep($)
  await turnEnd($)
  return { rec, clk, doc, events }
}

// A load that has read the record and not yet ticked: nearNight up to its first tick, so that a test can change the store as another session would after this load read it. The
// session's turn is then run by `turn` as nearNight runs it. `around` is a test's own answer to a write of the state, as nearNight takes it.
const beforeFirstTick = async ($: any, on: any, doc: any, startMs = NIGHT - 5000, around?: Around) => {
  const rec = kaWorld(on, doc)
  const journal = journalOf(on, doc, around)
  const clock = mock.clock(on, { now: startMs })
  const clk = timed(clock, startMs)
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.settle()
  const turn = async () => {
    await clk.by(1000)
    await mainStep($)
    await turnEnd($)
  }
  return { rec, clk, journal, turn }
}

describe('the overnight notices: the user is told once per install, when the stop can first act and when it first acts', () => {
  test("with the option on, keepalive on and a window learned, one tick writes the first line once, after the record's write has landed, and nothing is written while that write waits", { options: OVERNIGHT_ON }, async ($, on) => {
    const { hold, release } = gateOf()
    const doc = nightDoc(ONE_HOUR, {}, EARLY)
    doc.setHold = { key: NOTICES_KEY, hold }
    const { rec, clk, events } = await watched($, on, doc)
    await clk.by(10 * 1000)
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
    expect(noticesOf(rec)).toEqual([])
    release()
    await clk.by(2000)
    expect(events).toEqual([`${NOTICES_KEY} {"window":true,"step":false} after 0 lines`])
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    await clk.by(30 * 1000)
    expect(events).toHaveLength(1)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
  })

  test('a later tick and a change of the window write no second first line', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, events } = await watched($, on, nightDoc(ONE_HOUR, {}, EARLY))
    await clk.by(5000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    await clk.by(60 * 1000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    // Seven rests from 23:00 give the window from 00:00 to 05:00, which 03:00 is inside too: the window moves, and the line is not written again.
    rec.store.set('pauses/old', startsOf(7, new Date(2026, 0, 12, 23, 0).getTime()).flatMap(restAt))
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(5000)
    expect(await keepaliveRows($)).toContain('overnight: 00:00–05:00 · after 30m idle')
    await clk.by(60 * 1000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(events).toEqual([`${NOTICES_KEY} {"window":true,"step":false} after 0 lines`])
  })

  test('a load that reads the first line written, a reload or a session started after another wrote it, writes none, and leaves the record as it was', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await watched($, on, nightDoc(ONE_HOUR, { [NOTICES_KEY]: { window: true, step: false } }, EARLY))
    await clk.by(30 * 1000)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('with keepalive off a learned window writes no line and leaves the record unspent; turning keepalive on writes the first line at the next tick', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    const { rec, clk } = await watched($, on, nightDoc(ONE_HOUR, {}, EARLY))
    await clk.by(20 * 1000)
    expect(await toggle($, '')).toContain('Keepalive  off')
    expect(await keepaliveRows($)).toContain(`${OVERNIGHT_ROW} · only with keepalive on`)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
    await toggle($, 'on 60 24')
    await clk.by(2000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('with the option off a learned window writes no line and leaves the record unspent', { options: { ...OVERNIGHT_ON, overnight: 'off' } }, async ($, on) => {
    const { rec, clk } = await watched($, on, nightDoc(ONE_HOUR, {}, EARLY))
    await clk.by(30 * 1000)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(REST_ROW)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
  })

  test("at the 1 h TTL on Opus 5.5's own page, where no stop repays its rewrite, no line is written and the record is unspent", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await watched($, on, nightDoc(ONE_HOUR, {}, EARLY, PRICING_PAGE))
    await clk.by(30 * 1000)
    expect(await toggle($, '')).toContain(RUNNING)
    expect(await keepaliveRows($)).toContain(REST_ROW)
    expect((await keepaliveRows($)).some((row) => row.startsWith('overnight:'))).toBe(false)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
  })

  test('with no window learned no line is written and the record is unspent', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await watched($, on, nightDoc(ONE_HOUR, { 'pauses/old': startsOf(6, NIGHT - 120 * MIN - DAY_MS).flatMap(restAt) }, EARLY))
    await clk.by(30 * 1000)
    expect(await keepaliveRows($)).toContain('rest: 6 of 7 seen')
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
  })

  test('the first line comes before the window opens: it is written when the step can act, at any hour', { options: OVERNIGHT_ON }, async ($, on) => {
    const NOON = new Date(2026, 0, 14, 12, 0).getTime()
    const { rec, clk } = await watched($, on, nightDoc(ONE_HOUR, {}, NOON - 10 * MIN), NOON - 5000)
    await clk.by(10 * 1000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('a stop already held does not hold the first line back: a window learned while the run stands paused is told at the next tick, and the run stays paused', { options: { ...OVERNIGHT_ON, keepalive_count: 1 } }, async ($, on) => {
    const { rec, clk } = await longNight($, on, nightDoc(FIVE, { 'pauses/old': startsOf(6, NIGHT - 120 * MIN - DAY_MS).flatMap(restAt) }))
    expect(await toggle($, '')).toContain('Keepalive  paused count used')
    expect(await keepaliveRows($)).toContain('rest: 6 of 7 seen')
    expect(noticesOf(rec)).toEqual([])
    // The seventh rest completes the window, and a resume reads the pauses again.
    rec.store.set('pauses/old', NIGHTS['pauses/old'])
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(5000)
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    expect(await toggle($, '')).toContain('Keepalive  paused')
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
  })

  test('the first step writes the second line once, after the step mark and the record, with the first line before it; neither goes to the model or a toast', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, events } = await watched($, on)
    await clk.to(NIGHT + 2000)
    const step = rec.store.get('overnight/s1') as number
    expect(events).toEqual([`${NOTICES_KEY} {"window":true,"step":false} after 0 lines`, `overnight/s1 ${step} after 1 lines`, `${NOTICES_KEY} {"window":true,"step":true} after 1 lines`])
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
    // A later tick writes no third line, and the lines are not what a refresh sent or a toast showed.
    await clk.by(10 * MIN)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    expect(rec.forks.every((prompt) => prompt === 'ok')).toBe(true)
    expect(rec.toasts).toEqual([])
  })

  test('a tick whose stop commit loses its version check writes no second line, and the tick that steps writes it', { options: OVERNIGHT_ON }, async ($, on) => {
    let lost = 0
    const { rec, clk } = await nearNight($, on, nightDoc(ONE_HOUR), NIGHT - 5000, (e, next) => {
      if (e.key === 'keepalive' && e.value?.stop === 'overnight' && lost === 0) {
        lost++
        return { value: { isSet: false } }
      }
      return next(e)
    })
    await clk.to(NIGHT)
    expect(lost).toBe(1)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    await clk.by(1000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(rec.store.get('overnight/s1') as number, false)])
  })

  test('a step mark that cannot be written writes no second line in this load and leaves the record unspent for it; the step of another session, its mark landing, writes it', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR)
    doc.setDenied = new Set(['overnight/s1'])
    const { rec, clk, journal } = await nearNight($, on, doc)
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop'])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
    expect(await toggle($, '')).toContain(STOPPED)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
    await clk.by(10 * MIN)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    // A second session of the load steps later with its own mark landing: the line is written then, once.
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH_2 })
    await clk.by(1000)
    await mainStep($)
    await turnEnd($)
    await clk.by(70 * 1000)
    const second = rec.store.get('overnight/s2') as number
    expect(second).toBeGreaterThan(NIGHT)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(second, false)])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test("a later step, a day after the one that was told, steps and writes no line", { options: OVERNIGHT_ON }, async ($, on) => {
    const YESTERDAY = NIGHT - DAY_MS
    const { rec, clk, journal } = await nearNight($, on, nightDoc(ONE_HOUR, { [NOTICES_KEY]: { window: true, step: true }, 'overnight/s1': YESTERDAY, 'prompted/s1': YESTERDAY + 10 * MIN }))
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test("a second session of the same load meets both lines already written: it steps later the same day and writes no line, the record being the install's", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await watched($, on)
    await clk.to(NIGHT + 2000)
    const step = rec.store.get('overnight/s1') as number
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH_2 })
    await clk.by(1000)
    await mainStep($)
    await turnEnd($)
    await clk.by(70 * 1000)
    expect(rec.store.get('overnight/s2')).toBeGreaterThan(step)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test('a draw writes neither line: the pane and the bare answer drawn again and again before a tick write nothing, and the next tick writes the first line', { options: OVERNIGHT_ON }, async ($, on) => {
    const rec = kaWorld(on, nightDoc(FIVE, {}, EARLY))
    const clock = mock.clock(on, { now: NIGHT - 5000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    for (let i = 0; i < 5; i++) {
      await toggle($, '')
      await drawnPane($)
    }
    // The stop can act here, so a draw that wrote the line would have written it.
    expect(await keepaliveRows($)).toContain(OVERNIGHT_ROW)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
    await clock.advance(2000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
  })

  test('a record write that throws writes no line and is reported once, and no later tick of the load tries again', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR, {}, EARLY)
    doc.setDenied = new Set([NOTICES_KEY])
    const { rec, clk } = await watched($, on, doc)
    await clk.by(30 * 1000)
    expect(rec.logs.filter((l) => l.includes('write refused'))).toHaveLength(1)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
    expect(await toggle($, '')).toContain(RUNNING)
  })

  test('a failed read of the record is reported once and writes no line; the tick after a read that lands writes the first line', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR, {}, EARLY)
    doc.getDenied = new Set([NOTICES_KEY])
    const { rec, clk } = await watched($, on, doc)
    const refused = () => rec.logs.filter((l) => l.includes('read refused')).length
    await clk.by(20 * 1000)
    expect(refused()).toBe(1)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
    doc.getDenied.delete(NOTICES_KEY)
    await clk.by(2000)
    expect(refused()).toBe(1)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  test('a step taken while the record cannot be read is still taken, and writes no line', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR)
    doc.getDenied = new Set([NOTICES_KEY])
    const { rec, clk, journal } = await nearNight($, on, doc)
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
  })

  test("both lines another session told since this load read the record are not told again, and its flags are not erased by this session's asks", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal, turn } = await beforeFirstTick($, on, nightDoc(ONE_HOUR, {}, EARLY))
    // The record was read untold at the learn; another session of the install has told the user both lines since.
    rec.store.set(NOTICES_KEY, { window: true, step: true })
    await turn()
    await clk.by(10 * 1000)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    // The step at 03:20, this session's own, is not told either.
    await clk.to(NIGHT + 21 * MIN)
    expect(journal).toEqual(['stop', 'mark'])
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
  })

  test('the first line told after another session spent the step line keeps that flag in the record, and the step is not told again', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal, turn } = await beforeFirstTick($, on, nightDoc(ONE_HOUR, {}, EARLY))
    rec.store.set(NOTICES_KEY, { window: false, step: true })
    await turn()
    await clk.by(10 * 1000)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    await clk.to(NIGHT + 21 * MIN)
    expect(journal).toEqual(['stop', 'mark'])
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
  })

  test('a refused fresh read of the record writes no line and is reported once while it keeps failing; the tick whose read lands writes the first line', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(ONE_HOUR, {}, EARLY)
    // The first read of the record is the learn's; the next two, the ticks' fresh reads, are refused.
    doc.getGate = (key: string, nth: number) => (key === NOTICES_KEY && (nth === 2 || nth === 3) ? Promise.resolve('read refused') : undefined)
    const { rec, clk, turn } = await beforeFirstTick($, on, doc)
    const refused = () => rec.logs.filter((l) => l.includes('read refused')).length
    await turn()
    await clk.by(1500)
    expect(refused()).toBe(1)
    expect(noticesOf(rec)).toEqual([])
    expect(rec.store.has(NOTICES_KEY)).toBe(false)
    await clk.by(2000)
    expect(refused()).toBe(1)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
  })

  // A load that could not read the record at its learn is asked for it again by each tick. Refused until 03:00, it is read by the tick at 03:00:00.5, whose step is due and whose price list
  // came in long before: that tick asks for the first line and waits on the write of the record, or on the fresh read before it, which a test changes as another session would. The body
  // is what the user does in that wait, and the tick then goes on. `holdEdits` makes the next edit that leaves keepalive with no stop, which /keepalive on makes after it has noted
  // its time, wait for `edit`. Both waits are let go however the body ends, so that a failed assertion leaves nothing parked for the tests after it.
  type Due = Awaited<ReturnType<typeof beforeFirstTick>> & { notice: ReturnType<typeof gateOf>; edit: ReturnType<typeof gateOf>; holdEdits: () => void }
  const atDue = async ($: any, on: any, wait: 'write' | 'read', body: (due: Due) => Promise<void>) => {
    const notice = gateOf()
    const edit = gateOf()
    let holding = false
    const doc = nightDoc(ONE_HOUR)
    doc.getDenied = new Set([NOTICES_KEY])
    let freshRead = 0
    if (wait === 'write') doc.setHold = { key: NOTICES_KEY, hold: notice.hold }
    else doc.getGate = (key: string, nth: number) => (key === NOTICES_KEY && nth === freshRead ? notice.hold.then(() => undefined) : undefined)
    const world = await beforeFirstTick($, on, doc, NIGHT - 3500, async (e, next) => {
      if (holding && e.key === 'keepalive' && e.value?.stop === null) await edit.hold
      return next(e)
    })
    try {
      await world.clk.by(3000)
      expect(world.rec.logs.filter((l) => l.includes('read refused'))).toHaveLength(1)
      doc.getDenied.clear()
      // The next read of the record is the retry's, the one after it the ask's fresh read.
      freshRead = world.rec.gets.filter((key) => key === NOTICES_KEY).length + 2
      await world.clk.by(1000)
      expect(world.rec.store.has(NOTICES_KEY)).toBe(false)
      await world.clk.by(10)
      await body({ ...world, notice, edit, holdEdits: () => void (holding = true) })
    } finally {
      notice.release()
      edit.release()
    }
  }

  test("a /keepalive on made while the first line's record is written is seen by the step: no stop, mark or second line follows it, and the day's step is still to come", { options: OVERNIGHT_ON }, async ($, on) => {
    await atDue($, on, 'write', async ({ rec, clk, journal, notice, edit, holdEdits }) => {
      holdEdits()
      const toggled = toggle($, 'on 60 24')
      await clk.by(0)
      expect(journal).toEqual(['action'])
      notice.release()
      await clk.by(0)
      expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
      expect(journal).toEqual(['action'])
      expect(rec.store.has('overnight/s1')).toBe(false)
      expect(debugOf(rec, 'cachier overnight')).toEqual([])
      edit.release()
      await toggled
      expect(await toggle($, '')).toContain(RUNNING)
      expect(journal).toEqual(['action'])
      // The user acted at 03:00:00.51 and the session is idle again from there: the step is taken half an hour on.
      await clk.to(NIGHT + 31 * MIN)
      const step = rec.store.get('overnight/s1') as number
      expect(step).toBeGreaterThan(NIGHT + 30 * MIN)
      expect(journal).toEqual(['action', 'stop', 'mark'])
      expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
    })
  })

  test("a /keepalive on made while the record is read fresh is seen by the step too, when the read finds both lines told since by another session: nothing follows the user's action", { options: OVERNIGHT_ON }, async ($, on) => {
    await atDue($, on, 'read', async ({ rec, clk, journal, notice, edit, holdEdits }) => {
      holdEdits()
      const toggled = toggle($, 'on 60 24')
      await clk.by(0)
      expect(journal).toEqual(['action'])
      rec.store.set(NOTICES_KEY, { window: true, step: true })
      notice.release()
      await clk.by(0)
      expect(noticesOf(rec)).toEqual([])
      expect(journal).toEqual(['action'])
      expect(rec.store.has('overnight/s1')).toBe(false)
      expect(debugOf(rec, 'cachier overnight')).toEqual([])
      edit.release()
      await toggled
      expect(await toggle($, '')).toContain(RUNNING)
      expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    })
  })

  // A prompt closes the gap and bumps the state's version before it records its action time, so a tick whose look came before it loses its commit to the version check, and one whose
  // look came after it finds the gap shut: a prompt is safe without the tick looking again, and this pins that it stays so.
  test("a prompt that lands while the first line's record is written leaves the tick that asked no stop and no mark to take", { options: OVERNIGHT_ON }, async ($, on) => {
    await atDue($, on, 'write', async ({ rec, clk, journal, notice }) => {
      await userPrompt($)
      notice.release()
      await clk.by(0)
      expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
      expect(journal).toEqual(['action'])
      expect(rec.store.has('overnight/s1')).toBe(false)
      expect(debugOf(rec, 'cachier overnight')).toEqual([])
      expect(await toggle($, '')).toContain(RUNNING)
    })
  })

  test("keepalive turned off while the first line's record is written: the tick that asked decides nothing, and the line is told", { options: OVERNIGHT_ON }, async ($, on) => {
    await atDue($, on, 'write', async ({ rec, clk, journal, notice }) => {
      expect(await toggle($, 'off')).toBe('keepalive off')
      notice.release()
      await clk.by(0)
      expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
      expect(journal).toEqual([])
      expect(rec.store.has('overnight/s1')).toBe(false)
      expect(debugOf(rec, 'cachier overnight')).toEqual([])
      expect(rec.logs.filter((l) => l.includes('TypeError'))).toEqual([])
      expect(await toggle($, '')).toContain('Keepalive  off')
    })
  })

  test("only the tick that asked for the first line looks twice: the tick after it reads keepalive's state once less, and so does a tick before it that could not ask", { options: OVERNIGHT_ON }, async ($, on) => {
    let reads = 0
    on('state.get', (_$: any, e: any, next: any) => {
      if (e.key === 'keepalive') reads++
      return next(e)
    })
    // The record is refused until the fifth tick is over, so that the ticks before the ask are as steady as the ticks after it.
    const doc = nightDoc(ONE_HOUR, {}, EARLY)
    doc.getDenied = new Set([NOTICES_KEY])
    const { rec, clk } = await beforeFirstTick($, on, doc, NIGHT - 12000)
    const used: number[] = []
    let asked = -1
    for (let i = 0; i < 10; i++) {
      if (i === 5) doc.getDenied.clear()
      const before = reads
      await clk.by(1000)
      used.push(reads - before)
      if (asked < 0 && rec.store.has(NOTICES_KEY)) asked = i
    }
    expect(asked).toBeGreaterThanOrEqual(5)
    expect(used[asked]).toBe(used[asked + 1]! + 1)
    expect(used[asked + 1]).toBe(used[asked + 2])
    expect(used[asked - 1]).toBe(used[asked + 1])
  })
})

// The night compaction. A conversation's size is its last request's prompt and its reply: the fixture's request counts 8 input tokens and its reply 20, so a cache write of `tokens - 28`
// makes a context of `tokens`. The engine answers a compaction as the test says (`answer` gets the call and the world's record). The world checks what a hook answers: a conversation of
// messages as the engine types them, or a skip, and a hook that throws or answers otherwise is skipped, the engine going on to a base layer that refuses the call.
const writeOf = (tokens: number): number => tokens - 28
const STANDS = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', text: 'what the user typed', toolUses: [] }],
  tokensBefore: 60000,
  tokensAfter: 1500,
  usage: { input_tokens: 52000, output_tokens: 900, cache_read_input_tokens: 8000, cache_creation_input_tokens: 300 },
  ...over,
})
// The same compaction as the step's debug line states it.
const STOOD_LINE = { kind: 'stood', size_before: 60000, size_after: 1500, summarizer: { in: 52000, out: 900, cache_read: 8000, cache_write: 300 } }

// nearNight over a conversation of `tokens` tokens. `colds` holds the reason of each cold mark written (the write that clears a settled mark is none). `tune` changes the doc before the load
// starts, and `around` is nearNight's own answer to a write of the state.
const compactNight = async ($: any, on: any, tokens: number, answer: (e: any, rec: any) => unknown = () => STANDS(), store: Record<string, unknown> = {}, tune: (doc: any) => void = () => {}, around?: Around) => {
  const colds: string[] = []
  const doc = nightDoc(ONE_HOUR, store, REQ, undefined, writeOf(tokens))
  doc.compact = answer
  tune(doc)
  const world = await nearNight($, on, doc, NIGHT - 5000, (e, next) => {
    if (e.key === 'cold' && e.value !== null && e.value !== undefined) colds.push(e.value.reason)
    return around === undefined ? next(e) : around(e, next)
  })
  return { ...world, colds }
}

describe('the night compaction: a step on a conversation at the floor also compacts it, once, and the lines say so', () => {
  test('a step at the floor asks the engine for one compaction, with no instructions, after the step mark has landed, and the stop stands', { options: OVERNIGHT_ON }, async ($, on) => {
    const marked: boolean[] = []
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS, (_e, world) => {
      marked.push(world.store.has('overnight/s1'))
      return STANDS()
    })
    await clk.to(NIGHT + 2000)
    expect(rec.compacts).toHaveLength(1)
    expect(rec.compacts[0].instructions).toBeUndefined()
    expect(marked).toEqual([true])
    expect(journal).toEqual(['stop', 'mark'])
    expect(await toggle($, '')).toContain(STOPPED)
    expect(await keepaliveRows($)).toContain(`overnight: done ${hhmm(NIGHT)}`)
  })

  test('a step one token below the floor asks for no compaction: the stop and the mark stand, the debug line states none, and the second line says none', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS - 1)
    await clk.to(NIGHT + 2000)
    expect(rec.compacts).toEqual([])
    expect(journal).toEqual(['stop', 'mark'])
    expect(await toggle($, '')).toContain(STOPPED)
    const [line, ...more] = debugOf(rec, 'cachier overnight')
    expect(more).toEqual([])
    expect('compaction' in line).toBe(false)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(rec.store.get('overnight/s1') as number, false)])
    expect(noticesOf(rec)[1]).not.toContain('compacted')
  })

  test('the floor reads no TTL and no price: a step on the 5 m TTL compacts a conversation at the floor, as one on the 1 h TTL does', { options: OVERNIGHT_ON }, async ($, on) => {
    const doc = nightDoc(FIVE, {}, REQ, undefined, writeOf(COMPACT_FLOOR_TOKENS))
    doc.compact = () => STANDS()
    const { rec, clk, journal } = await longNight($, on, doc)
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop', 'mark'])
    expect(rec.compacts).toHaveLength(1)
  })

  test('with the option off the step does not act, and no conversation is compacted, at the floor or above it', { options: { ...OVERNIGHT_ON, overnight: 'off' } }, async ($, on) => {
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS + 40000)
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual([])
    expect(rec.compacts).toEqual([])
    expect(await toggle($, '')).toContain(RUNNING)
  })

  test("a compaction that stood is stated in the step's debug line by its sizes and the summarizer's usage, and in the second line; nothing the conversation holds is logged", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await compactNight($, on, COMPACT_FLOOR_TOKENS, () => STANDS({ messages: [{ role: 'user', text: 'a private sentence', toolUses: [] }] }))
    await clk.to(NIGHT + 2000)
    const step = rec.store.get('overnight/s1') as number
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ time: iso(step), window: WINDOW, compaction: STOOD_LINE }])
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, true)])
    expect(noticesOf(rec)[1]).toContain(' and the conversation was compacted; ')
    expect(rec.logs.join('\n')).not.toContain('a private sentence')
  })

  test('a compaction that stood with its sizes or its usage absent is stated with null for what the engine did not give', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await compactNight($, on, COMPACT_FLOOR_TOKENS, () => ({ messages: STANDS().messages }))
    await clk.to(NIGHT + 2000)
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ compaction: { kind: 'stood', size_before: null, size_after: null, summarizer: null } }])
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(rec.store.get('overnight/s1') as number, true)])
  })

  // A hook of the test world that throws is skipped by the engine, which goes on to a base layer that refuses the call with words of its own.
  const refusal = () => {
    throw new Error('a turn is running')
  }
  // A veto's words can quote the conversation, so the debug line gives their length and none of them.
  const VETO = 'vetoed because the conversation is about a private matter'
  for (const [what, answer, kind] of [
    ['skipped by another plugin', () => ({ skip: VETO }), 'skipped'],
    ['refused, as the engine does while a turn runs', refusal, 'refused'],
  ] as const) {
    test(`a compaction ${what} leaves the stop and the mark, writes no cold mark of the step's own, is stated by the debug line, and the second line says none stood`, { options: OVERNIGHT_ON }, async ($, on) => {
      const { rec, clk, journal, colds } = await compactNight($, on, COMPACT_FLOOR_TOKENS, answer)
      await clk.to(NIGHT + 2000)
      const step = rec.store.get('overnight/s1') as number
      expect(rec.compacts).toHaveLength(1)
      expect(journal).toEqual(['stop', 'mark'])
      expect(colds).toEqual([])
      expect(await toggle($, '')).toContain(STOPPED)
      const lines = debugOf(rec, 'cachier overnight')
      expect(lines).toHaveLength(1)
      expect(lines[0].compaction.kind).toBe(kind)
      if (kind === 'skipped') expect(lines[0].compaction).toEqual({ kind: 'skipped', reason: 'a hook vetoed it', reason_chars: VETO.length })
      if (kind === 'refused') {
        expect(Object.keys(lines[0].compaction)).toEqual(['kind', 'error_chars'])
        expect(lines[0].compaction.error_chars).toBeGreaterThan(0)
      }
      expect(rec.logs.join('\n')).not.toContain(VETO)
      expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
      expect(noticesOf(rec)[1]).not.toContain('compacted')
      // It was the day's try: no later tick asks again.
      await clk.by(10 * MIN)
      expect(rec.compacts).toHaveLength(1)
    })
  }

  // The engine fires a session start with source compact and the classic hook after the compaction while the call is still out; the measured order is the start first, and the other is as likely a
  // build away, so both are run.
  const startFirst = async ($: any) => {
    await $.classic.SessionStart({ source: 'compact', transcript_path: PATH })
    await COMPACT($)
  }
  const hookFirst = async ($: any) => {
    await COMPACT($)
    await $.classic.SessionStart({ source: 'compact', transcript_path: PATH })
  }
  for (const [order, hooks] of [
    ['the session start first', startFirst],
    ['the compaction hook first', hookFirst],
  ] as const) {
    test(`a compaction that stands is marked cold once, by the existing compaction handler and not by the step, with ${order}: the Cache line and the footer read reset, the pie green while the stop holds`, { options: OVERNIGHT_ON }, async ($, on) => {
      const running = gateOf()
      const { rec, clk, colds, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS, async () => {
        await running.hold
        return STANDS()
      })
      try {
        await clk.to(NIGHT + 2000)
        expect(rec.compacts).toHaveLength(1)
        expect(colds).toEqual([])
        const sent = rec.forks.length
        await hooks($)
        running.release()
        await clk.by(2000)
        expect(colds).toEqual(['compaction'])
        expect(rec.forks.length).toBe(sent)
      } finally {
        running.release()
      }
      const text = await toggle($, '')
      expect(text).toContain('Cache ○ reset')
      expect(text).toContain(STOPPED)
      const pie = await pieDrawn($)
      expect(pie.words).toBe('reset')
      expect(pie.pie).toContain('"color":"success"')
      // The step adds none later, nor does anything else: one mark for the one compaction.
      await clk.by(10 * MIN)
      expect(colds).toEqual(['compaction'])
      expect(journal).toEqual(['stop', 'mark'])
    })
  }

  test("a start that resets keepalive after the compaction is followed, at the next tick, by the overnight stop and no refresh", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS)
    await clk.to(NIGHT + 2000)
    const sent = rec.forks.length
    expect(journal).toEqual(['stop', 'mark'])
    await COMPACT($)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clk.by(3000)
    expect(journal).toEqual(['stop', 'mark', 'stop'])
    expect(await toggle($, '')).toContain(STOPPED)
    await clk.by(30 * 1000)
    expect(rec.forks.length).toBe(sent)
    expect(rec.compacts).toHaveLength(1)
  })

  test("the second line and the step's debug line wait for the compaction's outcome: nothing is written while it runs, and they then say what happened", { options: OVERNIGHT_ON }, async ($, on) => {
    const running = gateOf()
    const { rec, clk } = await compactNight($, on, COMPACT_FLOOR_TOKENS, async () => {
      await running.hold
      return STANDS()
    })
    try {
      await clk.to(NIGHT + 2000)
      expect(rec.compacts).toHaveLength(1)
      expect(rec.store.has('overnight/s1')).toBe(true)
      expect(noticesOf(rec)).toEqual([WINDOW_NOTICE])
      expect(debugOf(rec, 'cachier overnight')).toEqual([])
      expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: false })
      running.release()
      await clk.by(1000)
    } finally {
      running.release()
    }
    const step = rec.store.get('overnight/s1') as number
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, true)])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ time: iso(step), compaction: STOOD_LINE }])
  })

  test('the compaction does not hold the tick: while it runs, a keepalive reset by a start is stopped again at the next tick', { options: OVERNIGHT_ON }, async ($, on) => {
    const running = gateOf()
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS, async () => {
      await running.hold
      return STANDS()
    })
    try {
      await clk.to(NIGHT + 2000)
      const sent = rec.forks.length
      await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
      await clk.by(3000)
      expect(journal).toEqual(['stop', 'mark', 'stop'])
      expect(rec.forks.length).toBe(sent)
      expect(rec.compacts).toHaveLength(1)
    } finally {
      running.release()
    }
  })

  test("a prompt that lands while the compaction runs ends the stop as any prompt does, and the compaction's end changes neither that nor the day's step", { options: OVERNIGHT_ON }, async ($, on) => {
    const running = gateOf()
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS, async () => {
      await running.hold
      return STANDS()
    })
    try {
      await clk.to(NIGHT + 2000)
      await userPrompt($)
      await clk.by(2000)
      expect(await toggle($, '')).toContain(RUNNING)
      running.release()
      await clk.by(5000)
    } finally {
      running.release()
    }
    expect(await toggle($, '')).toContain(RUNNING)
    expect(journal).toEqual(['stop', 'mark', 'action'])
    expect(rec.compacts).toHaveLength(1)
  })

  // The gap between the stop and the compaction is the wait for the step's mark to be written. The world holds that write, so that the user can act while it waits.
  const inTheGap = async ($: any, on: any, acts: () => Promise<void>) => {
    const writing = gateOf()
    const world = await compactNight($, on, COMPACT_FLOOR_TOKENS, undefined, {}, (doc) => {
      doc.setHold = { key: 'overnight/s1', hold: writing.hold }
    })
    try {
      await world.clk.to(NIGHT + 2000)
      // The stop has committed and the mark is being written: no compaction is asked yet.
      expect(world.journal).toEqual(['stop'])
      expect(world.rec.store.has('overnight/s1')).toBe(false)
      expect(world.rec.compacts).toEqual([])
      await acts()
      writing.release()
      await world.clk.by(2000)
    } finally {
      writing.release()
    }
    return world
  }
  const LEFT_ALONE = { kind: 'skipped', reason: 'the user acted after the step' }

  test("a prompt that lands in the gap between the stop and the compaction, and finishes a short turn there, leaves the conversation alone: none is asked, the debug line says the user acted, and the second line says none stood", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await inTheGap($, on, async () => {
      await userPrompt($)
      await mainStep($)
      await turnEnd($)
    })
    const step = rec.store.get('overnight/s1') as number
    expect(rec.compacts).toEqual([])
    expect(journal).toEqual(['stop', 'action', 'mark'])
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ time: iso(step), window: WINDOW, compaction: LEFT_ALONE }])
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, false)])
    expect(await toggle($, '')).toContain(RUNNING)
    // It was the day's try: no later tick asks again.
    await clk.by(10 * MIN)
    expect(rec.compacts).toEqual([])
  })

  test("keepalive turned on in the gap is the user's action too: no compaction is asked", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, journal } = await inTheGap($, on, async () => {
      expect(await toggle($, 'on 60')).toContain('keepalive on: lead')
    })
    expect(rec.compacts).toEqual([])
    expect(journal).toContain('action')
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ compaction: LEFT_ALONE }])
  })

  test('an action of the user long before the step does not stop the compaction: only an action since the step does', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await compactNight($, on, COMPACT_FLOOR_TOKENS, undefined, { 'prompted/s1': NIGHT - 40 * MIN })
    await clk.to(NIGHT + 2000)
    expect(rec.compacts).toHaveLength(1)
    expect(debugOf(rec, 'cachier overnight')).toMatchObject([{ compaction: STOOD_LINE }])
  })

  test("no second compaction is asked the same local day: the user returns for a reply on a context above the floor and goes idle in the window again, and the day's step is not taken again", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal, doc } = await compactNight($, on, COMPACT_FLOOR_TOKENS)
    await clk.to(NIGHT + 2000)
    expect(rec.compacts).toHaveLength(1)
    await userPrompt($)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(clk.now()), write: writeOf(COMPACT_FLOOR_TOKENS + 5000), tags: ONE_HOUR, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' })])
    await mainStep($)
    await turnEnd($)
    await clk.by(45 * MIN)
    expect(rec.compacts).toHaveLength(1)
    expect(journal).toEqual(['stop', 'mark', 'action'])
    expect(debugOf(rec, 'cachier overnight')).toHaveLength(1)
  })

  test("no second compaction is asked across a reload: a load that finds the day's step mark in the store, over a conversation above the floor, takes no step and asks none", { options: OVERNIGHT_ON }, async ($, on) => {
    const AFTER = NIGHT + 40 * MIN - 5000
    const doc = nightDoc(ONE_HOUR, { 'overnight/s1': NIGHT }, AFTER - 30 * MIN, undefined, writeOf(COMPACT_FLOOR_TOKENS + 1000))
    doc.compact = () => STANDS()
    const { rec, clk, journal } = await nearNight($, on, doc, AFTER)
    await clk.by(10 * 1000)
    expect(journal).toEqual(['stop'])
    expect(rec.compacts).toEqual([])
    expect(rec.store.get('overnight/s1')).toBe(NIGHT)
    expect(debugOf(rec, 'cachier overnight')).toEqual([])
  })

  test('a step whose mark cannot be written asks for no compaction, since a later load may step the same day: the stop holds and the debug line states none', { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk, journal } = await compactNight($, on, COMPACT_FLOOR_TOKENS, undefined, {}, (doc) => {
      doc.setDenied = new Set(['overnight/s1'])
    })
    await clk.to(NIGHT + 2000)
    expect(journal).toEqual(['stop'])
    expect(rec.store.has('overnight/s1')).toBe(false)
    expect(rec.compacts).toEqual([])
    const lines = debugOf(rec, 'cachier overnight')
    expect(lines).toHaveLength(1)
    expect('compaction' in lines[0]).toBe(false)
    await clk.by(10 * MIN)
    expect(rec.compacts).toEqual([])
    expect(await toggle($, '')).toContain(STOPPED)
  })

  test('a tick whose stop commit loses its version check asks for no compaction, and the tick that steps asks for it', { options: OVERNIGHT_ON }, async ($, on) => {
    let lost = 0
    const { rec, clk } = await compactNight($, on, COMPACT_FLOOR_TOKENS, undefined, {}, () => {}, (e, next) => {
      if (e.key === 'keepalive' && e.value?.stop === 'overnight' && lost === 0) {
        lost++
        return { value: { isSet: false } }
      }
      return next(e)
    })
    await clk.to(NIGHT)
    expect(lost).toBe(1)
    expect(rec.compacts).toEqual([])
    await clk.by(1000)
    expect(rec.compacts).toHaveLength(1)
  })

  test("an install the first build told its lines to is told each rewritten line once, under the new record: the second names the compaction, and the old record is left as it was", { options: OVERNIGHT_ON }, async ($, on) => {
    const { rec, clk } = await compactNight($, on, COMPACT_FLOOR_TOKENS, undefined, { notices: { window: true, step: true } })
    await clk.to(NIGHT + 2000)
    const step = rec.store.get('overnight/s1') as number
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, true)])
    expect(rec.store.get(NOTICES_KEY)).toEqual({ window: true, step: true })
    expect(rec.store.get('notices')).toEqual({ window: true, step: true })
    expect(rec.gets).not.toContain('notices')
    await clk.by(10 * MIN)
    expect(noticesOf(rec)).toEqual([WINDOW_NOTICE, stepNoticeOf(step, true)])
  })
})

describe('the bare command says how many refreshes a pause sends, and why', () => {
  test('with nothing pinned or learned, the pane gives the break-even count and what it is', async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('max 24 refreshes/pause (break-even)')
  })

  test('keepalive_count caps the break-even count, and the pane says so', { options: { keepalive_count: 6 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('max 6 refreshes/pause (keepalive_count cap; break-even 24)')
  })

  test('a model with no price sends keepalive_count, or 3 while it is unset, and the pane says why', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('max 3 refreshes/pause (default: model unpriced, keepalive_count unset)')
  })
})

describe("the pie's colour: keepalive's mode on the footer line", () => {
  test('the pie is green while keepalive is on, refreshing or paused, and is not green with keepalive off', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
    await toggle($, 'on 60 1')
    await clock.advance(1000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    await mainStep($)
    await turnEnd($)
    await clock.advance(20 * MIN)
    expect(await drawnPane($)).toContain('Keepalive  paused ')
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    await toggle($, 'off')
    await clock.advance(1000)
    expect(await drawnHint($)).not.toContain('"color":"success"')
  })

  test('a keepalive stopped by a failure on a warm cache draws the footer\'s pie and the Cache line\'s glyph green beside the red `stopped` heading and no colour sentence; turned off, both are amber and the sentence is there', async ($, on) => {
    const doc: any = opusCached()
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
    const clock = await startedWorld($, on, doc)
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    const stopped = await paneTree($)
    expect(textOf(keepaliveRow(stopped))).toBe('Keepalive  stopped')
    expect(propsOf(keepaliveRow(stopped).children[1])).toEqual({ color: 'error' })
    expect(textOf(pieOfRow(cacheRow(stopped)))).toBe('◔')
    expect(propsOf(pieOfRow(cacheRow(stopped)))).toEqual({ color: 'success' })
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    expect(pieLineRow(stopped)).toBeUndefined()
    await toggle($, 'off')
    await clock.advance(1000)
    const off = await paneTree($)
    expect(propsOf(pieOfRow(cacheRow(off)))).toEqual({ color: 'warning' })
    expect((await pieDrawn($)).pie).toContain('"color":"warning"')
    expect(pieLineRow(off)).toBeDefined()
  })

  test('a keepalive paused by count used on a warm cache in the last tenth of its TTL draws the footer\'s pie and the Cache line\'s glyph green beside the `paused` heading', async ($, on) => {
    const clock = await startedWorld($, on)
    await countUsed($, clock)
    await clock.advance(30000)
    const tree = await paneTree($)
    expect(textOf(keepaliveRow(tree))).toBe('Keepalive  paused')
    expect(textOf(pieOfRow(cacheRow(tree)))).toBe('◔')
    expect(propsOf(pieOfRow(cacheRow(tree)))).toEqual({ color: 'success' })
    const footer = await pieDrawn($)
    expect(footer.words).toBe('0:29')
    expect(footer.pie).toContain('"color":"success"')
  })
})

describe("the TTL advice: the bare command names the other TTL once the recorded pauses say it would have cost less", () => {
  // Ten twenty-minute pauses on a 100k context that grew by 2k each: a lapse every time at 5m with keepalive off.
  const SIZED = {
    'pauses/old': Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 20 * MIN, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000, contextTokens: 100000, grownTokens: 2000 })),
  }

  test('with keepalive off, the pane says 1h would have saved money and how to set it; on, it prices the pings it sends', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: SIZED })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    // The best-setup block shows too, so the TTL block's setup row is left out: one setup row, then each block's rows.
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual([
      'setup: 5m/off',
      'best: 1h/off · would have saved $4.74 (10 recent pauses)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
      'other TTL: 1h/off · would have saved $4.74 (10 priced pauses, all sessions)',
      'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)',
    ])
    await toggle($, 'on 15')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('other TTL: 1h/off · would have saved $0.74 (10 priced pauses, all sessions)')
    expect(sectionLines(await commandText($, ''), 'Advice')?.[0]).toBe('setup: 5m/on')
    await toggle($, 'on 15 3')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('other TTL: 1h/off · would have saved $5.34 (10 priced pauses, all sessions)')
    expect(sectionLines(await commandText($, ''), 'Advice')?.[0]).toBe('setup: 5m/on')
  })

  test('keepalive on at a lead not below the TTL: the line names the setup you are on paused, with the reason the Keepalive section gives', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: SIZED })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 300')
    await clock.advance(1000)
    const text = await toggle($, '')
    const reason = 'lead 300s ≥ 300s TTL'
    expect(text).toContain(`Keepalive  paused`)
    expect(text).toContain(reason)
    const advice = sectionLines(await commandText($, ''), 'Advice')
    expect(advice?.[0]).toBe(`setup: 5m/paused (${reason})`)
    expect(advice).toContain('other TTL: 1h/off · would have saved $4.74 (10 priced pauses, all sessions)')
    expect(advice?.filter((row) => row.startsWith('setup:'))).toHaveLength(1)
  })

  test('a TTL block shown alone keeps its own setup row, and the best-setup block coming or going takes that row with it', async ($, on) => {
    // Four priced pauses are too few for the best setup (five are needed) but enough for the TTL block, which prices every one there is.
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/old': SIZED['pauses/old'].slice(0, 4) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const step = 'do: set "promptCacheTtl": "1h" in settings.json (new sessions start off: keepalive_default)'
    const alone = ['setup: 5m/off', 'other TTL: 1h/off · would have saved $1.90 (4 priced pauses, all sessions)', step]
    const both = [
      'setup: 5m/off',
      'best: 1h/off · would have saved $2.37 (5 recent pauses)',
      step,
      'other TTL: 1h/off · would have saved $2.37 (5 priced pauses, all sessions)',
      step,
    ]
    // The pane's Advice rows: those under the heading up to the blank row that ends the section.
    const drawn = async () => {
      const rows = await paneRows($)
      const from = rows.indexOf('Advice') + 1
      return rows.slice(from, rows.indexOf('', from))
    }
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(alone)
    expect(await drawn()).toEqual(alone)
    // A fifth pause, another session's, read on a resume: the best-setup block appears with the one setup row, and the TTL block loses its own.
    rec.store.set('pauses/other', [{ ...SIZED['pauses/old'][0]!, startMs: 5000 }])
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(both)
    expect(await drawn()).toEqual(both)
    // The store drops it and the next load reads without it: the best-setup block goes, and the TTL block has its setup row again.
    rec.store.set('pauses/other', [])
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(alone)
    expect(await drawn()).toEqual(alone)
  })

  test('a 1-hour session whose new sessions start keepalive on at a 300 s lead is told to go back to a 5-minute cache that sends nothing', { options: { keepalive_default: 'on', keepalive_lead_s: 300 } }, async ($, on) => {
    // Ten 2-minute pauses on a context that grew 50k each: the 1 h write costs more than the 5 m one, and no pause lapses at 5 m.
    const short = { 'pauses/old': SIZED['pauses/old'].map((r) => ({ ...r, pausedMs: 2 * MIN, grownTokens: 50000 })) }
    const oneHour = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: ONE_HOUR, model: 'claude-opus-5-5', speed: 'standard' })]) }
    kaWorld(on, { ...oneHour, store: short })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const target = 'other TTL: 5m/paused (lead 300s ≥ 300s TTL) · would have saved'
    const step = 'do: set "promptCacheTtl": "5m" in settings.json (new sessions start on: keepalive_default)'
    const text = await toggle($, '')
    expect(text).toContain(target)
    expect(text).toContain(step)
    // The best-setup block runs the paused setup after its step; the TTL block's step is that row without the tail.
    const advice = sectionLines(await commandText($, ''), 'Advice')
    expect(advice).toContain('do: set "promptCacheTtl": "5m" in settings.json (new sessions start on: keepalive_default, so run 5m/paused (lead 300s ≥ 300s TTL))')
    expect(advice?.some((row) => row.startsWith(target))).toBe(true)
    expect(advice).toContain(step)
    const pane = await paneRows($)
    expect(pane.some((row) => row.startsWith(target))).toBe(true)
    expect(pane).toContain(step)
    // The command keeps every row within 48 columns, the paused setup whole on one of them; the pane carries each row whole.
    const answer = (await commandText($, '')).split('\n')
    expect(widthOf(answer)).toBeLessThanOrEqual(48)
    expect(answer.some((row) => row.includes('5m/paused (lead 300s ≥ 300s TTL)'))).toBe(true)
  })

  test('the line is carried whole in the details pane and wrapped to 48 columns in the command', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: SIZED })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const rows = await paneRows($)
    expect(rows).toContain('other TTL: 1h/off · would have saved $4.74 (10 priced pauses, all sessions)')
    expect(widthOf((await commandText($, '')).split('\n'))).toBeLessThanOrEqual(48)
  })

  test('the other TTL is priced at the lead and pin a new session starts with, since switching TTL starts one', { options: { keepalive_count: 1, keepalive_default: 'on' } }, async ($, on) => {
    // 150-minute pauses with no growth, keepalive on at a 60 s lead pinned at 2. New sessions start keepalive on, so the other TTL is
    // priced with it on: at 1 h this session's run would hold each pause for two refreshes, but a new session runs the 15 s lead and the
    // count capped at 1, which cannot hold it, so 1 h costs its rewrite.
    const long = { 'pauses/old': SIZED['pauses/old'].map((r) => ({ ...r, pausedMs: 150 * MIN, grownTokens: 0 })) }
    kaWorld(on, { ...opusCached(), store: long })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, refreshing')
    expect(text).not.toContain('priced pause')
    expect(await drawnPane($)).not.toContain('priced pause')
  })

  // Ten 150-minute pauses with no growth: on 5 m each pays its rewrite ($0.48), with keepalive off or on at its learned count of none;
  // at 1 h keepalive on holds each for two reads ($0.04), and off each pays the 1 h rewrite ($0.78).
  const LONG = { 'pauses/old': SIZED['pauses/old'].map((r) => ({ ...r, pausedMs: 150 * MIN, grownTokens: 0 })) }

  test('the other TTL is priced with keepalive on when new sessions start it on, though this session has it off', { options: { keepalive_default: 'on' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: LONG })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'off')
    await clock.advance(1000)
    // The other TTL is named as the new session starts it, keepalive on, and its step is the setting with that start alone.
    const advice = sectionLines(await commandText($, ''), 'Advice')
    const at = advice?.indexOf('other TTL: 1h/on · would have saved $4.40 (10 priced pauses, all sessions)') ?? -1
    expect(at).toBeGreaterThanOrEqual(0)
    expect(advice?.[at + 1]).toBe('do: set "promptCacheTtl": "1h" in settings.json (new sessions start on: keepalive_default)')
    expect(advice?.[0]).toBe('setup: 5m/off')
  })

  test('the other TTL is priced with keepalive off when new sessions start it off, though this session has it on', { options: { keepalive_default: 'off' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: LONG })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 15')
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  paused')
    expect(text).not.toContain('priced pause')
    expect(await drawnPane($)).not.toContain('priced pause')
  })

  test('with no recorded context, the pane gives no advice', async ($, on) => {
    const bare = { 'pauses/old': SIZED['pauses/old'].map(({ contextTokens, grownTokens, ...r }) => r) }
    kaWorld(on, { ...opusCached(), store: bare })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).not.toContain('priced pause')
    expect(await drawnPane($)).not.toContain('priced pause')
  })
})

describe('the bare command answers five sections, in order: Cache, Keepalive, This session, Advice, Settings', () => {
  test('the sections come in that order, each headed by its name on a line of its own, and the cache line comes first', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const text = await commandText($, '')
    const headings = text.split('\n').filter((line: string) => ['Cache', 'This session', 'Advice', 'Settings'].includes(line) || line.startsWith('Keepalive'))
    expect(headings).toEqual(['Cache', 'Keepalive  off', 'This session', 'Advice', 'Settings'])
    expect(text.startsWith('Cache\n  ● warm · ')).toBe(true)
  })

  test('a section with no figure is absent: with nothing learned, missed or advised, there is no Advice heading', async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await commandText($, '')).not.toMatch(/(^|\n)Advice\n/)
  })

  test('the Settings section has the six settings, each with its value and how to change it, and the TTL and start mode say new sessions', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('TTL: 5m (last response) · set "promptCacheTtl": "1h" in settings.json for 1h (new sessions)')
    expect(text).toContain('lead: 15s · /keepalive on <lead_s>')
    expect(text).toContain('refreshes/pause: break-even · /keepalive on <lead_s> <count> or keepalive_count')
    expect(text).toContain('start mode: off (keepalive_default) · /keepalive default on|off (new sessions)')
    expect(text).toContain('unit: dollars (cost_unit) · /keepalive unit tokens|dollars')
    expect(text).toContain('night stop: on (overnight) · overnight')
  })

  test('a run whose cost the answer states has the refresh cost in the Keepalive section, before Settings', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 15 3')
    const text = await commandText($, '')
    expect(text.indexOf('Keepalive')).toBeLessThan(text.indexOf('refresh ~19k cached'))
    expect(text.indexOf('refresh ~19k cached')).toBeLessThan(text.indexOf('Settings'))
  })

  test('the session balance against the other setting is in the Keepalive section once a pause has been judged', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(10 * MIN)
    await userPrompt($)
    const text = await toggle($, '')
    expect(text).toMatch(/balance vs other setting: (saved \$[\d.]+ net|\$[\d.]+ net more|even) \(1 pause\)/)
    expect(text.indexOf('Keepalive  on, refreshing')).toBeLessThan(text.indexOf('balance vs other setting'))
    expect(text.indexOf('balance vs other setting')).toBeLessThan(text.indexOf('Settings'))
  })

  test('the Keepalive section says when keepalive pays off, under its heading', { options: { keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const text = await commandText($, '')
    expect(text.indexOf('Keepalive')).toBeLessThan(text.indexOf('refreshes/pause ('))
    expect(text).toContain('pays off if back in ')
  })
})

// The rows that are headings: unindented, the section's title with its state when it has one.
const headingsOf = (text: string): string[] => text.split('\n').filter((row) => row !== '' && !row.startsWith(' '))
// A section's lines as the answer states them: the rows under its heading up to the blank row that ends it, each line's wrapped rows joined
// back into one. Undefined when the answer has no such heading.
const sectionLines = (text: string, title: string): string[] | undefined => {
  const rows = text.replace(/\n {4}/g, ' ').split('\n')
  const at = rows.findIndex((row) => row === title || row.startsWith(`${title}  `))
  if (at < 0) return undefined
  const body: string[] = []
  for (const row of rows.slice(at + 1)) {
    if (row === '') break
    body.push(row.trim())
  }
  return body
}
const MISSES = 'misses: 1 (lapse 1) · $0.10 rewritten'
// A session on PATH whose keepalive sends one refresh and is then turned off; the pause is judged on the prompt that ends it, and the reply
// after the lapse counts a miss.
const withMiss = async ($: any, on: any, replyMs = T0 + 600000) => {
  const doc: any = opusCached()
  kaWorld(on, doc)
  const clock = mock.clock(on, { now: T0 })
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.advance(1000)
  await toggle($, 'on 60 2')
  await mainStep($)
  await turnEnd($)
  await clock.advance(240500)
  await toggle($, 'off')
  await clock.advance(359000)
  await userPrompt($)
  doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(replyMs), write: 20000, tags: FIVE, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' })])
  await mainStep($)
  await turnEnd($)
  await clock.advance(1000)
  return clock
}

describe('the This session section: the session figures, copied from the Keepalive and Advice sections under a heading of its own', () => {
  test('at a fresh session start it reads that no refresh has been sent, after Keepalive, and Keepalive has no session line', async ($, on) => {
    await startedWorld($, on)
    const text = await commandText($, '')
    expect(headingsOf(text)).toEqual(['Cache', 'Keepalive  off', 'This session', 'Settings'])
    expect(sectionLines(text, 'This session')).toEqual(['session: no refreshes yet'])
    expect(sectionLines(text, 'Keepalive')?.some((line) => line.startsWith('session:'))).toBe(false)
    expect(await drawnPane($)).toContain('session: no refreshes yet')
  })

  test('after one refresh read in tokens, its first line is the Keepalive section\'s session line, and Keepalive still carries that line once', async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'unit tokens')
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240500)
    await clock.advance(1000)
    const text = await commandText($, '')
    const session = 'session: 1 refresh · ~19k read'
    expect(sectionLines(text, 'This session')?.[0]).toBe(session)
    expect(sectionLines(text, 'Keepalive')?.filter((line) => line === session)).toHaveLength(1)
  })

  test('with dollars chosen and no price for the model, the refreshes are stated in tokens', async ($, on) => {
    const clock = await startedWorld($, on, cached())
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240500)
    await clock.advance(1000)
    const text = await commandText($, '')
    expect(text).toContain('unit: dollars (cost_unit)')
    const session = 'session: 1 refresh · ~19k read'
    expect(sectionLines(text, 'This session')?.[0]).toBe(session)
    expect(sectionLines(text, 'Keepalive')).toContain(session)
  })

  test('after two refreshes in dollars on a priced model, its first line is the Keepalive section\'s session line, the same text', async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 60 3')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240500)
    await clock.advance(240000)
    const text = await commandText($, '')
    const session = 'session: 2 refreshes · $0.007'
    expect(sectionLines(text, 'This session')?.[0]).toBe(session)
    expect(sectionLines(text, 'Keepalive')).toContain(session)
  })

  test('once a pause is judged, its second line is the Keepalive section\'s balance line, the same text, in dollars and in tokens', async ($, on) => {
    const clock = await startedWorld($, on)
    await clock.advance(10 * MIN)
    await userPrompt($)
    const text = await commandText($, '')
    const balance = sectionLines(text, 'Keepalive')?.find((line) => line.startsWith('balance vs other setting'))
    expect(balance).toMatch(/^balance vs other setting: (saved \$[\d.]+ net|\$[\d.]+ net more|even) \(1 pause\)$/)
    expect(sectionLines(text, 'This session')).toEqual(['session: no refreshes yet', balance])
    await toggle($, 'unit tokens')
    const tokens = await commandText($, '')
    const pointer = 'balance vs other setting: $ only, /keepalive unit dollars (1 pause)'
    expect(sectionLines(tokens, 'Keepalive')).toContain(pointer)
    expect(sectionLines(tokens, 'This session')).toEqual(['session: no refreshes yet', pointer])
  })

  test('once a miss is counted, its last line is the Advice section\'s misses line, the same text', async ($, on) => {
    const doc: any = { text: lines([user({ uuid: 'u1', parent: null, ts: iso(T0 - 60000) }), assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1', model: 'claude-opus-5-5', speed: 'standard' })]) }
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    doc.text += lines([assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' })])
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const text = await commandText($, '')
    expect(sectionLines(text, 'Advice')).toContain(MISSES)
    expect(sectionLines(text, 'This session')).toEqual(['session: no refreshes yet', MISSES])
  })

  test('a /clear starts the refreshes and the balance over, and a compaction keeps them', async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240500)
    await clock.advance(240000)
    await clock.advance(20000)
    await userPrompt($)
    await clock.advance(1000)
    const before = sectionLines(await commandText($, ''), 'This session')
    expect(before?.[0]).toBe('session: 2 refreshes · $0.007')
    expect(before?.[1]).toMatch(/^balance vs other setting/)
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await $.classic.SessionStart({ source: 'compact', transcript_path: PATH })
    await clock.advance(1000)
    expect(sectionLines(await commandText($, ''), 'This session')).toEqual(before)
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
    await clock.advance(1000)
    const cleared = sectionLines(await commandText($, ''), 'This session')
    expect(cleared?.[0]).toBe('session: no refreshes yet')
    expect(cleared?.some((line) => line.startsWith('Over '))).toBe(false)
  })

  test('a resume of the same transcript starts the refreshes and the balance over, and keeps the misses the section ends with', async ($, on) => {
    const clock = await withMiss($, on)
    const before = sectionLines(await commandText($, ''), 'This session')
    expect(before?.[0]).toBe('session: 1 refresh · $0.004')
    expect(before?.[2]).toBe(MISSES)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    const after = await commandText($, '')
    expect(sectionLines(after, 'This session')).toEqual(['session: no refreshes yet', MISSES])
    expect(sectionLines(after, 'Advice')).toContain(MISSES)
    expect(sectionLines(after, 'Keepalive')?.some((line) => line.startsWith('Over '))).toBe(false)
  })

  test('a session start on another transcript: neither the section nor Advice has the misses line', async ($, on) => {
    const clock = await withMiss($, on)
    expect(await commandText($, '')).toContain(MISSES)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/other/session.jsonl' })
    await clock.advance(1000)
    const text = await commandText($, '')
    expect(sectionLines(text, 'This session')).toEqual(['session: no refreshes yet'])
    expect(text).not.toContain('misses:')
  })

  test('the section is shown with keepalive off, on and paused', async ($, on) => {
    const clock = await startedWorld($, on)
    for (const args of ['off', 'on 60 2', 'on 300']) {
      await toggle($, args)
      await clock.advance(1000)
      const text = await commandText($, '')
      expect(headingsOf(text)).toContain('This session')
      expect(sectionLines(text, 'This session')?.[0]).toMatch(/^session: /)
    }
  })

  test('the section is shown with keepalive stopped', async ($, on) => {
    const doc: any = cached()
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    const text = await commandText($, '')
    expect(headingsOf(text)).toContain('Keepalive  stopped')
    expect(headingsOf(text)).toContain('This session')
    expect(sectionLines(text, 'This session')?.[0]).toMatch(/^session: /)
  })

  test('the section is shown with no cache to count from', async ($, on) => {
    const clock = await startedWorld($, on, { text: '', exists: false })
    await toggle($, 'on 15')
    await clock.advance(1000)
    const text = await commandText($, '')
    expect(headingsOf(text)).toContain('This session')
    expect(sectionLines(text, 'This session')?.[0]).toMatch(/^session: /)
  })
})

// The bare command's whole answer for fixed states: the text its sections lay out, headings and blank lines included. The cold-mark and
// shared-price pins take the fixtures of the existing tests of those two scenes and pin their whole answers, not a phrase of them.
describe('the bare command answers whole: the text its sections lay out, for fixed states', () => {
  const expired = () => ({
    text: lines([
      user({ uuid: 'u1', parent: null, ts: iso(T0) }),
      assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, out: 7000, tags: FIVE, model: 'claude-opus-5-5', speed: 'standard' }),
    ]),
  })

  test('keepalive on and refreshing: the whole answer, with the next refresh scheduled', async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 15')
    await clock.advance(1000)
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ● warm · 4:59 left · 5m TTL',
        '',
        'Keepalive  on, refreshing',
        '  refresh $0.004 (~19k cached) · every 4:45',
        '  if cold: rebuild ~$0.09 (~19k written)',
        '  next in 4:44 · 24 left',
        '  max 24 refreshes/pause (break-even)',
        '  pays off if back in 5:00–1:54:00',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('keepalive off: the whole answer', async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ● warm · 4:59 left · 5m TTL',
        '',
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  refresh $0.004 (~19k cached)',
        '  every 4:45',
        '  if cold: rebuild ~$0.09 (~19k written)',
        '  max 24 refreshes/pause (break-even)',
        '  pays off if back in 5:00–1:54:00',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('a pinned count under a keepalive_count cap: the whole answer gives the pinned count, with no cap line', { options: { keepalive_count: 6 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ● warm · 4:59 left · 5m TTL',
        '',
        'Keepalive  on, refreshing',
        '  refresh $0.004 (~19k cached) · every 4 min',
        '  if cold: rebuild ~$0.09 (~19k written)',
        '  next in 3:59 · 2 left',
        '  max 2 refreshes/pause (pinned)',
        '  pays off if back in 5:00–13:00',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 60s · /keepalive on <lead_s>',
        '  refreshes/pause: 2, pinned ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('an expired cache: the whole answer gives the rebuild figure in dollars', async ($, on) => {
    kaWorld(on, expired())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ○ expired · rebuild ~$0.13',
        '',
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  next refresh $0.004 (~19k read)',
        '  every 4:45',
        '  max 24 refreshes/pause (break-even)',
        '  pays off if back in 5:00–1:54:00',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('an expired cache: the whole answer gives the rebuild figure in tokens, with the unit switched this session', async ($, on) => {
    kaWorld(on, expired())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'unit tokens')
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ○ expired · rebuild ~26k tokens',
        '',
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  next refresh ~19k read',
        '  every 4:45',
        '  max 24 refreshes/pause (break-even)',
        '  pays off if back in 5:00–1:54:00',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Advice',
        '  5m write ≈ 25 reads (claude-opus-5-5)',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: tokens (switched this session) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('a cold mark being written: the whole answer says the cache reset is being recorded, and keeps the running figure', { options: { keepalive_lead_s: 60, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    kaWorld(on, doc)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'cold' && e.value !== null && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      // The rows are compared joined: a row's 48-column wrap is not what this pins, only the rows and their order.
      expect((await commandText($, '')).replace(/\n {4}/g, ' ')).toBe(
        [
          'Cache',
          '  ● warm · 5:00 left · 5m TTL',
          '',
          'Keepalive  paused',
          '  recording cache reset',
          '  refresh ~19k cached · every 4 min',
          '  if cold: rebuild ~19k written',
          '  max 2 refreshes/pause (pinned)',
          '  rest: 0 of 7 seen',
          '',
          'This session',
          '  session: no refreshes yet',
          '',
          'Advice',
          '  in tokens: no price for an unnamed model',
          '',
          'Settings',
          '  TTL: 5m (last response) · set "promptCacheTtl": "1h" in settings.json for 1h (new sessions)',
          '  lead: 60s · /keepalive on <lead_s>',
          '  refreshes/pause: 2, pinned · /keepalive on <lead_s> <count> or keepalive_count',
          '  start mode: off (keepalive_default) · /keepalive default on|off (new sessions)',
          '  unit: dollars (cost_unit) · /keepalive unit tokens|dollars',
          '  night stop: on (overnight) · overnight',
        ].join('\n'),
      )
      // The accepted window: the heading reads paused while the reset is being recorded, and the pie is still green with keepalive on.
      expect((await pieDrawn($)).pie).toContain('"color":"success"')
    } finally {
      release()
    }
    await switching
    await clock.advance(1000)
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
  })

  test('a price from the shared price record: the whole answer after the first fold, its misses priced at the stored rate', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    // The state an earlier load left: the stats counted the first reply, and a cursor stops the first pass at it.
    const stats = { ...INITIAL_STATS, transcript: PATH, cursor: 'm1', lastAtMs: T0, lastTotal: 18559, lastTtlMs: 300000 }
    const doc = {
      text: lines([
        user({ uuid: 'u1', parent: null, ts: iso(T0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, tags: FIVE, msg: 'm1', model: 'claude-opus-5-5', speed: 'standard' }),
        assistant({ uuid: 'a2', parent: 'a1', ts: iso(T0 + 360000), write: 20000, tags: FIVE, msg: 'm2', model: 'claude-opus-5-5', speed: 'standard' }),
      ]),
      store: { prices: storedPrices() },
    }
    const rec = kaWorld(on, doc)
    // The staged stats stand in for the state's stats on each read that finds none. The count below checks that one did, so a read shape
    // that no longer matches fails here, not as a different answer.
    let injected = 0
    on('state.get', async (_$: any, e: any, next: any) => {
      const got = await next(e)
      if (e.plugin === 'cachier' && e.key === 'stats' && got.value?.value === undefined) {
        injected += 1
        return { value: { ...got.value, value: stats } }
      }
      return got
    })
    const clock = mock.clock(on, { now: T0 + 360000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    expect(injected).toBeGreaterThan(0)
    expect(rec.fetches).toEqual([])
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ○ expired · rebuild ~$0.20',
        '',
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  next refresh $0.008 (~20k read)',
        '  every 4:45',
        '  max 3 refreshes/pause (keepalive_count cap;',
        '    break-even 24)',
        '  pays off if back in 5:00–19:15',
        '  rest: 0 of 7 seen',
        '  long pauses: 1 · p90 6:00 · mean 6:00 · max',
        '    6:00',
        '',
        'This session',
        '  session: no refreshes yet',
        '  misses: 1 (lapse 1) · $0.20 rewritten',
        '',
        'Advice',
        '  misses: 1 (lapse 1) · $0.20 rewritten',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even (keepalive_count',
        '    cap) · /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('a cold mark cleared by /clear: the whole answer has no Cache section', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
    await clock.advance(1000)
    expect(await commandText($, '')).toBe(
      [
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  // A cold mark from a model switch, held over the stored cache: 18551 tokens written by Opus 5.5 at the 5-minute TTL, 7000 of output.
  const coldHeld = async ($: any, on: any) => {
    kaWorld(on, expired())
    const clock = mock.clock(on, { now: T0 + 1000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'claude-sonnet-5-5', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.advance(1000)
    return clock
  }

  test('a cold mark from a model switch held over a priced stored cache: the whole answer gives the rebuild figure in dollars', async ($, on) => {
    await coldHeld($, on)
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ○ reset · rebuild ~$0.13',
        '',
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: dollars (cost_unit) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })

  test('a cold mark from a model switch held over a priced stored cache: the whole answer gives the rebuild figure in tokens', async ($, on) => {
    const clock = await coldHeld($, on)
    await toggle($, 'unit tokens')
    await clock.advance(1000)
    expect(await commandText($, '')).toBe(
      [
        'Cache',
        '  ○ reset · rebuild ~26k tokens',
        '',
        'Keepalive  off',
        '  pie: amber ≤¼ TTL left, red ≤⅒',
        '  rest: 0 of 7 seen',
        '',
        'This session',
        '  session: no refreshes yet',
        '',
        'Settings',
        '  TTL: 5m (last response) · set',
        '    "promptCacheTtl": "1h" in settings.json for',
        '    1h (new sessions)',
        '  lead: 15s · /keepalive on <lead_s>',
        '  refreshes/pause: break-even ·',
        '    /keepalive on <lead_s> <count> or',
        '    keepalive_count',
        '  start mode: off (keepalive_default) ·',
        '    /keepalive default on|off (new sessions)',
        '  unit: tokens (switched this session) ·',
        '    /keepalive unit tokens|dollars',
        '  night stop: on (overnight) · overnight',
      ].join('\n'),
    )
  })
})

// The Settings lines as each surface states them: the command's, each line's wrapped rows joined back into one, and the pane's rows, each whole.
const settingsLines = async ($: any): Promise<{ answer: string[]; pane: string[] }> => {
  const rows = await paneRows($)
  return { answer: sectionLines(await commandText($, ''), 'Settings') ?? [], pane: rows.slice(rows.indexOf('Settings') + 1) }
}
// What no Settings row holds, tested on each row so that a row cannot hide in an answer joined into one string: a closing full stop, the
// spelled-out placeholder `lead seconds`, the old name `refreshes a pause`, a source ending ` option)`, and a seconds figure spaced from its `s`.
const expectTerseRows = (rows: string[]) => {
  expect(rows.some((row) => row.endsWith('.'))).toBe(false)
  for (const old of [/lead seconds/, /refreshes a pause/, / option\)/, /\d s\b/]) expect(rows.some((row) => old.test(row))).toBe(false)
}

describe('the Settings rows: each is `name: value (source) · change`, the same in the pane and in the bare answer', () => {
  const SET_1H = 'set "promptCacheTtl": "1h" in settings.json for 1h (new sessions)'
  const SET_5M = 'set "promptCacheTtl": "5m" in settings.json for 5m (new sessions)'
  const COUNT = '/keepalive on <lead_s> <count> or keepalive_count'
  const DEFAULT_ROWS = [
    `TTL: 5m (last response) · ${SET_1H}`,
    'lead: 15s · /keepalive on <lead_s>',
    `refreshes/pause: break-even · ${COUNT}`,
    'start mode: off (keepalive_default) · /keepalive default on|off (new sessions)',
    'unit: dollars (cost_unit) · /keepalive unit tokens|dollars',
    'night stop: on (overnight) · overnight',
  ]

  test('six settings in a fixed order, each one row of its name, its value, its source where it has one and its change', async ($, on) => {
    await startedWorld($, on)
    const { answer, pane } = await settingsLines($)
    expect(answer).toEqual(DEFAULT_ROWS)
    expect(pane).toEqual(DEFAULT_ROWS)
    expectTerseRows(answer)
    expectTerseRows(pane)
  })

  // Each state changes some of the rows; every row it names stands in the pane and in the answer beside the other five, with no row wider than
  // the 48 columns the answer wraps to.
  type State = { name: string; options?: Record<string, number | string>; rows: string[]; run: ($: any, on: any) => Promise<unknown> }
  const STATES: State[] = [
    { name: 'a 1-hour cache: the TTL row steps back to 5m', rows: [`TTL: 1h (last response) · ${SET_5M}`], run: ($, on) => startedWorld($, on, cached(ONE_HOUR)) },
    {
      // The lead reads the options' here too: it stands until a command sets one, so no state of the command reads `lead: not set`.
      name: 'before any session has started: the TTL is not read yet',
      rows: [`TTL: not read yet · ${SET_1H}`, 'lead: 15s · /keepalive on <lead_s>'],
      run: async ($, on) => {
        kaWorld(on, opusCached())
        mock.clock(on, { now: T0 })
      },
    },
    {
      name: 'a count pinned by a command: the command\'s lead and the pinned count',
      rows: ['lead: 60s · /keepalive on <lead_s>', `refreshes/pause: 2, pinned · ${COUNT}`],
      run: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 60 2')
        await clock.advance(1000)
      },
    },
    { name: 'a keepalive_count cap on the break-even count', options: { keepalive_count: 6 }, rows: [`refreshes/pause: break-even (keepalive_count cap) · ${COUNT}`], run: ($, on) => startedWorld($, on) },
    { name: 'a count learned from the stored pauses', rows: [`refreshes/pause: learned · ${COUNT}`], run: ($, on) => startedWorld($, on, { ...opusCached(), store: LONG_PAUSES }) },
    { name: 'new sessions that start on', options: { keepalive_default: 'on' }, rows: ['start mode: on (keepalive_default) · /keepalive default on|off (new sessions)'], run: ($, on) => startedWorld($, on) },
    {
      name: 'a unit switched this session',
      rows: ['unit: tokens (switched this session) · /keepalive unit tokens|dollars'],
      run: async ($, on) => {
        await startedWorld($, on)
        await toggle($, 'unit tokens')
      },
    },
    { name: 'a unit the cost_unit option sets', options: { cost_unit: 'tokens' }, rows: ['unit: tokens (cost_unit) · /keepalive unit tokens|dollars'], run: ($, on) => startedWorld($, on) },
    { name: 'the overnight option off', options: { overnight: 'off' }, rows: ['night stop: off (overnight) · overnight'], run: ($, on) => startedWorld($, on) },
    // Only `off` turns it off: a value the engine hands unset or another word leaves it on.
    { name: 'the overnight option unset', options: { overnight: '' }, rows: ['night stop: on (overnight) · overnight'], run: ($, on) => startedWorld($, on) },
    { name: 'the overnight option another word', options: { overnight: 'Off' }, rows: ['night stop: on (overnight) · overnight'], run: ($, on) => startedWorld($, on) },
  ]
  for (const s of STATES) {
    test(s.name, { options: s.options }, async ($, on) => {
      await s.run($, on)
      const { answer, pane } = await settingsLines($)
      expect(answer).toHaveLength(6)
      expect(pane).toHaveLength(6)
      for (const row of s.rows) {
        expect(answer).toContain(row)
        expect(pane).toContain(row)
      }
      expectTerseRows(answer)
      expectTerseRows(pane)
      expect(widthOf((await commandText($, '')).split('\n'))).toBeLessThanOrEqual(48)
    })
  }

  test('the usage line and the command\'s argument hint keep their placeholders, `<lead seconds> [refreshes]`', async ($, on) => {
    const rec = kaWorld(on, opusCached())
    mock.clock(on, { now: T0 })
    await $.session.start({ cwd: '/home/test', surface: 'terminal', isInteractive: true } as any)
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    expect(rec.commands.map((c) => c.argumentHint)).toEqual(['<lead seconds> [refreshes] | off | default on|off | unit dollars|tokens'])
    expect(await commandText($, 'nonsense')).toBe(
      'usage: /keepalive on <lead seconds> [refreshes], /keepalive off, /keepalive default on|off, or /keepalive unit dollars|tokens. Without refreshes, each run sends the count learned from your pauses, else the break-even count. The default is the mode new sessions start in.',
    )
  })
})

// The reads a status call makes of the states it states: each is read once per call, so its figures are one reading.
describe('the bare command reads each state it states once per call', () => {
  test('one status call reads the cache view, the cold mark and the unit once each', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, opusCached())
    let counting = false
    const reads: string[] = []
    on('state.get', (_$: any, e: any, next: any) => {
      if (counting && e.plugin === 'cachier') reads.push(e.key)
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    counting = true
    await commandText($, '')
    counting = false
    const count = (key: string) => reads.filter((read) => read === key).length
    expect({ view: count('view'), cold: count('cold'), unit: count('unit'), hint: count('hint') }).toEqual({ view: 1, cold: 1, unit: 1, hint: 0 })
  })
})

// The Keepalive section's colour sentence and offer. The sentence shows exactly while keepalive is off, with a reading held or none and whatever the
// pie's colour; with keepalive on the pie is green and the sentence is absent. The offer's explanation and figures show with keepalive off and an offer.
// The answer's rows are joined, since the sentence wraps at 48 columns. A paused keepalive's refresh cost is followed by its interval row wherever the lead is below the TTL.
describe('the Keepalive section: the colour sentence and the offer while keepalive is off, and the interval a paused keepalive names', () => {
  const SENTENCE = 'pie: amber ≤¼ TTL left, red ≤⅒'
  const LONG = { 'pauses/old': Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 })) }
  const started = async ($: any, on: any, doc: any = opusCached()) => {
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    return clock
  }
  // The refresh's cost in dollars, as the section's rows read it joined: the cost wraps at 48 columns, and the interval row follows it.
  const REFRESH = 'refresh $0.004 (~19k cached)'
  const REBUILD = 'if cold: rebuild ~$0.09 (~19k written)'
  const EXPIRED_REFRESH = 'refresh $0.004 (~19k cached)'
  // Holds the write that records a stop of the given kind, so the section is read between the tick's verdict and its record.
  const holdingStop = (on: any, stop: string) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = { holding: false }
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'keepalive' && e.value?.stop === stop && !held.holding) {
        held.holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    return { held, release }
  }

  test('keepalive off, in the last quarter: the sentence follows the heading, then the offer, ahead of the section\'s other lines', async ($, on) => {
    const clock = await started($, on)
    await clock.advance(240000)
    expect(await toggle($, '')).toContain(`Keepalive  off ${SENTENCE} refresh $0.004 (~19k cached) every 4:45 if cold: rebuild ~$0.09 (~19k written) max 24 refreshes/pause`)
  })

  test('keepalive off, in the last tenth: the sentence is there', async ($, on) => {
    const clock = await started($, on)
    await clock.advance(280000)
    expect(await toggle($, '')).toContain(`Keepalive  off ${SENTENCE} `)
  })

  test('keepalive off, before the last quarter: the sentence is there too, though the pie is the normal colour', async ($, on) => {
    const clock = await started($, on)
    await clock.advance(100000)
    expect(await toggle($, '')).toContain(`Keepalive  off ${SENTENCE} refresh $0.004 (~19k cached) every 4:45 if cold: rebuild ~$0.09 (~19k written)`)
  })

  test('keepalive on and refreshing, in the last quarter: no sentence, the pie is green', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 15')
    await clock.advance(240000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, refreshing')
    expect(text).not.toContain('pie: amber')
  })

  test('keepalive on with a lead at the TTL, in the last quarter: the pie is green and the reason line is followed by the rebuild line, with no sentence', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 300')
    await clock.advance(240000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    const text = await toggle($, '')
    expect(text).toContain(`Keepalive  paused lead 300s ≥ 300s TTL · sends nothing ${REBUILD}`)
    expect(text).not.toContain(SENTENCE)
  })

  test('keepalive stopped with its count used, in the last quarter: the pie is green and the last-refresh line follows the reason, with no sentence between', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 500)
    await clock.advance(1000)
    await clock.advance(240000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    const text = await toggle($, '')
    expect(text).toMatch(/Keepalive  paused count used · resumes on next prompt \S/)
    expect(text).not.toContain(SENTENCE)
  })

  test('keepalive on with a learned count of none, in the last quarter: the pie is green and the figure follows the reason, with no sentence between', async ($, on) => {
    const clock = await started($, on, { ...opusCached(), store: LONG })
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(250000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  paused 0 refreshes this pause (learned: pauses rarely outlast TTL) · resumes on next prompt refresh ')
    expect(text).not.toContain(SENTENCE)
  })

  test('an expired cache with keepalive on: the pie is green, and the figure follows the reason, with no sentence', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(310000)
    await turnEnd($)
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('Cache ○ expired · rebuild')
    expect(text).toContain(`Keepalive  paused cache expired · resumes on next prompt ${EXPIRED_REFRESH}`)
    expect(text).not.toContain(SENTENCE)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
  })

  test('an expired cache with keepalive off: the sentence is there once, as the pane has it', async ($, on) => {
    const clock = await started($, on)
    await clock.advance(20 * MIN)
    const text = await toggle($, '')
    expect(text).toContain('Cache ○ expired · rebuild')
    expect(text).toContain(`Keepalive  off ${SENTENCE}`)
    expect(text.split(SENTENCE).length - 1).toBe(1)
  })

  test('with no reading to count from, keepalive off: the sentence is there once, and there is no cache line', async ($, on) => {
    await started($, on, { text: '', exists: false })
    const lines = (await commandText($, '')).split('\n')
    expect(lines.filter((line: string) => line === 'Cache' || /^\s*([○◔◑◕●] )?(warm|expired|reset)\b/.test(line))).toEqual([])
    expect(lines.join('\n')).not.toMatch(/[○◔◑◕●]/)
    const text = await toggle($, '')
    expect(text).toContain(`Keepalive  off ${SENTENCE}`)
    expect(text.split(SENTENCE).length - 1).toBe(1)
  })

  test('a cold mark being written in the last quarter, before the reset record lands: the pie is green and the section has no sentence', { options: { keepalive_lead_s: 20, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    kaWorld(on, doc)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'cold' && e.value !== null && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 20 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(250000)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      const text = await toggle($, '')
      expect(text).toContain('Cache ◔ warm · 0:50 left · 5m TTL')
      expect(text).toContain('Keepalive  paused recording cache reset')
      expect(text).not.toContain('pie: amber')
      expect((await pieDrawn($)).pie).toContain('"color":"success"')
    } finally {
      release()
    }
    await switching
  })

  test('a cold mark being written in the last quarter, after it is set and before its write finishes: the reading is cold, the pie green, and the section has no sentence', { options: { keepalive_lead_s: 20, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    kaWorld(on, doc)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'stats' && e.value?.coldSince?.length > 0 && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 20 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(250000)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      const text = await toggle($, '')
      expect(text).toContain('Cache ○ reset')
      expect(text).toContain('Keepalive  paused recording cache reset')
      expect(text).not.toContain(SENTENCE)
      expect((await pieDrawn($)).pie).toContain('"color":"success"')
      await clock.advance(1000)
      expect(await hint($)).toBe('reset')
    } finally {
      release()
    }
    await switching
  })

  test('a cold mark being written at a lead at the TTL on a warm cache: the overlay reads the pending reason, the lead reason, then the rebuild line', { options: { keepalive_lead_s: 300, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    kaWorld(on, doc)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'cold' && e.value !== null && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 300 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      expect(await toggle($, '')).toContain(
        'Keepalive  paused recording cache reset lead 300s ≥ 300s TTL · sends nothing if cold: rebuild ~19k written',
      )
    } finally {
      release()
    }
    await switching
  })

  test('a cold mark from a model switch with its mark set and its write unrecorded, in the last quarter: the pending reason is followed by the no-live-cache line', { options: { keepalive_lead_s: 20, keepalive_count: 2 } }, async ($, on) => {
    const doc: any = { text: '', exists: false }
    kaWorld(on, doc)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'stats' && e.value?.coldSince?.length > 0 && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 20 2')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(250000)
    const switching = $.classic.PostModelSwitch({ from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      expect(await toggle($, '')).toContain('Keepalive  paused recording cache reset no live cache · nothing scheduled · cache from next reply')
    } finally {
      release()
    }
    await switching
  })

  test('between the last refresh\'s count and its count-used stop being recorded, in the last quarter: the pie is green and the section has no sentence', async ($, on) => {
    kaWorld(on, cached())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = false
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'keepalive' && e.value?.stop === 'count used' && !holding) {
        holding = true
        return gate.then(() => next(e))
      }
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 500)
    // The refresh's reply touched the cache anew: run on to its last quarter, with the stop not yet recorded.
    const advancing = clock.advance(240000 + 1000)
    await clock.settle()
    try {
      expect(holding).toBe(true)
      const text = await toggle($, '')
      expect(text).toContain('Keepalive  paused count used')
      expect(text).not.toContain('pie: amber')
      expect((await pieDrawn($)).pie).toContain('"color":"success"')
    } finally {
      release()
    }
    await advancing
  })

  test('keepalive off with an offer: the section and the pane give the same explanation and figures', async ($, on) => {
    await started($, on)
    expect(await toggle($, '')).toContain('refresh $0.004 (~19k cached) every 4:45 if cold: rebuild ~$0.09 (~19k written)')
    const pane = await drawnPane($)
    expect(pane).toContain('refresh $0.004 (~19k cached)')
    expect(pane).toContain('every 4:45')
    expect(pane).toContain('if cold: rebuild ~$0.09 (~19k written)')
  })

  test('keepalive off with no cache to offer from: the sentence is there, and neither the explanation nor the figures', async ($, on) => {
    await started($, on, { text: '', exists: false })
    const text = await toggle($, '')
    expect(text).toContain(`Keepalive  off ${SENTENCE}`)
    expect(text).not.toMatch(/(^|\s)(refresh [$~]|if cold:|every \d)/)
  })

  test('keepalive off with a lead at the TTL, which offers no refresh: the hover states the rebuild, the sentence is there, and neither the explanation nor the figures', { options: { keepalive_lead_s: 300 } }, async ($, on) => {
    await started($, on)
    expect(await drawnHint($)).toContain('if cold ~$0.09 rebuild')
    const text = await toggle($, '')
    expect(text).toContain(`Keepalive  off ${SENTENCE}`)
    expect(text).not.toMatch(/(^|\s)(refresh [$~]|if cold:|every \d)/)
  })

  test('keepalive off: the sentence is there exactly once on a calm, an amber and a red pie', async ($, on) => {
    const clock = await started($, on)
    const once = async () => (await toggle($, '')).split(SENTENCE).length - 1
    expect(await once()).toBe(1)
    await clock.advance(239000)
    expect((await pieDrawn($)).pie).toContain('"color":"warning"')
    expect(await once()).toBe(1)
    await clock.advance(40000)
    expect((await pieDrawn($)).pie).toContain('"color":"error"')
    expect(await once()).toBe(1)
  })

  test('keepalive on and paused with a calm cache: the pie is green, and the reason line is followed by the rebuild line, with no sentence', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 300')
    await clock.advance(1000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    const text = await toggle($, '')
    expect(text).toContain(`Keepalive  paused lead 300s ≥ 300s TTL · sends nothing ${REBUILD}`)
    expect(text).not.toContain(SENTENCE)
  })

  test('keepalive on, paused after its count is used: the section gives the interval row, and no next-refresh line', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 500)
    await clock.advance(1000)
    await clock.advance(240000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  paused count used')
    expect(text).toContain('every 4 min')
    expect(text).toContain('if cold: rebuild ~$0.09 (~19k written)')
    expect(text).not.toContain('cached) · every')
  })

  test('keepalive on and refreshing: the section names the next refresh\'s cost and interval, and gives no offer', async ($, on) => {
    await started($, on)
    await toggle($, 'on 15')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, refreshing refresh $0.004 (~19k cached) · every 4:45 if cold: rebuild ~$0.09 (~19k written)')
    expect(text).not.toMatch(/\) every \d/)
  })

  test('keepalive on and refreshing on a calm cache: the sentence is absent', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 15')
    await clock.advance(1000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    expect((await toggle($, '')).split(SENTENCE).length - 1).toBe(0)
  })

  test('a count used with its stop recorded: the refresh cost, and directly after it the interval row', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 500)
    await clock.advance(1000)
    await clock.advance(240000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  paused count used')
    expect(text).toContain(`${REFRESH} every 4 min ${REBUILD}`)
  })

  test('recording a count-used stop leaves the section\'s figure rows unchanged: the cost and the interval read the same before the stop is recorded and after', async ($, on) => {
    kaWorld(on, opusCached())
    const { held, release } = holdingStop(on, 'count used')
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000 + 500)
    const advancing = clock.advance(240000 + 1000)
    await clock.settle()
    let before = ''
    try {
      expect(held.holding).toBe(true)
      before = await toggle($, '')
    } finally {
      release()
    }
    await advancing
    const after = await toggle($, '')
    expect(before).toContain(`${REFRESH} every 4 min ${REBUILD}`)
    expect(after).toContain(`${REFRESH} every 4 min ${REBUILD}`)
  })

  test('a cache expired, its stop recorded: the refresh cost, and directly after it the interval row', async ($, on) => {
    const clock = await started($, on)
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(310000)
    await turnEnd($)
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  paused cache expired · resumes on next prompt')
    expect(text).toContain(`${EXPIRED_REFRESH} every 4 min`)
  })

  test('a cache expired, its stop not yet recorded: the refresh cost, and directly after it the interval row', async ($, on) => {
    kaWorld(on, opusCached())
    const { held, release } = holdingStop(on, 'cache expired')
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    // The turn runs through the cache's expiry: the stop is written at that tick, and the hold keeps it unrecorded while the clock runs on.
    await clock.advance(310000)
    try {
      expect(held.holding).toBe(true)
      expect(await toggle($, '')).toContain(`${EXPIRED_REFRESH} every 4 min`)
    } finally {
      release()
      await clock.settle()
    }
  })

  test('a learned count of none whose cache expired, its stop recorded: the refresh cost, and directly after it the interval row', async ($, on) => {
    const clock = await started($, on, { ...opusCached(), store: LONG })
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(310000)
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  paused cache expired · resumes on next prompt')
    expect(text).toContain(`${EXPIRED_REFRESH} every 4 min`)
  })

  test('a learned count of none whose cache expired, its stop not yet recorded: the refresh cost, and directly after it the interval row', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: LONG })
    const { held, release } = holdingStop(on, 'cache expired')
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(310000)
    try {
      expect(held.holding).toBe(true)
      expect(await toggle($, '')).toContain(`${EXPIRED_REFRESH} every 4 min`)
    } finally {
      release()
      await clock.settle()
    }
  })

  test('keepalive on with no reading to count from: the sentence is absent', async ($, on) => {
    await started($, on, { text: '', exists: false })
    await toggle($, 'on 15')
    const text = await toggle($, '')
    expect(text).toContain('Keepalive  on, no count')
    expect(text.split(SENTENCE).length - 1).toBe(0)
  })
})

describe('the best setup: one sentence, in the pane and in the bare command, priced over this session or recent pauses', () => {
  // Ten ten-minute pauses, each with a million tokens written: on 5 m keepalive costs $5.04 a pause, off $5.48, 1 h $8.00.
  const pauseOf = (i: number, startMs = 1000 + i) => ({ startMs, pausedMs: 10 * MIN, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000, contextTokens: 100000, grownTokens: 1000000 })
  // The block these pauses give while keepalive is off: the setup you are on, the change to keepalive on, and the click that makes it.
  const CHANGE = ['setup: 5m/off', 'best: 5m/on · would have saved $4.40 (10 recent pauses)', 'do: /keepalive on 15 or click pie on']

  test('the bare command opens its Advice section with the block, each row one line of the section', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(sectionLines(await commandText($, ''), 'Advice')?.slice(0, 3)).toEqual(CHANGE)
    const rows = await paneRows($)
    expect(rows.slice(rows.indexOf('Advice') + 1, rows.indexOf('Advice') + 4)).toEqual(CHANGE)
  })

  test('keepalive on at a lead not below the TTL: the block names the setup paused, with the reason the Keepalive section gives', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await commandText($, 'on 300')
    await clock.advance(1000)
    // A run that sends nothing costs what keepalive off does, so the paused setup is optimal and the block states the baseline.
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(['setup: 5m/paused (lead 300s ≥ 300s TTL) (optimal)', '5m/off ≈ same cost (10 recent pauses)'])
  })

  test('the details pane carries the block, each row whole, in its Advice section', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const rows = await paneRows($)
    const advice = rows.indexOf('Advice')
    expect(advice).toBeGreaterThanOrEqual(0)
    expect(rows.slice(advice + 1, advice + 4)).toEqual(CHANGE)
    // The pane draws the best row whole, wider than the 48 columns the command wraps its rows to.
    expect(rows[advice + 2]!.length).toBeGreaterThan(48)
    expect(widthOf((await commandText($, '')).split('\n'))).toBeLessThanOrEqual(48)
  })

  test('while keepalive is off, its "on" setups are priced at the lead and count a click on the pie would send', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    // One pinned refresh cannot hold a ten-minute pause, so a click that sends it would cost more than keepalive off.
    await commandText($, 'on 30 1')
    await commandText($, 'off')
    await clock.advance(1000)
    const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
    expect(text).toContain('Advice ')
    // The click is the block's own words (the first test of this group draws it): none is advised here.
    expect(text).not.toContain('click pie on')
  })

  test('an "on" setup at the other TTL is priced at the defaults a new session starts with, not this session\'s last run', { options: { keepalive_count: 1 } }, async ($, on) => {
    // 150-minute pauses with no growth: a 1 h cache holds one for two refreshes at a 60 s lead pinned at 2, but a new session runs the
    // 15 s lead and the count capped at 1, which cannot hold it, so 1 h on costs what 1 h off does there.
    const long = Array.from({ length: 10 }, (_, i) => ({ ...pauseOf(i), pausedMs: 150 * MIN, grownTokens: 0 }))
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': long } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await commandText($, 'on 60 2')
    await commandText($, 'off')
    await clock.advance(1000)
    const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
    // The count capped at 1 cannot hold the pauses at 1 h, so no row names 1h/on (the change test below, without the cap, draws it).
    expect(text).not.toContain('1h/on')
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(['setup: 5m/off (optimal)', 'saves ~$3.00 vs 1h/off (10 recent pauses)'])
  })

  test('every session\'s pauses are read with at most eight store reads running, and all of them are priced', async ($, on) => {
    // Twenty sessions' keys, one pause each: more than the readers, so some read only after another has landed.
    const store = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`pauses/k${i}`, [pauseOf(i)]]))
    let running = 0
    let most = 0
    const getGate = (key: string) => {
      if (!key.startsWith('pauses/k')) return undefined
      most = Math.max(most, ++running)
      return (async () => {
        for (let i = 0; i < 5; i++) await null
        running--
        return undefined
      })()
    }
    kaWorld(on, { ...opusCached(), store, getGate })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(most).toBe(8)
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(['setup: 5m/off', 'best: 5m/on · would have saved $8.80 (20 recent pauses)', 'do: /keepalive on 15 or click pie on'])
  })

  test('a pause another session\'s key has since dropped is not brought back by a later load', async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/x': Array.from({ length: 6 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(6 recent pauses/)
    // The other session's key trims its oldest pauses at its own bound: the store keeps three.
    rec.store.set('pauses/x', Array.from({ length: 3 }, (_, i) => pauseOf(i)))
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    // The three are too few to price, and the three dropped ones are not read back from memory.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).not.toMatch(/recent pauses/)
  })

  test('a refused store read stops the history read: no reader takes another key once one is refused', async ($, on) => {
    const store = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`pauses/k${i}`, [pauseOf(i)]]))
    const rec = kaWorld(on, { ...opusCached(), store, getDenied: new Set(['pauses/k0']) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    // The first wave of readers is in flight when k0 is refused; none of them reads on after it.
    expect(rec.gets.filter((key: string) => key.startsWith('pauses/k')).length).toBeLessThanOrEqual(8)
    expect(rec.logs.filter((l: string) => l.includes('read refused'))).toHaveLength(1)
  })

  // 150-minute pauses with no growth: on 5 m each pays its rewrite ($0.48), with keepalive off or on at its learned count of none; at 1 h
  // keepalive on holds each for two reads ($0.04). A change to 1 h with keepalive on saves $4.40 over ten.
  const longPauses = Array.from({ length: 10 }, (_, i) => ({ ...pauseOf(i), pausedMs: 150 * MIN, grownTokens: 0 }))
  const TO_1H_ON = 'best: 1h/on · would have saved $4.40 (10 recent pauses)'
  const SET_1H = 'set "promptCacheTtl": "1h" in settings.json'

  test('a change of TTL says to click the pie on when new sessions start keepalive off, though it is on here', { options: { keepalive_default: 'off' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': longPauses } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await commandText($, 'on 15')
    await clock.advance(1000)
    const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
    expect(text).toContain('Keepalive  paused')
    const step = `do: ${SET_1H} (new sessions start off: keepalive_default); then /keepalive default on before the new session, or in it /keepalive on 15 or click pie on`
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(['setup: 5m/on', TO_1H_ON, step])
    expect(await paneRows($)).toContain(step)
    const rows = (await commandText($, '')).split('\n')
    expect(rows.every((row) => row.length <= 48)).toBe(true)
    expect(rows.some((row) => row.includes('/keepalive on 15'))).toBe(true)
    expect(rows.some((row) => row.includes('/keepalive default on'))).toBe(true)
    expect((await paneRows($)).some((row) => row.includes('/keepalive on 15') && row.includes('/keepalive default on'))).toBe(true)
  })

  test('a change of TTL needs no click when new sessions start keepalive as the change wants', { options: { keepalive_default: 'on' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': longPauses } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    // The step is the setting with the new-session start alone: no default to set and no click, as that start is the change's own.
    expect(sectionLines(await commandText($, ''), 'Advice')?.slice(0, 3)).toEqual(['setup: 5m/on', TO_1H_ON, `do: ${SET_1H} (new sessions start on: keepalive_default)`])
  })

  test('with no recorded pause there is no sentence, in the pane or the command', async ($, on) => {
    kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    // Every block opens with its setup row, which a block of `saves … vs` or `≈ same cost` rows has where `would have saved` is absent.
    expect(await commandText($, '')).not.toMatch(/setup: |would have saved/)
    expect(await drawnPane($)).not.toMatch(/setup: |would have saved/)
  })

  test('a cold cache drops the sentence while the cold mark stands, as the break-even line does', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const warm = await paneRows($)
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(1000)
    expect(await drawnPane($)).not.toMatch(/setup: |would have saved/)
    expect(warm).toContain('best: 5m/on · would have saved $4.40 (10 recent pauses)')
  })

  test("this session's pauses are the ones under its transcript's key: on another transcript they are recent, and the sentence says so", async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(['setup: 5m/off', 'best: 5m/on · would have saved $2.20 (5 pauses this session)', 'do: /keepalive on 15 or click pie on'])
    // A resume onto another transcript: a new session with no pauses under its key, and no cold mark as a clear would leave.
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/test/.claude/projects/p/s3.jsonl' })
    await clock.advance(1000)
    expect(sectionLines(await commandText($, ''), 'Advice')).toEqual(['setup: 5m/off', 'best: 5m/on · would have saved $2.20 (5 recent pauses)', 'do: /keepalive on 15 or click pie on'])
  })

  test("a pause the last transcript's prompt ended is not counted in the pauses of a transcript learned while it was written", async ($, on) => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    // The second read of the first transcript's key is the pause's write; the first is that transcript's own pauses, read at its start.
    kaWorld(on, { ...opusCached(), store: { 'pauses/s3': Array.from({ length: 4 }, (_, i) => pauseOf(i)), 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i, 5000 + i)) }, getHold: { key: 'pauses/s1', hold, nth: 2 } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    // The prompt's pause write waits on the held read: the resume lands meanwhile.
    const prompted = userPrompt($)
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/test/.claude/projects/p/s3.jsonl' })
    await clock.advance(1000)
    release()
    await prompted
    await clock.advance(1000)
    const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
    expect(text).toMatch(/\(\d+ recent pauses/)
    expect(text).not.toMatch(/pauses this session/)
  })

  test("a pause a prompt ends while this session's key is still being read stays in this session's pauses", async ($, on) => {
    let release!: () => void
    const S0 = '/home/test/.claude/projects/p/s0.jsonl'
    on('classic.UserPromptSubmit', () => ({}))
    const hold = new Promise<void>((resolve) => (release = resolve))
    // The session starts on another transcript, so the history's read of pauses/s1 (the first) is answered before this transcript is
    // learned; the second read is the learn's, and it is the one held.
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, getHold: { key: 'pauses/s1', hold, nth: 2 } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: S0 })
    await clock.advance(10 * MIN)
    await $.classic.UserPromptSubmit({ transcript_path: PATH, prompt: 'hi' } as any)
    await clock.advance(1000)
    await userPrompt($)
    release()
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
  })

  test("a pause a prompt ends while every session's pauses are still being read stays in the recent pauses once the read lands", async ($, on) => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    // The history's read of another session's key is held: it listed the keys before this session's key held the pause.
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, getHold: { key: 'pauses/old', hold } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    release()
    await clock.advance(1000)
    // This session's one pause is too few to price alone: the sentence prices the recent pauses, the four read and the one ended.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 recent pauses/)
  })

  test('a key read as stale is not deleted once a pause a prompt ended while the read ran is written under it', async ($, on) => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    // This session's key holds one pause older than the newest 2000, so the history's read finds it stale; that read is held past the prompt.
    const recent = Array.from({ length: 2000 }, (_, i) => pauseOf(i, 1000 + i))
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': [pauseOf(0, 1)], 'pauses/recent': recent }, getHold: { key: 'pauses/recent', hold } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(5000)
    await userPrompt($)
    await clock.advance(1000)
    release()
    await clock.advance(1000)
    expect(rec.store.get('pauses/s1')).toHaveLength(2)
  })

  test("a pause whose write to the store failed stays in the recent pauses when every session's pauses are read again", async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, setDenied: new Set(['pauses/s1']) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    // A resume onto the same transcript reads every session's pauses again; the store never kept this one.
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 recent pauses/)
  })

  test("a pause held only in memory is kept when another session's pause read again starts at the same moment", async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, setDenied: new Set(['pauses/s1']) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    // Another session's pause, which started at this one's start: a different pause, of its own length and context.
    rec.store.set('pauses/other', [{ ...pauseOf(0, T0), pausedMs: 3 * MIN, contextTokens: 50000 }])
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(6 recent pauses/)
  })

  test("after a reload, a pause a prompt ends before any path is learned stays this session's when the learn's read is answered before its write lands", async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    // The pause's write to this transcript's key is held, so the learn's read of that key is answered without it.
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, setHold: { key: 'pauses/s1', hold } })
    // The reload: the state still holds the transcript an earlier load learned and the cache it read, and this load has learned no path yet.
    const kept: Record<string, unknown> = {
      transcript: PATH,
      view: { kind: 'known', touchMs: T0, ttlMs: 300000, ttlLabel: '5m', promptTokens: 18551, outputTokens: 0, model: 'claude-opus-5-5', speed: 'standard' },
    }
    on('state.get', async (_$: any, e: any, next: any) => {
      const got = await next(e)
      // A read answers `{ value: { value, version } }`: a value never written is filled in from the earlier load's.
      return e.plugin === 'cachier' && e.key in kept && got.value?.value === undefined ? { value: { ...got.value, value: kept[e.key] } } : got
    })
    const clock = mock.clock(on, { now: T0 })
    await clock.advance(10 * MIN)
    const prompted = userPrompt($)
    await clock.advance(1000)
    await $.classic.UserPromptSubmit({ transcript_path: PATH, prompt: 'hi' } as any)
    await clock.advance(1000)
    release()
    await prompted
    await clock.advance(1000)
    // The pause was recorded under this transcript's key, after the learn's read.
    expect(rec.store.get('pauses/s1')).toHaveLength(5)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
  })

  test("a pause kept before the first learn, under the transcript a reload's state names, is not carried onto another transcript learned first", async ($, on) => {
    const S3 = '/home/test/.claude/projects/p/s3.jsonl'
    on('classic.UserPromptSubmit', () => ({}))
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 4 }, (_, i) => pauseOf(i)), 'pauses/s3': Array.from({ length: 4 }, (_, i) => pauseOf(i, 5000 + i)) } })
    // The reload: the state still names the transcript an earlier load learned and the cache it read, and this load has learned no path yet.
    const kept: Record<string, unknown> = {
      transcript: PATH,
      view: { kind: 'known', touchMs: T0, ttlMs: 300000, ttlLabel: '5m', promptTokens: 18551, outputTokens: 0, model: 'claude-opus-5-5', speed: 'standard' },
    }
    on('state.get', async (_$: any, e: any, next: any) => {
      const got = await next(e)
      return e.plugin === 'cachier' && e.key in kept && got.value?.value === undefined ? { value: { ...got.value, value: kept[e.key] } } : got
    })
    const clock = mock.clock(on, { now: T0 })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    // The pause was kept under the transcript the state names.
    expect(rec.store.get('pauses/s1')).toHaveLength(5)
    await $.classic.SessionStart({ source: 'resume', transcript_path: S3 })
    await clock.advance(1000)
    // s3's own four pauses are too few to price as this session's: the pause stayed with s1's key.
    const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
    expect(text).not.toMatch(/pauses this session/)
  })

  test("a pause a prompt ends once a new transcript is learned, before the state names it, is that transcript's", async ($, on) => {
    const S3 = '/home/test/.claude/projects/p/s3.jsonl'
    on('classic.UserPromptSubmit', () => ({}))
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s3': Array.from({ length: 4 }, (_, i) => pauseOf(i)) } })
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    let holding = false
    // The learn's write of the new transcript to the state is held: the mod knows the new path, and the state still names the old one.
    on('state.set', async (_$: any, e: any, next: any) => {
      if (holding && e.plugin === 'cachier' && e.key === 'transcript') await hold
      return next(e)
    })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    holding = true
    await $.classic.UserPromptSubmit({ transcript_path: S3, prompt: 'hi' } as any)
    await clock.advance(1000)
    await userPrompt($)
    release()
    await clock.advance(1000)
    expect(rec.store.get('pauses/s1')).toBeUndefined()
    expect(rec.store.get('pauses/s3')).toHaveLength(5)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
  })

  test("this session's pauses are bounded as its key is: a pause past the bound drops the oldest, and the sentence prices all that are kept", async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: HISTORY_BOUND }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    expect(rec.store.get('pauses/s1')).toHaveLength(HISTORY_BOUND)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(new RegExp(`\\(${HISTORY_BOUND} pauses this session`))
  })

  test("a failed read of this session's key is made again by a later tick, and the sentence then prices this session's pauses", async ($, on) => {
    const getDenied = new Set(['pauses/s1'])
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)), 'pauses/other': Array.from({ length: 10 }, (_, i) => pauseOf(i, 5000 + i)) }, getDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).not.toMatch(/pauses this session/)
    getDenied.clear()
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
  })

  test("a read of this session's key that keeps failing is reported once, not on every tick that reads it again", async ($, on) => {
    const getDenied = new Set(['pauses/s1'])
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)) }, getDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const refused = () => rec.logs.filter((l: string) => l.includes('read refused')).length
    const first = refused()
    expect(first).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) await clock.advance(1000)
    expect(refused()).toBe(first)
    getDenied.clear()
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
  })

  test("an earlier transcript's read that fails after another is learned leaves the held one's failing retries reported once", async ($, on) => {
    const S3 = '/home/test/.claude/projects/p/s3.jsonl'
    const getDenied = new Set(['pauses/s3'])
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    // A read of the first transcript's key waits, then is refused with its own reason, so its failure is told apart.
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)) }, getDenied, getHeldDenied: { key: 'pauses/s1', hold, deny: 'stale refused' } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: S3 })
    await clock.advance(1000)
    const refused = () => rec.logs.filter((l: string) => l.includes('read refused')).length
    const first = refused()
    expect(first).toBeGreaterThan(0)
    // The first transcript's read fails now, after the second was learned: the second's retries stay unreported.
    release()
    await clock.advance(1000)
    expect(rec.logs.some((l: string) => l.includes('stale refused'))).toBe(true)
    for (let i = 0; i < 3; i++) await clock.advance(1000)
    expect(refused()).toBe(first)
  })

  test("a transcript learned again after another keeps this session's pause whose write to its key failed", async ($, on) => {
    const S3 = '/home/test/.claude/projects/p/s3.jsonl'
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, setDenied: new Set(['pauses/s1']) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
    await $.classic.SessionStart({ source: 'resume', transcript_path: S3 })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    // The key holds four pauses; the fifth, whose write was refused, is the one this load held for the transcript.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
  })

  test("a refused pause stays this session's after sixteen other transcripts are learned, as nothing drops a pause but a reload", async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 4 }, (_, i) => pauseOf(i)) }, setDenied: new Set(['pauses/s1']) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    const visit = async (n: number) => {
      await $.classic.SessionStart({ source: 'resume', transcript_path: `/home/test/.claude/projects/p/o${n}.jsonl` })
      await clock.advance(1000)
    }
    const back = async () => {
      await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
      await clock.advance(1000)
      return (await commandText($, '')).replace(/\n\s*/g, ' ')
    }
    // Sixteen others learned after it: the refused pause is unsaved, so it is still this session's with the key's four.
    for (let n = 0; n < 16; n++) await visit(100 + n)
    expect(await back()).toMatch(/\(5 pauses this session/)
  })

  test("a transcript learned again after another, whose key's read then fails, is read again by a later tick, and until then prices none of it as this session's", async ($, on) => {
    // The other transcript's key is never read, so the last read that landed is the first transcript's.
    const getDenied = new Set<string>(['pauses/s3'])
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)) }, getDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(5 pauses this session/)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/test/.claude/projects/p/s3.jsonl' })
    await clock.advance(1000)
    // While the other transcript is held, the first one's key gains a pause this load did not end.
    rec.store.set('pauses/s1', Array.from({ length: 6 }, (_, i) => pauseOf(i)))
    getDenied.add('pauses/s1')
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    // The read failed, and this session has no pause of its own to add to the key's: the sentence prices the recent pauses.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).not.toMatch(/pauses this session/)
    getDenied.clear()
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/\(6 pauses this session/)
  })

  test("a transcript learned again while its earlier read still runs is read once more, not again by each tick, when the earlier read fails", async ($, on) => {
    let release1!: () => void
    let release2!: () => void
    const hold1 = new Promise<string | undefined>((resolve) => (release1 = () => resolve('first refused')))
    const hold2 = new Promise<string | undefined>((resolve) => (release2 = () => resolve(undefined)))
    const rec = kaWorld(on, { ...opusCached(), getGate: (key: string, nth: number) => (key !== 'pauses/s1' ? undefined : nth === 1 ? hold1 : nth === 2 ? hold2 : undefined) })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/test/.claude/projects/p/s3.jsonl' })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    // The first read fails while the second still runs: the ticks find a read of the held path running, and make none.
    release1()
    for (let i = 0; i < 3; i++) await clock.advance(1000)
    expect(rec.gets.filter((key: string) => key === 'pauses/s1')).toHaveLength(2)
    release2()
    await clock.advance(1000)
  })

  test("an open pane drawn while this session's key is still being read re-prices over this session's pauses once the read returns, with no tick", async ($, on) => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)), 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i, 5000 + i)) }, getHold: { key: 'pauses/s1', hold } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    expect(JSON.stringify(await pane.drawn())).toMatch(/\(15 recent pauses/)
    release()
    // No time passes, so no tick draws the footer state again: the read's return alone draws the pane again.
    await clock.advance(0)
    expect(JSON.stringify(await pane.drawn())).toMatch(/\(5 pauses this session/)
    await pane.unmount()
  })

  test("an open pane drawn while every session's pauses are still being read prices them once the read returns, with no tick", async ($, on) => {
    let release!: () => void
    const keysHold = new Promise<void>((resolve) => (release = resolve))
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i, 5000 + i)) }, keysHold })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const pane = await mountPane($)
    expect(JSON.stringify(await pane.drawn())).not.toMatch(/recent pauses/)
    release()
    await clock.advance(0)
    expect(JSON.stringify(await pane.drawn())).toMatch(/\(10 recent pauses/)
    await pane.unmount()
  })
})

describe('the rebuild figure: one figure on the footer, the pane and the bare command, over the prefix and the last reply\'s output', () => {
  const expired = () => ({
    text: lines([
      user({ uuid: 'u1', parent: null, ts: iso(T0) }),
      assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, out: 7000, tags: FIVE, model: 'claude-opus-5-5', speed: 'standard' }),
    ]),
  })
  const start = async ($: any, on: any) => {
    kaWorld(on, expired())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
  }

  test('in dollars the footer, the pane and the bare /keepalive give the same figure, which prices the output too', async ($, on) => {
    await start($, on)
    // 18551 + 7000 tokens at the $5/M 5-minute write rate; the prefix alone would be ~$0.09.
    expect(await hint($)).toBe('~$0.13 to rebuild')
    expect(await drawnPane($)).toContain('expired · rebuild ~$0.13')
    expect(await toggle($, '')).toContain('expired · rebuild ~$0.13')
  })

  test('in tokens the three give the same figure, the prefix plus the output', async ($, on) => {
    await start($, on)
    await toggle($, 'unit tokens')
    // 25551 tokens; the prefix alone would be ~19k.
    expect(await hint($)).toBe('~26k tokens to rebuild')
    expect(await drawnPane($)).toContain('expired · rebuild ~26k tokens')
    expect(await toggle($, '')).toContain('expired · rebuild ~26k tokens')
  })
})

describe("a warm cache of 1h TTL", () => {
  test('the Cache line reads its time left and `1h TTL`, on the pane and the bare answer', async ($, on) => {
    kaWorld(on, cached(ONE_HOUR))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).split('\n').some((line: string) => /^ {2}● warm · \d+:\d\d:?\d* left · 1h TTL$/.test(line))).toBe(true)
    expect((await paneRows($)).some((row: string) => /^● warm · \d+:\d\d:?\d* left · 1h TTL$/.test(row))).toBe(true)
  })
})

describe("the rebuild figure under a cold mark: priced at the model that last wrote the cache, and the bare answer says why a figure is in tokens", () => {
  const SWITCH = { from_model: 'claude-opus-5-5', to_model: 'claude-opus-5-5-next', requested_model: 'x', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any
  // The stored cache: 18551 tokens written and 7000 output, so 25551 tokens to rebuild. A named model with a price, unless given.
  const stored = (o: { model?: string | null; speed?: string; tags?: { five: number; one: number } } = {}) => ({
    text: lines([
      user({ uuid: 'u1', parent: null, ts: iso(T0) }),
      assistant({ uuid: 'a1', parent: 'u1', ts: iso(T0), write: 18551, out: 7000, tags: o.tags ?? FIVE, model: o.model === null ? undefined : (o.model ?? 'claude-opus-5-5'), speed: o.speed ?? 'standard' }),
    ]),
  })
  // The cold mark of a model switch (to `to`) or a compaction, held over the stored cache: nothing touches the cache after it.
  const held = async ($: any, on: any, doc: any, by: 'switch' | 'compaction' = 'switch', to = 'claude-opus-5-5-next') => {
    kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 1000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    if (by === 'switch') await $.classic.PostModelSwitch({ ...SWITCH, to_model: to })
    else await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(1000)
    return clock
  }
  const surfaces = async ($: any, figure: string) => {
    expect(await hint($)).toBe('reset')
    expect(await drawnPane($)).toContain(`reset · rebuild ${figure}`)
    expect(await toggle($, '')).toContain(`reset · rebuild ${figure}`)
  }

  test('a model switch held over a priced model: the pane and the bare answer give the figure in dollars', async ($, on) => {
    await held($, on, stored())
    // 25551 tokens at Opus 5.5's $5/M 5-minute write rate.
    await surfaces($, '~$0.13')
    expect(await toggle($, '')).not.toContain('in tokens:')
  })

  test('a compaction held over a priced model: the same figure in dollars', async ($, on) => {
    await held($, on, stored(), 'compaction')
    await surfaces($, '~$0.13')
  })

  test('a cold mark over an unread view has a reset Cache line with no figure, on the pane and the bare answer', async ($, on) => {
    kaWorld(on, { text: '', broken: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.PostModelSwitch(SWITCH)
    await clock.advance(1000)
    expect((await commandText($, '')).split('\n')).toContain('  ○ reset')
    expect(await paneRows($)).toContain('○ reset')
  })

  test("the figure is the stored cache's TTL's write rate", async ($, on) => {
    await held($, on, stored({ tags: { five: 0, one: 18551 } }))
    // 25551 tokens at Opus 5.5's $8/M 1-hour write rate.
    await surfaces($, '~$0.20')
  })

  test('the figure is the one the same view gives with no cold mark once it has expired', async ($, on) => {
    kaWorld(on, stored())
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('expired · rebuild ~$0.13')
    await $.classic.PostModelSwitch(SWITCH)
    await clock.advance(1000)
    await surfaces($, '~$0.13')
  })

  test('after a switch between differently priced models the figure is at the model switched from', async ($, on) => {
    // Sonnet 5.5 writes at $2.50/M, Opus 5.5 at $5/M; the stored cache was written by Opus.
    await held($, on, stored(), 'switch', 'claude-sonnet-5-5')
    await surfaces($, '~$0.13')
    expect(await toggle($, '')).not.toContain('~$0.064')
  })

  test('in tokens the pane and the bare answer give the token figure', async ($, on) => {
    const clock = await held($, on, stored())
    await toggle($, 'unit tokens')
    await clock.advance(1000)
    await surfaces($, '~26k tokens')
    expect(await toggle($, '')).not.toContain('in tokens:')
  })

  describe('in dollars, a stored view with no price gives the token figure and the bare answer says why', () => {
    const cases: [string, Parameters<typeof stored>[0], string][] = [
      ['a model with no price', { model: 'claude-nonesuch-1' }, 'no price for claude-nonesuch-1'],
      ['fast mode', { speed: 'fast' }, 'no price for fast mode'],
      ['no model named', { model: null }, 'no price for an unnamed model'],
    ]
    for (const [name, o, why] of cases) {
      test(name, async ($, on) => {
        await held($, on, stored(o))
        await surfaces($, '~26k tokens')
        expect(sectionLines(await commandText($, ''), 'Advice')).toContain(`in tokens: ${why}`)
      })
    }
  })

  test('an expired cache on an unpriced model has the one reason line, as before', async ($, on) => {
    kaWorld(on, stored({ model: 'claude-nonesuch-1' }))
    const clock = mock.clock(on, { now: T0 + 400000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const answer = await toggle($, '')
    expect(answer).toContain('expired · rebuild ~26k tokens')
    expect(answer.split('in tokens:').length).toBe(2)
    expect(sectionLines(await commandText($, ''), 'Advice')?.filter((row) => row === 'in tokens: no price for claude-nonesuch-1')).toHaveLength(1)
  })

  test('after /clear over a known stored view with no price: no Cache section, no pane warmth line and no reason line', async ($, on) => {
    kaWorld(on, stored({ model: 'claude-nonesuch-1' }))
    const clock = mock.clock(on, { now: T0 + 1000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
    await clock.advance(1000)
    const answer = await commandText($, '')
    expect(answer.startsWith('Keepalive')).toBe(true)
    expect(answer).not.toContain('in tokens:')
    const rows = await paneRows($)
    expect(rows.filter((row: string) => row === 'Cache' || /^\s*([○◔◑◕●] )?(warm|expired|reset)\b/.test(row))).toEqual([])
    expect(rows.join('\n')).not.toMatch(/[○◔◑◕●]/)
    expect(answer).not.toMatch(/[○◔◑◕●]/)
  })
})

describe('a model switch counts as a reset only on a cache cachier read as warm', () => {
  const TTL = 300000
  const SW = { from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any
  const at = (s: number) => iso(T0 + s * 1000)
  // The last value the mod wrote to each state key, and whether the view reads as unread.
  const wrote: Record<string, any> = {}
  let unread = false
  let broken = false
  const watch = (on: any) => {
    for (const k of Object.keys(wrote)) delete wrote[k]
    unread = false
    broken = false
    on('state.set', (_$: any, e: any, next: any) => {
      wrote[e.key] = e.value
      return next(e)
    })
    on('state.get', (_$: any, e: any, next: any) => (broken && e.key === 'view' ? { deny: 'read refused' } : unread && e.key === 'view' ? { value: { kind: 'unread' }, version: 1 } : next(e)))
  }
  const held = (key: string): any => wrote[key]
  let snapshot: number[] = []

  // A first reply, a main-thread request at T0+1s (the live touch), then `setup`, the switch, and a missing reply 400s later.
  const scenario = async ($: any, on: any, opts: { afterMs: number; engineWarm?: boolean; setup?: (rec: any, doc: any) => Promise<void>; undo?: (rec: any) => void; withReply?: boolean }) => {
    const doc: any = {
      text: lines([
        user({ uuid: 'u0', parent: null, ts: at(-60) }),
        assistant({ uuid: 'a0', parent: 'u0', ts: at(-59), write: 5, tags: FIVE, msg: 'm0' }),
        user({ uuid: 'u1', parent: 'a0', ts: at(0) }),
        assistant({ uuid: 'a1', parent: 'u1', ts: at(0.5), read: 20000, write: 100, tags: FIVE, msg: 'm1' }),
      ]),
    }
    watch(on)
    const rec = kaWorld(on, doc)
    const clock = mock.clock(on, { now: T0 + 1000 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await mainStep($)
    await turnEnd($)
    await clock.advance(opts.afterMs)
    await opts.setup?.(rec, doc)
    await $.classic.PostModelSwitch({ ...SW, prompt_cache_warm: opts.engineWarm ?? true })
    snapshot = wrote.stats?.coldSince ?? []
    opts.undo?.(rec)
    await clock.advance(1000)
    if (opts.withReply !== false) {
      await clock.advance(400000)
      doc.text += lines([
        user({ uuid: 'u2', parent: 'a1', ts: iso(T0 + 1000 + opts.afterMs + 399000) }),
        assistant({ uuid: 'b1', parent: 'u2', ts: iso(T0 + 1000 + opts.afterMs + 400500), read: 0, write: 20100, tags: FIVE, msg: 'm2' }),
      ])
      await mainStep($)
      await turnEnd($)
      await clock.advance(1000)
    }
    return { rec, clock, doc }
  }
  const causes = (rec: any) => debugOf(rec, 'cachier miss').map((m: any) => m.cause)
  const lineOf = (rec: any) => debugOf(rec, 'cachier switch')

  test('a cache read as expired at the switch makes the next miss a lapse and adds nothing to the reset times', async ($, on) => {
    const { rec } = await scenario($, on, { afterMs: TTL + 10000 })
    expect(snapshot).toEqual([])
    expect(held('cold')).toBeDefined()
    expect(causes(rec)).toEqual(['lapse'])
  })

  test('a cache read as warm makes the next miss a reset miss', async ($, on) => {
    const { rec } = await scenario($, on, { afterMs: 120000 })
    expect(snapshot).toHaveLength(1)
    expect(causes(rec)).toEqual(['cold'])
  })

  test('the reading decides, not the engine: warm read with the engine saying not warm is a reset', async ($, on) => {
    const { rec } = await scenario($, on, { afterMs: 120000, engineWarm: false })
    expect(snapshot).toHaveLength(1)
    expect(causes(rec)).toEqual(['cold'])
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: false, reading: 'warm' }])
  })

  test('an expired read with the engine saying warm adds nothing', async ($, on) => {
    const { rec } = await scenario($, on, { afterMs: TTL + 10000, engineWarm: true })
    expect(snapshot).toEqual([])
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: true, reading: 'expired' }])
  })

  test('the reading is warm one millisecond inside the TTL, counting from the live touch', async ($, on) => {
    await scenario($, on, { afterMs: TTL - 1, withReply: false })
    expect(snapshot).toHaveLength(1)
  })

  test('the reading is not warm at the TTL\'s end', async ($, on) => {
    const { rec } = await scenario($, on, { afterMs: TTL, withReply: false })
    expect(snapshot).toEqual([])
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: true, reading: 'expired' }])
  })

  test('a switch with no cache adds nothing', async ($, on) => {
    watch(on)
    const rec = world(on, { text: '' })
    mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await $.classic.PostModelSwitch(SW)
    expect(wrote.stats?.coldSince ?? []).toEqual([])
    expect(held('cold')).toBeDefined()
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: true, reading: 'none' }])
  })

  test('a switch after /clear adds nothing beyond the clear\'s own reset time', async ($, on) => {
    const { rec } = await scenario($, on, {
      afterMs: 1000,
      withReply: false,
      setup: async () => {
        await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
      },
    })
    expect(snapshot.length).toBe(1)
    expect(lineOf(rec)[0].reading).toBe('none')
  })

  test('a switch with an unread view adds nothing', async ($, on) => {
    const { rec } = await scenario($, on, {
      afterMs: 1000,
      withReply: false,
      setup: async () => void (unread = true),
    })
    expect(snapshot).toEqual([])
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: true, reading: 'none' }])
  })

  test('a switch while a compaction mark stands adds nothing, and the next miss is still a reset miss', async ($, on) => {
    const { rec } = await scenario($, on, {
      afterMs: 1000,
      setup: async () => {
        await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
      },
    })
    expect(snapshot).toHaveLength(1)
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: true, reading: 'cold' }])
    expect(causes(rec)).toEqual(['cold'])
  })

  test('a reading that throws writes the mark, adds nothing and does not fail the hook', async ($, on) => {
    const { rec } = await scenario($, on, {
      afterMs: 1000,
      withReply: false,
      setup: async () => void (broken = true),
      undo: () => void (broken = false),
    })
    expect(snapshot).toEqual([])
    expect(lineOf(rec)).toEqual([{ prompt_cache_warm: true, reading: 'unread' }])
    expect(held('cold')).toBeDefined()
  })

  for (const [what, from, source] of [['a resume', 'a', 'resume'], ['a switch to the model in use', 'b', 'command']] as const) {
    test(`${what} writes no debug line`, async ($, on) => {
      const rec = world(on, { text: '' })
      mock.clock(on, { now: T0 })
      await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
      await $.classic.PostModelSwitch({ ...SW, from_model: from, source })
      expect(lineOf(rec)).toEqual([])
    })
  }

  test('after a switch no refresh is sent until the next reply', { options: { keepalive_lead_s: 60, keepalive_count: 9 } }, async ($, on) => {
    const { rec } = await scenario($, on, {
      afterMs: TTL + 10000,
      withReply: false,
      setup: async () => void (await toggle($, 'on 60 3')),
    })
    expect(rec.forks).toEqual([])
  })
})

// The old pane's lines as each state must still draw them, held as literals since the builders that gave them are retired: the cache's warmth, the
// advice (its block of rows, joined with a space as a section is read), the status line (its status words are not compared; its reason and colour
// sentence are the Keepalive section's rows), the refresh figure and the interval, the break-even line and the session line.
// The pie-colour row the old pane ended its off and paused status lines with. The sections draw it with keepalive off only, so the paused rows below leave it
// out of their status, and the check below finds it in the off rows and absent from every row with keepalive on.
const COLOUR = 'pie: amber ≤¼ TTL left, red ≤⅒'
type OldPane = { advice?: string; warmth?: string; status: string; explain?: string; figures?: string; breakEven?: string; session?: string }
// How a state compares: `literal` finds the refresh row and the interval row, each of its own; `running` finds both in the one warm refresh row; `interval` finds the
// interval row and the refresh row as `explainBy`. `reasonBy` are the fragments a paused reason shares with the section's, when the wording differs. `heading` is the Keepalive heading's state, where the check pins it.
type Scenario = {
  name: string
  old: OldPane
  figure?: 'literal' | 'running' | 'interval'
  explainBy?: string
  reasonBy?: string[]
  heading?: string
  options?: Record<string, number>
  run: ($: any, on: any) => Promise<string[]>
}
const LONG_PAUSES = { 'pauses/old': Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 })) }
const MODEL_SWITCH = { from_model: 'a', to_model: 'b', requested_model: 'b', source: 'command', prompt_cache_warm: true, cache_ttl: '5m', context_tokens: 1, estimated_cache_write_usd: 0, pricing: 'catalog' } as any
// A world started at T0 with its transcript, one second in.
const startedWorld = async ($: any, on: any, doc: any = opusCached()) => {
  kaWorld(on, doc)
  const clock = mock.clock(on, { now: T0 })
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.advance(1000)
  return clock
}
// A state write that waits on a gate once, or is refused, while `matches` holds for it.
const gatedWrite = (on: any, matches: (e: any) => boolean) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = { holding: false, failing: false }
  on('state.set', (_$: any, e: any, next: any) => {
    if (!matches(e)) return next(e)
    if (held.failing) return e.key === 'stats' ? { value: { isSet: false } } : { deny: 'write refused' }
    if (held.holding) return next(e)
    held.holding = true
    return gate.then(() => next(e))
  })
  return { held, release }
}
const isColdWrite = (e: any) => e.key === 'cold' && e.value !== null
const isMarkedStats = (e: any) => e.key === 'stats' && e.value?.coldSince?.length > 0
const isStop = (stop: string) => (e: any) => e.key === 'keepalive' && e.value?.stop === stop
// Keepalive on over a transcript, its turn ended, then `mark` makes the cold mark; the pane is read while its write is held, or after it was refused.
// `phase` is where the first refresh stands when the mark is made: `scheduled` (not yet due), `running` (due, waiting on a turn that is running) or `sent` (its fork in flight).
const coldWrite = (matches: (e: any) => boolean, mark: ($: any) => Promise<unknown>, fail: boolean, phase: 'scheduled' | 'running' | 'sent' = 'scheduled'): Scenario['run'] => async ($, on) => {
  const doc: any = opusCached()
  let freeFork: () => void = () => {}
  if (phase === 'sent') doc.forkHold = new Promise<void>((resolve) => (freeFork = resolve))
  const rec = kaWorld(on, doc)
  const { held, release } = gatedWrite(on, matches)
  const clock = mock.clock(on, { now: T0 })
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.settle()
  await toggle($, 'on 60 2')
  await mainStep($)
  await turnEnd($)
  if (phase === 'scheduled') await clock.advance(100000)
  else if (phase === 'running') {
    await clock.advance(100000)
    await mainStep($)
    await clock.advance(240000)
    expect(rec.forks).toEqual([])
  } else {
    await clock.advance(270000)
    expect(rec.forks.length).toBe(1)
  }
  try {
    if (fail) {
      held.failing = true
      await mark($)
      held.failing = false
      await clock.advance(1000)
      return await paneRows($)
    }
    const marking = mark($)
    await clock.settle()
    try {
      expect(held.holding).toBe(true)
      await clock.advance(1000)
      return await paneRows($)
    } finally {
      release()
      await marking
    }
  } finally {
    freeFork()
    await clock.advance(1000)
  }
}
const SWITCH = ($: any) => $.classic.PostModelSwitch(MODEL_SWITCH)
const COMPACT = ($: any) => $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
// A /clear while keepalive is on over a transcript: the session start's cold mark is held in its write, and the next tick has run.
const clearWrite = (matches: (e: any) => boolean, fail: boolean): Scenario['run'] => async ($, on) => {
  kaWorld(on, opusCached())
  const { held, release } = gatedWrite(on, matches)
  const clock = mock.clock(on, { now: T0 })
  await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
  await clock.settle()
  held.failing = fail
  const clearing = $.classic.SessionStart({ source: 'clear', transcript_path: PATH } as any)
  await clock.settle()
  try {
    await toggle($, 'on 60 2')
    await clock.advance(1000)
    if (!fail) expect(held.holding).toBe(true)
    return await paneRows($)
  } finally {
    held.failing = false
    release()
    await clearing
  }
}
// A pause refreshed once, with the tally and the break-even line to show.
const sessionRun = (then: ($: any, clock: any) => Promise<void>, args = 'on 60 2'): Scenario['run'] => async ($, on) => {
  const clock = await startedWorld($, on)
  await toggle($, args)
  await mainStep($)
  await turnEnd($)
  await clock.advance(240500)
  await clock.advance(1000)
  await then($, clock)
  return paneRows($)
}
// A pane read before any session started, with keepalive turned `args`.
const noStateRun = (args: string): Scenario['run'] => async ($, on) => {
  kaWorld(on, opusCached())
  const clock = mock.clock(on, { now: T0 })
  await toggle($, args)
  await clock.advance(1000)
  return paneRows($)
}
const SCENARIOS: Scenario[] = [
  { name: 'keepalive off with an offer', old: { warmth: 'warm · 4:59 left · 5m TTL', status: `Keepalive is off. ${COLOUR}`, explain: '$0.004 (~19k cached)', figures: 'every 4:45', breakEven: 'pays off if back in 5:00–1:54:00' }, figure: 'literal', run: async ($, on) => (await startedWorld($, on), paneRows($)) },
  { name: 'keepalive off with the best setup advised over ten recent pauses', old: { advice: 'setup: 5m/off best: 5m/on · would have saved $4.40 (10 recent pauses) do: /keepalive on 15 or click pie on', warmth: 'warm · 4:59 left · 5m TTL', status: `Keepalive is off. ${COLOUR}`, explain: '$0.004 (~19k cached)', figures: 'every 4:45', breakEven: 'pays off if back in 5:00–1:54:00' }, figure: 'literal', run: async ($, on) => {
    const pauses = Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 10 * MIN, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000, contextTokens: 100000, grownTokens: 1000000 }))
    await startedWorld($, on, { ...opusCached(), store: { 'pauses/old': pauses } })
    return paneRows($)
  } },
  { name: 'keepalive off with no cache to count from', old: { status: `Keepalive is off. ${COLOUR}` }, run: async ($, on) => (await startedWorld($, on, { text: '', exists: false }), paneRows($)) },
  { name: 'keepalive off with a lead at the TTL, which offers no refresh', old: { warmth: 'warm · 4:59 left · 5m TTL', status: `Keepalive is off. ${COLOUR}`, breakEven: 'never pays off on this context' }, options: { keepalive_lead_s: 300 }, run: async ($, on) => (await startedWorld($, on), expect(await drawnHint($)).toContain('if cold ~$0.09 rebuild'), paneRows($)) },
  { name: 'keepalive off with a learned run count of 0', old: { warmth: 'warm · 4:59 left · 5m TTL', status: `Keepalive is off. ${COLOUR}` }, run: async ($, on) => (await startedWorld($, on, { ...opusCached(), store: LONG_PAUSES }), expect(await drawnHint($)).toContain('if cold ~$0.09 rebuild'), paneRows($)) },
  { name: 'keepalive on and refreshing', old: { warmth: 'warm · 4:58 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4:45', breakEven: 'pays off if back in 5:00–1:54:00' }, figure: 'running', heading: 'on, refreshing', run: async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 15')
    await clock.advance(1000)
    return paneRows($)
  } },
  { name: 'keepalive on with no cache to count from yet', old: { status: 'Keepalive is on, with no cache to count from yet.' }, run: async ($, on) => {
    const clock = await startedWorld($, on, { text: '', exists: false })
    await toggle($, 'on 15')
    await clock.advance(1000)
    return paneRows($)
  } },
  { name: 'keepalive on with a lead at the TTL', old: { warmth: 'warm · 4:58 left · 5m TTL', status: 'Keepalive is paused: lead 300s ≥ 300s TTL · sends nothing.', breakEven: 'never pays off on this context' }, reasonBy: ['lead 300s ≥ 300s TTL'], run: async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 300')
    await clock.advance(1000)
    return paneRows($)
  } },
  { name: 'keepalive on with a lead above the TTL', old: { warmth: 'warm · 4:58 left · 5m TTL', status: 'Keepalive is paused: lead 400s ≥ 300s TTL · sends nothing.', breakEven: 'never pays off on this context' }, reasonBy: ['lead 400s ≥ 300s TTL'], run: async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 400')
    await clock.advance(1000)
    return paneRows($)
  } },
  { name: 'keepalive stopped with its count used, the stop recorded', old: { warmth: 'warm · 0:59 left · 5m TTL', status: 'Keepalive is paused: count used · resumes on next prompt.', breakEven: 'pays off if back in 5:00–9:00', session: 'session: 1 refresh · $0.004' }, run: async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240500)
    await clock.advance(1000)
    await clock.advance(240000)
    return paneRows($)
  } },
  { name: 'keepalive stopped with its cache expired, the stop recorded', old: { warmth: 'expired · rebuild ~$0.09', status: 'Keepalive is paused: cache expired · resumes on next prompt.', breakEven: 'pays off if back in 5:00–13:00' }, run: async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(310000)
    await turnEnd($)
    await clock.advance(1000)
    return paneRows($)
  } },
  { name: 'keepalive on with a learned run count of 0', old: { warmth: 'warm · 4:59 left · 5m TTL', status: 'Keepalive is paused: 0 refreshes this pause (learned: pauses rarely outlast TTL) · resumes on next prompt.' }, reasonBy: ['pauses rarely outlast TTL', 'resumes on next prompt'], run: async ($, on) => {
    const clock = await startedWorld($, on, { ...opusCached(), store: LONG_PAUSES })
    await toggle($, 'on 60')
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    return paneRows($)
  } },
  { name: 'the count-used stop not yet recorded', old: { warmth: 'warm · 4:58 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–9:00', session: 'session: 1 refresh · $0.004' }, figure: 'interval', explainBy: 'refresh $0.004 (~19k cached)', run: async ($, on) => {
    kaWorld(on, opusCached())
    const { held, release } = gatedWrite(on, isStop('count used'))
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 1')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240500)
    const advancing = clock.advance(241000)
    await clock.settle()
    try {
      expect(held.holding).toBe(true)
      await clock.advance(1000)
      return await paneRows($)
    } finally {
      release()
      await advancing
    }
  } },
  { name: 'a cold mark from a model switch whose write is begun and the mark not yet set', old: { warmth: 'warm · 3:19 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, SWITCH, false) },
  { name: 'a cold mark from a model switch whose write failed before the mark was set', old: { warmth: 'warm · 3:19 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, SWITCH, true) },
  { name: 'a cold mark from a model switch set and its write not yet recorded', old: { warmth: 'reset · rebuild ~$0.09', status: 'Keepalive is paused: cache from next reply.' }, run: coldWrite(isMarkedStats, SWITCH, false) },
  { name: 'a cold mark from a model switch set and its write failed', old: { warmth: 'reset · rebuild ~$0.09', status: 'Keepalive is paused: cache from next reply.' }, heading: 'on, no count', run: coldWrite(isMarkedStats, SWITCH, true) },
  { name: 'a cold mark from a compaction set and its write not yet recorded', old: { warmth: 'reset · rebuild ~$0.09', status: 'Keepalive is paused: cache from next reply.' }, run: coldWrite(isMarkedStats, COMPACT, false) },
  { name: 'a cold mark from a compaction set and its write failed', old: { warmth: 'reset · rebuild ~$0.09', status: 'Keepalive is paused: cache from next reply.' }, heading: 'on, no count', run: coldWrite(isMarkedStats, COMPACT, true) },
  { name: 'a /clear cold mark begun and the mark not yet set', old: { warmth: 'warm · 4:59 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: clearWrite(isColdWrite, false) },
  { name: 'a /clear cold mark set and its write not yet recorded', old: { status: 'Keepalive is on, with no cache to count from yet.' }, run: clearWrite(isMarkedStats, false) },
  { name: 'a /clear cold mark set and its write failed', old: { status: 'Keepalive is on, with no cache to count from yet.' }, run: clearWrite(isMarkedStats, true) },
  { name: 'a cold mark from a model switch whose write is begun and the mark not yet set, over a refresh due with the turn running', old: { warmth: 'warm · 0:59 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, SWITCH, false, 'running') },
  { name: 'a cold mark from a model switch whose write failed before the mark was set, over a refresh due with the turn running', old: { warmth: 'warm · 0:59 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, SWITCH, true, 'running') },
  { name: 'a cold mark from a model switch whose write is begun and the mark not yet set, over a refresh sent now', old: { warmth: 'warm · 0:29 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, SWITCH, false, 'sent') },
  { name: 'a cold mark from a model switch whose write failed before the mark was set, over a refresh sent now', old: { warmth: 'warm · 0:29 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, SWITCH, true, 'sent') },
  { name: 'a cold mark from a compaction whose write is begun and the mark not yet set', old: { warmth: 'warm · 3:19 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, COMPACT, false) },
  { name: 'a cold mark from a compaction whose write failed before the mark was set', old: { warmth: 'warm · 3:19 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: coldWrite(isColdWrite, COMPACT, true) },
  { name: 'a /clear cold mark whose write failed before the mark was set', old: { warmth: 'warm · 4:59 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00' }, figure: 'running', heading: 'paused', run: clearWrite(isColdWrite, true) },
  { name: 'keepalive turned off after a refresh, the session tally kept', old: { warmth: 'warm · 4:58 left · 5m TTL', status: `Keepalive is off. ${COLOUR}`, explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00', session: 'session: 1 refresh · $0.004' }, figure: 'literal', run: sessionRun(async ($, clock) => { await toggle($, 'off'); await clock.advance(1000) }) },
  { name: 'keepalive refreshing after a refresh, the session tally shown', old: { warmth: 'warm · 4:59 left · 5m TTL', status: 'Keepalive is on and refreshing the cache.', explain: '$0.004 (~19k cached)', figures: 'every 4 min', breakEven: 'pays off if back in 5:00–13:00', session: 'session: 1 refresh · $0.004' }, figure: 'running', heading: 'on, refreshing', run: sessionRun(async () => {}) },
  { name: 'keepalive stopped with its cache expired after a refresh, the session tally shown', old: { warmth: 'expired · rebuild ~$0.09', status: 'Keepalive is paused: cache expired · resumes on next prompt.', breakEven: 'pays off if back in 5:00–13:00', session: 'session: 1 refresh · $0.004' }, run: sessionRun(async ($, clock) => { await mainStep($); await clock.advance(310000); await turnEnd($); await clock.advance(1000) }) },
  { name: 'keepalive off before any session has started', old: { status: `Keepalive is off. ${COLOUR}` }, run: noStateRun('off') },
  { name: 'keepalive on before any session has started', old: { status: 'Keepalive is on, with no cache to count from yet.' }, run: noStateRun('on 60') },
]

// The pane's rows as sections: each heading's row (the first row of a block), then the rows under it up to the blank row, joined with one space.
const sectionsOf = (rows: string[]): Map<string, { heading: string; text: string }> => {
  const found = new Map<string, { heading: string; text: string }>()
  let at = 0
  while (at < rows.length) {
    const heading = rows[at]!
    if (heading === '') {
      at++
      continue
    }
    const body: string[] = []
    for (at++; at < rows.length && rows[at] !== ''; at++) body.push(rows[at]!.trim())
    found.set(heading.split(' ')[0]!, { heading, text: body.join(' ') })
  }
  return found
}
const occurrences = (text: string, part: string) => text.split(part).length - 1

describe('the pane\'s sections hold every line the old pane drew, in each state it drew them, the colour sentence only while keepalive is off', () => {
  for (const s of SCENARIOS) {
    test(s.name, { options: s.options }, async ($, on) => {
      const sections = sectionsOf(await s.run($, on))
      const cache = sections.get('Cache')?.text
      const advice = sections.get('Advice')?.text
      const keepalive = sections.get('Keepalive')
      expect(keepalive).toBeDefined()
      const found = (where: string | undefined, part: string | undefined) => {
        expect(part).toBeDefined()
        expect(where).toBeDefined()
        expect(occurrences(where!, part!)).toBe(1)
      }
      const old = s.old
      if (old.advice !== undefined) found(advice, old.advice)
      if (old.warmth !== undefined) found(cache, old.warmth)
      // The status words move to the heading, and are not compared. What follows them is: the paused reason, and the colour sentence, which only
      // the keepalive-off states draw.
      const paused = 'Keepalive is paused: '
      if (old.status.startsWith(paused)) {
        expect(old.status.endsWith('.')).toBe(true)
        const reason = old.status.slice(paused.length, old.status.length - 1)
        if (s.reasonBy === undefined) found(keepalive?.text, reason)
        else
          for (const part of s.reasonBy) {
            expect(old.status).toContain(part)
            found(keepalive?.text, part)
          }
        expect(keepalive?.text).not.toContain(COLOUR)
      } else if (old.status.startsWith('Keepalive is off. ')) {
        expect(old.status).toBe(`Keepalive is off. ${COLOUR}`)
        found(keepalive?.text, COLOUR)
      } else {
        expect(['Keepalive is on and refreshing the cache.', 'Keepalive is on, with no cache to count from yet.']).toContain(old.status)
        expect(keepalive?.text).not.toContain(COLOUR)
      }
      if (old.explain !== undefined) {
        expect(old.figures).toBeDefined()
        // Every state here is warm, so the refresh row is the warm wording of the figure.
        const warm = `refresh ${old.explain}`
        if (s.figure === 'literal') {
          found(keepalive?.text, warm)
          found(keepalive?.text, old.figures)
        } else if (s.figure === 'running') {
          // One row in place of two, which names both facts.
          found(keepalive?.text, `${warm} · ${old.figures}`)
          expect(keepalive?.text).not.toContain(`${old.explain} ${old.figures}`)
        } else {
          expect(s.figure).toBe('interval')
          found(keepalive?.text, s.explainBy)
          found(keepalive?.text, old.figures)
        }
      } else {
        expect(s.figure).toBeUndefined()
      }
      // The warm refresh price comes with the price of rebuilding the cache if it goes cold, once.
      if (old.explain !== undefined) found(keepalive?.text, 'if cold: rebuild')
      if (old.breakEven !== undefined) found(keepalive?.text, old.breakEven)
      if (old.session !== undefined) found(keepalive?.text, old.session)
      if (s.heading !== undefined) expect(keepalive?.heading).toBe(`Keepalive  ${s.heading}`)
    })
  }
})

// The footer as it is drawn now: the whole drawing, the pie's own element, and the words beside it.
const pieDrawn = async ($: any) => {
  const m = await mountHint($)
  const drawn = JSON.stringify(await m.drawn())
  const pie = JSON.stringify((await m.find({ type: 'Button', key: 'pie' })) ?? null)
  const words = await hintOf(m)
  await m.unmount()
  return { drawn, pie, words }
}
// Keepalive on for one refresh, sent four minutes in: the stop for the count used stands once that refresh is in.
const countUsed = async ($: any, clock: any) => {
  await toggle($, 'on 60 1')
  await mainStep($)
  await turnEnd($)
  await clock.advance(240500)
  await clock.advance(1000)
  await clock.advance(240000)
}

describe('a standing stop leaves the pie green beside reset or no count with keepalive on, and its hover reads paused until the next prompt', () => {
  test('a count-used stop stands over a model switch: the pie is green beside reset, its hover reads paused, and the heading reads paused', async ($, on) => {
    const clock = await startedWorld($, on)
    await countUsed($, clock)
    await SWITCH($)
    await clock.advance(1000)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('reset')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is paused')
    expect(await toggle($, '')).toContain('Keepalive  paused')
  })

  test('a cache-expired stop stands over a compaction: the pie is green beside reset, and the heading reads paused', async ($, on) => {
    const clock = await startedWorld($, on)
    await toggle($, 'on 60 2')
    await mainStep($)
    await clock.advance(310000)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  paused')
    await COMPACT($)
    await clock.advance(1000)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('reset')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is paused')
  })

  test('a failure stop stands over a model switch: the pie is green beside reset, and the heading reads stopped', async ($, on) => {
    const doc: any = opusCached()
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
    const clock = await startedWorld($, on, doc)
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(241000)
    expect(await toggle($, '')).toContain('Keepalive  stopped')
    await SWITCH($)
    await clock.advance(1000)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('reset')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is paused')
  })

  test('a stop standing, then a failed transcript read that leaves the TTL unread: the pie is green beside no count, and its hover reads paused', async ($, on) => {
    const doc: any = opusCached()
    const clock = await startedWorld($, on, doc)
    await countUsed($, clock)
    doc.broken = true
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('no count')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is paused')
  })

  test('with no stop, a cold cache whose stats write is refused and the heading on, no count: the pie is green beside reset', async ($, on) => {
    kaWorld(on, opusCached())
    const { held } = gatedWrite(on, isMarkedStats)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(100000)
    held.failing = true
    await SWITCH($)
    held.failing = false
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  on, no count')
    const pie = await pieDrawn($)
    expect(pie.words).toBe('reset')
    expect(pie.pie).toContain('"color":"success"')
  })

  test('with no stop, a cold cache whose mark is pending and the heading paused: the pie is green beside reset', async ($, on) => {
    kaWorld(on, opusCached())
    const { held, release } = gatedWrite(on, isMarkedStats)
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    await toggle($, 'on 60 2')
    await mainStep($)
    await turnEnd($)
    await clock.advance(100000)
    const marking = SWITCH($)
    await clock.settle()
    try {
      expect(held.holding).toBe(true)
      await clock.advance(1000)
      expect(await toggle($, '')).toContain('Keepalive  paused')
      const pie = await pieDrawn($)
      expect(pie.words).toBe('reset')
      expect(pie.pie).toContain('"color":"success"')
    } finally {
      release()
      await marking
    }
  })

  test('a prompt over a stop, after a model switch, turns the pie\'s hover from paused to on beside reset before the turn touches the cache, the pie green throughout', async ($, on) => {
    const clock = await startedWorld($, on)
    await countUsed($, clock)
    await SWITCH($)
    await clock.advance(1000)
    const before = await pieDrawn($)
    expect(before.pie).toContain('"color":"success"')
    expect(before.drawn).toContain('cache keepalive is paused')
    await userPrompt($)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('reset')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is on')
  })

  test('a prompt over a stop with no reading turns the pie\'s hover from paused to on beside no count, the pie green throughout', async ($, on) => {
    const doc: any = opusCached()
    const clock = await startedWorld($, on, doc)
    await countUsed($, clock)
    doc.broken = true
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const before = await pieDrawn($)
    expect(before.pie).toContain('"color":"success"')
    expect(before.drawn).toContain('cache keepalive is paused')
    await userPrompt($)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('no count')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is on')
  })

  test('with keepalive_default on, a /clear over a lapsed cache carrying its session state starts under a cache expired stop: the pie is green beside no count, its hover reads paused, heading paused', { options: { keepalive_lead_s: 60, keepalive_default: 'on' } }, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.settle()
    // A turn runs across the lapse, so the idle gap stays shut and no refresh is sent before the cache expires.
    await mainStep($)
    await clock.advance(310000)
    await $.classic.SessionStart({ source: 'clear', transcript_path: PATH } as any)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive  paused')
    const pie = await pieDrawn($)
    expect(pie.words).toBe('no count')
    expect(pie.pie).toContain('"color":"success"')
    expect(pie.drawn).toContain('cache keepalive is paused')
  })

  test('a held footer over no reading under a stop has its hover turned from paused to on by the next prompt, with no hint write between, the pie green throughout', async ($, on) => {
    const doc: any = opusCached()
    const hintWrites: unknown[] = []
    on('state.set', (_$: any, e: any, next: any) => {
      if (e.key === 'hint') hintWrites.push(e.value)
      return next(e)
    })
    const clock = await startedWorld($, on, doc)
    await countUsed($, clock)
    doc.broken = true
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    const m = await mountHint($)
    expect(JSON.stringify(await m.find({ type: 'Button', key: 'pie' }))).toContain('"color":"success"')
    expect(JSON.stringify(await m.drawn())).toContain('cache keepalive is paused')
    hintWrites.length = 0
    await userPrompt($)
    expect(hintWrites).toEqual([])
    expect(JSON.stringify(await m.find({ type: 'Button', key: 'pie' }))).toContain('"color":"success"')
    expect(JSON.stringify(await m.drawn())).toContain('cache keepalive is on')
    await m.unmount()
  })

  test('keepalive turned off after a stop: a cold cache is dim beside reset', async ($, on) => {
    const clock = await startedWorld($, on)
    await countUsed($, clock)
    await SWITCH($)
    await clock.advance(1000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    await toggle($, 'off')
    await clock.advance(1000)
    const pie = await pieDrawn($)
    expect(pie.words).toBe('reset')
    expect(pie.pie).toContain('"dimColor":true')
    expect(pie.pie).not.toContain('"color":"success"')
  })

  test('keepalive turned off after a stop over no reading draws no footer', async ($, on) => {
    const doc: any = opusCached()
    const clock = await startedWorld($, on, doc)
    await countUsed($, clock)
    doc.broken = true
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect((await pieDrawn($)).pie).toContain('"color":"success"')
    await toggle($, 'off')
    await clock.advance(1000)
    const m = await mountHint($)
    expect(await m.find({ type: 'Button', key: 'pie' })).toBeUndefined()
    await m.unmount()
  })
})

// The footer's pie as drawn, once the tick has caught up: its glyph, and the props of the Text that draws it.
const footerPie = async ($: any): Promise<{ glyph: string; props: Record<string, unknown> } | undefined> => {
  const m = await mountHint($)
  const pie = (await m.find({ type: 'Button', key: 'pie' })) as any
  await m.unmount()
  return pie === undefined ? undefined : { glyph: textOf(pie), props: propsOf(pie.children[0]) }
}

describe('the Cache line opens with the pie: the footer\'s glyph in the bare answer, and in the pane in the footer\'s colour, dim or plain', () => {
  // Each state names the glyph and the props the footer's pie is drawn in there as literals, so the pane and the footer are held to them, not only to each other.
  const STATES: { name: string; word: 'warm' | 'expired' | 'reset'; glyph: string; props: Record<string, string | boolean>; reach: ($: any, on: any) => Promise<unknown> }[] = [
    { name: 'a fresh warm cache, keepalive off: the full pie in the normal colour', word: 'warm', glyph: '●', props: {}, reach: ($, on) => startedWorld($, on) },
    {
      name: 'three quarters left, keepalive off',
      word: 'warm',
      glyph: '◕',
      props: {},
      reach: async ($, on) => (await startedWorld($, on)).advance(110000),
    },
    {
      name: 'two quarters left, keepalive off',
      word: 'warm',
      glyph: '◑',
      props: {},
      reach: async ($, on) => (await startedWorld($, on)).advance(160000),
    },
    {
      name: 'the last quarter, keepalive off: amber',
      word: 'warm',
      glyph: '◔',
      props: { color: 'warning' },
      reach: async ($, on) => (await startedWorld($, on)).advance(240000),
    },
    {
      name: 'the last tenth, keepalive off: red',
      word: 'warm',
      glyph: '◔',
      props: { color: 'error' },
      reach: async ($, on) => (await startedWorld($, on)).advance(280000),
    },
    {
      name: 'keepalive refreshing a fresh cache: green',
      word: 'warm',
      glyph: '●',
      props: { color: 'success' },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 15')
        await clock.advance(1000)
      },
    },
    {
      name: 'keepalive refreshing, in the last quarter: green',
      word: 'warm',
      glyph: '◔',
      props: { color: 'success' },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 15')
        await clock.advance(240000)
      },
    },
    {
      name: 'keepalive on with a lead at the TTL, so paused, on a fresh cache: green',
      word: 'warm',
      glyph: '●',
      props: { color: 'success' },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 300')
        await clock.advance(1000)
      },
    },
    { name: 'an expired cache, keepalive off: the empty pie, dim', word: 'expired', glyph: '○', props: { dimColor: true }, reach: async ($, on) => (await startedWorld($, on)).advance(310000) },
    {
      name: 'an expired cache, keepalive on: the empty pie, green',
      word: 'expired',
      glyph: '○',
      props: { color: 'success' },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 60 2')
        await mainStep($)
        await clock.advance(310000)
        await turnEnd($)
        await clock.advance(1000)
      },
    },
    {
      name: 'a reset cache, keepalive off: the empty pie, dim',
      word: 'reset',
      glyph: '○',
      props: { dimColor: true },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await SWITCH($)
        await clock.advance(1000)
      },
    },
    {
      name: 'a reset cache, keepalive on: the empty pie, green',
      word: 'reset',
      glyph: '○',
      props: { color: 'success' },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 60 2')
        await SWITCH($)
        await clock.advance(1000)
      },
    },
    {
      name: 'a reset cache over a recorded stop, keepalive on: the empty pie, green',
      word: 'reset',
      glyph: '○',
      props: { color: 'success' },
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await countUsed($, clock)
        await SWITCH($)
        await clock.advance(1000)
      },
    },
  ]
  for (const s of STATES) {
    test(s.name, async ($, on) => {
      await s.reach($, on)
      const footer = await footerPie($)
      expect(footer).toEqual({ glyph: s.glyph, props: s.props })
      // The bare answer: the line under the Cache heading opens with the glyph and a space, then the cache's state.
      const answer = (await commandText($, '')).split('\n')
      expect(answer[0]).toBe('Cache')
      expect(answer[1]).toMatch(new RegExp(`^ {2}${s.glyph} ${s.word}\\b`))
      // The pane: the glyph in the footer's props, then the line's words, each its own Text and the words with no colour or dim.
      const pane = await mountPane($)
      const row = cacheRow((await pane.drawn()) as any)
      await pane.unmount()
      const pieces = row.children[0].children
      expect(pieces).toHaveLength(2)
      const [glyph, words] = pieces
      expect(textOf(glyph)).toBe(s.glyph)
      expect(propsOf(glyph)).toEqual(footer?.props)
      expect(propsOf(words)).toEqual({})
      expect(textOf(words)).toMatch(new RegExp(`^ ${s.word}\\b`))
      expect(textOf(glyph) + textOf(words)).toBe(answer[1]!.trim())
    })
  }

  // The footer draws the empty pie beside `no count` here with keepalive on, and nothing with it off; the Cache section is absent either way.
  const NONE: { name: string; footer: string | null; reach: ($: any, on: any) => Promise<unknown> }[] = [
    { name: 'no transcript, keepalive off', footer: null, reach: ($, on) => startedWorld($, on, { text: '', exists: false }) },
    {
      name: 'no transcript, keepalive on',
      footer: 'no count',
      reach: async ($, on) => {
        const clock = await startedWorld($, on, { text: '', exists: false })
        await toggle($, 'on 15')
        await clock.advance(1000)
      },
    },
    {
      name: 'after a /clear',
      footer: null,
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await $.classic.SessionStart({ source: 'clear', transcript_path: PATH })
        await clock.advance(1000)
      },
    },
  ]
  for (const s of NONE) {
    test(`with nothing to count (${s.name}) there is no Cache section and no glyph, in the bare answer or the pane`, async ($, on) => {
      await s.reach($, on)
      expect((await pieDrawn($)).words).toBe(s.footer ?? '')
      const answer = await commandText($, '')
      expect(answer.split('\n')).not.toContain('Cache')
      expect(answer).not.toMatch(/[○◔◑◕●]/)
      const pane = await mountPane($)
      const tree = (await pane.drawn()) as any
      await pane.unmount()
      expect(cacheRow(tree)).toBeUndefined()
      expect(JSON.stringify(tree)).not.toMatch(/[○◔◑◕●]/)
    })
  }
})

describe('the pie line draws its label dim, amber in the warning colour and red in the error colour, in each state that shows it, and the bare answer states it as plain text', () => {
  // The states that show the line, each with how a session reaches it. The line shows with keepalive off, whatever the pie's colour: a calm pie, an amber
  // one, a red one and a dim one stand beside the same two colour words.
  const STATES: { name: string; reach: ($: any, on: any) => Promise<unknown> }[] = [
    { name: 'keepalive off, a fresh warm cache: the pie in the normal colour', reach: ($, on) => startedWorld($, on) },
    { name: 'keepalive off, the last quarter: the pie amber', reach: async ($, on) => (await startedWorld($, on)).advance(240000) },
    { name: 'keepalive off, the last tenth: the pie red', reach: async ($, on) => (await startedWorld($, on)).advance(280000) },
    { name: 'keepalive off, an expired cache: the pie dim', reach: async ($, on) => (await startedWorld($, on)).advance(310000) },
    {
      name: 'keepalive off, a reset cache: the pie dim',
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await SWITCH($)
        await clock.advance(1000)
      },
    },
    { name: 'keepalive off with nothing to count', reach: ($, on) => startedWorld($, on, { text: '', exists: false }) },
  ]
  for (const s of STATES) {
    test(s.name, async ($, on) => {
      await s.reach($, on)
      const pane = await mountPane($)
      const tree = (await pane.drawn()) as any
      await pane.unmount()
      // The pieces of the line with a colour or dim are the label `pie:` dim, then `amber` in the warning colour and `red` in the error colour, in that order, so the
      // rest of the line has none.
      const line = pieLineRow(tree)
      expect(line).toBeDefined()
      const toned = line.children[0].children.filter((piece: any) => Object.keys(propsOf(piece)).length > 0)
      expect(toned.map((piece: any) => [textOf(piece), propsOf(piece)])).toEqual([['pie:', { dimColor: true }], ['amber', { color: 'warning' }], ['red', { color: 'error' }]])
      expect(textOf(line.children[0].children[0])).toBe('pie:')
      // The bare answer states the line once, as plain text in its one row.
      const answer = (await commandText($, '')).split('\n')
      expect(answer.filter((row) => row.includes(PIE_LINE))).toEqual([`  ${PIE_LINE}`])
    })
  }
})

describe('the pie line is absent while keepalive is on, in every state, beside a green pie: the pane and the bare answer draw none', () => {
  // Each state has keepalive on, and how a session reaches it: paused by design, stopped by its count, by a lapsed cache and by a reset, and with nothing to count.
  const STATES: { name: string; reach: ($: any, on: any) => Promise<unknown> }[] = [
    {
      name: 'keepalive on with a lead at the TTL, so paused',
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 300')
        await clock.advance(1000)
      },
    },
    { name: 'keepalive stopped with its count used', reach: async ($, on) => countUsed($, await startedWorld($, on)) },
    {
      name: 'keepalive on, an expired cache',
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 60 2')
        await mainStep($)
        await clock.advance(310000)
        await turnEnd($)
        await clock.advance(1000)
      },
    },
    {
      name: 'keepalive on, a reset cache',
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 60 2')
        await SWITCH($)
        await clock.advance(1000)
      },
    },
    {
      name: 'keepalive on with nothing to count',
      reach: async ($, on) => {
        const clock = await startedWorld($, on, { text: '', exists: false })
        await toggle($, 'on 15')
        await clock.advance(1000)
      },
    },
  ]
  for (const s of STATES) {
    test(s.name, async ($, on) => {
      await s.reach($, on)
      expect((await pieDrawn($)).pie).toContain('"color":"success"')
      const pane = await mountPane($)
      const tree = (await pane.drawn()) as any
      await pane.unmount()
      expect(pieLineRow(tree)).toBeUndefined()
      expect(await commandText($, '')).not.toContain(PIE_LINE)
    })
  }
})

// The labels the pane draws dim, each in a state that shows its row. A state names the labels its pane must show and the unlabelled rows it must show plain; the
// last test holds the states to the whole list, so a label added to the list needs a state that draws it.
describe('the details pane draws each row label dim in the states that show it, and every other row as it was', () => {
  type LabelState = {
    name: string
    labels: string[]
    unlabelled?: string[]
    options?: Record<string, number>
    reach: ($: any, on: any) => Promise<unknown>
  }
  const SETTINGS_LABELS = ['TTL:', 'lead:', 'refreshes/pause:', 'start mode:', 'unit:', 'night stop:']
  const pausesOf = (pausedMs: number, grownTokens: number) => ({
    'pauses/old': Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000, contextTokens: 100000, grownTokens })),
  })
  // Ten pauses of three hours learn no refreshes; twelve of three hours at this hour beside twelve of half an hour at another learn none for this hour alone.
  const LONG = { 'pauses/old': Array.from({ length: 10 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 3 * 3600000, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000 })) }
  const HOUR = new Date(T0 + 1000).getHours()
  const HOURLY = {
    'pauses/old': [
      ...Array.from({ length: 12 }, (_, i) => ({ startMs: 1000 + i, pausedMs: 3 * 3600000, hour: HOUR, weekday: 2, ratio: 24, ttlMs: 300000 })),
      ...Array.from({ length: 12 }, (_, i) => ({ startMs: 2000 + i, pausedMs: 30 * MIN, hour: (HOUR + 12) % 24, weekday: 2, ratio: 24, ttlMs: 300000 })),
    ],
  }
  const STATES: LabelState[] = [
    { name: 'keepalive off, a fresh warm cache: the pie line, the refresh figure, the rest count, the session fallback and the Settings rows', labels: ['pie:', 'refresh', 'rest:', 'session:', ...SETTINGS_LABELS], reach: ($, on) => startedWorld($, on) },
    {
      name: 'a rest learned from seven nights of pauses',
      labels: ['rest:'],
      reach: ($, on) => startedWorld($, on, { ...opusCached(), store: { 'pauses/old': startsOf(7, T0 - DAY_MS).flatMap(restAt) } }),
    },
    {
      name: 'a rest learned from seven nights of pauses, the night step on: the overnight row beside the rest row',
      labels: ['rest:', 'overnight:'],
      reach: ($, on) => startedWorld($, on, { ...opusCached(), store: { 'pauses/old': startsOf(7, T0 - DAY_MS).flatMap(restAt) } }),
    },
    {
      name: 'an advised best setup over recent pauses',
      labels: ['setup:', 'best:', 'do:'],
      reach: ($, on) => startedWorld($, on, { ...opusCached(), store: pausesOf(10 * MIN, 1000000) }),
    },
    { name: 'an other TTL that would have cost less', labels: ['setup:', 'other TTL:', 'do:'], reach: ($, on) => startedWorld($, on, { ...opusCached(), store: pausesOf(20 * MIN, 2000) }) },
    {
      name: 'the cheapest setup with a next best',
      labels: ['setup:', 'saves', 'next best:'],
      reach: async ($, on) => {
        const clock = await startedWorld($, on, { ...opusCached(), store: pausesOf(6 * MIN, 6000) })
        await toggle($, 'on 15 1')
        await clock.advance(1000)
      },
    },
    {
      name: 'a learned run count',
      labels: ['learned:'],
      options: { keepalive_lead_s: 60 },
      reach: async ($, on) => {
        const clock = await startedWorld($, on, { ...opusCached(), store: LONG })
        await toggle($, 'on 60')
        await mainStep($)
        await turnEnd($)
        await clock.advance(1000)
      },
    },
    { name: 'a run count learned from this hour\'s pauses alone', labels: ['learned (this hour):'], reach: ($, on) => startedWorld($, on, { ...opusCached(), store: HOURLY }) },
    {
      name: 'a session with a judged pause and a history of long, wasted and missed pauses',
      labels: ['balance vs other setting:', 'earlier:', 'long pauses:', 'misses:', 'session:'],
      unlabelled: ['most wasted pauses ran out: pauses outlast refreshes'],
      reach: ($, on) => withMiss($, on, T0 + 601000),
    },
    { name: 'the tokens unit on an unpriced model', labels: ['in tokens:', 'refresh', 'if cold:'], reach: ($, on) => startedWorld($, on, cached()) },
    {
      name: 'a run stopped with its count used after a refresh',
      labels: ['last refresh:', 'if cold:', 'refresh'],
      reach: async ($, on) => countUsed($, await startedWorld($, on)),
    },
    {
      name: 'keepalive refreshing after a refresh, its pause tally shown',
      labels: ['refresh', 'next in', 'last refresh:', 'pause:', 'session:'],
      reach: ($, on) => sessionRun(async () => {})($, on),
    },
    {
      name: 'keepalive on and due while the turn runs: the due sentence is not a label',
      labels: ['refresh'],
      unlabelled: ['refresh due · waits for turn end'],
      reach: async ($, on) => {
        const clock = await startedWorld($, on)
        await toggle($, 'on 60 2')
        await mainStep($)
        await clock.advance(241000)
      },
    },
    {
      name: 'keepalive on, stopped by a failure, over an expired cache',
      labels: ['next refresh'],
      reach: async ($, on) => {
        const doc: any = opusCached()
        doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_creation_input_tokens: 18000 } }
        const clock = await startedWorld($, on, doc)
        await toggle($, 'on 60 2')
        await mainStep($)
        await turnEnd($)
        await clock.advance(241000)
        await clock.advance(70000)
      },
    },
    { name: 'keepalive off over an expired cache', labels: ['next refresh'], reach: async ($, on) => (await startedWorld($, on)).advance(310000) },
  ]
  for (const s of STATES) {
    const run = async ($: any, on: any) => {
      await s.reach($, on)
      const pane = await mountPane($)
      const tree = (await pane.drawn()) as any
      await pane.unmount()
      // The state shows the rows: the pane's text has a row opening with each label, and each unlabelled row whole.
      const texts: string[] = tree.children.map(textOf)
      for (const label of s.labels) expect(texts.some((text) => text.startsWith(`${label} `) && !UNLABELLED.includes(text))).toBe(true)
      for (const text of s.unlabelled ?? []) expect(texts).toContain(text)
      // Each of its labels is drawn as a row's first piece, dim; no other piece of any row is a listed label, and no row opening with one is left a plain string.
      const drawn = drawnLabels(tree)
      for (const label of s.labels) expect(drawn.map(([drawnLabel]) => drawnLabel)).toContain(label)
      for (const [label, props] of drawn) expect([label, props]).toEqual([label, { dimColor: true }])
      expect(mislabelled(tree)).toEqual([])
      // The rest of every row has no colour or dim but what the Keepalive state word, the Cache line's pie and the pie line's two words give it.
      const rest = withoutTones(tree)
      expect(rest).toHaveLength(tree.children.length)
      expect(JSON.stringify(rest)).not.toMatch(NO_TONE)
      // A row with no label is drawn as it was, its text the one string it holds; the Cache line holds its pie beside its words.
      const cache = cacheRow(tree)
      const labelled = (row: any) => drawnLabels({ children: [row] }).length > 0
      for (const row of tree.children.filter((row: any) => row.type === 'Box' && row !== cache && !labelled(row))) expect(row.children[0].children).toEqual([textOf(row)])
      for (const text of s.unlabelled ?? []) expect(tree.children.find((row: any) => textOf(row) === text).children[0].children).toEqual([text])
    }
    if (s.options === undefined) test(s.name, run)
    else test(s.name, { options: s.options }, run)
  }

  test('the states between them show every listed label', () => {
    expect([...new Set(STATES.flatMap((s) => s.labels))].sort()).toEqual([...LABELS].sort())
  })
})
