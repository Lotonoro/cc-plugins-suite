"""The lock family: the files a run takes its slot in, and the flocks and records on them.

LOCK-PROTOCOL.md sections 2 and 5.1 are the contract, and `sim-lock.sh` shares these files, so
nothing here may differ from what that file says. Every lock is an exclusive `flock(2)`. A probe
and a take do not block and fail at once when another process holds the lock; the gate blocks,
with no timeout. The kernel drops a flock when the last descriptor on that open file closes, so a
holder that dies leaves no stale state.

A caller holds the gate (`gate()`) around `probe`, `probe_all`, `take_lowest_free` and the record
writes: a probe briefly holds a free slot's flock, which must not happen while another waiter
decides. Opening the gate twice in one process deadlocks, since flock conflicts between two open
files of one process too, so these methods never open it themselves; `list_holders` does, being
a whole operation of its own.

`in_default_family` is the one function here that concerns no family of its own: it says whether a
path belongs to the family of the script's default lock, which a root of the broker may use only
shared, at the script's slot count (LOCK-PROTOCOL.md section 4).
"""

from __future__ import annotations

import fcntl
import logging
import os
import re
from contextlib import contextmanager
from typing import Iterator, List, Optional, Tuple

from broker import protocol
from broker.errors import FamilyError

logger = logging.getLogger(__name__)

_DIGITS = re.compile(r"[0-9]+")
# Opened for appending: a missing file is created and none is truncated. The mode is what a
# shell's `>>` creates a file with, before the umask.
_OPEN_FLAGS = os.O_WRONLY | os.O_APPEND | os.O_CREAT
_OPEN_MODE = 0o666


def _open(path: str) -> int:
    try:
        return os.open(path, _OPEN_FLAGS, _OPEN_MODE)
    except OSError as err:
        raise FamilyError(f"cannot open {path}: {err.strerror or err}") from err


def _try_lock(fd: int, path: str) -> bool:
    """Takes the flock without blocking; False when another process holds it."""
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return False
    except OSError as err:
        raise FamilyError(f"cannot lock {path}: {err.strerror or err}") from err
    return True


def _is_the_file(path: str, other: str) -> bool:
    """Whether the two paths lead to one file, as the shell's `-ef` has it: false when either is absent."""
    try:
        return os.path.samestat(os.stat(path), os.stat(other))
    except OSError:
        return False


def _directory_and_name(path: str) -> Tuple[str, str]:
    """The directory and the name of `path` as dirname(1) and basename(1) give them.

    A trailing slash does not count, so `/a/b/` is the name `b` in `/a`, and a name with no
    directory is in `.`.
    """
    trimmed = path.rstrip("/") or path[:1]
    return os.path.dirname(trimmed) or ".", os.path.basename(trimmed)


def in_default_family(path: str, default: str) -> bool:
    """Whether `path` is the lock `default` or one of its family's files, as `sim-lock.sh` has it.

    This is the script's `in_default_family` (LOCK-PROTOCOL.md section 4), misses included. It
    finds the default lock and any file of its family (`.1`, `.gate`, ...) by the name's prefix,
    under any spelling of the directory (`/private/tmp`, a doubled slash, a symlinked directory),
    whether or not the file exists, and a symlink to the default lock itself. It does not find a
    different letter case, or a symlink to a family file other than the default lock.
    """
    if _is_the_file(path, default):
        return True
    directory, name = _directory_and_name(path)
    if not (os.path.isdir(directory) and os.access(directory, os.X_OK)):
        return False  # the script's `cd` into it fails
    default_directory, default_name = _directory_and_name(default)
    physical = os.path.realpath(directory)
    default_physical = os.path.realpath(default_directory)
    return f"{physical}/{name}".startswith(f"{default_physical}/{default_name}")


class Family:
    """One lock family: `lock_path` is slot 0, and the other files sit beside it.

    `slots` is the broker's own count, c, which the take loop covers. `window` is how many slots
    the probe and the holder listing cover: N, the script's MAX_RUNS, on a family shared with the
    script. A take beyond the window would be invisible to a script run, so `slots <= window`.
    """

    def __init__(
        self, lock_path: str, slots: int, window: int, creates_directory: bool = False
    ) -> None:
        if not 1 <= slots <= window:
            raise ValueError(f"slots must be from 1 to the window {window}, not {slots}")
        self.lock_path = lock_path
        self.slots = slots
        self.window = window
        self._creates_directory = creates_directory

    @property
    def gate_path(self) -> str:
        return self.lock_path + ".gate"

    @property
    def last_start_path(self) -> str:
        return self.lock_path + ".last-start"

    def slot_path(self, slot: int) -> str:
        return self.lock_path if slot == 0 else f"{self.lock_path}.{slot}"

    def owner_path(self, slot: int) -> str:
        return self.slot_path(slot) + ".owner"

    @contextmanager
    def gate(self) -> Iterator[None]:
        """Holds the gate's flock for the body, taken blocking with no timeout."""
        if self._creates_directory:
            directory = os.path.dirname(self.lock_path)
            try:
                os.makedirs(directory, exist_ok=True)
            except OSError as err:
                raise FamilyError(f"cannot create {directory}: {err.strerror or err}") from err
        fd = _open(self.gate_path)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
            except OSError as err:
                raise FamilyError(f"cannot lock {self.gate_path}: {err.strerror or err}") from err
            yield
        finally:
            os.close(fd)

    def probe(self, slot: int) -> bool:
        """Whether another process holds the slot; never keeps it. The caller holds the gate."""
        path = self.slot_path(slot)
        fd = _open(path)
        try:
            return not _try_lock(fd, path)
        finally:
            os.close(fd)  # releases the flock a successful probe took

    def probe_all(self) -> Tuple[bool, ...]:
        """Which slots of the window are held, in slot order. The caller holds the gate."""
        return tuple(self.probe(slot) for slot in range(self.window))

    def take_lowest_free(self) -> Optional[Tuple[int, int]]:
        """Takes the lowest-numbered broker slot it can lock; returns (slot, descriptor).

        The descriptor holds the flock and the caller closes it. None when every broker slot is
        held. The descriptor is not inheritable: whoever hands it on does so by name. The caller
        holds the gate.
        """
        for slot in range(self.slots):
            path = self.slot_path(slot)
            fd = _open(path)
            kept = False
            try:
                kept = _try_lock(fd, path)
            finally:
                if not kept:
                    os.close(fd)
            if kept:
                return slot, fd
        return None

    def read_last_start(self) -> Optional[int]:
        """The epoch second in the last-start file, or None when there is none to read.

        None is a missing file, one that cannot be read, or content that is not all digits once
        the trailing newlines are gone; each counts as settled (LOCK-PROTOCOL.md section 2.3),
        as the script's `cat ... || return 0` does.
        """
        try:
            with open(self.last_start_path, "rb") as handle:
                raw = handle.read()
        except OSError as err:
            logger.debug("[FAMILY] no last start in %s: %s", self.last_start_path, err)
            return None
        text = raw.decode("utf-8", errors="replace").rstrip("\n")
        return int(text) if _DIGITS.fullmatch(text) else None

    def write_last_start(self, epoch: int) -> None:
        """Writes the epoch second whole: plain digits and a newline. The caller holds the gate."""
        self._write(self.last_start_path, f"{epoch}\n", "last-start")

    def write_owner(self, slot: int, record: str) -> None:
        """Writes the slot's owner record whole, one line. The caller holds the gate."""
        self._write(self.owner_path(slot), record + "\n", "owner")

    def _write(self, path: str, text: str, what: str) -> None:
        try:
            with open(path, "w", encoding="utf-8", errors="surrogateescape") as handle:
                handle.write(text)
        except OSError as err:
            raise FamilyError(f"cannot write the {what} record {path}: {err.strerror or err}") from err

    def _read_owner(self, slot: int) -> Optional[str]:
        try:
            with open(self.owner_path(slot), "rb") as handle:
                return handle.read().decode("utf-8", errors="replace")
        except OSError as err:
            # The listing is for the reader; a record that is missing or unreadable is not listed.
            logger.debug("[FAMILY] no owner record for slot %s: %s", slot, err)
            return None

    def list_holders(self) -> List[str]:
        """The owner record of each run holding a slot now, each line indented two spaces.

        Takes the gate itself. A slot's record file stays after its run ends, so only a slot
        whose flock is held counts.
        """
        lines: List[str] = []
        with self.gate():
            for slot in range(self.window):
                if not self.probe(slot):
                    continue
                record = self._read_owner(slot)
                if record is not None:
                    lines.extend(protocol.HOLDER_INDENT + line for line in record.splitlines())
        return lines
