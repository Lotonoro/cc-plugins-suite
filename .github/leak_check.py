"""Refuses machine-specific paths in the files it is given.

    python3 leak_check.py [--scope FILE] PATH [PATH ...]

Each line of a PATH that holds a string of the scope is printed as `PATH:LINE:TEXT`: PATH as it
was given, LINE counted from 1, TEXT the line without its line end. The scope is a file of
literal strings, one per line, taken from `leak_check_scope.txt` beside this script, or from the
file --scope names in its place. Blank lines and lines starting with # are skipped, and each
string is trimmed.

Exit status:
    0  no line matched
    1  a line matched
    2  the check could not run to the end: no PATH, an unknown option, a scope that cannot be read
       or names no string, or a PATH that cannot be read. The matches in the PATHs that could be
       read are still printed.

Stdlib only, so that it runs on the Python 3.9 the CI gate runs on.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

DEFAULT_SCOPE = Path(__file__).resolve().with_name("leak_check_scope.txt")

EXIT_CLEAN = 0
EXIT_MATCHED = 1
EXIT_FAILED = 2


class ScopeError(Exception):
    """The scope cannot be used: it cannot be read, or it names no string."""


def read_scope(path: Path) -> List[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        raise ScopeError(f"cannot read the scope {path}: {err}") from err
    trimmed = [line.strip() for line in text.splitlines()]
    strings = [line for line in trimmed if line and not line.startswith("#")]
    if not strings:
        raise ScopeError(f"the scope {path} names no string")
    return strings


def matching_lines(path: str, scope: Sequence[str]) -> List[Tuple[int, str]]:
    """The numbered lines of a file that hold a string of the scope; raises OSError if unread."""
    text = Path(path).read_bytes().decode("utf-8", errors="replace")
    found: List[Tuple[int, str]] = []
    for number, line in enumerate(text.split("\n"), start=1):
        line = line.removesuffix("\r")
        if any(string in line for string in scope):
            found.append((number, line))
    return found


def parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="leak_check.py",
        description="Print each line of the given files that holds a machine-specific path.",
        epilog="Exit status: 0 no line matched, 1 a line matched, 2 the check could not finish.",
    )
    parser.add_argument(
        "--scope",
        type=Path,
        default=DEFAULT_SCOPE,
        metavar="FILE",
        help="the strings to refuse, one per line, in place of leak_check_scope.txt",
    )
    parser.add_argument("paths", nargs="+", metavar="PATH", help="a file to check")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    try:
        scope = read_scope(args.scope)
    except ScopeError as err:
        print(f"leak_check: {err}", file=sys.stderr)
        return EXIT_FAILED
    matched = False
    unread = False
    for path in args.paths:
        try:
            lines = matching_lines(path, scope)
        except OSError as err:
            print(f"leak_check: cannot read {path}: {err.strerror or err}", file=sys.stderr)
            unread = True
            continue
        for number, text in lines:
            print(f"{path}:{number}:{text}")
            matched = True
    if unread:
        return EXIT_FAILED
    return EXIT_MATCHED if matched else EXIT_CLEAN


if __name__ == "__main__":
    sys.exit(main())
