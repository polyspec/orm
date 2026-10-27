import sqlite3
import unittest
from datetime import datetime, time, timedelta, timezone
from types import SimpleNamespace

from . import testcase
from polyspec.orm import codes
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogRowSnapshot,
    CatalogTableMetadata,
    _MYSQL_DATETIME,
    _MYSQL_TIME,
    _mysql_catalog_value,
    _mysql_time_value,
    _check_value,
    _cell_key,
    _postgres_time_text,
    _postgres_datetime_text,
    _Session,
    _lock_original_row,
    _same_column_value,
)
from polyspec.orm.errors import OrmError


def metadata(name="account"):
    return CatalogTableMetadata(
        table={"namespace": "main", "name": name},
        kind="table",
        columns=[
            CatalogColumn("id", "INTEGER", False, False),
            CatalogColumn("name", "TEXT", False, False),
        ],
        primary_key=["id"],
        reliable_row_identity=True,
    )


class FakeSession:
    def __init__(self, descriptor, rows):
        self.descriptor = descriptor
        self.rows = rows
        self.calls = []
        self.safety_called = False

    def lookup(self, descriptor, keys, lock):
        self.calls.append(("lookup", descriptor, keys, lock))
        return self.rows

    def describe(self, table):
        self.calls.append(("describe", table))
        return self.descriptor

    def mysql_safety(self, descriptor):
        self.calls.append(("mysql_safety", descriptor))
        self.safety_called = True


class CatalogMutationHelperTest(unittest.TestCase):
    def test_plain_query_byte_budget_counts_utf8_bytes(self):
        connection = sqlite3.connect(":memory:")
        try:
            session = _Session("sqlite", SimpleNamespace(connection=connection))
            with self.assertRaises(OrmError) as overflow:
                session.run("SELECT 'é' AS value", max_rows=1, max_bytes=1)
            self.assertEqual(overflow.exception.code, codes.CATALOG_LIMIT)
            exact = session.run("SELECT 'é' AS value", max_rows=1, max_bytes=2)
            self.assertEqual(exact.rows, [["é"]])
        finally:
            connection.close()

    # Internal conversion regression; public catalog temporal coverage is in coverage_catalog_connection.py.
    def test_mysql_catalog_time_text_keeps_precision_and_datetime_comparison_is_typed(
        self,
    ):
        self.assertEqual(
            _mysql_catalog_value(
                timedelta(hours=12, minutes=34, seconds=56), _MYSQL_TIME, 0
            ),
            "12:34:56",
        )
        self.assertEqual(
            _mysql_catalog_value(
                timedelta(hours=12, minutes=34, seconds=56, microseconds=123000),
                _MYSQL_TIME,
                3,
            ),
            "12:34:56.123",
        )
        self.assertEqual(
            _mysql_catalog_value(
                timedelta(hours=12, minutes=34, seconds=56, microseconds=123456),
                _MYSQL_TIME,
                6,
            ),
            "12:34:56.123456",
        )
        self.assertIsNone(_mysql_catalog_value(None, _MYSQL_TIME, 6))
        for invalid in (timedelta(seconds=-1), timedelta(days=1)):
            with self.subTest(value=invalid):
                with self.assertRaises(OrmError) as raised:
                    _mysql_time_value(invalid, 6)
                self.assertEqual(raised.exception.code, codes.CATALOG_VALUE)
        with self.assertRaises(OrmError) as precision:
            _mysql_time_value(timedelta(microseconds=1), 0)
        self.assertEqual(precision.exception.code, codes.CATALOG_VALUE)

        native_datetime = datetime(2026, 1, 2, 3, 4, 5, 123000)
        column = CatalogColumn("at", "datetime(3)", False, False)
        self.assertTrue(
            _same_column_value(
                native_datetime, "2026-01-02 03:04:05.123", column, "mysql"
            )
        )
        self.assertFalse(
            _same_column_value(
                native_datetime,
                "2026-01-02 03:04:05.123",
                CatalogColumn("at", "text", False, False),
                "mysql",
            )
        )
        self.assertEqual(
            _mysql_catalog_value(native_datetime, _MYSQL_DATETIME, 3), native_datetime
        )

    def test_postgres_time_cells_keep_native_value_and_declared_precision(self):
        value = time(12, 34, 56, 123000)
        self.assertIs(_check_value(value), value)
        self.assertEqual(_cell_key(value), "h12:34:56.123000")
        self.assertEqual(_postgres_time_text(value, 3), "12:34:56.123")
        self.assertEqual(
            _postgres_time_text(time(12, 34, 56, 123456), 6),
            "12:34:56.123456",
        )
        self.assertTrue(
            _same_column_value(
                value,
                "12:34:56.123",
                CatalogColumn("at", "time(3) without time zone", False, False),
                "postgres",
            )
        )
        self.assertTrue(
            _same_column_value(
                time(12, 34, 56, 123456),
                "12:34:56.123456",
                CatalogColumn("at", "time without time zone", False, False),
                "postgres",
            )
        )
        for invalid in (
            time(12, 34, 56, 123001),
            time(12, 34, 56, tzinfo=timezone.utc),
        ):
            with self.subTest(value=invalid):
                with self.assertRaises(OrmError) as raised:
                    _postgres_time_text(invalid, 3)
                self.assertEqual(raised.exception.code, codes.CATALOG_VALUE)
        with self.assertRaises(OrmError) as snapshot:
            _cell_key(time(12, 34, 56, tzinfo=timezone.utc))
        self.assertEqual(snapshot.exception.code, codes.ROW_SNAPSHOT_INVALID)

    def test_postgres_timestamp_cells_keep_native_value_and_declared_precision(self):
        value = datetime(2026, 1, 2, 3, 4, 5, 123000)
        self.assertEqual(_postgres_datetime_text(value, 3), "2026-01-02 03:04:05.123")
        self.assertEqual(
            _postgres_datetime_text(datetime(2026, 1, 2, 3, 4, 5), 0),
            "2026-01-02 03:04:05",
        )
        self.assertTrue(
            _same_column_value(
                datetime(2026, 1, 2, 3, 4, 5, 123000),
                "2026-01-02 03:04:05.123",
                CatalogColumn("at", "timestamp(3) without time zone", False, False),
                "postgres",
            )
        )
        self.assertTrue(
            _same_column_value(
                datetime(2026, 1, 2, 3, 4, 5, 123456),
                "2026-01-02 03:04:05.123456",
                CatalogColumn("at", "timestamp without time zone", False, False),
                "postgres",
            )
        )
        with self.assertRaises(OrmError) as precision:
            _postgres_datetime_text(value, 2)
        self.assertEqual(precision.exception.code, codes.CATALOG_VALUE)
        with self.assertRaises(OrmError) as zone:
            _postgres_datetime_text(
                datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc), 6
            )
        self.assertEqual(zone.exception.code, codes.CATALOG_VALUE)

    def test_locks_and_validates_unchanged_original_row_before_mysql_safety(self):
        descriptor = metadata()
        session = FakeSession(descriptor, [[1, "original"]])
        snapshot = CatalogRowSnapshot(descriptor, [1, "original"], [0], "revision")

        got = _lock_original_row(session, snapshot, "mysql")

        self.assertIs(got, descriptor)
        self.assertEqual(
            session.calls,
            [
                ("lookup", descriptor, [1], True),
                ("describe", descriptor.table),
                ("mysql_safety", descriptor),
            ],
        )

    def test_changed_descriptor_fails_before_mysql_safety(self):
        original = metadata()
        session = FakeSession(metadata("changed"), [[1, "original"]])
        snapshot = CatalogRowSnapshot(original, [1, "original"], [0], "revision")

        with self.assertRaises(OrmError) as raised:
            _lock_original_row(session, snapshot, "mysql")

        self.assertEqual(raised.exception.code, "ROW_SCHEMA_CHANGED")
        self.assertFalse(session.safety_called)


if __name__ == "__main__":
    testcase.main()
