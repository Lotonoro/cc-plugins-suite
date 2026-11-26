import { describe, expect, test } from 'claude-code/testing'
import type { Conversation, OpenReview, TodoEntry } from '../types/index'
import { BOUND_MS } from './boundary'
import { fakeEngine, never, settled } from './fakes'
import { admitSend, committedNudge, readSend } from './notes'
import { mayPing, pingText, readLists, readingOf, withPing, withText } from './ping'
import type { Stopped } from './ping'

// The conversation a ping is decided on: the auditor on, the user's fourth own prompt the latest, no nudge and no review open, in a turn the user started with one entry recorded.
const standing = (over: Partial<Conversation> = {}): Conversation =>
  ({ off: false, epoch: 2, prompts: 4, nudged: false, dispatchesAtPrompt: 0, review: undefined, turnStart: 'user', wake: { tasks: [], crons: 0 }, lastMessage: 'Done.', record: { blocks: ['[1] USER: fix the parser\n\n'] }, ...over }) as unknown as Conversation

// A review open with the note slot as given, numbered 3.
const reviewing = (note?: string): OpenReview => ({ number: 3, record: [], dispatchedAt: 1, nothingWakes: true, ...(note === undefined ? {} : { note }) })

// A Stop that began at the user's fourth prompt, whose hooks beneath gave nothing and with nothing in flight.
const STOPPED: Stopped = { active: false, beneath: {}, nothingWakes: true, started: 4 }

const ENTRY = (title: string, state: TodoEntry['state'] = 'queued'): TodoEntry => ({ title, state })

describe('mayPing', () => {
  test('a Stop whose guards all pass may ping', () => {
    expect(mayPing(standing(), STOPPED)).toBe(true)
  })

  test('each guard that fails stops it', () => {
    const cases: [string, Conversation, Stopped][] = [
      ['the auditor is off', standing({ off: true }), STOPPED],
      ['the Stop follows a continuation (stop_hook_active)', standing(), { ...STOPPED, active: true }],
      ['a hook beneath blocked', standing(), { ...STOPPED, beneath: { block: 'go on' } }],
      ['a hook beneath blocked with an empty reason', standing(), { ...STOPPED, beneath: { block: '' } }],
      ['a hook beneath stopped the session', standing(), { ...STOPPED, beneath: { preventContinuation: true } }],
      ['the hooks beneath did not answer', standing(), { ...STOPPED, beneath: undefined }],
      ['something in flight will wake the worker, or the stall fact is withheld or unknown', standing(), { ...STOPPED, nothingWakes: false }],
      ['the prompt count at the Stop\'s start is unknown', standing(), { ...STOPPED, started: undefined }],
      ['the user\'s own prompt arrived during the Stop', standing({ prompts: 5 }), STOPPED],
      ['the stall guard is set', standing({ nudged: true }), STOPPED],
      ['a stall note of a review dispatched since the user\'s prompt is admitted and not yet booked', standing({ dispatchesAtPrompt: 2, review: reviewing('Stalled: x.') }), STOPPED],
    ]
    for (const [why, c, s] of cases) expect([why, mayPing(c, s)]).toEqual([why, false])
  })

  test('entries the hooks beneath returned, a note that is not a stall note and an older review\'s stall note do not stop it', () => {
    expect(mayPing(standing(), { ...STOPPED, beneath: { additionalContext: ['one', 'two'] } })).toBe(true)
    expect(mayPing(standing({ review: reviewing('a.ts:4 swallows it.') }), STOPPED)).toBe(true)
    expect(mayPing(standing({ dispatchesAtPrompt: 3, review: reviewing('Stalled: x.') }), STOPPED)).toBe(true)
  })
})

describe('withPing', () => {
  const PING = { text: 'auditor: you stopped with 1 open entry.', epoch: 2, stopped: STOPPED }

  test('a ping sets the guard, leaves no wake line and adds its entry, labelled as a plugin\'s prompt', () => {
    const c = standing()
    const { next, pinged } = withPing(c, PING)
    expect(pinged).toBe(true)
    expect(next).toMatchObject({ nudged: true, wake: null, turnStart: 'user' })
    expect(next.record.blocks).toEqual(['[1] USER: fix the parser\n\n', '[2] PROMPT (plugin): auditor: you stopped with 1 open entry.\n\n'])
  })

  test('a ping in a turn a reviewer\'s task notification started makes the turn recorded, its entry the first', () => {
    const { next } = withPing(standing({ turnStart: 'notice', record: { blocks: [] } }), PING)
    expect(next.turnStart).toBe('other')
    expect(next.record.blocks).toEqual(['[1] PROMPT (plugin): auditor: you stopped with 1 open entry.\n\n'])
  })

  test('a turn another prompt started keeps its start', () => {
    expect(withPing(standing({ turnStart: 'other' }), PING).next.turnStart).toBe('other')
    expect(withPing(standing({ turnStart: null }), PING).next.turnStart).toBeNull()
  })

  test('the write checks again what can have moved since the decision, and changes nothing where it has', () => {
    const cases: [string, Conversation][] = [
      ['the auditor was turned off', standing({ off: true })],
      ['the epoch moved', standing({ epoch: 3 })],
      ['the prompt count moved', standing({ prompts: 5 })],
      ['the guard was set', standing({ nudged: true })],
      ['a stall note was admitted', standing({ review: reviewing('Stalled: x.') })],
    ]
    for (const [why, c] of cases) {
      const written = withPing(c, PING)
      expect([why, written.pinged, written.next === c]).toEqual([why, false, true])
    }
  })

  test('the stall fact the write rests on is the one given, so a worker with something in flight is not pinged', () => {
    const c = standing()
    const written = withPing(c, { ...PING, stopped: { ...STOPPED, nothingWakes: false } })
    expect([written.pinged, written.next === c]).toEqual([false, true])
  })

  test('a ping and a stall note admitted at the same moment: whichever lands first, exactly one of the two takes effect', () => {
    const STALL = readSend('main', 'auditor, review 3:\nStalled: you said you would update the config.')
    const admission = (c: Conversation) => admitSend(STALL, c.review, c.epoch, committedNudge(c))
    // What the gate writes for an admitted note: the body in the open review's slot.
    const filled = (c: Conversation): Conversation => (c.review === undefined ? c : { ...c, review: { ...c.review, note: STALL.body } })
    const open = standing({ review: reviewing() })

    // The ping first: the stall note meets the guard it set.
    const pingFirst = withPing(open, PING)
    expect(pingFirst.pinged).toBe(true)
    expect(admission(pingFirst.next)).toMatchObject({ admitted: false })

    // The stall note first: the ping meets the note admitted into the slot.
    expect(admission(open)).toMatchObject({ admitted: true })
    expect(withPing(filled(open), PING).pinged).toBe(false)
  })
})

describe('withText', () => {
  test('the text is the last entry of the context the hooks beneath returned, whose other fields stay as they were', () => {
    const beneath = { additionalContext: ['one', 'two'], stopReason: 'x' }
    expect(withText(beneath, 'ping')).toEqual({ additionalContext: ['one', 'two', 'ping'], stopReason: 'x' })
    expect(beneath.additionalContext).toEqual(['one', 'two'])
  })

  test('a result with no context gets the text as its only entry', () => {
    expect(withText({}, 'ping')).toEqual({ additionalContext: ['ping'] })
  })
})

describe('pingText', () => {
  test('it names the entries, states the fact and asks for one of three ways out, in one paragraph that opens with the auditor\'s name', () => {
    const text = pingText([ENTRY('Fix the parser', 'in_flight'), ENTRY('Update the config')])
    expect(text).toBe(
      'auditor: you stopped with 2 open entries on your TODO list, and no background task or scheduled wake-up is in flight to wake you: "Fix the parser" (in_flight), "Update the config" (queued). If the work is not done, carry on. If it is done, mark the entries done. If you are waiting on something, say in one line what.',
    )
    expect(text).not.toContain('\n')
  })

  test('a single entry is counted in the singular', () => {
    expect(pingText([ENTRY('Fix the parser')])).toContain('you stopped with 1 open entry on your TODO list')
  })

  test('the entries in flight are named first, each group in its stored order', () => {
    const text = pingText([ENTRY('a'), ENTRY('b', 'in_flight'), ENTRY('c'), ENTRY('d', 'in_flight')])
    expect(text).toContain('"b" (in_flight), "d" (in_flight), "a" (queued), "c" (queued).')
  })

  test('at most five are named, and the rest are counted', () => {
    const text = pingText(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(title => ENTRY(title)))
    expect(text).toContain('you stopped with 7 open entries')
    expect(text).toContain('"a" (queued), "b" (queued), "c" (queued), "d" (queued), "e" (queued), and 2 more.')
    expect(pingText(['a', 'b', 'c', 'd', 'e'].map(title => ENTRY(title)))).not.toContain('more')
    expect(pingText(['a', 'b', 'c', 'd', 'e', 'f'].map(title => ENTRY(title)))).toContain('(queued), and 1 more.')
  })

  test('a title past 80 code points is cut there, with the count cut', () => {
    const text = pingText([ENTRY('x'.repeat(80)), ENTRY(`${'😀'.repeat(80)}tail`)])
    expect(text).toContain(`"${'x'.repeat(80)}" (queued)`)
    expect(text).toContain(`"${'😀'.repeat(80)} …+4 characters" (queued)`)
  })

  test('a line break, a tab or any run of whitespace in a title is one space, so the text stays one paragraph', () => {
    const separator = String.fromCharCode(0x2028)
    const text = pingText([ENTRY('Fix the\nparser'), ENTRY(`  Update \t the\r\n\r\nconfig${separator}now  `)])
    expect(text).toContain('"Fix the parser" (queued), "Update the config now" (queued).')
    expect(text).not.toContain('\n')
  })

  test('a control character in a title is dropped, and the spaces on either side of it are one', () => {
    const text = pingText([ENTRY('Fix \u0007 the\u001b parser\u007f'), ENTRY('Up\u0000date the config')])
    expect(text).toContain('"Fix the parser" (queued), "Update the config" (queued).')
  })

  test('a title is made one line before it is cut, so its whitespace costs it no length', () => {
    const text = pingText([ENTRY(`${'x'.repeat(70)}${'\n'.repeat(20)}`), ENTRY(`${'y'.repeat(40)}\n\n\n${'z'.repeat(39)}`)])
    expect(text).toContain(`"${'x'.repeat(70)}" (queued), "${'y'.repeat(40)} ${'z'.repeat(39)}" (queued).`)
  })

  test('it does not call the stop a stall, which is the reviewer\'s word', () => {
    expect(pingText([ENTRY('a')]).toLowerCase()).not.toContain('stall')
  })
})

describe('readingOf', () => {
  const ITEM = (over: Record<string, unknown> = {}) => ({ id: 3, blocking: true, state: 'open', pressedAt: null, ...over })
  const TODO = [ENTRY('Fix the parser', 'in_flight'), ENTRY('Update the config')]
  const WHAT = (list: unknown, todo: unknown = TODO) => readingOf({ todo, list })

  test('readable entries and a human list with no blocking item give the entries to name, and no line', () => {
    expect(WHAT({ items: [ITEM({ blocking: false })] })).toEqual({ entries: TODO, lines: [] })
  })

  test('a human list never written reads as the empty store: nothing blocks', () => {
    expect(WHAT(undefined)).toEqual({ entries: TODO, lines: [] })
    expect(WHAT(null)).toEqual({ entries: TODO, lines: [] })
    expect(WHAT({ items: [] })).toEqual({ entries: TODO, lines: [] })
  })

  // human-plugin's `items.ts` (`normalizeItem`) reads the item states `open`, `done-waiting` and `done-pending`; a missing or unknown state is open, `blocking` counts only when exactly true, and a `done-waiting` item with no finite press time is open again. This pins that table as of the read; it does not follow the owner if the owner moves it.
  test('a blocking item human-plugin reads as open withholds the ping, naming the item, whatever its state spelling', () => {
    const blocking: [string, Record<string, unknown>][] = [
      ['open', ITEM()],
      ['a missing state', (({ state: _s, ...rest }) => rest)(ITEM())],
      ['an unknown state', ITEM({ state: 'archived' })],
      ['a state that is not text', ITEM({ state: 7 })],
      ['done-waiting with no press time', ITEM({ state: 'done-waiting', pressedAt: null })],
      ['done-waiting with a press time missing', (({ pressedAt: _p, ...rest }) => rest)(ITEM({ state: 'done-waiting' }))],
      ['done-waiting with a press time that is not a number', ITEM({ state: 'done-waiting', pressedAt: '1700' })],
      ['done-waiting with a press time that is not finite', ITEM({ state: 'done-waiting', pressedAt: Number.POSITIVE_INFINITY })],
    ]
    for (const [why, item] of blocking) {
      const read = WHAT({ items: [item] })
      expect([why, read.entries, read.lines.length]).toEqual([why, [], 1])
      expect(read.lines[0]).toBe("auditor: no ping: human-plugin's human list holds an item that may be an open blocking one: #3")
    }
  })

  test('a blocking item human-plugin reads as done does not withhold it', () => {
    expect(WHAT({ items: [ITEM({ state: 'done-pending' })] })).toEqual({ entries: TODO, lines: [] })
    expect(WHAT({ items: [ITEM({ state: 'done-waiting', pressedAt: 1700 })] })).toEqual({ entries: TODO, lines: [] })
    expect(WHAT({ items: [ITEM({ state: 'done-waiting', pressedAt: 0 })] })).toEqual({ entries: TODO, lines: [] })
  })

  test('an item that is not blocking, or whose blocking is not exactly true, does not withhold it', () => {
    for (const blocking of [false, undefined, 'true', 1, null]) expect(WHAT({ items: [ITEM({ blocking })] })).toEqual({ entries: TODO, lines: [] })
  })

  test('an item human-plugin would drop for lacking an id still counts, and is named as one with no id', () => {
    const read = WHAT({ items: [(({ id: _i, ...rest }) => rest)(ITEM())] })
    expect(read.entries).toEqual([])
    expect(read.lines).toEqual(["auditor: no ping: human-plugin's human list holds an item that may be an open blocking one: (no id)"])
  })

  test('every such item is named, in the order stored, in the one line', () => {
    const read = WHAT({ items: [ITEM({ id: 5 }), ITEM({ id: 2, blocking: false }), ITEM({ id: 9, state: 'archived' }), ITEM({ id: 4, state: 'done-pending' })] })
    expect(read.lines).toEqual(["auditor: no ping: human-plugin's human list holds an item that may be an open blocking one: #5, #9"])
  })

  test('an entry in the list that is not an item, among items, is set aside', () => {
    expect(WHAT({ items: [null, 7, 'x', [], ITEM({ blocking: false })] })).toEqual({ entries: TODO, lines: [] })
  })

  test('a human list of a shape the owner does not write gives no ping and a line naming the key', () => {
    for (const list of ['items', 7, true, [ITEM()], {}, { items: 'open' }, { items: { 0: ITEM() } }]) {
      const read = WHAT(list)
      expect([JSON.stringify(list), read.entries, read.lines]).toEqual([JSON.stringify(list), [], ['auditor: no ping: human-plugin\'s "list" holds a value of a shape the ping does not know']])
    }
  })

  test('an absent or empty TODO list gives no ping and no line: there is nothing to name', () => {
    for (const todo of [undefined, null, []]) expect(readingOf({ todo, list: undefined })).toEqual({ entries: [], lines: [] })
  })

  test('a TODO list of a shape the owner does not write, or whose entries none is readable, gives no ping and a line naming the key', () => {
    const unknown = ['one', 7, true, { 0: ENTRY('a') }, [null], [7, 'x'], [{ title: 'a', state: 'done' }], [{ title: 7, state: 'queued' }], [{ state: 'queued' }]]
    for (const todo of unknown) {
      const read = WHAT(undefined, todo)
      expect([JSON.stringify(todo), read.entries, read.lines]).toEqual([JSON.stringify(todo), [], ['auditor: no ping: human-plugin\'s "todo" holds a value of a shape the ping does not know']])
    }
  })

  test('a TODO entry is read as its owner reads it: one whose title is not text or whose state is neither queued nor in flight is skipped, and the rest stand', () => {
    const todo = [ENTRY('a'), { title: 'done one', state: 'done' }, { title: 7, state: 'queued' }, null, { title: 'b', state: 'in_flight', eta: '5m' }]
    expect(WHAT({ items: [] }, todo).entries).toEqual([ENTRY('a'), { title: 'b', state: 'in_flight' }])
  })

  test('both shapes unknown, or an unknown shape beside a blocking item, write one line each', () => {
    expect(WHAT('x', 'y').lines).toEqual([
      'auditor: no ping: human-plugin\'s "todo" holds a value of a shape the ping does not know',
      'auditor: no ping: human-plugin\'s "list" holds a value of a shape the ping does not know',
    ])
    expect(WHAT({ items: [ITEM()] }, 'y').lines.length).toBe(2)
  })
})

describe('readLists', () => {
  // human-plugin's state as the engine answers a plain read: the value at a version, by plugin and key.
  const stateOf = (values: Record<string, unknown>) => {
    const refs: { plugin: string; key: string }[] = []
    return { refs, state: { get: async (ref: { plugin: string; key: string }) => (refs.push({ plugin: ref.plugin, key: ref.key }), { value: values[ref.key], version: 1 }) } }
  }

  test('it reads human-plugin\'s TODO list and human list, by their plugin and key, and gives both as stored', async () => {
    const held = stateOf({ todo: [ENTRY('a')], list: { items: [] } })
    const { $, logs } = fakeEngine({ state: held.state })
    expect(await readLists($)).toEqual({ todo: [ENTRY('a')], list: { items: [] } })
    expect(held.refs).toEqual([{ plugin: 'human-plugin', key: 'todo' }, { plugin: 'human-plugin', key: 'list' }])
    expect(logs).toEqual([])
  })

  test('a key never written reads as no value, which is an answer', async () => {
    const { $ } = fakeEngine({ state: stateOf({}).state })
    expect(await readLists($)).toEqual({ todo: undefined, list: undefined })
  })

  test('a read that rejects gives no lists, and one line names it', async () => {
    const { $, logs } = fakeEngine({ state: { get: (ref: { key: string }) => (ref.key === 'list' ? Promise.reject(new Error('state unreadable')) : Promise.resolve({ value: [ENTRY('a')], version: 1 })) } })
    expect(await readLists($)).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.startsWith('auditor: read of human-plugin\'s "list" state failed: Error: state unreadable')).toBe(true)
  })

  test('each read that fails is named, whichever it is', async () => {
    const { $, logs } = fakeEngine({ state: { get: () => Promise.reject(new Error('down')) } })
    expect(await readLists($)).toBeUndefined()
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain('human-plugin\'s "todo" state failed')
    expect(logs[1]).toContain('human-plugin\'s "list" state failed')
  })

  test('a read that does not answer within the bound gives no lists, and one line names it as late', async () => {
    const { $, logs, timers } = fakeEngine({ state: { get: (ref: { key: string }) => (ref.key === 'todo' ? never() : Promise.resolve({ value: undefined, version: 0 })) } })
    const reading = readLists($)
    await settled()
    expect(timers.map(t => t.ms)).toEqual([BOUND_MS, BOUND_MS])
    timers[0]?.fire()
    expect(await reading).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.startsWith(`auditor: read of human-plugin's "todo" state failed: Error: no answer within ${BOUND_MS} ms`)).toBe(true)
  })

  test('both reads are made before either answers, so the wait is one bound and not two', async () => {
    let asked = 0
    const { $ } = fakeEngine({ state: { get: () => (asked++, never()) } })
    void readLists($)
    await settled()
    expect(asked).toBe(2)
  })
})
