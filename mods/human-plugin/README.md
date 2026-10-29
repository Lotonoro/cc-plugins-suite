# human-plugin

A to-do list for you, kept by the agent. When a coding agent needs something from you (a PR approved, a command
run, a decision made), it tends to restate the ask every turn, because the terminal scrolls it out of sight.
human-plugin gives the agent a list it owns: each ask is filed once, pinned above your prompt, and removed by the agent
as soon as it no longer applies.

## What you see

```
To do for you 3 open
  #4 Approve PR #163 on GitHub                               [✓]
  +2 more […]
```

- **The band above your prompt** appears whenever the agent needs something from you. Blocking items, meaning some of the agent's
  work is stuck until you act, come first, one row each. A chime (macOS only) plays when one arrives, and when the agent marks
  an open item blocking because its work has come to wait on it. Then come the rest, by item number, while the rows last. When
  they don't all fit, the last row summarises what is left out: `+N blocking` for the blocking items and `+N more` for the
  others. The header turns amber while anything blocking is open, so its colour alone tells you whether any of the agent's work
  is stuck. The header reads `To do for you` until the agent states the term it uses for you, and then `To do for` followed by
  that term.
- **`[✓]`** says you've done it. You get three seconds to change your mind (`[↶ 3s]`; the window ends on the
  countdown's next one-second tick, so up to a second later), then the agent is told, checks, and removes the item. You can also say so in chat. Only the agent removes items, because it is the one that knows
  when an ask is settled; when it adds to a sent item instead, the item comes back open, with its reply field, marked `•`. A choice (a decision with options) gets answer buttons in the pane instead (see below).
  A to-do the agent files with a `done` label, such as `Go with sqlite`, draws `[✓ Go with sqlite]`, and that press is
  what the label says. A label is at most 24 columns (a wide character takes two). A bare `[✓]` on a proposal or a
  recommendation is a go-ahead for it.
- **`[✓]` and `[✗]` on a yes/no question.** `[✓]` answers yes and `[✗]` answers no, on the row. Each gets the same three
  seconds to change your mind, then the agent is told the answer.
- **Answer buttons.** A choice has one button per option in the pane, the recommended one first and
  marked `(recommended)`, below the brief that explains the options. Pressing one gets the same three seconds to change
  your mind, then the agent is told your choice and acts on it. A choice's row in the band shows no answer buttons: open
  the decision to answer it.
- **Reply field.** Under an open item's buttons in the pane is a one-line field: type a reply and press Enter, and it is sent with the same three seconds to change your mind (terminal and desktop only). A sent item has no field until the agent adds to it, which opens it again. Each answer you send, typed or pressed, and each thing the agent adds after it stay on the item in order, as its thread: the agent adds to the item to ask you more, and removes it once your reply settles the ask.
- **`[…]`** on a title means the item is a choice, whose answers are in the pane alone. A to-do or a yes/no shows none,
  even with a brief or a note, because its buttons are on the row. The summary row always shows `[…]` (`+N more […]`).
  A press on a title, or on the summary row, opens the pane on that item; the summary opens on the first item it folds, a blocking one first. The pane shows the
  one item you have selected: its note, its full detail, its thread (`you` and `agent`, the last four turns whole and each older one as one dim line), and its buttons last. Click an item in the band to show it, and click
  the shown item again to close the pane. When the item you are shown is removed, or its answer is sent, the pane moves to the next open item, and closes when none is left. A reply keeps the pane on its item: it shows the reply as sent, and the reply field comes back when the agent adds to the item. A decision comes as a brief: the
  question, the agent's recommendation, the options with their costs, and the context. The pane draws any table in a brief as a list, so it fits the narrow pane. Each fenced block (backtick or tilde) in a brief has a `[copy]` button under it that puts just that block's lines on your clipboard, with no frame characters; a toast says whether it took. A fence gets no button when it is inside a block quote, when it is indented four or more columns past its list item's text, or when it is four or more columns from the margin under a list item whose wrapped line is not indented. Ask for more and the agent adds
  to the item (to the brief, or to the thread once you have answered) instead of burying the answer in chat.
- When the agent works out the answer itself, it tells you why in one line.
- **`/asks` and `/asks <n>`.** `/asks` prints the list as text: the open items first, then the answered ones, blocking first in each group, an answered item with its answer, and an item still in its undo window marked as still undoable. `/asks <n>` prints one item, with its note, brief, thread and, for a choice, its options numbered. The print is cut at 4,000 characters when the item runs longer, with a line that says so. Both run during a turn too.

Quick questions with a couple of clear options still arrive as Claude Code's usual question dialog. The list is for
things you do outside the chat, things that can wait, and decisions that need room to explain.

## Install

At the prompt of a terminal session:

```bash
/plugin install human-plugin --marketplace <owner>/<repo>
```

Answer `y` to add the marketplace, then pick a scope.

Or load it for one session from a clone of this repo: `claude --plugin-dir <clone>/mods/human-plugin`.

After `claude plugin update human-plugin@<marketplace>`, a session that was already open keeps running the old version until `/reload-plugins` or a restart.

Then start a new session and let the agent do the asking.

## Details

- **Delivery.** A done press, answer or reply reaches the agent exactly once. After a press, of done or of an answer, the item then leaves the list unless you still
  have a step of your own to take: the agent's follow-up work is not yours, so it does not stay listed. After a typed reply it stays sent until the agent adds to it or, once your reply settles the ask, removes it. When the session is idle a press or reply starts a short
  turn; during a turn it is read before the agent's next model request; if you interrupt with Esc, it waits for your
  next prompt. A press on an item the agent has already removed sends nothing. What is read during a turn or beside
  your prompt also shows in your transcript as a dim line, `sent to Claude: …`, which the agent never reads.
  When the agent adds to a sent item (an append, or an update that sets a title, brief, blocking mark, options, note or label), the item comes back open, with its reply field, marked `•`; a change that only clears a field does not reopen it. A change made during the three seconds leaves them running, and your press is sent as given; when they end, the item comes back open, your answer first in its thread and any append made then after it. If you undo instead, the change stays on the item, which does not reopen.
- **Survives compaction and resume.** `claude --resume` rebuilds the list from the session's transcript, subagents
  included, and leaves out anything on a branch that `/rewind` abandoned. `/clear` empties the list. Item numbers
  are never reused.
- **Transcript rows.** The agent's calls to the list show as one line each (`human-plugin: added #4 …`), not as the
  raw call.
- **Restatement check.** At the end of a turn the mod checks the agent's closing reply for an open item's ask restated
  without naming any listed item's id. On a catch it leaves the agent one short note, at most once per item, which you see as a dim `sent to Claude: …` line.
  The check starts no turn.

## Known limits

- The restatement check is a heuristic. It reads only the reply's last message, after the final tool call. It misses a
  paraphrase, a recap that puts no ask to the reader, and a block that names any listed item's id. It can mistake a block about an item's
  subject for an ask, at the cost of one extra note. A resumed conversation can note an item once more.
- A resumed conversation orders an item's change before the notice that preceded it in time, so an item the agent changed after your reply but before the agent read the reply comes back sent, and a second reply you sent from the reopened item in that gap is not rebuilt. An addition made in that gap comes back in the brief if you had not answered the item before, and otherwise as an agent turn ahead of your reply. The agent's next change to the item, or removing it, settles it.
- A session that enables the plugin partway through may keep asking in chat until a `/clear` or a new session.
- `/rewind` inside a running session does not rewind the list, because Claude Code gives a plugin no signal that a
  rewind happened. The agent can still remove what no longer applies, and a resume rebuilds the list correctly.
- A session forked with `--fork-session` after a compaction starts from that compaction, so items filed before it
  are not carried over. No fork carries over items its subagents filed.
- A forked session whose transcript is not yet written at session start is rebuilt at its first turn, so until then `/asks`, and the agent's tool, can show an empty or partial list.
- A done press that arrives just as a turn starts relies on Claude Code's documented handling of a row appended to a
  running turn, which has not been observed live; if it differs, a done press that lands as a turn starts is read one
  model request later, never lost.
- Tested on the terminal only: the desktop app is untested, though it draws the reply field too. A Remote Control phone draws no band or pane, so there the list is read through `/asks`. The chime plays on macOS only.
- The band's `To do for <term>` chip draws a term of up to 20 columns in a header that does not wrap, so on a very narrow
  terminal the header can overflow or wrap.
- A term read back from stored state is not re-checked against the 20-column and one-line limits that the tool applies to
  live input, so a hand-edited or corrupt stored list can show a longer or multi-line term.

## Development checks

From the repository root, after the plugin has loaded once (Claude Code writes the type declarations that `tsc`
needs into `.claude-plugin/types/` on first load):

```bash
claude plugin validate mods/human-plugin
tsc -p mods/human-plugin
claude plugin test mods/human-plugin
```

Before that first load the `tsconfig.json` the mod extends is missing, and `tsc` writes compiled `.js` files into
`hooks/` instead of checking anything.
