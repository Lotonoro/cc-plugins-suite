"""The take-time leaf: one admission attempt, which is the I/O around the policy core.

Under the gate it reads the family's records and calls the core. When the core asks for a sample
it takes one, inside the gate, and calls the core again. On an admit it takes the lowest free
broker slot and writes the records; whatever the outcome it writes the last decision. It decides
nothing itself, so a new admission rule is an edit to the core alone.

The slot is taken in the process that waited, and the descriptor that holds its flock goes to the
caller. A take that finds no slot, though the checks passed, is a wait like any other (check 5 of
LOCK-PROTOCOL.md section 3): the process that failed is the one that keeps waiting.

The records are written in this order, all inside the one hold of the gate: the decision, then the
family's `.last-start`, then the slot's owner record, which is the order LOCK-PROTOCOL.md section 2.3
gives for the two the script reads. A failure after the take closes the descriptor first, so a
broken record never leaves a slot held by a run that will not start.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Sequence, Union

from broker import protocol
from broker.clock import Clock, local_stamp
from broker.decisions import DecisionStore, LastDecision
from broker.family import Family
from broker.machine import MachineAdapter
from broker.policy import Decision, Rules, Verdict, decide

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Applicant:
    """The run asking for a slot, as the owner record names it."""

    pid: int
    cwd: str
    command: Sequence[str]


@dataclass(frozen=True)
class Admitted:
    """The slot taken, and the descriptor holding its flock: the caller closes it or hands it on."""

    slot: int
    fd: int


@dataclass(frozen=True)
class Waiting:
    """The reason the run waits, which the waiter prints."""

    reason: str


Attempt = Union[Admitted, Waiting]


def owner_record(applicant: Applicant, slot: int, at: int) -> str:
    """The one-line owner record, with nothing quoted or escaped, as the script writes it."""
    return protocol.OWNER_RECORD.format(
        pid=applicant.pid,
        slot=slot,
        cwd=applicant.cwd,
        started=local_stamp(at),
        command=" ".join(applicant.command),
    )


class TakeTimeLeaf:
    def __init__(
        self,
        family: Family,
        rules: Rules,
        machine: MachineAdapter,
        clock: Clock,
        decisions: DecisionStore,
    ) -> None:
        if family.slots != rules.slots:
            raise ValueError(f"the family has {family.slots} slots and the rules {rules.slots}")
        if family.window != rules.window:
            raise ValueError(f"the family has a window of {family.window} and the rules {rules.window}")
        self.family = family
        self.rules = rules
        self.machine = machine
        self.clock = clock
        self.decisions = decisions

    def attempt(self, applicant: Applicant) -> Attempt:
        """Makes one attempt to be admitted, blocking only on the gate."""
        with self.family.gate():
            decision = self._decide()
            if decision.verdict is Verdict.ADMIT:
                return self._admit(applicant, decision.reason)
            return self._wait(decision.reason)

    def _decide(self) -> Decision:
        held = self.family.probe_all()
        last_start = self.family.read_last_start()
        now = self.clock.now()
        decision = decide(self.rules, held, last_start, now)
        if decision.verdict is Verdict.SAMPLE:
            decision = decide(self.rules, held, last_start, now, self.machine.cpu_idle())
        return decision

    def _admit(self, applicant: Applicant, reason: str) -> Attempt:
        taken = self.family.take_lowest_free()
        if taken is None:
            logger.debug("[LEAF] the checks passed and no broker slot could be locked")
            return self._wait(protocol.REASON_ALL_HELD.format(slots=self.rules.slots))
        slot, fd = taken
        try:
            at = self.clock.now()
            self.decisions.write(LastDecision(protocol.DECISION_ADMIT, reason, slot, at))
            self.family.write_last_start(at)
            self.family.write_owner(slot, owner_record(applicant, slot, at))
        except BaseException:
            os.close(fd)
            raise
        logger.debug("[LEAF] admitted to slot %s", slot)
        return Admitted(slot, fd)

    def _wait(self, reason: str) -> Waiting:
        self.decisions.write(LastDecision(protocol.DECISION_WAIT, reason, None, self.clock.now()))
        logger.debug("[LEAF] waiting: %s", reason)
        return Waiting(reason)
