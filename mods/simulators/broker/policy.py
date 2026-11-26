"""The policy core: the whole admission check order, from values alone.

It has no I/O and reads no clock, so every rule is tested from inputs. The order is
`sim-lock.sh`'s, as its `admit()` runs it, and the decision is staged so that the CPU is sampled
only when it can matter:

1. every broker slot held: wait, and nothing else is looked at;
2. another run holding a slot, and the last start less than the settle time ago: wait;
3. a minimum idle above 0 and no sample given: ask for one (`Verdict.SAMPLE`);
4. with the sample given, admit or wait with the reason.

A caller that gets `Verdict.SAMPLE` takes the sample and calls `decide` again with it. Later
changes add their stages to this module, so a new admission rule is one edit here.

After an admit the caller takes the slot, and the take can still find none free, as check 5 of
LOCK-PROTOCOL.md section 3 says: `take_failed` is the decision then.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Sequence, Union

from broker import protocol


class Verdict(Enum):
    ADMIT = "admit"
    WAIT = "wait"
    SAMPLE = "sample"


@dataclass(frozen=True)
class Rules:
    """The settings the check order reads.

    `slots` is the broker's own count, c, which the take loop and checks 1 and 5 use. `window` is
    the number of slots the alone check and the holder listing look at: N, the script's MAX_RUNS,
    on a family the broker shares with the script, and `slots` otherwise. So `window >= slots`.
    """

    slots: int
    window: int
    settle_seconds: int
    min_idle_percent: int


@dataclass(frozen=True)
class Measured:
    """A reading of a percentage: the idle CPU, or the free memory."""

    value: int


@dataclass(frozen=True)
class Unmeasurable:
    """The tool ran and printed nothing the adapter could read as a whole number."""


@dataclass(frozen=True)
class TimedOut:
    """The tool did not finish within `seconds`, and was killed and reaped."""

    seconds: int


Sample = Union[Measured, Unmeasurable, TimedOut]


@dataclass(frozen=True)
class Decision:
    verdict: Verdict
    reason: str


def _wait(reason: str) -> Decision:
    return Decision(Verdict.WAIT, reason)


def _all_held(rules: Rules) -> Decision:
    return _wait(protocol.REASON_ALL_HELD.format(slots=rules.slots))


def _settled(last_start: Optional[int], now: int, settle_seconds: int) -> bool:
    """Whether the settle time has passed; a missing or non-numeric last start counts as settled."""
    return last_start is None or now - last_start >= settle_seconds


def _after_sample(rules: Rules, alone: bool, sample: Sample) -> Decision:
    if isinstance(sample, Measured):
        if sample.value < rules.min_idle_percent:
            return _wait(
                protocol.REASON_BUSY.format(idle=sample.value, min_idle=rules.min_idle_percent)
            )
    elif isinstance(sample, TimedOut):
        # Not the unmeasurable case below, lone run or not: the script has no timeout and would
        # still be waiting on `iostat`, which overruns only on a badly loaded Mac, so admitting a
        # lone run here would start it into the load the check is for.
        return _wait(protocol.REASON_SAMPLE_TIMED_OUT.format(seconds=sample.seconds))
    elif not alone:
        # The idle percentage cannot be measured: a lone run starts, one beside another waits.
        # LOCK-PROTOCOL.md section 3.2 states the rule and how pango decided it.
        return _wait(protocol.REASON_UNMEASURABLE)
    return Decision(Verdict.ADMIT, protocol.REASON_ADMITTED)


def decide(
    rules: Rules,
    held: Sequence[bool],
    last_start: Optional[int],
    now: int,
    sample: Optional[Sample] = None,
) -> Decision:
    """The admission decision for one attempt.

    `held` has one entry per slot of the window, true where that slot's flock is held;
    `last_start` is the epoch second in the family's last-start file, or None when it is missing
    or not all digits; `now` is the epoch second; `sample` is the CPU reading, given only after
    this function has asked for it.
    """
    if len(held) != rules.window:
        raise ValueError(f"held has {len(held)} entries for a window of {rules.window}")
    if all(held[: rules.slots]):
        return _all_held(rules)
    alone = not any(held)
    if not alone and not _settled(last_start, now, rules.settle_seconds):
        return _wait(protocol.REASON_SETTLING.format(settle=rules.settle_seconds))
    if rules.min_idle_percent == 0:
        return Decision(Verdict.ADMIT, protocol.REASON_ADMITTED)
    if sample is None:
        return Decision(Verdict.SAMPLE, "")
    return _after_sample(rules, alone, sample)


def take_failed(rules: Rules) -> Decision:
    """The decision when the checks passed and the take then found no free broker slot.

    It is a wait with check 1's reason: every one of the broker's slots is held, as the count `c`
    of the rules says, whatever the window holds.
    """
    return _all_held(rules)
