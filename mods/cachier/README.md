# cachier

**Ca-ching!** Let’s see if keeping your cache warm knocks a few tokens off the bill.

Cachier can keep Claude Code’s prompt cache warm while you’re away. A cheap
refresh can save you the cost of rebuilding the cache when you return.
By default, Cachier measures cache costs and shows what could save you money.
You decide whether to flip the switch.

## How it works

Claude Code gives you two built-in cache lifetimes (TTLs), five minutes and
one hour. With keepalive on, Cachier sends a refresh shortly before expiry.
A refresh costs a cache read and buys another full TTL. If the cache
goes cold, the next request may have to write the context again.

With keepalive enabled, Cachier starts with the *ski rental* rule. A refresh
rents more time, and the buy price is the extra cost of returning to a cold
cache. Cachier caps refresh spending at that price. In the classic model,
this break-even rule costs at most twice what you’d pay if you knew how long
the pause would last. [Purohit et al., NeurIPS 2018](https://proceedings.neurips.cc/paper/2018/file/73a427badebe0e32caa2e1fc7530b7f3-Paper.pdf)

### What keepalive costs

For 250,000 cached tokens on Opus 5.5, a five-minute cache write costs $1.25,
a one-hour write costs $2.00, and a cache read costs $0.05.
[Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching)

- **Five-minute TTL.** At break-even, 24 refreshes plus the read on return cost
  the same as a cold rebuild. With the default 15-second lead, those
  refreshes can keep the cache warm for nearly two hours.
- **One-hour TTL.** The break-even budget is 39 refreshes, enough to cover more
  than a day. After a 25-hour pause, 25 refreshes plus the read on return can
  still cost less than a cold rebuild.

Cachier compares these four setups. The example includes the initial write,
any refreshes, and a cache read or rebuild on return. It assumes the same
context throughout. The keepalive examples use the default lead and assume
refreshes run through the pause.

| Cache lifetime | Pause | Keepalive off | Keepalive on | Savings with keepalive |
| --- | --- | ---: | ---: | ---: |
| 5 min | 45 min | $2.50 | **$1.75** | 30% |
| 5 min | 90 min | $2.50 | $2.20 | 12% |
| 1 hour | 90 min | $4.00 | **$2.10** | 47.5% |
| 1 hour | 25 hours | $4.00 | **$3.30** | 17.5% |

Savings use keepalive off at the same cache lifetime as the baseline.
Bold marks the lowest cost shown for each pause.

At 45 minutes, nine refreshes cost less than the $0.75 premium for a one-hour
write. At 90 minutes, the one-hour cache needs just one refresh. If you stay
away longer than the refresh budget, you can pay for both refreshes and a
rebuild.

### Advice based on your pauses

Cachier learns from your pauses and switches from break-even only when a
learned strategy does better on pauses it held out. It also prices all
four setups against your recorded pauses and shows what to change when the
savings make it worth switching.

## Get started

Run this at a Claude Code prompt.

```text
/plugin install cachier --marketplace Lotonoro/claude-code-plugin
```

To try a local clone for one session, run `claude --plugin-dir mods/cachier`
from the repository root.

## Use it

- **Check the cache.** The footer pie shows how much time is left. Hover over the
  countdown to compare the cost of a refresh with the cost of a rebuild. Click
  the countdown or status to open the details pane.
- **Read the advice.** Open the pane or run `/keepalive` to see session totals,
  cache misses, and any recommended setup. Message timestamps give you a quick
  sense of how long each phase took.
- **Control refreshes.** Click the pie to toggle keepalive for this session. Run
  `/keepalive on <lead_s> [count]` to choose how early to refresh and optionally
  pin a refresh count. Use `/keepalive off` to stop it or
  `/keepalive default on|off` to set the default for future sessions.

## Settings and limits

- **Cache lifetime.** Set `promptCacheTtl` to `"5m"` or `"1h"` in Claude
  Code’s settings and start a new session to use the recommended lifetime.
- **Cost display.** Run `/keepalive unit dollars|tokens` to switch units.
  Dollar estimates use API list prices or the rates you supply in
  `~/.claude/cachier/prices.json`.
- **Daily rest.** When keepalive is on, Cachier can pause refreshes during your
  learned rest window and compact long conversations. Set the plugin’s
  `overnight` option to `off` to disable both.
- **Surfaces.** The footer and pane are designed for the terminal. With Remote
  Control, keepalive continues in the host session.

For implementation details, see [refresh scheduling](hooks/keepalive.ts),
[setup recommendations](hooks/advice.ts), [overnight behavior](hooks/nightstep.ts),
and the [plugin settings](.claude-plugin/plugin.json).
