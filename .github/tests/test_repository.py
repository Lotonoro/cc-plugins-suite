"""Tests for the repository's .gitignore: what it lets git track and what it keeps out.

A global ignore file that drops every dotfile, like the one on the maintainer's Mac, is
simulated with a scratch file, so the result does not depend on the machine running the tests.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict

REPO = Path(__file__).resolve().parents[2]


class GitignoreTest(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        global_ignore = Path(scratch.name) / "ignore"
        global_ignore.write_text(".*\n", encoding="utf-8")
        global_config = Path(scratch.name) / "gitconfig"
        global_config.write_text(f"[core]\n\texcludesFile = {global_ignore}\n", encoding="utf-8")
        self.env: Dict[str, str] = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": str(global_config),
            "GIT_CONFIG_NOSYSTEM": "1",
        }

    def ignored(self, path: str) -> bool:
        """Whether the repository's rules, under the simulated global ignore, drop this path."""
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "--quiet", "--", path],
            cwd=REPO,
            env=self.env,
            capture_output=True,
            text=True,
        )
        if result.returncode not in (0, 1):
            self.fail(f"git check-ignore {path} failed ({result.returncode}): {result.stderr}")
        return result.returncode == 0

    def git(self, cwd: Path, *args: str) -> str:
        done = subprocess.run(
            ["git", *args], cwd=cwd, env=self.env, capture_output=True, text=True
        )
        if done.returncode != 0:
            self.fail(f"git {' '.join(args)} failed ({done.returncode}): {done.stderr}")
        return done.stdout

    def test_global_dotfile_rule_drops_a_dot_directory_the_repository_does_not_name(self) -> None:
        self.assertTrue(self.ignored(".unlisted/file"))

    def test_ci_gate_is_tracked_under_a_global_dotfile_rule(self) -> None:
        for path in (
            ".github/workflows/gate.yml",
            ".github/gate.py",
            ".github/leak_check.py",
            ".github/tests/test_gate.py",
        ):
            with self.subTest(path=path):
                self.assertFalse(self.ignored(path))

    def test_only_the_root_github_directory_is_tracked(self) -> None:
        self.assertTrue(self.ignored("mods/auditor/.github/workflows/gate.yml"))
        self.assertTrue(self.ignored(".github-extra/file"))

    def test_manifests_and_gitignore_are_still_tracked(self) -> None:
        for path in (
            ".gitignore",
            ".claude-plugin/marketplace.json",
            "mods/auditor/.claude-plugin/plugin.json",
        ):
            with self.subTest(path=path):
                self.assertFalse(self.ignored(path))

    def test_python_bytecode_is_ignored_in_every_directory(self) -> None:
        for path in (
            "__pycache__/leak_check.cpython-39.pyc",
            ".github/__pycache__/gate.cpython-39.pyc",
            ".github/tests/__pycache__/test_gate.cpython-39.pyc",
            "mods/simulators/broker/__pycache__/client.cpython-39.pyc",
            "mods/simulators/broker/__pycache__/x.pyc",
        ):
            with self.subTest(path=path):
                self.assertTrue(self.ignored(path))

    def test_python_source_beside_bytecode_is_not_ignored(self) -> None:
        self.assertFalse(self.ignored("mods/simulators/broker/client.py"))

    def test_git_status_lists_no_bytecode_once_python_has_written_it(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        repo = Path(scratch.name)
        shutil.copy(REPO / ".gitignore", repo / ".gitignore")
        broker = repo / "mods" / "simulators" / "broker"
        broker.mkdir(parents=True)
        (broker / "client.py").write_text("VALUE = 1\n", encoding="utf-8")
        self.git(repo, "init", "--quiet")
        # The import writes bytecode beside the source, as Python on Linux does; the system Python
        # on a Mac sends it to a user cache unless told otherwise, and the test would show nothing.
        importing = (
            "import sys",
            "sys.pycache_prefix = None",
            "sys.dont_write_bytecode = False",
            "import client",
        )
        subprocess.run([sys.executable, "-c", "; ".join(importing)], cwd=broker, check=True)
        self.assertTrue((broker / "__pycache__").is_dir(), "the import wrote no bytecode")
        listed = self.git(repo, "status", "--porcelain", "--untracked-files=all")
        self.assertIn("mods/simulators/broker/client.py", listed)
        self.assertNotIn("__pycache__", listed)


if __name__ == "__main__":
    unittest.main()
