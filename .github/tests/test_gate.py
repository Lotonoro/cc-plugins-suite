"""Tests for the gate: which steps it runs for which mods, and what fails it.

The gate runs in scratch repositories with a fake `claude` first on PATH, one that records its
arguments and fails on request, so what is tested is the gate's choice of steps and its verdict,
not the CLI's.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from support import Result, run

GATE = Path(__file__).resolve().parents[1] / "gate.py"

# Appends its arguments to $FAKE_CLAUDE_LOG, and exits 1 when they hold $FAKE_CLAUDE_FAIL.
FAKE_CLAUDE = """\
#!/usr/bin/env python3
import json
import os
import sys

with open(os.environ["FAKE_CLAUDE_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
failing = os.environ.get("FAKE_CLAUDE_FAIL")
if failing and failing in " ".join(sys.argv[1:]):
    print("the fake claude refuses: " + " ".join(sys.argv[1:]))
    sys.exit(1)
"""

# A check writes `check-ran` into its working directory, which shows where the gate ran it.
PASSING_CHECK = "#!/usr/bin/env python3\nopen('check-ran', 'w').close()\n"
FAILING_CHECK = "#!/usr/bin/env python3\nimport sys\nprint('the mod suite failed')\nsys.exit(1)\n"

LEAK = "/Users/someone/x"

# A name that ends a log line twice, once with a line feed and once with a carriage return, to
# start a workflow command of its own each time, and that holds the text of an escaped line end.
HOSTILE = "evil\n::error::injected\r::warning::more%0A"
ESCAPED = "evil%0A::error::injected%0D::warning::more%250A"

# File names that hold a line end, one with a line feed and one with a carriage return.
LINE_END_NAMES = ("a\n::error::boom\nb.md", "c\r::warning::more\rd.md")


def command_lines(log: str) -> List[str]:
    """The lines of a log that the runner reads as workflow commands; it ends a line at CR too."""
    return [line for line in re.split(r"\r\n|\r|\n", log) if line.startswith("::")]


class GateTest(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name)
        self.root = self.scratch / "repo"
        self.root.mkdir()
        self.log = self.scratch / "claude.log"
        bin_dir = self.scratch / "bin"
        bin_dir.mkdir()
        (bin_dir / "claude").write_text(FAKE_CLAUDE, encoding="utf-8")
        (bin_dir / "claude").chmod(0o755)
        self.env: Dict[str, str] = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_CLAUDE_LOG": str(self.log),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.env.pop("FAKE_CLAUDE_FAIL", None)
        self.git("init", "--quiet")
        self.add("README.md", "# scratch\n")
        self.marketplace([])

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.root, env=self.env, check=True, capture_output=True)

    def add(
        self, relative: str, content: str, *, executable: bool = False, track: bool = True
    ) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755 if executable else 0o644)
        if track:
            self.git("add", relative)

    def marketplace(self, listed: Sequence[str], description: str = "A scratch mod.") -> None:
        plugins = [
            {"name": name, "source": f"./mods/{name}", "description": description}
            for name in listed
        ]
        text = json.dumps({"name": "scratch", "plugins": plugins}, indent=2) + "\n"
        self.add(".claude-plugin/marketplace.json", text)

    def mod(
        self,
        name: str,
        *,
        hooks: bool = False,
        check: Optional[str] = None,
        executable: bool = True,
        track: bool = True,
    ) -> None:
        self.add(f"mods/{name}/README.md", f"The {name} mod.\n", track=track)
        if hooks:
            self.add(f"mods/{name}/hooks/hooks.json", "{}\n", track=track)
        if check is not None:
            self.add(f"mods/{name}/check", check, executable=executable, track=track)

    def gate(self, *args: str, env: Optional[Dict[str, str]] = None) -> Result:
        return run([sys.executable, str(GATE), *args], cwd=self.root, env=env or self.env)

    def claude_calls(self) -> List[List[str]]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def check_ran(self, name: str) -> bool:
        return (self.root / "mods" / name / "check-ran").exists()

    def test_listed_mod_with_hooks_and_a_check_gets_validate_test_and_its_check(self) -> None:
        self.mod("alpha", hooks=True, check=PASSING_CHECK)
        self.marketplace(["alpha"])
        result = self.gate()
        self.assertEqual(result.code, 0, result.out)
        self.assertEqual(
            self.claude_calls(),
            [
                ["plugin", "validate", "."],
                ["plugin", "validate", "mods/alpha"],
                ["plugin", "test", "mods/alpha"],
            ],
        )
        self.assertTrue(self.check_ran("alpha"))
        self.assertEqual(result.out.splitlines()[-1], "gate: all 5 steps passed")

    def test_listed_mod_with_no_hooks_and_no_check_is_validated_only(self) -> None:
        self.mod("beta")
        self.marketplace(["beta"])
        result = self.gate()
        self.assertEqual(result.code, 0, result.out)
        self.assertEqual(
            self.claude_calls(),
            [["plugin", "validate", "."], ["plugin", "validate", "mods/beta"]],
        )
        self.assertEqual(result.out.splitlines()[-1], "gate: all 3 steps passed")

    def test_unlisted_mod_runs_its_check_and_is_neither_validated_nor_tested(self) -> None:
        self.mod("gamma", hooks=True, check=PASSING_CHECK)
        result = self.gate()
        self.assertEqual(result.code, 0, result.out)
        self.assertEqual(self.claude_calls(), [["plugin", "validate", "."]])
        self.assertTrue(self.check_ran("gamma"))

    def test_check_runs_from_the_mods_directory(self) -> None:
        self.mod("alpha", check=PASSING_CHECK)
        self.marketplace(["alpha"])
        self.gate()
        self.assertTrue(self.check_ran("alpha"))
        self.assertFalse((self.root / "check-ran").exists())

    def test_mods_are_taken_in_name_order(self) -> None:
        self.mod("beta")
        self.mod("alpha")
        self.marketplace(["beta", "alpha"])
        self.gate()
        self.assertEqual(
            self.claude_calls(),
            [
                ["plugin", "validate", "."],
                ["plugin", "validate", "mods/alpha"],
                ["plugin", "validate", "mods/beta"],
            ],
        )

    def test_failing_check_fails_the_gate_naming_a_listed_mod(self) -> None:
        self.mod("alpha", check=FAILING_CHECK)
        self.marketplace(["alpha"])
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED mods/alpha: check: exit status 1", result.out)
        self.assertIn("the mod suite failed", result.out)
        self.assertIn("gate: 1 of 4 steps failed", result.out)

    def test_failing_check_fails_the_gate_naming_an_unlisted_mod(self) -> None:
        self.mod("gamma", check=FAILING_CHECK)
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED mods/gamma: check: exit status 1", result.out)

    def test_check_that_is_not_executable_fails_the_gate_naming_the_mod(self) -> None:
        self.mod("alpha", check=PASSING_CHECK, executable=False)
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED mods/alpha: check: not executable", result.out)
        self.assertFalse(self.check_ran("alpha"))

    def test_check_that_cannot_be_started_fails_the_gate_naming_the_mod(self) -> None:
        self.mod("alpha", check="#!/nonexistent/interpreter\n")
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED mods/alpha: check: cannot run", result.out)

    def test_failed_validate_fails_the_gate_naming_the_mod_and_the_other_steps_still_run(
        self,
    ) -> None:
        self.mod("alpha", check=PASSING_CHECK)
        self.mod("beta", check=PASSING_CHECK)
        self.marketplace(["alpha", "beta"])
        self.env["FAKE_CLAUDE_FAIL"] = "validate mods/alpha"
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(
            "FAILED mods/alpha: claude plugin validate mods/alpha: exit status 1", result.out
        )
        self.assertIn(["plugin", "validate", "mods/beta"], self.claude_calls())
        self.assertTrue(self.check_ran("alpha"))
        self.assertTrue(self.check_ran("beta"))
        self.assertIn("gate: 1 of 6 steps failed", result.out)

    def test_failed_test_fails_the_gate_naming_the_mod(self) -> None:
        self.mod("alpha", hooks=True)
        self.marketplace(["alpha"])
        self.env["FAKE_CLAUDE_FAIL"] = "plugin test mods/alpha"
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED mods/alpha: claude plugin test mods/alpha: exit status 1", result.out)

    def test_failed_marketplace_validate_fails_the_gate(self) -> None:
        self.env["FAKE_CLAUDE_FAIL"] = "plugin validate ."
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED marketplace: claude plugin validate .: exit status 1", result.out)

    def test_marketplace_that_cannot_be_read_fails_the_gate(self) -> None:
        self.add(".claude-plugin/marketplace.json", "{not json")
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(
            "FAILED marketplace: cannot read .claude-plugin/marketplace.json", result.out
        )

    def test_listed_source_that_is_not_a_directory_fails_the_gate_naming_the_entry(self) -> None:
        self.marketplace(["ghost"])
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(
            "FAILED marketplace: ghost: source ./mods/ghost is not a directory", result.out
        )

    def test_listed_source_that_is_not_a_path_fails_the_gate_naming_the_entry(self) -> None:
        entry = {"name": "remote", "source": {"source": "github", "repo": "someone/remote"}}
        text = json.dumps({"name": "scratch", "plugins": [entry]}, indent=2) + "\n"
        self.add(".claude-plugin/marketplace.json", text)
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED marketplace: remote: source ", result.out)

    def test_leak_in_a_tracked_mod_file_fails_the_gate_with_its_file_and_line(self) -> None:
        self.mod("alpha")
        self.marketplace(["alpha"])
        self.add("mods/alpha/notes.md", f"fine\n{LEAK}\n")
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(f"mods/alpha/notes.md:2:{LEAK}", result.out)
        self.assertIn("FAILED leak check: exit status 1", result.out)

    def test_leak_deep_in_a_mods_directory_fails_the_gate(self) -> None:
        self.mod("alpha")
        self.marketplace(["alpha"])
        self.add("mods/alpha/hooks/deep/er/file.ts", f"// {LEAK}\n")
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(f"mods/alpha/hooks/deep/er/file.ts:1:// {LEAK}", result.out)

    def test_leak_in_the_readme_fails_the_gate_with_its_file_and_line(self) -> None:
        self.add("README.md", f"# scratch\nsee {LEAK}\n")
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(f"README.md:2:see {LEAK}", result.out)

    def test_leak_in_the_marketplace_fails_the_gate_with_its_file_and_line(self) -> None:
        self.mod("alpha")
        self.marketplace(["alpha"], description=f"see {LEAK}")
        text = (self.root / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
        number, line = next(
            (n, line) for n, line in enumerate(text.splitlines(), start=1) if LEAK in line
        )
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn(f".claude-plugin/marketplace.json:{number}:{line}", result.out)

    def test_leaks_outside_every_mods_directory_and_in_untracked_files_pass(self) -> None:
        self.mod("alpha")
        self.marketplace(["alpha"])
        self.add("docs/notes.md", f"{LEAK}\n")
        self.add("mods/stray.md", f"{LEAK}\n")
        self.add("mods/alpha/scratch.md", f"{LEAK}\n", track=False)
        result = self.gate()
        self.assertEqual(result.code, 0, result.out)
        self.assertEqual(result.out.splitlines()[-1], "gate: all 3 steps passed")

    def test_no_file_to_leak_check_fails_the_gate(self) -> None:
        self.git("rm", "--quiet", "--force", "--cached", "README.md")
        self.git("rm", "--quiet", "--force", "--cached", ".claude-plugin/marketplace.json")
        result = self.gate()
        self.assertEqual(result.code, 1)
        self.assertIn("FAILED leak check: exit status 2", result.out)

    def test_outside_a_repository_exits_2_and_runs_nothing(self) -> None:
        elsewhere = self.scratch / "not-a-repository"
        elsewhere.mkdir()
        env = {**self.env, "GIT_CEILING_DIRECTORIES": str(self.scratch)}
        result = run([sys.executable, str(GATE)], cwd=elsewhere, env=env)
        self.assertEqual(result.code, 2)
        self.assertIn("gate: git rev-parse failed", result.err)
        self.assertEqual(self.claude_calls(), [])

    def test_an_argument_exits_2(self) -> None:
        result = self.gate("--no-such-option")
        self.assertEqual(result.code, 2)
        self.assertIn("--no-such-option", result.err)
        self.assertEqual(self.claude_calls(), [])

    def test_a_mods_name_cannot_end_a_log_line_and_start_a_workflow_command(self) -> None:
        # Untracked, so that the step labels are all that holds the name; the paths of a tracked
        # file under it are the subject of the test below.
        self.mod(HOSTILE, check=FAILING_CHECK, track=False)
        self.marketplace([HOSTILE])
        result = self.gate()
        self.assertEqual(result.code, 1)
        mod = f"mods/{ESCAPED}"
        self.assertEqual(
            command_lines(result.out),
            [
                "::group::marketplace: claude plugin validate .",
                "::endgroup::",
                f"::group::{mod}: claude plugin validate {mod}",
                "::endgroup::",
                f"::group::{mod}: check",
                "::endgroup::",
                f"::error::{mod}: check: exit status 1",
                "::group::leak check",
                "::endgroup::",
            ],
        )
        lines = result.out.split("\n")
        self.assertIn(f"$ claude plugin validate '{mod}'", lines)
        self.assertIn(f"FAILED {mod}: check: exit status 1", lines)

    def test_a_marketplace_entrys_name_cannot_end_a_log_line_and_start_a_workflow_command(
        self,
    ) -> None:
        entry = {"name": HOSTILE, "source": f"./mods/{HOSTILE}"}
        text = json.dumps({"name": "scratch", "plugins": [entry]}, indent=2) + "\n"
        self.add(".claude-plugin/marketplace.json", text)
        result = self.gate()
        self.assertEqual(result.code, 1)
        why = f"{ESCAPED}: source ./mods/{ESCAPED} is not a directory of this repository"
        self.assertEqual(
            command_lines(result.out),
            [
                f"::error::marketplace: {why}",
                "::group::marketplace: claude plugin validate .",
                "::endgroup::",
                "::group::leak check",
                "::endgroup::",
            ],
        )
        self.assertIn(f"FAILED marketplace: {why}", result.out.split("\n"))

    def test_a_tracked_path_with_a_line_end_fails_the_gate_and_stays_out_of_the_leak_check(
        self,
    ) -> None:
        self.mod("alpha")
        self.marketplace(["alpha"])
        for name in LINE_END_NAMES:
            self.add(f"mods/alpha/{name}", f"see {LEAK}\n")
        self.add("mods/alpha/notes.md", f"see {LEAK}\n")
        result = self.gate()
        self.assertEqual(result.code, 1)
        first = "tracked path mods/alpha/a%0A::error::boom%0Ab.md holds CR or LF"
        second = "tracked path mods/alpha/c%0D::warning::more%0Dd.md holds CR or LF"
        self.assertEqual(
            command_lines(result.out),
            [
                f"::error::leak check: {first}",
                f"::error::leak check: {second}",
                "::group::marketplace: claude plugin validate .",
                "::endgroup::",
                "::group::mods/alpha: claude plugin validate mods/alpha",
                "::endgroup::",
                "::group::leak check",
                "::endgroup::",
                "::error::leak check: exit status 1",
            ],
        )
        lines = result.out.split("\n")
        self.assertIn("$ python3 leak_check.py -- 4 files", lines)
        self.assertIn(f"mods/alpha/notes.md:1:see {LEAK}", lines)
        self.assertIn(f"FAILED leak check: {first}", lines)
        self.assertIn(f"FAILED leak check: {second}", lines)
        self.assertIn("gate: 3 of 5 steps failed", lines)
        self.assertNotIn("\r", result.out)


if __name__ == "__main__":
    unittest.main()
