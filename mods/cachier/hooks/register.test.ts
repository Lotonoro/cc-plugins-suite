import { describe, expect, mock, test } from 'claude-code/testing'
import { assistant, fakeFiles, lines, user } from './fixture'
import { HISTORY_BOUND, keyOf } from './history'
import { INITIAL as INITIAL_KEEPALIVE } from './keepalive'
import { alarmOf, learnTranscript, pressCountdown, pressOnce, restoreState, STATE_SHAPE, unitFrom } from './register'

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
const world = (on: any, doc: { text: string; broken?: boolean; exists?: boolean; hold?: Promise<void>; deny?: string; pricing?: string; pricingStatus?: number; fork?: unknown; forkHold?: Promise<void>; switchHold?: Promise<void>; compactHold?: Promise<void>; forkThrows?: boolean; dropPrompt?: boolean; promptThrows?: boolean; store?: Record<string, unknown>; auditor?: boolean; markdown?: boolean; engineNode?: boolean; openThrows?: boolean; openUnplaced?: boolean; keysThrows?: boolean; keysHold?: Promise<void>; getHold?: { key: string; hold: Promise<void>; nth?: number }; getHeldDenied?: { key: string; hold: Promise<void>; deny: string }; setHold?: { key: string; hold: Promise<void> }; getDenied?: Set<string>; setDenied?: Set<string>; deleteDenied?: Set<string>; getGate?: (key: string, nth: number) => Promise<string | undefined> | undefined }) => {
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
    rec.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...rec.panes].map((id) => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  // The pricing page: the rows these tests read, unless the doc serves another body or status.
  on('http.fetch', (_$: any, e: any) => {
    rec.fetches.push(e.url)
    const status = doc.pricingStatus ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: doc.pricing ?? PRICING_PAGE } }
  })
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
    return { value: fakeFiles(doc.text).run(e.argv) }
  })
  // A keepalive ping's fork: what the test set as `doc.fork`, else nothing to fork.
  on('model.fork', async (_$: any, e: any) => {
    rec.forks.push(e.prompt)
    if (doc.forkHold !== undefined) await doc.forkHold
    if (doc.forkThrows === true) throw new Error('fork broke')
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
// drawn, and no refresh is drawn beyond its hover. The drawing cannot tell those states apart, so the bare command does.
const expectCountdownOnly = async ($: any, state: 'off' | 'stopped' | 'paused') => {
  const drawn = await drawnHint($)
  expect(drawn).toContain('"key":"pie"')
  expect(drawn).not.toContain('ping')
  expect(drawn).not.toContain('"color":"success"')
  expect(await toggle($, '')).toContain(`Keepalive keepalive ${state}`)
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
// The details pane's drawing, as text: the sentences a click on the line opens it on.
const drawnPane = async ($: any) => {
  const pane = await mountPane($)
  const drawn = JSON.stringify(await pane.drawn())
  await pane.unmount()
  return drawn
}
// Everything the line and the details draw, as text: the footer's drawing, then the pane's.
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
    expect(rec.logs).toEqual([])
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
    expect(await hint($)).toBe('')
    expect(rec.logs).toEqual([])
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
    expect(await hint($)).toBe('')
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
    expect(await toggle($, '')).toContain('Keepalive keepalive on')
    doc.fork = { isAnswered: false, reason: 'empty-reply', usage: { ...ZERO, cache_read_input_tokens: 336000 } }
    await clock.advance(241000)
    expect(lastStatus(rec)).toBeUndefined()
    expect(debugOf(rec, 'cachier ping').at(-1).usage).toMatchObject({ read: 336000 })
    const text = await toggle($, '')
    expect(text).toContain('Keepalive keepalive on')
    expect(text).toContain('next refresh in')
    expect(text).toMatch(/Prompt cache warm, (4:\d\d|5:00) left/)
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
    expect(await toggle($, '')).toContain('Keepalive keepalive on')
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
    expect(await toggle($, '')).toContain('next refresh in 3:59')
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
    expect(text).toContain('Next refresh: ~19k cached tokens read')
    expect(text).toContain('every 4 min')
    expect(text).toContain('can also write')
    expect(rec.forks).toEqual([])
    await clock.advance(1000)
    expect(await drawnHint($)).toContain('~19k read/refresh')
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
    expect(await toggle($, '')).toContain('keepalive paused: its refreshes for this pause are used up; it resumes after your next prompt')
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
    expect(await toggle($, '')).toContain('refresh due, waits for the turn to end')
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
    expect(await toggle($, '')).toContain('keepalive paused: the cache expired; it resumes after your next prompt')
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
    expect(lastStatus(rec)).toContain('keepalive stopped: the refresh threw; see the debug log')
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
    expect(await toggle($, '')).toContain('no live cache to count from, nothing scheduled')
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
    expect(await toggle($, '')).toContain('no live cache to count from, nothing scheduled')
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
    expect(await toggle($, '')).toContain('keepalive on · Next refresh: ~19k cached tokens read, every')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('· next refresh in')
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(lastStatus(rec)).toContain('keepalive paused: lead 400 s is not below the 300 s TTL')
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
    expect(await toggle($, '')).toContain('keepalive on · no live cache to count from, nothing scheduled')
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
    expect(await toggle($, '')).toContain('keepalive on · no live cache to count from, nothing scheduled')
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
    expect(await toggle($, '')).toContain('refresh due, waits for the turn to end')
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
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
    expect(await hint($)).toBe('')
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
    expect(await toggle($, '')).toContain('no live cache to count from')
    doc.exists = undefined
    doc.text = cached().text
    await mainStep($)
    await turnEnd($)
    await clock.advance(100000)
    expect(rec.forks).toEqual([])
    expect(await toggle($, '')).toContain('Next refresh: ~19k cached tokens read')
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
    expect(await toggle($, 'on 60 2')).toContain('Next refresh: ~19k cached tokens read')
    await mainStep($)
    await turnEnd($)
    await clock.advance(240000)
    expect(rec.forks.length).toBe(1)
  })

  test('a /keepalive answer while a cold mark is being written says the cache reset is being recorded, and shows no cost', async ($, on) => {
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
    expect(await toggle($, '')).toContain('paused until the cache reset is recorded')
    expect(await toggle($, '')).not.toContain('Next refresh')
    release()
    await switching
    await clock.advance(1000)
    await mainStep($)
    await turnEnd($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Next refresh: ~19k cached tokens read')
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
    expect(await drawnHint($)).toContain('~19k read/refresh')
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
    expect(text).toContain('Next refresh: ~19k cached tokens read')
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
    expect(await toggle($, '')).toContain('The lead was raised to 16 s after a slow refresh.')
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
    expect(await toggle($, '')).toContain('The lead was raised to 16 s after a slow refresh.')
    expect(await toggle($, 'on 30 3')).toContain('lead 30 s')
    await clock.advance(1000)
    expect(await drawnHint($)).not.toContain('lead raised')
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
    expect(await drawnHint($)).toContain('~19k read/refresh')
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
    expect(lastStatus(rec)).toBe('keepalive stopped: a 160.0 s round trip needs a 320 s lead, over half the 300 s TTL')
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
    expect(lastStatus(rec)).toContain('keepalive stopped: round trip over 300 s TTL, no reply yet')
    release()
    await clock.advance(1000)
    const pings = debugOf(rec, 'cachier ping')
    expect(pings[pings.length - 1]).toMatchObject({ stale: true, outcome: 'answered' })
    expect(await toggle($, '')).toContain('This session: 1 refresh costing ~19k tokens read.')
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
    expect(status).not.toContain('This pause:')
    expect(status).toContain('This session: 1 refresh costing ~19k tokens read.')
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
    expect(await toggle($, '')).toContain('This pause: 1 refresh costing ~19k tokens read.')
    expect(await drawnHint($)).toContain('This session: 1 refresh costing ~19k tokens read.')
    await userPrompt($)
    await clock.advance(1000)
    expect(await drawnHint($)).not.toContain('This pause:')
    expect(await drawnHint($)).toContain('This session: 1 refresh costing ~19k tokens read.')
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
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
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
    expect(await drawnHint($)).toContain('~19k read/refresh')
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
    expect(JSON.stringify(await m.drawn())).not.toContain('Next refresh')
    await pressPie($)
    await clock.advance(1000)
    expect(await hintOf(m)).toMatch(countdown)
    expect(JSON.stringify(await m.drawn())).toContain('~19k read/refresh')
    expect(await m.find({ type: 'Button', key: 'unit' })).toBeFalsy()
    const pane = await mountPane($)
    const running = JSON.stringify(await m.drawn()) + JSON.stringify(await pane.drawn())
    await pane.unmount()
    expect(running).toContain('~19k read/refresh')
    expect(running).toContain('Next refresh: ~19k cached tokens read')
    expect(running).toContain('every 4:45')
    expect(running).not.toContain('Turn keepalive')
    expect(running).not.toContain('Click the line')
    await pressPie($)
    await clock.advance(1000)
    expect(await hintOf(m)).toMatch(countdown)
    expect(JSON.stringify(await m.drawn())).not.toContain('ping')
    expect(JSON.stringify(await m.drawn())).not.toContain('Next refresh')
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
    expect(await drawnPane($)).toContain('Keepalive is paused: ')
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('~19k read/refresh')
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
    expect(await toggle($, '')).toContain('keepalive paused: its refreshes for this pause are used up')
    expect(lastStatus(rec)).toBeUndefined()
    const m = await mountHint($)
    expect(await drawnPane($)).toContain('Keepalive is paused: its refreshes for this pause are used up')
    await pressPie($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
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
    expect(await toggle($, '')).toContain('keepalive paused: its refreshes for this pause are used up')
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
    expect(await drawnPane($)).toContain('Keepalive is paused: ')
    expect(lastStatus(rec)).toContain('keepalive paused: lead 300 s is not below the 300 s TTL')
    await pressPie($)
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
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
    expect(text).toContain('refreshes a pause break-even')
    expect(text).not.toContain('the count this pause started with')
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
    expect(await toggle($, '')).toContain('Cache misses: 1 (lapse 1), ~20k tokens rewritten')
    // Off, the line names no refresh figure; the pane states what one refresh would cost, as the offer a switch on is made in view of.
    expect(await hintOf(m)).not.toContain('refresh')
    expect(drawn).toMatch(/Next refresh: ~\d+k cached tokens read\./)
    expect(drawn).toContain('Keepalive is off. The pie turns amber')
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
    expect(await toggle($, '')).toContain('Cache misses: 1 (switch or compaction 1), ~20k tokens rewritten')
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
    expect(await toggle($, '')).toContain('Cache misses: 1')
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/other/session.jsonl' })
    await clock.advance(1000)
    expect(await toggle($, '')).not.toContain('Cache misses')
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
    expect(status).toContain('Cache misses: 1 (switch or compaction 1)')
    expect(status).not.toContain('ran out')
    expect(status).not.toContain('Earlier pauses')
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
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
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
    expect(lastStatus(rec) ?? '').not.toContain('Next refresh')
    await pressPie($)
    await clock.advance(1000)
    await pressPie($)
    await clock.advance(1000)
    expect(lastStatus(rec) ?? '').not.toContain('Next refresh')
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
    expect(JSON.stringify(await m.drawn())).toContain('~19k read/refresh')
    expect(await toggle($, '')).toContain('3 left')
    expect(rec.toasts).toEqual([])
    expect(rec.forks).toEqual([])
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).not.toContain('ping')
    await pressPie($)
    await clock.advance(1000)
    expect(JSON.stringify(await m.drawn())).toContain('~19k read/refresh')
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
    expect(await toggle($, '')).toContain('30 s')
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
    expect(await toggle($, '')).toContain('30 s')
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
    expect(await hint($)).toBe('')
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
    expect(lastStatus(rec) ?? '').not.toContain('Next refresh')
    const m = await mountHint($)
    expect(JSON.stringify(await m.drawn())).toContain('~19k read/refresh')
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
    expect(JSON.stringify(await mounted.drawn())).toContain('Next refresh')
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
    const cost = { label: '$0.006/refresh', explain: 'Next refresh: $0.006 (~19k cached tokens read).', figures: 'One refresh every 4:45.' }
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
  const rows = ((await pane.drawn()) as any).children.map(textOf)
  await pane.unmount()
  return rows
}
// The columns a pane asks for: its longest row.
const widthOf = (rows: string[]) => Math.max(...rows.map((row) => row.length))

describe('the details pane: a click on the time opens it at its size, a second click closes it, and the pie is the switch', () => {
  test('a click on the time opens the pane at the rows and columns its lines take, Esc closes it, and keepalive is left as it is', async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    expect(rec.opens.map((o: any) => o.id)).toEqual([PANE_ID])
    expect(rec.opens[0]).toMatchObject({ title: 'Prompt cache', closeOnEscape: true })
    const rows = await paneRows($)
    expect(rec.opens[0].rows).toBe(rows.length)
    expect(rec.opens[0].columns).toBe(widthOf(rows))
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
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

  test('the details hold the warmth first, then keepalive\'s state and its figure, and no history sentence', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const rows = await paneRows($)
    expect(rows[0]).toMatch(/^Prompt cache warm, \d+:\d\d left \(5-minute cache\)$/)
    expect(rows[1]).toBe('Keepalive is off. The pie turns amber in the cache\'s last quarter and red in its last tenth: the cache is about to lapse.')
    expect(rows[2]).toContain('Next refresh: ~19k cached tokens read.')
    expect(JSON.stringify(rows)).not.toMatch(/The pie is|Earlier pauses|Learned from|Shown in tokens|Longest pause|Cache misses/)
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
    expect(await toggle($, '')).toContain('Keepalive keepalive off')
  })

  test('while keepalive is off the pane states the figures of the run a press would start, at the lead the last run used', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, 'on 240 3')).toContain('keepalive on')
    expect(await toggle($, 'off')).toContain('keepalive off')
    await clock.advance(1000)
    const drawn = await drawnPane($)
    expect(drawn).toContain('Next refresh: ~19k cached tokens read.')
    expect(drawn).toContain('One refresh every 1 min.')
  })

  test('a pie press re-opens an open pane at the rows and columns its new lines take', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    await pressPie($)
    const rows = await paneRows($)
    expect(rec.opens.length).toBe(2)
    expect(rec.opens[1]).toMatchObject({ id: PANE_ID, rows: rows.length, columns: widthOf(rows) })
    expect(rec.closes).toEqual([])
  })

  test('a tick that changes the lines re-opens an open pane at its new size', { options: { keepalive_lead_s: 15, keepalive_count: 3 } }, async ($, on) => {
    const rec = kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await m.unmount()
    expect(await toggle($, 'on 15 3')).toContain('keepalive on')
    await clock.advance(1000)
    const rows = await paneRows($)
    expect(rec.opens.length).toBe(2)
    expect(rec.opens[1]).toMatchObject({ id: PANE_ID, rows: rows.length, columns: widthOf(rows) })
    expect(rec.opens[1].columns).toBeLessThan(rec.opens[0].columns)
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

  test('an open the engine does not place is named on the status line the same way', async ($, on) => {
    const rec = kaWorld(on, { ...cached(), openUnplaced: true })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const m = await mountHint($)
    await m.press({ key: 'details' })
    await clock.advance(1000)
    expect(lastStatus(rec)).toBe('the details pane did not open; see the debug log')
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
    expect(JSON.stringify(await drawnPane($))).not.toContain('hover')
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
    // Each state was reached, so the scan below covers it.
    expect(said[0]).toMatch(/Keepalive keepalive off/)
    expect(said[2]).toContain('its refreshes for this pause are used up')
    expect(said[3]).toContain('keepalive stopped: API error 529 (overloaded)')
    expect(said[8]).toContain('Prompt cache reset')
    for (const s of said) expect(s).not.toMatch(/ping|armed|cold|\bpar\b/i)
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
    expect(await toggle($, '')).toContain('Cache miss')
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
    expect(await toggle($, '')).toContain('Cache misses: 1 (lapse 1)')
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
    expect(await toggle($, '')).toContain('keepalive paused: the cache expired; it resumes after your next prompt · each refresh reads ~19k cached tokens')
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
    expect(running).toContain('$0.004/refresh')
    expect(running).toContain('Next refresh: $0.004 (~19k cached tokens read)')
    expect(running).not.toContain('Shown in tokens')
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
    expect(JSON.stringify(await m.drawn())).toContain('$0.007/refresh')
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
    expect(JSON.stringify(await m.drawn())).toContain('$0.004/refresh')
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
    expect(JSON.stringify(await m.drawn())).toContain('$0.004/refresh')
    expect(await toggle($, 'unit tokens')).toBe('figures show in tokens for this session.')
    const tokens = JSON.stringify(await m.drawn()) + (await drawnPane($))
    expect(tokens).toContain('~19k read/refresh')
    expect(await toggle($, '')).toContain('A 5-minute cache write costs about 25 cache reads on claude-opus-5-5.')
    expect(tokens).not.toContain('$0.004/refresh')
    expect(await toggle($, '')).toContain('Next refresh: ~19k cached tokens read')
    expect(await toggle($, 'unit dollars')).toBe('figures show in dollars for this session.')
    expect(JSON.stringify(await m.drawn())).toContain('$0.004/refresh')
    // Back in dollars, keepalive reads as it did before the switch: the unit is all that moved.
    expect(await toggle($, '')).toBe(before.replace('unit dollars (cost_unit option)', 'unit dollars (switched this session)'))
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
    expect(JSON.stringify(await m.drawn())).toContain('$0.007/refresh')
    expect(await toggle($, 'unit dollars')).toBe('figures show in dollars for this session.')
    expect(rec.fetches.length).toBe(2)
    await m.unmount()
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
    expect(JSON.stringify(await m.drawn())).toContain('$0.004/refresh')
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
    expect(JSON.stringify(await m.drawn())).toContain('~19k read/refresh')
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
    expect(drawn).toContain('~19k read/refresh')
    expect(await toggle($, '')).toContain('Shown in tokens: no price for claude-nonesuch-1.')
    await m.unmount()
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
      ui: { log: () => {}, status: () => {} },
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
      ui: { log: () => {}, status: () => {} },
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
    expect(await toggle($, '')).toMatch(/Keepalive keepalive on/)
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
    expect(await toggle($, '')).toMatch(/Keepalive keepalive off/)
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toMatch(/Keepalive keepalive on/)
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
    expect(await toggle($, '')).toMatch(/start mode off \(keepalive_default option\)/)
    expect(await toggle($, 'default on')).toBe('keepalive default: on. Sessions started from now on start with keepalive on; this one stays as it is.')
    expect(await toggle($, '')).toMatch(/Keepalive keepalive off/)
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
    expect(await toggle($, '')).toContain(', 24 left')
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

  test("a session start deletes the keys that hold only pauses older than the history keeps, and leaves this session's own", async ($, on) => {
    const old = { startMs: 1, pausedMs: MIN, hour: 0, weekday: 0, ratio: 24, ttlMs: 300000 }
    const recent = Array.from({ length: 2000 }, (_, i) => ({ ...old, startMs: 1000 + i }))
    const rec = kaWorld(on, { ...cached(), store: { 'pauses/old': [old], 'pauses/recent': recent, other: 1 } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect([...rec.store.keys()].sort()).toEqual(['other', 'pauses/recent'])
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
    const rec = kaWorld(on, { ...cached(), store: { 'pauses/old0': [old], 'pauses/old1': [old], 'pauses/old2': [old], 'pauses/recent': recent }, deleteDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect([...rec.store.keys()].sort()).toEqual(['pauses/old0', 'pauses/old1', 'pauses/recent'])
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
      const m = /over (\d+) (pauses this session|recent pauses)/.exec(text)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain('A 1-hour cache would have saved $0.12 over 6 priced pauses across sessions')
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
    expect(await toggle($, '')).toContain('no refreshes this pause')
    expect(await toggle($, '')).toContain('Learned from your pauses: no refreshes, as 0 of your 10 pauses ended within the 5:00 TTL.')
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
    expect(await toggle($, '')).toContain(', 2 left')
    expect(await drawnHint($)).not.toContain('Learned from your pauses')
    expect(await toggle($, '')).toContain('Each pause sends at most 2 refreshes: the count you pinned with /keepalive on.')
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
    expect(await toggle($, '')).toContain('Each pause sends at most 2 refreshes: the count you pinned with /keepalive on.')
    expect(await drawnHint($)).not.toContain('Learned from your pauses')
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
    expect(await toggle($, '')).toContain('refreshes a pause 1 (the count this pause started with; your next prompt works it out again)')
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
    expect(text).toContain('Each pause sends at most 1 refresh: the count this pause started with; your next prompt works it out again.')
    expect(text).toContain('refreshes a pause 1 (the count this pause started with; your next prompt works it out again)')
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
    expect(text).toContain('Each pause sends at most 24 refreshes: the count this pause started with; your next prompt works it out again.')
    expect(text).toContain('refreshes a pause 24 (the count this pause started with; your next prompt works it out again)')
  })
})

describe('the bare command says how many refreshes a pause sends, and why', () => {
  test('with nothing pinned or learned, the pane gives the break-even count and what it is', async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Each pause sends at most 24 refreshes: the break-even count, the most refreshes that cost no more than the rewrite they avoid.')
  })

  test('keepalive_count caps the break-even count, and the pane says so', { options: { keepalive_count: 6 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Each pause sends at most 6 refreshes: keepalive_count, which caps the break-even count of 24.')
  })

  test('a model with no price sends keepalive_count, or 3 while it is unset, and the pane says why', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('Each pause sends at most 3 refreshes: the default, since the price of this model is unknown and keepalive_count is unset.')
  })
})

describe("the pie's colour: keepalive's mode on the footer line", () => {
  test('the pie is green while keepalive refreshes, takes the warning colours once it is paused, and is plain with keepalive off', { options: { keepalive_lead_s: 60 } }, async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await hint($)).toBe('4:59')
    await toggle($, 'on 60 1')
    await clock.advance(1000)
    expect(await drawnHint($)).toContain('"color":"success"')
    await mainStep($)
    await turnEnd($)
    await clock.advance(20 * MIN)
    expect(await drawnPane($)).toContain('Keepalive is paused: ')
    expect(await drawnHint($)).not.toContain('"color":"success"')
    await toggle($, 'off')
    await clock.advance(1000)
    expect(await drawnHint($)).not.toContain('"color":"success"')
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
    expect(await toggle($, '')).toContain('A 1-hour cache would have saved $4.74 over 10 priced pauses across sessions: set "promptCacheTtl": "1h" in settings.json.')
    await toggle($, 'on 15')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('A 1-hour cache would have saved $0.74 over 10 priced pauses across sessions')
    await toggle($, 'on 15 3')
    await clock.advance(1000)
    expect(await toggle($, '')).toContain('A 1-hour cache would have saved $5.34 over 10 priced pauses across sessions')
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
    expect(text).toContain('Keepalive keepalive on')
    expect(text).not.toContain('A 1-hour cache would have saved')
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
    expect(await toggle($, '')).toContain('A 1-hour cache would have saved $4.40 over 10 priced pauses across sessions: set "promptCacheTtl": "1h" in settings.json.')
  })

  test('the other TTL is priced with keepalive off when new sessions start it off, though this session has it on', { options: { keepalive_default: 'off' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: LONG })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 15')
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('Keepalive keepalive on')
    expect(text).not.toContain('A 1-hour cache would have saved')
  })

  test('with no recorded context, the pane gives no advice', async ($, on) => {
    const bare = { 'pauses/old': SIZED['pauses/old'].map(({ contextTokens, grownTokens, ...r }) => r) }
    kaWorld(on, { ...opusCached(), store: bare })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await drawnHint($)).not.toContain('cache would have saved')
  })
})

describe('the bare command answers four sections, in order: Cache, Keepalive, Advice, Settings', () => {
  test('the sections come in that order, each headed by its name on a line of its own, and the cache line comes first', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const text = await commandText($, '')
    const headings = text.split('\n').filter((line: string) => ['Cache', 'Keepalive', 'Advice', 'Settings'].includes(line))
    expect(headings).toEqual(['Cache', 'Keepalive', 'Advice', 'Settings'])
    expect(text.startsWith('Cache\n  Prompt cache warm, ')).toBe(true)
  })

  test('a section with no figure is absent: with nothing learned, missed or advised, there is no Advice heading', async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await commandText($, '')).not.toMatch(/(^|\n)Advice\n/)
  })

  test('the Settings section has the five settings, each with its value and how to change it, and the TTL and start mode say new sessions', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const text = await toggle($, '')
    expect(text).toContain('TTL 5 min (read from the last response): set "promptCacheTtl": "1h" in settings.json for 1 h (new sessions).')
    expect(text).toContain('lead 15 s: /keepalive on <lead seconds>.')
    expect(text).toContain('refreshes a pause')
    expect(text).toContain('keepalive_count')
    expect(text).toContain('start mode off (keepalive_default option): /keepalive default on|off, for new sessions.')
    expect(text).toContain('unit dollars (cost_unit option): /keepalive unit tokens|dollars.')
  })

  test('a run whose cost the answer states has the refresh cost in the Keepalive section, before Settings', async ($, on) => {
    kaWorld(on, cached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await toggle($, 'on 15 3')
    const text = await commandText($, '')
    expect(text.indexOf('Keepalive')).toBeLessThan(text.indexOf('Next refresh'))
    expect(text.indexOf('Next refresh')).toBeLessThan(text.indexOf('Settings'))
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
    expect(text).toMatch(/Over 1 pause this session, keepalive (saved|cost)/)
    expect(text.indexOf('Keepalive keepalive')).toBeLessThan(text.indexOf('Over 1 pause this session'))
    expect(text.indexOf('Over 1 pause this session')).toBeLessThan(text.indexOf('Settings'))
  })

  test('the Keepalive section says when keepalive pays off, under its heading', { options: { keepalive_count: 3 } }, async ($, on) => {
    kaWorld(on, opusCached())
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const text = await commandText($, '')
    expect(text.indexOf('Keepalive')).toBeLessThan(text.indexOf('Each pause sends'))
    expect(text).toContain('Keepalive pays off if you')
  })
})

describe('the best setup: one sentence, in the pane and in the bare command, priced over this session or recent pauses', () => {
  // Ten ten-minute pauses, each with a million tokens written: on 5 m keepalive costs $5.04 a pause, off $5.48, 1 h $8.00.
  const pauseOf = (i: number, startMs = 1000 + i) => ({ startMs, pausedMs: 10 * MIN, hour: 10, weekday: 2, ratio: 24, ttlMs: 300000, contextTokens: 100000, grownTokens: 1000000 })
  const CHANGE = 'A 5-minute cache with keepalive on would have saved $4.40 over 10 recent pauses: click the pie on.'

  test('the bare command opens its Advice section with the sentence, as one line of the section', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain(`Advice ${CHANGE}`)
  })

  test('the details pane opens with the sentence, wrapped, above the status line', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    const drawn = await drawnPane($)
    expect(drawn.indexOf('"A 5-minute cache with keepalive on')).toBeGreaterThanOrEqual(0)
    expect(drawn.indexOf('"A 5-minute cache with keepalive on')).toBeLessThan(drawn.indexOf('Keepalive is off'))
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
    expect(text).not.toContain('click the pie on')
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
    expect(text).not.toContain('1-hour cache with keepalive on')
    expect(text).toContain("You're on the cheapest setup: with keepalive off, the 5-minute cache saves about $3.00 over 10 recent pauses against the 1-hour one.")
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain('A 5-minute cache with keepalive on would have saved $8.80 over 20 recent pauses: click the pie on.')
  })

  test('a pause another session\'s key has since dropped is not brought back by a later load', async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/x': Array.from({ length: 6 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 6 recent pauses/)
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
  const TO_1H_ON = 'A 1-hour cache with keepalive on would have saved $4.40 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json (new sessions)'

  test('a change of TTL says to click the pie on when new sessions start keepalive off, though it is on here', { options: { keepalive_default: 'off' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': longPauses } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    await commandText($, 'on 15')
    await clock.advance(1000)
    const text = (await commandText($, '')).replace(/\n\s*/g, ' ')
    expect(text).toContain('Keepalive keepalive on')
    expect(text).toContain('A 1-hour cache with keepalive on would have saved $4.40 over 10 recent pauses: set "promptCacheTtl": "1h" in settings.json and, in the new session, click the pie on.')
  })

  test('a change of TTL needs no click when new sessions start keepalive as the change wants', { options: { keepalive_default: 'on' } }, async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': longPauses } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain(`${TO_1H_ON}.`)
  })

  test('with no recorded pause there is no sentence, in the pane or the command', async ($, on) => {
    kaWorld(on, { ...opusCached() })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await commandText($, '')).not.toMatch(/cheapest setup|would have saved/)
    expect(await drawnPane($)).not.toContain('would have saved')
  })

  test('a cold cache drops the sentence while the cold mark stands, as the break-even line does', async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/old': Array.from({ length: 10 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect(await drawnPane($)).toContain('"A 5-minute cache with keepalive on')
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 's' } as any)
    await clock.advance(1000)
    expect(await drawnPane($)).not.toContain('would have saved')
  })

  test("this session's pauses are the ones under its transcript's key: on another transcript they are recent, and the sentence says so", async ($, on) => {
    kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain('A 5-minute cache with keepalive on would have saved $2.20 over 5 pauses this session: click the pie on.')
    // A resume onto another transcript: a new session with no pauses under its key, and no cold mark as a clear would leave.
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/home/test/.claude/projects/p/s3.jsonl' })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toContain('A 5-minute cache with keepalive on would have saved $2.20 over 5 recent pauses: click the pie on.')
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
    expect(text).toMatch(/over \d+ recent pauses/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 recent pauses/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 recent pauses/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 6 recent pauses/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
  })

  test("this session's pauses are bounded as its key is: a pause past the bound drops the oldest, and the sentence prices all that are kept", async ($, on) => {
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: HISTORY_BOUND }, (_, i) => pauseOf(i)) } })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(10 * MIN)
    await userPrompt($)
    await clock.advance(1000)
    expect(rec.store.get('pauses/s1')).toHaveLength(HISTORY_BOUND)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(new RegExp(`over ${HISTORY_BOUND} pauses this session`))
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
    await $.classic.SessionStart({ source: 'resume', transcript_path: S3 })
    await clock.advance(1000)
    await $.classic.SessionStart({ source: 'resume', transcript_path: PATH })
    await clock.advance(1000)
    // The key holds four pauses; the fifth, whose write was refused, is the one this load held for the transcript.
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
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
    expect(await back()).toMatch(/over 5 pauses this session/)
  })

  test("a transcript learned again after another, whose key's read then fails, is read again by a later tick, and until then prices none of it as this session's", async ($, on) => {
    // The other transcript's key is never read, so the last read that landed is the first transcript's.
    const getDenied = new Set<string>(['pauses/s3'])
    const rec = kaWorld(on, { ...opusCached(), store: { 'pauses/s1': Array.from({ length: 5 }, (_, i) => pauseOf(i)) }, getDenied })
    const clock = mock.clock(on, { now: T0 })
    await $.classic.SessionStart({ source: 'startup', transcript_path: PATH })
    await clock.advance(1000)
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 5 pauses this session/)
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
    expect((await commandText($, '')).replace(/\n\s*/g, ' ')).toMatch(/over 6 pauses this session/)
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
    expect(JSON.stringify(await pane.drawn())).toMatch(/over 15 recent pauses/)
    release()
    // No time passes, so no tick draws the footer state again: the read's return alone draws the pane again.
    await clock.advance(0)
    expect(JSON.stringify(await pane.drawn())).toMatch(/over 5 pauses this session/)
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
    expect(JSON.stringify(await pane.drawn())).toMatch(/over 10 recent pauses/)
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
    expect(await drawnPane($)).toContain('~$0.13 to rebuild')
    expect(await toggle($, '')).toContain('Prompt cache expired, ~$0.13 to rebuild.')
  })

  test('in tokens the three give the same figure, the prefix plus the output', async ($, on) => {
    await start($, on)
    await toggle($, 'unit tokens')
    // 25551 tokens; the prefix alone would be ~19k.
    expect(await hint($)).toBe('~26k tokens to rebuild')
    expect(await drawnPane($)).toContain('~26k tokens to rebuild')
    expect(await toggle($, '')).toContain('Prompt cache expired, ~26k tokens to rebuild.')
  })
})
