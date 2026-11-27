"""Tests for the configuration loader: defaults, validation where it is loaded, and the file."""

from __future__ import annotations

import json
import os
import stat
import unittest
from dataclasses import replace
from typing import Any, Dict
from unittest import mock

from broker import protocol
from broker.errors import ConfigError
from broker.settings import Config, default_family, default_slots, load_config
from broker.tests.support import be_there, in_other_letters, scratch_dir

ROOT = "/state/root"


def base(**overrides: Any) -> Config:
    return replace(Config.defaults(ROOT, cores=12), **overrides)


def parse(data: Dict[str, Any], cores: int = 12) -> Config:
    return Config.from_mapping(data, ROOT, cores)


class DefaultSlotsTest(unittest.TestCase):
    def test_a_24_core_machine_gets_6_slots_on_an_unshared_family(self) -> None:
        self.assertEqual(default_slots(cores=24, shared=False, max_runs=3), 6)

    def test_a_24_core_machine_gets_3_on_a_family_shared_at_max_runs_3(self) -> None:
        self.assertEqual(default_slots(cores=24, shared=True, max_runs=3), 3)

    def test_an_8_core_machine_gets_3_either_way(self) -> None:
        self.assertEqual(default_slots(cores=8, shared=False, max_runs=3), 3)
        self.assertEqual(default_slots(cores=8, shared=True, max_runs=3), 3)

    def test_the_12_core_machine_this_was_written_on_gets_3(self) -> None:
        self.assertEqual(default_slots(cores=12, shared=False, max_runs=3), 3)

    def test_cores_divide_by_four_and_round_down(self) -> None:
        self.assertEqual(default_slots(cores=19, shared=False, max_runs=3), 4)

    def test_a_shared_family_is_capped_at_its_max_runs(self) -> None:
        self.assertEqual(default_slots(cores=24, shared=True, max_runs=5), 5)
        self.assertEqual(default_slots(cores=48, shared=True, max_runs=8), 8)

    def test_a_shared_family_with_a_max_runs_below_3_caps_below_3(self) -> None:
        self.assertEqual(default_slots(cores=24, shared=True, max_runs=2), 2)


class DefaultsTest(unittest.TestCase):
    def test_the_defaults_are_the_scripts_with_the_brokers_own_family(self) -> None:
        got = Config.defaults(ROOT, cores=12)
        self.assertEqual(got.family, "/state/root/family/lock")
        self.assertEqual(
            (got.shared, got.max_runs, got.slots, got.settle_seconds, got.min_idle_percent),
            (False, 3, 3, 90, 50),
        )

    def test_the_default_family_is_inside_the_root(self) -> None:
        self.assertEqual(default_family("/a/b"), "/a/b/family/lock")

    def test_the_defaults_of_a_shared_family_cap_the_slots_at_its_max_runs(self) -> None:
        got = Config.defaults(ROOT, cores=24, shared=True, max_runs=5)
        self.assertEqual((got.shared, got.max_runs, got.slots), (True, 5, 5))

    def test_a_configuration_cannot_be_built_without_saying_every_setting(self) -> None:
        with self.assertRaises(TypeError):
            Config(family="/a/lock", slots=3)  # type: ignore[call-arg]

    def test_a_mapping_takes_every_default_from_the_defaults_and_writes_none_of_its_own(self) -> None:
        marker = Config(
            family="/marker/lock", slots=4, shared=False, max_runs=7, settle_seconds=11, min_idle_percent=13
        )
        with mock.patch.object(Config, "defaults", return_value=marker):
            self.assertEqual(parse({}), marker)

    def test_the_window_of_an_unshared_family_is_its_slot_count(self) -> None:
        self.assertEqual(base(slots=6).window, 6)

    def test_the_window_of_a_shared_family_is_the_scripts_max_runs(self) -> None:
        self.assertEqual(base(shared=True, max_runs=3, slots=2).window, 3)


class FromMappingTest(unittest.TestCase):
    def test_an_empty_object_is_the_defaults(self) -> None:
        self.assertEqual(parse({}), Config.defaults(ROOT, 12))

    def test_a_complete_object_is_read_whole(self) -> None:
        got = parse(
            {
                "family": "/tmp/a-shared-family/lock",
                "shared": True,
                "max_runs": 3,
                "slots": 3,
                "settle_seconds": 30,
                "min_idle_percent": 0,
            }
        )
        self.assertEqual(
            got,
            Config(
                family="/tmp/a-shared-family/lock",
                slots=3,
                shared=True,
                max_runs=3,
                settle_seconds=30,
                min_idle_percent=0,
            ),
        )

    def test_a_missing_slot_count_is_the_default_for_the_machine(self) -> None:
        self.assertEqual(parse({}, cores=24).slots, 6)
        self.assertEqual(parse({"shared": True}, cores=24).slots, 3)
        self.assertEqual(parse({"shared": True, "max_runs": 5}, cores=24).slots, 5)

    def test_a_named_slot_count_beats_the_default(self) -> None:
        self.assertEqual(parse({"slots": 2}, cores=24).slots, 2)

    def test_an_object_is_required(self) -> None:
        for data in ([], "x", 3, None):
            with self.subTest(data=data), self.assertRaisesRegex(ConfigError, "JSON object"):
                Config.from_mapping(data, ROOT, 12)

    def test_an_unknown_setting_is_refused_by_name(self) -> None:
        with self.assertRaisesRegex(ConfigError, "slotz"):
            parse({"slotz": 4})

    def test_a_whole_number_setting_refuses_text_floats_and_booleans(self) -> None:
        for key in ("max_runs", "slots", "settle_seconds", "min_idle_percent"):
            for value in ("3", 3.0, True, None, [3]):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ConfigError, key):
                    parse({key: value})

    def test_shared_must_be_a_boolean(self) -> None:
        for value in ("yes", 1, None):
            with self.subTest(value=value), self.assertRaisesRegex(ConfigError, "shared"):
                parse({"shared": value})

    def test_the_family_must_be_an_absolute_path(self) -> None:
        for value in ("", "lock", "./lock", 5, None):
            with self.subTest(value=value), self.assertRaisesRegex(ConfigError, "family"):
                parse({"family": value})

    def test_the_family_may_not_hold_a_nul_byte_which_no_file_system_call_takes(self) -> None:
        for shared in (False, True):
            with self.subTest(shared=shared), self.assertRaisesRegex(ConfigError, "family must not hold a NUL byte"):
                parse({"family": "/tmp/a\x00b", "shared": shared})

    def test_the_family_may_not_hold_a_dot_dot_component_and_the_refusal_names_the_fix(self) -> None:
        for family in ("/tmp/nosuch/../lock", "/tmp/a/b/../../lock", "/tmp//../lock", "/tmp/lock/.."):
            for shared in (False, True):
                with self.subTest(family=family, shared=shared):
                    with self.assertRaisesRegex(ConfigError, r"family must not hold a \.\. component") as caught:
                        parse({"family": family, "shared": shared})
                    self.assertIn("spell the family without ..", str(caught.exception))
                    self.assertIn(repr(family), str(caught.exception))

    def test_a_name_that_holds_dots_and_is_no_dot_dot_component_is_a_family(self) -> None:
        for family in ("/tmp/..lock", "/tmp/lock..", "/tmp/a..b/lock", "/tmp/.../lock", "/tmp/.d/lock", "/tmp/./lock"):
            with self.subTest(family=family):
                self.assertEqual(parse({"family": family}).family, family)


class LinkedFamilyTest(unittest.TestCase):
    """A family that is itself a symbolic link is refused, whether it leads to a file or dangles.

    A link that dangles is no file for the checks against the default lock to match, and opening the
    family creates what it points to. A directory in the path may be a link, as `/tmp` is on a Mac.
    """

    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.file = os.path.join(self.dir, "file")
        with open(self.file, "w", encoding="utf-8"):
            pass
        self.live = os.path.join(self.dir, "live")
        os.symlink(self.file, self.live)
        self.dangling = os.path.join(self.dir, "dangling")
        os.symlink(os.path.join(self.dir, "gone"), self.dangling)
        self.directory = os.path.join(self.dir, "directory")
        os.symlink(self.dir, self.directory)

    def test_a_family_that_is_a_link_is_refused_leading_to_a_file_or_not_and_the_refusal_names_the_fix(self) -> None:
        for link in (self.live, self.dangling):
            for shared in (False, True):
                with self.subTest(link=link, shared=shared):
                    with self.assertRaisesRegex(ConfigError, "family must not be a symbolic link") as caught:
                        parse({"family": link, "shared": shared})
                    self.assertIn("name the lock file itself, not a link to it", str(caught.exception))
                    self.assertIn(repr(link), str(caught.exception))

    def test_a_family_below_a_linked_directory_a_file_that_is_there_and_a_name_that_is_not_are_families(self) -> None:
        for family in (os.path.join(self.directory, "lock"), self.file, os.path.join(self.dir, "not-there")):
            for shared in (False, True):
                with self.subTest(family=family, shared=shared):
                    self.assertEqual(parse({"family": family, "shared": shared}).family, family)


class LimitsTest(unittest.TestCase):
    def test_the_slot_count_is_a_positive_whole_number(self) -> None:
        for value in (0, -1):
            with self.subTest(value=value), self.assertRaisesRegex(ConfigError, "slots"):
                parse({"slots": value})

    def test_a_shared_family_refuses_more_slots_than_its_max_runs(self) -> None:
        with self.assertRaisesRegex(ConfigError, "slots.*4.*MAX_RUNS 3"):
            parse({"shared": True, "max_runs": 3, "slots": 4})

    def test_a_shared_family_accepts_slots_up_to_its_max_runs(self) -> None:
        self.assertEqual(parse({"shared": True, "max_runs": 3, "slots": 3}).slots, 3)
        self.assertEqual(parse({"shared": True, "max_runs": 5, "slots": 4}).slots, 4)

    def test_an_unshared_family_accepts_more_slots_than_max_runs(self) -> None:
        self.assertEqual(parse({"slots": 8, "max_runs": 3}).slots, 8)

    def test_the_scripts_max_runs_is_a_positive_whole_number(self) -> None:
        with self.assertRaisesRegex(ConfigError, "max_runs"):
            parse({"max_runs": 0})

    def test_a_settle_time_of_at_most_7_digits(self) -> None:
        self.assertEqual(parse({"settle_seconds": 9_999_999}).settle_seconds, 9_999_999)
        self.assertEqual(parse({"settle_seconds": 0}).settle_seconds, 0)
        for value in (10_000_000, -1):
            with self.subTest(value=value), self.assertRaisesRegex(ConfigError, "settle_seconds"):
                parse({"settle_seconds": value})

    def test_a_minimum_idle_of_at_most_3_digits(self) -> None:
        self.assertEqual(parse({"min_idle_percent": 999}).min_idle_percent, 999)
        self.assertEqual(parse({"min_idle_percent": 0}).min_idle_percent, 0)
        for value in (1000, -1):
            with self.subTest(value=value), self.assertRaisesRegex(ConfigError, "min_idle_percent"):
                parse({"min_idle_percent": value})


class DefaultLockFamilyTest(unittest.TestCase):
    """The script's callers use the files of its default lock's family, and use the lock at one count, 3.
    A family of the broker that collides with that family must be shared, and a shared one must keep
    the count; a family anywhere else takes any count.

    The default lock stands in as a file of a scratch directory: no test here names the real one.
    """

    FAMILY_FILES = ("", ".1", ".gate", ".last-start", ".owner", ".1.owner")

    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.default = os.path.join(self.dir, "pango-sim-test.flock")
        patch = mock.patch.object(protocol, "DEFAULT_LOCK_FILE", self.default)
        patch.start()
        self.addCleanup(patch.stop)

    def shared(self, family: str, max_runs: int, slots: int = 1) -> Config:
        return parse({"family": family, "shared": True, "max_runs": max_runs, "slots": slots})

    def test_the_default_lock_and_each_file_of_its_family_is_refused_when_shared_at_any_max_runs_but_3(self) -> None:
        for suffix in self.FAMILY_FILES:
            for max_runs in (1, 2, 4, 5):
                with self.subTest(suffix=suffix, max_runs=max_runs), self.assertRaises(ConfigError):
                    self.shared(self.default + suffix, max_runs)

    def test_the_refusal_of_a_shared_family_names_the_setting_the_family_and_the_fix(self) -> None:
        with self.assertRaises(ConfigError) as caught:
            self.shared(self.default, 5)
        message = str(caught.exception)
        self.assertIn("max_runs is 5", message)
        self.assertIn(self.default, message)
        self.assertIn("set max_runs to 3, or family to another lock file", message)

    def test_a_max_runs_of_3_is_accepted_on_the_default_lock_and_each_file_of_its_family(self) -> None:
        for suffix in self.FAMILY_FILES:
            with self.subTest(suffix=suffix):
                self.assertEqual(self.shared(self.default + suffix, 3, slots=3).max_runs, 3)

    def test_another_spelling_of_the_directory_is_refused_too_whether_the_lock_is_there_or_not(self) -> None:
        os.symlink(self.dir, os.path.join(self.dir, "linked"))
        for there in (False, True):
            be_there(self.default, there)
            for spelling in (
                self.dir + "//pango-sim-test.flock",
                self.dir + "/./pango-sim-test.flock.1",
                os.path.join(self.dir, "linked", "pango-sim-test.flock"),
                os.path.join(self.dir, "linked", "pango-sim-test.flock.gate"),
            ):
                with self.subTest(there=there, spelling=spelling):
                    with self.assertRaises(ConfigError):
                        self.shared(spelling, 4)
                    with self.assertRaises(ConfigError):
                        parse({"family": spelling})

    def test_the_default_lock_in_other_letters_is_in_its_family_whether_the_lock_is_there_or_not(self) -> None:
        for there in (False, True):
            be_there(self.default, there)
            for spelling in in_other_letters(self.default):
                with self.subTest(there=there, spelling=spelling):
                    for data in ({}, {"max_runs": 5}):
                        with self.assertRaisesRegex(ConfigError, "shared is false"):
                            parse({"family": spelling, **data})
                    with self.assertRaisesRegex(ConfigError, "max_runs is 5"):
                        self.shared(spelling, 5)
                    self.assertEqual(self.shared(spelling, 3, slots=3).max_runs, 3)

    def test_the_same_file_under_another_name_is_in_its_family_while_the_lock_is_there(self) -> None:
        hard = os.path.join(self.dir, "elsewhere", "hard.flock")
        os.makedirs(os.path.dirname(hard))
        be_there(self.default, True)
        os.link(self.default, hard)
        with self.assertRaisesRegex(ConfigError, "shared is false"):
            parse({"family": hard})
        with self.assertRaisesRegex(ConfigError, "max_runs is 5"):
            self.shared(hard, 5)
        self.assertEqual(self.shared(hard, 3, slots=3).max_runs, 3)

    def test_a_longer_name_beside_the_default_lock_is_in_its_family_as_well(self) -> None:
        longer = self.default + "-mine"
        with self.assertRaisesRegex(ConfigError, "shared is false"):
            parse({"family": longer})
        with self.assertRaisesRegex(ConfigError, "max_runs is 5"):
            self.shared(longer, 5)
        self.assertEqual(self.shared(longer, 3, slots=3).max_runs, 3)

    def test_a_family_below_a_directory_named_for_the_default_lock_takes_any_count_whether_or_not_it_is_there(
        self,
    ) -> None:
        for below in (os.path.join(self.default + ".d", "lock"), os.path.join(self.default + ".d", "family", "lock")):
            for directory_is_there in (False, True):
                if directory_is_there:
                    os.makedirs(os.path.dirname(below), exist_ok=True)
                for there in (False, True):
                    be_there(self.default, there)
                    with self.subTest(below=below, directory_is_there=directory_is_there, lock_is_there=there):
                        got = parse({"family": below, "max_runs": 5})
                        self.assertEqual((got.shared, got.max_runs), (False, 5))
                        for max_runs in (1, 2, 4, 5):
                            self.assertEqual(self.shared(below, max_runs).max_runs, max_runs)

    def test_a_lock_file_elsewhere_takes_any_count(self) -> None:
        for family in (os.path.join(self.dir, "scratch.flock"), os.path.join(self.dir, "no", "such", "lock")):
            for max_runs in (1, 2, 4, 5):
                with self.subTest(family=family, max_runs=max_runs):
                    self.assertEqual(self.shared(family, max_runs).max_runs, max_runs)

    def test_the_default_lock_and_each_file_of_its_family_is_refused_unshared_at_any_max_runs_whether_it_is_there_or_not(
        self,
    ) -> None:
        for there in (False, True):
            for suffix in self.FAMILY_FILES:
                be_there(self.default + suffix, there)
                for data in ({"shared": False}, {"shared": False, "max_runs": 3}, {"shared": False, "max_runs": 5}, {}):
                    with self.subTest(there=there, suffix=suffix, data=data), self.assertRaises(ConfigError):
                        parse({"family": self.default + suffix, **data})

    def test_the_refusal_of_an_unshared_family_names_the_setting_the_family_and_the_fix(self) -> None:
        with self.assertRaises(ConfigError) as caught:
            parse({"family": self.default})
        message = str(caught.exception)
        self.assertIn("shared is false", message)
        self.assertIn(self.default, message)
        self.assertIn("set shared to true, or family to another lock file", message)

    def test_an_unshared_family_at_another_max_runs_is_refused_for_its_sharing_first(self) -> None:
        with self.assertRaisesRegex(ConfigError, "shared is false"):
            parse({"family": self.default, "shared": False, "max_runs": 5})

    def test_an_unshared_family_elsewhere_takes_any_count(self) -> None:
        got = parse({"family": os.path.join(self.dir, "scratch.flock"), "max_runs": 5})
        self.assertEqual((got.shared, got.max_runs), (False, 5))

    def test_a_shared_root_on_the_brokers_own_family_takes_any_count(self) -> None:
        self.assertEqual(parse({"shared": True, "max_runs": 5}).max_runs, 5)

    def test_a_link_to_the_default_lock_is_refused_as_a_link_whether_the_lock_is_there_or_not(self) -> None:
        link = os.path.join(self.dir, "link")
        os.symlink(self.default, link)  # dangles: the default lock is not there, and no check can match it
        for lock_is_there in (False, True):
            if lock_is_there:
                with open(self.default, "w", encoding="utf-8"):
                    pass
            for data in ({}, {"shared": True, "max_runs": 5, "slots": 3}):
                with self.subTest(lock_is_there=lock_is_there, data=data):
                    with self.assertRaisesRegex(ConfigError, "name the lock file itself, not a link to it"):
                        parse({"family": link, **data})


class SerializationTest(unittest.TestCase):
    def test_a_configuration_reads_back_equal(self) -> None:
        original = base(family="/tmp/x/lock", shared=True, max_runs=4, slots=2, settle_seconds=7)
        self.assertEqual(parse(json.loads(original.to_json())), original)

    def test_the_json_names_every_setting_in_a_fixed_order_and_ends_in_a_newline(self) -> None:
        text = base().to_json()
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(
            list(json.loads(text)),
            ["family", "shared", "max_runs", "slots", "settle_seconds", "min_idle_percent"],
        )


class LoadConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = scratch_dir(self)

    def write(self, text: str) -> str:
        path = os.path.join(self.root, "config.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def test_a_root_with_no_configuration_uses_the_defaults_and_says_it_has_none(self) -> None:
        loaded = load_config(self.root, cores=12)
        self.assertFalse(loaded.configured)
        self.assertEqual(loaded.config, Config.defaults(self.root, 12))

    def test_a_root_that_does_not_exist_is_a_root_with_no_configuration(self) -> None:
        loaded = load_config(os.path.join(self.root, "absent"), cores=12)
        self.assertFalse(loaded.configured)

    def test_a_configuration_is_loaded_and_validated(self) -> None:
        self.write('{"slots": 2, "settle_seconds": 5}')
        loaded = load_config(self.root, cores=12)
        self.assertTrue(loaded.configured)
        self.assertEqual((loaded.config.slots, loaded.config.settle_seconds), (2, 5))

    def test_a_refused_value_names_the_file(self) -> None:
        path = self.write('{"slots": 0}')
        with self.assertRaisesRegex(ConfigError, "config.json.*slots"):
            load_config(self.root, cores=12)
        self.assertTrue(os.path.exists(path))

    def test_text_that_is_not_json_is_refused_naming_the_file(self) -> None:
        self.write("slots = 3")
        with self.assertRaisesRegex(ConfigError, "config.json"):
            load_config(self.root, cores=12)

    def test_an_empty_file_is_refused(self) -> None:
        self.write("")
        with self.assertRaisesRegex(ConfigError, "config.json"):
            load_config(self.root, cores=12)

    def test_a_file_that_cannot_be_read_is_refused_not_taken_for_no_configuration(self) -> None:
        path = self.write("{}")
        os.chmod(path, 0)
        self.addCleanup(os.chmod, path, stat.S_IRUSR | stat.S_IWUSR)
        if os.access(path, os.R_OK):
            self.skipTest("this account reads any file, so none can be made unreadable")
        with self.assertRaisesRegex(ConfigError, "cannot read"):
            load_config(self.root, cores=12)

    def test_a_directory_in_place_of_the_file_is_refused(self) -> None:
        os.mkdir(os.path.join(self.root, "config.json"))
        with self.assertRaisesRegex(ConfigError, "cannot read"):
            load_config(self.root, cores=12)


if __name__ == "__main__":
    unittest.main()
