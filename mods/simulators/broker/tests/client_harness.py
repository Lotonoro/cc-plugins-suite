"""A stand-in client for the process tests: one metered run on a scratch family, on fast timing.

Run as `python -m broker.tests.client_harness PARAMS COMMAND...` from the mod's directory, where
PARAMS is a JSON object. It builds the same pieces the dispatcher will, a family, the take-time
leaf, the waiter and the runner, but takes its timing from PARAMS instead of the constants, since
a test cannot wait an hour for the timeout. The machine is the real adapter on a stand-in command
that prints a fixed idle percentage, so no `iostat` runs.

The keys of PARAMS: `lock` and `state` (paths), `slots`, `min_idle`, `poll`, `timeout`, `status`,
`run_limit` and `grace` (whole numbers).
"""

from __future__ import annotations

import json
import os
import sys

from broker.clock import SystemClock
from broker.decisions import DecisionStore
from broker.family import Family
from broker.leaf import Applicant, TakeTimeLeaf
from broker.machine import Machine
from broker.runner import RunLimits, metered_run
from broker.waiter import Timing, Waiter


def main() -> None:
    sys.dont_write_bytecode = True
    params = json.loads(sys.argv[1])
    command = sys.argv[2:]
    slots = params["slots"]
    family = Family(params["lock"], slots=slots, window=slots)
    machine = Machine(iostat=["/usr/bin/printf", "%s", " 1 2 90\n"])
    clock = SystemClock()
    leaf = TakeTimeLeaf(family, 90, params["min_idle"], machine, clock, DecisionStore(params["state"]))
    timing = Timing(params["poll"], params["timeout"], params["status"])
    waiter = Waiter(leaf, clock, sys.stderr, timing)
    limits = RunLimits(params["run_limit"], params["grace"])
    applicant = Applicant(pid=os.getpid(), cwd=os.getcwd(), command=command)
    sys.exit(metered_run(waiter, applicant, limits))


if __name__ == "__main__":
    main()
