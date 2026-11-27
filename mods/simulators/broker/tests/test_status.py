"""Tests for the status verb: it reads the last decision under the gate and prints it as recorded.

After each decision the record names it and its reason, and the verb's reading matches the
record. The decisions in these tests are the take-time leaf's own, on a real family, so the record
and the reading are checked against what the leaf wrote and not against what a test made up.
"""

from __future__ import annotations

import io
import os
import threading
import time
import unittest
from typing import List
from unittest import mock

from broker import protocol
from broker.decisions import LastDecision
from broker.errors import StateError
from broker.leaf import Admitted, Applicant
from broker.policy import Measured
from broker.status import status
from broker.stateroot import open_root
from broker.tests.support import (
    EPOCH,
    FakeClock,
    FakeMachine,
    hold_in_another_process,
    scratch_dir,
)

CORES = 12
APPLICANT = Applicant(pid=1, cwd="/tmp", command=("true",))


def stamp(epoch: int) -> str:
    """The UTC time of an epoch second, which is the local time while the zone is UTC."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch))


class StatusCase(unittest.TestCase):
    def setUp(self) -> None:
        patch = mock.patch.dict(os.environ, {"TZ": "UTC0"}, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        time.tzset()
        self.addCleanup(time.tzset)
        self.dir = scratch_dir(self)
        self.root_path = os.path.join(self.dir, "root")
        self.root = open_root(self.root_path, CORES)
        self.clock = FakeClock()
        self.machine = FakeMachine(clock=self.clock)
        self.out = io.StringIO()

    def attempt(self) -> object:
        got = self.root.leaf(self.machine, self.clock).attempt(APPLICANT)
        if isinstance(got, Admitted):
            self.addCleanup(os.close, got.fd)
        return got

    def reading(self) -> List[str]:
        out = io.StringIO()
        status(self.root, out)
        return out.getvalue().splitlines()

    def hold_slots(self, *slots: int) -> None:
        family = self.root.config.family
        os.makedirs(os.path.dirname(family), exist_ok=True)
        for slot in slots:
            hold_in_another_process(self, family if slot == 0 else f"{family}.{slot}")


class ReadingTest(StatusCase):
    def test_it_names_the_root_and_the_family_before_the_decision(self) -> None:
        lines = self.reading()
        self.assertEqual(lines[0], f"state root: {self.root_path}")
        self.assertEqual(lines[1], f"family: {os.path.join(self.root_path, 'family', 'lock')}")

    def test_with_no_decision_yet_it_says_so(self) -> None:
        self.assertEqual(self.reading()[2:], ["last decision: none recorded yet"])

    def test_a_wait_is_read_with_its_time_and_reason(self) -> None:
        self.root.decisions().write(LastDecision("wait", "all 3 run slots are held", None, EPOCH))
        self.assertEqual(
            self.reading()[2:], [f"last decision: wait at {stamp(EPOCH)}: all 3 run slots are held"]
        )

    def test_an_admit_is_read_with_its_slot(self) -> None:
        self.root.decisions().write(LastDecision("admit", "the checks passed", 2, EPOCH))
        self.assertEqual(
            self.reading()[2:],
            [f"last decision: admit at {stamp(EPOCH)} to slot 2: the checks passed"],
        )

    def test_a_record_that_is_not_ours_is_a_state_error_naming_the_file(self) -> None:
        os.makedirs(self.root.state_dir)
        with open(self.root.decisions().path, "w", encoding="utf-8") as handle:
            handle.write("not json")
        with self.assertRaisesRegex(StateError, "last-decision.json"):
            self.reading()


class MatchesTheRecordTest(StatusCase):
    """After each decision the leaf wrote, the record names it, and the reading says the same."""

    def check(self, decision: str, reason: str, slot: object, line: str) -> None:
        record = self.root.decisions().read()
        assert record is not None
        self.assertEqual((record.decision, record.reason, record.slot), (decision, reason, slot))
        self.assertEqual(self.reading()[2:], [line])

    def test_every_slot_held(self) -> None:
        self.hold_slots(0, 1, 2)
        self.attempt()
        reason = "all 3 run slots are held"
        self.check("wait", reason, None, f"last decision: wait at {stamp(EPOCH)}: {reason}")

    def test_the_settle_time_unpassed(self) -> None:
        self.hold_slots(0)
        with open(self.root.config.family + ".last-start", "w", encoding="utf-8") as handle:
            handle.write(f"{EPOCH - 10}\n")
        self.attempt()
        reason = "a run started less than 90s ago"
        self.check("wait", reason, None, f"last decision: wait at {stamp(EPOCH)}: {reason}")

    def test_a_busy_cpu(self) -> None:
        self.machine.cpu = (Measured(10),)
        self.attempt()
        reason = "the CPU is 10% idle and a run needs 50%"
        # The sample took the fake clock a second, and the decision was made after it.
        self.check("wait", reason, None, f"last decision: wait at {stamp(EPOCH + 1)}: {reason}")

    def test_an_admission(self) -> None:
        self.attempt()
        self.check(
            "admit",
            "the checks passed",
            0,
            f"last decision: admit at {stamp(EPOCH + 1)} to slot 0: the checks passed",
        )

    def test_a_later_decision_replaces_the_earlier_in_the_reading(self) -> None:
        self.attempt()  # admitted to slot 0, held by this process
        self.clock.advance(5)
        self.attempt()  # the settle time has not passed beside the run just admitted
        record = self.root.decisions().read()
        assert record is not None
        self.assertEqual(record.decision, protocol.DECISION_WAIT)
        self.assertIn("wait at", self.reading()[2])


class GateTest(StatusCase):
    def test_the_reading_waits_for_the_gate_as_every_reader_of_the_record_does(self) -> None:
        family = self.root.family()
        done = threading.Event()
        starting = threading.Event()

        def read() -> None:
            starting.set()
            self.reading()
            done.set()

        with family.gate():
            thread = threading.Thread(target=read, daemon=True)
            thread.start()
            self.assertTrue(starting.wait(5))
            self.assertFalse(done.wait(0.3), "the reading did not wait for the gate")
        self.assertTrue(done.wait(5))
        thread.join(5)


if __name__ == "__main__":
    unittest.main()
