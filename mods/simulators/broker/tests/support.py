"""What the broker's test modules share: scratch directories, fakes and process helpers.

Every scratch directory is made under `/tmp` and removed when its test ends, so a lock family
a test builds is its own and never the default `/tmp/pango-sim-test.flock`. No test here starts a
simulator or an emulator: the machine is `FakeMachine`, and the processes a test starts are
`sleep`, `sh` and Python stand-ins that this module's helpers kill by the id they were started with.
"""

from __future__ import annotations

import fcntl
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from typing import Callable, List, Optional, Sequence, Tuple

from broker.family import Family
from broker.policy import Measured, Sample

# Holds the flock on the file it is given until it is killed, and says so on stdout.
HOLDER_SOURCE = (
    "import fcntl, os, sys, time\n"
    "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o666)\n"
    "fcntl.flock(fd, fcntl.LOCK_EX)\n"
    "print('held', flush=True)\n"
    "time.sleep(60)\n"
)

# A time to start the fake clock at, a few seconds after an epoch hour.
EPOCH = 1_764_079_200


def scratch_dir(case: unittest.TestCase) -> str:
    """A new directory under /tmp, removed when the test ends; returns its path."""
    path = tempfile.mkdtemp(prefix="broker-test-", dir="/tmp")
    case.addCleanup(shutil.rmtree, path, ignore_errors=True)
    return os.path.realpath(path)


def stop_process(child: "subprocess.Popen[str]") -> None:
    """Kills the child by the id it was started with, reaps it and closes its pipes."""
    if child.poll() is None:
        child.kill()
    child.wait()
    for pipe in (child.stdout, child.stderr, child.stdin):
        if pipe is not None:
            pipe.close()


def hold_in_another_process(case: unittest.TestCase, path: str) -> "subprocess.Popen[str]":
    """A process that holds the flock on `path` until it is killed or the test ends."""
    child = subprocess.Popen(
        [sys.executable, "-c", HOLDER_SOURCE, path], stdout=subprocess.PIPE, text=True
    )
    case.addCleanup(stop_process, child)
    assert child.stdout is not None
    case.assertEqual(child.stdout.readline().strip(), "held")
    return child


def gate_is_held(family: Family) -> bool:
    """Whether some open file description holds the family's gate, tried without blocking."""
    fd = os.open(family.gate_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o666)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
    finally:
        os.close(fd)  # releases the flock when the try took it


class FakeClock:
    """A clock that moves only when a test says so, or when something sleeps or samples."""

    def __init__(self, start: int = EPOCH) -> None:
        self.time = start
        self.sleeps: List[float] = []

    def now(self) -> int:
        return int(self.time)

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.time += seconds

    def advance(self, seconds: float) -> None:
        self.time += seconds


class FakeMachine:
    """A machine adapter with scripted readings, a count of calls and a hook inside a sample.

    `cpu` is the readings in order, the last one repeating. A sample takes `sample_seconds` of the
    fake clock's time, as the real one takes a second, so the time an attempt takes shows in the
    waits that count it.
    """

    def __init__(
        self,
        cpu: Sequence[Sample] = (Measured(90),),
        memory: Sample = Measured(60),
        cores: int = 12,
        clock: Optional[FakeClock] = None,
        sample_seconds: int = 1,
    ) -> None:
        self.cpu = tuple(cpu)
        self.memory = memory
        self.core_count = cores
        self.clock = clock
        self.sample_seconds = sample_seconds
        self.cpu_calls = 0
        self.memory_calls = 0
        self.inside_sample: Optional[Callable[[], None]] = None

    def cpu_idle(self) -> Sample:
        reading = self.cpu[min(self.cpu_calls, len(self.cpu) - 1)]
        self.cpu_calls += 1
        if self.inside_sample is not None:
            self.inside_sample()
        if self.clock is not None:
            self.clock.advance(self.sample_seconds)
        return reading

    def memory_free(self) -> Sample:
        self.memory_calls += 1
        return self.memory

    def cores(self) -> int:
        return self.core_count


class SpyFamily(Family):
    """A family that notes whether the gate was held at each call that must be under it.

    `refuse_takes` is how many takes find no free slot, as when a slot is taken between the
    decision and the take, before the real take runs again.
    """

    UNDER_THE_GATE = ("probe_all", "take_lowest_free", "write_last_start", "write_owner")

    def __init__(self, *args: object, refuse_takes: int = 0, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.refuse_takes = refuse_takes
        self.calls: List[Tuple[str, bool]] = []

    def _note(self, name: str) -> None:
        self.calls.append((name, gate_is_held(self)))

    def probe_all(self) -> Tuple[bool, ...]:
        self._note("probe_all")
        return super().probe_all()

    def take_lowest_free(self) -> Optional[Tuple[int, int]]:
        self._note("take_lowest_free")
        if self.refuse_takes > 0:
            self.refuse_takes -= 1
            return None
        return super().take_lowest_free()

    def write_last_start(self, epoch: int) -> None:
        self._note("write_last_start")
        super().write_last_start(epoch)

    def write_owner(self, slot: int, record: str) -> None:
        self._note("write_owner")
        super().write_owner(slot, record)

    def names(self) -> List[str]:
        return [name for name, _ in self.calls]

    def every_call_held_the_gate(self) -> bool:
        return all(held for _, held in self.calls)
