"""What the broker publishes, in one place.

`LOCK-PROTOCOL.md` states the lock family the broker shares with pango's `sim-lock.sh`, and
`PROTOCOL.md` states the client contract. The conformance test reads both files and fails when
one of them differs from a constant here. A `{name}` in a text below stands for the value the
broker puts there, where the script's own texts write `%s` or `${name}`.
"""

from __future__ import annotations

# The protocol's version, which `PROTOCOL.md` states. A change to the state directory's layout or to
# a record's form is a breaking change, and raises it.
PROTOCOL_VERSION = 1

# The exit codes of a client command. 75, 124, 126 and 127 are the script's, and
# LOCK-PROTOCOL.md section 5.5 binds them. 64 and 78 follow sysexits.h's EX_USAGE and EX_CONFIG,
# as the script's 75 follows EX_TEMPFAIL.
EXIT_USAGE = 64
EXIT_TIMEOUT = 75
EXIT_CONFIG = 78
EXIT_FAMILY_DISAGREES = 79
EXIT_RUN_LIMIT = 124
EXIT_CANNOT_EXECUTE = 126
EXIT_NOT_FOUND = 127

# The script's defaults, which LOCK-PROTOCOL.md section 1 lists.
DEFAULT_MAX_RUNS = 3
DEFAULT_MIN_IDLE_PERCENT = 50
DEFAULT_SETTLE_SECONDS = 90
# The slot count's default on a machine of `cores` is max(SLOT_FLOOR, cores // CORES_PER_SLOT),
# and on a family shared with the script it is capped at the script's MAX_RUNS.
SLOT_FLOOR = 3
CORES_PER_SLOT = 4
# The limits a configuration's whole numbers keep to: "at most 7 digits" and "at most 3 digits".
MAX_SETTLE_SECONDS = 9_999_999
MAX_MIN_IDLE_PERCENT = 999

# The state root's layout. `PROTOCOL.md` states it.
DEFAULT_ROOT_PARTS = ("Library", "Application Support", "claude-simulators")
CONFIG_FILE = "config.json"
FAMILY_DIRECTORY = "family"
FAMILY_FILE = "lock"
STATE_DIRECTORY = "state"

# The configuration's settings, in the order the file lists them.
KEY_FAMILY = "family"
KEY_SHARED = "shared"
KEY_MAX_RUNS = "max_runs"
KEY_SLOTS = "slots"
KEY_SETTLE = "settle_seconds"
KEY_MIN_IDLE = "min_idle_percent"
CONFIG_KEYS = (KEY_FAMILY, KEY_SHARED, KEY_MAX_RUNS, KEY_SLOTS, KEY_SETTLE, KEY_MIN_IDLE)

# The last-decision record: one JSON object in the state directory, written under the gate by the
# waiter that made the decision.
LAST_DECISION_FILE = "last-decision.json"
DECISION_ADMIT = "admit"
DECISION_WAIT = "wait"
RECORD_DECISION = "decision"
RECORD_REASON = "reason"
RECORD_SLOT = "slot"  # the slot taken, or null for a wait
RECORD_AT = "at"  # the epoch second of the decision
RECORD_KEYS = (RECORD_DECISION, RECORD_REASON, RECORD_SLOT, RECORD_AT)

# The timing of a waiting run. These are constants and no setting: the script's own.
POLL_SECONDS = 10
TIMEOUT_SECONDS = 3600
RUN_LIMIT_SECONDS = 3600
STATUS_SECONDS = 300
KILL_GRACE_SECONDS = 10

# What a waiting run prints on stderr. LOCK-PROTOCOL.md section 5.1 binds these three lines with
# their prefix, which clients quote, and the holders listed under the first, each indented.
MESSAGE_PREFIX = "sim-lock: "
LINE_WAITING = MESSAGE_PREFIX + "waiting for a simulator run slot: {reason}; running now:"
LINE_STILL_WAITING = MESSAGE_PREFIX + "still waiting after {waited}s: {reason}"
LINE_GAVE_UP = MESSAGE_PREFIX + "gave up after {waited}s: {reason}"
HOLDER_INDENT = "  "

# What a state root with no configuration says, once, before its first waiting line: it runs on the
# broker's own defaults, its own family included. The plan says that such a root says so; the text
# is the broker's, and LOCK-PROTOCOL.md does not bind it.
NOTICE_UNCONFIGURED = (
    MESSAGE_PREFIX
    + "no configuration at {config}; the broker's own defaults apply, with the family {family}"
)

# The wrapper's own lines on stderr. LOCK-PROTOCOL.md section 5.5 does not bind them: the script's
# second line names a variable the broker does not read, so the broker's names the limit in seconds.
LINE_CANNOT_START = MESSAGE_PREFIX + "{command}: {reason}"
LINE_RUN_LIMIT = (
    MESSAGE_PREFIX
    + "command ran over the run limit of {limit}s and was killed; "
    + "its simulator may still be booted, so delete it"
)

# The client's verbs. The first word of a command line is one of these, or a request for the usage.
VERB_RUN = "run"
VERB_CONFIGURE = "configure"
VERB_STATUS = "status"
VERB_HELP = "help"
HELP_FLAGS = ("-h", "--help")

# The client's environment, which the dispatcher alone reads. A variable set to nothing counts as
# unset. The session's identifier is not read: nothing here consumes it.
HOME_VARIABLE = "HOME"
STATE_ROOT_SETTING = "CLAUDE_SIMULATORS_STATE_ROOT"
FAMILY_VARIABLE = "SIM_LOCK_FILE"
IGNORED_VARIABLE_PREFIX = "SIM_LOCK_"

# What a client says on stderr when its environment sets `sim-lock.sh`'s knobs, which it does not
# read: one line, naming each variable in name order, before anything else the verb prints. The text
# is the broker's, and LOCK-PROTOCOL.md does not bind it.
LINE_IGNORED = (
    MESSAGE_PREFIX
    + "ignoring {names}: the broker takes its settings from the state root's configuration, "
    + "never from the environment"
)

# The reasons a run waits, in the order the checks run. The first four are the script's, and
# LOCK-PROTOCOL.md section 3 binds their texts.
REASON_ALL_HELD = "all {slots} run slots are held"
REASON_SETTLING = "a run started less than {settle}s ago"
REASON_BUSY = "the CPU is {idle}% idle and a run needs {min_idle}%"
REASON_UNMEASURABLE = "the CPU's idle percentage cannot be measured"
# The broker's own: the script has no timeout on its measurement. A sample that outlasts the
# adapter's gives no idle reading, so it takes the same fallback as an unmeasurable one
# (LOCK-PROTOCOL.md section 3.2), and this is the reason it waits with beside another run.
REASON_SAMPLE_TIMED_OUT = "the CPU sample timed out after {seconds}s"
# What the last-decision record says when the checks passed.
REASON_ADMITTED = "the checks passed"

# The owner record's form: one line written to the taken slot's `.owner` file (LOCK-PROTOCOL.md
# section 2.3). `started` is the local time of the admission, in the form below, with no zone.
OWNER_RECORD = "pid={pid} slot={slot} cwd={cwd} started={started} command={command}"
OWNER_TIME_FORMAT = "%Y-%m-%dT%H:%M:%S"
