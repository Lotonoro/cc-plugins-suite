"""What the broker publishes, in one place.

`LOCK-PROTOCOL.md` states the lock family the broker shares with pango's `sim-lock.sh`, and
`PROTOCOL.md` states the client contract. The conformance test reads both files and fails when
one of them differs from a constant here. A `{name}` in a text below stands for the value the
broker puts there, where the script's own texts write `%s` or `${name}`.
"""

from __future__ import annotations

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

# The client's environment, which the dispatcher alone reads.
STATE_ROOT_SETTING = "CLAUDE_SIMULATORS_STATE_ROOT"
FAMILY_VARIABLE = "SIM_LOCK_FILE"
IGNORED_VARIABLE_PREFIX = "SIM_LOCK_"
SESSION_VARIABLE = "CLAUDE_CODE_SESSION_ID"

# The reasons a run waits, in the order the checks run. The first four are the script's, and
# LOCK-PROTOCOL.md section 3 binds their texts.
REASON_ALL_HELD = "all {slots} run slots are held"
REASON_SETTLING = "a run started less than {settle}s ago"
REASON_BUSY = "the CPU is {idle}% idle and a run needs {min_idle}%"
REASON_UNMEASURABLE = "the CPU's idle percentage cannot be measured"
# The broker's own: the script has no timeout on its measurement, and a sample that outlasts the
# adapter's is a reason to wait, not a reading.
REASON_SAMPLE_TIMED_OUT = "the CPU sample timed out after {seconds}s"
# What the last-decision record says when the checks passed.
REASON_ADMITTED = "the checks passed"
