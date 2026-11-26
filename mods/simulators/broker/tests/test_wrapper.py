"""Tests for the wrapper: the process that starts the command, watches it and stops it at the limit.

The status mapping runs everywhere. The rest starts the real wrapper as a process and is run on
macOS only, since the wrapper watches the command's group leader by kqueue, as `sim-lock.sh`'s
does; elsewhere those tests are skipped with the reason printed.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
import unittest
from typing import List, Optional

from broker import protocol, wrapper
from broker.tests import programs
from broker.tests.process_case import (
    ONLY_ON_MACOS,
    ROOT,
    ClientCase,
    pid_is_alive,
    wait_until,
)
from broker.tests.support import stop_process


class ExitStatusTest(unittest.TestCase):
    def test_a_status_the_command_exited_with_is_kept(self) -> None:
        for status in (0, 1, 7, 75, 124, 126, 127, 255):
            with self.subTest(status=status):
                self.assertEqual(wrapper.exit_status(status), status)

    def test_a_command_killed_by_signal_n_is_128_plus_n(self) -> None:
        self.assertEqual(wrapper.exit_status(-signal.SIGTERM), 143)
        self.assertEqual(wrapper.exit_status(-signal.SIGKILL), 137)
        self.assertEqual(wrapper.exit_status(-signal.SIGINT), 130)


class CommandLineTest(unittest.TestCase):
    def test_the_wrapper_starts_isolated_with_the_package_then_the_limit_the_grace_and_the_command(
        self,
    ) -> None:
        argv = wrapper.argv(3600, 10, ["make", "-j", "4"], python="/usr/bin/python3")
        self.assertEqual(argv[:3], ["/usr/bin/python3", "-I", "-c"])
        self.assertEqual(argv[3], wrapper.BOOT)
        self.assertEqual(argv[4:], [ROOT, "3600", "10", "make", "-j", "4"])

    def test_the_boot_text_writes_no_bytecode_into_the_package(self) -> None:
        self.assertIn("sys.dont_write_bytecode = True", wrapper.BOOT)


@unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)
class WrapperProcessTest(ClientCase):
    def run_wrapper(
        self,
        *command: str,
        limit: int = 0,
        grace: int = 1,
        stdin: Optional[str] = None,
        within: float = 30.0,
    ) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            wrapper.argv(limit, grace, list(command)),
            input=stdin,
            stdin=None if stdin is not None else subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=within,
        )

    def spawn_wrapper(self, *command: str, limit: int = 0, grace: int = 1) -> "subprocess.Popen[str]":
        child = subprocess.Popen(
            wrapper.argv(limit, grace, list(command)),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(stop_process, child)
        return child

    # The command's status.

    def test_the_wrapper_exits_with_the_commands_own_status(self) -> None:
        for status in (0, 1, 7, 42):
            with self.subTest(status=status):
                done = self.run_wrapper(*self.python(programs.EXIT_WITH, str(status)))
                self.assertEqual(done.returncode, status)

    def test_a_command_that_itself_exits_with_a_code_the_broker_uses_leaves_that_status(self) -> None:
        for status in (protocol.EXIT_TIMEOUT, protocol.EXIT_RUN_LIMIT, protocol.EXIT_CANNOT_EXECUTE, protocol.EXIT_NOT_FOUND):
            with self.subTest(status=status):
                done = self.run_wrapper(*self.python(programs.EXIT_WITH, str(status)))
                self.assertEqual(done.returncode, status)
                self.assertEqual(done.stderr, "")  # the run's own line is what tells a kill from this

    def test_a_command_killed_by_a_signal_exits_128_plus_the_signal(self) -> None:
        source = "import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\nimport time\ntime.sleep(5)\n"
        self.assertEqual(self.run_wrapper(*self.python(source)).returncode, 143)

    def test_a_command_that_is_not_found_exits_127_and_says_why_on_stderr(self) -> None:
        done = self.run_wrapper("/nonexistent/dir/tool", "--flag")
        self.assertEqual(done.returncode, protocol.EXIT_NOT_FOUND)
        self.assertEqual(done.stderr, "sim-lock: /nonexistent/dir/tool: No such file or directory\n")

    def test_a_command_that_cannot_be_executed_exits_126_and_says_why_on_stderr(self) -> None:
        plain = self.path("not-executable")
        with open(plain, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\nexit 0\n")
        os.chmod(plain, 0o644)
        done = self.run_wrapper(plain)
        self.assertEqual(done.returncode, protocol.EXIT_CANNOT_EXECUTE)
        self.assertEqual(done.stderr, f"sim-lock: {plain}: Permission denied\n")

    # What the command sees.

    def test_the_command_keeps_the_stdin_of_the_wrapper(self) -> None:
        done = self.run_wrapper("/bin/cat", stdin="from the caller\n")
        self.assertEqual(done.returncode, 0)
        self.assertEqual(done.stdout, "from the caller\n")

    def test_the_command_leads_its_own_session_and_process_group(self) -> None:
        source = (
            "import os, sys\n"
            "ids = (os.getpid(), os.getpgid(0), os.getsid(0))\n"
            "sys.stdout.write('%d %d %d' % ids)\n"
        )
        done = self.run_wrapper(*self.python(source))
        pid, group, session = (int(word) for word in done.stdout.split())
        self.assertEqual((group, session), (pid, pid))

    def test_a_command_with_no_output_of_its_own_leaves_stdout_and_stderr_empty(self) -> None:
        done = self.run_wrapper(*self.python(programs.EXIT_WITH, "0"))
        self.assertEqual((done.stdout, done.stderr), ("", ""))

    # Signals.

    def test_a_signal_to_the_wrapper_reaches_the_command_and_the_wrapper_waits_for_it(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            with self.subTest(signal=sig.name):
                pid_name, mark_name = f"pid-{sig.name}", f"mark-{sig.name}"
                child = self.spawn_wrapper(
                    *self.python(programs.RECORD_A_SIGNAL, self.path(pid_name), self.path(mark_name))
                )
                self.read_pid(pid_name)
                os.kill(child.pid, sig)
                child.wait(timeout=15)
                with open(self.path(mark_name), encoding="utf-8") as handle:
                    self.assertEqual(int(handle.read()), int(sig))
                self.assertEqual(child.returncode, 3)

    # The run limit.

    def test_a_command_past_the_limit_gets_term_then_kill_and_the_wrapper_exits_124(self) -> None:
        started = time.monotonic()
        child = self.spawn_wrapper(
            *self.python(
                programs.TRAP_TERM_WITH_A_STUBBORN_GRANDCHILD,
                self.path("leader"),
                self.path("term-mark"),
                self.path("grandchild"),
            ),
            limit=2,
            grace=5,
        )
        leader, grandchild = self.read_pid("leader"), self.read_pid("grandchild")
        _, err = child.communicate(timeout=30)
        self.assertEqual(child.returncode, protocol.EXIT_RUN_LIMIT)
        with open(self.path("term-mark"), encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "term")  # TERM came first, and the leader's trap ran
        self.assertTrue(wait_until(lambda: not pid_is_alive(leader)), "the leader is still there")
        self.assertTrue(wait_until(lambda: not pid_is_alive(grandchild)), "the group's KILL missed")
        self.assertLess(time.monotonic() - started, 15)
        self.assertIn("ran over the run limit of 2s and was killed", err)

    def test_the_limit_message_is_the_brokers_text_and_names_the_limit(self) -> None:
        child = self.spawn_wrapper(*self.python(programs.IGNORE_TERM, self.path("pid")), limit=2, grace=1)
        self.read_pid("pid")
        _, err = child.communicate(timeout=30)
        self.assertEqual(
            err,
            "sim-lock: command ran over the run limit of 2s and was killed; its simulator may still "
            "be booted, so delete it\n",
        )

    def test_a_leader_that_ignores_term_is_killed_when_the_grace_period_ends(self) -> None:
        started = time.monotonic()
        child = self.spawn_wrapper(*self.python(programs.IGNORE_TERM, self.path("pid")), limit=2, grace=2)
        leader = self.read_pid("pid")
        child.communicate(timeout=30)
        elapsed = time.monotonic() - started
        self.assertEqual(child.returncode, protocol.EXIT_RUN_LIMIT)
        self.assertGreaterEqual(elapsed, 3.5)  # the limit, then the whole grace, then KILL
        self.assertTrue(wait_until(lambda: not pid_is_alive(leader)))

    def test_a_command_that_ends_before_the_limit_exits_with_its_own_status(self) -> None:
        done = self.run_wrapper(*self.python(programs.EXIT_WITH, "9"), limit=30)
        self.assertEqual(done.returncode, 9)

    def test_a_limit_of_zero_sets_no_limit(self) -> None:
        # The command runs a second and a half, which any limit of a second would have cut short.
        source = "import time\ntime.sleep(1.5)\n"
        done = self.run_wrapper(*self.python(source), limit=0)
        self.assertEqual(done.returncode, 0)

    def test_the_wrapper_exits_only_when_the_commands_leader_has_exited(self) -> None:
        child = self.spawn_wrapper(
            *self.python(programs.WAIT_FOR_RELEASE, self.path("pid"), self.path("release"))
        )
        leader = self.read_pid("pid")
        self.assertIsNone(child.poll())
        self.assertTrue(pid_is_alive(leader))
        self.release()
        child.wait(timeout=15)
        self.assertEqual(child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
