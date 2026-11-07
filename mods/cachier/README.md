# cachier

A prompt-cache countdown, an opt-in keepalive, and a time on every message. It stays out of the way until you look
for it.

## The footer line

In the prompt footer, at the right after the mode labels (`auditor is on`, say), a pie shows how much of the prompt cache's
lifetime is left, and next to it the time left, or a word where there is no time:

| State | Footer |
| --- | --- |
| Warm | `◕ 3:12` (the time dim) |
| Expired, the model priced | `○ ~$0.42 to rebuild` (dim; `~29k tokens to rebuild` in the token unit, or unpriced) |
| Cache reset by a model switch or compaction | `○ reset` (dim) |
| Keepalive on, nothing to count yet (before the first reply, after `/clear`) | `○ no count` (dim) |
| Keepalive on, a model switch or compaction before any reply has written the cache | `○ no count` (dim) |
| Keepalive off, nothing to count | nothing: the footer's labels alone |

- The pie's shape is the time left in quarters of the cache's lifetime, rounded up: `●` above three quarters, then `◕`,
  `◑`, `◔`, and `○` once the cache is gone. The lifetime is 5 minutes or 1 hour, as the transcript records it: on a subscription the
  main conversation defaults to 1 hour and on an API key to 5 minutes, and the `promptCacheTtl` setting changes it.
- The pie's colour: green while keepalive refreshes, and with keepalive on and nothing to count. While keepalive has a recorded
  stop (its refreshes used up, the cache expired, or a failure), the pie beside `reset` or `no count` is red until your next
  prompt; a pending cold mark alone leaves it green. Otherwise (keepalive off, or on but paused or spent) it is the normal text
  colour, then amber in the cache's last quarter, and red in its last tenth (1:15 and 0:30 on a 5-minute cache, 15 and 6
  minutes on an hour's). An expired cache is red with keepalive on and dim with it off.
- The price cue: after the words (not after a footer that is not drawn), `⟳` (dim) shows while this session reads Anthropic's pricing
  page, whoever started the read (the weekly schedule, a switch to dollars). When the read lands a `✓` takes its place, and when it
  fails an amber `!` does, each for about 3 seconds; then the footer is as before. Only the session that ran the read shows it, a
  reload or a session end clears it, and no toast is raised. The pie and the words stay clickable.
- A click on the pie switches keepalive, as `/keepalive on` with the last-used lead and count (else the defaults) or
  `/keepalive off` does. A click on the time, the rebuild figure, `reset` or `no count` opens the details pane, at any terminal width. Esc closes it.
- Hovering the time or the figure shows the refresh cost in a popup just above it; nothing on the line moves, so the time stays
  clickable. While the cache is warm it shows what keeping it warm costs beside what the next prompt pays to rebuild it if it goes
  cold:
  `keep warm $0.006/refresh · if cold ~$0.21 rebuild`
  Once the cache has expired it shows the refresh figure alone, as `$0.006/refresh`. With keepalive off, where a press would send no
  refresh (a lead at or above the TTL, or a learned count of 0), a warm cache shows the rebuild price alone, as
  `if cold ~$0.21 rebuild`
  and keepalive on shows nothing there.
- Hovering the pie shows keepalive's state in a popup just above it: `cache keepalive is on`, `cache keepalive is paused`
  (on, but sending no more), or `cache keepalive is off`. It moves nothing on the line either.
- On the phone cachier draws no mod UI, so the footer and the pane don't show there. Keepalive keeps running on the Mac.

## The details pane

A click on the time, the rebuild figure, `reset` or `no count` opens the pane, sized to what it last drew: one row per row, as wide as the longest. Before the
pane has drawn this session it opens at 12 rows by 48 columns, and an open pane is re-sized to its drawing within a second. A terminal too short for the rows
scrolls them with the wheel. A click on that word while it is open closes it, as Esc or the person's close does. The click acts on the pane as the engine
lists it: a pane closed some way cachier did not hear of (a reload, another plugin) is opened by the next click after a second,
and a close another plugin refuses leaves the pane open to be closed by the next click. The pane shows the four sections a bare
`/keepalive` answers with, in the same order with the same text, each heading in bold:

- **Cache**: the cache's warmth, `Prompt cache warm, 3:12 left (5-minute cache)`, or, once the cache has expired or been reset, the
  figure to rebuild it (the context plus the last reply's output, which the next prompt writes with it). The figure is priced
  at the model that last wrote the cache, so after a model switch it is at the rates of the model switched from;
- **Keepalive**: its state on the heading (`off`, `on, refreshing`, `paused`, `stopped`), and beneath it why it is paused or stopped and
  that it resumes after your next prompt, what the pie's colours warn of while it is amber or red, what a refresh costs and when the next is due (while
  the cache is warm, with a line of its own for what your next prompt pays to rebuild it, opening `if it goes cold`; a run whose lead is not below the TTL states that line alone on a warm cache), how many
  refreshes a pause sends, when keepalive pays off (`Keepalive pays off if you're back between 5:00 and 1:54:00`), and this
  pause's and this session's refreshes and their cost;
- **Advice**: the best setup's sentence (see [Best setup](#best-setup)), priced from your recorded pauses, and the notes on the TTL
  and the unit;
- **Settings**: each setting's value, where it came from, and what changes it.

The pane draws these rows itself, from the same figures the command reads, and its countdown advances each second. A press on the pie
changes what an open pane shows at once; the pane is re-sized to the new rows by the next second's tick. The rows run to about 30 to 40, so in
a short terminal the lower sections are scrolled to with the wheel.

## Keepalive

- Every session starts off. `/keepalive default on` makes later sessions start on, and `/keepalive default off` goes
  back. The pie, or `/keepalive on <lead_s> [count]` or `/keepalive off`, changes only the session it's made in, so
  "off everywhere but here" takes `/keepalive default on` and a click on the pie.
- While it's on, a refresh is sent shortly before the cache expires, so the next prompt reads the cache instead of
  rewriting it. A refresh reads the whole cached context, so each one costs a cache read. While the cache is warm that cost
  shows on hover over the time and in the pane beside the cost of the rebuild if the cache goes cold:
  `keep warm ~19k read/refresh · if cold ~19k tokens rebuild`
  in tokens, `keep warm $0.006/refresh · if cold ~$0.21 rebuild` in dollars.
- Output tokens are never priced: a refresh's cost is its cache read, plus any uncached input or cache write its reply reports.
- Refreshes stop after a count per pause, learned from your own pauses or the break-even count until they say otherwise
  (see [How many refreshes](#how-many-refreshes)). Then keepalive is paused until your next prompt. It is paused too if
  you turn it on after the cache has expired. A message from another session or a finished background task doesn't
  resume it.
- A refresh that fails stops keepalive, and the Keepalive heading reads `stopped` and the first line beneath it says what broke in one clause, such as
  `API error 529 (overloaded); your next prompt restarts it`.
- The lead (how long before expiry a refresh is sent) starts at 15 s. A refresh slower than half the lead raises it to
  twice that round trip for the session. It is never lowered, and keepalive stops instead of raising it past half the
  TTL.

## Cost unit

- Every cost is in dollars or in tokens. `/keepalive unit dollars|tokens` switches the unit for the session, and every
  figure in the hover and in the pane follows it. The `cost_unit` option sets the unit a session starts in; dollars by
  default.
- Dollars are Anthropic's list prices, read from the official pricing page
  (`platform.claude.com/docs/en/about-claude/pricing.md`), except where your overrides file below sets your own rates. One price list, kept in the plugin store, is shared by every
  session: a read happens when the newest successful read is seven days old, and at once on every switch to dollars. A
  session about to read checks the shared record again, so a read another session has already stamped is not repeated.
  Until the page has been read, the built-in table in `hooks/prices.ts` prices the models it lists; after that the last
  stored list stays in force, and a failed read falls back to it and goes to the debug log. An unreachable page is tried
  again an hour later, then once a day; a page with no readable table waits for the next weekly read. A model the page
  stops listing keeps its last stored rates. A 5 m or 1 h cache write is priced at its own rate, a read at the read
  rate, and a prompt over a model's size threshold (Haiku 5.5 over 100,000 tokens) at its higher rates.
- A model id from Amazon Bedrock (`anthropic.claude-opus-4-1-20250805-v1:0`, with or without a region prefix such as
  `us.`, `eu.`, `apac.` or `global.`) or Google Vertex (`claude-opus-4-1@20250805`) is matched to its list model and
  priced at that model's list rates. An id the price list holds exactly as given is priced by its own entry first. The
  partners' own rates aren't known, so a figure for such a session may differ from its bill. Ids in the older Bedrock
  naming, such as `anthropic.claude-3-5-sonnet-20241022-v2:0`, normalise to `claude-3-5-sonnet`, which the
  price list does not name, so they show no price; the overrides file below prices them.
- Your own rates go in an overrides file, `~/.claude/cachier/prices.json` (under `CLAUDE_CONFIG_DIR` when that is set).
  Cachier reads it and never writes it, so you, or Claude when you ask it to read a pricing page and write the entries,
  edit it with the ordinary editor. It is read each time cachier re-reads the shared record, about once a minute, so an
  edit, or deleting the file, is in force in every open session within about two minutes, with no page read and no
  reload. It holds two kinds of entry:

  ```json
  {
    "rates": {
      "claude-opus-5-5": { "input": 4, "read": 0.4, "write5m": 5, "write1h": 8, "date": "2026-10-26T09:00" }
    },
    "mappings": {
      "anthropic.claude-3-5-sonnet-20241022-v2:0": "claude-sonnet-4-5"
    }
  }
  ```

  - **rates**: a model id and its dollars per million tokens. `input` and `read` are required and must be positive;
    `write5m` and `write1h` are optional and, when left out, are worked out from `input` as the built-in table does (a
    5 m write is 1.25 inputs, a 1 h write 2). An optional `above` holds a size tier (`threshold` in tokens, then
    `input`, `read` and optionally the writes). Every rates entry needs a `date`, when you set it: a calendar date, or a
    date and time. A date with no time counts as the end of that day, and a date or time with no offset is local time;
    one with an offset (`2026-10-26T09:00+02:00`, or `Z`) is that instant. The rates must be in the sanity order: read
    at most input, input at most 5 m write, 5 m write at most 1 h write.
  - **mappings**: an id as the session reports it, mapped to a model id that has a price (a model on the page, in the
    built-in table, or a rates entry). The id is matched exactly, so a mapping for an id the page lists wins, and the
    target may be a dated or partner form of a priced model. A mapping has no date. Mappings do not chain: a target that
    is itself a mapping key is skipped.

  The last editor wins. A hand rate stands over the built-in table and the page's rates until a page read changes that
  model's rates after the entry's date; the page's rates are then in force. A first sighting of a model on the page is
  no change, and a model the page never lists keeps its hand rate. An entry that breaks a rule above, or a mapping to a
  model with no price, is skipped and written to the debug log; a file that is not JSON or cannot be read is skipped
  whole and logged as unreadable. An unknown field or section is ignored and named in the debug log.
- A figure with no price is shown in tokens, and the bare `/keepalive` answer says why (`Shown in tokens: no price for …`). That covers a
  model neither the page nor the built-in table lists, fast mode, and a response that names no model. This holds for the figure to
  rebuild an expired or reset cache too, wherever the Cache section draws one. Both prices of the pair fall to tokens together: the
  rebuild figure reads `~33k tokens`, `<1k tokens` or `0 tokens`, the tokens of the context plus the last reply's output.
- Tokens name what was done with them (`~19k tokens read`, `~20k tokens written`), since a write costs many reads. The
  bare `/keepalive` answer says how many reads a 5 m write costs on the current model.

## Message times

Each message has its time at its top right, so you can see how long each phase took.

## `/keepalive`

`on <lead_s> [count]`, `off`, `default on|off`, `unit dollars|tokens`, or no argument for the state and the full
rundown, in four sections: Cache (the warmth, with the figure to rebuild an expired or reset cache), Keepalive (the
refresh cost, how many refreshes a pause gets and why, when it pays off, this session and your pauses), Advice (the best
setup's sentence, the one-hour cache advice, the misses by cause, why figures are in tokens) and Settings (the TTL, lead,
refresh count, start mode and unit: each value, where it came from when that is known, and what changes it; the TTL and
start mode apply to new sessions). The Keepalive heading names keepalive's state, one of `off`, `on, refreshing`,
`on, no count`, `paused` and `stopped`; the reason for a pause or stop is the first line beneath it. When no refresh is
coming, the Keepalive section words the pie's warning (the pie turns amber in the cache's last quarter and red in its last
tenth: the cache is about to lapse) just below the heading or that reason, whatever the pie's colour, with keepalive off or on
with a reading and not refreshing, on a reset or expired cache too. With keepalive off, and where a press would send refreshes,
the refresh's cost or the context it reads, and how often one is sent, come straight after the warning. While the cache is warm, each price
of a refresh is followed by a line of its own for what the next prompt pays to rebuild the cache if it goes cold (`if it goes cold, your next prompt rebuilds it: ~$0.21 (~33k tokens written)`);
once it has expired the refresh's price stands alone. A run whose lead is not below the TTL sends no refresh, so on a warm cache it states the `if it goes cold` line alone. A keepalive paused by design
(its count used, or its cache expired) names what a refresh reads or costs and, where the cache is known and the lead is below the TTL, how often one would
be sent. With keepalive on and no stop held, the heading reads `paused` while a cache reset is being recorded, and the first line
beneath it says so; the reason the section would give with no reset pending, when it has one, follows as a second reason row, after
the colour sentence when that shows. The Keepalive section is always shown, as its heading alone when it has nothing else to say. Cache, Advice and Settings
are left out when they have nothing to say. The text wraps at 48 columns. A count pins the refreshes per pause for the session;
without one, each pause sends the learned count, else the break-even count.

Options: `keepalive_lead_s` (default 15), the lead the pie uses until a command sets one; `keepalive_count` (unset by default), a cap on the
break-even count; `keepalive_default` (`off` or `on`, default `off`), the mode a session starts in, which
`/keepalive default` sets; `cost_unit` (`dollars` or `tokens`, default `dollars`).

## How many refreshes

Keepalive can't know how long you'll be away, so each pause is a bet. A refresh costs a cache read of the whole context;
a lapse costs a rewrite of it. On Opus 5.5 a 5 m write costs 25 reads and a 1 h write 40, so letting the cache lapse and
paying for the rewrite costs 24 reads more than one refresh, or 39 at the 1 h TTL.

This is the ski-rental problem: rent (refresh) until the rent has cost one purchase (the rewrite), then buy (stop and let
the cache lapse). Cachier refreshes until the refreshes have cost as much as the rewrite they avoid: the write rate less
the read rate, over the read rate, rounded down. That is 24 refreshes at the 5 m TTL, covering a pause of about 1 h 54 m
with the default lead, and 39 at the 1 h TTL. It is a ratio of prices, so the size of the context doesn't change it.

However long the pause turns out to be, this rule never costs more than twice what the best choice in hindsight would
have, give or take the one refresh sent in the lead before you came back:

- Back before the refreshes run out: you paid only for the refreshes you needed, which cost less than the rewrite.
- Back after: you paid for the refreshes and then the rewrite, about two rewrites, against the one rewrite turning
  keepalive off would have cost.

A model with no price (see Cost unit) has no break-even count, and sends `keepalive_count`, or 3 when it is unset.

### Learning from your pauses

Break-even is the safe bet with nothing known about you. Once cachier has seen your pauses (kept as below), it prices
each count from 0 up to break-even over them, the way the marker prices a pause: the refreshes sent before you came
back, plus a rewrite if the cache lapsed. The cheapest count wins, and the bare `/keepalive` answer says what it learned from
(`Learned from your pauses: 6 refreshes, which cover 33:30; 10 of your 13 pauses ended within it.`).

The savings come from long pauses. A pause shorter than the time between refreshes costs nothing at any count, but one
longer than any count covers (lunch, a meeting, the night) costs break-even's 24 refreshes and the rewrite too, where no
refreshes would have cost the rewrite alone. So if your long pauses are usually much longer than half an hour, keepalive
learns to send fewer refreshes, down to none. With none, it stays on and sends nothing, and the answer says so
(`Learned from your pauses: no refreshes, as … ended within the 5:00 TTL.`).

Which pauses to learn from is left to the history: all of them, or only those that started in the same hour of the day.
Each rule is checked by leaving one pause out at a time and pricing it at the count the others teach. The rule that
would have cost least on pauses it hadn't seen is used, and break-even wins a tie. With only a few pauses no learned
rule beats break-even, so nothing changes until your history earns it. No threshold is set by hand.

A count you pin with `/keepalive on <lead> <count>` is sent as pinned, and `keepalive_count` caps the learned count as
it caps break-even.

### 5 m or 1 h

A 1 h cache makes every write dearer (on Opus 5.5, $8 per million tokens against $5) and every pause up to an hour free.
Which is cheaper depends on how long you pause and how much each turn writes, so cachier prices your recorded pauses at
both, at today's rates, in the mode keepalive is in: no refreshes while it is off, your pinned count, or the count it
would learn for that TTL. A switch takes a new session, so the other TTL is priced as one starts: keepalive on or off as
`keepalive_default` says, at the `keepalive_lead_s` lead and no pinned count. Once the other TTL would have cost less,
the answer says so and how to switch (`A 1-hour cache would have saved $4.74 over 10 priced pauses across sessions:
set "promptCacheTtl": "1h" in settings.json.`). The figure is what it is, over every priced pause across sessions (those recorded
with their context); this line has no threshold, so weigh a saving over a few pauses as the few pauses it is.

### Best setup

Pauses are also priced, the same way, at all four setups: 5 m or 1 h, keepalive on or off (which pauses: below). Each
"on" setup at your current TTL uses the lead and count keepalive runs with, or a click on the pie would start with: a
pinned count, else the count learned from your whole history, else break-even. An "on" setup at the other TTL needs a new
session, so it uses the lead and count a new session's click starts with: the `keepalive_lead_s` lead and no pinned count.
A change of TTL says to click the pie only when the new session would start keepalive (per `keepalive_default`) other
than the change wants, and when it does, the click is made in the new session, e.g.
`A 1-hour cache with keepalive off would have saved $1.20 over 10 recent pauses: set "promptCacheTtl": "1h" in
settings.json and, in the new session, click the pie off.` The sentence is added beside the figures above and the TTL line,
which stay. It says one thing:

- a change, when the cheapest setup differs from yours and saves at least $0.01 and at least 5% of what your setup cost
  over those pauses: the TTL and keepalive settings that change, and the saving. A TTL change names
  the `promptCacheTtl` setting and applies to new sessions; a keepalive change says to click the pie;
- or that you're on the cheapest setup, and what it saves against the other: keepalive on against keepalive off at the
  same TTL, or the other TTL when keepalive is off. Priced from the pause records at today's setting, not money
  already saved;
- or that you're on the cheapest setup, and the baseline costs about the same.

When a cheaper setup exists but would not clear the threshold, the sentence opens by naming it and its saving ("No
other setup would have saved enough to change (a 1-hour cache with keepalive off would have saved $0.02)"), and never
calls your setup the cheapest. Where no change is worth making and the baseline costs no more, the sentence says the
baseline would have cost about the same when the two are within half a cent, else that it would have cost a little less,
too little to change, with no figure; when the setup it opens with is the baseline, the opening names the pauses and
nothing follows it.

A keepalive run whose lead is not below a TTL sends no refresh at that TTL, so it is priced there as keepalive off.

The pauses are this session's once five of them can be priced, else the 50 newest priced pauses across sessions, and
every sentence says which; with fewer than five priced pauses anywhere there is no sentence. In tokens it names the
setup and points to `/keepalive unit dollars` for the figure. It is the first line of the Advice section, in the
details pane and in a bare `/keepalive`.

Cachier can't switch the TTL itself: no plugin setting controls it. Set `"promptCacheTtl": "5m"` or `"1h"` in
settings.json; `FORCE_PROMPT_CACHING_5M` and `CLAUDE_CODE_PROMPT_CACHE_TTL` override it. The docs don't say a running
session picks up the change, so cachier counts a switch as taking effect in sessions started after you set it.

With `--debug` or `--debug-file`, each refresh, lead raise, miss and long pause writes a `cachier` line to
the debug log, and each model switch writes a `cachier switch` line holding the engine's `prompt_cache_warm` flag beside
cachier's own reading of the cache.

Cachier keeps one record per pause your prompt ends, in its plugin store under your config directory: when the pause
started, how long it ran, the local hour and weekday, the cache TTL, what a rewrite costs over a refresh, and the size of
the cached context and how much it grew since the session's previous pause. Nothing from the conversation is kept. It
holds the newest 2,000 or so pauses across all sessions, for keepalive to learn its refresh count from. It also keeps one
shared price record under the key `prices`: the rates each read gave every model it listed, when each model's rates last
changed, whether the newest read dropped it, when the newest successful read landed and when a read last changed any
rates, and the last read attempt with its outcome and failure count. Nothing else is written to disk. Cachier also reads
the overrides file `cachier/prices.json` under your config directory, and never writes it. The only request
cachier makes itself is the pricing page, with nothing sent but the request. Each keepalive refresh is a model request.

## Known limits

- A miss is a reply that rewrote at least half its context while reading at most half the previous one. The half is a
  chosen threshold, not a measured one.
- A model switch counts as a reset only when cachier read the cache as warm at the switch. Otherwise (expired, no
  cache, cleared, an unread view or unknown TTL) the next miss is classified by its gap: a lapse past the TTL, else
  unexplained. A reset already standing still makes the next miss a reset miss.
- Pause gaps run between replies' logged times, so they include the next reply's duration, usually a few seconds.
- Dollars are priced when each figure is counted, so a price change mid-session leaves earlier figures at the old
  price.
- Cachier draws nothing in the engine's hint row. Its pie goes after the footer's labels, with a dim separator between
  them wherever a label is drawn before it. A label drawn after the line gets its separator from the plugin that draws
  it, as auditor's does.

## Loading

Load it with `claude --plugin-dir <path>/mods/cachier`, or install it from the flea-market marketplace.

Terminal only. The desktop surface is not tested.

## Checks

`claude plugin validate mods/cachier`, `tsc -p mods/cachier`, `claude plugin test mods/cachier`.

`tsc` needs `.claude-plugin/types/`, which the engine writes the first time it loads the mod from a folder (for
example `claude --plugin-dir mods/cachier`). Before that the `tsconfig.json` it extends is missing, and `tsc` writes
compiled `.js` files into `hooks/` instead of checking anything.
