"""Tests for the metered runner: the client that holds the slot and starts the wrapper.

The signal forwarding and the 75 for a wait that gave up run everywhere. The runs themselves start
the real wrapper and are run on macOS only, through a stand-in client on a scratch family: the
status of the run, the slot held through it and after the client is killed, what a daemon holds,
and the run limit.
"""

from __future__ import annotations

import errno
import os
import re
import signal
import subprocess
import sys
import unittest
from typing import List, Tuple

from broker import protocol
from broker.decisions import DecisionStore
from broker.errors import BrokerError
from broker.leaf import Admitted, Applicant
from broker.runner import RunLimits, SignalForwarder, metered_run, run_in_wrapper
from broker.tests import programs
from broker.tests.process_case import (
    ONLY_ON_MACOS,
    ROOT,
    ClientCase,
    children_of,
    pid_is_alive,
    wait_until,
)
from broker.tests.support import hold_in_another_process, scratch_dir
from broker.waiter import GaveUp


class FakeWrapperProcess:
    def __init__(self) -> None:
        self.sent: List[int] = []

    def send_signal(self, signum: int) -> None:
        self.sent.append(signum)


class StubWaiter:
    """A waiter that returns what it was given, so a test chooses how the wait ended."""

    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.applicants: List[Applicant] = []

    def wait(self, applicant: Applicant) -> object:
        self.applicants.append(applicant)
        return self.outcome


class SignalForwarderTest(unittest.TestCase):
    def test_a_signal_before_the_wrapper_exists_is_held_and_sent_in_order_once_it_does(self) -> None:
        forwarder = SignalForwarder()
        forwarder.handle(signal.SIGHUP)
        forwarder.handle(signal.SIGTERM)
        wrapper = FakeWrapperProcess()
        self.assertEqual(wrapper.sent, [])
        forwarder.attach(wrapper)  # type: ignore[arg-type]
        self.assertEqual(wrapper.sent, [signal.SIGHUP, signal.SIGTERM])

    def test_a_signal_after_the_wrapper_exists_is_sent_at_once(self) -> None:
        forwarder = SignalForwarder()
        wrapper = FakeWrapperProcess()
        forwarder.attach(wrapper)  # type: ignore[arg-type]
        forwarder.handle(signal.SIGINT)
        self.assertEqual(wrapper.sent, [signal.SIGINT])

    def test_a_held_signal_is_sent_once_not_again_at_the_next_one(self) -> None:
        forwarder = SignalForwarder()
        forwarder.handle(signal.SIGHUP)
        wrapper = FakeWrapperProcess()
        forwarder.attach(wrapper)  # type: ignore[arg-type]
        forwarder.handle(signal.SIGTERM)
        self.assertEqual(wrapper.sent, [signal.SIGHUP, signal.SIGTERM])


class MeteredRunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.applicant = Applicant(pid=1, cwd="/tmp", command=(sys.executable, "-c", "pass"))

    def test_a_wait_that_gave_up_exits_75_and_starts_no_command(self) -> None:
        mark = os.path.join(self.dir, "mark")
        applicant = Applicant(pid=1, cwd="/tmp", command=(sys.executable, "-c", programs.LEAVE_A_MARK, "ran", mark))
        waiter = StubWaiter(GaveUp(3600, "all 3 run slots are held"))
        self.assertEqual(metered_run(waiter, applicant), protocol.EXIT_TIMEOUT)  # type: ignore[arg-type]
        self.assertFalse(os.path.exists(mark))

    def test_a_wrapper_that_cannot_be_started_is_a_failure_to_execute_and_the_slot_is_still_closed(self) -> None:
        fd = os.open(os.path.join(self.dir, "slot"), os.O_WRONLY | os.O_CREAT, 0o600)
        with self.assertRaises(BrokerError) as caught:
            run_in_wrapper(fd, ["tool"], RunLimits(0, 1), python="/nonexistent/python")
        self.assertEqual(caught.exception.exit_code, protocol.EXIT_CANNOT_EXECUTE)
        self.assertIn("/nonexistent/python", str(caught.exception))
        os.close(fd)  # the caller closes the slot it was given, so this one is still open

    @unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
    def test_the_slot_descriptor_is_closed_when_the_run_ends(self) -> None:
        fd = os.open(os.path.join(self.dir, "slot"), os.O_WRONLY | os.O_CREAT, 0o600)
        waiter = StubWaiter(Admitted(slot=0, fd=fd))
        self.assertEqual(metered_run(waiter, self.applicant, RunLimits(0, 1)), 0)  # type: ignore[arg-type]
        with self.assertRaises(OSError) as caught:
            os.fstat(fd)
        self.assertEqual(caught.exception.errno, errno.EBADF)

    def test_the_slot_descriptor_is_closed_when_the_wrapper_cannot_start_too(self) -> None:
        fd = os.open(os.path.join(self.dir, "slot"), os.O_WRONLY | os.O_CREAT, 0o600)
        waiter = StubWaiter(Admitted(slot=0, fd=fd))
        with self.assertRaises(BrokerError):
            metered_run(waiter, self.applicant, RunLimits(0, 1), python="/nonexistent/python")  # type: ignore[arg-type]
        with self.assertRaises(OSError):
            os.fstat(fd)

    @unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
    def test_the_signal_handlers_the_run_installed_are_put_back_when_it_ends(self) -> None:
        before = [signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)]
        fd = os.open(os.path.join(self.dir, "slot"), os.O_WRONLY | os.O_CREAT, 0o600)
        metered_run(StubWaiter(Admitted(slot=0, fd=fd)), self.applicant, RunLimits(0, 1))  # type: ignore[arg-type]
        after = [signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)]
        self.assertEqual(before, after)


@unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
class RunStatusTest(ClientCase):
    def test_the_run_exits_with_the_commands_status_and_prints_nothing_of_its_own(self) -> None:
        for status in (0, 7):
            with self.subTest(status=status):
                code, out, err = self.finish(self.start(*self.python(programs.EXIT_WITH, str(status))))
                self.assertEqual((code, out, err), (status, "", ""))

    def test_a_command_killed_by_a_signal_gives_128_plus_the_signal(self) -> None:
        source = "import os, signal, time\nos.kill(os.getpid(), signal.SIGTERM)\ntime.sleep(5)\n"
        code, _, _ = self.finish(self.start(*self.python(source)))
        self.assertEqual(code, 143)

    def test_a_command_that_is_not_found_gives_127_and_one_not_executable_gives_126(self) -> None:
        code, _, err = self.finish(self.start("/nonexistent/dir/tool"))
        self.assertEqual((code, err), (protocol.EXIT_NOT_FOUND, "sim-lock: /nonexistent/dir/tool: No such file or directory\n"))
        plain = self.path("not-executable")
        with open(plain, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\nexit 0\n")
        os.chmod(plain, 0o644)
        code, _, err = self.finish(self.start(plain))
        self.assertEqual((code, err), (protocol.EXIT_CANNOT_EXECUTE, f"sim-lock: {plain}: Permission denied\n"))

    def test_a_command_that_exits_with_a_code_the_broker_uses_leaves_that_status(self) -> None:
        for status in (protocol.EXIT_TIMEOUT, protocol.EXIT_RUN_LIMIT, protocol.EXIT_CANNOT_EXECUTE, protocol.EXIT_NOT_FOUND):
            with self.subTest(status=status):
                code, _, err = self.finish(self.start(*self.python(programs.EXIT_WITH, str(status))))
                self.assertEqual((code, err), (status, ""))

    def test_the_command_keeps_the_clients_stdin_and_its_output_is_its_own(self) -> None:
        child = self.start("/bin/cat", pipe_stdin=True)
        code, out, err = self.finish(child, stdin="from the caller\n")
        self.assertEqual((code, out, err), (0, "from the caller\n", ""))

    def test_a_wait_that_reaches_the_timeout_exits_75_and_the_command_does_not_run(self) -> None:
        for slot in range(3):
            hold_in_another_process(self, self.lock if slot == 0 else f"{self.lock}.{slot}")
        mark = self.path("mark")
        child = self.start(*self.python(programs.LEAVE_A_MARK, "ran", mark), timeout=2, poll=1)
        code, _, err = self.finish(child)
        self.assertEqual(code, protocol.EXIT_TIMEOUT)
        self.assertIn("sim-lock: waiting for a simulator run slot: all 3 run slots are held; running now:", err)
        self.assertRegex(err, r"sim-lock: gave up after [23]s: all 3 run slots are held\n$")
        self.assertFalse(os.path.exists(mark))


@unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
class SlotHoldingTest(ClientCase):
    def running_command(self, **limits: int) -> Tuple["subprocess.Popen[str]", int]:
        """A client whose command waits for `release`; returns the client and the command's pid."""
        child = self.start(
            *self.python(programs.WAIT_FOR_RELEASE, self.path("command-pid"), self.path("release")),
            **limits,
        )
        return child, self.read_pid("command-pid")

    def test_the_slot_is_held_for_the_run_and_free_after_it(self) -> None:
        child, _ = self.running_command()
        self.assertTrue(self.slot_is_held(0))
        self.release()
        code, _, _ = self.finish(child)
        self.assertEqual(code, 0)
        self.assertFalse(self.slot_is_held(0))

    def test_the_slots_owner_record_names_the_client_the_directory_and_the_command(self) -> None:
        child, _ = self.running_command()
        with open(self.lock + ".owner", encoding="utf-8") as handle:
            record = handle.read()
        pattern = (
            rf"^pid={child.pid} slot=0 cwd={re.escape(os.path.realpath(ROOT))} "
            r"started=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} "
            rf"command={re.escape(sys.executable)} {re.escape(self.path('program-1.py'))} .*\n$"
        )
        self.assertRegex(record, pattern)
        self.release()
        self.finish(child)

    def test_killing_the_client_leaves_the_slot_held_and_the_command_running_until_it_ends(self) -> None:
        child, command = self.running_command()
        wrapper_pids = children_of(child.pid)
        self.assertEqual(len(wrapper_pids), 1)
        self.kill_at_the_end(wrapper_pids[0])
        os.kill(child.pid, signal.SIGKILL)
        child.wait()
        self.assertTrue(pid_is_alive(command))
        self.assertTrue(self.slot_is_held(0), "the slot was freed with the client")
        self.release()
        self.assertTrue(wait_until(lambda: not pid_is_alive(command)))
        self.assertTrue(wait_until(lambda: not self.slot_is_held(0)), "the slot outlived the command")

    def test_killing_the_wrapper_frees_the_slot_as_killing_the_scripts_wrapper_does(self) -> None:
        child, command = self.running_command()
        (wrapper_pid,) = children_of(child.pid)
        self.kill_at_the_end(wrapper_pid)
        os.kill(wrapper_pid, signal.SIGKILL)
        # The command still runs and holds the client's streams, so the client is waited for, not read.
        self.assertEqual(child.wait(timeout=30), 137)
        self.assertFalse(self.slot_is_held(0))
        self.assertTrue(pid_is_alive(command), "the command should run on after its wrapper is killed")

    def test_a_daemon_the_command_leaves_running_holds_no_slot(self) -> None:
        child = self.start(*self.python(programs.LEAVE_A_DAEMON, self.path("daemon-pid")))
        daemon = self.read_pid("daemon-pid")
        code, _, _ = self.finish(child)
        self.assertEqual(code, 0)
        self.assertTrue(pid_is_alive(daemon))
        self.assertFalse(self.slot_is_held(0))

    def test_a_second_run_waits_behind_a_held_slot_and_starts_when_it_frees(self) -> None:
        first, _ = self.running_command(slots=1)
        second = self.start(*self.python(programs.EXIT_WITH, "0"), slots=1)
        decisions = DecisionStore(self.state)

        def second_has_waited() -> bool:
            record = decisions.read()
            return record is not None and record.decision == protocol.DECISION_WAIT

        self.assertTrue(wait_until(second_has_waited), "the second run never made an attempt")
        self.assertIsNone(second.poll(), "the second run started beside the first with one slot")
        self.release()
        code, _, err = self.finish(second)
        self.assertEqual(code, 0)
        self.assertEqual(self.finish(first)[0], 0)
        lines = err.splitlines()
        self.assertEqual(
            lines[0],
            "sim-lock: waiting for a simulator run slot: all 1 run slots are held; running now:",
        )
        self.assertRegex(lines[1], rf"^  pid={first.pid} slot=0 ")


@unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
class SignalsAndLimitTest(ClientCase):
    def end_a_waiting_run_with(self, sig: signal.Signals) -> None:
        """Before admission nothing handles INT, TERM or HUP: the run dies of the signal."""
        hold_in_another_process(self, self.lock)
        child = self.start("/bin/true", slots=1)
        decisions = DecisionStore(self.state)

        def has_waited() -> bool:
            record = decisions.read()
            return record is not None and record.decision == protocol.DECISION_WAIT

        self.assertTrue(wait_until(has_waited), "the run never made an attempt")
        os.kill(child.pid, sig)
        self.assertEqual(child.wait(timeout=15), -int(sig), "the run was not killed by the signal")
        assert child.stderr is not None
        self.assertNotIn("Traceback", child.stderr.read())

    def test_an_interrupt_ends_a_run_still_waiting_as_it_ends_the_scripts(self) -> None:
        self.end_a_waiting_run_with(signal.SIGINT)

    def test_a_terminate_ends_a_run_still_waiting(self) -> None:
        self.end_a_waiting_run_with(signal.SIGTERM)

    def test_a_hangup_ends_a_run_still_waiting(self) -> None:
        self.end_a_waiting_run_with(signal.SIGHUP)

    def test_a_signal_to_the_client_reaches_the_command_and_the_run_ends_with_its_status(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with self.subTest(signal=sig.name):
                pid_name, mark_name = f"pid-{sig.name}", f"mark-{sig.name}"
                child = self.start(*self.python(programs.RECORD_A_SIGNAL, self.path(pid_name), self.path(mark_name)))
                self.read_pid(pid_name)
                os.kill(child.pid, sig)
                code, _, _ = self.finish(child)
                self.assertEqual(code, 3)
                with open(self.path(mark_name), encoding="utf-8") as handle:
                    self.assertEqual(int(handle.read()), int(sig))
                self.assertFalse(self.slot_is_held(0))

    def test_a_command_past_the_run_limit_gets_term_then_kill_and_the_run_exits_124(self) -> None:
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
        self.assertEqual(code, protocol.EXIT_RUN_LIMIT)
        with open(self.path("term-mark"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "term")
        self.assertTrue(wait_until(lambda: not pid_is_alive(leader)), "the leader is still there")
        self.assertTrue(wait_until(lambda: not pid_is_alive(grandchild)), "a process of the group is left")
        self.assertIn("ran over the run limit of 2s and was killed", err)
        self.assertFalse(self.slot_is_held(0))


if __name__ == "__main__":
    unittest.main()
