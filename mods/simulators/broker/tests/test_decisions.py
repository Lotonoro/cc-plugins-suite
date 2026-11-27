"""Tests for the last-decision record: one file in the state directory, written whole."""

from __future__ import annotations

import json
import os
import unittest

from broker.decisions import DecisionStore, LastDecision
from broker.errors import StateError
from broker.tests.support import scratch_dir


class DecisionStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = os.path.join(scratch_dir(self), "state")
        self.store = DecisionStore(self.dir)

    def test_no_record_yet_reads_as_none(self) -> None:
        self.assertIsNone(self.store.read())

    def test_a_wait_reads_back_as_written(self) -> None:
        record = LastDecision("wait", "all 3 run slots are held", None, 1764079391)
        self.store.write(record)
        self.assertEqual(self.store.read(), record)

    def test_an_admit_reads_back_with_its_slot(self) -> None:
        record = LastDecision("admit", "the checks passed", 2, 1764079391)
        self.store.write(record)
        self.assertEqual(self.store.read(), record)

    def test_the_state_directory_is_made_when_the_first_record_is_written(self) -> None:
        self.assertFalse(os.path.exists(self.dir))
        self.store.write(LastDecision("wait", "x", None, 1))
        self.assertTrue(os.path.isdir(self.dir))

    def test_a_new_record_replaces_the_old_whole(self) -> None:
        self.store.write(LastDecision("admit", "the checks passed", 1, 10))
        self.store.write(LastDecision("wait", "a run started less than 90s ago", None, 20))
        self.assertEqual(
            self.store.read(), LastDecision("wait", "a run started less than 90s ago", None, 20)
        )

    def test_the_file_is_one_json_object_with_the_four_fields(self) -> None:
        self.store.write(LastDecision("admit", "the checks passed", 0, 5))
        with open(self.store.path, encoding="utf-8") as handle:
            text = handle.read()
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(
            json.loads(text),
            {"decision": "admit", "reason": "the checks passed", "slot": 0, "at": 5},
        )

    def test_writing_leaves_no_temporary_file_behind(self) -> None:
        for at in range(3):
            self.store.write(LastDecision("wait", "x", None, at))
        self.assertEqual(os.listdir(self.dir), ["last-decision.json"])

    def test_a_record_that_is_not_one_of_ours_is_refused_naming_the_file(self) -> None:
        os.makedirs(self.dir)
        bad = (
            "not json",
            "[]",
            '{"decision": "admit"}',
            '{"decision": "later", "reason": "x", "slot": null, "at": 1}',
            '{"decision": "wait", "reason": 5, "slot": null, "at": 1}',
            '{"decision": "wait", "reason": "x", "slot": "0", "at": 1}',
            '{"decision": "wait", "reason": "x", "slot": null, "at": 1.5}',
            '{"decision": "wait", "reason": "x", "slot": null, "at": 1, "extra": 1}',
        )
        for text in bad:
            with self.subTest(text=text):
                with open(self.store.path, "w", encoding="utf-8") as handle:
                    handle.write(text)
                with self.assertRaisesRegex(StateError, "last-decision.json"):
                    self.store.read()

    def test_a_record_that_cannot_be_written_is_a_state_error(self) -> None:
        with open(self.dir, "w", encoding="utf-8") as handle:  # a file where the directory goes
            handle.write("in the way")
        with self.assertRaisesRegex(StateError, "state"):
            self.store.write(LastDecision("wait", "x", None, 1))


if __name__ == "__main__":
    unittest.main()
