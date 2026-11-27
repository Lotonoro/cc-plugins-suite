# The shared-lock protocol

What a run does in a lock family that pango's `scripts/sim-lock.sh` and the simulator broker share:
the files, the gate, the records, the order of the admission checks, and what a waiting or running
client prints and exits with. It is written from the script, which pango-core owns. pango-core
reviews it against the script, and a change to this file goes to pango-core before it merges.

The client contract is not here. The broker's verbs, its status output, its device names and its
deletion log are `PROTOCOL.md`'s.

## The source

`scripts/sim-lock.sh` in pango at commit `282af324`, the merge of pango PR #622 (commit `522e99df`):
685 lines, git blob `5120a3abbb0a6eea80e748754903651618d209a2`. Below, `L166` is line 166 of that
file, `L166-169` lines 166 to 169, and `self-test L428-434` lines of its `--self-test`, which checks
most of the behaviours described.

A message, a record format or a command in a code span is quoted from the script character for
character; in such a text `%s`, `${name}` and `{name}` stand for the value the script puts there.

## What binds the broker

"A run", "a waiter" and "a holder" mean the script's or the broker's alike. On a family they share,
the broker follows what is written here, and these texts and codes are exact:

- the reasons in the table of section 3;
- the three waiting lines of section 5.1 with their `sim-lock: ` prefix, which clients quote, and
  the holders listing under the first;
- the exit codes in the first table of section 5.5.

The three messages in the second table of section 5.5 are the script's informational stderr and bind
nothing. The broker needs only some stderr line that tells its limit kill from a command's own 124
(L44-46).

## 1. Settings

The script's defaults, which the broker uses on a family it shares with the script. The script reads
each setting from the variable named, except the last, which is a constant.

| Setting | Variable | Default | Script |
|---|---|---|---|
| MAX_RUNS, runs at once | `SIM_LOCK_MAX_RUNS` | 3 | L59-60 |
| MIN_IDLE_PERCENT, the idle CPU a run needs, in percent | `SIM_LOCK_MIN_IDLE` | 50 | L61 |
| SETTLE_SECONDS, from the last start to a start beside another run | `SIM_LOCK_SETTLE` | 90 | L62 |
| POLL_SECONDS, between a waiter's attempts | `SIM_LOCK_POLL` | 10 | L55 |
| TIMEOUT_SECONDS, how long a waiter waits | `SIM_LOCK_TIMEOUT` | 3600 | L56 |
| RUN_LIMIT_SECONDS, how long a command may run; 0 for no limit | `SIM_LOCK_RUN_LIMIT` | 3600 | L57 |
| STATUS_SECONDS, between a waiter's repeats; 0 for none | `SIM_LOCK_STATUS` | 300 | L63 |
| KILL_GRACE_SECONDS, from TERM to KILL at the run limit | none | 10 | L66 |

## 2. The lock family

A family is one path, `<lock>`, and the files beside it. The script's path is `SIM_LOCK_FILE`, or
`/tmp/pango-sim-test.flock` when that is unset or empty (L58, L73-75). The broker shares a family
with the script by naming the same path.

| File | What it is | Script |
|---|---|---|
| `<lock>` | slot 0 | L96-99 |
| `<lock>.1`, `<lock>.2`, and so on | slot k, `<lock>.k`, for k above 0 | L96-99 |
| `<lock>.gate` | the gate | L198, L219 |
| `<lock>.last-start` | the epoch second of the last admission | L202 |
| `<lock>.owner`, `<lock>.1.owner`, and so on | the record of the run holding that slot: the slot's file with `.owner` appended | L206 |

The slot files and the gate are opened for appending, which creates a missing file and truncates
none, and nothing is written to them (L117, L143, L198, L219). `.last-start` and each owner record are
written whole at every admission (L202, L208). No run deletes a family file.

### 2.1 Locks and slots

Every lock is `flock(2)`, exclusive, taken through Python's `fcntl.flock` on an open file's
descriptor (L104-111). An attempt on a slot, or a probe of one, does not block and fails at once when
another process holds the lock; the gate's blocks, with no timeout (L199, L220). The kernel drops a
flock when the last descriptor on that open file closes, so a holder that dies leaves no stale state
for anyone to break (L31-32).

A run takes the lowest-numbered slot it can lock: it tries slot 0, then slot 1, up to slot
MAX_RUNS - 1, and keeps the first it gets (L186-189). It holds the slot's flock for as long as its
command runs (section 5.2). Slot 0 is the file the script's one-at-a-time form locked, so a run under
an older copy still counts as a run (L52-53).

A probe asks whether a slot is held without keeping it: it opens the slot's file and tries the flock;
if it gets it, it lets go at once and the slot is free, and if not the slot is held (L141-150). While
a probe holds a free slot's flock the slot cannot be taken, which is why a probe runs only under the
gate (L215-216).

### 2.2 The gate

Every decision to admit a run, and every listing of holders, runs with the gate's flock held, taken
blocking:

- A decision (`admit`, L196-212) makes the checks of section 3 and, when they pass, takes the slot
  and writes `.last-start` and the owner record, all before it lets the gate go (L198-210).
- A listing (`list_holders`, L217-228) probes slots, and a probe holds a free slot's flock for a
  moment, which must not happen while another waiter decides (L215-216, L219-220).

The CPU sample is part of the decision, so one waiter samples at a time (L23-24, L152-155, L176,
L200). The gate guards decisions and listings only; a run holds its slot outside it (L188, L210).

### 2.3 The records

Two records are written under the gate at every admission, a lone run's included (L201-209), and no
run deletes either, so a record outlives its run (L215-216).

`<lock>.last-start` holds the epoch second of the admission as `date +%s` prints it: decimal digits
and a newline (L202). A reader counts a missing file, or content that is not all digits, as settled
(L135-136). The broker's rule as a writer is plain epoch seconds with no leading zero, which the
script meets with `date +%s` (L202): bash reads a leading zero as octal, so `08` is an arithmetic
error at L138 and counts as not settled, and an epoch in the future stays unsettled until the clock
is SETTLE_SECONDS past it (L137-138).

The owner record is written after `.last-start`, to the taken slot's `.owner` file (L206-208). It is
one line, `pid=%s slot=%s cwd=%s started=%s command=%s` (L207), where

- `pid` is the script's own process id. It is for the reader and no run consults it, because the
  recorded shell can die while its command still holds the slot, and a pid can be reused
  (L37-38, L208);
- `slot` is the slot's number;
- `cwd` is the shell's `$PWD`: when the inherited `$PWD` names the directory, the working directory
  as the caller named it, so a symlink the caller went through stays in it, and otherwise bash's own
  physical path (L208);
- `started` is the local time of the admission from `date '+%Y-%m-%dT%H:%M:%S'`, with no zone (L208);
- `command` is the command's words joined by single spaces (L208).

Fields are separated by one space and no value is quoted or escaped, so `cwd` and `command` may hold
spaces (L207-208).

### 2.4 Listing the holders

A waiter lists the holders once, when it first starts to wait (section 5.1). Under the gate it probes
slots 0 to MAX_RUNS - 1 in turn, and for each whose flock is held and whose `.owner` file exists it
prints that file to stderr with two spaces before each line (L219-226). A record whose slot is not
held is never listed, since the file stays after its run ends, and a held slot is listed whether or
not the recorded shell is alive (L35-38, L215-216; self-test L644-668).

## 3. Admission

A run is admitted when the checks below pass, in this order, under the gate (L156-192). The first to
fail ends the decision with its reason, which the waiter prints (section 5.1). The CPU is sampled
only after checks 1 and 2 pass (L166-176).

A run is *alone* when no slot from 0 to MAX_RUNS - 1 is held, each decided by a probe (L157-163). The
last start is *settled* when at least SETTLE_SECONDS have passed since the epoch second in
`.last-start`, and also when that file is missing or not all digits (L132-139).

| # | The run waits when | Text | Script |
|---|---|---|---|
| 1 | every slot from 0 to MAX_RUNS - 1 is held | `all ${MAX_RUNS} run slots are held` | L166-169 |
| 2 | it is not alone and the last start is not settled | `a run started less than ${SETTLE_SECONDS}s ago` | L170-173 |
| 3 | MIN_IDLE_PERCENT is above 0 and the CPU's idle percentage is below it | `the CPU is ${idle}% idle and a run needs ${MIN_IDLE_PERCENT}%` | L174-180 |
| 4 | section 3.2: MIN_IDLE_PERCENT is above 0, the idle percentage cannot be measured, and the run is not alone | `the CPU's idle percentage cannot be measured` | L181-183 |
| 5 | checks 1 to 4 passed and it can lock none of the slots | `all ${MAX_RUNS} run slots are held` | L186-191 |

With every slot held, neither the settle time nor the CPU matters, and measuring would hold the gate
for a second to no purpose and name the wrong reason, so check 1 comes first and only its reason shows
(L164-165). A run that is alone skips check 2 (L170). Check 3 applies whether or not another run holds
a slot, because load that is not a run, such as a build or an emulator, is load all the same
(L18-20). When checks 1 to 4 pass the run takes the lowest free slot (section 2.1) and, under the same
hold of the gate, writes `.last-start` and its owner record (L186-189, L201-209).

### 3.1 The CPU sample

The sample is taken only when MIN_IDLE_PERCENT is above 0: a minimum of 0 admits at any load, so the
measurement is skipped (L174-175). The idle percentage is the third field of the last line of
`iostat -c 2 -w 1 -n 0`, which covers one second, and counts only when it is a whole number
(L125-130). The run passes check 3 when the percentage is at least MIN_IDLE_PERCENT (L177). The
sample is taken inside the gate, so other waiters wait behind it (L176, L200; section 2.2).

### 3.2 The unmeasurable-idle fallback

When MIN_IDLE_PERCENT is above 0 and the idle percentage cannot be measured, a run that is alone is
admitted without a CPU check, and a run that is not alone waits with check 4's reason (L181-183;
self-test L494-502). The reason therefore shows only beside another run, and a broken `iostat` never
blocks the only run (L24-25).

This rule is decided: pango's item #3, on whether a lone run may start with no idle reading, was
answered "Yes, start (keep as merged)" in pango PR #546 (68e6e8af). The rule shipped on purpose in
pango PR #545 (merge 98f42947), and `scripts/sim-lock.sh` is the same blob at `68e6e8af` as at
`98f42947`. If the rule changes, this section, the broker's conformance case for it and the script
change together, with pango-core changing the script on its side.

## 4. The shared-slot rule

A script run takes a slot, decides that it is alone or that every slot is held, and lists the
holders, all over slots 0 to MAX_RUNS - 1 and no others (L157-163, L166, L170, L186-189, L221-225).
MAX_RUNS is that run's own setting, read when it starts (L60); the family records none. So a script
run does not see a run on a slot numbered at or above its own MAX_RUNS: when no slot below its
MAX_RUNS is held, it counts itself alone, skips the settle check and does not list the other run.
This holds between two script runs too, in both directions: a run at MAX_RUNS 2 does not see a
holder on slot 2, and a run at 3 does not list a holder on slot 3, which a run at 5 can take.

So on a family the broker shares with the script, the script's callers share one N and the broker
is held to it:

- every script caller runs at one N. On the default lock's family that N is 3, and the script
  holds it: it refuses a `SIM_LOCK_MAX_RUNS` other than 3 there, before it touches the gate or a
  slot (L59, L374-376; the refusal's line is in section 5.5). On any other shared family N is what
  its callers agree on, and nothing holds it;
- the broker's alone check and its holder listing look at slots 0 to N - 1, its window;
- the broker's slot count c is at most N. A smaller c is safe, because the script sees slots 0 to
  N - 1, which include every broker slot;
- N changes only at pango-core's grant, for all the script's callers at once.

pango PR #622 decided the rule, and its record is
`docs/process/2026-11-26-the-default-simulator-lock-keeps-one-slot-count.md`. A lock file elsewhere
takes any count (self-test L402, L557-564).

The broker holds the same on its side by one rule, which asks where a family's files are and not
how its path is spelled. A family is in the default lock's family when its physical path begins
with the default lock's: the directory part resolved through every link, whether or not it is
there yet, then the name, compared without regard to letter case, which this Mac's volume does not
tell apart. That takes the lock, every file of its family (section 2), a longer name, and a path
inside any of them, since `configure` would turn a file of the script's into a directory. When the
default lock is a link, the file it leads to counts as the lock, and a family that is the same file
as the lock is in its family too (the shell's `-ef`, which only files that are there can pass). A
shared family in it must keep `max_runs` at 3, and a family in it must be shared: the script's
callers use its files, the gate among them, and an unshared family there would hold the script's
gate. The answer is the same whether the default lock is there or not, and before `configure`
makes the family's directory as after, so `configure` never takes a family that every later open
refuses. The rule takes everything the script's match behind its own refusal (L374-376) takes, and
other letter cases and a family whose directory is not there yet besides. A hard link planted
between a file of another family and a family file other than the lock, `<lock>.gate` say, is not
detected: the same-file test compares the two locks alone.

Where this file says MAX_RUNS of a broker run, it means c in its take loop and in checks 1 and 5 of
section 3, so the number in their text is c; in its alone check and its holder listing it means N.
The script cannot hold N to one on a family it has no name for: it reads MAX_RUNS per run and the
family records none. On the default lock's family it needs no record, since N is 3 there; on any
other shared family the callers keep one N between them.

More concurrency is pango-core's to grant. pango-core changes N only by a change to sim-lock.sh,
announced first, and the grant follows the order below. Each run reads MAX_RUNS when it starts
(L60), a waiting run included, so a run started under the old N keeps its window until it ends. A
grant therefore keeps the broker's window at least as wide as the largest N of any run in flight and
its c no larger than the smallest: the broker widens its window no later than the script's callers
move to the new N, lets the runs started under the old N drain, and only then raises c. Moving the
script's callers to the broker's client ends the constraint once none is left on the family.

## 5. A metered run

A metered run waits for admission, runs its command under the slot it was admitted to, and exits with
the command's status (L388-389). What the script prints on its own account goes to stderr, and the
command's output is the command's own (L92, L224, L237, L242, L246, L310).

### 5.1 Waiting

The waiter makes its first attempt at once and sleeps POLL_SECONDS after each failed one (L234,
L249); a run admitted at its first attempt prints nothing of its own. `waited` is the seconds since
the first attempt, read after each failed attempt, so the time an attempt takes, a second of `iostat`
or a wait for the gate, counts toward the repeats and the timeout (L231-235).

| After | Text | Filled with | Script |
|---|---|---|---|
| the first failed attempt | `sim-lock: waiting for a simulator run slot: %s; running now:` | the reason; the holders follow (section 2.4), listed this once | L236-240 |
| a failed attempt after the first, with `waited` at or past the repeat mark | `sim-lock: still waiting after %ss: %s` | the seconds waited, the reason | L241-244 |
| a failed attempt with `waited` at or past TIMEOUT_SECONDS | `sim-lock: gave up after %ss: %s` | the seconds waited, the reason; the waiter then exits 75 and the command does not run | L245-248 |

The first repeat mark is STATUS_SECONDS; each repeat moves it to `waited` plus STATUS_SECONDS, and
with STATUS_SECONDS 0 there are no repeats (L240-244). The first failed attempt prints the waiting
line and never a repeat, whatever `waited` is: the two are alternatives (L236-244). The timeout is
tested after them, on the same failed attempt, so the number in the last line is the first reading
at or past TIMEOUT_SECONDS, not TIMEOUT_SECONDS itself (L245-248). For example, with every slot held
(values illustrative; the form is that of L207-208, L224 and L237):

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
  (L29-32, L270-272, L284, L355-356, L363-367).
- The wrapper starts the command with `start_new_session=True` (L339): the command leads its own
  process group and session and has no controlling terminal, so a caller's terminal cannot answer a
  prompt from it (L42, L48-50). Python's default `close_fds` closes the inherited slot descriptor in
  the command (L338), so a daemon the command leaves behind holds no slot (L33-34; self-test
  L442-445).
- The command keeps the script's stdin (L283, L355; self-test L627-628).
- A SIGKILL to the script leaves the slot held until the wrapper is gone, which is when the command's
  group leader has exited (L29-32, L353-354; self-test L428-434). A holder that dies leaves no stale
  state once its command is gone (self-test L436-440).

### 5.3 The run limit

A command that runs longer than RUN_LIMIT_SECONDS is stopped, because a hung run would hold its slot
forever; 0 sets no limit (L40-41, L345). The wrapper waits for the command's group leader to exit
without reaping it, by kqueue, so the group's id cannot be reused before the KILL that follows
(L272-274, L322-331). At the limit it

1. prints a message on stderr that tells the kill from a command's own 124; when stderr cannot be
   written the message is dropped and the steps below follow (the script's message is in section
   5.5; L346-347);
2. sends SIGTERM to the group (L348);
3. waits for the leader to exit, at most KILL_GRACE_SECONDS (L349);
4. sends SIGKILL to the group, whether or not the leader has exited (L350);
5. reaps the leader and exits 124 (L351-352).

So a leader that traps TERM has until it exits, within the grace period, to run its trap (L42-44;
self-test L597-601), and a grandchild that ignores TERM dies with the group (self-test L592-595).

### 5.4 Signals

Once a run is admitted the script traps TERM, HUP and INT (L280-282) and passes each to the wrapper
(L261-268), which sends it to the command's process group (L299-303). The script goes on waiting for
the wrapper, so the slot stays held until the group leader has exited (L51-52, L363-367; self-test
L603-607). A signal that lands just as the command ends with exit 0 leaves the run exiting 0
(self-test L609-616, which covers only exit 0); the code intends the same for any status (L314-320,
L358-367). Before admission nothing handles these signals: the traps are set in `run_capped`, after
`acquire` has returned (L280-282, L388-389).

### 5.5 Exit codes and the script's messages

| Exit | When | Script |
|---|---|---|
| 75 | the wait reached TIMEOUT_SECONDS; the command did not run (section 5.1) | L64, L245-248; self-test L447-451 |
| 124 | the command ran over RUN_LIMIT_SECONDS and was killed (section 5.3) | L65, L352; self-test L566-569 |
| 127 | starting the command failed with ENOENT: the command is not found, or the interpreter named on its first line is not | L340-342 |
| 126 | starting the command failed with any other operating-system error, such as permission denied | L340-342 |
| 128+N | signal N killed the command | L354; self-test L624-625 |
| the command's own status | in every other case | L353-354; self-test L409-410 |

A command that itself exits 75, 124, 126 or 127 leaves the run with that status (L353-354), so the
status alone does not show that the script produced it; the script's own line on stderr does (L44-46
for 124). The script also exits 1, before any wait, on a usage error or a setting out of range
(L91-94, L372-387); those refusals belong to the script's own command line and variables, and this
protocol does not carry them. The one that section 4's rule causes has its line in the table below,
for a reader who meets it.

| When | Text | Filled with | Script |
|---|---|---|---|
| the command cannot be started | `sim-lock: {cmd[0]}: {err.strerror}` | the command's first word, the operating system's message | L305-312, L340-342 |
| the command ran over the limit | `sim-lock: command ran over SIM_LOCK_RUN_LIMIT={limit}s and was killed; its simulator may still be booted, so delete it` | the limit in seconds | L305-312, L345-347 |
| a `SIM_LOCK_MAX_RUNS` other than 3 on the default lock's family (section 4); the script exits 1 before any wait and takes no gate or slot | `sim-lock: SIM_LOCK_MAX_RUNS must be ${DEFAULT_MAX_RUNS} for the default lock; set SIM_LOCK_FILE to use another` | the default count, 3 | L59, L91-94, L374-376 |

The wrapper writes the first two through `warn()` (L305-312): one `os.write` to descriptor 2, whose
failure is dropped. A stderr whose reader has gone, because the caller was killed, therefore keeps
neither the kill at the limit nor the exit status 124, 126 or 127 from following (pango PR #603;
self-test L571-586). `warn()` encodes the line with `os.fsencode` (L310), so a command's name that
holds a byte that is not UTF-8 is written as it came in, and a missing command so named still exits
127 (pango PR #615; self-test L588-590). The broker's `say()` does the same on both counts.

The broker is not bound to any of these three messages (see "What binds the broker"). The third is
the script's refusal for its own callers; the broker refuses the same case in its configuration,
with words of its own and exit 78 (`PROTOCOL.md`).

### 5.6 Order among waiters

The script gives no waiter precedence. A waiter sleeps POLL_SECONDS after a failed attempt (L234,
L249), so its attempts start POLL_SECONDS plus the attempt's own time apart, and a freed slot goes to
the waiter whose attempt takes the gate first with the checks passing (L196-212). This is the
script's behaviour and is not carried over: the order in which the broker's own waiters take a freed
slot is not set here.

Constraints on the broker, not facts about the script: whatever order the broker applies, it applies
before a waiter enters the gate; admission still follows sections 2 and 3; and the broker never
holds a slot or the gate for a waiter, so a script waiter can take any free slot.
