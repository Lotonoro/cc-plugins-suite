import { expect, test } from 'claude-code/testing'
import { replay, rowsOf, type Source } from './replay'
import { TOOL } from './items'
import { TODO_TOOL } from './todo'
import { correctionText } from './restatement'

const row = (ts: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content }, ...extra })
const call = (ts: string, id: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: TOOL, input }] },
  })
const result = (ts: string, id: string, text: string, isError = false) =>
  row(ts, [{ type: 'tool_result', tool_use_id: id, content: text, ...(isError ? { is_error: true } : {}) }])
const notice = (ts: string, text: string) =>
  row(ts, text, { origin: { kind: 'plugin', name: 'human-plugin' } })

// The text arriving in pieces of `size` characters, as the host streams a file: a line may span two pieces.
async function* piecesOf(text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}
const sourceOf = (text: string, agent: string | null = null, size = 65536): Source => ({ rows: rowsOf(piecesOf(text, size)), agent })

const MAIN = [
  call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db', blocking: true, detail: 'pg or sqlite' }),
  result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
  call('2026-10-20T10:00:02.000Z', 'b', { action: 'add', title: 'Denied one' }),
  result('2026-10-20T10:00:03.000Z', 'b', 'Denied by the user', true),
  notice('2026-10-20T10:00:04.000Z', '#1 is done: Pick a db\nThe human marked it done. If the item proposed something or carried a recommendation, that is a go-ahead for it. Check that it is finished, then remove it, or update it with a note if it still needs work.'),
  call('2026-10-20T10:00:05.000Z', 'c', { action: 'update', id: 1, note: 'still open' }),
  result('2026-10-20T10:00:06.000Z', 'c', 'updated #1'),
  call('2026-10-20T10:00:06.500Z', 'x', { action: 'update', id: 1, detail: 'should not apply' }),
  result('2026-10-20T10:00:06.600Z', 'x', 'Denied by the user', true),
  call('2026-10-20T10:00:07.000Z', 'd', { action: 'remove', id: 9 }),
  result('2026-10-20T10:00:08.000Z', 'd', 'no item #9', true),
].join('\n') + '\n'

const SUB = [
  call('2026-10-20T10:00:03.500Z', 'e', { action: 'add', title: 'Sub ask' }),
  result('2026-10-20T10:00:03.600Z', 'e', 'added #2'),
].join('\n') + '\n'

test('replay rebuilds the list from the main and subagent transcripts in time order', async () => {
  const { store, skipped, unreadable } = await replay([sourceOf(MAIN), sourceOf(SUB, 'sub-1')])
  expect(store.next).toBe(3)
  expect(store.items.map(it => it.id)).toEqual([1, 2])
  expect(store.items[0]?.state).toBe('open')
  expect(store.items[0]?.note).toBe('still open')
  expect(store.items[0]?.blocking).toBe(true)
  expect(store.items[0]?.detail).toBe('pg or sqlite')
  expect(store.items[0]?.agent).toBe(null)
  expect(store.items[1]?.agent).toBe('sub-1')
  expect(store.items.every(it => it.unread === false)).toBe(true)
  expect(skipped).toBe(0)
  expect(unreadable).toEqual([])
})

test('a resume rebuilds the term the main agent last stated, on an add or an update; a subagent\'s term is not used', async () => {
  const main = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db', term: 'owner' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1 (term set to "owner")'),
    call('2026-10-20T10:00:05.000Z', 'b', { action: 'update', id: 1, term: 'lead' }),
    result('2026-10-20T10:00:06.000Z', 'b', 'no change to #1 (term set to "lead")'),
  ].join('\n') + '\n'
  const sub = [
    call('2026-10-20T10:00:07.000Z', 'e', { action: 'add', title: 'Sub ask', term: 'the user' }),
    result('2026-10-20T10:00:08.000Z', 'e', 'added #2 (term not used: only the main agent sets it)'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(main), sourceOf(sub, 'sub-1')])
  expect(store.term).toBe('lead')
  expect(store.items.map(it => it.id)).toEqual([1, 2])
})

test('a transcript that ends on a clear replays the cleared term, not the one before it', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db', term: 'owner' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1 (term set to "owner")'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'update', id: 1, term: '  ' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'no change to #1 (term cleared)'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.term).toBe('')
})

test('a call the mod refused for a term over the limit never ran, so the term before it stays', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db', term: 'owner' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1 (term set to "owner")'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'update', id: 1, term: 'x'.repeat(21) }),
    result('2026-10-20T10:00:03.000Z', 'b', 'term must be at most 20 columns: give the short word or name you use for the human', true),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.term).toBe('owner')
})

test('a subagent\'s term is not used, so an add it states over the limit still replays its item', async () => {
  const sub = [
    call('2026-10-20T10:00:03.000Z', 'e', { action: 'add', title: 'Sub ask', term: 'x'.repeat(21) }),
    result('2026-10-20T10:00:04.000Z', 'e', 'added #1 (term not used: only the main agent sets it)'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(sub, 'sub-1')])
  expect(store.items.map(it => it.title)).toEqual(['Sub ask'])
  expect(store.term).toBe(null)
})

test('a line may be split at any piece boundary', async () => {
  const whole = await replay([sourceOf(MAIN)])
  for (const size of [1, 7, 300]) {
    expect(await replay([sourceOf(MAIN, null, size)])).toEqual(whole)
  }
})

test('a done notice marks the item done-pending', async () => {
  const { store } = await replay([sourceOf(MAIN.split('\n').slice(0, 5).join('\n') + '\n')])
  expect(store.items[0]?.state).toBe('done-pending')
})

const REPLY_NOTICE = '#1 is done: Pick a db\nThe human replied on #1: use sqlite\nAct on that reply, then remove it.'

test('a reply notice then an append rebuilds the item open, the reply first in its thread and the append after it, the brief as it was', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    notice('2026-10-20T10:00:02.000Z', REPLY_NOTICE),
    call('2026-10-20T10:00:03.000Z', 'b', { action: 'append', id: 1, text: 'sqlite needs a file' }),
    result('2026-10-20T10:00:04.000Z', 'b', 'appended to #1'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items[0]).toMatchObject({ state: 'open', answer: null, replied: false, unread: false, detail: '' })
  expect(store.items[0]?.thread).toEqual([{ speaker: 'human', words: 'use sqlite' }, { speaker: 'agent', words: 'sqlite needs a file' }])
})

const REPLY_NOTICE_2 = '#1 is done: Pick a db\nThe human replied on #1: use postgres\nAct on that reply, then remove it.'

test('a resumed transcript of a reply, an append, a reply and an append rebuilds the thread the live list holds', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    notice('2026-10-20T10:00:02.000Z', REPLY_NOTICE),
    call('2026-10-20T10:00:03.000Z', 'b', { action: 'append', id: 1, text: 'sqlite needs a file' }),
    result('2026-10-20T10:00:04.000Z', 'b', 'appended to #1'),
    notice('2026-10-20T10:00:05.000Z', REPLY_NOTICE_2),
    call('2026-10-20T10:00:06.000Z', 'c', { action: 'append', id: 1, text: 'postgres needs a server' }),
    result('2026-10-20T10:00:07.000Z', 'c', 'appended to #1'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items[0]).toMatchObject({ state: 'open', detail: '' })
  expect(store.items[0]?.thread).toEqual([
    { speaker: 'human', words: 'use sqlite' },
    { speaker: 'agent', words: 'sqlite needs a file' },
    { speaker: 'human', words: 'use postgres' },
    { speaker: 'agent', words: 'postgres needs a server' },
  ])
})

test('a reply notice with no append after it rebuilds the item sent, its answer derived and its thread empty', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    notice('2026-10-20T10:00:02.000Z', REPLY_NOTICE),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'use sqlite', replied: true, thread: [] })
})

test('an append made before the reply notice reached the transcript rebuilds the item sent: the resume order puts the change first, in the brief', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'append', id: 1, text: 'sqlite needs a file' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'appended to #1'),
    notice('2026-10-20T10:00:04.000Z', REPLY_NOTICE),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'use sqlite', replied: true, detail: 'sqlite needs a file', thread: [] })
})

test('an update made before the reply notice reached the transcript rebuilds the item sent with the update in it, as an append made then does', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'update', id: 1, detail: 'Postgres or sqlite?' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'updated #1'),
    notice('2026-10-20T10:00:04.000Z', REPLY_NOTICE),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'use sqlite', replied: true, detail: 'Postgres or sqlite?', thread: [], windowChanged: false })
})

test('on an item answered before, an append made before the next reply notice reached the transcript rebuilds as an agent turn ahead of that reply', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    notice('2026-10-20T10:00:02.000Z', REPLY_NOTICE),
    call('2026-10-20T10:00:03.000Z', 'b', { action: 'append', id: 1, text: 'sqlite needs a file' }),
    result('2026-10-20T10:00:04.000Z', 'b', 'appended to #1'),
    call('2026-10-20T10:00:05.000Z', 'c', { action: 'append', id: 1, text: 'postgres needs a server' }),
    result('2026-10-20T10:00:06.000Z', 'c', 'appended to #1'),
    notice('2026-10-20T10:00:07.000Z', REPLY_NOTICE_2),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'use postgres', replied: true, detail: '' })
  expect(store.items[0]?.thread).toEqual([
    { speaker: 'human', words: 'use sqlite' },
    { speaker: 'agent', words: 'sqlite needs a file' },
    { speaker: 'agent', words: 'postgres needs a server' },
  ])
})

test('a failed or denied tool result is not replayed', async () => {
  const { store } = await replay([sourceOf(MAIN)])
  expect(store.items.some(it => it.title === 'Denied one')).toBe(false)
})

test('a half-written last line is dropped without a skip, and a corrupt complete line is skipped and counted', async () => {
  const partial = await replay([sourceOf(MAIN + '{"type":"assis')])
  expect(partial.store.items.length).toBe(1)
  expect(partial.skipped).toBe(0)
  const corrupt = await replay([sourceOf('{"broken\n' + MAIN)])
  expect(corrupt.skipped).toBe(1)
  expect(corrupt.store.items.map(it => it.title)).toEqual(['Pick a db'])
})

test('an empty transcript replays to an empty list', async () => {
  expect((await replay([sourceOf('')])).store).toEqual({ items: [], next: 1, term: null })
})

test('a row whose timestamp is no date cannot be placed in time: its call and its notice are skipped and counted, the rest replays', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Pick a db' }),
    result('no date', 'a', 'added #1'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'add', title: 'Second' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'added #2'),
    notice('no date', '#2 is done: Second\nThe human marked it done. Check that it is finished, then remove it.'),
  ].join('\n') + '\n'
  const { store, skipped } = await replay([sourceOf(text)])
  expect(store.items.map(it => `${it.id} ${it.title} ${it.state}`)).toEqual(['2 Second open'])
  expect(skipped).toBe(2)
})

test('ids continue past removed items on resume, so a new add gets a fresh id', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'One' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'add', title: 'Two' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'added #2'),
    call('2026-10-20T10:00:04.000Z', 'c', { action: 'remove', id: 2 }),
    result('2026-10-20T10:00:05.000Z', 'c', 'removed #2'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items.map(it => it.id)).toEqual([1])
  expect(store.next).toBe(3)
})

test('a transcript over 4 MiB replays whole, read in pieces that split its lines', async () => {
  const padding = row('2026-10-20T10:00:01.500Z', [{ type: 'tool_result', tool_use_id: 'pad', content: 'x'.repeat(5 * 1024 * 1024) }])
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'Big ask' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    padding,
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'add', title: 'After padding' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'added #2'),
  ].join('\n') + '\n'
  expect(text.length).toBeGreaterThan(4 * 1024 * 1024)
  const { store } = await replay([sourceOf(text, null, 1000003)])
  expect(store.items.map(it => it.title)).toEqual(['Big ask', 'After padding'])
  expect(store.next).toBe(3)
})

// Rows as the transcript links them: each names the row it hangs from. A /rewind writes nothing; the next prompt hangs
// from the row before the prompt it rewound to, so the abandoned branch stays in the file, opened by its own prompt
// (seen in sessions 33893700 and 5349feda). The tip, the last row written, is on the live branch.
const link = (uuid: string, parent: string | null, ts: string, body: Record<string, unknown>) =>
  JSON.stringify({ uuid, parentUuid: parent, timestamp: ts, ...body })
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const toolUse = (id: string, input: Record<string, unknown>, name: string = TOOL) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  ...extra,
})
const note = (text: string) => ({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] }, origin: { kind: 'plugin', name: 'human-plugin' } })
const lines = (...rows: string[]) => rows.map(line => line + '\n').join('')
const at = (s: number) => `2026-10-20T10:00:${String(s).padStart(2, '0')}.000Z`

// #2 is added on a branch a /rewind abandoned; the live branch adds #3. A notice appended mid-turn hangs beside the
// spine (n-3 from a-new, as r-new does), and the turn goes on from r-new.
const REWOUND = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Kept' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('p-old', 'r1', at(3), prompt('ask for gone')),
  link('a-old', 'p-old', at(4), toolUse('old', { action: 'add', title: 'Gone' })),
  link('r-old', 'a-old', at(5), toolResult('old', 'added #2')),
  link('n-old', 'r-old', at(6), note('#1 is done: Kept')),
  link('p-new', 'r1', at(7), prompt('ask for new')),
  link('a-new', 'p-new', at(8), toolUse('new', { action: 'add', title: 'New' })),
  link('r-new', 'a-new', at(9), toolResult('new', 'added #3')),
  link('n-3', 'a-new', at(10), note('#3 is done: New')),
  link('tail', 'r-new', at(11), { type: 'assistant', message: { role: 'assistant', content: 'done' } }),
)

test('a rewound branch is not replayed: its prompt is off the live branch, and so is everything below it', async () => {
  const { store } = await replay([sourceOf(REWOUND)])
  expect(store.items.map(it => it.title)).toEqual(['Kept', 'New'])
})

test('a notice beside the live branch counts; one on a rewound branch does not', async () => {
  const { store } = await replay([sourceOf(REWOUND)])
  expect(store.items.map(it => `${it.id}:${it.state}`)).toEqual(['1:open', '3:done-pending'])
})

test('ids continue past every id the transcript handed out, a rewound branch\'s included', async () => {
  const { store, known } = await replay([sourceOf(REWOUND)])
  expect(store.next).toBe(4)
  expect([...known].sort()).toEqual([1, 2, 3])
})

// Compaction keeps the conversation's tail. The boundary has no parent and names the last row before it as its logical
// parent; that row (a reminder) is first written after the boundary, re-parented onto the kept prompt (seen in 17 of
// 55 boundaries, for example 11ca72f7 line 4732). Before the boundary, #2 is on a rewound branch.
const COMPACTED = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Before' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('p-old', 'r1', at(3), prompt('ask for gone')),
  link('a-old', 'p-old', at(4), toolUse('old', { action: 'add', title: 'Gone' })),
  link('r-old', 'a-old', at(5), toolResult('old', 'added #2')),
  link('p-new', 'r1', at(6), prompt('ask again')),
  link('a3', 'p-new', at(7), toolUse('t3', { action: 'add', title: 'Rewound into' })),
  link('r3', 'a3', at(8), toolResult('t3', 'added #3')),
  JSON.stringify({ uuid: 'boundary', parentUuid: null, logicalParentUuid: 'reminder', timestamp: at(9), type: 'system', subtype: 'compact_boundary' }),
  link('kept', 'boundary', at(10), prompt('go on')),
  link('reminder', 'kept', at(8), { type: 'attachment', attachment: { type: 'total_tokens_reminder' } }),
  link('a4', 'reminder', at(11), toolUse('t4', { action: 'add', title: 'After' })),
  link('r4', 'a4', at(12), toolResult('t4', 'added #4')),
)

test('the live branch crosses a compaction whose boundary names a row written after it', async () => {
  const { store } = await replay([sourceOf(COMPACTED)])
  expect(store.items.map(it => it.title)).toEqual(['Before', 'Rewound into', 'After'])
  expect(store.next).toBe(5)
})

test('a boundary whose logical parent is written before it is crossed by that link', async () => {
  const before = COMPACTED.replace('"logicalParentUuid":"reminder"', '"logicalParentUuid":"r3"')
  const { store } = await replay([sourceOf(before)])
  expect(store.items.map(it => it.title)).toEqual(['Before', 'Rewound into', 'After'])
})

// A row can hang from one never written (3d8085bc line 4735, fb6151b9 line 51891): the branch goes on from the row
// written just before it.
test('a link to a row never written is bridged to the row written before it', async () => {
  const holed = REWOUND.replace('"uuid":"a-new","parentUuid":"p-new"', '"uuid":"a-new","parentUuid":"never-written"')
  const { store } = await replay([sourceOf(holed)])
  expect(store.items.map(it => it.title)).toEqual(['Kept', 'New'])
})

// Parallel calls: each result hangs from its own call's row, and the turn goes on from the last result (27c017fd lines
// 154-161), so a result that is not last is beside the spine.
test('the result of a call made in parallel with another tool counts', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'In parallel' })),
    link('a2', 'a1', at(1), toolUse('t2', { command: 'ls' }, 'Bash')),
    link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
    link('r2', 'a2', at(3), toolResult('t2', 'ok')),
    link('tail', 'r2', at(4), { type: 'assistant', message: { role: 'assistant', content: 'done' } }),
  )
  const { store } = await replay([sourceOf(text)])
  expect(store.items.map(it => it.title)).toEqual(['In parallel'])
})

// A subagent's file counts when the main transcript's Agent result naming it is live (toolUseResult.agentId, as in
// c32f91dd line 160), not when it was spawned only on a rewound branch. A file no Agent result names still counts.
// The rewound turn came last, so its subagent handed out the highest id.
const SPAWNING = lines(
  link('u0', null, at(0), prompt('start')),
  link('p-live', 'u0', at(1), prompt('spawn one')),
  link('s-live', 'p-live', at(1), toolUse('sp-live', { prompt: 'x' }, 'Agent')),
  link('sr-live', 's-live', at(4), toolResult('sp-live', 'done', { toolUseResult: { agentId: 'sub-live' } })),
  link('p-old', 'sr-live', at(5), prompt('spawn another')),
  link('s-old', 'p-old', at(5), toolUse('sp-old', { prompt: 'y' }, 'Agent')),
  link('sr-old', 's-old', at(7), toolResult('sp-old', 'done', { toolUseResult: { agentId: 'sub-dead' } })),
  link('p-new', 'sr-live', at(8), prompt('after the rewind')),
)
const subAdd = (s: number, id: string, title: string, n: number) =>
  lines(link(`${id}-a`, null, at(s), toolUse(id, { action: 'add', title })), link(`${id}-r`, `${id}-a`, at(s + 1), toolResult(id, `added #${n}`)))

test('a subagent spawned only on a rewound branch is not replayed; its ids still count', async () => {
  const { store } = await replay([
    sourceOf(SPAWNING),
    sourceOf(subAdd(2, 'l', 'Live sub ask', 1), 'sub-live'),
    sourceOf(subAdd(3, 'u', 'Unnamed sub ask', 2), 'sub-unnamed'),
    sourceOf(subAdd(6, 'd', 'Dead sub ask', 3), 'sub-dead'),
  ])
  expect(store.items.map(it => it.title)).toEqual(['Live sub ask', 'Unnamed sub ask'])
  expect(store.next).toBe(4)
})

// A subagent file that cannot be read is left out alone; the main transcript's failure fails the replay.
async function* failing(after: string): AsyncGenerator<string> {
  yield after
  throw new Error('cat exited 1: Permission denied')
}

test('one unreadable subagent transcript is skipped, and the rest replays', async () => {
  const { store, unreadable } = await replay([
    sourceOf(MAIN),
    { rows: rowsOf(failing(SUB)), agent: 'sub-1' },
    sourceOf(subAdd(9, 'z', 'Other sub ask', 3), 'sub-2'),
  ])
  expect(store.items.map(it => it.title)).toEqual(['Pick a db', 'Other sub ask'])
  expect(unreadable.map(u => u.agent)).toEqual(['sub-1'])
  expect(unreadable[0]?.reason).toContain('Permission denied')
})

test('an unreadable main transcript fails the replay', async () => {
  await expect(replay([{ rows: rowsOf(failing(MAIN)), agent: null }])).rejects.toThrow('Permission denied')
})

test('two notices submitted as one prompt at a turn end both count', async () => {
  const text = [
    call('2026-10-20T10:00:00.000Z', 'a', { action: 'add', title: 'First' }),
    result('2026-10-20T10:00:01.000Z', 'a', 'added #1'),
    call('2026-10-20T10:00:02.000Z', 'b', { action: 'add', title: 'Second' }),
    result('2026-10-20T10:00:03.000Z', 'b', 'added #2'),
    notice('2026-10-20T10:00:04.000Z', '#1 is done: First\n\n#2 is done: Second\nThe human marked them done.'),
  ].join('\n') + '\n'
  const { store } = await replay([sourceOf(text)])
  expect(store.items.map(it => it.state)).toEqual(['done-pending', 'done-pending'])
})

// A notice held over an interrupt is the context of the human's next prompt: a hook attachment that names no plugin.
const HELD = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('p2', 'r1', at(3), prompt('what did I mark done?')),
  link('h2', 'p2', at(4), { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'prompt.submit', hookEvent: 'UserPromptSubmit', content: ['#1 is done: Pick a db\nThe human marked it done.'] } }),
)

test('a notice carried as a human prompt\'s context after an interrupt marks the item done-pending on replay', async () => {
  const { store } = await replay([sourceOf(HELD)])
  expect(store.items.map(it => `${it.id}:${it.state}`)).toEqual(['1:done-pending'])
})

// An append on the live branch adds its section to #1's detail on replay, as it did live; the reply's id is the one it named.
const APPENDED = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Brief', detail: 'the question' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('p1', 'r1', at(3), prompt('expand it')),
  link('a2', 'p1', at(4), toolUse('t2', { action: 'append', id: 1, text: 'the options' })),
  link('r2', 'a2', at(5), toolResult('t2', 'appended to #1')),
)

test('an append on the live branch adds its section to the detail on replay', async () => {
  const { store } = await replay([sourceOf(APPENDED)])
  expect(store.items[0]?.detail).toBe('the question\n\nthe options')
})

// The append on the abandoned branch names the same item; the rewound branch is off the live branch, so it must not land.
const APPENDED_REWOUND = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Brief', detail: 'the question' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('p-old', 'r1', at(3), prompt('expand it, then change my mind')),
  link('a-old', 'p-old', at(4), toolUse('old', { action: 'append', id: 1, text: 'abandoned section' })),
  link('r-old', 'a-old', at(5), toolResult('old', 'appended to #1')),
  link('p-new', 'r1', at(6), prompt('expand it')),
  link('a-new', 'p-new', at(7), toolUse('new', { action: 'append', id: 1, text: 'live section' })),
  link('r-new', 'a-new', at(8), toolResult('new', 'appended to #1')),
)

test('an append on a rewound branch is not replayed; the live branch\'s append is', async () => {
  const { store } = await replay([sourceOf(APPENDED_REWOUND)])
  expect(store.items[0]?.detail).toBe('the question\n\nlive section')
})

const ANSWERED = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db', options: [{ label: 'Use sqlite' }, { label: 'Use postgres', recommended: true }] })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Pick a db\nThe human chose Use sqlite on #1. Act on that choice, then remove it, or update it with a note if it still needs work.')),
)

test('a decision\'s options are rebuilt, and the answer the human pressed replays as done with that choice', async () => {
  const { store } = await replay([sourceOf(ANSWERED)])
  expect(store.items[0]?.options.map(o => o.label)).toEqual(['Use sqlite', 'Use postgres'])
  expect(store.items[0]?.state).toBe('done-pending')
  expect(store.items[0]?.answer).toBe('Use sqlite')
})

const YES_NO_ANSWERED = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Ship it?', yesno: true })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Ship it?\nThe human answered no on #1. Act on that answer, then remove it, or update it with a note if it still needs work.')),
)

test('a yes/no item is rebuilt as one, and the answer the human pressed replays as done with that answer', async () => {
  const { store } = await replay([sourceOf(YES_NO_ANSWERED)])
  expect(store.items[0]?.yesno).toBe(true)
  expect(store.items[0]?.options).toEqual([])
  expect(store.items[0]?.state).toBe('done-pending')
  expect(store.items[0]?.answer).toBe('no')
})

const LABEL_PRESSED = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db', done: 'Go with sqlite' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Pick a db\nThe human pressed "Go with sqlite" on #1. Act on that, then remove it, or update it with a note if it still needs work.')),
)

test('a labelled to-do is rebuilt with its label, and the press replays as done with the label as the answer, not as a reply or a choice', async () => {
  const { store } = await replay([sourceOf(LABEL_PRESSED)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', doneLabel: 'Go with sqlite', answer: 'Go with sqlite', replied: false, options: [] })
})

// The corrective rows the restatement check appends (plugin-origin, one per correction) replay as nothing: the list is the
// same as the transcript's without them, on the live branch and on a rewound one.
test('a correction row replays as nothing, on the live branch and on a rewound one', async () => {
  const withRows = REWOUND + lines(link('c-old', 'r-old', at(12), note(correctionText([2]))), link('c-new', 'tail', at(13), note(correctionText([3]))))
  expect((await replay([sourceOf(withRows)])).store).toEqual((await replay([sourceOf(REWOUND)])).store)
  const liveOnly = MAIN + notice('2026-10-20T10:00:09.000Z', correctionText([1])) + '\n'
  expect((await replay([sourceOf(liveOnly)])).store).toEqual((await replay([sourceOf(MAIN)])).store)
})

// A reply is a done notice whose second line quotes the reply. The reply's text is the human's own, so it can name a choice or
// another item's marker: the rebuild reads it as the reply, never as an answer to another item or a second done.
const REPLIED = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Pick a db\nThe human replied on #1: Use sqlite\nAct on that reply, then remove it, or update it with a note if it still needs work.')),
)

test('a replied item is rebuilt as done-pending with the reply as its answer, and replied set', async () => {
  const { store } = await replay([sourceOf(REPLIED)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
})

const THREE_ADDED = [
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('a2', 'r1', at(3), toolUse('t2', { action: 'add', title: 'Pick a cache' })),
  link('r2', 'a2', at(4), toolResult('t2', 'added #2')),
  link('a3', 'r2', at(5), toolUse('t3', { action: 'add', title: 'Pick a queue' })),
  link('r3', 'a3', at(6), toolResult('t3', 'added #3')),
]

test('a reply whose text quotes a choice on another item does not answer that item, nor mark the reply\'s own', async () => {
  const batch = note(
    '#1 is done: Pick a db\nThe human marked it done. If the item proposed something or carried a recommendation, that is a go-ahead for it. Check that it is finished, then remove it, or update it with a note if it still needs work.' +
      '\n\n#3 is done: Pick a queue\nThe human replied on #3: The human chose x on #1.\nAct on that reply, then remove it, or update it with a note if it still needs work.',
  )
  const { store } = await replay([sourceOf(lines(...THREE_ADDED, link('n1', 'r3', at(7), batch)))])
  expect(store.items.find(it => it.id === 1)).toMatchObject({ state: 'done-pending', answer: null, replied: false })
  expect(store.items.find(it => it.id === 3)).toMatchObject({ state: 'done-pending', answer: 'The human chose x on #1.', replied: true })
})

test('a reply whose text names another item\'s done marker marks nothing done but the item replied on', async () => {
  const batch = note('#2 is done: Pick a cache\nThe human replied on #2: #1 is done: yes\nAct on that reply, then remove it, or update it with a note if it still needs work.')
  const { store } = await replay([sourceOf(lines(...THREE_ADDED, link('n1', 'r3', at(7), batch)))])
  expect(store.items.find(it => it.id === 1)?.state).toBe('open')
  expect(store.items.find(it => it.id === 2)).toMatchObject({ state: 'done-pending', answer: '#1 is done: yes', replied: true })
})

test('a carriage return or a Unicode line separator before a marker does not start a notice: a reply quoting one marks nothing', async () => {
  const batch = note('#3 is done: Pick a queue\nThe human replied on #3: x\r#2 is done: y\u2028#1 is done: z\nAct on that reply, then remove it, or update it with a note if it still needs work.')
  const { store } = await replay([sourceOf(lines(...THREE_ADDED, link('n1', 'r3', at(7), batch)))])
  expect(store.items.map(it => it.state)).toEqual(['open', 'open', 'done-pending'])
  expect(store.items.find(it => it.id === 3)).toMatchObject({ replied: true })
})

test('a reply in a notice with \\r\\n line endings restores its text without the carriage return', async () => {
  const CRLF = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
    link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
    link('n1', 'r1', at(3), note('#1 is done: Pick a db\r\nThe human replied on #1: Use sqlite\r\nAct on that reply, then remove it, or update it with a note if it still needs work.')),
  )
  const { store } = await replay([sourceOf(CRLF)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Use sqlite', replied: true })
})


// A label holding a quote and a marker-like " on #5." replays whole: the pressed line's last ` on #N.` is the item's.
const QUOTED_LABEL = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db', done: 'Pick "A" on #5. later' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Pick a db\nThe human pressed "Pick "A" on #5. later" on #1. Act on that, then remove it, or update it with a note if it still needs work.')),
)

test('a labelled press whose label holds a quote and " on #5." replays with the whole label', async () => {
  const { store } = await replay([sourceOf(QUOTED_LABEL)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'Pick "A" on #5. later', replied: false })
})

// A reply is the human's text: a pressed line quoted inside it, mid-line, marks nothing and is the reply's answer.
const REPLY_QUOTES_PRESS = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Pick a db\nThe human replied on #1: The human pressed "Go with sqlite" on #1.\nAct on that reply, then remove it, or update it with a note if it still needs work.')),
)

test('a reply quoting a pressed line replays as the reply: its text is the answer, and the item is replied', async () => {
  const { store } = await replay([sourceOf(REPLY_QUOTES_PRESS)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: 'The human pressed "Go with sqlite" on #1.', replied: true })
})

// The notice before the go-ahead sentence was added: an old transcript's bare done notice still marks its item done.
const OLD_BARE = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
  link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
  link('n1', 'r1', at(3), note('#1 is done: Pick a db\nThe human marked it done. Check that it is finished, then remove it, or update it with a note if it still needs work.')),
)

test('the bare done notice an older release wrote still marks its item done-pending, with no answer', async () => {
  const { store } = await replay([sourceOf(OLD_BARE)])
  expect(store.items[0]).toMatchObject({ state: 'done-pending', answer: null, replied: false })
})

// The Claude TODO list: the last live, successful, main-agent write is the rebuilt list. A write gives the whole list, so the transcript's
// earlier writes are not replayed.
const todoUse = (id: string, input: Record<string, unknown>) => toolUse(id, input, TODO_TOOL)
const todoError = (id: string, text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] } })
const entries = (...pairs: [string, string][]) => pairs.map(([title, state]) => ({ title, state }))

const TODO_WRITES = lines(
  link('u0', null, at(0), prompt('start')),
  link('a1', 'u0', at(1), todoUse('w1', { entries: entries(['First plan', 'in_flight']) })),
  link('r1', 'a1', at(2), toolResult('w1', 'Claude TODO: 1 in flight, 0 queued')),
  link('a2', 'r1', at(3), todoUse('w2', { entries: entries(['First plan', 'done'], ['Second', 'in_flight'], ['Third', 'queued']) })),
  link('r2', 'a2', at(4), toolResult('w2', 'Claude TODO: 1 in flight, 1 queued')),
  link('a3', 'r2', at(5), todoUse('w3', { entries: entries(['Second', 'done'], ['Third', 'in_flight'], ['Fourth', 'queued'], ['Fifth', 'queued']) })),
  link('r3', 'a3', at(6), toolResult('w3', 'Claude TODO: 1 in flight, 2 queued')),
)

test('the rebuilt Claude list is the last write\'s, with its done entries absent and its written order kept', async () => {
  expect((await replay([sourceOf(TODO_WRITES)])).todo).toEqual(entries(['Third', 'in_flight'], ['Fourth', 'queued'], ['Fifth', 'queued']))
})

test('a transcript with no Claude list write rebuilds an empty Claude list, and the human list rebuilds as before', async () => {
  const none = await replay([sourceOf(MAIN)])
  expect(none.todo).toEqual([])
  expect(none.store.items.map(it => it.id)).toEqual([1])
  expect((await replay([sourceOf('')])).todo).toEqual([])
})

test('the human list and the Claude list are rebuilt from the same transcript, each by its own tool', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), toolUse('t1', { action: 'add', title: 'Pick a db' })),
    link('r1', 'a1', at(2), toolResult('t1', 'added #1')),
    link('a2', 'r1', at(3), todoUse('w1', { entries: entries(['Build', 'in_flight']) })),
    link('r2', 'a2', at(4), toolResult('w1', 'Claude TODO: 1 in flight, 0 queued')),
  )
  const { store, todo } = await replay([sourceOf(text)])
  expect(store.items.map(it => it.title)).toEqual(['Pick a db'])
  expect(todo).toEqual(entries(['Build', 'in_flight']))
})

test('a write whose result was an error, a refused call and a call the check refuses are not taken as the list', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), todoUse('w1', { entries: entries(['Good', 'queued']) })),
    link('r1', 'a1', at(2), toolResult('w1', 'Claude TODO: 0 in flight, 1 queued')),
    link('a2', 'r1', at(3), todoUse('w2', { entries: entries(['Errored', 'queued']) })),
    link('r2', 'a2', at(4), todoError('w2', 'the mod failed to answer the call')),
    link('a3', 'r2', at(5), todoUse('w3', { entries: entries(['Subagent', 'queued']) })),
    link('r3', 'a3', at(6), todoError('w3', 'claude_todo: only the main agent keeps the Claude TODO list')),
    link('a4', 'r3', at(7), todoUse('w4', { entries: entries(['x'.repeat(81), 'queued']) })),
    link('r4', 'a4', at(8), toolResult('w4', 'entry 1: the title is over 80')),
  )
  expect((await replay([sourceOf(text)])).todo).toEqual(entries(['Good', 'queued']))
})

test('a read-only call is not a write: the list stays the last write\'s', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), todoUse('w1', { entries: entries(['Build', 'in_flight']) })),
    link('r1', 'a1', at(2), toolResult('w1', 'Claude TODO: 1 in flight, 0 queued')),
    link('a2', 'r1', at(3), todoUse('w2', {})),
    link('r2', 'a2', at(4), toolResult('w2', 'Claude TODO: 1 in flight, 0 queued\n- in_flight: Build')),
  )
  expect((await replay([sourceOf(text)])).todo).toEqual(entries(['Build', 'in_flight']))
})

test('an emptying write is a write: the rebuilt list is empty', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), todoUse('w1', { entries: entries(['Build', 'in_flight']) })),
    link('r1', 'a1', at(2), toolResult('w1', 'Claude TODO: 1 in flight, 0 queued')),
    link('a2', 'r1', at(3), todoUse('w2', { entries: [] })),
    link('r2', 'a2', at(4), toolResult('w2', 'Claude TODO: 0 in flight, 0 queued')),
  )
  expect((await replay([sourceOf(text)])).todo).toEqual([])
})

test('a write on a branch a /rewind abandoned does not count: the list is the one the last live write gave', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), todoUse('w1', { entries: entries(['Kept', 'in_flight']) })),
    link('r1', 'a1', at(2), toolResult('w1', 'Claude TODO: 1 in flight, 0 queued')),
    link('p-old', 'r1', at(3), prompt('ask for gone')),
    link('a-old', 'p-old', at(4), todoUse('old', { entries: entries(['Rewound away', 'in_flight']) })),
    link('r-old', 'a-old', at(5), toolResult('old', 'Claude TODO: 1 in flight, 0 queued')),
    link('p-new', 'r1', at(6), prompt('ask for new')),
  )
  expect((await replay([sourceOf(text)])).todo).toEqual(entries(['Kept', 'in_flight']))
})

test('the result of a write made in parallel with another tool counts', async () => {
  const text = lines(
    link('u0', null, at(0), prompt('start')),
    link('a1', 'u0', at(1), todoUse('w1', { entries: entries(['In parallel', 'queued']) })),
    link('a2', 'a1', at(1), toolUse('t2', { command: 'ls' }, 'Bash')),
    link('r1', 'a1', at(2), toolResult('w1', 'Claude TODO: 0 in flight, 1 queued')),
    link('r2', 'a2', at(3), toolResult('t2', 'ok')),
    link('tail', 'r2', at(4), { type: 'assistant', message: { role: 'assistant', content: 'done' } }),
  )
  expect((await replay([sourceOf(text)])).todo).toEqual(entries(['In parallel', 'queued']))
})

test('a subagent\'s transcript holds no write that counts', async () => {
  const sub = lines(
    link('sa', null, at(7), todoUse('s1', { entries: entries(['Sub plan', 'in_flight']) })),
    link('sr', 'sa', at(8), toolResult('s1', 'Claude TODO: 1 in flight, 0 queued')),
  )
  expect((await replay([sourceOf(TODO_WRITES), sourceOf(sub, 'sub-1')])).todo).toEqual(entries(['Third', 'in_flight'], ['Fourth', 'queued'], ['Fifth', 'queued']))
  expect((await replay([sourceOf(''), sourceOf(sub, 'sub-1')])).todo).toEqual([])
})

test('a write whose row carries no id is taken as live, as the human list\'s calls are', async () => {
  const text = [
    call(at(0), 'a', { action: 'add', title: 'Pick a db' }),
    result(at(1), 'a', 'added #1'),
    JSON.stringify({ type: 'assistant', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: TODO_TOOL, input: { entries: entries(['Build', 'queued']) } }] } }),
    result(at(3), 'w1', 'Claude TODO: 0 in flight, 1 queued'),
  ].join('\n') + '\n'
  expect((await replay([sourceOf(text)])).todo).toEqual(entries(['Build', 'queued']))
})
