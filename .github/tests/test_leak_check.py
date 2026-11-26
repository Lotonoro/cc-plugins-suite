"""Tests for the leak check's interface: the paths it takes, the lines it prints, its exit status.

The check runs as a child process, as the gate and the measurements build call it, so what is
tested is what they see.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, Optional, Union

from support import Result, run

LEAK_CHECK = Path(__file__).resolve().parents[1] / "leak_check.py"

MACHINE_SPECIFIC = ("/Users/someone/x", "~/temp/x", "$HOME/temp/x")
STANDARD_LOCATIONS = ("~/.claude/x", "~/.android/avd", "/home/someone/x")


class LeakCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.dir = Path(scratch.name)

    def write(self, name: str, content: Union[str, bytes]) -> str:
        """Writes a file of exactly these bytes into the scratch directory; returns its name."""
        data = content.encode("utf-8") if isinstance(content, str) else content
        (self.dir / name).write_bytes(data)
        return name

    def run_check(self, *args: str, env: Optional[Dict[str, str]] = None) -> Result:
        return run([sys.executable, str(LEAK_CHECK), *args], cwd=self.dir, env=env)

    def test_clean_files_exit_0_and_print_nothing(self) -> None:
        self.write("a.md", "nothing here\nor here\n")
        self.write("b.md", "")
        result = self.run_check("a.md", "b.md")
        self.assertEqual((result.code, result.out, result.err), (0, "", ""))

    def test_a_match_prints_file_line_text_and_exits_1(self) -> None:
        self.write("leak.md", "fine\nsee /Users/someone/x here\nfine\n")
        result = self.run_check("leak.md")
        self.assertEqual(result.code, 1)
        self.assertEqual(result.out, "leak.md:2:see /Users/someone/x here\n")

    def test_each_matching_line_prints_once_in_argument_order(self) -> None:
        self.write("a.md", "ok\n~/temp/a\n")
        self.write("b.md", "$HOME/temp/b\nok\n/Users/c\n")
        result = self.run_check("b.md", "a.md")
        self.assertEqual(result.code, 1)
        self.assertEqual(result.out, "b.md:1:$HOME/temp/b\nb.md:3:/Users/c\na.md:2:~/temp/a\n")

    def test_a_line_holding_two_scope_strings_prints_once(self) -> None:
        self.write("a.md", "/Users/a and ~/temp/b\n")
        result = self.run_check("a.md")
        self.assertEqual(result.out, "a.md:1:/Users/a and ~/temp/b\n")

    def test_paths_print_as_they_were_given(self) -> None:
        self.write("a.md", "/Users/a\n")
        absolute = str(self.dir / "a.md")
        self.assertEqual(self.run_check(absolute).out, f"{absolute}:1:/Users/a\n")

    def test_no_paths_exits_2_and_prints_the_usage_on_stderr(self) -> None:
        result = self.run_check()
        self.assertEqual((result.code, result.out), (2, ""))
        self.assertIn("usage", result.err.lower())

    def test_unknown_option_exits_2_and_names_it_on_stderr(self) -> None:
        self.write("a.md", "ok\n")
        result = self.run_check("--no-such-option", "a.md")
        self.assertEqual((result.code, result.out), (2, ""))
        self.assertIn("--no-such-option", result.err)

    def test_double_dash_ends_the_options(self) -> None:
        self.write("-leak.md", "/Users/a\n")
        result = self.run_check("--", "-leak.md")
        self.assertEqual((result.code, result.out), (1, "-leak.md:1:/Users/a\n"))

    def test_shipped_scope_fails_machine_specific_paths(self) -> None:
        for text in MACHINE_SPECIFIC:
            with self.subTest(text=text):
                self.write("a.md", f"before\n{text}\n")
                result = self.run_check("a.md")
                self.assertEqual((result.code, result.out), (1, f"a.md:2:{text}\n"))

    def test_shipped_scope_passes_standard_locations(self) -> None:
        for text in STANDARD_LOCATIONS:
            with self.subTest(text=text):
                self.write("a.md", f"{text}\n")
                result = self.run_check("a.md")
                self.assertEqual((result.code, result.out), (0, ""))

    def test_scope_option_replaces_the_shipped_scope(self) -> None:
        self.write("scope.txt", "/Volumes/Backup\n")
        self.write("private.md", "/Volumes/Backup/x\n")
        self.write("machine.md", "/Users/someone/x\n")
        private = self.run_check("--scope", "scope.txt", "private.md")
        self.assertEqual((private.code, private.out), (1, "private.md:1:/Volumes/Backup/x\n"))
        machine = self.run_check("--scope", "scope.txt", "machine.md")
        self.assertEqual((machine.code, machine.out), (0, ""))

    def test_scope_strings_match_as_literal_text(self) -> None:
        self.write("scope.txt", "a.c\n$HOME\n")
        self.write("a.md", "abc\nan a.c\n$HOME\n")
        result = self.run_check("--scope", "scope.txt", "a.md")
        self.assertEqual(result.out, "a.md:2:an a.c\na.md:3:$HOME\n")

    def test_scope_skips_comments_and_blank_lines_and_trims_each_string(self) -> None:
        self.write("scope.txt", "# /Users/ is a comment here\n\n   /opt/private   \n")
        self.write("a.md", "/Users/someone/x\n")
        self.write("b.md", "see /opt/private/y\n")
        self.assertEqual(self.run_check("--scope", "scope.txt", "a.md").code, 0)
        result = self.run_check("--scope", "scope.txt", "b.md")
        self.assertEqual((result.code, result.out), (1, "b.md:1:see /opt/private/y\n"))

    def test_scope_naming_no_string_exits_2(self) -> None:
        self.write("scope.txt", "# only a comment\n\n")
        self.write("a.md", "/Users/someone/x\n")
        result = self.run_check("--scope", "scope.txt", "a.md")
        self.assertEqual((result.code, result.out), (2, ""))
        self.assertIn("scope.txt", result.err)

    def test_unreadable_scope_exits_2(self) -> None:
        self.write("a.md", "ok\n")
        result = self.run_check("--scope", "missing.txt", "a.md")
        self.assertEqual((result.code, result.out), (2, ""))
        self.assertIn("missing.txt", result.err)

    def test_missing_path_exits_2_and_still_reports_the_other_paths_matches(self) -> None:
        self.write("leak.md", "/Users/a\n")
        result = self.run_check("missing.md", "leak.md")
        self.assertEqual(result.code, 2)
        self.assertEqual(result.out, "leak.md:1:/Users/a\n")
        self.assertIn("missing.md", result.err)

    def test_directory_path_exits_2_and_names_it_on_stderr(self) -> None:
        (self.dir / "a-directory").mkdir()
        result = self.run_check("a-directory")
        self.assertEqual((result.code, result.out), (2, ""))
        self.assertIn("a-directory", result.err)

    def test_line_ends_are_not_text_and_a_last_line_without_a_newline_is_checked(self) -> None:
        self.write("a.md", b"ok\r\n/Users/a\r\n/Users/b")
        result = self.run_check("a.md")
        self.assertEqual(result.out, "a.md:2:/Users/a\na.md:3:/Users/b\n")

    def test_bytes_that_are_not_utf8_do_not_hide_a_match(self) -> None:
        self.write("bin.dat", b"\xff\xfe junk /Users/x\n")
        result = self.run_check("bin.dat")
        self.assertEqual(result.code, 1)
        self.assertTrue(result.out.startswith("bin.dat:1:"))
        self.assertIn("/Users/x", result.out)

    def test_output_is_utf8_whatever_the_terminal_encoding(self) -> None:
        self.write("a.md", "It’s /Users/a\n")
        env = {**os.environ, "PYTHONIOENCODING": "ascii"}
        result = self.run_check("a.md", env=env)
        self.assertEqual((result.code, result.out), (1, "a.md:1:It’s /Users/a\n"))


if __name__ == "__main__":
    unittest.main()
