# The shared-lock protocol

What a run does in a lock family that pango's `scripts/sim-lock.sh` and the simulator broker share:
the files, the gate, the records, the order of the admission checks, and what a waiting or running
client prints and exits with. It is written from the script, which pango-core owns. pango-core
reviews it against the script, and a change to this file goes to pango-core before it merges.

The client contract is not here. The broker's verbs, its status output, its device names and its
deletion log are `PROTOCOL.md`'s.

## The source

`scripts/sim-lock.sh` in pango at commit `4af6051e`: 625 lines, git blob
`d494f9bfab6b645240694d16749414acff4af38b`, the same blob as at `98f42947`. Below, `L148` is line 148
of that file, `L148-151` lines 148 to 151, and `self-test L398-404` lines of its `--self-test`, which
checks most of the behaviours described.

A message, a record format or a command in a code span is quoted from the script character for
character; in such a text `%s`, `${name}` and `{name}` stand for the value the script puts there.

## What binds the broker

"A run", "a waiter" and "a holder" mean the script's or the broker's alike. On a family they share,
the broker follows what is written here, and these texts and codes are exact:

- the reasons in the table of section 3;
- the three waiting lines of section 5.1 with their `sim-lock: ` prefix, which clients quote, and
  the holders listing under the first;
- the exit codes in the first table of section 5.5.

The two messages in the second table of section 5.5 are the script's informational stderr and bind
nothing. The broker needs only some stderr line that tells its limit kill from a command's own 124
(L42-44).

## 1. Settings

The script's defaults, which the broker uses on a family it shares with the script. The script reads
each setting from the variable named, except the last, which is a constant.

| Setting | Variable | Default | Script |
|---|---|---|---|
| MAX_RUNS, runs at once | `SIM_LOCK_MAX_RUNS` | 3 | L56 |
| MIN_IDLE_PERCENT, the idle CPU a run needs, in percent | `SIM_LOCK_MIN_IDLE` | 50 | L57 |
| SETTLE_SECONDS, from the last start to a start beside another run | `SIM_LOCK_SETTLE` | 90 | L58 |
| POLL_SECONDS, between a waiter's attempts | `SIM_LOCK_POLL` | 10 | L53 |
| TIMEOUT_SECONDS, how long a waiter waits | `SIM_LOCK_TIMEOUT` | 3600 | L54 |
| RUN_LIMIT_SECONDS, how long a command may run; 0 for no limit | `SIM_LOCK_RUN_LIMIT` | 3600 | L55 |
| STATUS_SECONDS, between a waiter's repeats; 0 for none | `SIM_LOCK_STATUS` | 300 | L59 |
| KILL_GRACE_SECONDS, from TERM to KILL at the run limit | none | 10 | L62 |

## 2. The lock family

A family is one path, `<lock>`, and the files beside it. The script's path is `SIM_LOCK_FILE`, or
`/tmp/pango-sim-test.flock` when that is unset or empty (L69-71). The broker shares a family with the
script by naming the same path.

| File | What it is | Script |
|---|---|---|
| `<lock>` | slot 0 | L78-81 |
| `<lock>.1`, `<lock>.2`, and so on | slot k, `<lock>.k`, for k above 0 | L78-81 |
| `<lock>.gate` | the gate | L180, L201 |
| `<lock>.last-start` | the epoch second of the last admission | L184 |
| `<lock>.owner`, `<lock>.1.owner`, and so on | the record of the run holding that slot: the slot's file with `.owner` appended | L188 |

The slot files and the gate are opened for appending, which creates a missing file and truncates
none, and nothing is written to them (L99, L125, L180, L201). `.last-start` and each owner record are
written whole at every admission (L184, L190). No run deletes a family file.

### 2.1 Locks and slots

Every lock is `flock(2)`, exclusive, taken through Python's `fcntl.flock` on an open file's
descriptor (L86-93). An attempt on a slot, or a probe of one, does not block and fails at once when
another process holds the lock; the gate's blocks, with no timeout (L181, L202). The kernel drops a
flock when the last descriptor on that open file closes, so a holder that dies leaves no stale state
for anyone to break (L29-30).

A run takes the lowest-numbered slot it can lock: it tries slot 0, then slot 1, up to slot
MAX_RUNS - 1, and keeps the first it gets (L168-171). It holds the slot's flock for as long as its
command runs (section 5.2). Slot 0 is the file the script's one-at-a-time form locked, so a run under
an older copy still counts as a run (L50-51).

A probe asks whether a slot is held without keeping it: it opens the slot's file and tries the flock;
if it gets it, it lets go at once and the slot is free, and if not the slot is held (L123-132). While
a probe holds a free slot's flock the slot cannot be taken, which is why a probe runs only under the
gate (L197-198).

### 2.2 The gate

Every decision to admit a run, and every listing of holders, runs with the gate's flock held, taken
blocking:

- A decision (`admit`, L178-194) makes the checks of section 3 and, when they pass, takes the slot
  and writes `.last-start` and the owner record, all before it lets the gate go (L180-192).
- A listing (`list_holders`, L199-210) probes slots, and a probe holds a free slot's flock for a
  moment, which must not happen while another waiter decides (L197-198, L201-202).

The CPU sample is part of the decision, so one waiter samples at a time (L21-22, L134-137, L158,
L182). The gate guards decisions and listings only; a run holds its slot outside it (L170, L192).

### 2.3 The records

Two records are written under the gate at every admission, a lone run's included (L183-191), and no
run deletes either, so a record outlives its run (L197-198).

`<lock>.last-start` holds the epoch second of the admission as `date +%s` prints it: decimal digits
and a newline (L184). A reader counts a missing file, or content that is not all digits, as settled
(L117-118). A writer writes plain epoch seconds with no leading zero: bash reads a leading zero as
octal, so `08` is an arithmetic error at L120 and counts as not settled, and an epoch in the future
stays unsettled until the clock is SETTLE_SECONDS past it (L119-120).

The owner record is written after `.last-start`, to the taken slot's `.owner` file (L188-190). It is
one line, `pid=%s slot=%s cwd=%s started=%s command=%s` (L189), where

- `pid` is the script's own process id. It is for the reader and no run consults it, because the
  recorded shell can die while its command still holds the slot, and a pid can be reused
  (L35-36, L190);
- `slot` is the slot's number;
- `cwd` is the working directory;
- `started` is the local time of the admission from `date '+%Y-%m-%dT%H:%M:%S'`, with no zone (L190);
- `command` is the command's words joined by single spaces (L190).

Fields are separated by one space and no value is quoted or escaped, so `cwd` and `command` may hold
spaces (L189-190).

### 2.4 Listing the holders

A waiter lists the holders once, when it first starts to wait (section 5.1). Under the gate it probes
slots 0 to MAX_RUNS - 1 in turn, and for each whose flock is held and whose `.owner` file exists it
prints that file to stderr with two spaces before each line (L201-208). A record whose slot is not
held is never listed, since the file stays after its run ends, and a held slot is listed whether or
not the recorded shell is alive (L33-36, L197-198; self-test L584-608).

## 3. Admission

A run is admitted when the checks below pass, in this order, under the gate (L138-174). The first to
fail ends the decision with its reason, which the waiter prints (section 5.1). The CPU is sampled
only after checks 1 and 2 pass (L148-158).

A run is *alone* when no slot from 0 to MAX_RUNS - 1 is held, each decided by a probe (L139-145). The
last start is *settled* when at least SETTLE_SECONDS have passed since the epoch second in
`.last-start`, and also when that file is missing or not all digits (L114-121).

| # | The run waits when | Text | Script |
|---|---|---|---|
| 1 | every slot from 0 to MAX_RUNS - 1 is held | `all ${MAX_RUNS} run slots are held` | L148-151 |
| 2 | it is not alone and the last start is not settled | `a run started less than ${SETTLE_SECONDS}s ago` | L152-155 |
| 3 | MIN_IDLE_PERCENT is above 0 and the CPU's idle percentage is below it | `the CPU is ${idle}% idle and a run needs ${MIN_IDLE_PERCENT}%` | L156-162 |
| 4 | provisional, section 3.2: MIN_IDLE_PERCENT is above 0, the idle percentage cannot be measured, and the run is not alone | `the CPU's idle percentage cannot be measured` | L163-165 |
| 5 | checks 1 to 4 passed and it can lock none of the slots | `all ${MAX_RUNS} run slots are held` | L168-173 |

With every slot held, neither the settle time nor the CPU matters, and measuring would hold the gate
for a second to no purpose and name the wrong reason, so check 1 comes first and only its reason shows
(L146-147). A run that is alone skips check 2 (L152). Check 3 applies whether or not another run holds
a slot, because load that is not a run, such as a build or an emulator, is load all the same
(L16-18). When checks 1 to 4 pass the run takes the lowest free slot (section 2.1) and, under the same
hold of the gate, writes `.last-start` and its owner record (L168-171, L183-191).

### 3.1 The CPU sample

The sample is taken only when MIN_IDLE_PERCENT is above 0: a minimum of 0 admits at any load, so the
measurement is skipped (L156-157). The idle percentage is the third field of the last line of
`iostat -c 2 -w 1 -n 0`, which covers one second, and counts only when it is a whole number
(L107-112). The run passes check 3 when the percentage is at least MIN_IDLE_PERCENT (L159). The
sample is taken inside the gate, so other waiters wait behind it (L158, L182; section 2.2).

### 3.2 The unmeasurable-idle fallback (provisional)

When MIN_IDLE_PERCENT is above 0 and the idle percentage cannot be measured, a run that is alone is
admitted without a CPU check, and a run that is not alone waits with check 4's reason (L163-165;
self-test L464-472). The reason therefore shows only beside another run, and a broken `iostat` never
blocks the only run (L22-23).

This rule is provisional: it is what the script does today. What follows is proposed, for pango-core
to correct. pango's decision on the rule is open. Nothing in the broker would depend on its being
final: the broker would mark its conformance case for this rule provisional, as check 4 above is, and
if the rule changes, this section, that case and the script would change together, with pango-core
changing the script on its side.

## 4. The shared-slot rule

A script run takes a slot, decides that it is alone or that every slot is held, and lists the
holders, all over slots 0 to MAX_RUNS - 1 and no others (L139-145, L148, L152, L168-171, L203-207).
MAX_RUNS is that run's own setting, read when it starts (L56); the family records none. So a script
run does not see a run on a slot numbered at or above its own MAX_RUNS: when no slot below its
MAX_RUNS is held, it counts itself alone, skips the settle check and does not list the other run.
This holds between two script runs too, in both directions: a run at MAX_RUNS 2 does not see a
holder on slot 2, and a run at 3 does not list a holder on slot 3, which a run at 5 can take.

So on a family the broker shares with the script, the script's callers share one N and the broker
is held to it:

- every script caller runs at one N: 3 today (L56), and no caller on the shared family sets the
  variable;
- the broker's alone check and its holder listing look at slots 0 to N - 1, its window;
- the broker's slot count c is at most N. A smaller c is safe, because the script sees slots 0 to
  N - 1, which include every broker slot;
- N changes only at pango-core's grant, for all the script's callers at once.

Where this file says MAX_RUNS of a broker run, it means c in its take loop and in checks 1 and 5 of
section 3, so the number in their text is c; in its alone check and its holder listing it means N.
The script cannot enforce that N is one: it reads MAX_RUNS per run and the family records none.
pango-core is asked to hold it.

More concurrency is pango-core's to grant. Each run reads MAX_RUNS when it starts (L56), a waiting
run included, so a run started under the old N keeps its window until it ends. A grant therefore
keeps the broker's window at least as wide as the largest N of any run in flight and its c no
larger than the smallest: the broker widens its window no later than the script's callers move to
the new N, lets the runs started under the old N drain, and only then raises c. Moving the script's
callers to the broker's client ends the constraint once none is left on the family.

## 5. A metered run

A metered run waits for admission, runs its command under the slot it was admitted to, and exits with
the command's status (L358-359). What the script prints on its own account goes to stderr, and the
command's output is the command's own (L74, L206, L219, L224, L228, L314, L319-320).

### 5.1 Waiting

The waiter makes its first attempt at once and sleeps POLL_SECONDS after each failed one (L216,
L231); a run admitted at its first attempt prints nothing of its own. `waited` is the seconds since
the first attempt, read after each failed attempt, so the time an attempt takes, a second of `iostat`
or a wait for the gate, counts toward the repeats and the timeout (L213-217).

| After | Text | Filled with | Script |
|---|---|---|---|
| the first failed attempt | `sim-lock: waiting for a simulator run slot: %s; running now:` | the reason; the holders follow (section 2.4), listed this once | L218-222 |
| a failed attempt after the first, with `waited` at or past the repeat mark | `sim-lock: still waiting after %ss: %s` | the seconds waited, the reason | L223-226 |
| a failed attempt with `waited` at or past TIMEOUT_SECONDS | `sim-lock: gave up after %ss: %s` | the seconds waited, the reason; the waiter then exits 75 and the command does not run | L227-230 |

The first repeat mark is STATUS_SECONDS; each repeat moves it to `waited` plus STATUS_SECONDS, and
with STATUS_SECONDS 0 there are no repeats (L222-226). The first failed attempt prints the waiting
line and never a repeat, whatever `waited` is: the two are alternatives (L218-226). The timeout is
tested after them, on the same failed attempt, so the number in the last line is the first reading
at or past TIMEOUT_SECONDS, not TIMEOUT_SECONDS itself (L227-230). For example, with every slot held
(values illustrative; the form is that of L189-190, L206 and L219):

```
sim-lock: waiting for a simulator run slot: all 3 run slots are held; running now:
  pid=41231 slot=0 cwd=/tmp/work started=2026-11-25T14:03:11 command=xcodebuild test
  pid=41233 slot=1 cwd=/tmp/work started=2026-11-25T14:04:45 command=xcodebuild test
  pid=41234 slot=2 cwd=/tmp/work started=2026-11-25T14:06:20 command=xcodebuild test
```

### 5.2 Running

- The script keeps the admitted slot's flock on a descriptor of its own and starts a wrapper, a
  `/usr/bin/python3 -I -c` process, in the background with that descriptor inherited, so the script
  and the wrapper both hold the flock; the script then waits until the wrapper is gone
  (L27-30, L252-254, L266, L328-329, L336-340).
- The wrapper starts the command with `start_new_session=True` (L312): the command leads its own
  process group and session and has no controlling terminal, so a caller's terminal cannot answer a
  prompt from it (L40, L46-48). Python's default `close_fds` closes the inherited slot descriptor in
  the command (L311), so a daemon the command leaves behind holds no slot (L31-32; self-test
  L412-415).
- The command keeps the script's stdin (L265, L328; self-test L567-568).
- A SIGKILL to the script leaves the slot held until the wrapper is gone, which is when the command's
  group leader has exited (L27-30, L326-327; self-test L398-404). A holder that dies leaves no stale
  state once its command is gone (self-test L406-410).

### 5.3 The run limit

A command that runs longer than RUN_LIMIT_SECONDS is stopped, because a hung run would hold its slot
forever; 0 sets no limit (L38-39, L318). The wrapper waits for the command's group leader to exit
without reaping it, by kqueue, so the group's id cannot be reused before the KILL that follows
(L254-256, L295-304). At the limit it

1. prints a message on stderr that tells the kill from a command's own 124 (the script's message is
   in section 5.5; L319-320);
2. sends SIGTERM to the group (L321);
3. waits for the leader to exit, at most KILL_GRACE_SECONDS (L322);
4. sends SIGKILL to the group, whether or not the leader has exited (L323);
5. reaps the leader and exits 124 (L324-325).

So a leader that traps TERM has until it exits, within the grace period, to run its trap (L40-42;
self-test L537-541), and a grandchild that ignores TERM dies with the group (self-test L532-535).

### 5.4 Signals

Once a run is admitted the script traps TERM, HUP and INT (L262-264) and passes each to the wrapper
(L243-250), which sends it to the command's process group (L281-285). The script goes on waiting for
the wrapper, so the slot stays held until the group leader has exited (L49-50, L336-340; self-test
L543-547). A signal that lands just as the command ends leaves the command's status unchanged
(L287-293, L331-340; self-test L549-556). Before admission nothing handles these signals: the traps
are set in `run_capped`, after `acquire` has returned (L262-264, L358-359).

### 5.5 Exit codes and the wrapper's messages

| Exit | When | Script |
|---|---|---|
| 75 | the wait reached TIMEOUT_SECONDS; the command did not run (section 5.1) | L60, L227-230; self-test L417-421 |
| 124 | the command ran over RUN_LIMIT_SECONDS and was killed (section 5.3) | L61, L325; self-test L527-530 |
| 127 | starting the command failed with ENOENT: the command is not found, or the interpreter named on its first line is not | L313-315 |
| 126 | starting the command failed with any other operating-system error, such as permission denied | L313-315 |
| 128+N | signal N killed the command | L327; self-test L564-565 |
| the command's own status | in every other case | L326-327; self-test L379-380 |

A command that itself exits 75, 124, 126 or 127 leaves the run with that status (L326-327), so the
status alone does not show that the script produced it; the script's own line on stderr does (L42-44
for 124). The script also exits 1, before any wait, on a usage error or a setting out of range
(L73-76, L345-357); those refusals belong to the script's own command line and variables, and this
protocol does not carry them.

| When | Text | Filled with | Script |
|---|---|---|---|
| the command cannot be started | `sim-lock: {cmd[0]}: {err.strerror}` | the command's first word, the operating system's message | L313-315 |
| the command ran over the limit | `sim-lock: command ran over SIM_LOCK_RUN_LIMIT={limit}s and was killed; its simulator may still be booted, so delete it` | the limit in seconds | L318-320 |

The broker is not bound to these two messages (see "What binds the broker").

### 5.6 Order among waiters

The script gives no waiter precedence. A waiter sleeps POLL_SECONDS after a failed attempt (L216,
L231), so its attempts start POLL_SECONDS plus the attempt's own time apart, and a freed slot goes to
the waiter whose attempt takes the gate first with the checks passing (L178-194). This is the
script's behaviour and is not carried over: the order in which the broker's own waiters take a freed
slot is not set here.

Whatever order the broker applies, it applies before a waiter enters the gate. Admission still
follows sections 2 and 3, and the broker never holds a slot or the gate for a waiter, so a script
waiter can take any free slot.
