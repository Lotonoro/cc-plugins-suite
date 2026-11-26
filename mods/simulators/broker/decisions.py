"""The last admission decision: one record in the state directory.

The waiter that makes a decision writes it, under the gate, and the other waiters and the status
verb read it under the gate, so every reader sees one decision and none a half-written one. It is
written under a temporary name and renamed into place, so a crash cannot leave a torn record.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

from broker import protocol
from broker.errors import StateError


@dataclass(frozen=True)
class LastDecision:
    decision: str  # protocol.DECISION_ADMIT or protocol.DECISION_WAIT
    reason: str
    slot: Optional[int]  # the slot taken, when the decision admitted a run
    at: int  # the epoch second of the decision


class DecisionStore:
    def __init__(self, state_dir: str) -> None:
        self.state_dir = state_dir

    @property
    def path(self) -> str:
        return os.path.join(self.state_dir, protocol.LAST_DECISION_FILE)

    def write(self, record: LastDecision) -> None:
        """Replaces the record whole. The caller holds the gate."""
        text = (
            json.dumps(
                {
                    protocol.RECORD_DECISION: record.decision,
                    protocol.RECORD_REASON: record.reason,
                    protocol.RECORD_SLOT: record.slot,
                    protocol.RECORD_AT: record.at,
                }
            )
            + "\n"
        )
        temporary = os.path.join(self.state_dir, f".{protocol.LAST_DECISION_FILE}.{os.getpid()}.tmp")
        try:
            os.makedirs(self.state_dir, exist_ok=True)
            with open(temporary, "w", encoding="utf-8") as handle:
                handle.write(text)
            os.replace(temporary, self.path)
        except OSError as err:
            self._discard(temporary)
            raise StateError(f"cannot write {self.path}: {err.strerror or err}") from err

    def read(self) -> Optional[LastDecision]:
        """The record, or None when none was written yet. The caller holds the gate."""
        try:
            with open(self.path, "rb") as handle:
                raw = handle.read()
        except FileNotFoundError:
            return None
        except OSError as err:
            raise StateError(f"cannot read {self.path}: {err.strerror or err}") from err
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError as err:  # UnicodeDecodeError and json.JSONDecodeError are both ValueErrors
            raise StateError(f"{self.path} is not JSON: {err}") from err
        return self._record(data)

    def _record(self, data: object) -> LastDecision:
        if not isinstance(data, dict) or set(data) != set(protocol.RECORD_KEYS):
            raise StateError(f"{self.path} is not a last-decision record")
        decision = data[protocol.RECORD_DECISION]
        reason = data[protocol.RECORD_REASON]
        slot = data[protocol.RECORD_SLOT]
        at = data[protocol.RECORD_AT]
        well_formed = (
            decision in (protocol.DECISION_ADMIT, protocol.DECISION_WAIT)
            and isinstance(reason, str)
            and (slot is None or (type(slot) is int and slot >= 0))
            and type(at) is int
        )
        if not well_formed:
            raise StateError(f"{self.path} is not a last-decision record")
        return LastDecision(decision, reason, slot, at)

    @staticmethod
    def _discard(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            # Best effort, on a path that is already failing: the write's own error is the one
            # that is raised, and a stray temporary name is harmless and replaced by the next write.
            pass
