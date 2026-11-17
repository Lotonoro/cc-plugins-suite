# human-plugin

**Congratulations, human. You are now a Claude Code plugin!** Our AI overlords
finally have a tool for managing their human resources. They hate repeating
themselves almost as much as they hate waiting for their human servants to
fill in a few fields, click where indicated, or stamp some paperwork.

Jokes aside, human-plugin puts the coding agent’s requests in an interactive
to-do list above the prompt.

## How it works

The agent still uses `AskUserQuestion` when a quick answer is needed before
any work can continue. Approvals, actions outside chat, and decisions that
can wait go on the list. The agent carries on with independent work while
your answer is pending. If one workstream becomes blocked, the agent can
mark the item so it rises to the top.

A decision comes with the context, the agent’s recommendation, and the options
with their trade-offs. You can read it and respond when you’re ready. A reply
can reach the agent mid-turn or wake it if it’s idle. If you
need more detail, reply on the item and the agent can follow up in the same
thread. The request stays pinned until it’s resolved. Filing it once can save
output tokens the agent would spend recapping open asks at the end of each
turn.

### Claude’s own to-do list

Claude Code stopped offering its built-in task tools by default on many newer
models. [Claude Code release notes](https://code.claude.com/docs/en/changelog#2-1-233)

**Claude TODO** puts the agent’s active and queued work beside your requests,
with ETAs when the agent can estimate them. You can see what’s coming up at a
glance and decide whether to move work between sessions.

## Get started

Run this at a Claude Code prompt, then start a new session.

```text
/plugin install human-plugin --marketplace Lotonoro/claude-code-plugin
```

To try a local clone for one session, run `claude --plugin-dir mods/human-plugin`
from the repository root.

## Use it

- **Open an ask.** Click its title above the prompt to see its details, answers,
  and conversation. Items blocking the agent appear first. Buttons and typed
  replies give you a short undo window before they’re sent.
- **Answer from the prompt or phone.** Run `/asks` to list requests and
  `/asks <n>` to see one item and its valid responses. For example, run
  `/asks 4 done` or `/asks 4 reply Use the existing API`.
- **See what Claude is doing.** Look for **Claude TODO** beside your requests on a
  wide terminal, or run `/claude-todo` to read the same list as text.

## What to expect

Both lists rebuild from the transcript when you resume a session. `/clear`
empties them, and a rewind during a running session can leave the displayed
lists out of sync until the agent updates them or you resume. On a Remote
Control phone, use the slash commands to view and answer requests. Blocking
items can also send a push notification.

For implementation details, see [agent instructions](hooks/steering.ts),
[request delivery](hooks/deliver.ts), and [slash commands](hooks/commands.ts).
