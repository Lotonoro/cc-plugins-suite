import { atom, read, update, type EngineInterface } from 'claude-code'
import type { HookFailure, On, Register, UiCopyArgs } from 'claude-code'
import type { OwedNotices, Store } from '../types'
import { TOOL, act, carryNext, clearAll, parseInput, type Outcome } from './items'
import { STEERING, TOOL_SPEC } from './steering'
import { oneLine, stateOf } from './done'
import { ARG_HINT, COMMAND, DESCRIPTION, FAILED, PHONE_REBUILDING, REBUILDING, USAGE, answerLine, answerTo, parseAsk, phoneBlock } from './commands'
import { carried, carryHeld, endTurn, giveBack, handOver, notEntered, offer, pending, reset, setOnChange, startTurn } from './turns'
import { band, pane, toolLine, type Handlers, type View } from './ui'
import { correctionText, newlyRestated, restatedIds } from './restatement'
import { enter } from './deliver'
import { PANE, endPane, followShown, markRead, personClosed, pickItem, setDrawn, shownSelection, showItem, syncPane } from './pane'
import { pressAnswer, pressDone, pressReply, rearmWindows, stopTicker } from './windows'
import { restored, resetRebuild, setForkedTranscript, startForkRestore, startRestore } from './rebuild'
import { emptyList, inBackground, readList, updateList } from './shared'

const SOUND = '/System/Library/Sounds/Glass.aiff'
const UNDO_WINDOW_MS = 3000

// The items a correction has named in this conversation, so each is corrected once (see correct).
const CORRECTED = { plugin: 'human-plugin', key: 'corrected' } as const
const corrected = atom(CORRECTED, [] as number[])
// The done notices turns.ts is still owed, kept here so a reload re-offers them (see saveNotices and restoreNotices).
const NOTICES = { plugin: 'human-plugin', key: 'notices' } as const
const notices = atom(NOTICES, { held: [], waiting: [] } as OwedNotices)

// Ends the turn: what it leaves goes to a turn of its own, or waits for the human (turns.ts). The turn's end and its failure
// handler both end it this way; the failure handler cannot tell which of the list's items are still there, so it keeps all.
const finishTurn = ($: EngineInterface, turnId: string, interrupted: boolean, isLive: (id: number) => boolean): void => {
  const submit = endTurn(turnId, interrupted, isLive)
  if (submit !== null) inBackground($, enter($, submit.text, () => notEntered(submit.notices)))
}

// A hook that threw or overran is logged with why, to the transcript; its `.catch` then answers in its place. A failure a hook caught
// in its own body is logged here too, as a throw.
const failed = ($: EngineInterface, hook: string, reason: Pick<HookFailure, 'kind' | 'message'>): void => {
  $.ui.log(`human-plugin: the ${hook} hook ${reason.kind}: ${reason.message ?? 'no message'}`)
}
// The stack of an error a hook caught, not only its message: a log line that names no place cannot be traced back to where the failure
// came from. An error with no stack is logged by its message, and a value that is not an Error as it is.
const messageOf = (err: unknown): string => (err instanceof Error ? err.stack || err.message : String(err))

// The list as it stands now, for the check a notice gets right before its row is appended. An unreadable list checks nothing:
// the notice is appended, and the failure is logged.
const liveNow = async ($: EngineInterface): Promise<(id: number) => boolean> => {
  try {
    const store = await readList($)
    return id => stateOf(store, id) !== 'missing'
  } catch (err) {
    $.ui.log(`human-plugin: the list could not be read before a notice was appended: ${String(err)}`)
    return () => true
  }
}

// What the human sees of a notice the model reads unseen (an appended row, or context beside their prompt): a dim
// transcript line, which the model is not sent. The line is one line, so the notice's line break is drawn as a space (oneLine).
const SHOWN = 'sent to Claude: '
const showSent = ($: EngineInterface, text: string): void => $.ui.log(`${SHOWN}${oneLine(text)}`)

// Appends one notice as a user row the model reads, and shows it (showSent). Returns false when the row was refused or failed: the notice then
// waits for the next read point or the turn's end, and the failure is logged, not dropped.
const appendNotice = async ($: EngineInterface, text: string): Promise<boolean> => {
  try {
    const row = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (typeof row.deny === 'string') {
      $.ui.log(`human-plugin: a notice was refused: ${row.deny}`, { to: 'debug' })
      return false
    }
    showSent($, text)
    return true
  } catch (err) {
    $.ui.log(`human-plugin: a notice could not be appended: ${String(err)}`)
    return false
  }
}

// Corrects a turn's answer that restated an open item's ask (restatement.ts): one row the agent reads on its next request,
// naming the items, and each item at most once per conversation. It runs before finishTurn, so the row sits after the answer
// and before any delivery submit. A failure is logged and changes nothing: the turn still ends.
const correct = async ($: EngineInterface, e: { reason: string; answer: string }, items: Store['items']): Promise<void> => {
  try {
    if (e.reason !== 'answer') return
    const fresh = newlyRestated(restatedIds(e.answer, items), await read($, corrected))
    if (fresh.length > 0 && (await appendNotice($, correctionText(fresh)))) await update($, corrected, ids => [...ids, ...fresh])
  } catch (err) {
    $.ui.log(`human-plugin: the restatement check failed: ${String(err)}`)
  }
}

// The state keeps the notices turns.ts is owed, so a reload finds them. Each change writes a snapshot; the writes are chained, so a later
// snapshot never lands before an earlier one. A failed write is logged rather than dropped.
let writing: Promise<void> = Promise.resolve()
const saveNotices = ($: EngineInterface): void => {
  const snapshot = pending()
  writing = writing
    .then(async () => {
      await $.state.set(NOTICES, snapshot)
    })
    .catch((err: unknown) => $.ui.log(`human-plugin: the notices were not saved: ${String(err)}`))
}

// A reload runs session.start again with the module's variables fresh, so the notices it was owed come back from the state: each one whose
// item is still on the list. A held one is held again, for the human's next prompt, as an interrupt left it. Waiting ones: an idle session
// submits them all as one prompt (a refused one is held, as any refused submit is); with a turn running, they wait for its read point.
// The stored value is then rewritten to what is still owed. `raw` is the stored value as session.start read it, before any change could
// overwrite it. An older release stored the owed notices as one list, all of them waiting ones.
const restoreNotices = async ($: EngineInterface, raw: OwedNotices | OwedNotices['waiting']): Promise<void> => {
  const stored = Array.isArray(raw) ? { held: [], waiting: raw } : raw
  if (stored.held.length === 0 && stored.waiting.length === 0) return
  // An unreadable list checks nothing, as at a read point (liveNow): every owed notice is re-offered, so none is lost to a failed read.
  let isLive: (notice: { id: number }) => boolean
  try {
    const store = await readList($)
    isLive = notice => stateOf(store, notice.id) !== 'missing'
  } catch (err) {
    $.ui.log(`human-plugin: the list could not be read to check the owed notices, so they are re-offered unchecked: ${String(err)}`)
    isLive = () => true
  }
  const held = stored.held.filter(isLive)
  if (held.length > 0) giveBack(held)
  const live = stored.waiting.filter(isLive)
  const [first, ...rest] = live
  if (first !== undefined) {
    if (offer(first) === 'submit') inBackground($, enter($, live.map(notice => notice.text).join('\n\n'), () => notEntered(live)))
    else for (const notice of rest) offer(notice)
  }
  saveNotices($)
}

// A brief's copy button: the toast says whether the text reached the clipboard, since the copy itself shows nothing.
const copyText = async ($: EngineInterface, text: string, surface: UiCopyArgs['surface']): Promise<void> => {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? 'copied' : `not copied: ${r.reason}`)
}

const handlers = ($: EngineInterface, windowMs: number): Handlers => ({
  pick: (id, isSelected) => inBackground($, pickItem($, id, isSelected)),
  done: (id, answer) => inBackground($, pressDone($, id, answer, windowMs)),
  reply: (id, text) => inBackground($, pressReply($, id, text, windowMs)),
  more: id => inBackground($, showItem($, id)),
  copy: (text, surface) => inBackground($, copyText($, text, surface)),
})

// The tool's answer. A blocking add, or an update that marks an open item blocking, plays a sound; the reply stays one short line.
// While the list is being rebuilt from a transcript the call waits for it, so it never numbers or changes items the rebuild has not filled in.
const answer = async ($: EngineInterface, e: unknown) => {
  const parsed = parseInput(e)
  if (!parsed.ok) return { deny: `human_items: ${parsed.reason}` }
  if (!(await restored($))) return { deny: 'human_items: the list is still being rebuilt from the transcript; call again in a moment' }
  const agentId = (e as { agentId?: unknown }).agentId
  const ctx = { agent: typeof agentId === 'string' ? agentId : null, now: await $.clock.now() }
  const holder: { out: Outcome | null } = { out: null }
  await updateList($, store => {
    holder.out = act(store, parsed.value, ctx)
    return 'store' in holder.out ? holder.out.store : store
  })
  const out = holder.out
  if (out === null) throw new Error('human_items: the list was not read')
  if ('deny' in out) return { deny: out.deny }
  if (out.added !== null) await saveCounter($, out.store.next)
  await followShown($, out)
  if (out.added?.blocking || out.changed?.promoted) {
    inBackground($, $.process.run(['afplay', SOUND]).then(r => $.ui.log(`human-plugin: sound ${SOUND}, afplay exit ${r.exitCode}`, { to: 'debug' })))
  }
  return { result: out.reply }
}

// The `/asks` command's answer: the list, one item whole, or the confirmation of an answer form. It waits for a rebuild in progress as the tool
// does, and clears the unread mark of the one item it shows, if that item is still the one it printed (markRead); an answer form clears its
// item's mark in its own write (pressAnswer). The wording and the parse are commands.ts's. A mark that cannot be cleared is logged, and the text
// is still returned: the item is what the person asked for.
const asks = async ($: EngineInterface, args: string, windowMs: number): Promise<string> => {
  const ask = parseAsk(args)
  if (ask.kind === 'usage') return USAGE
  if (!(await restored($))) return REBUILDING
  if (ask.kind === 'answer') return answerLine(await pressAnswer($, ask.digits, ask.form, windowMs))
  const { items } = await readList($)
  const { text, shown } = answerTo(items, ask)
  const printed = items.find(it => it.id === shown)
  if (printed !== undefined) {
    try {
      await markRead($, printed.id, printed)
    } catch (err) {
      $.ui.log(`human-plugin: the unread mark of #${printed.id} was not cleared: ${String(err)}`)
    }
  }
  return text
}

// The id counter outlives a /clear in the plugin store: the old session saves it (never lower than what is stored) and the
// new session, which starts with a fresh state, carries it back.
const NEXT_KEY = 'next'
// The id counter is saved on every add, so a /clear whose carry fails still finds the highest id handed out. A failed save is
// logged rather than thrown: the item is on the list already, and the reply says so. The saved counter is never lowered: a
// session whose count is behind the store's keeps the store's.
const saveCounter = async ($: EngineInterface, next: number): Promise<void> => {
  try {
    await $.store.set(NEXT_KEY, carryNext({ items: [], next, term: null }, await $.store.get(NEXT_KEY)).next)
  } catch (err) {
    $.ui.log(`human-plugin: the id counter was not saved: ${String(err)}`)
  }
}

const carry = async ($: EngineInterface): Promise<void> => {
  const saved = await $.store.get(NEXT_KEY)
  await updateList($, store => carryNext(store, saved))
}

// The plugin's hooks, with the undo window they use. `register` is the one the engine loads, with the fixed window; the window is a
// parameter only so that a test can load the same hooks with another (register.test.ts).
export const wireHooks = (on: On, windowMs: number): void => {
  // Also what a reload runs again (session.start fires once per fresh load of the plugin): the undo windows its old timers held are timed again,
  // and the notices it was owed come back from the state. Their read is made first, before the change hook is set, since a change saves the
  // module's own notices over them. A failed read still fails where it is awaited, after the tool is registered. The hook is set next, so
  // every change from here on reaches the state.
  on('session.start', async ($, e, next) => {
    const owed: Promise<OwedNotices | OwedNotices['waiting']> = read($, notices)
    owed.catch(() => {})
    setOnChange(() => saveNotices($))
    await $.tool.register(TOOL_SPEC)
    // A failed registration is logged, and the rest of the start still runs: the rebuild, the undo windows and the owed notices.
    try {
      await $.command.register({ name: COMMAND, description: DESCRIPTION, argumentHint: ARG_HINT, immediate: true })
    } catch (err) {
      $.ui.log(`human-plugin: the /${COMMAND} command was not registered: ${String(err)}`)
    }
    await startForkRestore($)
    await rearmWindows($, windowMs)
    await restoreNotices($, await owed)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, STEERING] }
  })

  // The mod answers its own calls in tool.call, so the engine never checks them; this allow is the verdict the
  // engine's own check would otherwise ask the person for (the default is ask). The matchers spell the tool's name out, since
  // `claude plugin validate` reports a matcher whose value is a constant as {tool=?}.
  on('tool.check', { tool: 'mcp__human-plugin__human_items' }, () => ({ decision: 'allow' })).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__human-plugin__human_items' }, ($, e) => answer($, e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'human_items: the mod failed to answer the call' },
  )

  // The matcher spells the name out, as the tool's do. A throw is logged and answers one error line; the list is left as it was.
  on('command.run', { command: 'asks' }, ($, e) => asks($, e.args, windowMs).then(text => ({ text }))).catch(($, _e, next) => {
    failed($, 'command.run', next.error)
    return { text: FAILED }
  })

  // A done notice reaches a running turn at a read point the engine holds before its next request (turns.ts): the end of
  // a tool batch. A request that starts afterwards carries it; a turn that ends first hands what is left to a turn of its
  // own, or, after an interrupt, holds it for the human's next prompt.
  // A notice that landed while the turn was starting is appended here, before the turn's first request.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    startTurn()
    await handOver(text => appendNotice($, text), () => liveNow($))
    await startForkRestore($)
    return next(e)
  })

  on('classic.PostToolBatch', async ($, e, next) => {
    if (e.agent_id === undefined) await handOver(text => appendNotice($, text), () => liveNow($))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) carried()
    return yield* next(e)
  })

  // The human's own prompt carries the notices an interrupt held, as context beside it: once, and only when it enters. A
  // held notice whose item the agent has removed since is dropped, the list being read here as at the turn's end. A prompt
  // from the phone also carries the open items (commands.ts's phoneBlock), as context the person does not see: it waits for a
  // rebuild in progress, as /asks does, and when the wait runs out it carries the rebuilding line instead. The block is in the
  // one call that passes the prompt on, ahead of the held notices. The wait comes before the read, so the read sees what a rebuild filled
  // in. The wait and the block each have their own try: a failure in either is logged, and the prompt goes through with its held notices,
  // filtered as above, and no block. The read sits outside both tries, so an unreadable list still reaches the catch.
  on('prompt.submit', async ($, e, next) => {
    const phone = e.origin.kind === 'bridge' && e.command === undefined
    // Null when the wait failed: no block is built then.
    let rebuilt: boolean | null = true
    if (phone) {
      try {
        rebuilt = await restored($)
      } catch (err) {
        rebuilt = null
        failed($, 'prompt.submit', { kind: 'throw', message: messageOf(err) })
      }
    }
    const store = await readList($)
    let block: string | null = null
    if (phone && rebuilt !== null) {
      try {
        block = rebuilt ? phoneBlock(store.items) : PHONE_REBUILDING
      } catch (err) {
        failed($, 'prompt.submit', { kind: 'throw', message: messageOf(err) })
      }
    }
    const withBlock = block === null ? e : { ...e, context: [...(e.context ?? []), block] }
    return carryHeld(withBlock, next, id => stateOf(store, id) !== 'missing', text => showSent($, text))
  }).catch(($, e, next) => {
    failed($, 'prompt.submit', next.error)
    // An unreadable list carries the held notices unchecked rather than holding them back.
    return next.called ? next(e) : carryHeld(e, next, () => true, text => showSent($, text))
  })

  // The list is read here, before the turn's end takes what is left: a notice whose item the agent has removed starts nothing.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const store = await readList($)
      await correct($, e, store.items)
      finishTurn($, e.turnId, e.isAborted, id => stateOf(store, id) !== 'missing')
    }
    return next(e)
  }).catch(($, e, next) => {
    failed($, 'turn.complete', next.error)
    // An unreadable list must not strand the turn's notices: the turn ends unchecked.
    if (!next.called && e.agentId === undefined) finishTurn($, e.turnId, e.isAborted, () => true)
    return next(e)
  })

  // A session's end ends what the mod holds for its conversation: the turn's notices, the undo countdown's redraw, a rebuild in progress
  // (its generation is dropped after a /clear or a /resume alike, so it cannot fill the next conversation's list) and a fork waiting for
  // its transcript. /clear also empties the list; a resume starts with a fresh one (the state is held per session), which its rebuild fills.
  // The id counter goes to the plugin store for the new session to carry (see carry).
  on('session.end', async ($, e, next) => {
    reset()
    stopTicker()
    resetRebuild()
    // The pane goes first, before anything that can fail: its item leaves with the list, so it must not stay open on nothing.
    endPane($, e.reason === 'clear')
    if (e.reason === 'clear') {
      const kept = carryNext(await readList($), await $.store.get(NEXT_KEY))
      await $.store.set(NEXT_KEY, kept.next)
      await updateList($, clearAll)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    failed($, 'session.end', next.error)
    // A /clear empties the list even when the carry failed, and the counter comes from the store, which every add saved.
    if (!next.called && e.reason === 'clear') await emptyList($, await $.store.get(NEXT_KEY))
    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    if (e.source === 'resume' && e.transcript_path) startRestore($, e.transcript_path)
    if (e.source === 'fork' && e.transcript_path) setForkedTranscript(e.transcript_path)
    if (e.source === 'clear') inBackground($, carry($))
    return next(e)
  })

  // A close the mod hears. The mod's own close clears the flag itself, before the close is awaited (closePane), so only another's counts.
  on('ui.close', ($, e, next) => {
    personClosed(e.id, e.origin.kind)
    return next(e)
  })

  // The mod's tool draws its own rows: one line for the call, and the result row beneath a standalone call, which would
  // only repeat the reply, is drawn empty. Every other tool's rows pass through.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool !== TOOL) return next(e)
    return $.ui.resolve(e).Text({ dimColor: true, wrap: 'truncate-end', children: [toolLine(e.props)] })
  })

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== TOOL) return next(e)
    return $.ui.resolve(e).Box({ display: 'none' })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await syncPane($)
    const store = await readList($)
    setDrawn(store.items)
    if (store.items.length === 0) return next(e)
    const selected = await shownSelection($)
    const view: View = { maxRows: e.props.maxRows, now: await $.clock.now(), windowMs, selected }
    return band($.ui.resolve(e), handlers($, windowMs), store, view)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const view: View = { maxRows: 0, now: await $.clock.now(), windowMs, selected: await shownSelection($) }
    const store = await readList($)
    setDrawn(store.items)
    return pane($.ui.resolve(e), handlers($, windowMs), store, view)
  })
}

export const register: Register = on => wireHooks(on, UNDO_WINDOW_MS)
