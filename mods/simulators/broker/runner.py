"""The metered runner: the client that waits for a slot, holds it, and runs the command under it.

One process does all of it, as `sim-lock.sh` does, so a take-time check that fails leaves the
process that failed still waiting, and the process's exit is the session's notice that the run
ended. After the waiter admits it, the client holds the slot's flock on a descriptor and starts the
wrapper with that descriptor inherited, so the client and the wrapper both hold the flock. It then
waits until the wrapper is gone. Killing the client therefore leaves the slot held until the
command's group leader has exited, and killing the wrapper frees it.

Before admission nothing handles INT, TERM or HUP, as in the script: the process ends by the
signal. After it, the client passes each to the wrapper, which sends it to the command's group,
and goes on waiting, so the slot stays held until the command is gone.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Sequence

from broker import protocol, wrapper
from broker.errors import WrapperError
from broker.leaf import Applicant
from broker.waiter import GaveUp, Waiter

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RunLimits:
    """How long a command may run, and how long its leader has between TERM and KILL."""

    run_limit_seconds: int = protocol.RUN_LIMIT_SECONDS  # 0 for no limit
    kill_grace_seconds: int = protocol.KILL_GRACE_SECONDS


class SignalForwarder:
    """Passes signals to the wrapper, holding those that arrive before it exists."""

    SIGNALS = wrapper.SIGNALS

    def __init__(self) -> None:
        self._wrapper: Optional["subprocess.Popen[bytes]"] = None
        self._pending: List[int] = []

    def handle(self, signum: int, frame: object = None) -> None:
        if self._wrapper is None:
            self._pending.append(signum)
        else:
            self._wrapper.send_signal(signum)

    def attach(self, process: "subprocess.Popen[bytes]") -> None:
        """Starts passing signals to `process`, after those held, in the order they came."""
        self._wrapper = process
        while self._pending:
            process.send_signal(self._pending.pop(0))


@contextmanager
def _handlers(forwarder: SignalForwarder) -> Iterator[None]:
    previous: Dict[int, Any] = {}
    for sig in forwarder.SIGNALS:
        previous[sig] = signal.signal(sig, forwarder.handle)
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


@contextmanager
def _interrupt_ends_the_process() -> Iterator[None]:
    """Gives INT its default effect while the run waits, as the script's has: Python would raise."""
    previous = signal.signal(signal.SIGINT, signal.SIG_DFL)
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, previous)


def run_in_wrapper(
    slot_fd: int,
    command: Sequence[str],
    limits: RunLimits,
    python: str = sys.executable,
) -> int:
    """Runs `command` under the wrapper, which inherits the slot's descriptor; returns the status.

    The caller keeps and closes its own descriptor. The status is the command's, 128+N when signal
    N killed it, and 124 when it ran past the limit; a wrapper that cannot be started is a
    WrapperError.
    """
    forwarder = SignalForwarder()
    with _handlers(forwarder):
        try:
            process = subprocess.Popen(
                wrapper.argv(limits.run_limit_seconds, limits.kill_grace_seconds, command, python),
                pass_fds=(slot_fd,),
            )
        except OSError as err:
            raise WrapperError(f"cannot start the wrapper {python}: {err.strerror or err}") from err
        forwarder.attach(process)
        logger.debug("[RUNNER] wrapper %s started for %s", process.pid, command[0])
        return wrapper.exit_status(process.wait())


def metered_run(
    waiter: Waiter,
    applicant: Applicant,
    limits: RunLimits = RunLimits(),
    python: str = sys.executable,
) -> int:
    """Waits for a slot, runs the applicant's command under it, and returns the run's exit status.

    75 when the wait reached the timeout, and the command did not run.
    """
    with _interrupt_ends_the_process():
        outcome = waiter.wait(applicant)
    if isinstance(outcome, GaveUp):
        return protocol.EXIT_TIMEOUT
    try:
        return run_in_wrapper(outcome.fd, applicant.command, limits, python)
    finally:
        os.close(outcome.fd)
