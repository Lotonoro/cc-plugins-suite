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
At the end of a turn, a persistent Haiku reviewer checks the main agent’s
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

**Read-only access to project files.** The reviewer’s tools are limited to
inspecting files and the transcript, updating its own findings memory, and
sending notes. The main agent handles any edits.

## Token cost

Auditor runs the reviewer on Haiku at high effort. Reviews under 100,000
prompt tokens use the standard tier. On a warm review, reused context is
priced as cache reads at one-tenth of Haiku’s standard input rate in
Auditor’s pricing table.

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
the session total. The estimate uses Haiku API list prices for new input,
output, cache reads and writes, and reviewer compaction requests.

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
  use, and notes. `/clear` starts a new transcript and resets the reviewer’s
  memory.

For implementation details, see the [reviewer’s instructions](hooks/prompt.ts),
[review dispatch](hooks/register.ts), [finding memory](hooks/memory.ts),
and [usage accounting](hooks/pricing.ts).
