"""The CI gate: what every pull request to main must pass.

    python3 .github/gate.py

Run it from anywhere inside the repository, with no argument. It runs every step below even
when an earlier one fails, so one run names every failure, and it exits 1 when any step failed.

1. `claude plugin validate .`, on the marketplace.
2. For every mod `.claude-plugin/marketplace.json` lists, found by its `source` directory:
   `claude plugin validate <mod>`, and `claude plugin test <mod>` when the mod has a `hooks/`
   directory.
3. For every directory under `mods/`, listed or not, and for every listed mod: the mod's own
   check, when it has one. A mod's pull request thus runs its suite before the pull request that
   lists it, and a new mod or a new suite edits nothing here.
4. The leak check, `leak_check.py` beside this file, over every tracked file under a mod's
   directory (`mods/<name>/...`, as `git ls-files` lists them, since a mod's directory is what an
   install copies) and over `README.md` and `.claude-plugin/marketplace.json`, which the
   marketplace's page shows.

A mod declares its check as an executable file named `check` at the mod's root. The gate runs it
from the mod's directory, and its exit status is the step's: 0 passes. A `check` that is not
executable fails the step. A check that must run on Python 3.9 starts `python3`, which the
workflow puts first on PATH; `/usr/bin/python3` is the runner image's own Python.

No step has a timeout of its own. The workflow's `timeout-minutes` bounds the run, and the last
`::group::` line of the log names the step that was running.

Exit status: 0 every step passed, 1 a step failed, 2 the gate could not start (an argument, or
no git repository around the current directory).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Set, Tuple

LEAK_CHECK = Path(__file__).resolve().with_name("leak_check.py")
MARKETPLACE = ".claude-plugin/marketplace.json"
README = "README.md"

EXIT_PASSED = 0
EXIT_FAILED = 1
EXIT_UNSTARTED = 2

Problem = Tuple[str, str]  # a step that cannot be run: its label, and why


class StartError(Exception):
    """The gate cannot start: git is missing, or the current directory is not in a repository."""


@dataclass(frozen=True)
class Step:
    label: str
    argv: Tuple[str, ...]
    cwd: Path
    command: str = ""  # what the log shows as the command; the arguments joined when empty

    def shown(self) -> str:
        return self.command or shlex.join(self.argv)


def say(text: str) -> None:
    print(text, flush=True)


def git(root: Optional[Path], *args: str) -> bytes:
    """What a git command prints; raises StartError when git cannot run it or it fails."""
    try:
        done = subprocess.run(["git", *args], cwd=root, capture_output=True)
    except OSError as err:
        raise StartError(f"cannot run git: {err.strerror or err}") from err
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", errors="replace").strip()
        raise StartError(f"git {args[0]} failed: {detail}")
    return done.stdout


def repository_root() -> Path:
    return Path(os.fsdecode(git(None, "rev-parse", "--show-toplevel")).strip())


def tracked_files(root: Path) -> List[str]:
    names = os.fsdecode(git(root, "ls-files", "-z")).split("\0")
    return [name for name in names if name]


def files_to_leak_check(tracked: Iterable[str]) -> List[str]:
    """The tracked files the leak check covers: under a mod's directory, README and marketplace."""
    return [
        path
        for path in tracked
        if path in (README, MARKETPLACE) or (path.startswith("mods/") and path.count("/") >= 2)
    ]


def local_directory(root: Path, source: object) -> Optional[str]:
    """A marketplace entry's source as a path relative to the root, if it is a directory there."""
    if not isinstance(source, str):
        return None
    relative = os.path.normpath(source)
    return relative if (root / relative).is_dir() else None


def listed_mods(root: Path) -> Tuple[List[str], List[Problem]]:
    """The directories the marketplace lists, and what is wrong with its listing."""
    try:
        data = json.loads((root / MARKETPLACE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        return [], [("marketplace", f"cannot read {MARKETPLACE}: {err}")]
    plugins = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        return [], [("marketplace", f"{MARKETPLACE} has no list of plugins")]
    mods: List[str] = []
    problems: List[Problem] = []
    for entry in plugins:
        name = entry.get("name") if isinstance(entry, dict) else None
        source = entry.get("source") if isinstance(entry, dict) else None
        directory = local_directory(root, source)
        if directory is None:
            problem = f"{name}: source {source} is not a directory of this repository"
            problems.append(("marketplace", problem))
        elif directory not in mods:
            mods.append(directory)
    return mods, problems


def mod_directories(root: Path) -> List[str]:
    mods = root / "mods"
    if not mods.is_dir():
        return []
    return [f"mods/{entry.name}" for entry in mods.iterdir() if entry.is_dir()]


def claude_step(root: Path, subject: str, verb: str, target: str) -> Step:
    label = f"{subject}: claude plugin {verb} {target}"
    return Step(label, ("claude", "plugin", verb, target), root)


def plan(root: Path, tracked: Sequence[str]) -> Tuple[List[Step], List[Problem]]:
    listed, problems = listed_mods(root)
    listed_set: Set[str] = set(listed)
    steps = [claude_step(root, "marketplace", "validate", ".")]
    for mod in sorted(listed_set | set(mod_directories(root))):
        if mod in listed_set:
            steps.append(claude_step(root, mod, "validate", mod))
            if (root / mod / "hooks").is_dir():
                steps.append(claude_step(root, mod, "test", mod))
        check = root / mod / "check"
        if not check.is_file():
            continue
        if os.access(check, os.X_OK):
            steps.append(Step(f"{mod}: check", ("./check",), root / mod))
        else:
            problems.append((f"{mod}: check", "not executable"))
    files = files_to_leak_check(tracked)
    command = f"python3 {LEAK_CHECK.name} -- {len(files)} files"
    steps.append(Step("leak check", (sys.executable, str(LEAK_CHECK), "--", *files), root, command))
    return steps, problems


def run_step(step: Step) -> Optional[str]:
    """Runs a step with its output going straight to the log; returns why it failed, if it did."""
    say(f"::group::{step.label}")
    say(f"$ {step.shown()}")
    try:
        done = subprocess.run(step.argv, cwd=step.cwd, stdin=subprocess.DEVNULL)
    except OSError as err:
        reason: Optional[str] = f"cannot run {step.argv[0]}: {err.strerror or err}"
    else:
        reason = None if done.returncode == 0 else f"exit status {done.returncode}"
    say("::endgroup::")
    return reason


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gate.py",
        description="Run the CI gate on the repository the current directory is in.",
        epilog="Exit status: 0 every step passed, 1 a step failed, 2 the gate could not start.",
    )
    parser.parse_args(argv)
    try:
        root = repository_root()
        tracked = tracked_files(root)
    except StartError as err:
        print(f"gate: {err}", file=sys.stderr)
        return EXIT_UNSTARTED
    steps, problems = plan(root, tracked)
    failures: List[str] = []
    for label, why in problems:
        failures.append(f"{label}: {why}")
        say(f"::error::{label}: {why}")
    for step in steps:
        reason = run_step(step)
        if reason is not None:
            failures.append(f"{step.label}: {reason}")
            say(f"::error::{step.label}: {reason}")
    total = len(steps) + len(problems)
    if not failures:
        say(f"gate: all {total} steps passed")
        return EXIT_PASSED
    say(f"gate: {len(failures)} of {total} steps failed")
    for failure in failures:
        say(f"FAILED {failure}")
    return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
