"""The wrapper: the process that starts the command, watches it and stops it at the run limit.

It is `sim-lock.sh`'s wrapper (LOCK-PROTOCOL.md sections 5.2 to 5.5), ported. The client starts it
with the slot's flock inherited, so the slot stays held until the wrapper is gone, which is when
the command's group leader has exited, whether or not the client is still there. It starts the
command with `start_new_session=True`: the command leads its own process group and session, and
its descriptors are closed but the three it is given, so a daemon it leaves running holds no slot.

The wrapper watches the group leader exit by kqueue without reaping it, so the group's id, which
is the leader's pid, cannot be reused before the KILL that follows. It forwards INT, TERM and HUP
to the command's group, and a signal that lands before the command exists is held and sent as soon
as it does. At the run limit it prints a line, sends TERM, gives the leader the grace period to
exit, sends KILL to the group whether or not the leader has exited, reaps the leader and exits 124.

It runs as `python -I -c BOOT`, which is `argv` below: isolated, so the directory it runs in cannot
shadow a standard module, with the package's directory put on the path by hand. This module is the
only part of the broker the wrapper process imports besides the published constants.
"""

from __future__ import annotations

import os
import select
import signal
import subprocess
import sys
from typing import List, Optional, Sequence

from broker import protocol

# What `python -I -c` runs: the package's directory, which the client puts first in the arguments,
# goes on the path, and no bytecode is written beside the sources.
BOOT = (
    "import sys; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv.pop(1)); "
    "from broker.wrapper import main; main(sys.argv[1:])"
)
PACKAGE_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


def argv(
    run_limit_seconds: int,
    kill_grace_seconds: int,
    command: Sequence[str],
    python: str = sys.executable,
) -> List[str]:
    """The command line that starts the wrapper for `command`; a limit of 0 sets no limit."""
    return [
        python,
        "-I",
        "-c",
        BOOT,
        PACKAGE_PARENT,
        str(run_limit_seconds),
        str(kill_grace_seconds),
        *command,
    ]


def exit_status(returncode: int) -> int:
    """The shell's status for a process's return code: 128 plus N when signal N killed it."""
    return returncode if returncode >= 0 else 128 - returncode


def say(line: str) -> None:
    """Writes a line to descriptor 2, and says nothing when it cannot be written.

    A stderr that has no reader or is closed must not stop the kill or the status that follow the
    line. `print` is no use here: the line it fails to write stays in `sys.stderr`'s buffer, and the
    interpreter's flush of that buffer at exit fails again and makes the status 120.
    """
    try:
        os.write(2, os.fsencode(f"{line}\n"))  # fsencode: the command's name came from argv's bytes
    except OSError:
        pass


class Run:
    """One command under the wrapper: starts it, stops it at the limit, and says how it ended."""

    def __init__(self, limit_seconds: int, grace_seconds: int, command: Sequence[str]) -> None:
        self.limit_seconds = limit_seconds
        self.grace_seconds = grace_seconds
        self.command = list(command)
        self.proc: Optional["subprocess.Popen[bytes]"] = None
        self.pending: List[int] = []

    def forward(self, signum: int, frame: object) -> None:
        """Passes a signal to the command's group, or holds it until the command exists."""
        if self.proc is None:
            self.pending.append(signum)
        else:
            self._kill_group(signum)

    def _kill_group(self, signum: int) -> None:
        assert self.proc is not None
        try:
            os.killpg(self.proc.pid, signum)
        except (ProcessLookupError, PermissionError):
            # The group is gone, or on macOS holds only the unreaped leader, which refuses with EPERM.
            pass

    def _leader_exited(self, timeout: Optional[float]) -> bool:
        """Waits for the leader to exit without reaping it, so its pid cannot be reused before we do.

        `Popen.wait` would reap it and leave a window for a stray KILL to hit a stranger's group.
        """
        assert self.proc is not None
        event = select.kevent(
            self.proc.pid,
            select.KQ_FILTER_PROC,
            select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
            select.KQ_NOTE_EXIT,
        )
        queue = select.kqueue()
        try:
            return bool(queue.control([event], 1, timeout))
        finally:
            queue.close()

    def run(self) -> int:
        """Runs the command to its end and returns the status the wrapper exits with."""
        # The handlers go in before the command starts, and a signal that lands before it exists
        # waits in `pending`, so no signal in the window around Popen leaves the command running.
        for sig in SIGNALS:
            signal.signal(sig, self.forward)
        try:
            # close_fds, on by default, closes the inherited slot descriptor in the command.
            self.proc = subprocess.Popen(self.command, start_new_session=True)
        except OSError as err:
            say(protocol.LINE_CANNOT_START.format(command=self.command[0], reason=err.strerror))
            if isinstance(err, FileNotFoundError):
                return protocol.EXIT_NOT_FOUND
            return protocol.EXIT_CANNOT_EXECUTE
        while self.pending:
            self._kill_group(self.pending.pop(0))
        if not self._leader_exited(self.limit_seconds or None):
            say(protocol.LINE_RUN_LIMIT.format(limit=self.limit_seconds))
            self._kill_group(signal.SIGTERM)
            self._leader_exited(self.grace_seconds)
            self._kill_group(signal.SIGKILL)
            self.proc.wait()
            return protocol.EXIT_RUN_LIMIT
        return exit_status(self.proc.wait())


def main(arguments: Sequence[str]) -> None:
    """Runs the command in `arguments`: the limit, the grace period, then the command's words."""
    limit_seconds, grace_seconds = int(arguments[0]), int(arguments[1])
    code = Run(limit_seconds, grace_seconds, arguments[2:]).run()
    # The command is gone, so a signal still on its way has nothing left to stop. Ignoring it keeps
    # it from killing this process during interpreter shutdown, which would replace the command's
    # status with 128+N.
    for sig in SIGNALS:
        signal.signal(sig, signal.SIG_IGN)
    sys.exit(code)
