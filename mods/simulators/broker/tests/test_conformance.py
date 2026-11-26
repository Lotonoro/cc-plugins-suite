"""The conformance suite: the two protocol files against the code, and a case for each item the broker
carries over from `sim-lock.sh`.

- `ParityTest` reads `LOCK-PROTOCOL.md` and `PROTOCOL.md` and fails when an exit code, a reason or
  message text, a record field, a default or a file name in either differs from the code.
- `NegativeControlTest` changes one thing at a time in a copy of each file and shows that the
  comparison finds it, and that the comparison cannot pass on a file with nothing in it.
- One case for each item of the plan's "What carries over from sim-lock.sh":
  `AdmissionCase`, `UnmeasurableIdleFallbackCase`, `WaitingCase`, `RunningCase`, `DefaultsCase`,
  `FileFamilyAndRecordsCase`, `SharedLockProtocolCase` and `SharedSlotRuleCase`. A case expects the
  texts and numbers that the protocol files give, read out of them, and drives the broker's own
  classes on a scratch family with fakes for the clock and the machine, so a code that drifts from
  its file fails the case that drives it. `RunningCase` runs the real wrapper, on macOS only.

The unmeasurable-idle fallback is decided and final (pango PR #546, 68e6e8af). Its case carries no
provisional marker, and the file's own text is checked for none.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
import unittest
from io import StringIO
from typing import Callable, List, Optional, Tuple
from unittest import mock

from broker import protocol
from broker.clock import local_stamp
from broker.decisions import DecisionStore
from broker.errors import ConfigError
from broker.family import Family
from broker.leaf import Admitted, Applicant, TakeTimeLeaf, Waiting
from broker.policy import Measured, Sample, TimedOut, Unmeasurable
from broker.runner import RunLimits, metered_run
from broker.settings import Config, load_config
from broker.tests import programs
from broker.tests.conformance import (
    CLIENT_PROTOCOL,
    LOCK_PROTOCOL,
    REASON_VALUES,
    client_protocol_differences,
    default_lock,
    default_lock_count,
    family_files,
    fill,
    first_table,
    lock_protocol_differences,
    named,
    read,
    section,
    span_of,
    whole_number,
)
from broker.tests.process_case import (
    ONLY_ON_MACOS,
    ClientCase,
    children_of,
    pid_is_alive,
    wait_until,
)
from broker.tests.support import (
    EPOCH,
    FakeClock,
    FakeMachine,
    SpyFamily,
    gate_is_held,
    hold_in_another_process,
    scratch_dir,
)
from broker.waiter import GaveUp, Timing, Waiter

LOCK_TEXT = read(LOCK_PROTOCOL)
CLIENT_TEXT = read(CLIENT_PROTOCOL)

APPLICANT = Applicant(pid=4242, cwd="/tmp/work", command=("xcodebuild", "test"))


class Docs:
    """What the two protocol files say, read out of them for a case to expect."""

    @staticmethod
    def added_reason() -> str:
        """The text `PROTOCOL.md` gives its one added reason, with `{seconds}` left in."""
        (row,) = first_table(section(CLIENT_TEXT, "Reasons"), 1)
        return span_of(row[1])

    @staticmethod
    def reason(check: int) -> str:
        """The text of check `check` of section 3, its values written as `{slots}` and the like."""
        for row in first_table(section(LOCK_TEXT, "3. Admission")):
            if row[0] == str(check):
                return named(span_of(row[2]), REASON_VALUES)
        raise AssertionError(f"section 3 has no check {check}")

    @staticmethod
    def waiting_lines() -> Tuple[str, str, str]:
        """The first-wait, repeat and give-up lines of section 5.1, with `{reason}` and `{waited}`."""
        rows = first_table(section(LOCK_TEXT, "5.1 Waiting"), 3)
        return (
            fill(span_of(rows[0][1]), ("reason",)),
            fill(span_of(rows[1][1]), ("waited", "reason")),
            fill(span_of(rows[2][1]), ("waited", "reason")),
        )

    @staticmethod
    def exit_code(phrase: str) -> int:
        """The exit code of the row of section 5.5 whose "When" cell holds `phrase`."""
        for row in first_table(section(LOCK_TEXT, "5.5 Exit codes")):
            if phrase in row[1]:
                return whole_number(row[0])
        raise AssertionError(f"section 5.5 has no row with {phrase!r}")

    @staticmethod
    def signal_base() -> int:
        """The N of "N+signal" in section 5.5: what a command killed by a signal exits with."""
        for row in first_table(section(LOCK_TEXT, "5.5 Exit codes")):
            if "+N" in row[0]:
                return whole_number(row[0].split("+")[0])
        raise AssertionError("section 5.5 has no row for a signal")

    @staticmethod
    def default(setting: str) -> int:
        """The default of a setting in section 1, by the first word of its name."""
        for row in first_table(section(LOCK_TEXT, "1. Settings")):
            if row[0].split(",")[0].strip() == setting:
                return whole_number(row[2])
        raise AssertionError(f"section 1 has no setting {setting}")

    @staticmethod
    def default_lock() -> str:
        """The path section 2 gives as the script's default lock."""
        return default_lock(LOCK_TEXT)

    @staticmethod
    def default_lock_count() -> int:
        """The one MAX_RUNS section 4 says the script keeps on the default lock's family."""
        return default_lock_count(LOCK_TEXT)

    @staticmethod
    def family_files(lock: str) -> List[str]:
        """Each file of a family at `lock` that section 2's table names."""
        return family_files(LOCK_TEXT, lock)

    @staticmethod
    def owner_record(pid: int, slot: int, cwd: str, started: str, command: str) -> str:
        form = re.search(r"one line, `([^`]+)`", section(LOCK_TEXT, "2.3 The records"))
        assert form is not None
        text = fill(form.group(1), ("pid", "slot", "cwd", "started", "command"))
        return text.format(pid=pid, slot=slot, cwd=cwd, started=started, command=command)


class ParityTest(unittest.TestCase):
    def test_lock_protocol_says_what_the_code_does(self) -> None:
        self.assertEqual(lock_protocol_differences(LOCK_TEXT), [])

    def test_the_client_protocol_says_what_the_code_does(self) -> None:
        self.assertEqual(client_protocol_differences(CLIENT_TEXT), [])


# (what changes, the text it starts from, what it becomes, a word the difference found must hold)
LOCK_CHANGES = (
    ("an exit code", "| 75 | the wait reached", "| 76 | the wait reached", "EXIT_TIMEOUT"),
    ("an exit code", "| 124 | the command ran over", "| 125 | the command ran over", "EXIT_RUN_LIMIT"),
    ("an exit code", "| 127 | starting", "| 128 | starting", "EXIT_NOT_FOUND"),
    ("an exit code", "| 126 | starting", "| 125 | starting", "EXIT_CANNOT_EXECUTE"),
    ("a reason", "`all ${MAX_RUNS} run slots are held`", "`all ${MAX_RUNS} slots are held`", "check 1"),
    ("a reason", "less than ${SETTLE_SECONDS}s ago`", "less than ${SETTLE_SECONDS} seconds ago`", "check 2"),
    ("a reason", "needs ${MIN_IDLE_PERCENT}%`", "needs ${MIN_IDLE_PERCENT} percent`", "check 3"),
    ("a reason", "idle percentage cannot be measured`", "idle percentage cannot be read`", "check 4"),
    ("a lost row", "| 4 | section 3.2:", "| 6 | section 3.2:", "check 4"),
    ("the waiting line", "run slot: %s; running now:`", "slot: %s; running now:`", "waiting"),
    ("the repeat line", "`sim-lock: still waiting after %ss: %s`", "`sim-lock: still waiting after %s: %s`", "still waiting"),
    ("the give-up line", "`sim-lock: gave up after %ss: %s`", "`sim-lock: gave up after %ss, %s`", "gave up"),
    ("the prefix", "`sim-lock: gave up after %ss: %s`", "`gave up after %ss: %s`", "gave up"),
    ("the owner record", "cwd=%s started=%s", "dir=%s started=%s", "owner record"),
    ("the time format", "date '+%Y-%m-%dT%H:%M:%S'", "date '+%Y-%m-%d %H:%M:%S'", "owner record"),
    ("a default", "| `SIM_LOCK_MAX_RUNS` | 3 |", "| `SIM_LOCK_MAX_RUNS` | 4 |", "MAX_RUNS"),
    ("a default", "| `SIM_LOCK_SETTLE` | 90 |", "| `SIM_LOCK_SETTLE` | 60 |", "SETTLE_SECONDS"),
    ("a default", "| `SIM_LOCK_STATUS` | 300 |", "| `SIM_LOCK_STATUS` | 600 |", "STATUS_SECONDS"),
    ("a default", "| none | 10 |", "| none | 15 |", "KILL_GRACE_SECONDS"),
    ("the default lock's path", "`/tmp/pango-sim-test.flock` when that is unset", "`/tmp/pango-sim.flock` when that is unset", "the default lock's path"),
    ("the default lock's count", "refuses a `SIM_LOCK_MAX_RUNS` other than 3", "refuses a `SIM_LOCK_MAX_RUNS` other than 4", "the default lock's count"),
    ("a file's name", "| `<lock>.last-start` |", "| `<lock>.laststart` |", "section 2"),
    ("the gate's name", "| `<lock>.gate` |", "| `<lock>.lock` |", "section 2"),
    ("the owner file's name", "`<lock>.owner`, `<lock>.1.owner`", "`<lock>.own`, `<lock>.1.own`", "section 2"),
    ("the sample's command", "`iostat -c 2 -w 1 -n 0`", "`iostat -c 2 -w 2 -n 0`", "the CPU sample"),
    ("a provisional marker", "This rule is decided:", "This rule is provisional:", "provisional"),
    ("a section's title", "## 3. Admission", "## 3. Admittance", "no section titled"),
)

CLIENT_CHANGES = (
    ("the version", "The protocol's version is 1.", "The protocol's version is 2.", "the version"),
    ("an exit code", "| 64 |", "| 65 |", "EXIT_USAGE"),
    ("an exit code", "| 75 |", "| 76 |", "EXIT_TIMEOUT"),
    ("an exit code", "| 78 |", "| 77 |", "EXIT_CONFIG"),
    ("an exit code", "| 79 |", "| 80 |", "EXIT_FAMILY_DISAGREES"),
    ("an exit code", "| 124 |", "| 125 |", "EXIT_RUN_LIMIT"),
    ("an exit code", "| 126 |", "| 125 |", "EXIT_CANNOT_EXECUTE"),
    ("an exit code", "| 127 |", "| 128 |", "EXIT_NOT_FOUND"),
    ("a verb", "| `status` |", "| `state` |", "verb"),
    ("an option", "[--slots N]", "[--slot N]", "configure option"),
    ("the help flags", "`-h` and `--help`", "`-h` and `--usage`", "help flags"),
    ("the state root's setting", "| `CLAUDE_SIMULATORS_STATE_ROOT` |", "| `CLAUDE_SIM_ROOT` |", "variable"),
    ("the working directory's variable", "| `PWD` |", "| `CWD` |", "variable"),
    ("the default root", "`Library/Application Support/claude-simulators`", "`Library/Application Support/claude-sims`", "default state root"),
    ("the family variable's code", "the client exits 79", "the client exits 80", "family variable"),
    ("a path in the root", "| `state/last-decision.json` |", "| `state/last.json` |", "root path"),
    ("a setting", "| `min_idle_percent` |", "| `min_idle` |", "setting"),
    ("a default", "| 90 |", "| 60 |", "default"),
    ("a range", "at most 7 digits", "at most 6 digits", "largest"),
    ("the slots' default", "`max(3, cores / 4)`", "`max(3, cores / 3)`", "default slots"),
    ("a record field", "| `at` |", "| `time` |", "fields are listed"),
    ("a decision value", "`admit` or `wait`", "`admitted` or `wait`", "the field 'decision'"),
    ("the admitted reason", "`the checks passed`", "`ok`", "the field 'reason'"),
    ("the added reason", "after {seconds}s`", "after {seconds} s`", "sample timeout"),
    ("the ignored line", "`sim-lock: ignoring {names}:", "`sim-lock: ignoring {names} :", "line ignored"),
    ("the notice", "the broker's own defaults apply", "the broker's defaults apply", "line unconfigured"),
    ("the cannot-start line", "`sim-lock: {command}: {reason}`", "`sim-lock: {command} - {reason}`", "line cannot start"),
    ("the run-limit line", "of {limit}s and was killed", "of {limit} seconds and was killed", "line run limit"),
)  # fmt: skip


class NegativeControlTest(unittest.TestCase):
    """A change to one thing in a file is found, and a check cannot pass by finding nothing."""

    def changes_are_found(
        self,
        text: str,
        changes: Tuple[Tuple[str, str, str, str], ...],
        find: Callable[[str], List[str]],
    ) -> None:
        for what, old, new, word in changes:
            with self.subTest(what=what, old=old):
                self.assertIn(old, text, "the text this change starts from is not in the file")
                found = find(text.replace(old, new, 1))
                self.assertTrue(any(word in line for line in found), f"{word!r} not in {found}")

    def test_each_change_to_lock_protocol_is_found(self) -> None:
        self.changes_are_found(LOCK_TEXT, LOCK_CHANGES, lock_protocol_differences)

    def test_each_change_to_the_client_protocol_is_found(self) -> None:
        self.changes_are_found(CLIENT_TEXT, CLIENT_CHANGES, client_protocol_differences)

    def test_a_file_with_nothing_in_it_differs_in_every_check(self) -> None:
        self.assertGreaterEqual(len(lock_protocol_differences("")), 9)
        self.assertGreaterEqual(len(client_protocol_differences("")), 9)

    def test_a_change_to_one_thing_is_found_in_that_check_alone(self) -> None:
        found = lock_protocol_differences(LOCK_TEXT.replace("| 75 | the wait reached", "| 76 | the wait reached", 1))
        self.assertEqual(len(found), 1, found)


class ConformanceCase(unittest.TestCase):
    """A scratch family, a fake clock and machine, and a leaf over them."""

    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.lock = os.path.join(self.dir, "lock")
        self.state = os.path.join(self.dir, "state")
        self.clock = FakeClock()
        self.machine = FakeMachine(clock=self.clock)
        self.decisions = DecisionStore(self.state)
        self.family: Optional[SpyFamily] = None

    def leaf(
        self,
        slots: int = 3,
        window: Optional[int] = None,
        settle: int = 90,
        min_idle: int = 50,
        refuse_takes: int = 0,
        cpu: Optional[List[Sample]] = None,
    ) -> TakeTimeLeaf:
        window = window or slots
        if cpu is not None:
            self.machine.cpu = tuple(cpu)
        self.family = SpyFamily(self.lock, slots=slots, window=window, refuse_takes=refuse_takes)
        return TakeTimeLeaf(self.family, settle, min_idle, self.machine, self.clock, self.decisions)

    def attempt(self, leaf: TakeTimeLeaf) -> object:
        got = leaf.attempt(APPLICANT)
        if isinstance(got, Admitted):
            self.addCleanup(self.close_quietly, got.fd)
        return got

    def close_quietly(self, fd: int) -> None:
        try:
            os.close(fd)
        except OSError:
            pass  # the test closed it already

    def slot_of(self, got: object) -> int:
        """The slot an attempt took, which the test asserts it did take one."""
        self.assertIsInstance(got, Admitted)
        assert isinstance(got, Admitted)
        return got.slot

    def hold(self, *slots: int) -> None:
        for slot in slots:
            hold_in_another_process(self, self.lock if slot == 0 else f"{self.lock}.{slot}")

    def read(self, suffix: str) -> str:
        with open(self.lock + suffix, encoding="utf-8") as handle:
            return handle.read()

    def write(self, suffix: str, text: str) -> None:
        with open(self.lock + suffix, "w", encoding="utf-8") as handle:
            handle.write(text)


class AdmissionCase(ConformanceCase):
    """Item "Admission": the checks run in the file's order, each with the file's reason."""

    def test_a_lone_run_starts_when_the_cpu_is_idle_enough_after_one_sample(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)
        self.assertEqual(self.machine.cpu_calls, 1)

    def test_a_run_at_exactly_the_minimum_idle_starts(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf(cpu=[Measured(50)])), Admitted)

    def test_the_cpu_check_applies_to_a_lone_run_and_gives_the_files_reason(self) -> None:
        got = self.attempt(self.leaf(cpu=[Measured(49)]))
        self.assertEqual(got, Waiting(Docs.reason(3).format(idle=49, min_idle=50)))

    def test_the_cpu_check_applies_beside_another_run_too(self) -> None:
        self.hold(0)  # no .last-start, so the settle time has passed
        got = self.attempt(self.leaf(cpu=[Measured(10)]))
        self.assertEqual(got, Waiting(Docs.reason(3).format(idle=10, min_idle=50)))

    def test_beside_another_run_a_start_waits_for_the_settle_time_and_samples_nothing(self) -> None:
        self.hold(0)
        self.write(".last-start", f"{EPOCH - 89}\n")
        got = self.attempt(self.leaf())
        self.assertEqual(got, Waiting(Docs.reason(2).format(settle=90)))
        self.assertEqual(self.machine.cpu_calls, 0)

    def test_beside_another_run_a_start_90_seconds_after_the_last_goes_ahead(self) -> None:
        self.hold(0)
        self.write(".last-start", f"{EPOCH - 90}\n")
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)

    def test_a_lone_run_skips_the_settle_time(self) -> None:
        self.write(".last-start", f"{EPOCH - 1}\n")
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)

    def test_with_every_slot_held_only_that_reason_shows_and_nothing_is_sampled(self) -> None:
        self.hold(0, 1, 2)
        self.write(".last-start", f"{EPOCH - 5}\n")  # unsettled, and the CPU busy, and neither shows
        got = self.attempt(self.leaf(cpu=[Measured(0)]))
        self.assertEqual(got, Waiting(Docs.reason(1).format(slots=3)))
        self.assertEqual(self.machine.cpu_calls, 0)

    def test_a_minimum_idle_of_0_skips_the_measurement(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf(min_idle=0, cpu=[Measured(0)])), Admitted)
        self.assertEqual(self.machine.cpu_calls, 0)

    def test_a_take_that_finds_every_slot_taken_gives_the_all_held_reason(self) -> None:
        got = self.attempt(self.leaf(refuse_takes=1))
        self.assertEqual(got, Waiting(Docs.reason(5).format(slots=3)))

    def test_at_most_three_run_at_once(self) -> None:
        leaf = self.leaf()
        for _ in range(3):
            self.assertIsInstance(self.attempt(leaf), Admitted)
            self.clock.advance(100)
        self.assertEqual(self.attempt(leaf), Waiting(Docs.reason(1).format(slots=3)))


class UnmeasurableIdleFallbackCase(ConformanceCase):
    """Item "The unmeasurable-idle fallback", final: decided in pango PR #546 (68e6e8af).

    A CPU sample that times out is not this case: the script has no timeout and would still be
    waiting on `iostat`, which overruns only on a badly loaded Mac, so such a sample waits a lone
    run too, with the reason `PROTOCOL.md` adds.
    """

    def test_a_lone_run_starts_when_the_idle_percentage_cannot_be_measured(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf(cpu=[Unmeasurable()])), Admitted)
        self.assertEqual(self.machine.cpu_calls, 1)

    def test_a_run_beside_another_waits_with_the_files_reason(self) -> None:
        self.hold(0)
        got = self.attempt(self.leaf(cpu=[Unmeasurable()]))
        self.assertEqual(got, Waiting(Docs.reason(4)))

    def test_the_reason_never_shows_on_a_lone_run_whatever_the_cpu_does(self) -> None:
        for reading in (Unmeasurable(), Measured(80)):
            with self.subTest(reading=reading):
                got = self.leaf(cpu=[reading]).attempt(APPLICANT)
                self.assertIsInstance(got, Admitted)
                assert isinstance(got, Admitted)
                os.close(got.fd)  # the next run is a lone one again
                self.clock.advance(100)

    def test_a_minimum_idle_of_0_needs_no_reading_beside_another_run_either(self) -> None:
        self.hold(0)
        self.assertIsInstance(self.attempt(self.leaf(min_idle=0, cpu=[Unmeasurable()])), Admitted)
        self.assertEqual(self.machine.cpu_calls, 0)

    def test_a_lone_run_waits_with_the_client_protocols_reason_when_the_cpu_sample_timed_out(self) -> None:
        got = self.attempt(self.leaf(cpu=[TimedOut(10)]))
        self.assertEqual(got, Waiting(Docs.added_reason().format(seconds=10)))
        self.assertEqual(self.machine.cpu_calls, 1)

    def test_a_run_beside_another_waits_with_the_client_protocols_reason_when_the_sample_timed_out(self) -> None:
        self.hold(0)
        got = self.attempt(self.leaf(cpu=[TimedOut(10)]))
        self.assertEqual(got, Waiting(Docs.added_reason().format(seconds=10)))

    def test_the_client_protocol_says_that_reason_shows_whether_or_not_the_run_is_alone(self) -> None:
        prose = " ".join(section(CLIENT_TEXT, "Reasons").split())
        self.assertIn("whether or not it is alone", prose)

    def test_the_file_states_the_rule_as_decided_and_nothing_in_it_is_provisional(self) -> None:
        self.assertIn("#546", section(LOCK_TEXT, "3.2 The unmeasurable-idle fallback"))
        self.assertNotIn("provisional", LOCK_TEXT.lower())
        self.assertNotIn("provisional", CLIENT_TEXT.lower())


class WaitingCase(ConformanceCase):
    """Item "Waiting": the lines and the timing of section 5.1, and exit 75 on the timeout."""

    def waiter(self, leaf: TakeTimeLeaf, timing: Timing = Timing()) -> Tuple[Waiter, StringIO]:
        err = StringIO()
        return Waiter(leaf, self.clock, err, timing), err

    def write_owners(self) -> List[str]:
        records = [
            Docs.owner_record(41231 + slot, slot, "/tmp/work", f"2026-11-25T14:0{slot}:11", "xcodebuild test")
            for slot in range(3)
        ]
        for slot, record in enumerate(records):
            self.write(".owner" if slot == 0 else f".{slot}.owner", record + "\n")
        return records

    def test_the_first_failed_attempt_prints_the_waiting_line_and_lists_the_holders_once(self) -> None:
        records = self.write_owners()
        self.hold(0, 1, 2)
        waiter, err = self.waiter(self.leaf(), Timing(10, 30, 300))
        waiter.wait(APPLICANT)
        first, _, gave_up = Docs.waiting_lines()
        reason = Docs.reason(1).format(slots=3)
        self.assertEqual(
            err.getvalue().splitlines(),
            [first.format(reason=reason), *["  " + r for r in records], gave_up.format(waited=30, reason=reason)],
        )

    def test_it_repeats_every_300_seconds_and_gives_up_at_3600_counting_each_attempts_own_time(self) -> None:
        # Alone and busy: each attempt takes a second of sample, then the waiter sleeps the 10 s poll,
        # so `waited` reads 1, 12, 23 and so on, 11k - 10 after attempt k. The first repeat mark is
        # 300, and each repeat moves the mark to the reading plus 300: readings 309, 617, 925 and so
        # on. The timeout is the first reading at or past 3600, which is 3609.
        waiter, err = self.waiter(self.leaf(cpu=[Measured(10)]))
        outcome = waiter.wait(APPLICANT)
        first, repeat, gave_up = Docs.waiting_lines()
        reason = Docs.reason(3).format(idle=10, min_idle=50)
        marks = [309, 617, 925, 1233, 1541, 1849, 2157, 2465, 2773, 3081, 3389]
        self.assertEqual(
            err.getvalue().splitlines(),
            [
                first.format(reason=reason),
                *[repeat.format(waited=waited, reason=reason) for waited in marks],
                gave_up.format(waited=3609, reason=reason),
            ],
        )
        self.assertEqual(outcome, GaveUp(3609, reason))

    def test_with_a_status_of_0_there_are_no_repeats(self) -> None:
        # The readings are 11k - 10 as above, and the first at or past 1000 is 1002.
        waiter, err = self.waiter(self.leaf(cpu=[Measured(10)]), Timing(10, 1000, 0))
        waiter.wait(APPLICANT)
        first, _, gave_up = Docs.waiting_lines()
        reason = Docs.reason(3).format(idle=10, min_idle=50)
        self.assertEqual(
            err.getvalue().splitlines(),
            [first.format(reason=reason), gave_up.format(waited=1002, reason=reason)],
        )

    def test_a_run_admitted_at_its_first_attempt_prints_nothing(self) -> None:
        waiter, err = self.waiter(self.leaf())
        outcome = waiter.wait(APPLICANT)
        self.assertIsInstance(outcome, Admitted)
        assert isinstance(outcome, Admitted)
        self.addCleanup(self.close_quietly, outcome.fd)
        self.assertEqual(err.getvalue(), "")

    def test_a_wait_that_reaches_the_timeout_exits_with_the_files_code_and_the_command_does_not_run(self) -> None:
        self.hold(0, 1, 2)
        waiter, _ = self.waiter(self.leaf(), Timing(10, 20, 0))
        mark = os.path.join(self.dir, "mark")
        script = os.path.join(self.dir, "program.py")
        with open(script, "w", encoding="utf-8") as handle:
            handle.write(programs.LEAVE_A_MARK)
        applicant = Applicant(pid=1, cwd=self.dir, command=(sys.executable, script, "ran", mark))
        status = metered_run(waiter, applicant, RunLimits(0, 1))
        self.assertEqual(status, Docs.exit_code("the wait reached"))
        self.assertFalse(os.path.exists(mark))


@unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
class RunningCase(ClientCase):
    """Item "Running": the real wrapper on a scratch family, through the stand-in client."""

    def run_client(self, *command: str) -> Tuple[int, str, str]:
        return self.finish(self.start(*command))

    def running_command(self) -> "Tuple[subprocess.Popen[str], int]":
        child = self.start(*self.python(programs.WAIT_FOR_RELEASE, self.path("command-pid"), self.path("release")))
        return child, self.read_pid("command-pid")

    def test_the_exit_status_is_the_commands_own(self) -> None:
        code, out, err = self.run_client(*self.python(programs.EXIT_WITH, "3"))
        self.assertEqual((code, out, err), (3, "", ""))

    def test_a_command_not_found_and_one_that_cannot_be_executed_exit_with_the_files_codes(self) -> None:
        code, _, err = self.run_client(self.path("missing"))
        self.assertEqual(code, Docs.exit_code("ENOENT"))
        self.assertIn("sim-lock: ", err)
        plain = self.path("not-executable")
        with open(plain, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\nexit 0\n")
        os.chmod(plain, 0o644)
        code, _, _ = self.run_client(plain)
        self.assertEqual(code, Docs.exit_code("any other operating-system error"))

    def test_a_command_killed_by_a_signal_exits_with_the_files_base_plus_the_signal(self) -> None:
        code, _, _ = self.run_client("/bin/sh", "-c", "kill -TERM $$")
        self.assertEqual(code, Docs.signal_base() + int(signal.SIGTERM))

    def test_the_command_leads_its_own_group_and_session_and_keeps_the_clients_stdin(self) -> None:
        source = (
            "import os, sys\n"
            "print(os.getpid() == os.getpgrp() == os.getsid(0), sys.stdin.read().strip())\n"
        )
        child = self.start(*self.python(source), pipe_stdin=True)
        code, out, _ = self.finish(child, stdin="from the caller\n")
        self.assertEqual((code, out), (0, "True from the caller\n"))

    def test_a_daemon_the_command_leaves_running_holds_no_slot(self) -> None:
        child = self.start(*self.python(programs.LEAVE_A_DAEMON, self.path("daemon-pid")))
        daemon = self.read_pid("daemon-pid")
        self.assertEqual(self.finish(child)[0], 0)
        self.assertTrue(pid_is_alive(daemon))
        self.assertFalse(self.slot_is_held(0))

    def test_killing_the_client_leaves_the_slot_held_until_the_command_ends(self) -> None:
        child, command = self.running_command()
        (wrapper,) = children_of(child.pid)
        self.kill_at_the_end(wrapper)
        os.kill(child.pid, signal.SIGKILL)
        child.wait()
        self.assertTrue(pid_is_alive(command))
        self.assertTrue(self.slot_is_held(0), "the slot was freed with the client")
        self.release()
        self.assertTrue(wait_until(lambda: not pid_is_alive(command)))
        self.assertTrue(wait_until(lambda: not self.slot_is_held(0)), "the slot outlived its command")

    def test_term_hup_and_int_reach_the_command(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with self.subTest(signal=sig.name):
                pid_name, mark_name = f"pid-{sig.name}", f"mark-{sig.name}"
                child = self.start(*self.python(programs.RECORD_A_SIGNAL, self.path(pid_name), self.path(mark_name)))
                self.read_pid(pid_name)
                os.kill(child.pid, sig)
                self.assertEqual(self.finish(child)[0], 3)
                with open(self.path(mark_name), encoding="utf-8") as handle:
                    self.assertEqual(int(handle.read()), int(sig))

    def test_a_command_past_the_run_limit_gets_term_then_kill_and_the_run_exits_with_the_files_code(self) -> None:
        child = self.start(
            *self.python(
                programs.TRAP_TERM_WITH_A_STUBBORN_GRANDCHILD,
                self.path("leader"),
                self.path("term-mark"),
                self.path("grandchild"),
            ),
            run_limit=2,
            grace=5,
        )
        leader, grandchild = self.read_pid("leader"), self.read_pid("grandchild")
        code, _, err = self.finish(child)
        self.assertEqual(code, Docs.exit_code("ran over RUN_LIMIT_SECONDS"))
        with open(self.path("term-mark"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "term")
        self.assertTrue(wait_until(lambda: not pid_is_alive(leader)))
        self.assertTrue(wait_until(lambda: not pid_is_alive(grandchild)), "a process of the group is left")
        self.assertTrue(err.startswith("sim-lock: "), err)


class DefaultsCase(ConformanceCase):
    """Item "The defaults": the file's, in what the broker actually uses."""

    def test_the_configuration_of_a_root_with_none_uses_them(self) -> None:
        config = Config.defaults(self.dir, 12)
        self.assertEqual(config.max_runs, Docs.default("MAX_RUNS"))
        self.assertEqual(config.min_idle_percent, Docs.default("MIN_IDLE_PERCENT"))
        self.assertEqual(config.settle_seconds, Docs.default("SETTLE_SECONDS"))

    def test_the_loader_gives_the_same_to_a_root_with_no_file(self) -> None:
        loaded = load_config(self.dir, 12)
        self.assertFalse(loaded.configured)
        self.assertEqual(loaded.config, Config.defaults(self.dir, 12))

    def test_the_waiter_and_the_runner_use_the_files_poll_timeout_status_run_limit_and_grace(self) -> None:
        timing, limits = Timing(), RunLimits()
        self.assertEqual(timing.poll_seconds, Docs.default("POLL_SECONDS"))
        self.assertEqual(timing.timeout_seconds, Docs.default("TIMEOUT_SECONDS"))
        self.assertEqual(timing.status_seconds, Docs.default("STATUS_SECONDS"))
        self.assertEqual(limits.run_limit_seconds, Docs.default("RUN_LIMIT_SECONDS"))
        self.assertEqual(limits.kill_grace_seconds, Docs.default("KILL_GRACE_SECONDS"))


class FileFamilyAndRecordsCase(ConformanceCase):
    """Item "The file family and its records"."""

    def test_slot_0_is_the_lock_file_and_slot_k_has_dot_k_appended_and_nothing_is_written_to_them(self) -> None:
        leaf = self.leaf()
        for _ in range(2):
            self.attempt(leaf)
            self.clock.advance(100)
        assert self.family is not None
        with self.family.gate():
            self.assertEqual(self.family.probe_all(), (True, True, False))
        for suffix in ("", ".1", ".gate"):
            self.assertEqual(os.path.getsize(self.lock + suffix), 0, suffix)

    def test_the_lowest_free_slot_is_taken_first(self) -> None:
        self.hold(1)
        self.assertEqual(self.slot_of(self.attempt(self.leaf())), 0)
        self.clock.advance(100)
        self.assertEqual(self.slot_of(self.attempt(self.leaf())), 2)

    def test_every_admission_writes_the_last_start_as_epoch_seconds_a_lone_runs_included(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)
        self.assertEqual(self.read(".last-start"), f"{EPOCH + 1}\n")  # after the second's sample

    def test_the_owner_record_is_in_the_slots_owner_file_in_the_files_form(self) -> None:
        leaf = self.leaf()
        self.attempt(leaf)
        self.clock.advance(100)
        self.attempt(leaf)
        started = local_stamp(EPOCH + 1)
        self.assertEqual(self.read(".owner"), Docs.owner_record(4242, 0, "/tmp/work", started, "xcodebuild test") + "\n")
        self.assertEqual(
            self.read(".1.owner"),
            Docs.owner_record(4242, 1, "/tmp/work", local_stamp(EPOCH + 102), "xcodebuild test") + "\n",
        )

    def test_a_missing_or_non_numeric_last_start_counts_as_settled(self) -> None:
        self.hold(0)  # a run beside which the settle time would apply
        self.assertFalse(os.path.exists(self.lock + ".last-start"))
        self.assertEqual(self.slot_of(self.attempt(self.leaf())), 1)  # no file at all
        self.write(".last-start", "recently\n")
        self.assertEqual(self.slot_of(self.attempt(self.leaf())), 2)

    def test_a_record_is_listed_only_while_its_slots_flock_is_held(self) -> None:
        record = Docs.owner_record(41231, 0, "/tmp/work", "2026-11-25T14:03:11", "xcodebuild test")
        family = Family(self.lock, slots=3, window=3)
        self.write("", "")
        self.write(".owner", record + "\n")
        self.assertEqual(family.list_holders(), [])
        self.hold(0)
        self.assertEqual(family.list_holders(), ["  " + record])


class SharedLockProtocolCase(ConformanceCase):
    """Item "The shared-lock protocol": the gate around the decision, the records and the listing."""

    def test_the_decision_the_take_and_both_records_happen_under_the_gate(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)
        assert self.family is not None
        self.assertEqual(
            sorted(set(self.family.calls)),
            sorted((name, True) for name in SpyFamily.UNDER_THE_GATE),
        )

    def test_the_cpu_sample_is_taken_inside_the_gate_so_one_waiter_samples_at_a_time(self) -> None:
        seen: List[bool] = []
        leaf = self.leaf()
        assert self.family is not None
        family = self.family
        self.machine.inside_sample = lambda: seen.append(gate_is_held(family))
        self.attempt(leaf)
        self.assertEqual(seen, [True])

    def test_the_listing_of_holders_waits_for_the_gate(self) -> None:
        family = Family(self.lock, slots=3, window=3)
        done = threading.Event()
        started = threading.Event()

        def list_them() -> None:
            started.set()
            family.list_holders()
            done.set()

        with family.gate():
            thread = threading.Thread(target=list_them, daemon=True)
            thread.start()
            self.assertTrue(started.wait(5))
            self.assertFalse(done.wait(0.3), "the listing did not wait for the gate")
        self.assertTrue(done.wait(5))
        thread.join(5)

    def test_a_holder_that_dies_leaves_no_stale_state(self) -> None:
        record = Docs.owner_record(41231, 0, "/tmp/work", "2026-11-25T14:03:11", "xcodebuild test")
        self.write("", "")
        self.write(".owner", record + "\n")
        holder = hold_in_another_process(self, self.lock)
        family = Family(self.lock, slots=3, window=3)
        self.assertEqual(family.list_holders(), ["  " + record])
        holder.kill()
        holder.wait()
        self.assertEqual(family.list_holders(), [])
        self.assertEqual(self.slot_of(self.attempt(self.leaf())), 0)


class SharedSlotRuleCase(ConformanceCase):
    """Item "The shared-slot rule": the broker's count c is at most the script's N, its window N.

    The default lock's family keeps one N, which the script holds and the broker holds too. The
    default lock stands in as a file of the scratch directory, named as the file names it.
    """

    def shared(self, **settings: object) -> Config:
        return Config.from_mapping({"shared": True, "max_runs": 3, **settings}, self.dir, 12)

    def stand_in_for_the_default_lock(self) -> str:
        default = os.path.join(self.dir, os.path.basename(Docs.default_lock()))
        patch = mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default)
        patch.start()
        self.addCleanup(patch.stop)
        return default

    def test_the_default_locks_family_takes_the_files_one_count_and_no_other(self) -> None:
        default = self.stand_in_for_the_default_lock()
        count = Docs.default_lock_count()
        for path in Docs.family_files(default):
            for other in (count - 1, count + 1, count + 2):
                with self.subTest(path=path, max_runs=other), self.assertRaises(ConfigError):
                    self.shared(family=path, max_runs=other, slots=1)
            self.assertEqual(self.shared(family=path, max_runs=count).max_runs, count)

    def test_the_default_locks_family_is_matched_under_another_spelling_of_its_directory(self) -> None:
        default = self.stand_in_for_the_default_lock()
        count = Docs.default_lock_count()
        name = os.path.basename(default)
        os.symlink(self.dir, os.path.join(self.dir, "linked"))
        for spelling in (f"{self.dir}//{name}", f"{self.dir}/./{name}.1", os.path.join(self.dir, "linked", name)):
            with self.subTest(spelling=spelling), self.assertRaises(ConfigError):
                self.shared(family=spelling, max_runs=count + 1, slots=1)

    def test_a_lock_file_elsewhere_takes_any_count(self) -> None:
        self.stand_in_for_the_default_lock()
        scratch = os.path.join(self.dir, "scratch.flock")
        for other in (1, 2, Docs.default_lock_count() + 1, 5):
            with self.subTest(max_runs=other):
                self.assertEqual(self.shared(family=scratch, max_runs=other, slots=1).max_runs, other)

    def test_on_a_shared_family_a_slot_count_above_max_runs_is_refused(self) -> None:
        with self.assertRaises(ConfigError):
            self.shared(slots=4)
        self.assertEqual(self.shared(slots=3).slots, 3)
        self.assertEqual(self.shared(slots=2).slots, 2)

    def test_the_window_is_n_on_a_shared_family_and_c_on_the_brokers_own(self) -> None:
        self.assertEqual((self.shared(slots=2).slots, self.shared(slots=2).window), (2, 3))
        own = Config.from_mapping({"slots": 2}, self.dir, 12)
        self.assertEqual((own.slots, own.window), (2, 2))

    def test_a_script_run_on_a_slot_beyond_the_brokers_count_is_a_run_beside_it(self) -> None:
        self.hold(2)  # a script run, on slot 2 of N = 3, when the broker's c is 2
        self.write(".last-start", f"{EPOCH - 10}\n")
        got = self.attempt(self.leaf(slots=2, window=3))
        self.assertEqual(got, Waiting(Docs.reason(2).format(settle=90)))

    def test_the_holder_listing_looks_at_n_slots(self) -> None:
        record = Docs.owner_record(41231, 2, "/tmp/work", "2026-11-25T14:03:11", "xcodebuild test")
        self.write(".2", "")
        self.write(".2.owner", record + "\n")
        self.hold(2)
        self.assertEqual(Family(self.lock, slots=2, window=3).list_holders(), ["  " + record])

    def test_the_all_held_reason_and_the_take_use_the_brokers_count(self) -> None:
        self.hold(0, 1)  # slot 2 is free, and the broker's c is 2
        got = self.attempt(self.leaf(slots=2, window=3))
        self.assertEqual(got, Waiting(Docs.reason(1).format(slots=2)))
        self.assertEqual(self.machine.cpu_calls, 0, "check 1 failed, so nothing was sampled")

    def test_a_waiting_broker_run_holds_neither_a_slot_nor_the_gate(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf(cpu=[Measured(10)])), Waiting)
        assert self.family is not None
        self.assertFalse(gate_is_held(self.family))
        with self.family.gate():
            self.assertEqual(self.family.probe_all(), (False, False, False))


if __name__ == "__main__":
    unittest.main()
