"""Tests for the dispatcher: the one entry point, and the one reader of the client's environment.

The dispatcher is handed the environment as a mapping, so a test sets it without touching the
process's, which every test here empties to show that nothing else is read. A `run` runs the real
wrapper and so is run on macOS only; the rest runs anywhere.
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import types
import unittest
from typing import Dict, List, Optional
from unittest import mock

from broker import protocol
from broker.dispatcher import USAGE, main
from broker.tests.process_case import ONLY_ON_MACOS, ROOT
from broker.tests.programs import EXIT_WITH, LEAVE_A_MARK
from broker.tests.support import FakeClock, FakeMachine, hold_in_another_process, scratch_dir

ON_MACOS = unittest.skipUnless(sys.platform == "darwin", ONLY_ON_MACOS)


class DispatcherCase(unittest.TestCase):
    def setUp(self) -> None:
        patch = mock.patch.dict(os.environ, {}, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.dir = scratch_dir(self)
        self.root = os.path.join(self.dir, "root")
        self.family = os.path.join(self.root, "family", "lock")
        self.env: Dict[str, str] = {protocol.STATE_ROOT_SETTING: self.root}
        self.clock = FakeClock()
        self.machine = FakeMachine(clock=self.clock)
        self.out = io.StringIO()
        self.err = io.StringIO()

    def main(self, *argv: str, env: Optional[Dict[str, str]] = None) -> int:
        return main(
            list(argv),
            environ=self.env if env is None else env,
            out=self.out,
            err=self.err,
            machine=self.machine,
            clock=self.clock,
        )

    def python(self, source: str, *args: str) -> List[str]:
        script = os.path.join(self.dir, f"program-{len(os.listdir(self.dir))}.py")
        with open(script, "w", encoding="utf-8") as handle:
            handle.write(source)
        return [sys.executable, script, *args]

    def err_lines(self) -> List[str]:
        return self.err.getvalue().splitlines()


class RoutingTest(DispatcherCase):
    def test_the_status_verb_reads_the_root_the_setting_names(self) -> None:
        self.assertEqual(self.main("status"), 0)
        self.assertEqual(self.out.getvalue().splitlines()[0], f"state root: {self.root}")
        self.assertEqual(self.err.getvalue(), "")

    def test_with_no_setting_the_root_is_claude_simulators_in_application_support(self) -> None:
        home = os.path.join(self.dir, "home")
        os.makedirs(home)
        self.assertEqual(self.main("status", env={"HOME": home}), 0)
        expected = os.path.join(home, "Library", "Application Support", "claude-simulators")
        self.assertEqual(self.out.getvalue().splitlines()[0], f"state root: {expected}")

    def test_a_relative_setting_is_made_absolute_from_the_working_directory(self) -> None:
        before = os.getcwd()
        os.chdir(self.dir)
        self.addCleanup(os.chdir, before)
        self.assertEqual(self.main("status", env={protocol.STATE_ROOT_SETTING: "relative-root"}), 0)
        self.assertEqual(
            self.out.getvalue().splitlines()[0], f"state root: {os.path.join(self.dir, 'relative-root')}"
        )

    def test_the_configure_verb_writes_the_configuration_into_the_root(self) -> None:
        self.assertEqual(self.main("configure", "--slots", "2", "--settle-seconds", "30"), 0)
        with open(os.path.join(self.root, "config.json"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn('"slots": 2', text)
        self.assertIn('"settle_seconds": 30', text)
        self.assertIn(f"wrote {os.path.join(self.root, 'config.json')}", self.out.getvalue())

    def test_the_configure_verb_takes_every_setting_as_an_option(self) -> None:
        shared = os.path.join(self.dir, "shared")
        os.makedirs(shared)
        argv = [
            "configure", "--family", os.path.join(shared, "lock"), "--shared", "--max-runs", "3",
            "--slots", "2", "--settle-seconds", "45", "--min-idle-percent", "60",
        ]  # fmt: skip
        self.assertEqual(self.main(*argv), 0)
        output = self.out.getvalue()
        for line in ("shared with sim-lock.sh: yes", "slots: 2", "settle seconds: 45", "minimum idle percent: 60"):
            self.assertIn(line, output)

    def test_the_configure_verb_works_on_a_root_whose_configuration_the_loader_refuses(self) -> None:
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            handle.write("not json")
        self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
        self.assertEqual(self.main("configure"), 0)
        self.assertEqual(self.main("status"), 0)

    def test_a_family_that_only_begins_like_the_default_lock_is_configured_and_read_again(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")  # stands for the script's default lock
        family = os.path.join(default + ".d", "family", "lock")
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main("configure", "--family", family), 0)  # which makes the directory
            self.assertEqual(self.main("status"), 0)
            self.assertEqual(self.main("configure", "--family", family), 0)
        self.assertEqual(self.err.getvalue(), "")

    @ON_MACOS
    def test_the_run_verb_exits_with_the_commands_status_and_prints_nothing_of_its_own(self) -> None:
        self.assertEqual(self.main("run", "--", *self.python(EXIT_WITH, "7")), 7)
        self.assertEqual((self.out.getvalue(), self.err.getvalue()), ("", ""))

    @ON_MACOS
    def test_the_run_verb_takes_a_command_with_flags_of_its_own_with_or_without_the_dashes(self) -> None:
        self.assertEqual(self.main("run", "/bin/sh", "-c", "exit 3"), 3)
        self.assertEqual(self.main("run", "--", "/bin/sh", "-c", "exit 4"), 4)

    @ON_MACOS
    def test_the_run_verb_names_the_client_the_directory_and_the_command_in_the_slots_record(self) -> None:
        record = os.path.join(self.dir, "owner-record")
        source = (
            "import shutil, sys\n"
            f"shutil.copy({self.family + '.owner'!r}, sys.argv[1])\n"
        )
        command = self.python(source, record)
        self.assertEqual(self.main("run", "--", *command), 0)
        with open(record, encoding="utf-8") as handle:
            owner = handle.read()
        self.assertTrue(owner.startswith(f"pid={os.getpid()} slot=0 cwd={os.getcwd()} started="), owner)
        self.assertTrue(owner.endswith(f"command={' '.join(command)}\n"), owner)

    def test_a_run_that_waits_the_whole_timeout_exits_75_and_runs_nothing(self) -> None:
        os.makedirs(os.path.dirname(self.family))
        for slot in range(3):
            hold_in_another_process(self, self.family if slot == 0 else f"{self.family}.{slot}")
        mark = os.path.join(self.dir, "mark")
        self.assertEqual(self.main("run", "--", *self.python(LEAVE_A_MARK, "ran", mark)), protocol.EXIT_TIMEOUT)
        self.assertFalse(os.path.exists(mark))
        lines = self.err_lines()
        self.assertEqual(lines[0].split(";")[0], f"sim-lock: no configuration at {self.root}/config.json")
        self.assertEqual(
            lines[1],
            "sim-lock: waiting for a simulator run slot: all 3 run slots are held; running now:",
        )
        self.assertEqual(lines[-1], "sim-lock: gave up after 3600s: all 3 run slots are held")
        self.assertEqual(self.out.getvalue(), "")


class EnvironmentTest(DispatcherCase):
    def test_a_family_equal_to_the_roots_is_accepted_and_is_not_called_ignored(self) -> None:
        self.env[protocol.FAMILY_VARIABLE] = self.family
        self.assertEqual(self.main("status"), 0)
        self.assertEqual(self.err.getvalue(), "")

    def test_a_family_other_than_the_roots_reports_both_runs_nothing_and_exits_79(self) -> None:
        other = os.path.join(self.dir, "pango-sim-test.flock")
        self.env[protocol.FAMILY_VARIABLE] = other
        mark = os.path.join(self.dir, "mark")
        code = self.main("run", "--", *self.python(LEAVE_A_MARK, "ran", mark))
        self.assertEqual(code, protocol.EXIT_FAMILY_DISAGREES)
        self.assertFalse(os.path.exists(mark))
        line = self.err_lines()[-1]
        self.assertTrue(line.startswith("sim-lock: "), line)
        self.assertIn(other, line)
        self.assertIn(self.family, line)
        self.assertIn("nothing was run", line)
        self.assertFalse(os.path.exists(os.path.join(self.root, "state")))
        self.assertFalse(os.path.exists(os.path.dirname(self.family)))

    def test_each_other_sim_lock_variable_is_named_as_ignored_once_in_name_order(self) -> None:
        self.env.update({"SIM_LOCK_TIMEOUT": "5", "SIM_LOCK_MAX_RUNS": "9", "SIM_LOCK_POLL": "1"})
        self.assertEqual(self.main("status"), 0)
        self.assertEqual(
            self.err_lines(),
            [
                "sim-lock: ignoring SIM_LOCK_MAX_RUNS, SIM_LOCK_POLL, SIM_LOCK_TIMEOUT: the broker "
                "takes its settings from the state root's configuration, never from the environment"
            ],
        )

    def test_only_variables_with_the_prefix_are_named(self) -> None:
        self.env.update({"SIM_LOCKED": "1", "XSIM_LOCK_POLL": "1", "OTHER": "1"})
        self.assertEqual(self.main("status"), 0)
        self.assertEqual(self.err.getvalue(), "")

    def test_the_ignored_notice_comes_before_a_disagreement_and_both_appear(self) -> None:
        self.env.update({"SIM_LOCK_POLL": "1", protocol.FAMILY_VARIABLE: os.path.join(self.dir, "other")})
        self.assertEqual(self.main("status"), protocol.EXIT_FAMILY_DISAGREES)
        lines = self.err_lines()
        self.assertTrue(lines[0].startswith("sim-lock: ignoring SIM_LOCK_POLL"), lines[0])
        self.assertIn("nothing was run", lines[1])

    def test_the_configure_verb_names_a_family_variable_as_ignored_since_it_takes_the_family_as_an_option(
        self,
    ) -> None:
        self.env[protocol.FAMILY_VARIABLE] = os.path.join(self.dir, "other")
        self.assertEqual(self.main("configure"), 0)
        self.assertIn("sim-lock: ignoring SIM_LOCK_FILE", self.err_lines()[0])
        self.assertIn(os.path.join(self.root, "family", "lock"), self.out.getvalue())

    def test_the_dispatcher_reads_the_mapping_it_is_given_and_not_the_process_environment(self) -> None:
        self.assertEqual(dict(os.environ), {})
        self.assertEqual(self.main("status"), 0)
        self.assertEqual(self.main("status", env={protocol.STATE_ROOT_SETTING: self.root + "-2"}), 0)
        roots = [line for line in self.out.getvalue().splitlines() if line.startswith("state root: ")]
        self.assertEqual(roots, [f"state root: {self.root}", f"state root: {self.root}-2"])

    def test_a_variable_set_to_nothing_counts_as_unset(self) -> None:
        home = os.path.join(self.dir, "home")
        os.makedirs(home)
        env = {
            "HOME": home,
            protocol.STATE_ROOT_SETTING: "",
            protocol.FAMILY_VARIABLE: "",
            "SIM_LOCK_POLL": "",
        }
        self.assertEqual(self.main("status", env=env), 0)
        expected = os.path.join(home, "Library", "Application Support", "claude-simulators")
        self.assertEqual(self.out.getvalue().splitlines()[0], f"state root: {expected}")
        self.assertEqual(self.err.getvalue(), "")

    def test_with_no_home_the_accounts_home_directory_holds_the_default_root(self) -> None:
        home = os.path.join(self.dir, "home")
        os.makedirs(home)
        account = types.SimpleNamespace(pw_dir=home)
        with mock.patch("broker.dispatcher.pwd.getpwuid", return_value=account) as lookup:
            self.assertEqual(self.main("status", env={}), 0)
        lookup.assert_called_once_with(os.getuid())
        expected = os.path.join(home, "Library", "Application Support", "claude-simulators")
        self.assertEqual(self.out.getvalue().splitlines()[0], f"state root: {expected}")

    def test_a_home_that_holds_a_dot_dot_gives_the_default_root_without_it_and_a_family_that_is_accepted(self) -> None:
        home = os.path.join(self.dir, "home")
        os.makedirs(home)
        env = {"HOME": os.path.join(home, "..", "home")}
        self.assertEqual(self.main("configure", env=env), 0)  # the family it derives from the root has no `..`
        self.assertEqual(self.main("status", env=env), 0)
        root = os.path.join(home, "Library", "Application Support", "claude-simulators")
        self.assertIn(f"state root: {root}", self.out.getvalue().splitlines())
        with open(os.path.join(root, "config.json"), encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["family"], os.path.join(root, "family", "lock"))
        self.assertEqual(self.err.getvalue(), "")

    # The directory the slot's owner record shows is the one `sim-lock.sh` records, the shell's
    # `$PWD`, when that names the current directory.

    def chdir(self, path: str) -> None:
        before = os.getcwd()
        os.chdir(path)
        self.addCleanup(os.chdir, before)

    def recorded_directory(self, env: Dict[str, str]) -> str:
        """The `cwd` the owner record shows for a run started with the environment `env`."""
        record = os.path.join(self.dir, "owner-record")
        source = f"import shutil, sys\nshutil.copy({self.family + '.owner'!r}, sys.argv[1])\n"
        self.assertEqual(self.main("run", "--", *self.python(source, record), env=env), 0)
        with open(record, encoding="utf-8") as handle:
            owner = handle.read()
        found = re.search(r" cwd=(.*?) started=\d{4}-\d\d-\d\dT", owner)
        assert found is not None, owner
        return found.group(1)

    @ON_MACOS
    def test_the_record_shows_the_directory_pwd_names_when_it_is_the_current_one_through_a_symlink(
        self,
    ) -> None:
        real, link = os.path.join(self.dir, "real"), os.path.join(self.dir, "link")
        os.makedirs(real)
        os.symlink(real, link)
        self.chdir(link)
        self.assertEqual(os.getcwd(), real)  # all the process itself can say is the resolved path
        self.assertEqual(self.recorded_directory({**self.env, "PWD": link}), link)

    @ON_MACOS
    def test_the_record_shows_the_current_directory_when_pwd_is_no_name_for_it(self) -> None:
        other = os.path.join(self.dir, "other")
        os.makedirs(other)
        self.chdir(self.dir)
        for what, pwd in (
            ("unset", None),
            ("empty", ""),
            ("another directory", other),
            ("a relative path", "."),
            ("a path that is not there", os.path.join(self.dir, "gone")),
        ):
            with self.subTest(what=what):
                env = dict(self.env) if pwd is None else {**self.env, "PWD": pwd}
                self.assertEqual(self.recorded_directory(env), self.dir)


class ErrorsTest(DispatcherCase):
    def test_no_verb_is_a_usage_error_with_the_usage(self) -> None:
        self.assertEqual(self.main(), protocol.EXIT_USAGE)
        self.assertEqual(self.err_lines()[0], "sim-lock: no verb given")
        self.assertIn(USAGE.splitlines()[0], self.err.getvalue())

    def test_an_unknown_verb_is_a_usage_error_naming_it(self) -> None:
        self.assertEqual(self.main("launch"), protocol.EXIT_USAGE)
        self.assertEqual(self.err_lines()[0], "sim-lock: unknown verb 'launch'")

    def test_a_command_line_that_is_wrong_is_refused_before_the_environment_is_read(self) -> None:
        env = {protocol.STATE_ROOT_SETTING: self.root, "SIM_LOCK_POLL": "1"}
        self.assertEqual(self.main("launch", env=env), protocol.EXIT_USAGE)
        self.assertEqual(self.err_lines()[0], "sim-lock: unknown verb 'launch'")
        self.assertFalse(os.path.exists(self.root))

    def test_run_with_no_command_is_a_usage_error(self) -> None:
        for argv in (["run"], ["run", "--"]):
            with self.subTest(argv=argv):
                self.err.truncate(0)
                self.err.seek(0)
                self.assertEqual(self.main(*argv), protocol.EXIT_USAGE)
                self.assertEqual(self.err_lines()[0], "sim-lock: run needs a command")

    def test_status_takes_no_argument(self) -> None:
        self.assertEqual(self.main("status", "extra"), protocol.EXIT_USAGE)

    def test_configure_refuses_an_option_it_does_not_have_and_a_value_that_is_not_a_whole_number(self) -> None:
        self.assertEqual(self.main("configure", "--bogus"), protocol.EXIT_USAGE)
        self.assertEqual(self.main("configure", "--slots", "many"), protocol.EXIT_USAGE)
        self.assertFalse(os.path.exists(self.root))

    def test_help_prints_the_usage_on_stdout_and_exits_0(self) -> None:
        for argv in (["--help"], ["-h"], ["help"]):
            with self.subTest(argv=argv):
                self.out.truncate(0)
                self.out.seek(0)
                self.assertEqual(self.main(*argv), 0)
                self.assertEqual(self.out.getvalue(), USAGE)
        self.assertEqual(self.err.getvalue(), "")

    def test_the_usage_names_every_verb_and_every_option_of_the_configure_verb(self) -> None:
        for verb in (protocol.VERB_RUN, protocol.VERB_CONFIGURE, protocol.VERB_STATUS):
            self.assertIn(verb, USAGE)
        for key in protocol.CONFIG_KEYS:
            self.assertIn("--" + key.replace("_", "-"), USAGE)

    def test_the_usage_names_the_state_root_setting(self) -> None:
        self.assertIn(protocol.STATE_ROOT_SETTING, USAGE)

    def test_a_configuration_the_loader_refuses_exits_78_naming_the_file(self) -> None:
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            handle.write('{"slots": 0}')
        self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
        self.assertRegex(self.err_lines()[0], r"^sim-lock: .*config\.json")

    def test_a_family_with_a_nul_byte_exits_78_naming_the_file(self) -> None:
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({"family": "/tmp/a\x00b"}, handle)
        self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
        self.assertRegex(self.err_lines()[0], r"^sim-lock: .*config\.json: family must not hold a NUL byte")

    def test_a_family_with_a_dot_dot_component_exits_78_naming_the_file_and_the_fix(self) -> None:
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({"family": "/tmp/nosuch/../lock"}, handle)
        self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
        self.assertRegex(
            self.err_lines()[0],
            r"^sim-lock: .*config\.json: family must not hold a \.\. component: spell the family without \.\.",
        )

    def test_a_family_that_is_a_link_exits_78_naming_the_file_and_the_fix(self) -> None:
        link = os.path.join(self.dir, "link")
        os.symlink(os.path.join(self.dir, "gone"), link)
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({"family": link}, handle)
        self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
        self.assertRegex(
            self.err_lines()[0],
            r"^sim-lock: .*config\.json: family must not be a symbolic link, but .* is one: "
            r"name the lock file itself, not a link to it$",
        )

    def test_configure_arguments_the_loader_refuses_exit_78_and_write_nothing(self) -> None:
        self.assertEqual(self.main("configure", "--slots", "0"), protocol.EXIT_CONFIG)
        self.assertFalse(os.path.exists(os.path.join(self.root, "config.json")))

    def test_a_shared_family_in_the_default_locks_family_at_another_max_runs_exits_78_and_runs_nothing(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")  # stands for the script's default lock
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({"family": default, "shared": True, "max_runs": 5, "slots": 3}, handle)
        mark = os.path.join(self.dir, "mark")
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
            self.assertEqual(self.main("run", "--", *self.python(LEAVE_A_MARK, "ran", mark)), protocol.EXIT_CONFIG)
        self.assertRegex(self.err_lines()[0], r"^sim-lock: .*config\.json: max_runs is 5, .*set max_runs to 3")
        self.assertFalse(os.path.exists(mark))
        self.assertFalse(os.path.exists(default + ".gate"))

    def test_the_default_lock_that_is_not_shared_exits_78_and_runs_nothing(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")  # stands for the script's default lock
        os.makedirs(self.root)
        with open(os.path.join(self.root, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({"family": default, "shared": False, "slots": 3}, handle)
        mark = os.path.join(self.dir, "mark")
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
            self.assertEqual(self.main("run", "--", *self.python(LEAVE_A_MARK, "ran", mark)), protocol.EXIT_CONFIG)
        self.assertRegex(self.err_lines()[0], r"^sim-lock: .*config\.json: shared is false, .*set shared to true")
        self.assertFalse(os.path.exists(mark))
        self.assertFalse(os.path.exists(default + ".gate"))

    def test_configure_refuses_the_default_lock_unshared_and_writes_nothing_and_accepts_it_shared(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main("configure", "--family", default, "--slots", "3"), protocol.EXIT_CONFIG)
            self.assertFalse(os.path.exists(os.path.join(self.root, "config.json")))
            self.assertEqual(self.main("configure", "--family", default, "--slots", "3", "--shared"), 0)
        self.assertRegex(self.err_lines()[0], r"^sim-lock: shared is false, .*set shared to true, or family")
        self.assertTrue(os.path.exists(os.path.join(self.root, "config.json")))

    def test_configure_refuses_the_same_and_writes_nothing_and_accepts_the_files_count(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")
        options = ("configure", "--family", default, "--shared", "--slots", "3")
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main(*options, "--max-runs", "4"), protocol.EXIT_CONFIG)
            self.assertFalse(os.path.exists(os.path.join(self.root, "config.json")))
            self.assertEqual(self.main(*options, "--max-runs", "3"), 0)
        self.assertTrue(os.path.exists(os.path.join(self.root, "config.json")))

    def test_configure_refuses_a_family_spelled_through_a_directory_that_is_not_there_and_makes_nothing(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")
        family = os.path.join(self.dir, "nosuch", "..", "pango-sim-test.flock")
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main("configure", "--family", family), protocol.EXIT_CONFIG)
        self.assertRegex(
            self.err_lines()[0], r"^sim-lock: family must not hold a \.\. component: spell the family without \.\."
        )
        self.assertEqual(os.listdir(self.dir), [], "no directory was made and no configuration written")

    def test_configure_refuses_a_link_to_a_default_lock_that_is_not_there_and_does_not_make_the_lock(self) -> None:
        default = os.path.join(self.dir, "pango-sim-test.flock")
        link = os.path.join(self.dir, "link")
        os.symlink(default, link)  # dangles: the default lock is not there
        with mock.patch.object(protocol, "DEFAULT_LOCK_FILE", default):
            self.assertEqual(self.main("configure", "--family", link), protocol.EXIT_CONFIG)
        self.assertRegex(
            self.err_lines()[0],
            r"^sim-lock: family must not be a symbolic link, but .* is one: name the lock file itself, not a link to it$",
        )
        self.assertEqual(os.listdir(self.dir), ["link"], "the lock was not made through the link, and nothing else was")

    def test_a_record_that_is_not_ours_exits_78_naming_the_file(self) -> None:
        os.makedirs(os.path.join(self.root, "state"))
        with open(os.path.join(self.root, "state", "last-decision.json"), "w", encoding="utf-8") as handle:
            handle.write("[]")
        self.assertEqual(self.main("status"), protocol.EXIT_CONFIG)
        self.assertIn("last-decision.json", self.err_lines()[0])


class EntryPointTest(unittest.TestCase):
    """The process entry, run for real: the process's own environment and streams and exit status.

    The environment is built whole, so a `SIM_LOCK_*` or a state root in the developer's shell
    cannot reach it. The real `iostat` runs, so the root's minimum idle is 0, which any reading
    meets, and a run does not wait on whatever else the machine is doing.
    """

    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.root = os.path.join(self.dir, "root")

    def client(self, *argv: str, env: Optional[Dict[str, str]] = None) -> "subprocess.CompletedProcess[str]":
        environment = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": self.dir,  # so that a default root, if one were reached, is not the account's
            "PYTHONDONTWRITEBYTECODE": "1",
            protocol.STATE_ROOT_SETTING: self.root,
        }
        environment.update(env or {})
        return subprocess.run(
            [sys.executable, "-m", "broker.dispatcher", *argv],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def test_configure_then_status_read_and_write_the_root_the_environment_names(self) -> None:
        configured = self.client("configure", "--min-idle-percent", "0")
        self.assertEqual((configured.returncode, configured.stderr), (0, ""))
        self.assertEqual(configured.stdout.splitlines()[0], f"wrote {os.path.join(self.root, 'config.json')}")
        read = self.client("status")
        self.assertEqual((read.returncode, read.stderr), (0, ""))
        self.assertEqual(
            read.stdout.splitlines(),
            [
                f"state root: {self.root}",
                f"family: {os.path.join(self.root, 'family', 'lock')}",
                "last decision: none recorded yet",
            ],
        )

    @ON_MACOS
    def test_a_run_exits_with_its_commands_status_and_the_next_status_reads_its_admission(self) -> None:
        self.assertEqual(self.client("configure", "--min-idle-percent", "0").returncode, 0)
        ran = self.client("run", "--", "/bin/sh", "-c", "exit 3")
        self.assertEqual((ran.returncode, ran.stdout, ran.stderr), (3, "", ""))
        read = self.client("status")
        self.assertRegex(
            read.stdout.splitlines()[2],
            r"^last decision: admit at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d to slot 0: the checks passed$",
        )

    def test_an_unknown_verb_exits_64_with_the_message_and_the_usage_on_stderr(self) -> None:
        got = self.client("launch")
        self.assertEqual((got.returncode, got.stdout), (protocol.EXIT_USAGE, ""))
        self.assertEqual(got.stderr, "sim-lock: unknown verb 'launch'\n" + USAGE)

    def test_a_family_other_than_the_roots_exits_79_and_runs_nothing(self) -> None:
        mark = os.path.join(self.dir, "mark")
        other = os.path.join(self.dir, "other-lock")
        got = self.client("run", "/usr/bin/touch", mark, env={protocol.FAMILY_VARIABLE: other})
        self.assertEqual(got.returncode, protocol.EXIT_FAMILY_DISAGREES)
        self.assertFalse(os.path.exists(mark))
        self.assertIn("nothing was run", got.stderr)

    def test_the_entry_reads_its_own_process_environment(self) -> None:
        got = self.client("status", env={"SIM_LOCK_POLL": "1"})
        self.assertEqual(got.returncode, 0)
        self.assertTrue(got.stderr.startswith("sim-lock: ignoring SIM_LOCK_POLL: "), got.stderr)


if __name__ == "__main__":
    unittest.main()
