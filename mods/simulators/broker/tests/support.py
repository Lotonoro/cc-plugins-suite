"""What the broker's test modules share: scratch directories, fakes and process helpers.

Every scratch directory is made under `/tmp` and removed when its test ends, so a lock family
a test builds is its own and never the default `/tmp/pango-sim-test.flock`.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest


def scratch_dir(case: unittest.TestCase) -> str:
    """A new directory under /tmp, removed when the test ends; returns its path."""
    path = tempfile.mkdtemp(prefix="broker-test-", dir="/tmp")
    case.addCleanup(shutil.rmtree, path, ignore_errors=True)
    return os.path.realpath(path)
