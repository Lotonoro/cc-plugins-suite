import { atom, read, update, type EngineInterface } from 'claude-code'
import type { HookFailure, On, Register, UiCopyArgs } from 'claude-code'
import type { OwedNotices, Store } from '../types'
import { PLUGIN, TOOL, act, carryNext, clearAll, parseInput, type Outcome } from './items'
import { STEERING, TODO_SPEC, TOOL_SPEC } from './steering'
import { countBatch } from './reminder'
import { SUBAGENT_REFUSAL, TODO_NAME, TODO_TOOL, emptyTodo, parseTodo, readName, readTodo, todoLine, todoReply, writeName, writeTodo } from './todo'
import { oneLine } from './cut'
import { messageOf, stateOf } from './done'
import {
  ARG_HINT, CLAUDE_COMMAND, CLAUDE_DESCRIPTION, CLAUDE_FAILED, CLAUDE_REBUILDING, CLAUDE_USAGE, COMMAND, DESCRIPTION, FAILED, PHONE_REBUILDING, REBUILDING, USAGE,
  answerLine, answerTo, claudeTodoText, hasArgument, parseAsk, phoneBlock,
} from './commands'
import { carried, carryHeld, endTurn, giveBack, handOver, notEntered, offer, pending, reset, setOnChange, startTurn } from './turns'
import { backlogPane, band, pane, toolLine, type Handlers, type View } from './ui'
import { bandDraws } from './layout'
import { correctionText, newlyRestated, restatedIds } from './restatement'
import { enter } from './deliver'
import { CLAUDE_VIEW, PANE, endPane, followShown, followTodo, markRead, paneDocked, personClosed, pickBacklog, pickItem, seated, setDrawn, setDrawnTodo, shownSelection, showItem, syncPane } from './pane'
import { endPushes, pushAnswer } from './push'
import { pressAnswer, pressDone, pressReply, rearmWindows, stopTicker } from './windows'
import { restored, resetRebuild, setForkedTranscript, startForkRestore, startRestore } from './rebuild'
import { emptyList, inBackground, readList, updateList } from './shared'
import { endWalk, observeAsked, walk } from './walk'

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
  pick: id => inBackground($, pickItem($, id)),
  backlog: () => inBackground($, pickBacklog($)),
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
  pushAnswer($, out)
  if (out.added !== null) await saveCounter($, out.store.next)
  await followShown($, out)
  if (out.added?.blocking || out.changed?.promoted) {
    inBackground($, $.process.run(['afplay', SOUND]).then(r => $.ui.log(`human-plugin: sound ${SOUND}, afplay exit ${r.exitCode}`, { to: 'debug' })))
  }
  return { result: out.reply }
}

// The `/todo` command's answer: the list, one item whole, the confirmation of an answer form, or the walk's end text (`/todo answer`, walk.ts, which asks
// about each open item before it returns). It waits for a rebuild in progress as the tool does, and clears the unread mark of the one item it shows, if that
// item is still the one it printed (markRead); an answer form clears its item's mark in its own write (pressAnswer). The wording and the parse are
// commands.ts's. A mark that cannot be cleared is logged, and the text is still returned: the item is what the person asked for.
const todoCommand = async ($: EngineInterface, args: string, windowMs: number): Promise<string> => {
  const ask = parseAsk(args)
  if (ask.kind === 'usage') return USAGE
  if (!(await restored($))) return REBUILDING
  if (ask.kind === 'answer') return answerLine(await pressAnswer($, ask.digits, ask.form, windowMs))
  if (ask.kind === 'walk') return walk($, windowMs)
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

// The `/claude-todo` command's answer: the Claude TODO list under the name the agent stated for it, once a rebuild in progress has ended, as the print commands.ts words. It takes no argument.
const claudeTodo = async ($: EngineInterface, args: string): Promise<string> => {
  if (hasArgument(args)) return CLAUDE_USAGE
  if (!(await restored($))) return CLAUDE_REBUILDING
  return claudeTodoText(await readTodo($), await readName($))
}

// The Claude list tool's calls, in the order they arrived. The engine does not promise to finish parallel calls in the order it started them,
// and a resume replays the transcript's order, so each call waits for the one before it: the list left live is the list a resume rebuilds.
let todoTurn: Promise<void> = Promise.resolve()

// The name a call states, stored after the list it may carry. A name that cannot be stored is logged and not thrown: the list is written by then, so the call is answered, and its
// answer is headed by the name as stored.
const storeName = async ($: EngineInterface, name: string): Promise<void> => {
  try {
    await writeName($, name)
  } catch (err) {
    $.ui.log(`human-plugin: the agent list's name was not stored: ${String(err)}`)
  }
}

// The Claude list tool's answer: a write replaces the list whole, a call with no list reads it, and a call that states a name sets it, a blank one clearing it. Only the main agent keeps
// the list, so a subagent's call is refused. Like the human tool's, a call waits for a rebuild in progress, so it never reads or replaces a list the rebuild has not filled in. A refused
// call changes nothing and takes no turn. The list is written before the name, so a list write that fails fails the call before the name changes. A call that writes either is followed up
// once, after both writes and before the call answers, inside its place in the call order (todoTurn), so the pane that shows the list follows each call in order. A call that states a
// name and no list writes no list, and is a read in every other way.
const todoAnswer = async ($: EngineInterface, e: unknown) => {
  const parsed = parseTodo(e)
  if (!parsed.ok) return { deny: `${TODO_NAME}: ${parsed.reason}` }
  if (typeof (e as { agentId?: unknown }).agentId === 'string') return { deny: `${TODO_NAME}: ${SUBAGENT_REFUSAL}` }
  const before = todoTurn
  const turn: { done: () => void } = { done: () => undefined }
  todoTurn = new Promise<void>(resolve => (turn.done = resolve))
  try {
    await before
    if (!(await restored($))) return { deny: `${TODO_NAME}: the list is still being rebuilt from the transcript; call again in a moment` }
    if (parsed.value !== null) await writeTodo($, parsed.value)
    if (parsed.name !== null) await storeName($, parsed.name)
    if (parsed.value !== null || parsed.name !== null) await followTodo($)
    return { result: todoReply(parsed.value ?? (await readTodo($)), await readName($)) }
  } finally {
    turn.done()
  }
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
    await $.tool.register(TODO_SPEC)
    // A failed registration is logged, and the rest of the start still runs: the other command, the rebuild, the undo windows and the owed notices.
    const commands = [
      { name: COMMAND, description: DESCRIPTION, argumentHint: ARG_HINT, immediate: true },
      { name: CLAUDE_COMMAND, description: CLAUDE_DESCRIPTION, immediate: true },
    ] as const
    for (const spec of commands) {
      try {
        await $.command.register(spec)
      } catch (err) {
        $.ui.log(`human-plugin: the /${spec.name} command was not registered: ${String(err)}`)
      }
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

  // The walk's own dialogs (`$.ui.ask`, raised from the `/todo` hook) reach this hook as AskUserQuestion calls, and it sees each result before the dialog
  // returns. Every call passes through unchanged: the model's and other plugins' as well as the walk's. A call this plugin made is also handed, with its
  // result, to the walk, which records it (walk.ts); a throw there is logged and leaves the result as it was. The hook has no `.catch`: one that passed the
  // call on again would raise a dismissed dialog a second time. The matcher spells the tool's name out, as the others do.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const result = await next(e)
    try {
      if (next.origin.plugin === PLUGIN) observeAsked($, e, result)
    } catch (err) {
      $.ui.log(`human-plugin: the record of a walk's question failed: ${messageOf(err)}`)
    }
    return result
  })

  // The mod answers its own calls in tool.call, so the engine never checks them; this allow is the verdict the
  // engine's own check would otherwise ask the person for (the default is ask). The matchers spell the tool's name out, since
  // `claude plugin validate` reports a matcher whose value is a constant as {tool=?}.
  on('tool.check', { tool: 'mcp__human-plugin__claude_todo' }, () => ({ decision: 'allow' })).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__human-plugin__claude_todo' }, ($, e) => todoAnswer($, e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${TODO_NAME}: the mod failed to answer the call` },
  )

  on('tool.check', { tool: 'mcp__human-plugin__human_items' }, () => ({ decision: 'allow' })).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__human-plugin__human_items' }, ($, e) => answer($, e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'human_items: the mod failed to answer the call' },
  )

  // The matcher spells the name out, as the tool's do. A throw is logged and answers one error line; the list is left as it was.
  on('command.run', { command: 'todo' }, ($, e) => todoCommand($, e.args, windowMs).then(text => ({ text }))).catch(($, _e, next) => {
    failed($, 'command.run', next.error)
    return { text: FAILED }
  })

  // The same for `/claude-todo`: the name spelled out in the matcher, and a throw logged and answered by its own failure line.
  on('command.run', { command: 'claude-todo' }, ($, e) => claudeTodo($, e.args).then(text => ({ text }))).catch(($, _e, next) => {
    failed($, 'command.run', next.error)
    return { text: CLAUDE_FAILED }
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

  // The main agent's batch also counts its calls toward the Claude list's reminder (reminder.ts), which rides the result's context after any
  // the rest of the chain gave. A subagent's batch is neither counted nor reminded.
  on('classic.PostToolBatch', async ($, e, next) => {
    if (e.agent_id !== undefined) return next(e)
    await handOver(text => appendNotice($, text), () => liveNow($))
    const result = await next(e)
    const reminder = await countBatch($, e.tool_calls, TODO_TOOL)
    return reminder === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), reminder] }
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) carried()
    return yield* next(e)
  })

  // The human's own prompt carries the notices an interrupt held, as context beside it: once, and only when it enters. A
  // held notice whose item the agent has removed since is dropped, the list being read here as at the turn's end. A prompt
  // from the phone also carries the open items (commands.ts's phoneBlock), as context the person does not see: it waits for a
  // rebuild in progress, as /todo does, and when the wait runs out it carries the rebuilding line instead. The block is in the
  // one call that passes the prompt on, ahead of the held notices. The wait comes before the read, so the read sees what a rebuild filled
  // in. A failed wait has its own try: it is logged, and the prompt goes through with its held notices, filtered as above, and no block.
  // The read sits outside that try, so an unreadable list still reaches the catch.
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
    const block = phone && rebuilt !== null ? (rebuilt ? phoneBlock(store.items) : PHONE_REBUILDING) : null
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
  // (its generation is dropped after a /clear or a /resume alike, so it cannot fill the next conversation's list), a fork waiting for
  // its transcript and the walk that is asking (its flag is released, so a dialog it leaves open cannot block the next walk). /clear also empties
  // the list; a resume starts with a fresh one (the state is held per session), which its rebuild fills.
  // The id counter goes to the plugin store for the new session to carry (see carry).
  on('session.end', async ($, e, next) => {
    endPushes()
    reset()
    stopTicker()
    resetRebuild()
    endWalk()
    // The pane goes first, before anything that can fail: after a /clear its item leaves with the list, and a resume rebuilds the Claude list the backlog shows, so the pane must
    // not stay open on nothing or on the old list's rows.
    endPane($, e.reason === 'clear')
    if (e.reason === 'clear') {
      const kept = carryNext(await readList($), await $.store.get(NEXT_KEY))
      await $.store.set(NEXT_KEY, kept.next)
      await updateList($, clearAll)
      await emptyTodo($)
    }
    return next(e)
  }).catch(async ($, e, next) => {
    failed($, 'session.end', next.error)
    // A /clear empties the list even when the carry failed, and the counter comes from the store, which every add saved.
    if (!next.called && e.reason === 'clear') {
      // The Claude list is emptied even when emptying the human list throws.
      try {
        await emptyList($, await $.store.get(NEXT_KEY))
      } finally {
        await emptyTodo($)
      }
    }
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

  // The mod's tools draw their own rows: one line for the call, and the result row beneath a standalone call, which would
  // only repeat the reply, is drawn empty. Every other tool's rows pass through.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.tool !== TOOL && e.props.tool !== TODO_TOOL) return next(e)
    return $.ui.resolve(e).Text({ dimColor: true, wrap: 'truncate-end', children: [e.props.tool === TOOL ? toolLine(e.props) : todoLine(e.props)] })
  })

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== TOOL && e.props.tool !== TODO_TOOL) return next(e)
    return $.ui.resolve(e).Box({ display: 'none' })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await syncPane($)
    const store = await readList($)
    setDrawn(store.items)
    const todo = await readTodo($)
    const name = await readName($)
    setDrawnTodo(todo, name)
    if (!bandDraws(store.items.length, todo)) return next(e)
    // Read for the record it keeps (pane.ts, lastRead): the stored selection a press decides on after a reload with the pane open, before any press or move has set one. The band draws
    // no row as the shown one, so it uses nothing the read returns.
    await shownSelection($)
    const view: View = { maxRows: e.props.maxRows, now: await $.clock.now(), windowMs, claude: { items: todo, columns: e.props.bodyColumns, isDocked: paneDocked(e.surface), name } }
    return band($.ui.resolve(e), handlers($, windowMs), store, view)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // First, before anything this draw reads: the band's width rule turns on whether this surface has seated the pane as a dock.
    seated($, e.surface, e.props.placement)
    const selected = await shownSelection($)
    // The pane shows the Claude list or a human item, by what the selection says.
    if (selected === CLAUDE_VIEW) {
      const todo = await readTodo($)
      const name = await readName($)
      setDrawnTodo(todo, name)
      return backlogPane($.ui.resolve(e), todo, e.props.bodyColumns, name)
    }
    const view: View = { maxRows: 0, now: await $.clock.now(), windowMs, selected }
    const store = await readList($)
    setDrawn(store.items)
    return pane($.ui.resolve(e), handlers($, windowMs), store, view)
  })
}

export const register: Register = on => wireHooks(on, UNDO_WINDOW_MS)
