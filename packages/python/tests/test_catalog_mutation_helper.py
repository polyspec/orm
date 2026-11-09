import sqlite3
import unittest
from datetime import date, datetime, time, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

from . import testcase
from polyspec.orm import codes
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogRowSnapshot,
    CatalogTableMetadata,
    _MYSQL_DATE,
    _MYSQL_TIME,
    _check_value,
    _grid_cell,
    _mysql_decoders,
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

    # The plain cells of read_only_query; the cells of a described table are in test_catalog_described_temporal.py.
    def test_postgres_time_cells_keep_native_value(self):
        value = time(12, 34, 56, 123000)
        self.assertIs(_check_value(value, 1), value)
        self.assertEqual(_cell_key(value), "h12:34:56.123000")
        with self.assertRaises(OrmError) as snapshot:
            _cell_key(time(12, 34, 56, tzinfo=timezone.utc))
        self.assertEqual(snapshot.exception.code, codes.ROW_SNAPSHOT_INVALID)

    def test_date_and_uuid_cells_read_as_their_dbspec_text(self):
        # A date and a uuid read from a described table are the text forms of their dbspec types, which the cell key
        # and the snapshot read as text.
        self.assertEqual(_check_value(date(2024, 2, 29), 1), "2024-02-29")
        self.assertEqual(_check_value(date(1, 1, 1), 1), "0001-01-01")
        self.assertEqual(
            _check_value(UUID("0F8FAD5B-D9CB-469F-A165-70867728950E"), 1),
            "0f8fad5b-d9cb-469f-a165-70867728950e",
        )
        self.assertEqual(
            _cell_key(_check_value(date(2024, 2, 29), 1)), "s10:2024-02-29"
        )
        # A decimal cell arrives as text from the driver conversions of the catalog sessions; a Decimal object stays refused.
        with self.assertRaises(OrmError) as decimal:
            _check_value(Decimal("1.50"), 4)
        self.assertEqual(
            str(decimal.exception), "CATALOG_VALUE: column 4: unsupported driver value"
        )

    # Requirements: INT-171
    # INT-171 (FCV-2): no database sends a driver value that is not the host form of its column type, so the values are
    # injected at the conversion of the driver values of each dialect.
    def test_a_driver_value_of_another_host_form_is_refused(self):
        cases = [
            ("a SQLite value of no storage class", object(), "sqlite", None, None),
            (
                "a MySQL TIME of another time kind",
                time(1, 2, 3),
                "mysql",
                _MYSQL_TIME,
                None,
            ),
            (
                "a MySQL date with a time of day",
                datetime(2024, 2, 29, 1),
                "mysql",
                _MYSQL_DATE,
                None,
            ),
            (
                "a PostgreSQL integer text that is no integer",
                b"1.5",
                "postgres",
                20,
                "integer",
            ),
            (
                "a PostgreSQL integer beyond 64 bits",
                b"9223372036854775808",
                "postgres",
                20,
                "integer",
            ),
            (
                "a PostgreSQL float text that is no number",
                b"one",
                "postgres",
                701,
                "float64",
            ),
            (
                "a PostgreSQL time with a seventh fraction digit",
                b"12:34:56.1234567",
                "postgres",
                1083,
                "time",
            ),
        ]
        for name, value, dialect, code, cls in cases:
            with self.subTest(case=name):
                with self.assertRaises(OrmError) as raised:
                    _grid_cell(value, dialect, code, False, 3, cls)
                self.assertEqual(
                    str(raised.exception),
                    "CATALOG_VALUE: column 3: unsupported driver value",
                )
                self.assertIsNone(raised.exception.__cause__)

    # Requirements: INT-172
    # INT-172 (FCV-2): no database sends a value that its driver cannot decode, so the failure is injected at the decoding
    # of each dialect; the refusal names no column, and the failure is its cause.
    def test_a_value_the_driver_cannot_decode_keeps_its_failure(self):
        def converter(data):
            raise ValueError("no value")

        result = SimpleNamespace(converters=[("utf-8", None), (None, converter)])
        _mysql_decoders(result)
        cases = [
            (
                "a MySQL text that is not UTF-8",
                lambda: result.converters[0][1](b"\xff"),
                UnicodeDecodeError,
            ),
            (
                "a MySQL converter that fails",
                lambda: result.converters[1][1](b"1"),
                ValueError,
            ),
            (
                "a PostgreSQL text that is not UTF-8",
                lambda: _grid_cell(b"\xff", "postgres", 25, False, 2, "text"),
                UnicodeDecodeError,
            ),
            (
                "a PostgreSQL bytea of no bytea form",
                lambda: _grid_cell(b"\\x0", "postgres", 17, False, 5, "binary"),
                ValueError,
            ),
        ]
        for name, call, failure in cases:
            with self.subTest(case=name):
                with self.assertRaises(OrmError) as raised:
                    call()
                self.assertEqual(
                    str(raised.exception),
                    "CATALOG_VALUE: the driver could not decode the value",
                )
                self.assertIsInstance(raised.exception.__cause__, failure)
                self.assertIs(raised.exception.cause, raised.exception.__cause__)

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
