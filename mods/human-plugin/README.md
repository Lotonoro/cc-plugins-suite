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
mark the item so it rises to the top. When the agent has done everything it
can without you, it marks the request it is waiting on as blocking. The
list’s header reads `<name> TODO`, using the name the agent has for you, and
**Human TODO** until it has one.

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

**Agent TODO** puts the agent’s active and queued work beside your requests,
with ETAs when the agent can estimate them. You can see what’s coming up at a
glance and decide whether to move work between sessions. The header reads
**Agent TODO** until the agent gives itself a call name for the session, and then
`<name> TODO`; a long name is cut before the counts are.

## Get started

Run this at a Claude Code prompt, then start a new session.

```text
/plugin install human-plugin --marketplace Lotonoro/cc-plugins-suite
```

To try a local clone for one session, run `claude --plugin-dir mods/human-plugin`
from the repository root.

## Use it

- **Open an ask.** Click its title above the prompt to see its details, answers,
  and conversation. Items `/todo answer` hasn’t shown you yet, or that have
  changed since, appear first, and blocking items come first within each group.
  Buttons and typed replies give you a short undo window before they’re sent.
  The pane moves on to the next open request once the answer to the item it
  shows is sent, and closes when none is left.
- **Answer from the prompt.** Run `/todo` to list requests and
  `/todo <n>` to see one item and its valid responses. For example, run
  `/todo 4 done` or `/todo 4 reply Use the existing API`.
- **Answer every open request.** Run `/do` and it asks about each open request
  in turn, one dialog each. Each answer is written as you give it, and you can
  stop or skip from any dialog.
- **See what Claude is doing.** Look for **Agent TODO** beside your requests on a
  wide terminal, or run `/claude-todo` to read the same list as text.

## On a Remote Control phone

The panes and the list above the prompt don’t draw on the phone, so there is
nothing to click and the flow differs from the terminal’s. Slash commands and
their output do draw, and they take the pane’s place. `/todo` and
`/todo <n> <form>` work as they do at the prompt. `/do` asks about each open
request in turn, one dialog per request: the ones it hasn’t shown you yet, or
that have changed since, come first, and blocking ones come first within each
group. It writes each answer as you give it; `/todo answer` still starts the
same walk, and both run at the terminal too. The agent gets those answers when
the walk ends, as measured at the terminal. Whether the phone shows the
agent’s reply without a prompt you type awaits a run on the phone.

A prompt you type from the phone also carries the open requests to the agent
as context, so you don’t have to ask what’s waiting. A blocking item can send
a push notification to the phone too, including one the agent marks blocking
when it has run out of work it can do without you.

## What to expect

Both lists and their headers rebuild from the transcript when you resume a
session. `/clear` empties them and resets both headers, and a rewind during a
running session can leave the displayed lists out of sync until the agent
updates them or you resume.

For implementation details, see [agent instructions](hooks/steering.ts),
[request delivery](hooks/deliver.ts), and [slash commands](hooks/commands.ts).
