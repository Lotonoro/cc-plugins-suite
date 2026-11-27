"""The clock: the epoch second the admission rule reads, and the sleep between a waiter's attempts.

The take-time leaf and the waiter are given a `Clock`, so a test moves time by hand and a run of
minutes takes no time. `SystemClock` is the real one. The epoch second is a whole number, as
`date +%s` prints it, which is what the last-start file holds.
"""

from __future__ import annotations

import time
from typing import Protocol

from broker import protocol


class Clock(Protocol):
    def now(self) -> int: ...

    def sleep(self, seconds: float) -> None: ...


class SystemClock:
    def now(self) -> int:
        return int(time.time())

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)


def local_stamp(epoch: int) -> str:
    """The local time of an epoch second to the second, with no zone: the owner record's `started`."""
    return time.strftime(protocol.OWNER_TIME_FORMAT, time.localtime(epoch))
