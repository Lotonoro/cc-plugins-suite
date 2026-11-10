# human-plugin

A to-do list for you, kept by the agent. When a coding agent needs something from you (a PR approved, a command
run, a decision made), it tends to restate the ask every turn, because the terminal scrolls it out of sight.
human-plugin gives the agent a list it owns: each ask is filed once, pinned above your prompt, and removed by the agent
as soon as it no longer applies.

## What you see

```
To do for you 3 open
  #4 Approve PR #163 on GitHub [✓]
  +2 more […]
```

- **The band above your prompt** appears whenever the agent needs something from you. Blocking items, meaning some of the agent's
  work is stuck until you act, come first, one row each. A chime (macOS only) plays when one arrives, and when the agent marks
  an open item blocking because its work has come to wait on it. Then come the rest, by item number, while the rows last. When
  they don't all fit, the last row summarises what is left out: `+N blocking` for the blocking items and `+N more` for the
  others. The header turns amber while anything blocking is open, so its colour alone tells you whether any of the agent's work
  is stuck. The header reads `To do for you` until the agent states the term it uses for you, and then `To do for` followed by
  that term. A blocking ask is also pushed to your phone, and while you are at the terminal the push is retried each minute, for an hour at most, until it is sent.
- **A row is one line.** The item number, the title and the control share one line, the control one blank after the title. A title too long for its line is cut at its end with `…`
  to leave room for the control at the widest it gets, and a line break in a title reads as a space; a choice keeps its `[…]` after the cut title. That room is reserved at the control's
  widest state, so a press, an undo and the end of the three seconds move nothing: the control starts on the same column through all of them. A pressed answer's text shows up to 24 columns;
  where the title would keep under ten columns it is cut further with `…`, and where cutting it is not enough the pressed control shrinks to `✓ [↶ 3s]` (`✗` for a no) and the answer is in the pane.
  Under 15 to 18 columns (by the id's digits) a row shows its number and title only, its controls in the pane, which its title opens; under 6 to 9 columns it shows its title alone.
  A list beside the Claude column and one that has the whole band do the same, except that a list under 64 columns beside the column, which happens only while this plugin's pane is open and docked (see The Claude TODO column), is squeezed:
  every pressed control, a reply included, is `✓ [↶ 3s]` from the start, and its header is the chip on one line with the count under it, each cut at the list's edge. When the band is too short for
  both lines and a row, the header is the chip alone, and a band too short for any row draws its header alone. The summary row is one line too, cut at the list's width with `…`.
- **`[✓]`** says you've done it. You get three seconds to change your mind (`[↶ 3s]`; the window ends on the
  countdown's next one-second tick, so up to a second later), then the agent is told, checks, and removes the item. You can also say so in chat. Only the agent removes items, because it is the one that knows
  when an ask is settled; when it adds to a sent item instead, the item comes back open, with its reply field, marked `•`. A choice (a decision with options) gets answer buttons in the pane instead (see below).
  A to-do the agent files with a `done` label, such as `Go with sqlite`, draws `[✓ Go with sqlite]`, and that press is
  what the label says. A label is at most 24 columns (a wide character takes two; a joined emoji such as a family or a flag counts as the wider of what Claude Code lays out and what the terminal draws, two columns where they agree). A bare `[✓]` on a proposal or a
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
  the shown item again to close the pane. When the item you are shown is removed, or its answer is sent, a reply included, the pane moves to the next open item, and closes when none is left. An agent follow-up on an item the pane has left shows as its `•` mark in the band, and a press on its title shows the item again, with its reply field. A decision comes as a brief: the
  question, the agent's recommendation, the options with their costs, and the context. The pane draws any table in a brief as a list, so it fits the narrow pane. Each fenced block (backtick or tilde) in a brief has a `[copy]` button under it that puts just that block's lines on your clipboard, with no frame characters; a toast says whether it took. A fence gets no button when it is inside a block quote, when it is indented four or more columns past its list item's text, or when it is four or more columns from the margin under a list item whose wrapped line is not indented. Ask for more and the agent adds
  to the item (to the brief, or to the thread once you have answered) instead of burying the answer in chat.
- When the agent works out the answer itself, it tells you why in one line.
- **`/asks` and `/asks <n>`.** `/asks` prints the list as text: the open items first, then the answered ones, blocking first in each group, an answered item with its answer, and an item still in its undo window marked as still undoable. `/asks <n>` prints one item, with its note, brief, thread and, for a choice, its options numbered, and ends with the forms that answer it: `/asks <n> done` for a to-do, `yes` and `no` for a yes/no, `1-<k>` for a choice's k options, and `reply <text>` for any open item. Typing one answers the item as its button or the reply field would, with the same three seconds to change your mind, and the command confirms it with `answered #<n> with` the answer. An item in its undo window or already sent takes no answer. The print is cut at 4,000 characters when the item runs longer, with a line that says so; the forms at its end are never cut. Both run during a turn too.
- **The Claude TODO column.** On a wide terminal the agent's own list (see The Claude TODO list below) draws as a column at the right of the band, beside the list above, which keeps its place at the left. The column has a header, `Claude TODO` and its counts (`2 active, 3 queued`; active is the step the agent is on), and a row for each step: `◐` for one in flight, `○` for one queued, then its title on one line, cut at the column's edge. Every in-flight step has a row, however many. Queued steps fill the rows that are left, down to the height of the list above, and when they do not all fit the last row says `+N queued`. The column is a third of the band, at least 32 columns wide, and the list above takes the rest, so both draw when the band is 96 columns or wider (a terminal of about 101 columns or more, with no pane docked), or 52 columns or wider beside this plugin's own docked pane, where the band is the transcript's column: the column's 32 and a list of 20. When both draw, each keeps one column of its width empty on the side that faces the other, so two blank columns separate their text, and the column's header and rows are cut one column short of its width; a list that draws alone uses all of its width. Under that width the column hides and the list above takes the whole width; another plugin's docked pane is not recognised, so beside it the 96 holds. With no asks for you, the column draws alone at the right edge while a step is in flight, and nothing draws when none is. With asks for you and nothing on the agent's list, there is no column; it first appears when the agent writes a step. When many steps are in flight and the band outgrows its room, the band scrolls as one, and the summary row of a folded list above stays in view at the top. Its header, each row and `+N queued` can each be pressed, and a press on any of them opens the Claude TODO pane (next).
- **The Claude TODO pane.** A press on the column's header, on a row or on `+N queued` opens the side pane on the whole list, the steps `+N queued` stands for included: a header line, `Claude TODO` and the counts in the long form (`Claude TODO 2 in flight, 3 queued`), then the steps in flight and the steps queued, each group in the order the agent wrote it, and each step one line: `◐` or `○`, a space, its title, then ` · ` and its ETA drawn dim (`◐ Run the tests · ~10 min`; `no ETA` when the agent gave none). A title too long for the line is cut at its end with `…`, before the ETA, which stays whole while the title can keep ten columns beside it, and past that the ETA is cut with `…` (or left out where no character of it fits); `/claude-todo` still prints the title and the whole ETA. A list taller than the pane scrolls with the pane's keys. The pane is read-only, since only the agent changes the list: it has no button. There is one pane, so the list takes the place of the item it was showing, and a press on an item's title, or on the summary row, puts that item there again; a press on the column while the pane shows the list closes the pane. The pane follows the agent's writes: new steps appear, and when the list is emptied the pane closes. It closes as well when the session ends, since a resume rebuilds the list from its transcript. Changes to the list above, an item removed or an answer sent, leave the pane on the list. Showing the list reads none of your items, so their `•` marks stay. Beside this plugin's docked pane the column stays from a band of 52 columns (see above), so the press that switches the pane, or closes it, is there. The pane's title, `Claude TODO`, is drawn only when another plugin's pane makes tabs.
- **`/claude-todo`.** Prints the agent's own list (see The Claude TODO list below) as text: a first line that counts it (`Claude TODO: 2 in flight, 3 queued`), then the in-flight steps under `in flight:` and the queued ones under `queued:`, each group in the order the agent wrote it and each step as `◐` (in flight) or `○` (queued), its title, ` · ` and its ETA (`◐ Run the tests · ~10 min`; `no ETA` when the agent gave none). A group with no steps prints no heading, and an empty list prints one line saying so. It names at most 20 steps, in-flight first, with a last line that counts the ones left out (`and 3 more in flight, 12 more queued`), and a title is cut to at most 80 characters (an ETA is printed whole). It takes no argument and runs during a turn too. It is how the list is read on a phone, which draws no band or pane.

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
  your prompt also shows in your transcript as a dim line, `sent to Claude: …`, which the agent never reads; a phone prompt's block is the one thing read beside your prompt that does not show.
  When the agent adds to a sent item (an append, or an update that sets a title, brief, blocking mark, options, note or label), the item comes back open, with its reply field, marked `•`; a change that only clears a field does not reopen it. A change made during the three seconds leaves them running, and your press is sent as given; when they end, the item comes back open, your answer first in its thread and any append made then after it. If you undo instead, the change stays on the item, which does not reopen.
- **Survives compaction and resume.** `claude --resume` rebuilds the list from the session's transcript, subagents
  included, and leaves out anything on a branch that `/rewind` abandoned. `/clear` empties the list. Item numbers
  are never reused.
- **The Claude TODO list.** The agent also keeps a list of its own work through a second tool, `claude_todo`: the step it is on (`in_flight`) and the steps queued after it (`queued`). Each call gives the whole list, and a step that is done leaves it at once. Only the main agent keeps it; a subagent's call is refused. A title is a few words on one line, at most 80 characters. Each step also carries an ETA, short text of at most 30 characters such as `~10 min` or `after tests`; a step the agent gives none shows `no ETA`, and an ETA is never refused: one that is blank or not text is stored as `no ETA`, one over 30 characters is cut with an ellipsis to at most 30, never splitting an emoji or taking a letter from its accent, and one on more than one line is joined onto one line. The band's column does not draw the ETA; the pane and `/claude-todo` do. Asks of you never go on it: they go on the list above, filed once. You read it in the column at the right of the band on a wide terminal, in the pane a press on the column opens, or with `/claude-todo`. Each call shows in the transcript as one line (`human-plugin: Claude TODO 2 in flight, 3 queued`), and the agent can read the list back: the answer to a write, as to a read, lists each step with its ETA as stored. `claude --resume` rebuilds it from the session's transcript, in the same pass as the list above, as the last write that was live and succeeded gave it; a list the agent has already written in the resumed session is kept as written. After 50 tool calls with no write, the agent is reminded once, unseen, to bring the list up to date. `/clear` empties it.
- **Transcript rows.** The agent's calls to the list show as one line each (`human-plugin: added #4 …`), not as the
  raw call.
- **Restatement check.** At the end of a turn the mod checks the agent's closing reply for an open item's ask restated
  without naming any listed item's id. On a catch it leaves the agent one short note, at most once per item, which you see as a dim `sent to Claude: …` line.
  The check starts no turn.
- **Phone prompts.** A prompt sent from a Remote Control phone tells the agent that you cannot see the list, so it ends its reply by naming the open items.

## Known limits

- The restatement check is a heuristic. It reads only the reply's last message, after the final tool call. It misses a
  paraphrase, a recap that puts no ask to the reader, and a block that names any listed item's id. It can mistake a block about an item's
  subject for an ask, at the cost of one extra note. A resumed conversation can note an item once more.
- A resumed conversation orders an item's change before the notice that preceded it in time, so an item the agent changed after your reply but before the agent read the reply comes back sent, and a second reply you sent from the reopened item in that gap is not rebuilt. An addition made in that gap comes back in the brief if you had not answered the item before, and otherwise as an agent turn ahead of your reply. The agent's next change to the item, or removing it, settles it.
- The Claude TODO column hides under 96 columns, so in a narrow terminal, or beside another plugin's docked pane, which is not recognised, it can be hidden while the agent's list is not empty, and then no press opens the pane on it; `/claude-todo` still prints it. Beside this plugin's own docked pane it draws from 52 columns, with the list above squeezed under 64.
- A session that enables the plugin partway through may keep asking in chat until a `/clear` or a new session.
- `/rewind` inside a running session does not rewind the list, because Claude Code gives a plugin no signal that a
  rewind happened. The agent can still remove what no longer applies, and a resume rebuilds the list correctly.
- `/rewind` inside a running session, and a fork made after a compaction, affect the Claude TODO list as they do the list above: it is not rewound, and a fork carries only the writes the copied transcript holds.
- A session forked with `--fork-session` after a compaction starts from that compaction, so items filed before it
  are not carried over. No fork carries over items its subagents filed.
- A forked session whose transcript is not yet written at session start is rebuilt at its first turn, so until then `/asks`, and the agent's tool, can show an empty or partial list.
- A done press that arrives just as a turn starts relies on Claude Code's documented handling of a row appended to a
  running turn, which has not been observed live; if it differs, a done press that lands as a turn starts is read one
  model request later, never lost.
- Tested on the terminal only: the desktop app is untested, though it draws the reply field too. A Remote Control phone draws no band or pane, so there the list is read through `/asks`, and the Claude TODO list through `/claude-todo`. The chime plays on macOS only.
- The band's `To do for <term>` chip never shrinks while it fits, and a term of up to 20 columns makes it up to 32 columns wide with its spaces. The count beside the chip wraps in the columns the chip leaves, and the header takes as many lines as that needs.
  In a squeezed list (under 64 columns beside the Claude column), and in any list narrower than its chip and one column, the chip is cut at the list's edge instead, so a long term loses its end,
  and its count is on the line below, cut the same way; when the band is too short for both lines and a row, the header is the chip alone and the count is left out.
- Joined emoji are counted from sequences measured in tmux 3.8 and Claude Code 2.1.311, so a sequence newer than Unicode 18.0 counts as its parts until it is measured. Under tmux 3.8 most emoji with a skin tone draw wider than Claude Code places them, so the text after one can be drawn over its end. A joined sequence Claude Code lays out wider than the terminal draws leaves a blank after it. A digit or `*` with a keycap mark and no U+FE0F counts two columns, a guess measured only on `#`.
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
