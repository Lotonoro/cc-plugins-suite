"""Tests for the workflow file: when it runs, what it pins, what it runs, and that it names no mod.

The standard library has no YAML parser, so the file is read as text, with its comment lines
dropped first so that a comment neither satisfies nor breaks a test. Its structure is read by
indentation: `block` gives the lines under a header line, and `steps` the lines of each step.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import List

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "gate.yml"

# The gate takes about ten minutes; the bound is for a check that hangs.
LONGEST_RUN_MINUTES = 30


def workflow_lines() -> List[str]:
    """The workflow's lines, without its comment lines."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    return [line for line in lines if not line.lstrip().startswith("#")]


def workflow_text() -> str:
    return "\n".join(workflow_lines())


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def block(header: str) -> List[str]:
    """The lines indented under a header line, which must be in the workflow exactly once."""
    lines = workflow_lines()
    if lines.count(header) != 1:
        raise AssertionError(f"the workflow has {lines.count(header)} lines {header!r}, not one")
    body: List[str] = []
    for line in lines[lines.index(header) + 1 :]:
        if not line.strip():
            continue
        if indent_of(line) <= indent_of(header):
            break
        body.append(line)
    return body


def steps() -> List[List[str]]:
    """The lines of each step of the job, a list for each; a step starts at its `- `."""
    items: List[List[str]] = []
    for line in block("    steps:"):
        if line.startswith("      - ") or not items:
            items.append([])
        items[-1].append(line)
    return items


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
        self.assertEqual(block("on:"), ["  pull_request:", "    branches: [main]"])

    def test_workflow_evaluates_no_expression_and_only_reads_the_repository(self) -> None:
        text = workflow_text()
        self.assertNotIn("${{", text, "an expression runs before the shell, on a secret or a title")
        self.assertEqual(block("permissions:"), ["  contents: read"])
        self.assertIsNone(re.search(r":\s*write\b", text))

    def test_workflow_pins_the_runner_python_and_cli(self) -> None:
        text = workflow_text()
        self.assertRegex(text, r"(?m)^    runs-on: ubuntu-24\.04$")
        self.assertRegex(text, r'(?m)^          python-version: "3\.9"$')
        self.assertRegex(text, r'(?m)^  CLAUDE_CODE_VERSION: "\d+\.\d+\.\d+"$')
        self.assertRegex(text, r'(?m)^  DISABLE_UPDATES: "1"$')
        for name in ("CLAUDE_CODE_VERSION", "DISABLE_UPDATES"):
            with self.subTest(name=name):
                declared = re.findall(name + r"""["']?[ \t]*:""", text)
                self.assertEqual(len(declared), 1, "a job's or step's own env would override it")

    def test_workflow_installs_the_pinned_cli_and_runs_its_postinstall_itself(self) -> None:
        joined = re.sub(r"\\\n\s*", "", workflow_text())
        installs = [line.strip() for line in joined.splitlines() if "npm install" in line]
        self.assertEqual(len(installs), 1)
        self.assertIn('"@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"', installs[0])
        self.assertIn("--ignore-scripts", installs[0])
        self.assertIn("claude-code/install.cjs", joined)

    def test_workflow_pins_every_action_to_a_commit(self) -> None:
        uses = re.findall(r"(?m)^\s*-?\s*uses: (\S+)(?: +#.*)?$", workflow_text())
        self.assertTrue(uses, "the workflow uses no action")
        for reference in uses:
            with self.subTest(uses=reference):
                self.assertRegex(reference, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")

    def test_workflow_keeps_no_credentials_after_the_checkout(self) -> None:
        checkouts = [
            step for step in steps() if any("uses: actions/checkout@" in line for line in step)
        ]
        self.assertEqual(len(checkouts), 1)
        self.assertIn("          persist-credentials: false", checkouts[0])

    def test_workflow_runs_bash_that_stops_at_the_first_error(self) -> None:
        self.assertEqual(
            block("defaults:"), ["  run:", "    shell: bash --noprofile --norc -euo pipefail {0}"]
        )
        self.assertEqual(workflow_text().count("shell:"), 1, "a step's own shell replaces it")

    def test_workflow_tests_the_gate_then_installs_the_cli_then_runs_the_gate(self) -> None:
        text = workflow_text()
        markers = [
            "run: python3 -m unittest discover -s .github/tests",
            "npm install",
            "claude-code/install.cjs",
            "--version",
            "run: python3 .github/gate.py",
        ]
        positions = [text.find(marker) for marker in markers]
        self.assertNotIn(-1, positions, f"a step is missing: {list(zip(markers, positions))}")
        self.assertEqual(positions, sorted(positions))

    def test_workflow_runs_the_gate_and_its_tests_as_plain_commands(self) -> None:
        lines = workflow_lines()
        for command in (
            "        run: python3 -m unittest discover -s .github/tests -v",
            "        run: python3 .github/gate.py",
        ):
            with self.subTest(command=command):
                self.assertEqual(lines.count(command), 1)

    def test_workflow_has_one_job_named_gate_that_nothing_skips_or_excuses(self) -> None:
        jobs = [line for line in block("jobs:") if indent_of(line) == 2]
        self.assertEqual(jobs, ["  gate:"])
        self.assertIsNone(re.search(r"(?m)^\s*(?:- )?(?:if|continue-on-error):", workflow_text()))

    def test_workflow_bounds_the_run(self) -> None:
        minutes = re.findall(r"(?m)^    timeout-minutes: (\d+)$", workflow_text())
        self.assertEqual(len(minutes), 1)
        self.assertTrue(0 < int(minutes[0]) <= LONGEST_RUN_MINUTES, f"{minutes[0]} minutes")


if __name__ == "__main__":
    unittest.main()
