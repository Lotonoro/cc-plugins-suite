import { expect, test } from 'claude-code/testing'
import { carried, carryHeld, carriesHeld, endHold, endTurn, giveBack, handOver, notEntered, offer, pending, reset, setOnChange, setWalkAsking, startTurn, takeHeld, unreadIds } from './turns'

// The queue is module state: each test starts from an idle session with nothing held.
// LIVE: every item is still on the list.
const LIVE = () => true
const NOW = async () => LIVE
const kept = (into: string[]) => async (text: string) => {
  into.push(text)
  return true
}

test('setOnChange is told after each change to the held and waiting notices, and pending() keeps the held ones apart from the waiting ones', () => {
  reset()
  let told = 0
  setOnChange(() => {
    told += 1
  })
  startTurn()
  offer({ id: 1, text: 'a' })
  offer({ id: 2, text: 'b' })
  expect(told).toBe(2)
  endTurn('t1', true, LIVE)
  expect(told).toBe(3)
  giveBack([{ id: 0, text: 'z' }])
  expect(pending()).toEqual({ held: [{ id: 0, text: 'z' }, { id: 1, text: 'a' }, { id: 2, text: 'b' }], waiting: [] })
  takeHeld()
  expect(pending()).toEqual({ held: [], waiting: [] })
  expect(told).toBe(5)
  setOnChange(() => {})
})

test('a notice offered while the session is idle is submitted, not held', () => {
  reset()
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('submit')
  expect(endTurn('t1', false, LIVE)).toBe(null)
})

test('a notice offered while a turn runs waits for a read point, and is appended there once', async () => {
  reset()
  startTurn()
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('queued')
  const appended: string[] = []
  await handOver(kept(appended), NOW)
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#1 is done: a'])
})

test('an appended notice is unread until a step of the turn carries it, and then nothing is left for the turn end', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  await handOver(kept([]), NOW)
  expect(unreadIds()).toEqual([1, 2])
  carried()
  expect(unreadIds()).toEqual([])
  expect(endTurn('t1', false, LIVE)).toBe(null)
})

test('a notice the engine refuses goes back to waiting, with those after it, and the turn end submits their text', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  offer({ id: 3, text: '#3 is done: c' })
  const appended: string[] = []
  await handOver(async text => {
    appended.push(text)
    return text !== '#2 is done: b'
  }, NOW)
  expect(appended).toEqual(['#1 is done: a', '#2 is done: b'])
  expect(unreadIds()).toEqual([1])
  carried()
  const left = endTurn('t1', false, LIVE)?.text
  expect(left).toContain('#2 is done: b')
  expect(left).toContain('#3 is done: c')
  expect(left?.includes('#1 is done:')).toBe(false)
})

test('the turn end submits a pointer, not the text again, for a notice appended that no step carried', async () => {
  reset()
  startTurn()
  offer({ id: 4, text: '#4 is done: d' })
  await handOver(kept([]), NOW)
  const left = endTurn('t1', false, LIVE)?.text
  expect(left).toContain('#4')
  expect(left?.includes('is done:')).toBe(false)
  expect(endTurn('t1', false, LIVE)).toBe(null)
})

test('the turn end leaves the session idle: a later notice is submitted', async () => {
  reset()
  startTurn()
  endTurn('t1', false, LIVE)
  expect(offer({ id: 5, text: '#5 is done: e' })).toBe('submit')
})

test('a turn end that submits keeps the session busy: a notice that lands before that turn starts waits for it', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  expect(endTurn('t1', false, LIVE)?.text).toBe('#1 is done: a')
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('queued')
})

test('a turn-end submit that does not enter holds its notices for the human\'s next prompt, and the session is idle again', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  const submit = endTurn('t1', false, LIVE)
  expect(submit?.notices).toEqual([{ id: 1, text: '#1 is done: a' }])
  notEntered(submit?.notices ?? [])
  expect(takeHeld()).toEqual([{ id: 1, text: '#1 is done: a' }])
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('submit')
})

test('a notice offered while a hand-over is appending waits for the next read point', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  const appended: string[] = []
  await handOver(async text => {
    offer({ id: 2, text: '#2 is done: b' })
    appended.push(text)
    return true
  }, NOW)
  expect(appended).toEqual(['#1 is done: a'])
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#1 is done: a', '#2 is done: b'])
})

test('a /clear drops what the old conversation still held', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  await handOver(async text => text === '#1 is done: a', NOW)
  reset()
  expect(unreadIds()).toEqual([])
  expect(endTurn('t1', false, LIVE)).toBe(null)
  expect(offer({ id: 3, text: '#3 is done: c' })).toBe('submit')
})

test('an interrupt holds the waiting notices for the human\'s next prompt, and submits nothing', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  expect(endTurn('t1', true, LIVE)).toBe(null)
  expect(takeHeld()).toEqual([{ id: 1, text: '#1 is done: a' }])
  expect(takeHeld()).toEqual([])
})

test('an interrupt does not hold a notice already appended: its row is in the conversation, and the next request reads it', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  expect(endTurn('t1', true, LIVE)).toBe(null)
  expect(takeHeld()).toEqual([])
})

test('a held notice a prompt did not carry goes back, ahead of the others', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  giveBack([{ id: 0, text: '#0 is done: z' }])
  expect(takeHeld()).toEqual([
    { id: 0, text: '#0 is done: z' },
    { id: 1, text: '#1 is done: a' },
  ])
})

test('only the human\'s own prompts carry held notices: the composer and the remote bridge', () => {
  expect(carriesHeld({ kind: 'composer' })).toBe(true)
  expect(carriesHeld({ kind: 'bridge' })).toBe(true)
  expect(carriesHeld({ kind: 'plugin' })).toBe(false)
  expect(carriesHeld({ kind: 'peer' })).toBe(false)
  expect(carriesHeld({ kind: 'task-notification' })).toBe(false)
})

test('a /clear drops the held notices too', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  reset()
  expect(takeHeld()).toEqual([])
})

test('a notice that lands before the first one\'s turn starts waits for that turn: one turn carries both, each read once', async () => {
  reset()
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('submit')
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('queued')
  startTurn()
  const appended: string[] = []
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#2 is done: b'])
  carried()
  expect(endTurn('t1', false, LIVE)).toBe(null)
})

test('a submit that does not enter hands its notice and the waiting ones to the next human prompt, and the session is idle again', () => {
  reset()
  const first = { id: 1, text: '#1 is done: a' }
  expect(offer(first)).toBe('submit')
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('queued')
  notEntered([first])
  expect(takeHeld()).toEqual([first, { id: 2, text: '#2 is done: b' }])
  expect(offer({ id: 3, text: '#3 is done: c' })).toBe('submit')
})

test('a turn end drops the notice of an item the agent has removed, and keeps the rest', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  const left = endTurn('t1', false, id => id !== 1)?.text
  expect(left).toContain('#2 is done: b')
  expect(left?.includes('#1 is done:')).toBe(false)
})

test('a turn end with only a removed item\'s notice starts no turn', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  expect(endTurn('t1', false, () => false)).toBe(null)
})

test('an interrupt holds only the notices whose items are still on the list', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  expect(endTurn('t1', true, id => id === 2)).toBe(null)
  expect(takeHeld()).toEqual([{ id: 2, text: '#2 is done: b' }])
})

test('a pointer to an appended notice whose item was removed is not submitted', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  expect(endTurn('t1', false, () => false)).toBe(null)
})

type Prompt = { origin: { kind: string }; text: string; context?: readonly string[] }
type Answer = { text?: string; drop?: unknown }
const composer = (text: string): Prompt => ({ origin: { kind: 'composer' }, text })

test('the human\'s prompt carries the held notices as context, once', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  const seen: unknown[] = []
  const next = async (e: Prompt): Promise<Answer> => {
    seen.push(e.context)
    return { text: e.text }
  }
  expect(await carryHeld(composer('hi'), next, LIVE)).toEqual({ text: 'hi' })
  await carryHeld(composer('again'), next, LIVE)
  expect(seen).toEqual([['#1 is done: a'], undefined])
})

test('a held notice whose item the agent removed is dropped, not carried: the human\'s prompt gets only the live ones', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  endTurn('t1', true, LIVE)
  const seen: unknown[] = []
  const next = async (e: Prompt): Promise<Answer> => {
    seen.push(e.context)
    return { text: e.text }
  }
  await carryHeld(composer('hi'), next, id => id !== 1)
  expect(seen).toEqual([['#2 is done: b']])
  await carryHeld(composer('again'), next, LIVE)
  expect(seen).toEqual([['#2 is done: b'], undefined])
})

test('a held notice only for removed items carries nothing: the prompt goes through with no context', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  const seen: unknown[] = []
  await carryHeld(composer('hi'), async (e: Prompt): Promise<Answer> => {
    seen.push(e.context)
    return { text: e.text }
  }, () => false)
  expect(seen).toEqual([undefined])
  expect(takeHeld()).toEqual([])
})

test('a prompt that is refused gives the held notices back, so the next human prompt carries them', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  const seen: unknown[] = []
  const refused = async (e: Prompt): Promise<Answer> => {
    seen.push(e.context)
    return { drop: 'no' }
  }
  expect(await carryHeld(composer('hi'), refused, LIVE)).toEqual({ drop: 'no' })
  await carryHeld(composer('again'), async (e: Prompt): Promise<Answer> => {
    seen.push(e.context)
    return { text: e.text }
  }, LIVE)
  expect(seen).toEqual([['#1 is done: a'], ['#1 is done: a']])
})

test('a prompt that throws gives the held notices back and rethrows the error', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  const failing = async (): Promise<Answer> => {
    throw new Error('boom')
  }
  await expect(carryHeld(composer('hi'), failing, LIVE)).rejects.toThrow('boom')
  expect(takeHeld()).toEqual([{ id: 1, text: '#1 is done: a' }])
})

test('a plugin\'s prompt passes through untouched and leaves the held notices for the human', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  endTurn('t1', true, LIVE)
  const plugin: Prompt = { origin: { kind: 'plugin' }, text: 'p' }
  const seen: unknown[] = []
  await carryHeld(plugin, async (e: Prompt): Promise<Answer> => {
    seen.push(e)
    return { text: e.text }
  }, LIVE)
  expect(seen).toEqual([plugin])
  expect(takeHeld()).toEqual([{ id: 1, text: '#1 is done: a' }])
})

test('a queued notice whose item is gone when its row would be appended is dropped, not appended', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  const appended: string[] = []
  await handOver(kept(appended), async () => id => id !== 1)
  expect(appended).toEqual(['#2 is done: b'])
  expect(endTurn('t1', false, LIVE)?.text).toBe('human-plugin: #2 was marked done while you worked; its notice is above.')
})

test('the hand-over reads the list again before each row: an item removed while an earlier row was appended is dropped', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  const items = new Set([1, 2])
  const appended: string[] = []
  await handOver(async text => {
    appended.push(text)
    items.delete(2)
    return true
  }, async () => {
    // A snapshot of the list at the call, as the mod's read takes it: a check made once, before the loop, would not see the removal.
    const snapshot = new Set(items)
    return id => snapshot.has(id)
  })
  expect(appended).toEqual(['#1 is done: a'])
})

test('a second end of the same turn changes nothing: a submit the first end made keeps the session busy', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  expect(endTurn('t1', false, LIVE)?.text).toBe('#1 is done: a')
  expect(endTurn('t1', false, LIVE)).toBe(null)
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('queued')
})

test('an interrupt during a hand-over\'s append holds the notices it had not appended, and the one in flight once it is refused', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: 'a' })
  offer({ id: 2, text: 'b' })
  const appended: string[] = []
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  let verdict!: (kept: boolean) => void
  const decided = new Promise<boolean>(resolve => { verdict = resolve })
  const run = handOver(async text => {
    appended.push(text)
    started()
    return decided
  }, NOW)
  await begun
  expect(endTurn('t1', true, LIVE)).toBe(null)
  verdict(false)
  await run
  expect(appended).toEqual(['a'])
  expect(takeHeld().map(notice => notice.id)).toEqual([1, 2])
})

test('an interrupt during a hand-over\'s append delivers the notice in flight once, and holds the notices after it, never appending them', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: 'a' })
  offer({ id: 2, text: 'b' })
  const appended: string[] = []
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  let verdict!: (kept: boolean) => void
  const decided = new Promise<boolean>(resolve => { verdict = resolve })
  const run = handOver(async text => {
    appended.push(text)
    started()
    return decided
  }, NOW)
  await begun
  expect(endTurn('t1', true, LIVE)).toBe(null)
  verdict(true)
  await run
  expect(appended).toEqual(['a'])
  expect(takeHeld().map(notice => notice.id)).toEqual([2])
})

test('a notice appended after an interrupt ended its turn is not pointed at by the next turn\'s end', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: 'a' })
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  let verdict!: (kept: boolean) => void
  const decided = new Promise<boolean>(resolve => { verdict = resolve })
  const run = handOver(async () => {
    started()
    return decided
  }, NOW)
  await begun
  expect(endTurn('t1', true, LIVE)).toBe(null)
  verdict(true)
  await run
  startTurn()
  expect(endTurn('t2', false, LIVE)).toBe(null)
})

test('a notice appended after a normal end of its turn is not pointed at by the next turn\'s end', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: 'a' })
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  let verdict!: (kept: boolean) => void
  const decided = new Promise<boolean>(resolve => { verdict = resolve })
  const run = handOver(async () => {
    started()
    return decided
  }, NOW)
  await begun
  expect(endTurn('t1', false, LIVE)).toBe(null)
  verdict(true)
  await run
  startTurn()
  expect(endTurn('t2', false, LIVE)).toBe(null)
})

// A walk is asking (walk.ts switches it): the engine refuses a submit made while the walk's command hook is in flight, so none is tried. Each test that
// switches it on starts from reset(), which switches it off.
test('while a walk is asking, a notice offered to an idle session waits and no submit is asked for: the session stays idle, and the saved record is told', () => {
  reset()
  let told = 0
  setOnChange(() => {
    told += 1
  })
  setWalkAsking(true)
  expect(offer({ id: 1, text: 'a' })).toBe('walk')
  expect(offer({ id: 2, text: 'b' })).toBe('walk')
  expect(told).toBe(2)
  expect(pending()).toEqual({ held: [], waiting: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] })
  setOnChange(() => {})
})

test('a notice offered while a turn runs goes to its read point when a walk is asking, as it does without one', async () => {
  reset()
  startTurn()
  setWalkAsking(true)
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('queued')
  const appended: string[] = []
  await handOver(kept(appended), NOW)
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#1 is done: a'])
})

test('a walk that cannot arm its release ends the hold itself: the next notice takes the idle path, and the turn it starts appends the walk\'s earlier notice once', async () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  setWalkAsking(false)
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('submit')
  startTurn()
  const appended: string[] = []
  await handOver(kept(appended), NOW)
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#1 is done: a'])
})

test('the next turn to start appends the notices a walk kept, once each, and leaves out the one whose item has gone', async () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  offer({ id: 3, text: '#3 is done: c' })
  setWalkAsking(false)
  startTurn()
  const appended: string[] = []
  await handOver(kept(appended), async () => id => id !== 2)
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#1 is done: a', '#3 is done: c'])
  expect(pending()).toEqual({ held: [], waiting: [] })
})

test('a turn that ends, not interrupted, while a walk is asking submits nothing: its leftovers wait with the pointer to a notice it appended, the session is idle, and the walk\'s release delivers both', async () => {
  reset()
  let told = 0
  setOnChange(() => {
    told += 1
  })
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  offer({ id: 2, text: '#2 is done: b' })
  offer({ id: 3, text: '#3 is done: c' })
  setWalkAsking(true)
  const before = told
  expect(endTurn('t1', false, id => id !== 3)).toBe(null)
  expect(told).toBeGreaterThan(before)
  expect(pending()).toEqual({ held: [], waiting: [{ id: 2, text: '#2 is done: b' }] })
  expect(offer({ id: 4, text: '#4 is done: d' })).toBe('walk')
  expect(endHold(LIVE)).toEqual({
    text: 'human-plugin: #1 was marked done while you worked; its notice is above.\n\n#2 is done: b\n\n#4 is done: d',
    notices: [{ id: 2, text: '#2 is done: b' }, { id: 4, text: '#4 is done: d' }],
    pointed: [1],
  })
  setOnChange(() => {})
})

test('a request that starts before the walk\'s release carries the notices a turn appended, so the release does not point to them', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  setWalkAsking(true)
  expect(endTurn('t1', false, LIVE)).toBe(null)
  startTurn()
  carried()
  expect(endTurn('t2', false, LIVE)).toBe(null)
  offer({ id: 2, text: '#2 is done: b' })
  expect(endHold(LIVE)).toEqual({ text: '#2 is done: b', notices: [{ id: 2, text: '#2 is done: b' }], pointed: [] })
})

test('a pointer a turn kept for the walk\'s release is left out when the item of the notice it points to has gone', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  await handOver(kept([]), NOW)
  setWalkAsking(true)
  expect(endTurn('t1', false, LIVE)).toBe(null)
  expect(endHold(id => id !== 1)?.text).toBe('human-plugin: #2 was marked done while you worked; its notice is above.')
})

test('a turn that is interrupted while a walk is asking holds its leftovers for the human\'s next prompt, as it does without one', () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  setWalkAsking(true)
  expect(endTurn('t1', true, LIVE)).toBe(null)
  expect(pending()).toEqual({ held: [{ id: 1, text: '#1 is done: a' }], waiting: [] })
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('walk')
})

test('a /clear ends the hold: a notice offered afterwards takes the idle path', () => {
  reset()
  setWalkAsking(true)
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('walk')
  reset()
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('submit')
})

// The walk's release (deliver.ts makes it a second after the walk's end): it ends the hold and takes what is owed, by the rule a turn's end uses.
test('the release ends the hold and delivers the waiting notices whose items are still on the list as one prompt, each once, and the session is busy until that prompt enters', () => {
  reset()
  let told = 0
  setOnChange(() => {
    told += 1
  })
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  offer({ id: 2, text: '#2 is done: b' })
  offer({ id: 3, text: '#3 is done: c' })
  const before = told
  expect(endHold(id => id !== 2)).toEqual({
    text: '#1 is done: a\n\n#3 is done: c',
    notices: [{ id: 1, text: '#1 is done: a' }, { id: 3, text: '#3 is done: c' }],
    pointed: [],
  })
  expect(told).toBeGreaterThan(before)
  expect(pending()).toEqual({ held: [], waiting: [] })
  expect(endHold(LIVE)).toBe(null)
  // The prompt is starting a turn: a notice that lands before it starts waits for it.
  expect(offer({ id: 4, text: '#4 is done: d' })).toBe('queued')
  setOnChange(() => {})
})

test('a release with nothing owed delivers nothing, tells the saved record of nothing, ends the hold and leaves the session idle: the next notice takes the idle path', () => {
  reset()
  let told = 0
  setOnChange(() => {
    told += 1
  })
  setWalkAsking(true)
  expect(endHold(LIVE)).toBe(null)
  expect(told).toBe(0)
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('submit')
  setOnChange(() => {})
})

test('a release whose only waiting notices are for items that have gone delivers nothing and ends the hold', () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  expect(endHold(() => false)).toBe(null)
  expect(pending()).toEqual({ held: [], waiting: [] })
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('submit')
})

test('a release whose prompt does not enter holds its notices for the human\'s next prompt, and the session is idle again', () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  const submit = endHold(LIVE)
  notEntered(submit?.notices ?? [])
  expect(takeHeld()).toEqual([{ id: 1, text: '#1 is done: a' }])
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('submit')
})

test('a release with a turn running delivers nothing but ends the hold: that turn appends the waiting notices at its read point, and its end submits what it leaves', async () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  startTurn()
  expect(endHold(LIVE)).toBe(null)
  expect(pending()).toEqual({ held: [], waiting: [{ id: 1, text: '#1 is done: a' }] })
  // A notice offered after the release goes to the running turn, and not to the walk.
  expect(offer({ id: 2, text: '#2 is done: b' })).toBe('queued')
  expect(endTurn('t1', false, LIVE)?.text).toBe('#1 is done: a\n\n#2 is done: b')
})

test('a release with a turn running leaves the notices for that turn\'s read point, which appends each once', async () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  startTurn()
  expect(endHold(LIVE)).toBe(null)
  const appended: string[] = []
  await handOver(kept(appended), NOW)
  await handOver(kept(appended), NOW)
  expect(appended).toEqual(['#1 is done: a'])
})

test('a release while a submit is starting a turn delivers nothing: the notices wait for that turn', () => {
  reset()
  expect(offer({ id: 1, text: '#1 is done: a' })).toBe('submit')
  setWalkAsking(true)
  offer({ id: 2, text: '#2 is done: b' })
  expect(endHold(LIVE)).toBe(null)
  expect(pending()).toEqual({ held: [], waiting: [{ id: 2, text: '#2 is done: b' }] })
})

test('a turn that starts while the hold is on appends the notices a walk kept, and the release has nothing left to deliver', async () => {
  reset()
  setWalkAsking(true)
  offer({ id: 1, text: '#1 is done: a' })
  startTurn()
  const appended: string[] = []
  await handOver(kept(appended), NOW)
  carried()
  expect(appended).toEqual(['#1 is done: a'])
  expect(endHold(LIVE)).toBe(null)
  expect(endTurn('t1', false, LIVE)).toBe(null)
})

test('the release leaves the notices an interrupt held for the human\'s prompt, and a pointer to an interrupted turn\'s appended notices is not sent', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  offer({ id: 2, text: '#2 is done: b' })
  setWalkAsking(true)
  expect(endTurn('t1', true, LIVE)).toBe(null)
  offer({ id: 3, text: '#3 is done: c' })
  expect(endHold(LIVE)).toEqual({ text: '#3 is done: c', notices: [{ id: 3, text: '#3 is done: c' }], pointed: [] })
  expect(takeHeld()).toEqual([{ id: 2, text: '#2 is done: b' }])
})

test('a release whose only owed notices are held ones delivers nothing, and they stay for the human\'s next prompt', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  offer({ id: 2, text: '#2 is done: b' })
  endTurn('t0', true, LIVE)
  setWalkAsking(true)
  startTurn()
  offer({ id: 3, text: '#3 is done: c' })
  await handOver(kept([]), NOW)
  expect(endTurn('t1', true, LIVE)).toBe(null)
  expect(endHold(LIVE)).toBe(null)
  expect(takeHeld()).toEqual([{ id: 2, text: '#2 is done: b' }])
})

test('a release delivers a pointer alone when a turn that ended during the walk left only appended notices no request carried', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  setWalkAsking(true)
  expect(endTurn('t1', false, LIVE)).toBe(null)
  expect(endHold(LIVE)).toEqual({
    text: 'human-plugin: #1 was marked done while you worked; its notice is above.',
    notices: [],
    pointed: [1],
  })
})

test('a release that has pointed to the appended notices has taken them: a turn that ends later does not point to them again', async () => {
  reset()
  startTurn()
  offer({ id: 1, text: '#1 is done: a' })
  await handOver(kept([]), NOW)
  setWalkAsking(true)
  expect(endTurn('t1', false, LIVE)).toBe(null)
  const submit = endHold(LIVE)
  expect(submit?.pointed).toEqual([1])
  // The prompt did not enter, so no request carried the pointer; a turn that starts and ends afterwards leaves it unsaid.
  notEntered(submit?.notices ?? [])
  startTurn()
  offer({ id: 2, text: '#2 is done: b' })
  expect(endTurn('t2', false, LIVE)?.text).toBe('#2 is done: b')
})
