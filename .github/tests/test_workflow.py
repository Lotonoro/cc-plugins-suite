"""Tests for the workflow file: when it runs, what it pins, what it runs, and that it names no mod.

The standard library has no YAML parser, so the file is read as text, with its comment lines
dropped first so that a comment neither satisfies nor breaks a test.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import List

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "gate.yml"


def workflow_text() -> str:
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    return "\n".join(line for line in lines if not line.lstrip().startswith("#"))


def mod_names() -> List[str]:
    """Every name a mod has here: its directory under mods/ and its marketplace entry."""
    names = {entry.name for entry in (REPO / "mods").iterdir() if entry.is_dir()}
    marketplace = REPO / ".claude-plugin" / "marketplace.json"
    manifest = json.loads(marketplace.read_text(encoding="utf-8"))
    names.update(entry["name"] for entry in manifest["plugins"])
    return sorted(names)


class WorkflowTest(unittest.TestCase):
    def test_workflow_names_no_mod(self) -> None:
        text = workflow_text()
        self.assertNotIn("mods/", text)
        names = mod_names()
        self.assertGreaterEqual(len(names), 3, "the repository's mods were not found")
        for name in names:
            with self.subTest(name=name):
                pattern = rf"(?<![\w-]){re.escape(name)}(?![\w-])"
                self.assertIsNone(re.search(pattern, text))

    def test_workflow_runs_on_every_pull_request_to_main_and_on_nothing_else(self) -> None:
        text = workflow_text()
        self.assertRegex(text, r"(?m)^on:\n  pull_request:\n    branches: \[main\]\n")
        self.assertNotIn("pull_request_target", text)
        self.assertNotIn("push:", text)

    def test_workflow_uses_no_secret_and_only_reads_the_repository(self) -> None:
        text = workflow_text()
        self.assertNotIn("secrets.", text)
        self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n")
        self.assertIsNone(re.search(r":\s*write\b", text))

    def test_workflow_pins_the_runner_python_and_cli(self) -> None:
        text = workflow_text()
        self.assertRegex(text, r"(?m)^    runs-on: ubuntu-24\.04$")
        self.assertRegex(text, r'(?m)^          python-version: "3\.9"$')
        self.assertRegex(text, r'(?m)^  CLAUDE_CODE_VERSION: "\d+\.\d+\.\d+"$')
        self.assertRegex(text, r'(?m)^  DISABLE_UPDATES: "1"$')

    def test_workflow_runs_the_cli_postinstall_itself_whatever_npm_does_with_scripts(self) -> None:
        text = workflow_text()
        self.assertIn("--ignore-scripts", text)
        self.assertIn("claude-code/install.cjs", text)

    def test_workflow_pins_every_action_to_a_commit(self) -> None:
        uses = re.findall(r"(?m)^\s*-?\s*uses: (\S+)(?: +#.*)?$", workflow_text())
        self.assertTrue(uses, "the workflow uses no action")
        for reference in uses:
            with self.subTest(uses=reference):
                self.assertRegex(reference, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")

    def test_workflow_tests_the_gate_then_installs_the_cli_then_runs_the_gate(self) -> None:
        text = workflow_text()
        steps = [
            "run: python3 -m unittest discover -s .github/tests",
            "npm install",
            "claude-code/install.cjs",
            "--version",
            "run: python3 .github/gate.py",
        ]
        positions = [text.find(step) for step in steps]
        self.assertNotIn(-1, positions, f"a step is missing: {list(zip(steps, positions))}")
        self.assertEqual(positions, sorted(positions))

    def test_workflow_bounds_the_run(self) -> None:
        self.assertRegex(workflow_text(), r"(?m)^    timeout-minutes: \d+$")


if __name__ == "__main__":
    unittest.main()
