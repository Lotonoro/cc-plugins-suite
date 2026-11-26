"""Tests for the policy core: the whole admission check order, from inputs alone.

Every input is a value: which slots are held, the last start, the rules, the time and, once the
core has asked for one, the CPU sample. No file, process or clock is involved, and the texts are
written out here, not read from the code, so a changed reason fails a test.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path
from typing import Optional, Sequence

from broker import policy
from broker.policy import Decision, Measured, Rules, TimedOut, Unmeasurable, Verdict

NOW = 1_000_000


def rules(
    slots: int = 3, window: int = 3, settle: int = 90, min_idle: int = 50
) -> Rules:
    return Rules(slots=slots, window=window, settle_seconds=settle, min_idle_percent=min_idle)


def decide(
    held: Sequence[bool],
    rule: Optional[Rules] = None,
    last_start: Optional[int] = None,
    sample: Optional[policy.Sample] = None,
) -> Decision:
    return policy.decide(rule or rules(), held, last_start, NOW, sample)


FREE = (False, False, False)


class SlotsHeldTest(unittest.TestCase):
    def test_every_slot_held_waits_with_the_slots_reason(self) -> None:
        got = decide((True, True, True), last_start=NOW)
        self.assertEqual(got, Decision(Verdict.WAIT, "all 3 run slots are held"))

    def test_every_slot_held_asks_for_no_sample_whatever_the_settle_time_and_cpu_say(self) -> None:
        # The settle time is unpassed and a sample would be needed; only the slots show.
        got = decide((True, True, True), rules(min_idle=50), last_start=NOW)
        self.assertEqual(got.verdict, Verdict.WAIT)
        self.assertEqual(got.reason, "all 3 run slots are held")

    def test_every_slot_held_is_decided_before_a_sample_is_looked_at(self) -> None:
        got = decide((True, True, True), sample=Measured(0), last_start=NOW)
        self.assertEqual(got.reason, "all 3 run slots are held")

    def test_the_reason_counts_the_broker_slots_not_the_window(self) -> None:
        # The broker takes slots 0 and 1; slot 2 is the script's window only.
        got = decide((True, True, False), rules(slots=2, window=3))
        self.assertEqual(got, Decision(Verdict.WAIT, "all 2 run slots are held"))

    def test_a_free_broker_slot_among_held_ones_is_not_every_slot_held(self) -> None:
        got = decide((True, False, True), last_start=NOW - 200, sample=Measured(100))
        self.assertEqual(got.verdict, Verdict.ADMIT)

    def test_a_window_that_is_not_one_entry_per_slot_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            decide((True, True), rules(slots=3, window=3))


class SettleTest(unittest.TestCase):
    def test_beside_another_run_it_waits_until_the_settle_time_has_passed(self) -> None:
        got = decide((True, False, False), last_start=NOW - 89)
        self.assertEqual(got, Decision(Verdict.WAIT, "a run started less than 90s ago"))

    def test_the_settle_time_exactly_passed_is_settled(self) -> None:
        got = decide((True, False, False), last_start=NOW - 90)
        self.assertEqual(got.verdict, Verdict.SAMPLE)

    def test_a_lone_run_skips_the_settle_check(self) -> None:
        got = decide(FREE, last_start=NOW)
        self.assertEqual(got.verdict, Verdict.SAMPLE)

    def test_a_missing_last_start_counts_as_settled(self) -> None:
        got = decide((True, False, False), last_start=None)
        self.assertEqual(got.verdict, Verdict.SAMPLE)

    def test_a_last_start_in_the_future_stays_unsettled_until_the_clock_passes_it(self) -> None:
        got = decide((True, False, False), last_start=NOW + 10)
        self.assertEqual(got, Decision(Verdict.WAIT, "a run started less than 90s ago"))
        later = policy.decide(rules(), (True, False, False), NOW + 10, NOW + 100, None)
        self.assertEqual(later.verdict, Verdict.SAMPLE)

    def test_the_reason_names_the_configured_settle_time(self) -> None:
        got = decide((False, True, False), rules(settle=30), last_start=NOW - 5)
        self.assertEqual(got.reason, "a run started less than 30s ago")

    def test_a_settle_time_of_zero_is_always_settled(self) -> None:
        got = decide((True, False, False), rules(settle=0), last_start=NOW)
        self.assertEqual(got.verdict, Verdict.SAMPLE)

    def test_an_unpassed_settle_time_asks_for_no_sample(self) -> None:
        got = decide((True, False, False), last_start=NOW - 1, sample=Measured(100))
        self.assertEqual(got.verdict, Verdict.WAIT)

    def test_a_run_on_a_window_slot_beyond_the_broker_count_is_another_run(self) -> None:
        # The script's callers may hold slot 2 while the broker takes only 0 and 1: the broker
        # run is not alone, so the settle time applies.
        got = decide((False, False, True), rules(slots=2, window=3), last_start=NOW - 1)
        self.assertEqual(got, Decision(Verdict.WAIT, "a run started less than 90s ago"))


class CpuSampleTest(unittest.TestCase):
    def test_the_core_asks_for_a_sample_once_slots_and_settle_pass(self) -> None:
        self.assertEqual(decide(FREE).verdict, Verdict.SAMPLE)

    def test_a_minimum_idle_of_zero_admits_without_a_sample(self) -> None:
        got = decide(FREE, rules(min_idle=0))
        self.assertEqual(got, Decision(Verdict.ADMIT, "the checks passed"))

    def test_a_minimum_idle_of_zero_admits_beside_another_settled_run_too(self) -> None:
        got = decide((True, False, False), rules(min_idle=0), last_start=NOW - 90)
        self.assertEqual(got.verdict, Verdict.ADMIT)

    def test_idle_at_the_minimum_admits(self) -> None:
        got = decide(FREE, sample=Measured(50))
        self.assertEqual(got, Decision(Verdict.ADMIT, "the checks passed"))

    def test_idle_below_the_minimum_waits_naming_both_figures(self) -> None:
        got = decide(FREE, sample=Measured(49))
        self.assertEqual(
            got, Decision(Verdict.WAIT, "the CPU is 49% idle and a run needs 50%")
        )

    def test_the_cpu_check_applies_to_a_lone_run(self) -> None:
        got = decide(FREE, rules(min_idle=80), sample=Measured(10))
        self.assertEqual(got.reason, "the CPU is 10% idle and a run needs 80%")

    def test_the_cpu_check_applies_beside_another_settled_run(self) -> None:
        got = decide((True, False, False), last_start=NOW - 200, sample=Measured(10))
        self.assertEqual(got.reason, "the CPU is 10% idle and a run needs 50%")

    def test_a_minimum_above_100_admits_no_measured_run(self) -> None:
        got = decide(FREE, rules(min_idle=101), sample=Measured(100))
        self.assertEqual(got.reason, "the CPU is 100% idle and a run needs 101%")

    def test_a_sample_given_when_none_is_needed_is_not_consulted(self) -> None:
        got = decide(FREE, rules(min_idle=0), sample=Measured(0))
        self.assertEqual(got.verdict, Verdict.ADMIT)


class UnmeasurableIdleTest(unittest.TestCase):
    """LOCK-PROTOCOL.md section 3.2: a lone run starts with no idle reading, one beside another waits."""

    def test_a_lone_run_starts_when_the_idle_percentage_cannot_be_measured(self) -> None:
        got = decide(FREE, sample=Unmeasurable())
        self.assertEqual(got.verdict, Verdict.ADMIT)

    def test_a_run_beside_another_waits_with_the_unmeasurable_reason(self) -> None:
        got = decide((True, False, False), last_start=NOW - 200, sample=Unmeasurable())
        self.assertEqual(
            got, Decision(Verdict.WAIT, "the CPU's idle percentage cannot be measured")
        )

    def test_the_fallback_does_not_apply_when_the_minimum_is_zero(self) -> None:
        got = decide((True, False, False), rules(min_idle=0), last_start=NOW - 200)
        self.assertEqual(got.verdict, Verdict.ADMIT)


class TimedOutSampleTest(unittest.TestCase):
    """A sample that timed out is not the unmeasurable case, so it waits a lone run as well.

    The script has no timeout and would still be waiting on `iostat`, which overruns only on a badly
    loaded Mac, so starting a lone run on a timeout would start it into the load the check is for.
    """

    def test_a_lone_run_waits_with_the_timeout_reason_when_the_sample_timed_out(self) -> None:
        got = decide(FREE, sample=TimedOut(10))
        self.assertEqual(got, Decision(Verdict.WAIT, "the CPU sample timed out after 10s"))

    def test_a_run_beside_another_waits_with_the_timeout_reason(self) -> None:
        got = decide((True, False, False), last_start=NOW - 200, sample=TimedOut(10))
        self.assertEqual(got, Decision(Verdict.WAIT, "the CPU sample timed out after 10s"))

    def test_the_reason_names_the_seconds_the_sample_was_given(self) -> None:
        got = decide((False, True, False), last_start=NOW - 200, sample=TimedOut(25))
        self.assertEqual(got.reason, "the CPU sample timed out after 25s")

    def test_a_lone_run_waits_on_a_timeout_where_it_starts_on_an_unmeasurable_reading(self) -> None:
        timed_out = decide(FREE, sample=TimedOut(10))
        unmeasurable = decide(FREE, sample=Unmeasurable())
        self.assertEqual((timed_out.verdict, unmeasurable.verdict), (Verdict.WAIT, Verdict.ADMIT))

    def test_beside_another_run_a_timeout_waits_as_an_unmeasurable_reading_does_with_its_own_reason(
        self,
    ) -> None:
        held = (True, False, False)
        timed_out = decide(held, last_start=NOW - 200, sample=TimedOut(10))
        unmeasurable = decide(held, last_start=NOW - 200, sample=Unmeasurable())
        self.assertEqual(timed_out.verdict, unmeasurable.verdict)
        self.assertNotEqual(timed_out.reason, unmeasurable.reason)


class TakeFailedTest(unittest.TestCase):
    """Check 5 of LOCK-PROTOCOL.md section 3: the checks passed and the take then found no free slot."""

    def test_the_decision_is_a_wait_with_the_all_held_reason(self) -> None:
        got = policy.take_failed(rules())
        self.assertEqual(got, Decision(Verdict.WAIT, "all 3 run slots are held"))

    def test_the_reason_counts_the_broker_slots_not_the_window(self) -> None:
        got = policy.take_failed(rules(slots=2, window=3))
        self.assertEqual(got.reason, "all 2 run slots are held")

    def test_it_is_the_decision_check_1_gives_when_every_slot_is_held(self) -> None:
        self.assertEqual(policy.take_failed(rules()), decide((True, True, True)))


class CheckOrderTest(unittest.TestCase):
    def test_slots_come_before_settle(self) -> None:
        got = decide((True, True, True), last_start=NOW - 1)
        self.assertEqual(got.reason, "all 3 run slots are held")

    def test_settle_comes_before_the_cpu(self) -> None:
        got = decide((True, False, False), last_start=NOW - 1, sample=Measured(0))
        self.assertEqual(got.reason, "a run started less than 90s ago")

    def test_the_decision_is_the_same_value_for_the_same_inputs(self) -> None:
        a = decide((True, False, False), last_start=NOW - 1)
        b = decide((True, False, False), last_start=NOW - 1)
        self.assertEqual(a, b)


class PurityTest(unittest.TestCase):
    """The core has no I/O because it imports nothing that could do any."""

    ALLOWED = {"__future__", "dataclasses", "enum", "typing", "broker"}

    def test_the_policy_module_imports_only_pure_modules(self) -> None:
        source = Path(policy.__file__).read_text(encoding="utf-8")
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertEqual(imported - self.ALLOWED, set())
        self.assertGreater(len(imported), 0, "the scan found no import at all")


if __name__ == "__main__":
    unittest.main()
