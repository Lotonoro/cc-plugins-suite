import { describe, expect, test } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'
import type { Conversation } from '../types/index'
import { adopt, compactionModel, idleTimerOf, isEndNotice, isHandBack, isNotice, isReviewerEntry, keeps, land, lapseOf, learn, learnName, letGo, letGoSwitched, letGoSwitchedIdle, markers, nameKnown, nameListed, needsIds, originOf, reapIdle, reviewModels, reviewerNameOf, spawnChoice, spawnName, spawning, standingOf, stopMissed, sweepable, withTurnEnd } from './reviewer'
import type { Identity } from './reviewer'

const ID: Identity = { plugin: 'auditor', name: 'auditor-reviewer', description: 'auditor review' }
const TIMEOUT = 600_000

// A conversation holding only what the reviewer's identity reads; review 4 is open at epoch 2.
const conversation = (over: Partial<Conversation> = {}): Conversation =>
  ({ off: false, epoch: 2, reviewerContext: 0, reviewerIds: [], reviewerNames: [], reviewerModels: {}, spawnsInFlight: [], review: { number: 4, record: [], dispatchedAt: 1, nothingWakes: false }, ...over }) as unknown as Conversation
// A list entry; `spawnedBy` is set only when given.
const listed = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({ id, type: 'general-purpose', status: 'running', description: 'd', ...over }) as AgentInfo
const spawn = (over: Partial<Conversation['spawnsInFlight'][number]> = {}): Conversation['spawnsInFlight'][number] => ({ brief: 'b', epoch: 2, number: 4, startedAt: 1000, ...over })

describe('standingOf', () => {
  test('the stored reviewer is the current one', () => {
    expect(standingOf(conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'] }), 'ag1')).toBe('current')
  })

  test('a retired reviewer is a former one', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerContext: 90_000 })
    expect(standingOf(letGo(c, 'rotation', 'ag1', 80_000).next, 'ag1')).toBe('former')
  })

  test('a reviewer switched off is a former one', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'] })
    expect(standingOf(letGo(c, 'switch off', 'ag1').next, 'ag1')).toBe('former')
  })

  test('a reviewer forgotten on a /clear is a former one, since its marker is kept', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'] })
    expect(standingOf(conversation({ ...markers(c), epoch: 3 }), 'ag1')).toBe('former')
  })

  test('a stale spawn is a former reviewer, whether it was stood in or not', () => {
    const c = conversation({ spawnsInFlight: [spawn()] })
    expect(standingOf(land(c, 'b', 4, 1, { agentId: 'ag9', model: 'm' }).next, 'ag9')).toBe('former')
  })

  test('a reviewer replaced by another is a former one, and the other is the current one', () => {
    const c = conversation({ reviewer: { id: 'ag2', model: 'm' }, reviewerIds: ['ag1', 'ag2'] })
    expect([standingOf(c, 'ag1'), standingOf(c, 'ag2')]).toEqual(['former', 'current'])
  })

  test('the worker\'s own agents, and an absent id, are neither, a name under a reviewer\'s included', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerNames: ['auditor-reviewer'] })
    expect([standingOf(c, 'sub1'), standingOf(c, undefined), standingOf(c, 'auditor-reviewer')]).toEqual(['neither', 'neither', 'neither'])
  })

  test('a spawn whose id no hook has stored is neither: the origin classifier is what matches it', () => {
    expect(standingOf(conversation({ spawnsInFlight: [spawn()] }), 'ag7')).toBe('neither')
  })
})

describe('originOf', () => {
  const send = (origin: { kind: string; name?: string }, agentId?: string) => ({ from: 'send' as const, origin, agentId })

  test('a send from the model inside an agent this plugin spawned is the spawned agent\'s, current, former or unlanded alike', () => {
    expect(originOf('auditor', send({ kind: 'plugin', name: 'auditor' }, 'ag7'))).toBe('spawned')
  })

  test('a send this plugin\'s own hook made carries no agent id, and is the plugin\'s own', () => {
    expect(originOf('auditor', send({ kind: 'plugin', name: 'auditor' }))).toBe('own')
  })

  test('a send from the model, or from another plugin, is neither, whatever the agent id', () => {
    expect(originOf('auditor', send({ kind: 'model' }, 'ag7'))).toBe('neither')
    expect(originOf('auditor', send({ kind: 'plugin', name: 'cachier' }, 'ag7'))).toBe('neither')
    expect(originOf('auditor', send({ kind: 'plugin' }, 'ag7'))).toBe('neither')
  })

  test('a hook this plugin\'s is its own, another plugin\'s and the engine\'s are neither', () => {
    expect(originOf('auditor', { from: 'hook', origin: { plugin: 'auditor' } })).toBe('own')
    expect(originOf('auditor', { from: 'hook', origin: { plugin: 'cachier' } })).toBe('neither')
    expect(originOf('auditor', { from: 'hook', origin: { plugin: 'engine' } })).toBe('neither')
  })

  test('a list entry this plugin spawned is spawned, one the model or the person started, or another plugin, is neither', () => {
    expect(originOf('auditor', { from: 'listed', agent: { spawnedBy: 'auditor' } })).toBe('spawned')
    expect(originOf('auditor', { from: 'listed', agent: {} })).toBe('neither')
    expect(originOf('auditor', { from: 'listed', agent: { spawnedBy: 'cachier' } })).toBe('neither')
  })
})

describe('isReviewerEntry', () => {
  const c = conversation({ reviewer: { id: 'ag2', model: 'm' }, reviewerIds: ['ag1', 'ag2'] })

  test('an entry whose id the state knows is a reviewer\'s, current or former', () => {
    expect([isReviewerEntry(ID, c, listed('ag1')), isReviewerEntry(ID, c, listed('ag2'))]).toEqual([true, true])
  })

  test('an entry the list names as this plugin\'s spawn is a reviewer\'s though the state does not know its id', () => {
    expect(isReviewerEntry(ID, c, listed('ag7', { spawnedBy: 'auditor' }))).toBe(true)
  })

  test('the worker\'s own agent is not, under a reviewer\'s name or spawned by another plugin included', () => {
    expect(isReviewerEntry(ID, c, listed('sub1'))).toBe(false)
    expect(isReviewerEntry(ID, c, listed('sub2', { name: 'auditor-reviewer' }))).toBe(false)
    expect(isReviewerEntry(ID, c, listed('sub3', { spawnedBy: 'cachier' }))).toBe(false)
  })
})

describe('the name decisions', () => {
  test('a caller is adopted under its name when the list gives it a spawn name and this plugin\'s spawn', () => {
    expect(reviewerNameOf(ID, listed('ag1', { name: 'auditor-reviewer', spawnedBy: 'auditor' }))).toBe('auditor-reviewer')
    expect(reviewerNameOf(ID, listed('ag2', { name: 'auditor-reviewer-12', spawnedBy: 'auditor' }))).toBe('auditor-reviewer-12')
  })

  test('a caller is not adopted when the list does not name it, names it as the worker\'s, or gives it another name', () => {
    expect(reviewerNameOf(ID, undefined)).toBeUndefined()
    expect(reviewerNameOf(ID, listed('ag1', { spawnedBy: 'auditor' }))).toBeUndefined()
    expect(reviewerNameOf(ID, listed('sub1', { name: 'auditor-reviewer', type: 'auditor:reviewer' }))).toBeUndefined()
    expect(reviewerNameOf(ID, listed('ag1', { name: 'helper', spawnedBy: 'auditor' }))).toBeUndefined()
    expect(reviewerNameOf(ID, listed('ag1', { name: 'auditor-reviewer-x', spawnedBy: 'auditor' }))).toBeUndefined()
    expect(reviewerNameOf(ID, listed('ag1', { name: 'xauditor-reviewer', spawnedBy: 'auditor' }))).toBeUndefined()
  })

  test('a spawn is learned under the name the list gives its id, else under the name it was spawned under', () => {
    expect(spawnName(ID, [listed('sub1', { name: 'helper' }), listed('ag2', { name: 'auditor-reviewer-2' })], 'ag2')).toBe('auditor-reviewer-2')
    expect(spawnName(ID, [listed('sub1', { name: 'helper' })], 'ag2')).toBe('auditor-reviewer')
    expect(spawnName(ID, [listed('ag2')], 'ag2')).toBe('auditor-reviewer')
    expect(spawnName(ID, undefined, 'ag2')).toBe('auditor-reviewer')
  })

  test('a team name the state holds is known, one shaped like a spawn name is asked of the list, any other is not a reviewer\'s', () => {
    const c = conversation({ reviewerNames: ['auditor-reviewer'] })
    expect(nameKnown(ID, c, 'auditor-reviewer')).toBe('known')
    expect(nameKnown(ID, c, 'auditor-reviewer-2')).toBe('ask')
    expect(nameKnown(ID, c, 'helper')).toBe('other')
    expect(nameKnown(ID, c, 'my-auditor-reviewer')).toBe('other')
  })

  test('a name the list gives to one of this conversation\'s reviewer ids is learned; one it gives another agent is not; a lost list takes it as known', () => {
    const c = conversation({ reviewerIds: ['ag1'] })
    expect(nameListed(c, 'auditor-reviewer-2', [listed('ag1', { name: 'auditor-reviewer-2' })])).toBe('learn')
    expect(nameListed(c, 'auditor-reviewer-2', [listed('sub9', { name: 'auditor-reviewer-2' })])).toBe('other')
    expect(nameListed(c, 'auditor-reviewer-2', [])).toBe('other')
    expect(nameListed(c, 'auditor-reviewer-2', undefined)).toBe('known')
  })

  test('a reviewer that was replaced still owns its name: the id is a former one\'s', () => {
    const c = conversation({ reviewer: { id: 'ag2', model: 'm' }, reviewerIds: ['ag1', 'ag2'] })
    expect(nameListed(c, 'auditor-reviewer-3', [listed('ag1', { name: 'auditor-reviewer-3' })])).toBe('learn')
  })
})

describe('the text matchers', () => {
  const peer = (text: string, kind = 'peer') => ({ text, origin: { kind } })

  test('a hand-back opening the first line, which names the reviewer, is the reviewer\'s', () => {
    expect(isHandBack(ID, peer('[Subagent hand-back] auditor-reviewer (auditor:reviewer) finished'))).toBe(true)
    expect(isHandBack(ID, peer('[Subagent hand-back] auditor-reviewer-3 finished'))).toBe(true)
  })

  test('a hand-back opening the line right after a reviewer\'s agent-message envelope is the reviewer\'s', () => {
    expect(isHandBack(ID, peer('<agent-message from="auditor-reviewer">\n[Subagent hand-back] done'))).toBe(true)
  })

  test('a note quoting a hand-back frame is not one: its first line is the envelope and its second the review line', () => {
    expect(isHandBack(ID, peer('<agent-message from="auditor-reviewer">\nauditor, review 3:\n[Subagent hand-back] auditor-reviewer'))).toBe(false)
    expect(isHandBack(ID, peer('auditor, review 3:\nthe line [Subagent hand-back] auditor-reviewer says'))).toBe(false)
  })

  test('a hand-back naming another agent, a longer name containing the reviewer\'s, or arriving from another origin is not the reviewer\'s', () => {
    expect(isHandBack(ID, peer('[Subagent hand-back] Explore finished'))).toBe(false)
    expect(isHandBack(ID, peer('[Subagent hand-back] auditor-reviewer-helper finished'))).toBe(false)
    expect(isHandBack(ID, peer('[Subagent hand-back] auditor-reviewer finished', 'composer'))).toBe(false)
  })

  test('an end-of-run notice is a JSON object of type idle_notification; any other body is not', () => {
    expect(isEndNotice(JSON.stringify({ type: 'idle_notification', from: 'auditor-reviewer' }))).toBe(true)
    expect(isEndNotice(JSON.stringify({ type: 'message' }))).toBe(false)
    expect(isEndNotice('{"type":"idle_notification"')).toBe(false)
    expect(isEndNotice('null')).toBe(false)
    expect(isEndNotice('idle_notification')).toBe(false)
  })

  const block = (summary: string): string => `<task-notification>\n<summary>${summary}</summary>\n</task-notification>`
  const notice = (text: string, kind = 'task-notification') => ({ text, origin: { kind } })

  test('a task notification naming the spawn description is the reviewer\'s, one block or several', () => {
    expect(isNotice(ID, notice(block('Agent "auditor review" failed')))).toBe(true)
    expect(isNotice(ID, notice(`${block('Agent "auditor review" completed')}\n${block('Agent "auditor review" failed')}`))).toBe(true)
  })

  test('a batch holding another task\'s notification is not the reviewer\'s', () => {
    expect(isNotice(ID, notice(`${block('Agent "auditor review" completed')}\n${block('Agent "Find the bug" completed')}`))).toBe(false)
  })

  test('text with no block is judged by its text, and an origin other than a task notification is never the reviewer\'s', () => {
    expect(isNotice(ID, notice('Agent "auditor review" failed'))).toBe(true)
    expect(isNotice(ID, notice('Agent "Find the bug" failed'))).toBe(false)
    expect(isNotice(ID, notice(block('Agent "auditor review" failed'), 'peer'))).toBe(false)
  })

  test('the description is the one passed in', () => {
    expect(isNotice({ ...ID, description: 'other review' }, notice(block('Agent "auditor review" failed')))).toBe(false)
    expect(isNotice({ ...ID, description: 'other review' }, notice(block('Agent "other review" failed')))).toBe(true)
  })
})

describe('learn', () => {
  const pending = (over: Partial<Conversation> = {}): Conversation => conversation({ spawnsInFlight: [spawn()], ...over })

  test('a spawn for the open review stands in as the reviewer, with its id and model on its entry, and its id and name marked', () => {
    const next = learn(pending(), 'b', 'ag1', 'haiku', 'auditor-reviewer-2')
    expect(next).toMatchObject({ reviewer: { id: 'ag1', model: 'haiku' }, reviewerIds: ['ag1'], reviewerNames: ['auditor-reviewer-2'], spawnsInFlight: [{ brief: 'b', id: 'ag1', model: 'haiku' }] })
  })

  test('it stands in nothing while off, while a reviewer is stored, from another epoch, or for another review', () => {
    expect(learn(pending({ off: true }), 'b', 'ag1', 'm', 'n').reviewer).toBeUndefined()
    expect(learn(pending({ reviewer: { id: 'ag0', model: 'm' } }), 'b', 'ag1', 'm', 'n').reviewer).toEqual({ id: 'ag0', model: 'm' })
    expect(learn(pending({ spawnsInFlight: [spawn({ epoch: 1 })] }), 'b', 'ag1', 'm', 'n').reviewer).toBeUndefined()
    expect(learn(pending({ spawnsInFlight: [spawn({ number: 3 })] }), 'b', 'ag1', 'm', 'n').reviewer).toBeUndefined()
  })

  test('a spawn no entry matches only marks its id and name, and a mark already held is not repeated', () => {
    const next = learn(pending({ reviewerIds: ['ag1'], reviewerNames: ['n'] }), 'other brief', 'ag1', 'm', 'n')
    expect(next.reviewer).toBeUndefined()
    expect(next.spawnsInFlight).toEqual([spawn()])
    expect([next.reviewerIds, next.reviewerNames]).toEqual([['ag1'], ['n']])
  })

  test('a team name learned from the list joins the names once', () => {
    const c = learnName(conversation(), 'auditor-reviewer-2')
    expect(c.reviewerNames).toEqual(['auditor-reviewer-2'])
    expect(learnName(c, 'auditor-reviewer-2')).toBe(c)
  })
})

describe('adopt', () => {
  const adoptable = (over: Partial<Conversation> = {}): Conversation => conversation({ reviewerIds: ['ag0'], ...over })
  const adopted = (c: Conversation, now: number | undefined = 1500) => adopt(c, 'ag1', 'auditor-reviewer', now, TIMEOUT)

  test('a caller is stored as the reviewer, with its id and name marked, when none is stored and no older spawn blocks it', () => {
    expect(adopted(adoptable())).toMatchObject({ reviewer: { id: 'ag1', model: '' }, reviewerIds: ['ag0', 'ag1'], reviewerNames: ['auditor-reviewer'] })
  })

  test('nothing is adopted while off, while a reviewer is stored, or for an id the state already knows', () => {
    const off = adoptable({ off: true })
    expect(adopted(off)).toBe(off)
    const stored = adoptable({ reviewer: { id: 'ag0', model: 'm' } })
    expect(adopted(stored)).toBe(stored)
    const known = adoptable({ reviewerIds: ['ag0', 'ag1'] })
    expect(adopted(known)).toBe(known)
  })

  test('an older epoch\'s spawn with no id of its own, or with the caller\'s, blocks adoption', () => {
    for (const id of [undefined, 'ag1']) {
      const c = adoptable({ epoch: 3, spawnsInFlight: [spawn({ epoch: 2, ...(id === undefined ? {} : { id }) })] })
      expect(adopted(c)).toBe(c)
    }
  })

  test('it blocks nothing when its hook named another id, when it is past the timeout, or when it is this epoch\'s', () => {
    expect(adopted(adoptable({ epoch: 3, spawnsInFlight: [spawn({ epoch: 2, id: 'ag9' })] })).reviewer).toEqual({ id: 'ag1', model: '' })
    expect(adopted(adoptable({ epoch: 3, spawnsInFlight: [spawn({ epoch: 2 })] }), 1000 + TIMEOUT + 1).reviewer).toEqual({ id: 'ag1', model: '' })
    expect(adopted(adoptable({ epoch: 3, spawnsInFlight: [spawn({ epoch: 3 })] })).reviewer).toEqual({ id: 'ag1', model: '' })
  })

  test('with no clock reading every older epoch\'s spawn blocks, however old', () => {
    const c = adoptable({ epoch: 3, spawnsInFlight: [spawn({ epoch: 2 })] })
    expect(adopted(c, undefined)).toBe(c)
  })

  test('a former reviewer is never adopted, whatever the list says of its name', () => {
    const c = letGo(conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'] }), 'switch off', 'ag1').next
    expect(adopted(c)).toBe(c)
  })
})

describe('spawning, landing and ending a reviewer', () => {
  test('a spawn started clears the stored reviewer and its context and adds its entry', () => {
    const c = conversation({ reviewer: { id: 'ag0', model: 'm' }, reviewerContext: 5, reviewerIds: ['ag0'] })
    expect(spawning(c, spawn())).toMatchObject({ reviewer: undefined, reviewerContext: 0, reviewerIds: ['ag0'], spawnsInFlight: [spawn()] })
  })

  const flying = (over: Partial<Conversation> = {}): Conversation => conversation({ spawnsInFlight: [spawn()], ...over })

  test('a spawn landing under its epoch with its review open stands in as the reviewer, its id marked', () => {
    const landing = land(flying(), 'b', 4, 2, { agentId: 'ag1', model: 'haiku' })
    expect(landing).toMatchObject({ id: 'ag1', stale: false, stood: true })
    expect(landing.next).toMatchObject({ reviewer: { id: 'ag1', model: 'haiku' }, reviewerIds: ['ag1'] })
  })

  test('its model is the one its hook kept on its entry when that entry names the same id', () => {
    const c = flying({ spawnsInFlight: [spawn({ id: 'ag1', model: 'kept' })] })
    expect(land(c, 'b', 4, 2, { agentId: 'ag1', model: 'result' }).next.reviewer).toEqual({ id: 'ag1', model: 'kept' })
    expect(land(c, 'b', 4, 2, { agentId: 'ag2', model: 'result' }).next.reviewer).toEqual({ id: 'ag2', model: 'result' })
    expect(land(c, 'b', 4, 2, { agentId: 'ag2' }).next.reviewer).toEqual({ id: 'ag2', model: '' })
  })

  test('a result with no id takes its entry\'s id, else the stored reviewer\'s, else lands with none', () => {
    expect(land(flying({ spawnsInFlight: [spawn({ id: 'ag5' })] }), 'b', 4, 2, {})).toMatchObject({ id: 'ag5', stood: true })
    expect(land(flying({ reviewer: { id: 'ag6', model: 'm' } }), 'b', 4, 2, {})).toMatchObject({ id: 'ag6', stood: true })
    const none = land(flying(), 'b', 4, 2, {})
    expect(none).toMatchObject({ id: undefined, stale: false, stood: false })
    expect(none.next).toEqual(flying())
  })

  test('a stale landing marks its id and stands in nothing, and with no id of its own it lands with none, the stored reviewer\'s id not borrowed', () => {
    const stored = flying({ reviewer: { id: 'ag6', model: 'm' } })
    const stale = land(stored, 'b', 4, 1, { agentId: 'ag1', model: 'm' })
    expect(stale).toMatchObject({ id: 'ag1', stale: true, stood: false })
    expect(stale.next).toMatchObject({ reviewer: { id: 'ag6', model: 'm' }, reviewerIds: ['ag1'] })
    expect(land(stored, 'b', 4, 1, {})).toMatchObject({ id: undefined, stale: true, stood: false })
  })

  test('a spawn whose review closed since, with another reviewer stored, is not stood in again, and the stored one stays', () => {
    const c = flying({ review: undefined, reviewer: { id: 'ag6', model: 'm' } })
    const landing = land(c, 'b', 4, 2, { agentId: 'ag1', model: 'm' })
    expect(landing).toMatchObject({ id: 'ag1', stood: false })
    expect(landing.next).toMatchObject({ reviewer: { id: 'ag6', model: 'm' }, reviewerIds: ['ag1'] })
  })

  test('a spawn adopted by name before it landed is stood in again by its own landing even when its review closed', () => {
    const c = flying({ review: undefined, reviewer: { id: 'ag1', model: '' }, reviewerIds: ['ag1'] })
    const landing = land(c, 'b', 4, 2, { agentId: 'ag1', model: 'haiku' })
    expect(landing).toMatchObject({ stood: true })
    expect(landing.next.reviewer).toEqual({ id: 'ag1', model: 'haiku' })
  })

  test('the markers a /clear keeps are the ids, the names and the models the reviewers ran on', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerNames: ['n'], reviewerModels: { ag1: 'm' }, reviewerContext: 7 })
    expect(markers(c)).toEqual({ reviewerIds: ['ag1'], reviewerNames: ['n'], reviewerModels: { ag1: 'm' } })
  })
})

describe('the choice a reviewer is spawned for', () => {
  const entry = (over: Partial<Conversation['spawnsInFlight'][number]> = {}) => spawn({ choice: 'sonnet', ...over })

  test('a spawn that stands in carries the choice its entry was spawned for, and its model is recorded for its id', () => {
    const next = learn(conversation({ spawnsInFlight: [entry()] }), 'b', 'ag1', 'claude-sonnet-5-5', 'n')
    expect(next.reviewer).toEqual({ id: 'ag1', model: 'claude-sonnet-5-5', choice: 'sonnet' })
    expect(next.reviewerModels).toEqual({ ag1: 'claude-sonnet-5-5' })
    expect(next.spawnsInFlight).toEqual([entry({ id: 'ag1', model: 'claude-sonnet-5-5' })])
  })

  test('a spawn that is not stood in still has its model recorded for its id, and a blank model records none', () => {
    expect(learn(conversation({ spawnsInFlight: [entry({ epoch: 1 })] }), 'b', 'ag1', 'claude-sonnet-5-5', 'n').reviewerModels).toEqual({ ag1: 'claude-sonnet-5-5' })
    expect(learn(conversation({ spawnsInFlight: [entry()] }), 'b', 'ag1', '', 'n').reviewerModels).toEqual({})
  })

  test('an entry without a choice stands in a reviewer without one', () => {
    expect(learn(conversation({ spawnsInFlight: [spawn()] }), 'b', 'ag1', 'm', 'n').reviewer).toEqual({ id: 'ag1', model: 'm' })
  })

  test('landing stands the spawn in with its entry\'s choice and records its model, a stale landing\'s included', () => {
    const landing = land(conversation({ spawnsInFlight: [entry()] }), 'b', 4, 2, { agentId: 'ag1', model: 'claude-sonnet-5-5' })
    expect(landing.next.reviewer).toEqual({ id: 'ag1', model: 'claude-sonnet-5-5', choice: 'sonnet' })
    expect(landing.next.reviewerModels).toEqual({ ag1: 'claude-sonnet-5-5' })
    const stale = land(conversation({ spawnsInFlight: [entry()] }), 'b', 4, 1, { agentId: 'ag1', model: 'claude-sonnet-5-5' })
    expect(stale.next.reviewerModels).toEqual({ ag1: 'claude-sonnet-5-5' })
  })

  test('a landing whose entry is gone keeps the choice of the reviewer already stored under its id', () => {
    const c = conversation({ review: undefined, reviewer: { id: 'ag1', model: '', choice: 'opus' }, reviewerIds: ['ag1'] })
    expect(land(c, 'b', 4, 2, { agentId: 'ag1', model: 'claude-opus-5-5' }).next.reviewer).toEqual({ id: 'ag1', model: 'claude-opus-5-5', choice: 'opus' })
  })

  test('the choice of the spawn in flight for a brief is found by the brief alone, and is none for an unknown brief or an entry that predates choices', () => {
    const c = conversation({ spawnsInFlight: [entry({ brief: 'a', choice: 'opus' }), entry({ brief: 'b', choice: 'claude-opus-4-6' }), spawn({ brief: 'c' })] })
    expect(spawnChoice(c, 'b')).toBe('claude-opus-4-6')
    expect(spawnChoice(c, 'a')).toBe('opus')
    expect(spawnChoice(c, 'c')).toBeUndefined()
    expect(spawnChoice(c, 'unknown')).toBeUndefined()
    expect(spawnChoice(conversation(), 'a')).toBeUndefined()
  })

  test('adoption takes the choice of the current epoch\'s newest spawn in flight, else the conversation\'s', () => {
    const adopted = (over: Partial<Conversation>) => adopt(conversation({ reviewerIds: ['ag0'], ...over }), 'ag1', 'auditor-reviewer', 1500, TIMEOUT).reviewer
    expect(adopted({ choice: 'haiku', spawnsInFlight: [entry({ choice: 'opus', brief: 'a' }), entry({ choice: 'sonnet', brief: 'b' })] })).toEqual({ id: 'ag1', model: '', choice: 'sonnet' })
    expect(adopted({ choice: 'haiku', spawnsInFlight: [entry({ choice: 'opus', epoch: 1, id: 'ag9' })] })).toEqual({ id: 'ag1', model: '', choice: 'haiku' })
    expect(adopted({ choice: 'haiku' })).toEqual({ id: 'ag1', model: '', choice: 'haiku' })
    expect(adopted({})).toEqual({ id: 'ag1', model: '' })
  })
})

describe('whether a stored reviewer is kept at a switch', () => {
  const held = (choice: string | undefined, spawnedFor: string | undefined, over: Partial<Conversation> = {}): Conversation =>
    conversation({ review: undefined, reviewerIds: ['ag1'], ...(choice === undefined ? {} : { choice }), reviewer: { id: 'ag1', model: 'm', ...(spawnedFor === undefined ? {} : { choice: spawnedFor }) }, ...over })

  test('a reviewer spawned for the conversation\'s choice is kept, whatever the ids say', () => {
    expect(keeps(held('haiku', 'haiku'), {})).toBe(true)
    expect(keeps(held('claude-opus-4-6[1m]', 'claude-opus-4-6[1m]'), { 'claude-opus-4-6[1m]': 'claude-sonnet-5' })).toBe(true)
  })

  test('a reviewer spawned for another name is kept when both ids are known and equal, and let go otherwise', () => {
    expect(keeps(held('claude-haiku-5-5', 'haiku'), { haiku: 'claude-haiku-5-5-20261001' })).toBe(true)
    expect(keeps(held('sonnet', 'haiku'), { haiku: 'claude-haiku-5-5', sonnet: 'claude-haiku-5-5' })).toBe(true)
    expect(keeps(held('sonnet', 'haiku'), { haiku: 'claude-haiku-5-5' })).toBe(false)
    expect(keeps(held('sonnet', 'haiku'), {})).toBe(false)
    expect(keeps(held('opus', 'claude-opus-4-6'), { opus: 'claude-opus-5-5' })).toBe(false)
  })

  test('a conversation with no choice has switched nothing, and a reviewer with none ran the default', () => {
    expect(keeps(held(undefined, 'sonnet'), {})).toBe(true)
    expect(keeps(held('haiku', undefined), {})).toBe(true)
    expect(keeps(held('sonnet', undefined), {})).toBe(false)
  })

  test('the stored ids are needed only where the reviewer\'s name differs from the choice\'s', () => {
    expect(needsIds(held('sonnet', 'haiku'))).toBe(true)
    expect(needsIds(held('sonnet', undefined))).toBe(true)
    expect(needsIds(held('haiku', 'haiku'))).toBe(false)
    expect(needsIds(held('haiku', undefined))).toBe(false)
    expect(needsIds(held(undefined, 'sonnet'))).toBe(false)
    expect(needsIds(conversation({ choice: 'sonnet' }))).toBe(false)
  })

  test('letting a switched reviewer go clears it like a rotation and notes the reason, and keeps its marks', () => {
    const { next, released } = letGoSwitched(held('sonnet', 'haiku', { reviewerContext: 9 }), {})
    expect(released).toBe('ag1')
    expect(next).toMatchObject({ reviewer: undefined, reviewerContext: 0, lastLetGo: 'model switch', reviewerIds: ['ag1'] })
  })

  test('a reviewer that is kept, or none stored, lets nothing go', () => {
    const kept = held('haiku', 'haiku')
    expect(letGoSwitched(kept, {})).toEqual({ next: kept, released: undefined })
    const none = conversation({ choice: 'sonnet' })
    expect(letGoSwitched(none, {})).toEqual({ next: none, released: undefined })
  })

  test('the switch\'s own let-go takes an idle reviewer only: no review open, no spawn in flight', () => {
    expect(letGoSwitchedIdle(held('sonnet', 'haiku'), {}).released).toBe('ag1')
    const reviewing = held('sonnet', 'haiku', { review: { number: 4, record: [], dispatchedAt: 1, nothingWakes: false } })
    expect(letGoSwitchedIdle(reviewing, {})).toEqual({ next: reviewing, released: undefined })
    const spawning = held('sonnet', 'haiku', { spawnsInFlight: [spawn()] })
    expect(letGoSwitchedIdle(spawning, {})).toEqual({ next: spawning, released: undefined })
    const same = held('haiku', 'haiku')
    expect(letGoSwitchedIdle(same, {})).toEqual({ next: same, released: undefined })
  })
})

describe('the models a review\'s log names', () => {
  test('the reviewer that held the review names them: the choice it was spawned for and the model it resolved to', () => {
    const c = conversation({ choice: 'opus', reviewer: { id: 'ag1', model: 'claude-haiku-5-5', choice: 'haiku' } })
    expect(reviewModels(c, 4)).toEqual({ configured: 'haiku', resolved: 'claude-haiku-5-5' })
  })

  test('a reviewer whose result has not landed has no resolved model, unless the record of its id has one', () => {
    const adopted = conversation({ reviewer: { id: 'ag1', model: '', choice: 'haiku' } })
    expect(reviewModels(adopted, 4)).toEqual({ configured: 'haiku', resolved: null })
    expect(reviewModels({ ...adopted, reviewerModels: { ag1: 'claude-haiku-5-5' } }, 4)).toEqual({ configured: 'haiku', resolved: 'claude-haiku-5-5' })
  })

  test('with no reviewer the spawn in flight for the review\'s number names the choice', () => {
    const c = conversation({ choice: 'opus', spawnsInFlight: [spawn({ number: 3, choice: 'fable' }), spawn({ number: 4, choice: 'sonnet', brief: 'x' })] })
    expect(reviewModels(c, 4)).toEqual({ configured: 'sonnet', resolved: null })
  })

  test('with neither it is the conversation\'s choice, and with no choice yet, null', () => {
    expect(reviewModels(conversation({ choice: 'opus' }), 4)).toEqual({ configured: 'opus', resolved: null })
    expect(reviewModels(conversation(), 4)).toEqual({ configured: null, resolved: null })
  })

  test('a reviewer with no choice of its own falls to the spawn in flight, then to the conversation\'s choice', () => {
    expect(reviewModels(conversation({ choice: 'opus', reviewer: { id: 'ag1', model: 'm' } }), 4)).toEqual({ configured: 'opus', resolved: 'm' })
  })
})

describe('the model a compaction is priced at', () => {
  test('the model recorded for the compacting reviewer\'s id, whichever reviewer is stored since', () => {
    const c = conversation({ reviewer: { id: 'ag2', model: 'claude-sonnet-5-5', choice: 'sonnet' }, reviewerModels: { ag1: 'claude-haiku-5-5', ag2: 'claude-sonnet-5-5' } })
    expect(compactionModel(c, 'ag1', {})).toBe('claude-haiku-5-5')
    expect(compactionModel(c, 'ag2', {})).toBe('claude-sonnet-5-5')
  })

  test('the stored reviewer\'s own model, for a state that kept none per id', () => {
    expect(compactionModel(conversation({ reviewer: { id: 'ag1', model: 'claude-haiku-5-5' } }), 'ag1', {})).toBe('claude-haiku-5-5')
  })

  test('a stored reviewer adopted before its result landed takes the id its choice gets from the chain', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: '', choice: 'haiku' } })
    expect(compactionModel(c, 'ag1', { haiku: 'claude-haiku-5-5-20261001' })).toBe('claude-haiku-5-5')
    expect(compactionModel(conversation({ reviewer: { id: 'ag1', model: '', choice: 'claude-opus-4-6' } }), 'ag1', {})).toBe('claude-opus-4-6')
  })

  test('with no model recorded and no chain to an id it is unknown, a former reviewer kept only by its id included', () => {
    expect(compactionModel(conversation({ reviewer: { id: 'ag1', model: '', choice: 'haiku' } }), 'ag1', {})).toBeUndefined()
    expect(compactionModel(conversation({ reviewer: { id: 'ag1', model: '' } }), 'ag1', {})).toBeUndefined()
    expect(compactionModel(conversation({ reviewerIds: ['ag0'] }), 'ag0', { haiku: 'claude-haiku-5-5' })).toBeUndefined()
  })
})

describe('letting a reviewer go', () => {
  const stored = (over: Partial<Conversation> = {}): Conversation => conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerNames: ['n'], reviewerContext: 7, ...over })

  test('a reviewer past the rotation limit is let go with its id returned, its context cleared, its marks kept and the reason noted; one at the limit is not', () => {
    const past = letGo(stored({ reviewerContext: 80_001 }), 'rotation', 'ag1', 80_000)
    expect(past.released).toBe('ag1')
    expect(past.next).toMatchObject({ reviewer: undefined, reviewerContext: 0, reviewerIds: ['ag1'], reviewerNames: ['n'], lastLetGo: 'rotation' })
    const at = stored({ reviewerContext: 80_000 })
    expect(letGo(at, 'rotation', 'ag1', 80_000)).toEqual({ next: at, released: undefined })
  })

  for (const reason of ['switch off', 'session end', 'failed review', 'reaped idle'] as const) {
    test(`a ${reason} lets the stored reviewer go whatever its context: its id returned, its context cleared, its marks kept and the reason noted`, () => {
      const gone = letGo(stored(), reason, 'ag1')
      expect(gone.released).toBe('ag1')
      expect(gone.next).toMatchObject({ reviewer: undefined, reviewerContext: 0, reviewerIds: ['ag1'], reviewerNames: ['n'], lastLetGo: reason })
    })
  }

  test('a refused brief notes its reason and returns the refused id, and leaves the stored reviewer to the spawn that replaces it', () => {
    const c = stored()
    expect(letGo(c, 'refused brief', 'ag1')).toEqual({ next: { ...c, lastLetGo: 'refused brief' }, released: 'ag1' })
  })

  test('a stale landing notes its reason and returns the landed id, the stored reviewer staying', () => {
    const c = stored()
    expect(letGo(c, 'stale landing', 'ag9')).toEqual({ next: { ...c, lastLetGo: 'stale landing' }, released: 'ag9' })
  })

  test('a stale landing whose id is the stored reviewer\'s lets nothing go', () => {
    const c = stored()
    expect(letGo(c, 'stale landing', 'ag1')).toEqual({ next: c, released: undefined })
  })

  test('a rejected spawn notes its reason and returns the learned id, and clears the stored reviewer when it is that id', () => {
    const c = stored({ reviewerContext: 7 })
    expect(letGo(c, 'rejected spawn', 'ag1')).toEqual({ next: { ...c, reviewer: undefined, reviewerContext: 0, lastLetGo: 'rejected spawn' }, released: 'ag1' })
  })

  test('a rejected spawn whose id is not the stored reviewer\'s leaves the stored reviewer', () => {
    const c = stored({ reviewerContext: 7 })
    expect(letGo(c, 'rejected spawn', 'ag9')).toEqual({ next: { ...c, lastLetGo: 'rejected spawn' }, released: 'ag9' })
  })

  test('with no id to let go, nothing is released and the last reason stays; a clearing reason still clears', () => {
    const c = conversation({ reviewerContext: 3, lastLetGo: 'rotation' })
    expect(letGo(c, 'switch off', undefined)).toEqual({ next: { ...c, reviewer: undefined, reviewerContext: 0 }, released: undefined })
    expect(letGo(c, 'refused brief', undefined)).toEqual({ next: c, released: undefined })
    expect(letGo(stored(), 'rejected spawn', undefined)).toEqual({ next: stored(), released: undefined })
  })

  test('a later let-go replaces the reason', () => {
    expect(letGo(stored({ lastLetGo: 'rotation' }), 'switch off', 'ag1').next.lastLetGo).toBe('switch off')
  })
})

describe('the lapse of an open review', () => {
  const stored = (over: Partial<Conversation> = {}): Conversation => conversation({ reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], ...over })
  const dispatchedAt = 1
  const limits = (start: number, finish: number) => ({ start, finish })

  test('a review held by a stored reviewer lapses as never finished once its limit passed, and not before', () => {
    expect(lapseOf(stored(), dispatchedAt + 600_001, limits(600_000, 600_000))).toBe('no finish')
    expect(lapseOf(stored(), dispatchedAt + 600_000, limits(600_000, 600_000))).toBeUndefined()
  })

  test('a review with no stored reviewer lapses as never started once its limit passed, and not before', () => {
    expect(lapseOf(conversation(), dispatchedAt + 600_001, limits(600_000, 600_000))).toBe('no start')
    expect(lapseOf(conversation(), dispatchedAt + 600_000, limits(600_000, 600_000))).toBeUndefined()
  })

  test('each lapse reads its own limit alone', () => {
    expect(lapseOf(stored(), dispatchedAt + 100, limits(1, 99))).toBe('no finish')
    expect(lapseOf(stored(), dispatchedAt + 100, limits(99, 1_000))).toBeUndefined()
    expect(lapseOf(conversation(), dispatchedAt + 100, limits(99, 1_000))).toBe('no start')
    expect(lapseOf(conversation(), dispatchedAt + 100, limits(1_000, 1))).toBeUndefined()
  })

  test('no open review never lapses', () => {
    expect(lapseOf(conversation({ review: undefined }), dispatchedAt + 1_000_000, limits(1, 1))).toBeUndefined()
  })

  test('letting the stuck reviewer go for the lapse clears it, keeps its markers and notes the reason', () => {
    const c = stored({ reviewerContext: 5 })
    expect(letGo(c, 'lapsed', 'ag1')).toEqual({ next: { ...c, reviewer: undefined, reviewerContext: 0, lastLetGo: 'lapsed' }, released: 'ag1' })
  })
})

describe('the reviewer\'s latest turn end', () => {
  test('is noted on the stored reviewer whose turn ended, and on no other', () => {
    const c = conversation({ reviewer: { id: 'ag1', model: 'm' } })
    expect(withTurnEnd(c, 'ag1', 50).reviewer).toEqual({ id: 'ag1', model: 'm', endedAt: 50 })
    expect(withTurnEnd(c, 'ag9', 50)).toBe(c)
    expect(withTurnEnd(conversation(), 'ag1', 50)).toEqual(conversation())
  })

  test('goes with the reviewer when it is let go', () => {
    expect(letGo(withTurnEnd(conversation({ reviewer: { id: 'ag1', model: 'm' } }), 'ag1', 50), 'reaped idle', 'ag1').next.reviewer).toBeUndefined()
  })
})

describe('the reap of an idle reviewer', () => {
  // Dispatch 4 was the last; no review is open and no spawn is in flight, at epoch 2.
  const idle = (over: Partial<Conversation> = {}): Conversation =>
    conversation({ review: undefined, dispatches: 4, reviewer: { id: 'ag1', model: 'm' }, reviewerIds: ['ag1'], reviewerNames: ['n'], reviewerContext: 7, ...over })
  const timer = { id: 'ag1', dispatches: 4, epoch: 2 }

  test('a stored reviewer with no open review and no spawn in flight has a timer identity: its id, the dispatch count and the epoch', () => {
    expect(idleTimerOf(idle())).toEqual(timer)
  })

  test('no timer identity while a review is open, a spawn is in flight or no reviewer is stored', () => {
    expect(idleTimerOf(idle({ review: conversation().review }))).toBeUndefined()
    expect(idleTimerOf(idle({ spawnsInFlight: [spawn()] }))).toBeUndefined()
    expect(idleTimerOf(idle({ reviewer: undefined }))).toBeUndefined()
  })

  test('the fire lets the same idle reviewer go: its id returned, its context cleared, its marks kept and the reason noted', () => {
    const gone = reapIdle(idle(), timer)
    expect(gone.released).toBe('ag1')
    expect(gone.next).toMatchObject({ reviewer: undefined, reviewerContext: 0, reviewerIds: ['ag1'], reviewerNames: ['n'], lastLetGo: 'reaped idle' })
  })

  const unchanged: [string, Conversation][] = [
    ['a review is open', idle({ review: conversation().review })],
    ['a spawn is in flight', idle({ spawnsInFlight: [spawn()] })],
    ['another reviewer is stored', idle({ reviewer: { id: 'ag2', model: 'm' } })],
    ['no reviewer is stored', idle({ reviewer: undefined })],
    ['a dispatch was made since', idle({ dispatches: 5 })],
    ['the epoch moved', idle({ epoch: 3 })],
  ]
  for (const [when, c] of unchanged) {
    test(`the fire changes nothing when ${when}`, () => {
      expect(reapIdle(c, timer)).toEqual({ next: c, released: undefined })
    })
  }
})

describe('stopMissed', () => {
  test('a stop the engine took is missed when the list still shows the reviewer in any status that is not ended, and says which', () => {
    for (const status of ['pending', 'running', 'waiting', 'idle'] as const) {
      expect(stopMissed(false, [listed('ag1', { status })], 'ag1')).toBe(`the list still shows it ${status}`)
    }
  })

  test('a stop the engine took is not missed when the list shows the reviewer ended, shows it not at all, or could not be read', () => {
    for (const status of ['completed', 'failed', 'killed'] as const) expect(stopMissed(false, [listed('ag1', { status })], 'ag1')).toBeUndefined()
    expect(stopMissed(false, [], 'ag1')).toBeUndefined()
    expect(stopMissed(false, [listed('ag2', { status: 'idle' })], 'ag1')).toBeUndefined()
    expect(stopMissed(false, undefined, 'ag1')).toBeUndefined()
  })

  test('a stop the engine refused is missed whatever the list says, the refusal named first', () => {
    expect(stopMissed(true, undefined, 'ag1')).toBe('the engine refused it')
    expect(stopMissed(true, [], 'ag1')).toBe('the engine refused it')
    expect(stopMissed(true, [listed('ag1', { status: 'killed' })], 'ag1')).toBe('the engine refused it')
  })
})

describe('the idle reviewers a sweep stops', () => {
  const former = (over: Partial<Conversation> = {}): Conversation => conversation({ review: undefined, reviewer: { id: 'ag2', model: 'm' }, reviewerIds: ['ag1', 'ag2', 'ag3'], ...over })

  test('every listed idle reviewer the state knows and does not store is swept, in the list\'s order', () => {
    expect(sweepable(former(), [listed('ag3', { status: 'idle' }), listed('ag2', { status: 'idle' }), listed('ag1', { status: 'idle' })])).toEqual(['ag3', 'ag1'])
  })

  test('the stored reviewer is not swept, idle or not', () => {
    expect(sweepable(former(), [listed('ag2', { status: 'idle' })])).toEqual([])
    expect(sweepable(former({ review: conversation().review }), [listed('ag2', { status: 'idle' })])).toEqual([])
  })

  test('an entry that is not idle is not swept', () => {
    for (const status of ['pending', 'running', 'waiting', 'completed', 'failed', 'killed'] as const) expect(sweepable(former(), [listed('ag1', { status })])).toEqual([])
  })

  test('an entry the state does not know is not swept, whoever spawned it or whatever it is called', () => {
    const agents = [listed('ag9', { status: 'idle', spawnedBy: 'auditor', type: 'auditor:reviewer', name: 'auditor-reviewer' }), listed('ag8', { status: 'idle', type: 'auditor:reviewer', name: 'auditor-reviewer-2' })]
    expect(sweepable(former(), agents)).toEqual([])
  })

  test('nothing is swept while a spawn is in flight', () => {
    expect(sweepable(former({ spawnsInFlight: [spawn()] }), [listed('ag1', { status: 'idle' })])).toEqual([])
  })

  test('a reviewer stored by no state at all is swept once the state knows it', () => {
    expect(sweepable(former({ reviewer: undefined }), [listed('ag1', { status: 'idle' })])).toEqual(['ag1'])
  })
})
