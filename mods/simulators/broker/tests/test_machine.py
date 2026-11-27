"""Tests for the machine adapter: reading the CPU and memory, and the timeout on every call.

The adapter runs real child processes here, but never iostat or memory_pressure themselves: each
test hands it a stand-in command that prints what the tool prints or hangs, so no result depends
on how busy this Mac is.
"""

from __future__ import annotations

import os
import time
import unittest
from typing import List

from broker.machine import Machine
from broker.policy import Measured, TimedOut, Unmeasurable
from broker.tests.support import scratch_dir

IOSTAT_OUTPUT = (
    "              cpu    load average\n"
    " us sy id   1m   5m   15m\n"
    " 10  6 84  175.65 159.08 87.66\n"
    " 52 22 26  162.54 156.64 87.21\n"
)


def printing(text: str) -> List[str]:
    """A stand-in command that prints `text` exactly and exits 0."""
    return ["/usr/bin/printf", "%s", text]


def cpu(argv: List[str], timeout: int = 5) -> Machine:
    return Machine(timeout_seconds=timeout, iostat=argv)


class CpuIdleTest(unittest.TestCase):
    def test_idle_is_the_third_field_of_the_last_line(self) -> None:
        self.assertEqual(cpu(printing(IOSTAT_OUTPUT)).cpu_idle(), Measured(26))

    def test_a_third_field_that_is_not_a_whole_number_cannot_be_measured(self) -> None:
        for text in (" 1 2 7.5 x\n", " 1 2 abc\n", " 1 2 -3\n", " 1 2 ٣\n"):
            with self.subTest(text=text):
                self.assertEqual(cpu(printing(text)).cpu_idle(), Unmeasurable())

    def test_a_last_line_with_fewer_than_three_fields_cannot_be_measured(self) -> None:
        self.assertEqual(cpu(printing("1 2\n")).cpu_idle(), Unmeasurable())

    def test_output_that_ends_in_a_blank_line_is_read_from_that_line_as_awk_reads_it(self) -> None:
        # The script's `awk 'END { print $3 }'` takes the last record, which is the empty one.
        self.assertEqual(cpu(printing(" 1 2 55\n\n")).cpu_idle(), Unmeasurable())

    def test_output_with_no_line_end_is_read_from_its_last_line(self) -> None:
        self.assertEqual(cpu(printing(" 1 2 55")).cpu_idle(), Measured(55))

    def test_no_output_cannot_be_measured(self) -> None:
        self.assertEqual(cpu(["/usr/bin/true"]).cpu_idle(), Unmeasurable())

    def test_a_tool_that_fails_with_no_output_cannot_be_measured(self) -> None:
        self.assertEqual(cpu(["/usr/bin/false"]).cpu_idle(), Unmeasurable())

    def test_the_exit_status_is_not_consulted_only_what_the_tool_printed(self) -> None:
        argv = ["/bin/sh", "-c", "printf ' 1 2 40\\n'; exit 3"]
        self.assertEqual(cpu(argv).cpu_idle(), Measured(40))

    def test_a_tool_that_is_not_there_cannot_be_measured(self) -> None:
        self.assertEqual(cpu(["/nonexistent/iostat"]).cpu_idle(), Unmeasurable())

    def test_a_tool_that_cannot_be_executed_cannot_be_measured(self) -> None:
        self.assertEqual(cpu(["/etc/hosts"]).cpu_idle(), Unmeasurable())

    def test_the_default_command_is_iostat_over_one_second(self) -> None:
        self.assertEqual(
            Machine().iostat_command, ("iostat", "-c", "2", "-w", "1", "-n", "0")
        )


class MemoryFreeTest(unittest.TestCase):
    def memory(self, argv: List[str], timeout: int = 5) -> Machine:
        return Machine(timeout_seconds=timeout, memory_pressure=argv)

    def test_free_memory_is_the_percentage_the_tool_reports(self) -> None:
        text = (
            "The system has 68719476736 (4194304 pages with a page size of 16384).\n"
            "System-wide memory free percentage: 64%\n"
        )
        self.assertEqual(self.memory(printing(text)).memory_free(), Measured(64))

    def test_output_with_no_such_line_cannot_be_measured(self) -> None:
        self.assertEqual(self.memory(printing("nothing\n")).memory_free(), Unmeasurable())

    def test_a_tool_that_is_not_there_cannot_be_measured(self) -> None:
        self.assertEqual(self.memory(["/nonexistent/memory_pressure"]).memory_free(), Unmeasurable())

    def test_a_memory_call_that_outlasts_the_timeout_times_out(self) -> None:
        got = self.memory(["/bin/sleep", "30"], timeout=1).memory_free()
        self.assertEqual(got, TimedOut(1))


class TimeoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = scratch_dir(self)

    def gone(self, pid: int, within: float = 5.0) -> bool:
        """Whether no process has this id any more, which a killed but unreaped child does not meet."""
        deadline = time.monotonic() + within
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.05)
        return False

    def read_pid(self, name: str) -> int:
        with open(os.path.join(self.dir, name), encoding="utf-8") as handle:
            return int(handle.read().strip())

    def test_a_cpu_call_that_outlasts_the_timeout_times_out_and_returns_at_once(self) -> None:
        started = time.monotonic()
        got = cpu(["/bin/sleep", "30"], timeout=1).cpu_idle()
        self.assertEqual(got, TimedOut(1))
        self.assertLess(time.monotonic() - started, 10)

    def test_the_child_that_timed_out_is_killed_and_reaped(self) -> None:
        pid_file = os.path.join(self.dir, "pid")
        argv = ["/bin/sh", "-c", f"echo $$ > '{pid_file}'; exec sleep 30"]
        self.assertEqual(cpu(argv, timeout=1).cpu_idle(), TimedOut(1))
        self.assertTrue(self.gone(self.read_pid("pid")), "the child is still there, or a zombie")

    def test_a_grandchild_the_child_started_is_killed_too(self) -> None:
        pid_file = os.path.join(self.dir, "grandchild")
        argv = ["/bin/sh", "-c", f"sleep 30 & echo $! > '{pid_file}'; wait"]
        self.assertEqual(cpu(argv, timeout=1).cpu_idle(), TimedOut(1))
        self.assertTrue(self.gone(self.read_pid("grandchild")), "the grandchild outlived the call")

    def test_a_call_that_finishes_in_time_leaves_no_child_either(self) -> None:
        pid_file = os.path.join(self.dir, "pid")
        argv = ["/bin/sh", "-c", f"echo $$ > '{pid_file}'; printf ' 1 2 61\\n'"]
        self.assertEqual(cpu(argv).cpu_idle(), Measured(61))
        self.assertTrue(self.gone(self.read_pid("pid")))


class CoresTest(unittest.TestCase):
    def test_the_core_count_is_the_machines_and_at_least_one(self) -> None:
        self.assertEqual(Machine().cores(), max(1, os.cpu_count() or 1))


if __name__ == "__main__":
    unittest.main()
