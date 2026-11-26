"""The waiter: attempts until admitted, and says what it is waiting for as the script does.

LOCK-PROTOCOL.md section 5.1 is the contract. The waiter makes its first attempt at once and
sleeps the poll time after each failed one. A run admitted at its first attempt prints nothing.
After the first failed attempt it prints the waiting line and lists the holders, once. After a
later failed attempt it prints a repeat when `waited` has reached the repeat mark, and gives up
when `waited` has reached the timeout. `waited` is read after each failed attempt, in whole
seconds since the first attempt began, so the time an attempt takes counts: a second of `iostat`,
or a wait for the gate.

The waiter holds neither the gate nor a slot while it sleeps, so a script waiter can take any
free slot, and its own process is the one that takes when its check passes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional, TextIO, Union

from broker import protocol
from broker.clock import Clock
from broker.leaf import Admitted, Applicant, TakeTimeLeaf

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Timing:
    """The seconds a wait runs by. They are constants, not settings: the script's own."""

    poll_seconds: int = protocol.POLL_SECONDS
    timeout_seconds: int = protocol.TIMEOUT_SECONDS
    status_seconds: int = protocol.STATUS_SECONDS  # 0 for no repeats


@dataclass(frozen=True)
class GaveUp:
    """The wait reached the timeout: the seconds waited at the last reading, and the last reason."""

    waited: int
    reason: str


class Waiter:
    """Waits for admission through the take-time leaf, writing what it says to `err`.

    `notice`, when given, is one line printed once before the first waiting line: how a root with
    no configuration says so.
    """

    def __init__(
        self,
        leaf: TakeTimeLeaf,
        clock: Clock,
        err: TextIO,
        timing: Timing = Timing(),
        notice: Optional[str] = None,
    ) -> None:
        self.leaf = leaf
        self.clock = clock
        self.err = err
        self.timing = timing
        self.notice = notice

    def wait(self, applicant: Applicant) -> Union[Admitted, GaveUp]:
        started = self.clock.now()
        repeat_at = self.timing.status_seconds
        first_failure = True
        while True:
            attempt = self.leaf.attempt(applicant)
            if isinstance(attempt, Admitted):
                return attempt
            waited = self.clock.now() - started
            if first_failure:
                self._say_first(attempt.reason)
                first_failure = False
            elif self.timing.status_seconds > 0 and waited >= repeat_at:
                self._say(protocol.LINE_STILL_WAITING.format(waited=waited, reason=attempt.reason))
                repeat_at = waited + self.timing.status_seconds
            if waited >= self.timing.timeout_seconds:
                self._say(protocol.LINE_GAVE_UP.format(waited=waited, reason=attempt.reason))
                return GaveUp(waited, attempt.reason)
            self.clock.sleep(self.timing.poll_seconds)

    def _say_first(self, reason: str) -> None:
        if self.notice is not None:
            self._say(self.notice)
        self._say(protocol.LINE_WAITING.format(reason=reason))
        for holder in self.leaf.family.list_holders():
            self._say(holder)

    def _say(self, line: str) -> None:
        self.err.write(line + "\n")
        self.err.flush()
