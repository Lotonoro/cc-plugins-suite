"""A base class for the process tests: a stand-in client on a scratch family, and ways to watch it.

A test starts the client with `start`, learns the ids of the processes it cares about from files
the command writes, and kills only ids it was given: the client's own `Popen`, or a pid a test
program wrote about itself. Every such id is killed again when the test ends, so a failed test
leaves nothing running.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import unittest
from typing import Callable, List, Optional, Tuple

from broker.family import Family
from broker.tests.support import scratch_dir, stop_process

# The directory that holds the `broker` package, where the client harness is run from.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ONLY_ON_MACOS = "the wrapper watches the command's group leader by kqueue, which only macOS has"


def pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_until(predicate: Callable[[], bool], within: float = 10.0) -> bool:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def children_of(pid: int) -> List[int]:
    """The ids of the processes whose parent is `pid`, read from the process table."""
    table = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True
    ).stdout
    found = []
    for line in table.splitlines():
        fields = line.split()
        if len(fields) == 2 and int(fields[1]) == pid:
            found.append(int(fields[0]))
    return found


class ClientCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.lock = os.path.join(self.dir, "lock")
        self.state = os.path.join(self.dir, "state")
        self.program_count = 0

    def path(self, name: str) -> str:
        return os.path.join(self.dir, name)

    def python(self, source: str, *args: str) -> List[str]:
        """A command that runs `source` as a script in this test's directory, with `args`."""
        self.program_count += 1
        script = self.path(f"program-{self.program_count}.py")
        with open(script, "w", encoding="utf-8") as handle:
            handle.write(source)
        return [sys.executable, script, *args]

    def kill_at_the_end(self, pid: int) -> None:
        """Kills a process this test recorded when the test ends, if it still runs."""
        self.addCleanup(self.kill_recorded, pid)

    def kill_recorded(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGKILL)  # a command leads its own group, so this is its group
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def read_pid(self, name: str, within: float = 10.0) -> int:
        """The pid a test program wrote to the file `name`, waited for; killed at the test's end."""
        path = self.path(name)
        self.assertTrue(
            wait_until(lambda: os.path.exists(path) and os.path.getsize(path) > 0, within),
            f"{name} was never written",
        )
        with open(path, encoding="utf-8") as handle:
            pid = int(handle.read())
        self.kill_at_the_end(pid)
        return pid

    def release(self, name: str = "release") -> None:
        with open(self.path(name), "w", encoding="utf-8") as handle:
            handle.write("go")

    def start(
        self,
        *command: str,
        pipe_stdin: bool = False,
        slots: int = 3,
        min_idle: int = 0,
        poll: int = 1,
        timeout: int = 30,
        status: int = 0,
        run_limit: int = 0,
        grace: int = 1,
    ) -> "subprocess.Popen[str]":
        """Starts the stand-in client on this test's family with `command` as the metered command."""
        params = dict(
            lock=self.lock, state=self.state, slots=slots, min_idle=min_idle, poll=poll,
            timeout=timeout, status=status, run_limit=run_limit, grace=grace,
        )  # fmt: skip
        child = subprocess.Popen(
            [sys.executable, "-m", "broker.tests.client_harness", json.dumps(params), *command],
            cwd=ROOT,
            stdin=subprocess.PIPE if pipe_stdin else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
        )
        self.addCleanup(stop_process, child)
        return child

    def finish(
        self, child: "subprocess.Popen[str]", stdin: Optional[str] = None, within: float = 30.0
    ) -> Tuple[int, str, str]:
        """Waits for the client to end, giving it `stdin`; returns its status, stdout and stderr.

        Reads both streams to their end, so a command still running that holds them open, such as
        one the test left behind on purpose, keeps this waiting: such a test waits on the client.
        """
        try:
            out, err = child.communicate(input=stdin, timeout=within)
        except subprocess.TimeoutExpired:
            self.fail(f"the client did not end within {within}s")
        return child.returncode, out, err

    def slot_is_held(self, slot: int, slots: int = 3) -> bool:
        family = Family(self.lock, slots=slots, window=slots)
        with family.gate():
            return family.probe(slot)
