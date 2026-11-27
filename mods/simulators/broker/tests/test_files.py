"""Tests for the one way the broker replaces a file whole: under a temporary name, then renamed."""

from __future__ import annotations

import os
import unittest

from broker.files import write_whole
from broker.tests.support import scratch_dir


class WriteWholeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = scratch_dir(self)
        self.path = os.path.join(self.dir, "record.json")

    def read(self) -> str:
        with open(self.path, encoding="utf-8") as handle:
            return handle.read()

    def test_the_text_is_the_whole_content_of_the_file(self) -> None:
        write_whole(self.path, "one\n")
        self.assertEqual(self.read(), "one\n")

    def test_a_second_write_replaces_the_first_whole(self) -> None:
        write_whole(self.path, "a long first text\n")
        write_whole(self.path, "short\n")
        self.assertEqual(self.read(), "short\n")

    def test_the_directory_is_made_when_it_does_not_exist(self) -> None:
        path = os.path.join(self.dir, "made", "deeper", "record.json")
        write_whole(path, "x")
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "x")

    def test_no_temporary_file_is_left_behind(self) -> None:
        for count in range(3):
            write_whole(self.path, f"{count}\n")
        self.assertEqual(os.listdir(self.dir), ["record.json"])

    def test_a_directory_in_the_files_place_fails_with_an_os_error_and_leaves_no_temporary_file(self) -> None:
        os.mkdir(self.path)
        with self.assertRaises(OSError):
            write_whole(self.path, "x")
        self.assertEqual(os.listdir(self.dir), ["record.json"])
        self.assertTrue(os.path.isdir(self.path))

    def test_a_file_in_the_directorys_place_fails_with_an_os_error(self) -> None:
        with open(os.path.join(self.dir, "in-the-way"), "w", encoding="utf-8") as handle:
            handle.write("x")
        with self.assertRaises(OSError):
            write_whole(os.path.join(self.dir, "in-the-way", "record.json"), "x")


if __name__ == "__main__":
    unittest.main()
