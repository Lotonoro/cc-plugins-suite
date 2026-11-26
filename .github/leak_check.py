"""Refuses machine-specific paths in the files it is given.

    python3 leak_check.py PATH [PATH ...]

Each line of a PATH that holds a machine-specific path is printed as `PATH:LINE:TEXT`: PATH as it
was given, LINE counted from 1, TEXT the line without its line end and with a CR inside it written
`%0D`, so that a match is one line of output. A path is machine-specific when it belongs to one
account of one machine: `/Users/`, `~/temp` and `$HOME/temp`, where `temp` is the whole name, so
that `~/templates` is another. A standard location, the same on every Mac, such as `~/.claude/` or
`~/.android/`, passes.

Exit status:
    0  no line matched
    1  a line matched
    2  the check could not run to the end: no PATH, an unknown option, or a PATH that cannot be
       read. The matches in the PATHs that could be read are still printed.

Stdlib only, so that it runs on the Python 3.9 the CI gate runs on.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

# `temp` must be the whole name. More name after it (a letter, digit, `_` or `-`, or a `.` and one
# of those) makes another name: `~/templates`, `~/temp-files`, `~/temp.d`. A `/`, a line end or any
# other mark ends the path: `~/temp`, `~/temp/x`, `` `~/temp` ``, `see ~/temp.`.
MACHINE_SPECIFIC = re.compile(r"/Users/|(?:~|\$HOME)/temp(?![\w-]|\.[\w-])")

EXIT_CLEAN = 0
EXIT_MATCHED = 1
EXIT_FAILED = 2


def matching_lines(path: str) -> List[Tuple[int, str]]:
    """The numbered lines of a file that hold a machine-specific path; raises OSError if unread."""
    text = Path(path).read_bytes().decode("utf-8", errors="replace")
    found: List[Tuple[int, str]] = []
    for number, line in enumerate(text.split("\n"), start=1):
        line = line.removesuffix("\r")
        if MACHINE_SPECIFIC.search(line):
            # A CR ends a line in the CI log as a LF does, and the text holds no LF: it was split.
            found.append((number, line.replace("\r", "%0D")))
    return found


def parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="leak_check.py",
        description="Print each line of the given files that holds a machine-specific path.",
        epilog="Exit status: 0 no line matched, 1 a line matched, 2 the check could not finish.",
    )
    parser.add_argument("paths", nargs="+", metavar="PATH", help="a file to check")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = parse_args(argv)
    matched = False
    unread = False
    for path in args.paths:
        try:
            lines = matching_lines(path)
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
