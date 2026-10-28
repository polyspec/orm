"""Deterministic tests for the Python wall-clock source used by Db.now."""

import unittest
from unittest.mock import patch

from polyspec.orm import clock
from polyspec.orm.engine.dialect import MysqlDialect, PostgresDialect, SqliteDialect


class WallMicrosTest(unittest.TestCase):
    # Requirements: INT-145, PRT-33.
    def test_estimate_inside_wall_millisecond_is_used(self):
        wall = 1_700_000_000_000_000
        monotonic_start = 5_000_000
        with (
            patch.object(clock, "_MONOTONIC_START", monotonic_start),
            patch.object(clock, "_anchor", float(wall - 250)),
            patch.object(clock.time, "time_ns", return_value=wall * 1000),
            patch.object(
                clock.time,
                "monotonic_ns",
                return_value=(monotonic_start + 500) * 1000,
            ),
        ):
            self.assertEqual(clock.wall_micros(), wall + 250)

    def test_estimate_below_wall_clamps_and_reanchors(self):
        wall = 1_700_000_000_000_000
        monotonic_start = 5_000_000
        with (
            patch.object(clock, "_MONOTONIC_START", monotonic_start),
            patch.object(clock, "_anchor", float(wall - 1000)),
            patch.object(clock.time, "time_ns", return_value=wall * 1000),
            patch.object(
                clock.time,
                "monotonic_ns",
                side_effect=[monotonic_start * 1000, (monotonic_start + 25) * 1000],
            ),
        ):
            self.assertEqual(clock.wall_micros(), wall)
            self.assertEqual(clock._anchor, float(wall))
            self.assertEqual(clock.wall_micros(), wall + 25)

    def test_estimate_above_wall_millisecond_clamps_and_reanchors(self):
        wall = 1_700_000_000_000_000
        monotonic_start = 5_000_000
        with (
            patch.object(clock, "_MONOTONIC_START", monotonic_start),
            patch.object(clock, "_anchor", float(wall + 2000)),
            patch.object(clock.time, "time_ns", return_value=wall * 1000),
            patch.object(
                clock.time, "monotonic_ns", return_value=monotonic_start * 1000
            ),
        ):
            self.assertEqual(clock.wall_micros(), wall + 999)
            self.assertEqual(clock._anchor, float(wall + 999))


class NativeDialectHookTest(unittest.TestCase):
    # Requirements: INT-147, PRT-2, PRT-8, PRT-27, DIA-48, PRT-67.
    def test_python_dialect_hooks_keep_their_native_forms(self):
        self.assertEqual(
            MysqlDialect().restart_identity("load_probe", "seq"),
            "ALTER TABLE `load_probe` AUTO_INCREMENT = 1",
        )
        self.assertEqual(
            PostgresDialect().restart_identity("load_probe", "seq"),
            "SELECT setval(pg_get_serial_sequence('\"load_probe\"', 'seq'), "
            'COALESCE(MAX("seq"), 0) + 1, false) FROM "load_probe"',
        )
        self.assertEqual(
            SqliteDialect().restart_identity("load_probe", "seq"),
            'UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX("seq"), 0) '
            "FROM \"load_probe\") WHERE name = 'load_probe'",
        )
        self.assertEqual(PostgresDialect().read_uuid('"uuid"'), 'CAST("uuid" AS text)')
        self.assertEqual(
            PostgresDialect().write_uuid("$1"), "CAST(CAST($1 AS text) AS uuid)"
        )
        self.assertEqual(SqliteDialect().row_lock("update"), "")
        self.assertIsNone(SqliteDialect().row_lock("invalid"))


if __name__ == "__main__":
    unittest.main()
