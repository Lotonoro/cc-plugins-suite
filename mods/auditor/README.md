# auditor

A second Claude reviews your session as you work. When the agent finishes a turn, a reviewer subagent on Haiku 5.5
at high effort reads what the agent did and checks it against the rules the agent is bound by: your instructions, the
plan, skills and CLAUDE.md, and the correctness of the code it touched. When it finds a deviation, it hands the agent
one note: an idle agent takes it at once, as the prompt of a turn of its own, and a busy agent reads it at its next
tool call. When it finds nothing, it stays silent.

The reviewer corrects; it does not steer. A note must cite what the agent did (a tool call, a claim, a file on disk)
and the rule it breaks or the action the agent said it would take, and it leaves the fix to the agent. It speaks only
when the agent needs to change course or a bug in the code would otherwise go unnoticed: no notes that withdraw an
earlier one, confirm a fix, or correct the wording of a message when nothing would act on it.

## What you see

```
⏵⏵ auto mode on · (shift+tab to cycle) · auditor is on
```

- **The toggle** sits on the footer's mode row, after Claude Code's mode labels and a dim ` · ` separator. It reads
  `auditor is on` while the reviewer runs, and `auditor is failing` while its reviews fail. Click it to switch:
  `auditor is off` pauses the reviewer for this session, so no new review starts and nothing is recorded, though a
  review already running finishes and its note still arrives. It stays off across `/clear`. Clicking it again,
  `auditor is on`, resumes the reviewer, and the next review covers only what happens from then on. `/auditor off` and
  `/auditor on` do the same from anywhere, mid-turn too, and bare `/auditor` says which it is: the Claude mobile app
  draws no footer, but runs the command and shows its answer. Every new session starts on. To stop it for good,
  disable the plugin with `/plugin`.
- **Notes** reach the agent headed `auditor, review N:`, never as your words. An idle agent takes its note at once,
  and the note's prompt starts a turn of its own, which the reviewer then reviews too, so the agent and the reviewer
  may go back and forth for several turns without you. A busy agent reads its notes at its next tool call, or when
  that turn ends if it makes no more calls. Two holds keep notes back until you prompt: after you interrupt a turn, and
  after a submit another hook dropped (a busy agent still reads those at its next tool call). Your next prompt (typed
  or sent from your phone, but not a slash command) carries them beside it and ends both holds; a slash command
  releases nothing. Every note shows in your transcript as a
  dim line, `auditor note N to Claude: …`, when it reaches the agent; the agent never reads that line. An escalation
  needs you: the agent answers it in the transcript, where you read it.
- **Nothing else.** Beyond those lines, a review that finds nothing leaves no trace on screen, and neither do the reviewer's own messages
  or task rows. Two things reach you: an escalation of an unresolved disagreement, as a toast and as a push
  notification on your phone when you are away from the terminal (Claude Code holds it back while you are at it), and
  the toggle reading `auditor is failing` while reviews fail, until one succeeds; the debug log has the cause. In a headless
  `claude -p` run, which has no agent team, the reviewer's hand-back is dropped at the prompt instead, and the run's
  output says `Prompt dropped by a hook: reviewer bookkeeping`.

## Install

Install it from the marketplace that lists it (Claude Code 2.1.275 or later):

```bash
/plugin install auditor --marketplace <owner>/<repo>
```

Or load it for one session from a clone of this repo: `claude --plugin-dir <clone>/mods/auditor`.

Then start a new session. The reviewer is on as soon as the plugin is loaded.

## Details

- **Cost.** A review starts when the agent ends a turn and no review is running; turns that end during a review go to
  the next one together. Each review is one Haiku run that reads the record and whatever files or earlier context it
  needs. The `log` setting records each review's token use, if you want a figure.
- **A fresh reviewer.** One reviewer serves the session and remembers its earlier reviews. Once its context passes
  80,000 tokens, which keeps it under Haiku's higher price tier, the next review goes to a fresh reviewer, told the
  last five notes the worker was given; it finds your instructions again in the transcript. A fresh reviewer also
  carries none of the old one's reading of the session, which keeps it independent. The retired reviewer is stopped,
  so it does not stay idle for the rest of the session. So is a reviewer forgotten on a `/clear`, or one whose brief
  was refused. Should one review alone outgrow 100,000 tokens, the reviewer
  compacts, keeping your instructions, its notes and any open disagreement.
- **What the reviewer reads.** A record of the agent's turns since the previous review: your prompts, the agent's
  replies and every tool call with its result. It also reads files on disk, and it can search the whole session's
  transcript to find an instruction you gave many turns ago. Search results come back as short snippets around each
  match, and a whole transcript line only when the reviewer asks for it.
- **Setting.** `log` (default off) writes one JSON file per review, with its note, timing and token use, to
  `~/.claude/auditor/<session id>/`. It is declared under `userConfig` in `.claude-plugin/plugin.json`.

## The stall nudge

Sometimes the agent ends a turn with work it said it would do still undone, or waiting on a shell or subagent that has
already finished. Nothing then wakes it, and it sits idle until you type something. When nothing is in flight to wake
the agent, the reviewer is told so, and it may answer with a note opening `Stalled:`, which reaches the agent as any
note does and resumes it.

- **What counts as in flight.** A subagent or teammate that is working or waiting on its own work, or one the agent messaged in the turn
  whatever its status; a shell, a monitor or another background task; or a scheduled wake-up. An idle, finished,
  failed or killed agent does not count, nor does the reviewer's own, and "nothing in flight" is exact. The limit: a
  teammate in a terminal pane of its own that has died still reads as working, so no nudge comes for it.
- **No nudge** when the agent's own last tool call asked you something (`AskUserQuestion`, or filing a human-plugin
  item), when the turn ended aborted, or when a stall note on a review dispatched since your last prompt already reached the
  agent. So one stall gets one nudge; your next prompt, `/clear` or the toggle re-arms it. A stall note from a review whose
  brief did not say nothing will wake the agent is dropped.
- **The limit.** The reviewer judges the wording of the last turn, so it can miss a stall, and it can flag one that is
  not. Only the guards above are mechanical.

## Known limits

- A review takes minutes, so a note can land a turn or two after the step it is about.
- `/clear` starts a new transcript, so the reviewer cannot find instructions given before it, just as the agent has
  lost them.

## Development checks

From the repository root, after the plugin has loaded once (Claude Code writes the type declarations that `tsc`
needs into `.claude-plugin/types/` on first load):

```bash
claude plugin validate mods/auditor
tsc -p mods/auditor --noEmit
claude plugin test mods/auditor
```
