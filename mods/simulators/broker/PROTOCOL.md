# The client contract

What a client of the simulator broker sees: its verbs, the environment it reads, the state root it
keeps, the codes it exits with and the lines it prints. The lock family the broker shares with
pango's `scripts/sim-lock.sh` is `LOCK-PROTOCOL.md`'s, which pango-core reviews; this file is the
broker's own and changes with the broker. A test reads both files and fails when a code, a text or
a record field in either differs from the broker's code.

A text in a code span is exact. In such a text `{name}` stands for the value the client puts there.

## Version

The protocol's version is 1.

A change to the state directory's layout or to the form of a record is a breaking change, and its
migration or drain is decided with that change.

## Verbs

Every verb enters through one dispatcher, which reads the command line before it reads anything
else, so a command line that is wrong is refused whatever the environment holds.

| Verb | What it does |
|---|---|
| `run [--] COMMAND [ARGUMENT...]` | waits for a simulator run slot, runs the command under it, and exits with the command's status; everything after `run`, or after a `--` that follows it, is the command |
| `configure [--family PATH] [--shared] [--max-runs N] [--slots N] [--settle-seconds N] [--min-idle-percent N]` | writes the state root's whole configuration from its options and the defaults, reading no existing file, then reads the new one back and tries the family's lock files without blocking |
| `status` | prints the state root, its family and the last admission decision |
| `help` | prints the usage; `-h` and `--help` do the same |

The options of `configure` are the configuration's settings, each written with `--` and with `-` for
`_`. The text `configure` and `status` print is for a reader and no part of this contract.

## The environment

The dispatcher alone reads the environment. A variable set to nothing counts as unset, and a
variable not named here is not read.

| Variable | What the client does with it |
|---|---|
| `CLAUDE_SIMULATORS_STATE_ROOT` | names the state root; a relative path is made absolute from the working directory |
| `HOME` | locates the default state root, which is `Library/Application Support/claude-simulators` in it; when `HOME` is unset the account's home directory stands in |
| `PWD` | names the working directory the slot's owner record shows, as `sim-lock.sh` records its shell's `$PWD`, when it is an absolute path to the directory the client is in; any other value is not believed, and the record shows the directory the client is in |
| `SIM_LOCK_FILE` | is the family the client was given: a state root whose family is another runs nothing and the client exits 79; `configure` ignores it |
| any other `SIM_LOCK_*` | is a setting of `sim-lock.sh` that the broker does not read, and a line on stderr names it |

## The state root

A directory with a configuration and one state directory.

| Path in the root | What it is |
|---|---|
| `config.json` | the configuration |
| `family/lock` | the lock family's path, slot 0, unless the configuration names another |
| `state` | the state directory |
| `state/last-decision.json` | the last admission decision |

A root with no configuration runs on the broker's own defaults, its own family included, and says
so once, before its first waiting line.

## Exit codes

A client command exits with one of these. A command that itself exits with one of the codes below
leaves the run with that status, so the status alone does not show that the broker produced it: the
broker's own line on stderr does.

| Exit | When |
|---|---|
| 64 | the command line is not one the client takes |
| 75 | the wait reached the timeout, and the command did not run |
| 78 | a configuration, a lock file or a record cannot be read, written or used |
| 79 | the family the client was given is not the state root's family, and nothing was run |
| 124 | the command ran over the run limit and was killed |
| 126 | starting the command failed with an operating-system error other than a missing file, such as permission denied |
| 127 | starting the command failed because a file is missing: the command is not found, or the interpreter named on its first line is not |
| 128+N | signal N killed the command |
| the command's own status | in every other case |

The wrapper is the process the client starts to run and watch the command. A wrapper that cannot be
started is a refusal: the client exits 126 and says so. One that starts and then fails inside, as an
import error makes it, ends with Python's traceback on stderr and status 1, or 120 when stderr
cannot be written either. A command may exit with any status, so the table has no row for this, and
the traceback is what shows it.

## Records

### The configuration, `config.json`

One JSON object. `configure` writes every setting; a file that leaves one out takes its default.
A setting that is not listed, or a value out of its range, makes the loader refuse the file, and a
client that meets such a file exits 78 naming it.

| Setting | What it is | Default | Range |
|---|---|---|---|
| `family` | the lock family's path | `family/lock` in the root | an absolute path with no NUL byte and no `..` component, since a `..` after a directory that is not there yet names another directory once `configure` has made it |
| `shared` | whether `sim-lock.sh` uses the family too | `false` | `true` or `false`, and `true` for `sim-lock.sh`'s default lock itself, matched as that file and not by prefix (`LOCK-PROTOCOL.md` section 4) |
| `max_runs` | on a shared family, the MAX_RUNS that the script's callers use | 3 | a positive whole number, and 3 on a shared family in `sim-lock.sh`'s default lock family, matched as the script matches it (`LOCK-PROTOCOL.md` section 4) |
| `slots` | the number of slots the broker takes | `max(3, cores / 4)`, at most `max_runs` on a shared family | a positive whole number, at most `max_runs` on a shared family |
| `settle_seconds` | from the last start to a start beside another run | 90 | a whole number of at most 7 digits |
| `min_idle_percent` | the idle CPU a run needs | 50 | a whole number of at most 3 digits |

The timeout, the run limit, the repeat, the poll and the kill grace are constants, `LOCK-PROTOCOL.md`'s
defaults, and no setting.

### The last decision, `state/last-decision.json`

One JSON object, written whole under the gate by the waiter that made the decision and read under
the gate.

| Field | Value |
|---|---|
| `decision` | `admit` or `wait` |
| `reason` | the reason the run waits, or `the checks passed` when it was admitted |
| `slot` | the slot taken, or `null` for a wait |
| `at` | the epoch second of the decision |

## Reasons

The reasons a run waits are `LOCK-PROTOCOL.md` section 3's. The broker adds one, for a CPU sample
that outlasts the machine adapter's timeout. That is not the unmeasurable case of `LOCK-PROTOCOL.md`
section 3.2: the script has no timeout and would still be waiting on `iostat`, which overruns only
on a badly loaded Mac, so a run waits with this reason whether or not it is alone.

| When | Text |
|---|---|
| the CPU sample outlasted the machine adapter's timeout | `the CPU sample timed out after {seconds}s` |

## Lines on stderr

The three waiting lines and the holders under the first are `LOCK-PROTOCOL.md` section 5.1's. A
refusal prints one line, `sim-lock: ` and its reason, and exits with its code from the table above;
a usage error then prints the usage. The broker's own lines are these.

| When | Text |
|---|---|
| the environment sets `SIM_LOCK_*` variables the client ignores, before anything else the verb prints; the names are in name order | `sim-lock: ignoring {names}: the broker takes its settings from the state root's configuration, never from the environment` |
| the state root has no configuration, once, before the first waiting line | `sim-lock: no configuration at {config}; the broker's own defaults apply, with the family {family}` |
| the command cannot be started | `sim-lock: {command}: {reason}` |
| the command ran over the run limit | `sim-lock: command ran over the run limit of {limit}s and was killed; its simulator may still be booted, so delete it` |
