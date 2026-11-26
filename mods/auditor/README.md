# auditor

**Supreme judge, billing at Haiku rates.**

Agentic workflows commonly validate a coder’s output with tests and code
review. The costliest mistakes can happen upstream. One skipped check or a
wrong turn by the orchestrator can leave an entire team redoing its work.
The evidence lives in the session transcript, which rarely gets its own
review. Auditor reviews the main agent while the session runs, whether it
does the work directly or coordinates other agents.

## How it works

Auditor treats the session transcript as a work product in its own right.
At the end of a turn, a persistent reviewer checks the main agent’s
decisions, tool calls, and results against your instructions, standing rules,
global processes, and the active plan. It can look up earlier turns or
inspect files on disk for evidence.

The review covers both the agent’s process and the code it changes. For
example, it can flag an agent that says it will write tests first, then
starts with the implementation, or reports that all checks passed when only
some ran.

Reviews run alongside the session, so feedback can reach the main agent
within a turn or two, while the work is still fresh. The reviewer sends one
short, actionable note tied to the work already underway, so the agent can
correct course with little extra context. An idle agent can act on it
immediately. A busy agent reads it after its current turn.

If the main agent disagrees with a correction, it will explain why in its next
turn. The reviewer reads that reply in the transcript and can drop a mistaken
finding after a single exchange. It can also nudge a stalled agent or escalate
a disagreement that persists.

**A nudge when the TODO list is left open.** If the main agent stops with
entries still open on its TODO list and nothing in flight to wake it, Auditor
asks it to carry on, to mark the entries done, or to say in one line what it
is waiting on. The list is the one human-plugin keeps, so without
human-plugin Auditor does nothing here. The ask fires at most once per user
prompt, and not while the agent’s last step was a question to you or a
human-plugin item for you may still be open and blocking. In the terminal it
shows as a `Stop hook feedback: auditor: …` row, not as an error. It was not
shown on the phone’s web view, so a reply there may answer a question you never
saw. `/auditor off` silences it along with the reviewer.

**Read-only access to project files.** The reviewer’s tools are limited to
inspecting files and the transcript, updating its own findings memory, and
sending notes. The main agent handles any edits.

## Token cost

Auditor runs the reviewer at high effort, on Haiku unless you choose another
model with `/auditor model`. On Haiku, reviews up to 100,000 prompt tokens use
the standard tier. On a warm review, reused context is priced as cache reads
at one-tenth of Haiku’s standard input rate in Auditor’s pricing table.

- **Read the new work.** A review starts with a short brief and fetches the
  activity since the previous review in pages. The reviewer looks up older
  transcript entries as needed. Turns that finish during a review are batched
  into the next one.
- **Reuse the warm cache.** A reviewer stays around between turns so later
  reviews can reuse its prompt cache. After five minutes idle, the cache
  expires and Auditor retires the reviewer. Starting fresh avoids rewriting
  its accumulated context.
- **Leave room below the higher price tier.** Auditor rotates a reviewer
  whose context passes 80,000 tokens to leave headroom below that threshold.
  A replacement gets a compact record of earlier findings so it can pick up
  where the previous reviewer left off.

The footer and `/auditor` show estimated review spend and its share of
the session total. The estimate prices each review at its own model’s API
list prices, for new input, output, cache reads and writes, and for reviewer
compaction requests.

The priced models are those the claude-api skill’s model table listed when
the rates were taken, on 2026-11-18. A review on any other model leaves the
cost unknown: the footer drops its figures and `/auditor` says
`cost unknown`, naming the model, until you switch Auditor off and on again
or run `/clear`. A price tier a model gains later is followed only once its
rates are taken again.

## Get started

Run this at a Claude Code prompt, then start a new session.

```text
/plugin install auditor --marketplace Lotonoro/cc-plugins-suite
```

To try a local clone for one session, run `claude --plugin-dir mods/auditor`
from the repository root.

## Use it

- **Check status and cost.** The footer shows whether Auditor is on, off, or
  failing. Hover for review counts, recent activity, and estimated cost. Run
  `/auditor` for the same information on surfaces without the footer.
- **Toggle it.** Click the footer label or run `/auditor on` or `/auditor off`
  to control the current session. Each new session starts on while the plugin
  is enabled.
- **Inspect findings.** Run `/auditor memory` to see the reviewer’s notes and
  which findings are still open or settled. Enable the plugin’s `log` option
  to write per-review JSON under `~/.claude/auditor/`, including timing, token
  use, the reviewer’s model, notes, and the reviewer the brief reached
  (`briefed_id`). It also counts the reviewer turn ends that arrived while the
  review was open but did not close it: `unmatched_former` for a reviewer the
  plugin had already let go, `unmatched_let_go` for the current reviewer, found
  let go as its turn end was settled, and `unmatched_last` for the last two,
  with agent and time. A review given up after its 10 minutes also logs how
  long it really ran (`lapse_age_ms`), when that was found
  (`lapse_detected_at`), the reviewer held for it and its status in the agent
  list then (`lapse_held_id`, `lapse_held_status`), and up to three Auditor
  reviewers in the list that the plugin had no record of
  (`lapse_unknown_spawns`, with their total in `lapse_unknown_spawns_total`),
  which may belong to another conversation. `/clear` starts a new transcript
  and resets the reviewer’s memory.
- **Choose the reviewer’s model.** Run `/auditor model` to list the choices and
  `/auditor model <name>` to set one. The choices are `haiku`, `sonnet`,
  `opus`, and `fable`, plus the model ids `/model` lists, narrowed by your
  `availableModels` setting. The list marks the current choice, the default
  (Haiku, unless `availableModels` rules it out), each Fable, and
  `cost unknown` beside a model Auditor has no price for.
- **Switch mid-session.** A switch applies from the next review; one in
  progress finishes on its old model. The choice survives `/auditor off`,
  `/auditor on` and `/clear`. A new session starts on the last model set in
  any session.

For implementation details, see the [reviewer’s instructions](hooks/prompt.ts),
[review dispatch](hooks/register.ts), [finding memory](hooks/memory.ts),
and [usage accounting](hooks/pricing.ts).
