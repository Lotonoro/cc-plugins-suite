"""Tests for the lock family: the files, the flocks and the records, on real files and processes.

LOCK-PROTOCOL.md sections 2 and 5.1 say what each file is and what is done to it. The flocks are
tested against a second process too, since the family is shared with processes that are not
this one: a flock held by a process that dies is gone, and a probe never keeps what it tests.
"""

from __future__ import annotations

import fcntl
import os
import threading
import unittest
from typing import List, Optional, Tuple

from broker.errors import FamilyError
from broker.family import Family, in_default_family
from broker.tests.support import hold_in_another_process, scratch_dir


class FamilyCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.lock = os.path.join(self.dir, "lock")

    def family(self, slots: int = 3, window: Optional[int] = None) -> Family:
        return Family(self.lock, slots=slots, window=window or slots)

    def read(self, path: str) -> str:
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def write(self, path: str, text: str) -> None:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)


class PathsTest(FamilyCase):
    def test_slot_0_is_the_lock_file_and_slot_k_has_dot_k_appended(self) -> None:
        fam = self.family()
        self.assertEqual(fam.slot_path(0), self.lock)
        self.assertEqual(fam.slot_path(2), self.lock + ".2")

    def test_the_owner_record_is_the_slots_file_with_dot_owner_appended(self) -> None:
        fam = self.family()
        self.assertEqual(fam.owner_path(0), self.lock + ".owner")
        self.assertEqual(fam.owner_path(2), self.lock + ".2.owner")

    def test_the_gate_and_the_last_start_sit_beside_the_lock_file(self) -> None:
        fam = self.family()
        self.assertEqual(fam.gate_path, self.lock + ".gate")
        self.assertEqual(fam.last_start_path, self.lock + ".last-start")


class ConstructionTest(FamilyCase):
    def test_a_slot_count_above_the_window_is_refused_since_the_script_would_not_see_that_slot(
        self,
    ) -> None:
        with self.assertRaisesRegex(ValueError, "window"):
            Family(self.lock, slots=4, window=3)

    def test_a_slot_count_below_one_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "slots"):
            Family(self.lock, slots=0, window=3)


class FilesTest(FamilyCase):
    def test_probing_creates_the_slot_files_and_the_gate_and_writes_nothing_to_them(self) -> None:
        fam = self.family(slots=2, window=3)
        with fam.gate():
            fam.probe_all()
        for name in ("lock", "lock.1", "lock.2", "lock.gate"):
            path = os.path.join(self.dir, name)
            self.assertEqual(os.path.getsize(path), 0, name)
        self.assertFalse(os.path.exists(self.lock + ".3"))

    def test_a_file_is_opened_for_appending_so_what_it_holds_is_kept(self) -> None:
        self.write(self.lock, "keep me")
        self.write(self.lock + ".gate", "and me")
        fam = self.family()
        with fam.gate():
            fam.probe(0)
        self.assertEqual(self.read(self.lock), "keep me")
        self.assertEqual(self.read(self.lock + ".gate"), "and me")

    def test_a_family_in_a_directory_that_does_not_exist_is_refused_naming_the_file(self) -> None:
        fam = Family(os.path.join(self.dir, "absent", "lock"), slots=3, window=3)
        with self.assertRaisesRegex(FamilyError, "absent/lock.gate"):
            with fam.gate():
                pass
        with self.assertRaisesRegex(FamilyError, "absent/lock"):
            fam.probe(0)

    def test_a_family_the_broker_owns_gets_its_directory_made(self) -> None:
        lock = os.path.join(self.dir, "family", "lock")
        fam = Family(lock, slots=3, window=3, creates_directory=True)
        with fam.gate():
            self.assertFalse(fam.probe(0))
        self.assertTrue(os.path.exists(lock))

    def test_two_families_never_see_each_others_slots(self) -> None:
        other = Family(os.path.join(self.dir, "other"), slots=3, window=3)
        mine = self.family()
        with mine.gate():
            taken = mine.take_lowest_free()
        self.assertIsNotNone(taken)
        with other.gate():
            self.assertEqual(other.probe_all(), (False, False, False))
        os.close(taken[1])  # type: ignore[index]


class GateTest(FamilyCase):
    def test_the_gate_blocks_a_second_taker_until_it_is_released(self) -> None:
        first = self.family()
        second = self.family()
        starting = threading.Event()
        entered = threading.Event()

        def take_the_gate() -> None:
            starting.set()
            with second.gate():
                entered.set()

        with first.gate():
            thread = threading.Thread(target=take_the_gate, daemon=True)
            thread.start()
            self.assertTrue(starting.wait(5))
            self.assertFalse(entered.wait(0.3), "the second taker got in while the gate was held")
        self.assertTrue(entered.wait(5), "the second taker never got in after the release")
        thread.join(5)

    def test_the_gate_is_released_when_its_body_raises(self) -> None:
        fam = self.family()
        with self.assertRaises(RuntimeError):
            with fam.gate():
                raise RuntimeError("body failed")
        with fam.gate():
            pass  # would block forever if the first hold had leaked

    def test_the_gate_is_an_exclusive_flock_on_the_gate_file(self) -> None:
        fam = self.family()
        with fam.gate():
            fd = os.open(fam.gate_path, os.O_WRONLY | os.O_APPEND)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(fd)

    def test_a_listing_waits_for_the_gate(self) -> None:
        fam = self.family()
        starting = threading.Event()
        done = threading.Event()

        def list_it() -> None:
            starting.set()
            fam.list_holders()
            done.set()

        with self.family().gate():
            thread = threading.Thread(target=list_it, daemon=True)
            thread.start()
            self.assertTrue(starting.wait(5))
            self.assertFalse(done.wait(0.3), "the listing probed slots while the gate was held")
        self.assertTrue(done.wait(5))
        thread.join(5)


class ProbeTest(FamilyCase):
    def test_a_free_slot_probes_free_and_stays_takable(self) -> None:
        fam = self.family()
        with fam.gate():
            self.assertFalse(fam.probe(0))
            self.assertFalse(fam.probe(0))  # the first probe did not keep the slot
            taken = fam.take_lowest_free()
        self.assertEqual(taken[0], 0)  # type: ignore[index]
        os.close(taken[1])  # type: ignore[index]

    def test_a_slot_held_by_another_process_probes_held(self) -> None:
        hold_in_another_process(self, self.lock + ".1")
        fam = self.family()
        with fam.gate():
            self.assertEqual(fam.probe_all(), (False, True, False))

    def test_a_holder_that_dies_leaves_the_slot_free_with_no_stale_state(self) -> None:
        child = hold_in_another_process(self, self.lock)
        fam = self.family()
        with fam.gate():
            self.assertTrue(fam.probe(0))
        child.kill()
        child.wait()
        with fam.gate():
            self.assertFalse(fam.probe(0))

    def test_the_probe_covers_the_window_not_only_the_brokers_slots(self) -> None:
        hold_in_another_process(self, self.lock + ".2")
        fam = self.family(slots=2, window=3)
        with fam.gate():
            self.assertEqual(fam.probe_all(), (False, False, True))


class TakeTest(FamilyCase):
    def take(self, fam: Family) -> Optional[Tuple[int, int]]:
        with fam.gate():
            taken = fam.take_lowest_free()
        if taken is not None:
            self.addCleanup(os.close, taken[1])
        return taken

    def test_the_lowest_free_slot_is_taken_first(self) -> None:
        fam = self.family()
        slots = [self.take(fam), self.take(fam), self.take(fam)]
        self.assertEqual([got[0] for got in slots if got], [0, 1, 2])

    def test_no_slot_is_left_when_every_broker_slot_is_held(self) -> None:
        fam = self.family()
        for _ in range(3):
            self.take(fam)
        self.assertIsNone(self.take(fam))

    def test_a_taken_slot_is_held_until_its_descriptor_closes(self) -> None:
        fam = self.family()
        with fam.gate():
            taken = fam.take_lowest_free()
        assert taken is not None
        with fam.gate():
            self.assertTrue(fam.probe(0))
        os.close(taken[1])
        with fam.gate():
            self.assertFalse(fam.probe(0))

    def test_a_slot_the_script_holds_below_the_brokers_count_is_skipped(self) -> None:
        hold_in_another_process(self, self.lock)
        got = self.take(self.family())
        self.assertEqual(got[0], 1)  # type: ignore[index]

    def test_a_free_slot_beyond_the_brokers_count_is_never_taken(self) -> None:
        # c = 2 and N = 3: slot 2 is in the script's window only.
        fam = self.family(slots=2, window=3)
        self.take(fam)
        self.take(fam)
        self.assertIsNone(self.take(fam))
        with fam.gate():
            self.assertFalse(fam.probe(2))

    def test_the_taken_descriptor_is_not_inherited_by_a_child_unless_passed(self) -> None:
        fam = self.family()
        taken = self.take(fam)
        self.assertFalse(os.get_inheritable(taken[1]))  # type: ignore[index]


class RecordsTest(FamilyCase):
    def test_a_missing_last_start_reads_as_none(self) -> None:
        self.assertIsNone(self.family().read_last_start())

    def test_a_last_start_of_digits_and_a_newline_reads_as_the_epoch_second(self) -> None:
        self.write(self.lock + ".last-start", "1764079391\n")
        self.assertEqual(self.family().read_last_start(), 1764079391)

    def test_content_that_is_not_all_digits_reads_as_none(self) -> None:
        for text in ("", "\n", "soon\n", "12 \n", "1.5\n", "-4\n", "٣\n"):
            with self.subTest(text=text):
                self.write(self.lock + ".last-start", text)
                self.assertIsNone(self.family().read_last_start())

    def test_trailing_newlines_are_not_content(self) -> None:
        self.write(self.lock + ".last-start", "77\n\n")
        self.assertEqual(self.family().read_last_start(), 77)

    def test_an_unreadable_last_start_reads_as_none_as_the_script_counts_it_settled(self) -> None:
        os.mkdir(self.lock + ".last-start")
        self.assertIsNone(self.family().read_last_start())

    def test_the_last_start_is_written_as_plain_epoch_seconds_and_a_newline(self) -> None:
        self.family().write_last_start(1764079391)
        self.assertEqual(self.read(self.lock + ".last-start"), "1764079391\n")

    def test_the_last_start_is_rewritten_whole_not_appended(self) -> None:
        fam = self.family()
        fam.write_last_start(1764079391)
        fam.write_last_start(5)
        self.assertEqual(self.read(self.lock + ".last-start"), "5\n")

    def test_an_owner_record_is_one_line_in_the_slots_owner_file(self) -> None:
        self.family().write_owner(2, "pid=1 slot=2 cwd=/ started=t command=x")
        self.assertEqual(self.read(self.lock + ".2.owner"), "pid=1 slot=2 cwd=/ started=t command=x\n")

    def test_a_record_that_cannot_be_written_is_a_family_error_naming_the_file(self) -> None:
        fam = Family(os.path.join(self.dir, "absent", "lock"), slots=1, window=1)
        with self.assertRaisesRegex(FamilyError, "last-start"):
            fam.write_last_start(1)
        with self.assertRaisesRegex(FamilyError, "owner"):
            fam.write_owner(0, "x")


class HoldersTest(FamilyCase):
    def test_no_one_holding_a_slot_lists_nothing(self) -> None:
        self.assertEqual(self.family().list_holders(), [])

    def test_a_held_slot_lists_its_record_indented_two_spaces(self) -> None:
        self.write(self.lock + ".owner", "pid=41231 slot=0 cwd=/tmp/work started=2026-11-25T14:03:11 command=xcodebuild test\n")
        hold_in_another_process(self, self.lock)
        self.assertEqual(
            self.family().list_holders(),
            ["  pid=41231 slot=0 cwd=/tmp/work started=2026-11-25T14:03:11 command=xcodebuild test"],
        )

    def test_a_record_whose_slot_is_not_held_is_never_listed(self) -> None:
        self.write(self.lock + ".owner", "pid=1 slot=0 cwd=/ started=t command=finished-run\n")
        self.assertEqual(self.family().list_holders(), [])

    def test_a_held_slot_with_no_record_lists_nothing(self) -> None:
        hold_in_another_process(self, self.lock + ".1")
        self.assertEqual(self.family().list_holders(), [])

    def test_the_holders_are_listed_in_slot_order(self) -> None:
        for k, name in ((0, ".owner"), (2, ".2.owner")):
            self.write(self.lock + name, f"pid={k} slot={k} cwd=/ started=t command=run{k}\n")
        hold_in_another_process(self, self.lock + ".2")
        hold_in_another_process(self, self.lock)
        got: List[str] = self.family().list_holders()
        self.assertEqual([line.split()[1] for line in got], ["slot=0", "slot=2"])

    def test_the_listing_covers_the_window_beyond_the_brokers_slots(self) -> None:
        self.write(self.lock + ".2.owner", "pid=9 slot=2 cwd=/ started=t command=script-run\n")
        hold_in_another_process(self, self.lock + ".2")
        got = self.family(slots=2, window=3).list_holders()
        self.assertEqual(got, ["  pid=9 slot=2 cwd=/ started=t command=script-run"])

    def test_a_listing_leaves_every_slot_as_it_found_it(self) -> None:
        fam = self.family()
        fam.list_holders()
        with fam.gate():
            self.assertEqual(fam.probe_all(), (False, False, False))


class InDefaultFamilyTest(FamilyCase):
    """Whether a path is the script's default lock or one of its family's files, as the script says.

    `sim-lock.sh` refuses a MAX_RUNS other than 3 there (LOCK-PROTOCOL.md section 4), and its
    matcher is ported as it is, misses included. The default lock a test names sits in a directory
    of its own, which stands for /tmp, and is an argument: no test here names the real one.
    """

    NAME = "pango-sim-test.flock"

    def setUp(self) -> None:
        super().setUp()
        self.tmp = os.path.join(self.dir, "tmp")
        self.elsewhere = os.path.join(self.dir, "elsewhere")
        os.makedirs(self.tmp)
        os.makedirs(self.elsewhere)
        self.default = os.path.join(self.tmp, self.NAME)

    def says(self, path: str) -> bool:
        return in_default_family(path, self.default)

    def link(self, target: str, where: str, name: str) -> str:
        path = os.path.join(where, name)
        os.symlink(target, path)
        return path

    def test_the_default_lock_is_in_its_own_family_whether_or_not_the_file_is_there(self) -> None:
        self.assertTrue(self.says(self.default))
        self.write(self.default, "")
        self.assertTrue(self.says(self.default))

    def test_a_file_of_its_family_is_in_it_whether_or_not_the_file_is_there(self) -> None:
        for suffix in (".1", ".2", ".gate", ".last-start", ".owner", ".1.owner"):
            with self.subTest(suffix=suffix):
                self.assertTrue(self.says(self.default + suffix))

    def test_the_script_matches_by_prefix_so_a_longer_name_is_in_the_family_too(self) -> None:
        self.assertTrue(self.says(self.default + "-probe"))

    def test_another_spelling_of_the_directory_is_the_same_family(self) -> None:
        linked = self.link(self.tmp, self.dir, "linked")
        for spelling in (
            f"{self.tmp}//{self.NAME}",
            f"{self.tmp}/./{self.NAME}.1",
            os.path.join(self.elsewhere, "..", "tmp", f"{self.NAME}.gate"),
            os.path.join(linked, self.NAME),
            os.path.join(linked, f"{self.NAME}.2"),
        ):
            with self.subTest(spelling=spelling):
                self.assertTrue(self.says(spelling))

    def test_a_trailing_slash_does_not_change_the_name_as_the_shells_basename_reads_it(self) -> None:
        self.assertTrue(self.says(self.default + "/"))
        self.assertFalse(self.says(os.path.join(self.elsewhere, self.NAME) + "/"))

    def test_the_default_locks_own_directory_may_be_a_symlink_as_tmp_is_on_a_mac(self) -> None:
        linked = self.link(self.tmp, self.dir, "linked")
        self.assertTrue(in_default_family(self.default + ".1", os.path.join(linked, self.NAME)))
        self.assertFalse(in_default_family(os.path.join(self.elsewhere, self.NAME), os.path.join(linked, self.NAME)))

    def test_a_symlink_to_the_default_lock_is_in_the_family_once_the_lock_is_there(self) -> None:
        mine = self.link(self.default, self.elsewhere, "mine.flock")
        self.assertFalse(self.says(mine), "the link leads nowhere yet")
        self.write(self.default, "")
        self.assertTrue(self.says(mine))

    def test_a_file_that_is_neither_beside_the_default_lock_nor_named_for_it_is_not_in_the_family(self) -> None:
        for path in (
            os.path.join(self.tmp, "other.flock"),
            os.path.join(self.tmp, "pango-sim-test"),
            os.path.join(self.elsewhere, self.NAME),
            os.path.join(self.elsewhere, self.NAME + ".1"),
            os.path.join(self.dir, "no", "such", "directory", self.NAME),
        ):
            with self.subTest(path=path):
                self.assertFalse(self.says(path))

    def test_a_symlink_to_a_family_file_other_than_the_default_lock_is_a_miss_as_in_the_script(self) -> None:
        self.write(self.default + ".1", "")
        self.assertFalse(self.says(self.link(self.default + ".1", self.elsewhere, "mine.flock")))

    def test_a_different_letter_case_is_a_miss_as_in_the_script(self) -> None:
        self.assertFalse(self.says(os.path.join(self.tmp, "Pango-Sim-Test.flock")))


if __name__ == "__main__":
    unittest.main()
