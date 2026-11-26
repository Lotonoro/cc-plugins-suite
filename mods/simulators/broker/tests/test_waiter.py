"""Tests for the waiter: the waiting lines, the poll, the repeats and the timeout of section 5.1.

The waiter runs on the real take-time leaf and a real family in a scratch directory, with a fake
clock and a fake machine, so an hour of waiting takes no time. Other runs are real processes
holding real flocks, with owner records written as the script writes them.
"""

from __future__ import annotations

import io
import os
import subprocess
import unittest
from typing import List, Optional, Union

from broker import protocol
from broker.decisions import DecisionStore
from broker.leaf import Admitted, Applicant, TakeTimeLeaf
from broker.policy import Measured, Rules, Sample
from broker.tests.support import (
    FakeClock,
    FakeMachine,
    SpyFamily,
    hold_in_another_process,
    scratch_dir,
)
from broker.waiter import GaveUp, Timing, Waiter

APPLICANT = Applicant(pid=4242, cwd="/tmp/work", command=("xcodebuild", "test"))
ALL_HELD = "all 3 run slots are held"
BUSY = "the CPU is 10% idle and a run needs 50%"
HOLDER_LINES = [
    "  pid=4000 slot=0 cwd=/tmp/work started=2026-11-25T14:00:11 command=xcodebuild test",
    "  pid=4001 slot=1 cwd=/tmp/work started=2026-11-25T14:01:11 command=xcodebuild test",
    "  pid=4002 slot=2 cwd=/tmp/work started=2026-11-25T14:02:11 command=xcodebuild test",
]

Children = List["subprocess.Popen[str]"]


class WaiterCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.lock = os.path.join(self.dir, "lock")
        self.clock = FakeClock()
        self.machine = FakeMachine(clock=self.clock)
        self.err = io.StringIO()
        self.decisions = DecisionStore(os.path.join(self.dir, "state"))

    def waiter(
        self,
        timing: Timing = Timing(),
        notice: Optional[str] = None,
        refuse_takes: int = 0,
        cpu: Optional[List[Sample]] = None,
    ) -> Waiter:
        if cpu is not None:
            self.machine.cpu = tuple(cpu)
        family = SpyFamily(self.lock, slots=3, window=3, refuse_takes=refuse_takes)
        rules = Rules(slots=3, window=3, settle_seconds=90, min_idle_percent=50)
        leaf = TakeTimeLeaf(family, rules, self.machine, self.clock, self.decisions)
        return Waiter(leaf, self.clock, self.err, timing, notice)

    def hold_all_slots(self) -> Children:
        """Three other runs, each holding a slot and with an owner record, as the script's runs do."""
        children = []
        for slot in range(3):
            path = self.lock if slot == 0 else f"{self.lock}.{slot}"
            with open(path + ".owner", "w", encoding="utf-8") as handle:
                handle.write(HOLDER_LINES[slot].strip() + "\n")
            children.append(hold_in_another_process(self, path))
        return children

    def free_after_sleeps(self, children: Children, sleeps: int) -> None:
        """Ends the other runs, and so frees their slots, during the waiter's `sleeps`th sleep."""

        def free(count: int) -> None:
            if count == sleeps:
                for child in children:
                    child.kill()
                    child.wait()  # the slot's flock is gone once the process is

        self.clock.on_sleep = free

    def lines(self) -> List[str]:
        return self.err.getvalue().splitlines()

    def wait(self, waiter: Waiter) -> Union[Admitted, GaveUp]:
        got = waiter.wait(APPLICANT)
        if isinstance(got, Admitted):
            self.addCleanup(os.close, got.fd)
        return got


class FirstAttemptTest(WaiterCase):
    def test_a_run_admitted_at_its_first_attempt_prints_nothing_and_never_sleeps(self) -> None:
        got = self.wait(self.waiter(notice="a note"))
        self.assertIsInstance(got, Admitted)
        self.assertEqual(self.err.getvalue(), "")
        self.assertEqual(self.clock.sleeps, [])


class FirstFailedAttemptTest(WaiterCase):
    def waiting_run(self, notice: Optional[str] = None) -> Waiter:
        self.free_after_sleeps(self.hold_all_slots(), sleeps=1)
        return self.waiter(notice=notice)

    def test_the_waiting_line_names_the_reason_and_ends_with_running_now(self) -> None:
        self.wait(self.waiting_run())
        self.assertEqual(
            self.lines()[0],
            "sim-lock: waiting for a simulator run slot: all 3 run slots are held; running now:",
        )

    def test_the_holders_follow_the_line_each_indented_two_spaces_in_slot_order(self) -> None:
        self.wait(self.waiting_run())
        self.assertEqual(self.lines()[1:], HOLDER_LINES)

    def test_the_holders_are_listed_once_not_at_each_failed_attempt(self) -> None:
        self.free_after_sleeps(self.hold_all_slots(), sleeps=4)
        self.wait(self.waiter())
        self.assertEqual(self.clock.sleeps, [10, 10, 10, 10])
        self.assertEqual(self.lines()[1:], HOLDER_LINES)
        self.assertEqual(sum(line.startswith("sim-lock: waiting") for line in self.lines()), 1)

    def test_a_notice_comes_once_before_the_waiting_line(self) -> None:
        self.wait(self.waiting_run(notice="sim-lock: a note"))
        self.assertEqual(self.lines()[0], "sim-lock: a note")
        self.assertTrue(self.lines()[1].startswith("sim-lock: waiting for a simulator run slot"))
        self.assertEqual(self.err.getvalue().count("a note"), 1)

    def test_the_first_failed_attempt_prints_the_waiting_line_and_never_a_repeat(self) -> None:
        # A sample takes 5 s of the fake clock and the repeat mark is 1 s, so the first reading is
        # past the mark; the waiting line and a repeat are alternatives, and the repeat is the next.
        self.machine.sample_seconds = 5
        self.wait(self.waiter(timing=Timing(10, 20, 1), cpu=[Measured(10)]))
        self.assertEqual(
            self.lines(),
            [
                f"sim-lock: waiting for a simulator run slot: {BUSY}; running now:",
                f"sim-lock: still waiting after 20s: {BUSY}",
                f"sim-lock: gave up after 20s: {BUSY}",
            ],
        )


class PollTest(WaiterCase):
    def test_a_failed_attempt_is_followed_by_a_sleep_of_the_poll_time(self) -> None:
        self.free_after_sleeps(self.hold_all_slots(), sleeps=2)
        self.wait(self.waiter())
        self.assertEqual(self.clock.sleeps, [protocol.POLL_SECONDS] * 2)

    def test_a_run_waits_until_the_slots_free_and_is_then_admitted_to_the_lowest(self) -> None:
        self.free_after_sleeps(self.hold_all_slots(), sleeps=3)
        got = self.wait(self.waiter())
        self.assertIsInstance(got, Admitted)
        self.assertEqual(got.slot, 0)  # type: ignore[union-attr]
        self.assertEqual(self.clock.sleeps, [10, 10, 10])


class RepeatTest(WaiterCase):
    def test_the_first_repeat_is_at_the_status_mark_and_the_next_one_status_seconds_after_it(
        self,
    ) -> None:
        self.hold_all_slots()
        self.wait(self.waiter(timing=Timing(10, 700, 300)))
        repeats = [line for line in self.lines() if "still waiting" in line]
        self.assertEqual(
            repeats,
            [
                f"sim-lock: still waiting after 300s: {ALL_HELD}",
                f"sim-lock: still waiting after 600s: {ALL_HELD}",
            ],
        )

    def test_the_time_an_attempt_takes_counts_toward_the_repeats_and_moves_each_mark(self) -> None:
        # A failed attempt takes a second of sampling and the poll is ten, so the readings are
        # 1, 12, 23, ...: the first at or past 300 is 309, and the next mark is 309 + 300.
        self.wait(self.waiter(timing=Timing(10, 700, 300), cpu=[Measured(10)]))
        repeats = [line for line in self.lines() if "still waiting" in line]
        self.assertEqual(
            repeats,
            [
                f"sim-lock: still waiting after 309s: {BUSY}",
                f"sim-lock: still waiting after 617s: {BUSY}",
            ],
        )

    def test_a_status_time_of_zero_prints_no_repeats(self) -> None:
        self.hold_all_slots()
        self.wait(self.waiter(timing=Timing(10, 1000, 0)))
        self.assertEqual(sum("still waiting" in line for line in self.lines()), 0)
        self.assertEqual(self.lines()[-1], f"sim-lock: gave up after 1000s: {ALL_HELD}")


class TimeoutTest(WaiterCase):
    def test_the_wait_ends_with_a_gave_up_line_and_returns_the_reading_and_the_reason(self) -> None:
        self.hold_all_slots()
        got = self.wait(self.waiter(timing=Timing(10, 100, 0)))
        self.assertEqual(got, GaveUp(100, ALL_HELD))
        self.assertEqual(self.lines()[-1], f"sim-lock: gave up after 100s: {ALL_HELD}")

    def test_the_number_in_the_last_line_is_the_first_reading_at_or_past_the_timeout(self) -> None:
        # Readings of 1, 12, 23, ...: the first at or past 3600 is 3609, not 3600.
        got = self.wait(self.waiter(cpu=[Measured(10)]))
        self.assertEqual(got, GaveUp(3609, BUSY))
        self.assertEqual(self.lines()[-1], f"sim-lock: gave up after 3609s: {BUSY}")

    def test_the_timeout_is_tested_after_the_repeat_on_the_same_attempt(self) -> None:
        # With every slot held an attempt takes no time: the readings are 0, 10, ..., 3600, and
        # the one that reaches the timeout is at a repeat mark too.
        self.hold_all_slots()
        got = self.wait(self.waiter())
        self.assertEqual(got, GaveUp(3600, ALL_HELD))
        self.assertEqual(
            self.lines()[-2:],
            [
                f"sim-lock: still waiting after 3600s: {ALL_HELD}",
                f"sim-lock: gave up after 3600s: {ALL_HELD}",
            ],
        )
        self.assertEqual(sum("still waiting" in line for line in self.lines()), 12)

    def test_the_default_timing_is_the_scripts_constants(self) -> None:
        self.assertEqual(Timing(), Timing(poll_seconds=10, timeout_seconds=3600, status_seconds=300))

    def test_a_timed_out_wait_takes_no_slot_and_writes_no_family_record(self) -> None:
        got = self.wait(self.waiter(timing=Timing(10, 30, 0), cpu=[Measured(10)]))
        self.assertIsInstance(got, GaveUp)
        self.assertFalse(os.path.exists(self.lock + ".owner"))
        self.assertFalse(os.path.exists(self.lock + ".last-start"))


class TakeTimeCheckTest(WaiterCase):
    def test_a_run_whose_take_time_check_fails_keeps_waiting_and_starts_once_it_passes(self) -> None:
        got = self.wait(self.waiter(refuse_takes=2))
        self.assertIsInstance(got, Admitted)
        self.assertEqual(self.clock.sleeps, [10, 10])
        self.assertEqual(
            self.lines(),
            [f"sim-lock: waiting for a simulator run slot: {ALL_HELD}; running now:"],
        )


if __name__ == "__main__":
    unittest.main()
