import sqlite3
import unittest
from datetime import time, timedelta, timezone
from types import SimpleNamespace

from . import testcase
from polyspec.orm import codes
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogRowSnapshot,
    CatalogTableMetadata,
    _MYSQL_TIME,
    _mysql_catalog_value,
    _mysql_time_value,
    _check_value,
    _cell_key,
    _Session,
    _lock_original_row,
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
    def test_valid_postgres_budget_queries_hit_limits(self):
        connection = sqlite3.connect(":memory:")
        try:
            session = _Session("sqlite", SimpleNamespace(connection=connection))
            many_rows = "SELECT 1" + " UNION ALL SELECT 1" * 199
            with self.assertRaises(OrmError) as row_limit:
                session.run(many_rows, max_rows=199, grid=True)
            self.assertEqual(row_limit.exception.code, codes.CATALOG_LIMIT)

            long_expression = "SELECT " + "+".join(["1"] * 200)
            with self.assertRaises(OrmError) as byte_limit:
                session.run(long_expression, max_bytes=7, grid=True)
            self.assertEqual(byte_limit.exception.code, codes.CATALOG_LIMIT)
        finally:
            connection.close()

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

    # The MySQL TIME text of read_only_query; the cells of a described table are in test_catalog_described_temporal.py.
    def test_mysql_catalog_time_text_keeps_precision(self):
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

    # The plain cells of read_only_query; the cells of a described table are in test_catalog_described_temporal.py.
    def test_postgres_time_cells_keep_native_value(self):
        value = time(12, 34, 56, 123000)
        self.assertIs(_check_value(value), value)
        self.assertEqual(_cell_key(value), "h12:34:56.123000")
        with self.assertRaises(OrmError) as snapshot:
            _cell_key(time(12, 34, 56, tzinfo=timezone.utc))
        self.assertEqual(snapshot.exception.code, codes.ROW_SNAPSHOT_INVALID)

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
