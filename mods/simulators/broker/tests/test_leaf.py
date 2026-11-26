"""Tests for the take-time leaf: one admission attempt, all the I/O around the policy core.

The family is real, in a scratch directory, with other holders as real processes. The clock and the
machine are fakes. `SpyFamily` notes whether the gate was held at each call that must be under it.
"""

from __future__ import annotations

import os
import unittest
from typing import List, Optional

from broker import protocol
from broker.clock import local_stamp
from broker.decisions import DecisionStore, LastDecision
from broker.errors import FamilyError, StateError
from broker.leaf import Admitted, Applicant, TakeTimeLeaf, Waiting
from broker.policy import Measured, Rules, Sample, TimedOut, Unmeasurable
from broker.tests.support import (
    EPOCH,
    FakeClock,
    FakeMachine,
    SpyFamily,
    gate_is_held,
    hold_in_another_process,
    scratch_dir,
)

APPLICANT = Applicant(pid=4242, cwd="/tmp/work", command=("xcodebuild", "test"))


class LeafCase(unittest.TestCase):
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
        rules = Rules(
            slots=slots, window=window, settle_seconds=settle, min_idle_percent=min_idle
        )
        return TakeTimeLeaf(self.family, rules, self.machine, self.clock, self.decisions)

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

    def read(self, suffix: str) -> str:
        with open(self.lock + suffix, encoding="utf-8") as handle:
            return handle.read()

    def write(self, suffix: str, text: str) -> None:
        with open(self.lock + suffix, "w", encoding="utf-8") as handle:
            handle.write(text)

    def exists(self, suffix: str) -> bool:
        return os.path.exists(self.lock + suffix)

    def hold(self, *slots: int) -> None:
        for slot in slots:
            hold_in_another_process(self, self.lock if slot == 0 else f"{self.lock}.{slot}")

    def slot_is_held(self, slot: int) -> bool:
        assert self.family is not None
        with self.family.gate():
            return self.family.probe(slot)


class AdmitTest(LeafCase):
    def test_a_lone_run_on_an_idle_machine_is_admitted_to_slot_0(self) -> None:
        got = self.attempt(self.leaf())
        self.assertIsInstance(got, Admitted)
        self.assertEqual(got.slot, 0)  # type: ignore[attr-defined]

    def test_the_slot_is_held_by_the_descriptor_the_attempt_returns_and_by_nothing_else(self) -> None:
        got = self.attempt(self.leaf())
        self.assertTrue(self.slot_is_held(0))
        os.close(got.fd)  # type: ignore[attr-defined]
        self.assertFalse(self.slot_is_held(0))

    def test_the_last_start_is_the_time_after_the_sample_as_plain_epoch_seconds(self) -> None:
        self.attempt(self.leaf())
        self.assertEqual(self.machine.cpu_calls, 1)
        self.assertEqual(self.read(".last-start"), f"{EPOCH + 1}\n")

    def test_the_owner_record_names_pid_slot_cwd_start_and_command(self) -> None:
        self.attempt(self.leaf())
        stamp = local_stamp(EPOCH + 1)
        self.assertEqual(
            self.read(".owner"),
            f"pid=4242 slot=0 cwd=/tmp/work started={stamp} command=xcodebuild test\n",
        )

    def test_the_owner_record_goes_to_the_slot_taken(self) -> None:
        self.hold(0)
        self.write(".last-start", f"{EPOCH - 100}\n")
        self.attempt(self.leaf())
        self.assertIn("slot=1 ", self.read(".1.owner"))
        self.assertFalse(self.exists(".owner"))

    def test_the_last_decision_names_the_admission_its_slot_and_its_time(self) -> None:
        self.attempt(self.leaf())
        self.assertEqual(
            self.decisions.read(),
            LastDecision(protocol.DECISION_ADMIT, protocol.REASON_ADMITTED, 0, EPOCH + 1),
        )

    def test_a_lone_run_ignores_the_settle_time(self) -> None:
        self.write(".last-start", f"{EPOCH - 1}\n")
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)

    def test_the_lowest_free_slot_is_taken_beside_a_settled_run(self) -> None:
        self.hold(0)
        self.write(".last-start", f"{EPOCH - 100}\n")
        got = self.attempt(self.leaf())
        self.assertEqual(got.slot, 1)  # type: ignore[attr-defined]

    def test_a_missing_last_start_beside_another_run_is_settled(self) -> None:
        self.hold(0)
        self.assertIsInstance(self.attempt(self.leaf()), Admitted)

    def test_a_sample_at_the_minimum_admits(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf(cpu=[Measured(50)])), Admitted)

    def test_a_minimum_idle_of_zero_takes_no_sample_and_admits_at_any_load(self) -> None:
        got = self.attempt(self.leaf(min_idle=0, cpu=[Measured(0)]))
        self.assertIsInstance(got, Admitted)
        self.assertEqual(self.machine.cpu_calls, 0)
        self.assertEqual(self.read(".last-start"), f"{EPOCH}\n")

    def test_an_unmeasurable_cpu_admits_a_lone_run(self) -> None:
        self.assertIsInstance(self.attempt(self.leaf(cpu=[Unmeasurable()])), Admitted)


class WaitTest(LeafCase):
    def test_every_broker_slot_held_waits_with_that_reason_and_takes_no_sample(self) -> None:
        self.hold(0, 1, 2)
        got = self.attempt(self.leaf())
        self.assertEqual(got, Waiting("all 3 run slots are held"))
        self.assertEqual(self.machine.cpu_calls, 0)

    def test_an_unsettled_start_beside_another_run_waits_and_takes_no_sample(self) -> None:
        self.hold(0)
        self.write(".last-start", f"{EPOCH - 10}\n")
        got = self.attempt(self.leaf())
        self.assertEqual(got, Waiting("a run started less than 90s ago"))
        self.assertEqual(self.machine.cpu_calls, 0)

    def test_a_busy_cpu_waits_with_the_reading_in_the_reason(self) -> None:
        got = self.attempt(self.leaf(cpu=[Measured(20)]))
        self.assertEqual(got, Waiting("the CPU is 20% idle and a run needs 50%"))

    def test_a_waiting_attempt_changes_nothing_in_the_family(self) -> None:
        self.attempt(self.leaf(cpu=[Measured(20)]))
        self.assertFalse(self.exists(".last-start"))
        self.assertFalse(self.exists(".owner"))
        self.assertFalse(self.slot_is_held(0))

    def test_an_unmeasurable_cpu_beside_another_run_waits(self) -> None:
        self.hold(1)
        self.write(".last-start", f"{EPOCH - 100}\n")
        got = self.attempt(self.leaf(cpu=[Unmeasurable()]))
        self.assertEqual(got, Waiting("the CPU's idle percentage cannot be measured"))

    def test_a_cpu_sample_that_timed_out_waits_a_lone_run_and_records_the_wait(self) -> None:
        got = self.attempt(self.leaf(cpu=[TimedOut(10)]))
        self.assertEqual(got, Waiting("the CPU sample timed out after 10s"))
        self.assertEqual(
            self.decisions.read(),
            LastDecision(protocol.DECISION_WAIT, "the CPU sample timed out after 10s", None, EPOCH + 1),
        )
        self.assertFalse(self.slot_is_held(0))
        self.assertFalse(self.exists(".last-start"))

    def test_a_sample_that_timed_out_beside_another_run_waits_with_that_reason(self) -> None:
        self.hold(1)
        self.write(".last-start", f"{EPOCH - 100}\n")
        got = self.attempt(self.leaf(cpu=[TimedOut(10)]))
        self.assertEqual(got, Waiting("the CPU sample timed out after 10s"))
        self.assertEqual(
            self.decisions.read(),
            LastDecision(protocol.DECISION_WAIT, "the CPU sample timed out after 10s", None, EPOCH + 1),
        )

    def test_every_decision_is_recorded_with_its_reason_and_no_slot(self) -> None:
        self.attempt(self.leaf(cpu=[Measured(20)]))
        self.assertEqual(
            self.decisions.read(),
            # The sample took the fake clock a second, and the record is written after it.
            LastDecision(
                protocol.DECISION_WAIT, "the CPU is 20% idle and a run needs 50%", None, EPOCH + 1
            ),
        )

    def test_a_later_wait_replaces_an_earlier_admission_in_the_record(self) -> None:
        leaf = self.leaf()
        self.assertIsInstance(self.attempt(leaf), Admitted)
        # This process holds slot 0 now, and its own last start is a second old.
        got = self.attempt(leaf)
        self.assertEqual(got, Waiting("a run started less than 90s ago"))
        record = self.decisions.read()
        assert record is not None
        self.assertEqual(record.decision, protocol.DECISION_WAIT)

    def test_a_slot_above_the_brokers_count_is_never_taken_but_is_seen_as_another_run(self) -> None:
        # c = 2 and N = 3: slot 2 is held, as by a script run, and nothing else is.
        self.hold(2)
        self.write(".last-start", f"{EPOCH - 10}\n")
        got = self.attempt(self.leaf(slots=2, window=3))
        self.assertEqual(got, Waiting("a run started less than 90s ago"))

    def test_with_both_broker_slots_held_the_reason_counts_the_brokers_slots(self) -> None:
        self.hold(0, 1)
        got = self.attempt(self.leaf(slots=2, window=3))
        self.assertEqual(got, Waiting("all 2 run slots are held"))
        self.assertFalse(self.slot_is_held(2))


class TakeFailureTest(LeafCase):
    def test_a_take_that_finds_no_slot_after_the_checks_passed_waits_with_check_5s_reason(self) -> None:
        got = self.attempt(self.leaf(refuse_takes=1))
        self.assertEqual(got, Waiting("all 3 run slots are held"))
        self.assertEqual(
            self.decisions.read(),
            LastDecision(protocol.DECISION_WAIT, "all 3 run slots are held", None, EPOCH + 1),
        )
        self.assertFalse(self.exists(".last-start"))
        self.assertFalse(self.exists(".owner"))

    def test_the_same_leaf_admits_at_its_next_attempt_once_the_take_succeeds(self) -> None:
        leaf = self.leaf(refuse_takes=1)
        self.assertIsInstance(self.attempt(leaf), Waiting)
        self.assertIsInstance(self.attempt(leaf), Admitted)

    def test_a_decision_record_that_cannot_be_written_releases_the_slot_and_leaves_no_family_record(
        self,
    ) -> None:
        with open(self.state, "w", encoding="utf-8") as handle:  # a file where the directory goes
            handle.write("in the way")
        leaf = self.leaf()
        with self.assertRaises(StateError):
            leaf.attempt(APPLICANT)
        self.assertFalse(self.slot_is_held(0))
        self.assertFalse(self.exists(".last-start"))
        self.assertFalse(self.exists(".owner"))

    def test_an_owner_record_that_cannot_be_written_releases_the_slot(self) -> None:
        os.makedirs(self.lock + ".owner")  # a directory where the record goes
        leaf = self.leaf()
        with self.assertRaises(FamilyError):
            leaf.attempt(APPLICANT)
        self.assertFalse(self.slot_is_held(0))

    def test_a_failing_attempt_lets_the_gate_go(self) -> None:
        os.makedirs(self.lock + ".owner")
        leaf = self.leaf()
        with self.assertRaises(FamilyError):
            leaf.attempt(APPLICANT)
        assert self.family is not None
        self.assertFalse(gate_is_held(self.family))


class GateTest(LeafCase):
    def test_the_helper_that_checks_the_gate_tells_a_held_gate_from_a_free_one(self) -> None:
        # The assertions below that the gate was held mean nothing if the helper says held always.
        family = SpyFamily(self.lock, slots=3, window=3)
        self.assertFalse(gate_is_held(family))
        with family.gate():
            self.assertTrue(gate_is_held(family))
        self.assertFalse(gate_is_held(family))

    def test_the_probe_the_take_and_both_records_are_made_under_the_gate_in_order(self) -> None:
        self.attempt(self.leaf())
        assert self.family is not None
        self.assertEqual(
            self.family.names(),
            ["probe_all", "take_lowest_free", "write_last_start", "write_owner"],
        )
        self.assertTrue(self.family.every_call_held_the_gate())

    def test_the_gate_is_let_go_when_the_attempt_ends(self) -> None:
        self.attempt(self.leaf())
        assert self.family is not None
        self.assertFalse(gate_is_held(self.family))

    def test_a_waiter_that_passes_both_checks_takes_a_fresh_sample_inside_the_gate_every_attempt(
        self,
    ) -> None:
        leaf = self.leaf(cpu=[Measured(10)])
        assert self.family is not None
        family = self.family
        inside: List[bool] = []
        self.machine.inside_sample = lambda: inside.append(gate_is_held(family))
        self.attempt(leaf)
        self.attempt(leaf)
        self.assertEqual(self.machine.cpu_calls, 2)
        self.assertEqual(inside, [True, True])

    def test_the_decision_record_is_written_under_the_gate_too(self) -> None:
        leaf = self.leaf(cpu=[Measured(10)])
        assert self.family is not None
        family = self.family
        held: List[bool] = []
        real = self.decisions.write

        def spy(record: LastDecision) -> None:
            held.append(gate_is_held(family))
            real(record)

        self.decisions.write = spy  # type: ignore[assignment]
        self.attempt(leaf)
        self.assertEqual(held, [True])


class ConstructionTest(LeafCase):
    def test_rules_that_disagree_with_the_family_about_the_slots_are_refused(self) -> None:
        family = SpyFamily(self.lock, slots=3, window=3)
        rules = Rules(slots=2, window=3, settle_seconds=90, min_idle_percent=50)
        with self.assertRaisesRegex(ValueError, "slots"):
            TakeTimeLeaf(family, rules, self.machine, self.clock, self.decisions)

    def test_rules_that_disagree_with_the_family_about_the_window_are_refused(self) -> None:
        family = SpyFamily(self.lock, slots=2, window=2)
        rules = Rules(slots=2, window=3, settle_seconds=90, min_idle_percent=50)
        with self.assertRaisesRegex(ValueError, "window"):
            TakeTimeLeaf(family, rules, self.machine, self.clock, self.decisions)


if __name__ == "__main__":
    unittest.main()
