"""Reads the two protocol files and compares what they publish with the broker's code.

`lock_protocol_differences` and `client_protocol_differences` take a file's text and return one
line for each place where it differs from `broker.protocol` or from what the broker's own classes
give: an exit code, a reason or message text, a record form, a default, a file name. An empty list
means the file and the code agree. They take the text, not the path, so a test can hand them a copy
with one thing changed and see that the change is found.

A file's structure is compared too: a table that lost a row, a section that was renamed or a text
that cannot be found is a difference, so no check passes by finding nothing.

In a protocol file's text, `%s`, `${name}` and `{name}` stand for the value put there, and the code
writes each as `{name}`: the files' names for them are mapped to the code's below.
"""

from __future__ import annotations

import os
import re
from typing import Callable, Dict, List, Mapping, Sequence, Tuple

from broker import machine, protocol
from broker.family import Family

DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK_PROTOCOL = os.path.join(DIRECTORY, "LOCK-PROTOCOL.md")
CLIENT_PROTOCOL = os.path.join(DIRECTORY, "PROTOCOL.md")

# The names the script's texts give the values in a reason, and the code's names for them.
REASON_VALUES = {
    "MAX_RUNS": "slots",
    "SETTLE_SECONDS": "settle",
    "idle": "idle",
    "MIN_IDLE_PERCENT": "min_idle",
}
SAMPLE_LOCK = "/sample/lock"

Row = List[str]


class Missing(Exception):
    """The file lacks a section, a table, a row or a text that a check looks for."""


def read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


# Reading the Markdown ---------------------------------------------------------------------------

_HEADING = re.compile(r"^(#+)\s+(.*)$")
_SPAN = re.compile(r"`([^`]+)`")


def section(text: str, title: str) -> str:
    """The text under the heading whose title starts with `title`, to the next heading above it."""
    lines = text.splitlines()
    start = level = -1
    in_fence = False
    for index, line in enumerate(lines):
        if line.startswith("```"):
            in_fence = not in_fence
        found = None if in_fence else _HEADING.match(line)
        if found is None:
            continue
        if start < 0 and found.group(2).startswith(title):
            start, level = index + 1, len(found.group(1))
        elif start >= 0 and len(found.group(1)) <= level:
            return "\n".join(lines[start:index])
    if start < 0:
        raise Missing(f"no section titled {title!r}")
    return "\n".join(lines[start:])


def first_table(block: str, minimum_rows: int = 1) -> List[Row]:
    """The rows of the first table in `block`, without its header and its rule."""
    rows: List[Row] = []
    for line in block.splitlines():
        if line.startswith("|"):
            rows.append([cell.strip() for cell in line.strip().strip("|").split("|")])
        elif rows:
            break
    body = rows[2:]
    if len(body) < minimum_rows:
        raise Missing(f"a table of at least {minimum_rows} rows was expected, and {len(body)} found")
    return body


def spans(cell: str) -> List[str]:
    """The code spans of a table cell."""
    return _SPAN.findall(cell)


def span_of(cell: str) -> str:
    found = spans(cell)
    if not found:
        raise Missing(f"no code span in {cell!r}")
    return found[0]


def whole_number(cell: str) -> int:
    if not cell.isdigit():
        raise Missing(f"{cell!r} is not a whole number")
    return int(cell)


def fill(text: str, names: Sequence[str]) -> str:
    """`text` with each `%s`, in order, written as `{name}` with the next of `names`."""
    parts = text.split("%s")
    if len(parts) != len(names) + 1:
        raise Missing(f"{text!r} has {len(parts) - 1} values, and {len(names)} were expected")
    return parts[0] + "".join("{" + name + "}" + rest for name, rest in zip(names, parts[1:]))


def named(text: str, names: Mapping[str, str]) -> str:
    """`text` with each `${name}` written as `{code's name}`."""

    def rename(match: "re.Match[str]") -> str:
        if match.group(1) not in names:
            raise Missing(f"{match.group(0)} in {text!r} is a value the code does not name")
        return "{" + names[match.group(1)] + "}"

    return re.sub(r"\$\{(\w+)\}", rename, text)


def by_phrase(cell: str, phrases: Mapping[str, str]) -> str:
    """The one name whose phrase `cell` contains."""
    found = [name for phrase, name in phrases.items() if phrase in cell]
    if len(found) != 1:
        raise Missing(f"{cell!r} should match one row of the code's, and matches {found}")
    return found[0]


def keyed(rows: Sequence[Tuple[str, object]], what: str, found: List[str]) -> Dict[str, object]:
    """`rows` as a mapping, reporting a key that two rows give."""
    mapping: Dict[str, object] = {}
    for key, value in rows:
        if key in mapping:
            found.append(f"{what}: {key!r} is given twice")
        mapping[key] = value
    return mapping


def compare(
    found: List[str], what: str, doc: Mapping[str, object], code: Mapping[str, object]
) -> None:
    """Reports each key only one side has, and each value the two sides give differently."""
    for key in sorted(set(doc) - set(code)):
        found.append(f"{what}: the file has {key!r}, which the code does not")
    for key in sorted(set(code) - set(doc)):
        found.append(f"{what}: the code has {key!r}, which the file does not")
    for key in sorted(set(doc) & set(code)):
        if doc[key] != code[key]:
            found.append(f"{what} {key}: the file says {doc[key]!r}, the code {code[key]!r}")


# What the code gives, for the checks to compare ---------------------------------------------------

EXIT_NAMES = (
    "EXIT_USAGE",
    "EXIT_TIMEOUT",
    "EXIT_CONFIG",
    "EXIT_FAMILY_DISAGREES",
    "EXIT_RUN_LIMIT",
    "EXIT_CANNOT_EXECUTE",
    "EXIT_NOT_FOUND",
)


def exit_codes(table: Sequence[Row], phrases: Mapping[str, str], what: str) -> List[str]:
    """Each numeric row of an exit-code table against the constant its "When" cell describes."""
    found: List[str] = []
    rows = [
        (by_phrase(row[1], phrases), whole_number(row[0])) for row in table if row[0].isdigit()
    ]
    doc = keyed(rows, what, found)
    compare(found, what, doc, {name: getattr(protocol, name) for name in phrases.values()})
    firsts = {row[0] for row in table}
    for form in ("128+N", "the command's own status"):
        if form not in firsts:
            found.append(f"{what}: no row for {form!r}")
    return found


# The checks of LOCK-PROTOCOL.md -------------------------------------------------------------------


def check_lock_defaults(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "1. Settings"), 8)
    doc = keyed([(r[0].split(",")[0].strip(), whole_number(r[2])) for r in rows], "section 1", found)
    code = {
        "MAX_RUNS": protocol.DEFAULT_MAX_RUNS,
        "MIN_IDLE_PERCENT": protocol.DEFAULT_MIN_IDLE_PERCENT,
        "SETTLE_SECONDS": protocol.DEFAULT_SETTLE_SECONDS,
        "POLL_SECONDS": protocol.POLL_SECONDS,
        "TIMEOUT_SECONDS": protocol.TIMEOUT_SECONDS,
        "RUN_LIMIT_SECONDS": protocol.RUN_LIMIT_SECONDS,
        "STATUS_SECONDS": protocol.STATUS_SECONDS,
        "KILL_GRACE_SECONDS": protocol.KILL_GRACE_SECONDS,
    }
    compare(found, "section 1 default", doc, code)
    for row in rows:
        for variable in spans(row[1]):
            if not variable.startswith(protocol.IGNORED_VARIABLE_PREFIX):
                found.append(f"section 1: {variable} lacks the prefix {protocol.IGNORED_VARIABLE_PREFIX}")
    return found


def check_lock_files(text: str) -> List[str]:
    found: List[str] = []
    family = Family(SAMPLE_LOCK, slots=3, window=3)
    kinds = set()
    for row in first_table(section(text, "2. The lock family"), 5):
        for name in spans(row[0]):
            kind, path = _family_file(family, name)
            kinds.add(kind)
            if name.replace("<lock>", SAMPLE_LOCK) != path:
                found.append(f"section 2 {name}: the file's path differs from the code's {path!r}")
    for kind in ("slot", "gate", "last-start", "owner"):
        if kind not in kinds:
            found.append(f"section 2: no file of the kind {kind!r}")
    return found


def _family_file(family: Family, name: str) -> Tuple[str, str]:
    """The kind of a family file the protocol names, and the path the code gives that kind."""
    if name == "<lock>":
        return "slot", family.slot_path(0)
    if name == "<lock>.gate":
        return "gate", family.gate_path
    if name == "<lock>.last-start":
        return "last-start", family.last_start_path
    if name == "<lock>.owner":
        return "owner", family.owner_path(0)
    slot = re.fullmatch(r"<lock>\.(\d+)", name)
    if slot:
        return "slot", family.slot_path(int(slot.group(1)))
    owner = re.fullmatch(r"<lock>\.(\d+)\.owner", name)
    if owner:
        return "owner", family.owner_path(int(owner.group(1)))
    raise Missing(f"section 2 names {name!r}, which is no file the code knows")


def default_lock(text: str) -> str:
    """The path section 2 gives as the script's default lock."""
    flat = " ".join(section(text, "2. The lock family").split())
    found = re.search(r"`(/[^`]+)` when that is unset or empty", flat)
    if found is None:
        raise Missing("section 2 gives no default lock")
    return found.group(1)


def default_lock_count(text: str) -> int:
    """The one MAX_RUNS section 4 says the script keeps on the default lock's family."""
    flat = " ".join(section(text, "4. The shared-slot rule").split())
    found = re.search(r"refuses a `SIM_LOCK_MAX_RUNS` other than (\d+)", flat)
    if found is None:
        raise Missing("section 4 gives no count that the default lock's family keeps")
    return int(found.group(1))


def family_files(text: str, lock: str) -> List[str]:
    """Each file of a family at `lock` that section 2's table names, with `<lock>` filled in."""
    rows = first_table(section(text, "2. The lock family"), 5)
    return [name.replace("<lock>", lock) for row in rows for name in spans(row[0])]


def says_default_locks_family_must_be_shared(text: str) -> bool:
    """Whether section 4 says that a family in the default lock's family must be shared."""
    return "a family in it must be shared" in " ".join(section(text, "4. The shared-slot rule").split())


def check_lock_default_family(text: str) -> List[str]:
    found: List[str] = []
    compare(found, "the default lock's", {"path": default_lock(text)}, {"path": protocol.DEFAULT_LOCK_FILE})
    compare(
        found,
        "the default lock's",
        {"count": default_lock_count(text)},
        {"count": protocol.DEFAULT_MAX_RUNS},
    )
    if not says_default_locks_family_must_be_shared(text):
        found.append("the default lock's sharing: section 4 does not say that a family in its family must be shared")
    return found


def check_lock_owner_record(text: str) -> List[str]:
    found: List[str] = []
    block = section(text, "2.3 The records")
    form = re.search(r"one line, `([^`]+)`", block)
    if form is None:
        raise Missing("section 2.3 gives no owner record form")
    record = fill(form.group(1), ("pid", "slot", "cwd", "started", "command"))
    compare(found, "owner record", {"form": record}, {"form": protocol.OWNER_RECORD})
    stamp = re.search(r"date '\+([^']+)'", block)
    if stamp is None:
        raise Missing("section 2.3 gives no time format")
    compare(found, "owner record", {"time": stamp.group(1)}, {"time": protocol.OWNER_TIME_FORMAT})
    return found


def check_lock_reasons(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "3. Admission"), 5)
    doc = keyed(
        [(f"check {r[0]}", named(span_of(r[2]), REASON_VALUES)) for r in rows], "section 3", found
    )
    code = {
        "check 1": protocol.REASON_ALL_HELD,
        "check 2": protocol.REASON_SETTLING,
        "check 3": protocol.REASON_BUSY,
        "check 4": protocol.REASON_UNMEASURABLE,
        "check 5": protocol.REASON_ALL_HELD,
    }
    compare(found, "section 3 reason", doc, code)
    return found


def check_lock_iostat(text: str) -> List[str]:
    found: List[str] = []
    command = re.search(r"`(iostat [^`]+)`", section(text, "3.1 The CPU sample"))
    if command is None:
        raise Missing("section 3.1 gives no iostat command")
    compare(found, "the CPU sample", {"command": command.group(1)}, {"command": " ".join(machine.IOSTAT)})
    return found


def check_lock_fallback_decided(text: str) -> List[str]:
    found: List[str] = []
    block = section(text, "3.2 The unmeasurable-idle fallback")
    if "#546" not in block:
        found.append("section 3.2 does not name the pango PR that decided the fallback")
    if "provisional" in text.lower():
        found.append("the file still calls something provisional")
    return found


def check_lock_waiting_lines(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "5.1 Waiting"), 3)
    phrases = {
        "the first failed attempt": "waiting",
        "repeat mark": "still waiting",
        "TIMEOUT_SECONDS": "gave up",
    }
    names = {
        "waiting": ("reason",),
        "still waiting": ("waited", "reason"),
        "gave up": ("waited", "reason"),
    }
    doc = keyed(
        [
            (by_phrase(r[0], phrases), fill(span_of(r[1]), names[by_phrase(r[0], phrases)]))
            for r in rows
        ],
        "section 5.1",
        found,
    )
    code = {
        "waiting": protocol.LINE_WAITING,
        "still waiting": protocol.LINE_STILL_WAITING,
        "gave up": protocol.LINE_GAVE_UP,
    }
    compare(found, "section 5.1 line", doc, code)
    return found


def check_lock_exit_codes(text: str) -> List[str]:
    phrases = {
        "the wait reached": "EXIT_TIMEOUT",
        "ran over RUN_LIMIT_SECONDS": "EXIT_RUN_LIMIT",
        "ENOENT": "EXIT_NOT_FOUND",
        "any other operating-system error": "EXIT_CANNOT_EXECUTE",
    }
    return exit_codes(first_table(section(text, "5.5 Exit codes"), 6), phrases, "section 5.5 exit")


LOCK_CHECKS: Tuple[Callable[[str], List[str]], ...] = (
    check_lock_defaults,
    check_lock_files,
    check_lock_default_family,
    check_lock_owner_record,
    check_lock_reasons,
    check_lock_iostat,
    check_lock_fallback_decided,
    check_lock_waiting_lines,
    check_lock_exit_codes,
)

# The checks of PROTOCOL.md --------------------------------------------------------------------------


def check_client_version(text: str) -> List[str]:
    found: List[str] = []
    stated = re.search(r"The protocol's version is (\d+)\.", section(text, "Version"))
    if stated is None:
        raise Missing("no version is stated")
    compare(found, "the version", {"number": int(stated.group(1))}, {"number": protocol.PROTOCOL_VERSION})
    return found


def check_client_verbs(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "Verbs"), 4)
    usage = {span_of(row[0]).split()[0]: row for row in rows}
    code_verbs = {protocol.VERB_RUN, protocol.VERB_CONFIGURE, protocol.VERB_STATUS, protocol.VERB_HELP}
    compare(found, "verb", {v: True for v in usage}, {v: True for v in code_verbs})
    if protocol.VERB_CONFIGURE in usage:
        options = set(re.findall(r"--[a-z-]+", span_of(usage[protocol.VERB_CONFIGURE][0])))
        wanted = {"--" + key.replace("_", "-") for key in protocol.CONFIG_KEYS}
        compare(found, "configure option", {o: True for o in options}, {o: True for o in wanted})
    if protocol.VERB_HELP in usage:
        compare(
            found,
            "help flags",
            {"flags": tuple(spans(usage[protocol.VERB_HELP][1]))},
            {"flags": protocol.HELP_FLAGS},
        )
    return found


def check_client_environment(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "The environment"), 5)
    variables = {span_of(row[0]): row for row in rows}
    code = {
        protocol.STATE_ROOT_SETTING,
        protocol.HOME_VARIABLE,
        protocol.PWD_VARIABLE,
        protocol.FAMILY_VARIABLE,
        protocol.IGNORED_VARIABLE_PREFIX + "*",
    }
    compare(found, "variable", {v: True for v in variables}, {v: True for v in code})
    home = variables.get(protocol.HOME_VARIABLE)
    if home is not None:
        compare(
            found,
            "the default state root",
            {"path": spans(home[1])[0] if spans(home[1]) else None},
            {"path": "/".join(protocol.DEFAULT_ROOT_PARTS)},
        )
    family = variables.get(protocol.FAMILY_VARIABLE)
    if family is not None and str(protocol.EXIT_FAMILY_DISAGREES) not in family[1]:
        found.append(f"the family variable's row does not give the code {protocol.EXIT_FAMILY_DISAGREES}")
    return found


def check_client_root(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "The state root"), 4)
    code = {
        protocol.CONFIG_FILE,
        f"{protocol.FAMILY_DIRECTORY}/{protocol.FAMILY_FILE}",
        protocol.STATE_DIRECTORY,
        f"{protocol.STATE_DIRECTORY}/{protocol.LAST_DECISION_FILE}",
    }
    compare(found, "root path", {span_of(r[0]): True for r in rows}, {p: True for p in code})
    return found


def check_client_exit_codes(text: str) -> List[str]:
    phrases = {
        "is not one the client takes": "EXIT_USAGE",
        "the wait reached": "EXIT_TIMEOUT",
        "cannot be read, written or used": "EXIT_CONFIG",
        "is not the state root's family": "EXIT_FAMILY_DISAGREES",
        "ran over the run limit": "EXIT_RUN_LIMIT",
        "other than a missing file": "EXIT_CANNOT_EXECUTE",
        "a file is missing": "EXIT_NOT_FOUND",
    }
    return exit_codes(first_table(section(text, "Exit codes"), 9), phrases, "exit")


def check_client_configuration(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "The configuration"), len(protocol.CONFIG_KEYS))
    by_key = {span_of(row[0]): row for row in rows}
    compare(
        found,
        "setting",
        {key: True for key in by_key},
        {key: True for key in protocol.CONFIG_KEYS},
    )
    if list(by_key) != list(protocol.CONFIG_KEYS):
        found.append(f"settings are listed in the order {list(by_key)}, not {list(protocol.CONFIG_KEYS)}")
    defaults = {
        protocol.KEY_MAX_RUNS: protocol.DEFAULT_MAX_RUNS,
        protocol.KEY_SETTLE: protocol.DEFAULT_SETTLE_SECONDS,
        protocol.KEY_MIN_IDLE: protocol.DEFAULT_MIN_IDLE_PERCENT,
    }
    compare(
        found,
        "default",
        {key: whole_number(by_key[key][2]) for key in defaults if key in by_key},
        {key: value for key, value in defaults.items() if key in by_key},
    )
    if protocol.KEY_FAMILY in by_key:
        compare(
            found,
            "default family",
            {"path": span_of(by_key[protocol.KEY_FAMILY][2])},
            {"path": f"{protocol.FAMILY_DIRECTORY}/{protocol.FAMILY_FILE}"},
        )
    if protocol.KEY_SLOTS in by_key:
        floor = re.search(r"max\((\d+), cores / (\d+)\)", by_key[protocol.KEY_SLOTS][2])
        if floor is None:
            raise Missing("the slots' default is not max(N, cores / M)")
        compare(
            found,
            "default slots",
            {"floor and cores per slot": (int(floor.group(1)), int(floor.group(2)))},
            {"floor and cores per slot": (protocol.SLOT_FLOOR, protocol.CORES_PER_SLOT)},
        )
    for key, limit in (
        (protocol.KEY_SETTLE, protocol.MAX_SETTLE_SECONDS),
        (protocol.KEY_MIN_IDLE, protocol.MAX_MIN_IDLE_PERCENT),
    ):
        if key not in by_key:
            continue
        digits = re.search(r"at most (\d+) digits", by_key[key][3])
        if digits is None:
            raise Missing(f"the range of {key} does not say how many digits")
        compare(found, "largest", {key: 10 ** int(digits.group(1)) - 1}, {key: limit})
    return found


def check_client_last_decision(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "The last decision"), len(protocol.RECORD_KEYS))
    fields = {span_of(row[0]): row for row in rows}
    if list(fields) != list(protocol.RECORD_KEYS):
        found.append(f"fields are listed as {list(fields)}, and the code writes {list(protocol.RECORD_KEYS)}")
    values = {
        protocol.RECORD_DECISION: [protocol.DECISION_ADMIT, protocol.DECISION_WAIT],
        protocol.RECORD_SLOT: ["null"],
    }
    for field, wanted in values.items():
        if field in fields and spans(fields[field][1]) != wanted:
            found.append(f"the field {field!r} says {spans(fields[field][1])}, and the code {wanted}")
    reason = fields.get(protocol.RECORD_REASON)
    if reason is not None and protocol.REASON_ADMITTED not in spans(reason[1]):
        found.append(f"the field 'reason' does not give {protocol.REASON_ADMITTED!r}")
    return found


def check_client_reasons(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "Reasons"), 1)
    compare(
        found,
        "reason",
        {"sample timeout": span_of(rows[0][1])},
        {"sample timeout": protocol.REASON_SAMPLE_TIMED_OUT},
    )
    return found


def check_client_lines(text: str) -> List[str]:
    found: List[str] = []
    rows = first_table(section(text, "Lines on stderr"), 4)
    phrases = {
        "SIM_LOCK_*": "ignored",
        "has no configuration": "unconfigured",
        "cannot be started": "cannot start",
        "ran over the run limit": "run limit",
    }
    doc = keyed([(by_phrase(r[0], phrases), span_of(r[1])) for r in rows], "stderr", found)
    code = {
        "ignored": protocol.LINE_IGNORED,
        "unconfigured": protocol.NOTICE_UNCONFIGURED,
        "cannot start": protocol.LINE_CANNOT_START,
        "run limit": protocol.LINE_RUN_LIMIT,
    }
    compare(found, "line", doc, code)
    return found


CLIENT_CHECKS: Tuple[Callable[[str], List[str]], ...] = (
    check_client_version,
    check_client_verbs,
    check_client_environment,
    check_client_root,
    check_client_exit_codes,
    check_client_configuration,
    check_client_last_decision,
    check_client_reasons,
    check_client_lines,
)


def _differences(checks: Sequence[Callable[[str], List[str]]], text: str) -> List[str]:
    found: List[str] = []
    for check in checks:
        try:
            found.extend(check(text))
        except Missing as err:
            found.append(f"{check.__name__}: {err}")
    return found


def lock_protocol_differences(text: str) -> List[str]:
    """Where the text of LOCK-PROTOCOL.md differs from the code."""
    return _differences(LOCK_CHECKS, text)


def client_protocol_differences(text: str) -> List[str]:
    """Where the text of PROTOCOL.md differs from the code."""
    return _differences(CLIENT_CHECKS, text)
