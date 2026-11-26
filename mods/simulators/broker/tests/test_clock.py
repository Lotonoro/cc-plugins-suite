"""Tests for the clock: whole epoch seconds as `date +%s` prints them, and the owner record's stamp."""

from __future__ import annotations

import os
import subprocess
import sys
import time
import unittest

from broker.clock import SystemClock, local_stamp
from broker.tests.support import EPOCH


class SystemClockTest(unittest.TestCase):
    def test_now_is_the_epoch_second_as_a_whole_number(self) -> None:
        before = int(time.time())
        got = SystemClock().now()
        after = int(time.time())
        self.assertIsInstance(got, int)
        self.assertTrue(before <= got <= after, f"{got} is not within {before}..{after}")

    def test_sleep_waits_at_least_the_time_given(self) -> None:
        started = time.monotonic()
        SystemClock().sleep(0.05)
        self.assertGreaterEqual(time.monotonic() - started, 0.04)


class LocalStampTest(unittest.TestCase):
    def setUp(self) -> None:
        self.addCleanup(self.restore_zone, os.environ.get("TZ"))

    def restore_zone(self, zone: object) -> None:
        if zone is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = str(zone)
        time.tzset()

    def at_zone(self, zone: str) -> None:
        os.environ["TZ"] = zone
        time.tzset()

    def test_the_stamp_is_the_local_time_to_the_second_with_no_zone(self) -> None:
        self.assertRegex(local_stamp(EPOCH), r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$")

    def test_the_stamp_follows_the_zone_the_machine_is_in(self) -> None:
        self.at_zone("UTC0")
        self.assertEqual(local_stamp(0), "1970-01-01T00:00:00")
        self.at_zone("EST5")  # five hours west of UTC
        self.assertEqual(local_stamp(0), "1969-12-31T19:00:00")

    def test_the_stamp_pads_every_field_to_its_width(self) -> None:
        self.at_zone("UTC0")
        self.assertEqual(local_stamp(86400 * 31 + 3600 * 4 + 60 * 5 + 6), "1970-02-01T04:05:06")

    @unittest.skipUnless(sys.platform == "darwin", "date -r takes an epoch second on macOS only")
    def test_the_stamp_is_what_the_date_command_prints_for_the_same_second(self) -> None:
        printed = subprocess.run(
            ["/bin/date", "-r", str(EPOCH), "+%Y-%m-%dT%H:%M:%S"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(local_stamp(EPOCH), printed)


if __name__ == "__main__":
    unittest.main()
