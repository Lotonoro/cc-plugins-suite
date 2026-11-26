"""Tests for the configuration loader: defaults, validation where it is loaded, and the file."""

from __future__ import annotations

import json
import os
import stat
import unittest
from dataclasses import replace
from typing import Any, Dict

from broker.errors import ConfigError
from broker.settings import Config, default_family, default_slots, load_config
from broker.tests.support import scratch_dir

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
