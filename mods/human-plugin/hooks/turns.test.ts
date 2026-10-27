import { expect, test } from 'claude-code/testing'
import { carried, carryHeld, carriesHeld, endTurn, giveBack, handOver, notEntered, offer, pending, reset, setOnChange, startTurn, takeHeld, unreadIds } from './turns'

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
