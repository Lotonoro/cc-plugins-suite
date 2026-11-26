"""Tests for the open step: a state root's configuration, checked against the family a client was given.

Every test here runs with the process environment emptied, which is the plan's bar for the open
step: it reads no environment, so the dispatcher's reading of it is the only one.
"""

from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from broker import protocol
from broker.errors import ConfigError, FamilyDisagreement, FamilyError
from broker.leaf import Admitted, Applicant
from broker.settings import Config
from broker.stateroot import open_root
from broker.tests.support import FakeClock, FakeMachine, hold_in_another_process, scratch_dir

CORES = 12
APPLICANT = Applicant(pid=1, cwd="/tmp", command=("true",))


class RootCase(unittest.TestCase):
    def setUp(self) -> None:
        patch = mock.patch.dict(os.environ, {}, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.dir = scratch_dir(self)
        self.root = os.path.join(self.dir, "root")

    def configure(self, **settings: object) -> None:
        os.makedirs(self.root, exist_ok=True)
        with open(os.path.join(self.root, protocol.CONFIG_FILE), "w", encoding="utf-8") as handle:
            json.dump(settings, handle)

    def full_configuration(self, **overrides: object) -> None:
        base = Config.defaults(self.root, CORES)
        settings = json.loads(base.to_json())
        settings.update(overrides)
        self.configure(**settings)


class EnvironmentTest(RootCase):
    def test_the_environment_is_empty_for_every_test_in_this_module(self) -> None:
        self.assertEqual(dict(os.environ), {})


class OpenTest(RootCase):
    def test_a_root_with_no_configuration_opens_on_the_defaults(self) -> None:
        got = open_root(self.root, CORES)
        self.assertFalse(got.configured)
        self.assertEqual(got.config, Config.defaults(self.root, CORES))
        self.assertEqual(got.config.family, os.path.join(self.root, "family", "lock"))

    def test_a_configured_root_uses_its_configuration(self) -> None:
        self.full_configuration(slots=2, settle_seconds=30, min_idle_percent=40)
        got = open_root(self.root, CORES)
        self.assertTrue(got.configured)
        self.assertEqual((got.config.slots, got.config.settle_seconds, got.config.min_idle_percent), (2, 30, 40))

    def test_the_configuration_file_and_the_state_directory_sit_in_the_root(self) -> None:
        got = open_root(self.root, CORES)
        self.assertEqual(got.config_path, os.path.join(self.root, "config.json"))
        self.assertEqual(got.state_dir, os.path.join(self.root, "state"))
        self.assertEqual(got.decisions().state_dir, got.state_dir)

    def test_the_leaf_decides_with_the_configured_settings_and_the_window(self) -> None:
        self.full_configuration(shared=True, max_runs=3, slots=2, settle_seconds=45, min_idle_percent=60)
        rules = open_root(self.root, CORES).leaf(FakeMachine(), FakeClock()).rules
        self.assertEqual((rules.slots, rules.window, rules.settle_seconds, rules.min_idle_percent), (2, 3, 45, 60))

    def test_the_family_is_built_with_the_slots_and_the_window_of_the_configuration(self) -> None:
        self.full_configuration(shared=True, max_runs=3, slots=2)
        family = open_root(self.root, CORES).family()
        self.assertEqual((family.lock_path, family.slots, family.window), (os.path.join(self.root, "family", "lock"), 2, 3))

    def test_a_broker_owned_family_gets_its_directory_made_and_a_shared_one_does_not(self) -> None:
        own = open_root(self.root, CORES).family()
        with own.gate():
            self.assertTrue(os.path.isdir(os.path.join(self.root, "family")))
        other = os.path.join(self.dir, "elsewhere")
        self.full_configuration(shared=True, max_runs=3, family=os.path.join(other, "lock"))
        shared = open_root(self.root, CORES).family()
        with self.assertRaises(FamilyError):
            with shared.gate():
                pass
        self.assertFalse(os.path.exists(other))

    def test_a_configuration_that_cannot_be_read_names_the_file(self) -> None:
        os.makedirs(os.path.join(self.root, "config.json"))
        with self.assertRaisesRegex(ConfigError, "config.json"):
            open_root(self.root, CORES)


class RefusalTest(RootCase):
    """The open step refuses what the loader refuses, naming the configuration file."""

    def test_a_shared_family_with_a_slot_count_above_its_max_runs(self) -> None:
        self.full_configuration(shared=True, max_runs=3, slots=4)
        with self.assertRaisesRegex(ConfigError, "config.json"):
            open_root(self.root, CORES)

    def test_a_settle_time_of_more_than_seven_digits(self) -> None:
        self.full_configuration(settle_seconds=10_000_000)
        with self.assertRaisesRegex(ConfigError, "config.json"):
            open_root(self.root, CORES)

    def test_a_minimum_idle_of_more_than_three_digits(self) -> None:
        self.full_configuration(min_idle_percent=1000)
        with self.assertRaisesRegex(ConfigError, "config.json"):
            open_root(self.root, CORES)

    def test_the_limits_themselves_are_accepted(self) -> None:
        self.full_configuration(settle_seconds=9_999_999, min_idle_percent=999)
        self.assertEqual(open_root(self.root, CORES).config.settle_seconds, 9_999_999)


class DefaultLockFamilyTest(RootCase):
    """A root in the script's default lock family opens shared, at a MAX_RUNS of 3, and no other way.

    The default lock stands in as a file of the scratch directory: no test here names the real one.
    """

    def setUp(self) -> None:
        super().setUp()
        self.default = os.path.join(self.dir, "pango-sim-test.flock")
        patch = mock.patch.object(protocol, "DEFAULT_LOCK_FILE", self.default)
        patch.start()
        self.addCleanup(patch.stop)

    def test_another_max_runs_is_refused_naming_the_file_and_the_setting_and_touching_no_slot(self) -> None:
        self.full_configuration(family=self.default + ".1", shared=True, max_runs=4, slots=3)
        with self.assertRaisesRegex(ConfigError, r"config\.json: max_runs is 4") as caught:
            open_root(self.root, CORES)
        self.assertEqual(caught.exception.exit_code, protocol.EXIT_CONFIG)
        self.assertEqual(os.listdir(self.dir), ["root"], "nothing of the family was created")

    def test_an_unshared_family_is_refused_naming_the_file_the_setting_and_the_fix_and_touching_no_slot(self) -> None:
        self.full_configuration(family=self.default, shared=False)
        with self.assertRaisesRegex(ConfigError, r"config\.json: shared is false") as caught:
            open_root(self.root, CORES)
        self.assertEqual(caught.exception.exit_code, protocol.EXIT_CONFIG)
        self.assertIn("set shared to true, or family to another lock file", str(caught.exception))
        self.assertEqual(os.listdir(self.dir), ["root"], "nothing of the family was created")

    def test_a_max_runs_of_3_opens_and_the_window_is_3(self) -> None:
        self.full_configuration(family=self.default, shared=True, max_runs=3, slots=2)
        got = open_root(self.root, CORES)
        self.assertEqual((got.config.family, got.config.slots, got.config.window), (self.default, 2, 3))

    def test_the_brokers_own_family_and_any_other_lock_file_take_any_count_shared_or_not(self) -> None:
        self.full_configuration(shared=True, max_runs=5, slots=5)
        self.assertEqual(open_root(self.root, CORES).config.window, 5)
        scratch = os.path.join(self.dir, "scratch.flock")
        self.full_configuration(family=scratch, shared=True, max_runs=2, slots=2)
        self.assertEqual(open_root(self.root, CORES).config.window, 2)
        self.full_configuration(family=scratch, shared=False, slots=4)
        self.assertEqual(open_root(self.root, CORES).config.window, 4)


class GivenFamilyTest(RootCase):
    def test_no_given_family_is_no_check(self) -> None:
        self.assertFalse(open_root(self.root, CORES).configured)

    def test_a_given_family_equal_to_the_roots_is_accepted(self) -> None:
        family = os.path.join(self.root, "family", "lock")
        self.assertEqual(open_root(self.root, CORES, given_family=family).config.family, family)

    def test_the_same_family_by_another_path_is_accepted(self) -> None:
        os.makedirs(os.path.join(self.root, "family"))
        link = os.path.join(self.dir, "link")
        os.symlink(os.path.join(self.root, "family"), link)
        self.assertIsNotNone(open_root(self.root, CORES, given_family=os.path.join(link, "lock")))

    def test_a_given_family_other_than_the_roots_reports_both_and_runs_nothing(self) -> None:
        given = os.path.join(self.dir, "pango-sim-test.flock")
        with self.assertRaises(FamilyDisagreement) as caught:
            open_root(self.root, CORES, given_family=given)
        message = str(caught.exception)
        self.assertIn(given, message)
        self.assertIn(os.path.join(self.root, "family", "lock"), message)
        self.assertIn("nothing was run", message)
        self.assertEqual(caught.exception.exit_code, protocol.EXIT_FAMILY_DISAGREES)

    def test_the_report_names_the_configuration_file_when_there_is_one(self) -> None:
        self.full_configuration(family=os.path.join(self.dir, "mine", "lock"))
        with self.assertRaises(FamilyDisagreement) as caught:
            open_root(self.root, CORES, given_family=os.path.join(self.dir, "theirs"))
        self.assertIn(os.path.join(self.root, "config.json"), str(caught.exception))

    def test_the_report_names_the_state_root_when_there_is_no_configuration(self) -> None:
        with self.assertRaises(FamilyDisagreement) as caught:
            open_root(self.root, CORES, given_family=os.path.join(self.dir, "theirs"))
        self.assertIn(f"the state root {self.root}", str(caught.exception))


class NoticeTest(RootCase):
    def test_a_root_with_no_configuration_says_so_and_names_its_family(self) -> None:
        got = open_root(self.root, CORES)
        self.assertEqual(
            got.notice(),
            f"sim-lock: no configuration at {self.root}/config.json; the broker's own defaults "
            f"apply, with the family {self.root}/family/lock",
        )

    def test_a_configured_root_has_no_notice(self) -> None:
        self.full_configuration()
        self.assertIsNone(open_root(self.root, CORES).notice())


class IsolationTest(RootCase):
    def test_two_roots_with_different_families_never_see_each_others_runs(self) -> None:
        first = open_root(os.path.join(self.dir, "first"), CORES)
        second = open_root(os.path.join(self.dir, "second"), CORES)
        self.assertNotEqual(first.config.family, second.config.family)
        # Every slot of the first root's family is held, each with an owner record.
        for slot in range(first.config.slots):
            path = first.config.family if slot == 0 else f"{first.config.family}.{slot}"
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + ".owner", "w", encoding="utf-8") as handle:
                handle.write(f"pid=1 slot={slot} cwd=/ started=t command=first-root-run\n")
            hold_in_another_process(self, path)
        full = first.leaf(FakeMachine(), FakeClock())
        self.assertEqual(full.attempt(APPLICANT).reason, "all 3 run slots are held")  # type: ignore[union-attr]
        # The second root sees none of them: it lists no holder and admits a run to its slot 0.
        self.assertEqual(second.family().list_holders(), [])
        free = second.leaf(FakeMachine(), FakeClock())
        got = free.attempt(APPLICANT)
        self.assertIsInstance(got, Admitted)
        os.close(got.fd)  # type: ignore[union-attr]
        self.assertEqual(len(first.family().list_holders()), 3)

    def test_each_root_keeps_its_own_last_decision(self) -> None:
        first = open_root(os.path.join(self.dir, "first"), CORES)
        second = open_root(os.path.join(self.dir, "second"), CORES)
        got = first.leaf(FakeMachine(), FakeClock()).attempt(APPLICANT)
        os.close(got.fd)  # type: ignore[union-attr]
        self.assertIsNotNone(first.decisions().read())
        self.assertIsNone(second.decisions().read())


if __name__ == "__main__":
    unittest.main()
