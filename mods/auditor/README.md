# auditor

A second Claude reviews your session as you work. When the agent finishes a turn, a reviewer subagent on Haiku 5.5
at high effort reads what the agent did and checks it against the rules the agent is bound by: your instructions, the
plan, skills and CLAUDE.md, and the correctness of the code it touched. When it finds a deviation, it sends the agent
one note as a message: an idle agent takes it at once, in a turn of its own, and a busy agent reads it once its turn
ends. When it finds nothing, it stays silent.

The reviewer corrects; it does not steer. A note must cite what the agent did (a tool call, a claim, a file on disk)
and the rule it breaks or the action the agent said it would take, and it leaves the fix to the agent. It speaks only
when the agent needs to change course or a bug in the code would otherwise go unnoticed: no notes that withdraw an
earlier one, confirm a fix, or correct the wording of a message when nothing would act on it.

## What you see

```
⏵⏵ auto mode on · (shift+tab to cycle) · auditor on ($12, 3%)
```

- **The toggle** sits on the footer's mode row, after Claude Code's mode labels and a dim ` · ` separator. It reads
  `auditor on` while the reviewer runs, and `auditor failing` while its reviews fail; once the reviewer has spent
  anything, the label adds its cost and its share of the session's cost in parentheses (`auditor on ($12, 3%)`).
  Click it to switch: `auditor off` stops the reviewer for this session at once: a review already running is stopped, the reviewer
  sends nothing more, no new review starts and nothing is recorded; a note it sent just before may still arrive, and a note held for your next prompt after an Esc is dropped. It stays off across `/clear`. Clicking it again,
  `auditor on`, resumes the reviewer, and the next review covers only what happens from then on. `/auditor off` and
  `/auditor on` do the same from anywhere, mid-turn too, and bare `/auditor` says which it is and what it has cost, the
  button's label and the popup's rows: the Claude mobile app draws no footer, but runs the command and shows its answer. `/auditor memory` prints the reviewer's memory of the
  notes it delivered, the findings still in flight and the ones it settled, from any surface, the phone included.
  Every new session starts on. To stop it for good, disable the plugin with `/plugin`.
- **The hover popup.** Pointing at the button shows, above it and without moving the footer, what the label rounds
  and what the reviewer has done, then what a click does, in at most four rows:

  ```
  auditor $12.40 since on · session $410.27 · 3% · API list prices
  14 reviews · 3 notes · last at 14:32, quiet
  click to switch off
  failing: the reviewer ended a turn without an answer · 1 note held
  ```

  The first row is the reviewer's cost since it was switched on, to the cent, the session's cost and the share. The
  second counts the reviews that completed and the notes given since the session or conversation began or the auditor
  was switched on, and says when the last review closed (the time of day on your machine) and whether it sent a note
  (`note sent`) or stayed silent (`quiet`); before any review it reads `no reviews yet`. A review that fails is not
  counted. The fourth row appears only when something needs saying: `failing:` with the cause, which is one of `the
  reviewer ended a turn without an answer`, `a review could not be handed to a reviewer`, `the reviewer did not start
  in 10 minutes`, `the reviewer did not finish in 10 minutes` or `cause unknown; see the debug log`; and `N notes held for your next prompt` while notes wait
  for your next message after an Esc (joined to the failing text as `· 1 note held` when both apply). The popup is not
  redrawn while it is open, so the close time is a clock time, not "2 min ago". The reviewer's raw failure reason is in
  the debug log. While the auditor is off it says `off: no reviews, no figures until switched on` and `click to switch
  on`, with no review facts. When the reviewer's cost cannot be priced, the label drops its figures and the cost row
  says `cost unknown: no price for <model>`. `/auditor` answers with the same rows after the label.
- **Notes** reach the agent as a message from the reviewer, headed `auditor, review N:`, never as your words. Each
  shows in your transcript as Claude Code's grey collapsed `› Message from @auditor-reviewer` row. An idle agent
  takes its note at once, in a turn of its own, which the reviewer then reviews too, so the agent and the reviewer
  may go back and forth for several turns without you. A busy agent reads its note once its turn ends. After you
  switch the reviewer off or `/clear`, it sends nothing more, though a note it sent just before may still arrive. A
  reviewer whose final answer opens with its review line and a note, instead of sending it, gets one follow-up asking
  it to send the note. An escalation needs you: the agent answers it in the transcript, where you read it.
- **A note after an Esc.** Once you interrupt a turn, Claude Code refuses a message to the agent until you type
  again. A note the reviewer sends in that state is held, and reaches the agent with your next message, with no row of
  its own; a slash command does not carry it. An escalation still shows its toast and push when the reviewer gives it.
  Switching the reviewer off or `/clear` drops a held note. A held note's log reads `note_delivered: false`, though the
  note rides with that message unless the toggle or `/clear` drops it.
- **No review after an Esc until you type.** After you interrupt a turn, and while a note is held, no review starts:
  the turns in between go to the one review that starts after your next plain message and its turn end. A slash
  command does not end the wait. A review already open runs on and settles as usual.
- **A review refused after an Esc.** If Claude Code refuses a review's brief with the same stopped-session reply, for
  example after an Esc while the agent was idle, the review is given back rather than failed: it is logged incomplete
  with the reason `given back: the session was stopped`, its entries wait for the next review, the reviewer stays, and
  `auditor failing` does not show.
- **A review that never finishes.** If the reviewer never ends its turn, because it died, was killed from the agent
  list or hangs, the review is given up at the next turn end of the agent more than 10 minutes after it was
  dispatched (the longest review logged took 150 seconds): `auditor failing` shows, with the cause `the reviewer did
  not finish in 10 minutes`, the review is logged incomplete with the reason `reviewer did not finish in 10 minutes`,
  its entries wait for the next review and the reviewer is stopped. Until that turn end the footer still reads
  `auditor on`. The next turn that starts from your own prompt spawns a fresh reviewer, and its first successful
  review clears the failure.
- **Nothing else.** Beyond those rows, a review that finds nothing leaves no trace on screen, and neither do the
  reviewer's end-of-run notices or task rows. Two things reach you: an escalation of an unresolved disagreement, as a toast and as a push
  notification on your phone when you are away from the terminal (Claude Code holds it back while you are at it), and
  the toggle reading `auditor failing` while reviews fail, until one succeeds, with the cause in the popup and the raw reason in the debug log. In an
  interactive session without agent teams (measured on Claude Code 2.1.312), the reviewer's hand-back arrives as a
  prompt and is dropped there, and Claude Code shows `Prompt dropped by a hook: reviewer bookkeeping`.

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
  needs. The button shows what the reviewers have spent: every response of every reviewer this session spawned, and each
  compaction of a reviewer's own conversation, priced at Haiku 5.5's API list prices whatever your billing (a
  subscription pays no such amount; the figure is what the same tokens cost on the API), and its share of the session's
  cost, the figure `/cost` totals. The count starts at zero when the session or the conversation begins (`/clear`
  included, which starts a new conversation) and each time the auditor is switched on, and switching it off empties it.
  It keeps counting while the auditor is `failing`. The `log` setting records each review's token use, if you want
  per-review figures.
- **A fresh reviewer.** One reviewer serves the session and remembers its earlier reviews. Once its context passes
  80,000 tokens, which keeps it under Haiku's higher price tier, the next review goes to a fresh reviewer; every
  brief, a fresh reviewer's included, carries the reviewer's memory of the notes delivered, and it finds your
  instructions again in the transcript. A fresh reviewer carries none of the old one's own reading of the session,
  only the notes in its memory, which keeps its judgement independent. The memory also records the disputes the
  reviewer settled, where the agent countered a finding and the reviewer had no new evidence, so a later reviewer does
  not raise a settled finding again without new evidence. The memory is the reviewer's own, never sent to the agent:
  it is bounded in size and age, reset on `/clear` and on switching on, and kept while the auditor is off. A reviewer is
  also stopped once it has sat idle for five minutes, the life of its prompt cache: after that a brief would only
  re-write its whole context, where a fresh reviewer writes just its prompt and the brief, so the next review starts
  fresh with the memory. A dispatch within the five minutes keeps it. The retired
  reviewer is stopped, so it does not stay idle for the rest of the session. So is a reviewer forgotten on a `/clear`,
  one whose brief was refused, one whose spawn failed after it was named, one whose review never finished (see above),
  one whose review failed (its turn ended with no answer or an error, or its brief could not be delivered; a turn you
  aborted with Esc is not one, and keeps its reviewer), or one the toggle switched off. A session
  that is exiting (`/exit`, ctrl+c, ctrl+d, or a `-p` run that finished) ends the reviewer with it, so no stop is
  attempted then. Each stop is checked against Claude Code's agent list, without holding anything up: a stop that was
  refused, or after which the list still shows the reviewer not ended, is issued once more, and a reviewer that
  survives both is named as left running in the debug log. A stop Claude Code answers with "No task found" means the
  reviewer is already gone: it is not issued again and the reviewer is not named as left running. A session end issues its one stop and does not check it.
  Should one review alone outgrow 100,000 tokens, the reviewer compacts, keeping your instructions and
  where you gave them.
- **What the reviewer reads.** A record of the agent's turns since the previous review: your prompts, the agent's
  replies and every tool call with its result. The review's brief also lists the paths the record edits: one line,
  each path once in the order it was first edited, at most 20, with a count of any left out. It lists only what the
  `Edit`, `Write` and `NotebookEdit` tools wrote, from calls that succeeded, so a file changed through a shell command
  is not on it. The reviewer also reads files on disk, and it can search the whole session's transcript to find an
  instruction you gave many turns ago. Search results come back as short snippets around each match, and a whole
  transcript line only when the reviewer asks for it.
- **Setting.** `log` (default off) writes one JSON file per review, with its note, timing and token use, to
  `~/.claude/auditor/<session id>/`; a review that did not complete is logged too, with its reason. The file also says
  whether the review's brief told the reviewer that nothing will wake the agent (`nothing_wakes`), whether the review
  had its follow-up (`followed_up`), and where the brief went (`brief_to`): `stored` for the reviewer already running,
  or `spawn:` with why, either `no reviewer yet` or the reason the last reviewer was let go (`rotation`, `switch off`,
  `session end`, `refused brief`, `stale landing`, `rejected spawn`, `lapsed`, `failed review`, `reaped idle`). `brief_to` is null for a review given back, or
  whose dispatch failed before its brief went out, since its brief did not reach a reviewer. It is declared under
  `userConfig` in `.claude-plugin/plugin.json`.

## The stall nudge

Sometimes the agent ends a turn with work it said it would do still undone, or waiting on a shell or subagent that has
already finished. Nothing then wakes it, and it sits idle until you type something. When nothing is in flight to wake
the agent, the reviewer is told so, and it may send a note opening `Stalled:`, which wakes the idle agent like any
other note.

- **What counts as in flight.** A subagent or teammate that is working or waiting on its own work, or one the agent messaged in the turn
  whatever its status; a shell, a monitor or another background task; or a scheduled wake-up. An idle, finished,
  failed or killed agent does not count, nor does the reviewer's own, even one whose id the plugin has not learned yet, and "nothing in flight" is exact. The limit: a
  teammate in a terminal pane of its own that has died still reads as working, so no nudge comes for it.
- **No nudge** when the agent's own last tool call asked you something (`AskUserQuestion`, or filing a human-plugin
  item), when the turn ended aborted, when the agent itself sends a broadcast in its turn (a `SendMessage` to `*` names
  no agent, so that turn gets no stall verdict at all), or when a stall note on a review dispatched since your last prompt
  already reached the agent. So one stall gets one nudge; your next prompt, `/clear` or the toggle re-arms it. A stall
  note from a review whose brief did not say nothing will wake the agent is refused, and never reaches it.
- **The limit.** The reviewer judges the wording of the last turn, so it can miss a stall, and it can flag one that is
  not. Only the guards above are mechanical.

## Known limits

- A review takes minutes, so a note can land a turn or two after the step it is about.
- `/clear` starts a new transcript, so the reviewer cannot find instructions given before it, just as the agent has
  lost them.
- The share is the reviewer's count over the session's cost, and the count restarts when the auditor is switched on
  while the session's cost does not, so after time off the share reads lower than the reviewer's share of the spend
  since it came back on.
- The session's cost counts the agent's own subagents and the teammates that run inside the session. A teammate in a
  terminal pane of its own is a separate session with its own cost, which the share does not include.
- A response of a reviewer that lands before the plugin has recorded the reviewer's id is not counted. None was seen
  in eight reviewers spawned while measuring it.
- The prices are written into the plugin for the reviewer's model. A change to Anthropic's list prices reaches the
  figure only when the plugin is updated, and a `modelPricing` setting that changes what `/cost` charges does not
  change it.
- A plugin reload while a reviewer sits idle cancels the timer that would stop it. That reviewer stays until its next
  review settles and starts a new timer, or a `/clear`, a switch or the session end lets it go.
- A plugin reload between a stop and its check loses the check; the reviewer was still stopped once.
- The footer redraws when the auditor's own count moves, which it does at every reviewer response, and the session's
  cost is read at each redraw. Between redraws the share can lag the session's cost, which `/auditor` always reads
  fresh.

## Development checks

From the repository root, after the plugin has loaded once (Claude Code writes the type declarations that `tsc`
needs into `.claude-plugin/types/` on first load):

```bash
claude plugin validate mods/auditor
tsc -p mods/auditor --noEmit
claude plugin test mods/auditor
```
