"""The machine adapter: the CPU's idle percentage, the free memory and the core count.

The adapter is the one place the broker runs a tool to learn about the machine. Every call has a
timeout. A tool that outlasts it is killed with its whole process group and reaped, so no call
leaves a child behind, and the timeout is a reading (`TimedOut`) that a waiter reports as its
reason. A tool that cannot be run, or prints nothing the adapter can read, is `Unmeasurable`.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
from typing import Optional, Protocol, Sequence, Union

from broker.policy import Measured, Sample, TimedOut, Unmeasurable

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 10
# The idle percentage is the third field of the last line, over the second of the two samples,
# which covers one second: what `sim-lock.sh` reads (LOCK-PROTOCOL.md section 3.1).
IOSTAT = ("iostat", "-c", "2", "-w", "1", "-n", "0")
MEMORY_PRESSURE = ("memory_pressure", "-Q")

_WHOLE_NUMBER = re.compile(r"[0-9]+")
_MEMORY_FREE = re.compile(r"System-wide memory free percentage: ([0-9]+)%")


class MachineAdapter(Protocol):
    """What the take-time leaf and the verbs need of the machine; tests give them a fake."""

    def cpu_idle(self) -> Sample: ...

    def memory_free(self) -> Sample: ...

    def cores(self) -> int: ...


def _last_record(text: str) -> str:
    """The last line of `text` as awk reads it: a final newline ends a record, it starts none."""
    lines = text.split("\n")
    if text.endswith("\n"):
        lines.pop()
    return lines[-1]


def _kill_group(child: "subprocess.Popen[bytes]") -> None:
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        # The group is gone, or on macOS holds only the unreaped leader, which refuses with EPERM.
        pass


def _stop(child: "subprocess.Popen[bytes]") -> None:
    """Kills the child's group if it still runs, reaps the child and closes its pipe."""
    if child.poll() is None:
        _kill_group(child)
        child.wait()
    if child.stdout is not None:
        child.stdout.close()


class Machine:
    """The real adapter. The commands are parameters so that tests run stand-ins."""

    def __init__(
        self,
        timeout_seconds: int = TIMEOUT_SECONDS,
        iostat: Sequence[str] = IOSTAT,
        memory_pressure: Sequence[str] = MEMORY_PRESSURE,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.iostat_command = tuple(iostat)
        self.memory_command = tuple(memory_pressure)

    def _capture(self, argv: Sequence[str]) -> Union[str, TimedOut]:
        """What the tool printed on stdout, or TimedOut when it outlasted the timeout.

        The exit status is not consulted, as the script's is not: only what was printed counts.
        """
        try:
            child = subprocess.Popen(
                list(argv),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as err:
            logger.debug("[MACHINE] cannot run %s: %s", argv[0], err.strerror or err)
            return ""
        try:
            out, _ = child.communicate(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired:
            logger.debug("[MACHINE] %s outlasted %ss and was killed", argv[0], self.timeout_seconds)
            return TimedOut(self.timeout_seconds)
        finally:
            _stop(child)
        return out.decode("utf-8", errors="replace")

    def cpu_idle(self) -> Sample:
        out = self._capture(self.iostat_command)
        if isinstance(out, TimedOut):
            return out
        fields = _last_record(out).split()
        idle = fields[2] if len(fields) >= 3 else ""
        if _WHOLE_NUMBER.fullmatch(idle):
            return Measured(int(idle))
        logger.debug("[MACHINE] no idle percentage in the output of %s", self.iostat_command[0])
        return Unmeasurable()

    def memory_free(self) -> Sample:
        out = self._capture(self.memory_command)
        if isinstance(out, TimedOut):
            return out
        found: Optional["re.Match[str]"] = _MEMORY_FREE.search(out)
        if found is None:
            logger.debug("[MACHINE] no free percentage in the output of %s", self.memory_command[0])
            return Unmeasurable()
        return Measured(int(found.group(1)))

    def cores(self) -> int:
        return max(1, os.cpu_count() or 1)
