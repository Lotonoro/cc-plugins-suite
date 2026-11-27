"""The status verb: the last admission decision, read under the gate and printed as recorded.

It is the state root's smallest reading: where the root and its family are, and the one record the
waiter that decided last wrote. Later changes add the tickets, the holders and the queue to it.
"""

from __future__ import annotations

from typing import Optional, TextIO

from broker.clock import local_stamp
from broker.decisions import LastDecision
from broker.stateroot import Root


def status(root: Root, out: TextIO) -> None:
    """Prints the root, its family and the last decision. Reads the record under the gate."""
    with root.family().gate():
        record = root.decisions().read()
    print(f"state root: {root.path}", file=out)
    print(f"family: {root.config.family}", file=out)
    print(_describe(record), file=out)


def _describe(record: Optional[LastDecision]) -> str:
    if record is None:
        return "last decision: none recorded yet"
    where = f" to slot {record.slot}" if record.slot is not None else ""
    return f"last decision: {record.decision} at {local_stamp(record.at)}{where}: {record.reason}"
