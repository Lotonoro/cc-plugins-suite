"""What the test modules share: run a command as a child and read what it printed."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Sequence


@dataclass(frozen=True)
class Result:
    code: int
    out: str
    err: str


def run(argv: Sequence[str], cwd: Path, env: Optional[Dict[str, str]] = None) -> Result:
    done = subprocess.run(list(argv), cwd=cwd, env=env, capture_output=True)
    return Result(
        done.returncode,
        done.stdout.decode("utf-8", errors="replace"),
        done.stderr.decode("utf-8", errors="replace"),
    )
