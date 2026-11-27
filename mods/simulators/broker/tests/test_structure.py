"""Structural tests: which modules read the environment, and which can be entered from outside.

The plan's bar is that every verb enters through the dispatcher and that the dispatcher alone reads
the client's environment. These tests read the broker's source, not its behaviour, and each rule is
shown to find a break of it in a source written for the purpose, so a scan that has gone blind fails
here and not silently.
"""

from __future__ import annotations

import ast
import os
import unittest
from typing import Dict, List, Set

DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

READS = {"environ", "environb", "getenv", "getenvb", "putenv", "unsetenv"}
# The modules that carry out a verb: `broker.configure`, `broker.status` and the runner of `run`.
VERB_MODULES = {"broker.configure", "broker.status", "broker.runner"}


def production_sources() -> Dict[str, str]:
    """The source of each of the broker's modules, by module name, tests excluded."""
    found = {}
    for name in sorted(os.listdir(DIRECTORY)):
        if name.endswith(".py"):
            with open(os.path.join(DIRECTORY, name), encoding="utf-8") as handle:
                found[name[: -len(".py")]] = handle.read()
    return found


def environment_reads(source: str) -> List[ast.AST]:
    """The places a source reads or writes the process's environment through `os`."""
    tree = ast.parse(source)
    names = {"os"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.asname for alias in node.names if alias.name == "os" and alias.asname)
    found: List[ast.AST] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id in names
            and node.attr in READS
        ):
            found.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            found.extend([node] if any(alias.name in READS for alias in node.names) else [])
    return found


def imports(source: str) -> Set[str]:
    """The module names a source imports, `from broker import x` counted as `broker.x`."""
    found: Set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
            found.update(f"{node.module}.{alias.name}" for alias in node.names)
    return found


def has_main_guard(source: str) -> bool:
    for node in ast.walk(ast.parse(source)):
        if (
            isinstance(node, ast.If)
            and isinstance(node.test, ast.Compare)
            and isinstance(node.test.left, ast.Name)
            and node.test.left.id == "__name__"
        ):
            return True
    return False


def enclosing_function(source: str, target: ast.AST) -> str:
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(child is not target and getattr(child, "lineno", -1) == target.lineno for child in ast.walk(node)):
                return node.name
    return ""


class EnvironmentTest(unittest.TestCase):
    def test_the_scan_has_the_modules_to_look_at(self) -> None:
        sources = production_sources()
        self.assertGreaterEqual(len(sources), 15)
        for name in ("dispatcher", "stateroot", "policy", "leaf", "wrapper", "runner", "family"):
            self.assertIn(name, sources)

    def test_no_module_but_the_dispatcher_reads_the_environment(self) -> None:
        for name, source in production_sources().items():
            if name != "dispatcher":
                with self.subTest(module=name):
                    self.assertEqual([node.lineno for node in environment_reads(source)], [])

    def test_the_dispatcher_reads_the_process_environment_once_and_in_its_entry(self) -> None:
        source = production_sources()["dispatcher"]
        (read,) = environment_reads(source)
        self.assertEqual(enclosing_function(source, read), "entry")

    def test_the_scan_names_the_function_a_read_is_in(self) -> None:
        source = "import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return os.environ\n"
        (read,) = environment_reads(source)
        self.assertEqual(enclosing_function(source, read), "b")

    def test_the_scan_finds_each_way_of_reaching_the_environment(self) -> None:
        for what, source in (
            ("os.environ", "import os\nx = os.environ['A']\n"),
            ("os.getenv", "import os\nx = os.getenv('A')\n"),
            ("os.putenv", "import os\nos.putenv('A', 'b')\n"),
            ("an import", "from os import environ\n"),
            ("an alias", "import os as o\nx = o.environ\n"),
        ):
            with self.subTest(what=what):
                self.assertEqual(len(environment_reads(source)), 1)
        self.assertEqual(environment_reads("import os\nx = os.getcwd()\n"), [])


class EntryTest(unittest.TestCase):
    def test_only_the_dispatcher_imports_a_verbs_module(self) -> None:
        for name, source in production_sources().items():
            if name != "dispatcher":
                with self.subTest(module=name):
                    self.assertEqual(imports(source) & VERB_MODULES, set())

    def test_the_dispatcher_imports_every_verbs_module(self) -> None:
        self.assertEqual(imports(production_sources()["dispatcher"]) & VERB_MODULES, VERB_MODULES)

    def test_only_the_dispatcher_can_be_run_as_a_program(self) -> None:
        for name, source in production_sources().items():
            with self.subTest(module=name):
                self.assertEqual(has_main_guard(source), name == "dispatcher")

    def test_the_scan_finds_a_second_entry_and_a_second_import_of_a_verb(self) -> None:
        self.assertTrue(has_main_guard("if __name__ == '__main__':\n    pass\n"))
        self.assertFalse(has_main_guard("def main():\n    pass\n"))
        self.assertEqual(imports("from broker import status\n") & VERB_MODULES, {"broker.status"})
        self.assertEqual(imports("import broker.configure\n") & VERB_MODULES, {"broker.configure"})
        self.assertEqual(imports("from broker.runner import metered_run\n") & VERB_MODULES, {"broker.runner"})


if __name__ == "__main__":
    unittest.main()
