"""Tests for the configure verb: it writes a whole configuration, reads none, and verifies what it wrote.

The verify step reads the file back through the loader and, under the gate, opens each of the
family's lock files and tries it without blocking, as `list_holders()` reads the slots. The tests
run with no environment and on real files in a scratch root, with other runs as real processes.
"""

from __future__ import annotations

import dataclasses
import io
import json
import os
import threading
import unittest
from typing import Dict, List
from unittest import mock

from broker import protocol
from broker.configure import Settings, configure
from broker.errors import ConfigError, FamilyError, StateError
from broker.settings import Config, LoadedConfig, load_config
from broker.stateroot import open_root
from broker.tests.support import hold_in_another_process, scratch_dir

CORES = 12


class ConfigureCase(unittest.TestCase):
    def setUp(self) -> None:
        patch = mock.patch.dict(os.environ, {}, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.dir = scratch_dir(self)
        self.root = os.path.join(self.dir, "root")
        self.config_path = os.path.join(self.root, "config.json")
        self.out = io.StringIO()

    def run_configure(self, settings: Settings = Settings(), cores: int = CORES) -> Config:
        return configure(self.root, settings, cores, self.out)

    def written(self) -> Dict[str, object]:
        with open(self.config_path, encoding="utf-8") as handle:
            return json.load(handle)

    def lines(self) -> List[str]:
        return self.out.getvalue().splitlines()


class SettingsTest(unittest.TestCase):
    def test_the_arguments_are_the_configurations_settings_in_the_files_order(self) -> None:
        self.assertEqual(tuple(field.name for field in dataclasses.fields(Settings)), protocol.CONFIG_KEYS)

    def test_only_the_arguments_that_were_given_are_passed_on(self) -> None:
        self.assertEqual(Settings().given(), {})
        self.assertEqual(Settings(shared=False, slots=2).given(), {"shared": False, "slots": 2})


class WritesTest(ConfigureCase):
    def test_with_no_arguments_it_writes_a_complete_configuration_of_the_defaults(self) -> None:
        self.run_configure()
        data = self.written()
        self.assertEqual(sorted(data), sorted(protocol.CONFIG_KEYS))
        self.assertEqual(
            data,
            {
                "family": os.path.join(self.root, "family", "lock"),
                "shared": False,
                "max_runs": 3,
                "slots": 3,
                "settle_seconds": 90,
                "min_idle_percent": 50,
            },
        )

    def test_the_arguments_override_the_defaults_and_the_rest_stay_default(self) -> None:
        self.run_configure(Settings(slots=2, settle_seconds=30))
        data = self.written()
        self.assertEqual((data["slots"], data["settle_seconds"], data["min_idle_percent"]), (2, 30, 50))

    def test_it_returns_the_configuration_it_wrote(self) -> None:
        got = self.run_configure(Settings(min_idle_percent=40))
        self.assertEqual(got.min_idle_percent, 40)
        self.assertEqual(got, Config.from_mapping(self.written(), self.root, CORES))

    def test_the_root_is_made_when_it_does_not_exist(self) -> None:
        self.assertFalse(os.path.exists(self.root))
        self.run_configure()
        self.assertTrue(os.path.isfile(self.config_path))

    def test_no_temporary_file_is_left_beside_the_configuration(self) -> None:
        self.run_configure()
        self.run_configure(Settings(slots=2))
        self.assertEqual(sorted(os.listdir(self.root)), ["config.json", "family"])

    def test_a_fake_24_core_machine_gets_6_slots_unshared_and_3_shared_and_an_8_core_gets_3_on_either(self) -> None:
        self.assertEqual(self.run_configure(cores=24).slots, 6)
        self.assertEqual(self.run_configure(Settings(shared=True, max_runs=3), cores=24).slots, 3)
        self.assertEqual(self.run_configure(cores=8).slots, 3)
        self.assertEqual(self.run_configure(Settings(shared=True, max_runs=3), cores=8).slots, 3)


class ReadsNothingTest(ConfigureCase):
    def seed(self, text: str) -> None:
        os.makedirs(self.root, exist_ok=True)
        with open(self.config_path, "w", encoding="utf-8") as handle:
            handle.write(text)

    def test_a_configuration_that_is_not_json_is_written_over(self) -> None:
        self.seed("this is not json")
        with self.assertRaises(ConfigError):  # the loader refuses it, and configure does not ask
            load_config(self.root, CORES)
        self.run_configure()
        self.assertEqual(self.written()["slots"], 3)

    def test_a_configuration_with_values_the_loader_refuses_is_written_over(self) -> None:
        self.seed(json.dumps({"slots": 0, "shared": True, "max_runs": 3}))
        self.run_configure(Settings(slots=2))
        self.assertEqual(self.written()["slots"], 2)

    def test_a_configuration_that_cannot_be_read_is_written_over(self) -> None:
        self.seed("{}")
        os.chmod(self.config_path, 0o000)
        self.addCleanup(os.chmod, self.config_path, 0o600)
        self.run_configure(Settings(slots=2))
        self.assertEqual(self.written()["slots"], 2)

    def test_invalid_arguments_are_refused_and_the_existing_configuration_is_untouched(self) -> None:
        self.seed(json.dumps({"slots": 2}))
        before = self.written()
        for settings in (
            Settings(slots=0),
            Settings(shared=True, max_runs=3, slots=4),
            Settings(settle_seconds=10_000_000),
            Settings(min_idle_percent=1000),
        ):
            with self.subTest(settings=settings):
                with self.assertRaises(ConfigError):
                    self.run_configure(settings)
                self.assertEqual(self.written(), before)
        self.assertEqual(self.out.getvalue(), "")


class DefaultLockFamilyTest(ConfigureCase):
    """The verb refuses what the open step would: the script's default lock when it is not shared, and a
    shared family in its family when it has another MAX_RUNS; and it writes what the open step opens.

    The default lock stands in as a file of the scratch directory: no test here names the real one.
    """

    def setUp(self) -> None:
        super().setUp()
        self.default = os.path.join(self.dir, "pango-sim-test.flock")
        patch = mock.patch.object(protocol, "DEFAULT_LOCK_FILE", self.default)
        patch.start()
        self.addCleanup(patch.stop)

    def test_another_max_runs_is_refused_and_nothing_is_written_or_made(self) -> None:
        with self.assertRaisesRegex(ConfigError, "max_runs is 4"):
            self.run_configure(Settings(family=self.default + ".gate", shared=True, max_runs=4, slots=3))
        self.assertEqual(os.listdir(self.dir), [])
        self.assertEqual(self.out.getvalue(), "")

    def test_the_default_lock_that_is_not_shared_is_refused_and_nothing_is_written_or_made(self) -> None:
        another_spelling = self.dir + "//pango-sim-test.flock"
        for settings in (Settings(family=self.default), Settings(family=another_spelling, shared=False, slots=2)):
            with self.subTest(settings=settings), self.assertRaisesRegex(ConfigError, "shared is false"):
                self.run_configure(settings)
        self.assertEqual(os.listdir(self.dir), [])
        self.assertEqual(self.out.getvalue(), "")

    def test_a_family_below_a_directory_named_for_the_default_lock_is_configured_opened_and_configured_again(self) -> None:
        settings = Settings(family=os.path.join(self.default + ".d", "family", "lock"), slots=2)
        self.run_configure(settings)
        self.assertTrue(os.path.isdir(os.path.dirname(settings.family)), "configure made the directory")
        self.assertEqual(open_root(self.root, CORES).config.family, settings.family)
        self.assertEqual(self.run_configure(settings).family, settings.family)

    def test_a_family_spelled_through_a_directory_that_is_not_there_is_refused_before_the_directory_is_made(self) -> None:
        # `nosuch/..` is the default lock's own directory only once `nosuch` is made, and the verify step
        # makes it: such a family was accepted unshared, and then every open of the root refused it.
        family = os.path.join(self.dir, "nosuch", "..", "pango-sim-test.flock")
        with self.assertRaisesRegex(ConfigError, r"family must not hold a \.\. component") as caught:
            self.run_configure(Settings(family=family))
        self.assertIn("spell the family without ..", str(caught.exception))
        self.assertEqual(os.listdir(self.dir), [], "no directory was made and no configuration written")
        self.assertEqual(self.out.getvalue(), "")

    def test_a_link_to_a_default_lock_that_is_not_there_is_refused_before_opening_the_family_makes_the_lock(self) -> None:
        # The link dangles, so the checks against the default lock find no file to match; opening the family
        # makes the lock through the link, and every open of the root after that refused the family.
        link = os.path.join(self.dir, "link")
        os.symlink(self.default, link)
        for settings in (Settings(family=link), Settings(family=link, shared=True, max_runs=5, slots=3)):
            with self.subTest(settings=settings):
                with self.assertRaisesRegex(ConfigError, "name the lock file itself, not a link to it"):
                    self.run_configure(settings)
        self.assertEqual(os.listdir(self.dir), ["link"], "the lock was not made through the link, and nothing else was")
        self.assertEqual(self.out.getvalue(), "")

    def test_the_default_locks_own_count_is_written_and_the_family_tried(self) -> None:
        got = self.run_configure(Settings(family=self.default, shared=True, max_runs=3, slots=3))
        self.assertEqual((got.family, got.max_runs), (self.default, 3))
        self.assertEqual(self.written()["family"], self.default)
        self.assertIn(f"family: {self.default}", self.lines())
        self.assertIn(f"  {self.default}.gate: opened", self.lines())


class VerifiesTest(ConfigureCase):
    def test_the_configuration_is_read_back_through_the_loader(self) -> None:
        # The file written has 3 slots; a loader that reads back 2 shows the verify step compares.
        other = LoadedConfig(Config.from_mapping({"slots": 2}, self.root, CORES), configured=True)
        loader = mock.Mock(return_value=other)
        with mock.patch("broker.configure.load_config", loader):
            with self.assertRaisesRegex(StateError, "read back"):
                self.run_configure()
        loader.assert_called_once_with(self.root, CORES)

    def test_it_prints_the_family_the_slot_count_and_the_settings(self) -> None:
        self.run_configure(Settings(slots=2, settle_seconds=30, min_idle_percent=40))
        family = os.path.join(self.root, "family", "lock")
        self.assertEqual(
            self.lines()[:7],
            [
                f"wrote {self.config_path}",
                f"family: {family}",
                "shared with sim-lock.sh: no",
                "slots: 2",
                "max runs: 3",
                "settle seconds: 30",
                "minimum idle percent: 40",
            ],
        )

    def test_it_says_yes_for_a_shared_family(self) -> None:
        family = os.path.join(self.dir, "shared", "lock")
        os.makedirs(os.path.dirname(family))  # a shared family's directory is the script's, not made here
        self.run_configure(Settings(shared=True, max_runs=3, family=family))
        self.assertIn("shared with sim-lock.sh: yes", self.lines())

    def test_it_opens_and_tries_every_lock_file_of_the_window_and_the_gate(self) -> None:
        self.run_configure()
        family = os.path.join(self.root, "family", "lock")
        self.assertEqual(
            self.lines()[7:],
            [
                "lock files, each opened and tried without blocking:",
                f"  {family}.gate: opened",
                f"  {family}: free",
                f"  {family}.1: free",
                f"  {family}.2: free",
            ],
        )

    def test_a_slot_another_run_holds_is_reported_held_and_is_not_waited_for(self) -> None:
        family = os.path.join(self.root, "family", "lock")
        os.makedirs(os.path.dirname(family))
        for slot in range(3):
            hold_in_another_process(self, family if slot == 0 else f"{family}.{slot}")
        done = threading.Event()
        thread = threading.Thread(target=lambda: (self.run_configure(), done.set()), daemon=True)
        thread.start()
        self.assertTrue(done.wait(10), "the verify step blocked on a slot another run holds")
        self.assertEqual(sum(line.endswith(": held") for line in self.lines()), 3)

    def test_the_window_of_a_shared_family_is_tried_not_only_the_brokers_slots(self) -> None:
        family = os.path.join(self.dir, "shared", "lock")
        os.makedirs(os.path.dirname(family))
        self.run_configure(Settings(shared=True, max_runs=3, slots=2, family=family))
        tried = [line for line in self.lines() if line.startswith("  ") and "gate" not in line]
        self.assertEqual(len(tried), 3)

    def test_a_family_whose_lock_files_cannot_be_opened_fails_naming_the_file(self) -> None:
        family = os.path.join(self.dir, "shared", "lock")
        os.makedirs(os.path.dirname(family))
        os.makedirs(family + ".1")  # a directory where a slot's lock file goes
        with self.assertRaisesRegex(FamilyError, r"lock\.1"):
            self.run_configure(Settings(shared=True, max_runs=3, family=family))

    def test_a_shared_family_in_a_directory_that_does_not_exist_fails_and_the_directory_is_not_made(self) -> None:
        family = os.path.join(self.dir, "absent", "lock")
        with self.assertRaisesRegex(FamilyError, r"absent/lock\.gate"):
            self.run_configure(Settings(shared=True, max_runs=3, family=family))
        self.assertFalse(os.path.exists(os.path.dirname(family)))

    def test_a_family_in_a_place_that_cannot_hold_files_fails_the_verify_step(self) -> None:
        in_the_way = os.path.join(self.dir, "a-file")
        with open(in_the_way, "w", encoding="utf-8") as handle:
            handle.write("not a directory")
        for shared in (False, True):
            with self.subTest(shared=shared):
                settings = Settings(shared=shared, max_runs=3, family=os.path.join(in_the_way, "lock"))
                with self.assertRaises(FamilyError):
                    self.run_configure(settings)

    def test_the_configuration_is_written_before_the_family_is_checked(self) -> None:
        in_the_way = os.path.join(self.dir, "a-file")
        with open(in_the_way, "w", encoding="utf-8") as handle:
            handle.write("not a directory")
        with self.assertRaises(FamilyError):
            self.run_configure(Settings(family=os.path.join(in_the_way, "lock")))
        self.assertEqual(self.written()["family"], os.path.join(in_the_way, "lock"))

    def test_a_configuration_that_cannot_be_written_is_a_state_error_naming_the_file(self) -> None:
        with open(self.root, "w", encoding="utf-8") as handle:  # a file where the root goes
            handle.write("in the way")
        with self.assertRaises(StateError):
            self.run_configure()


if __name__ == "__main__":
    unittest.main()
