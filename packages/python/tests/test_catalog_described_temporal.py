import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

from . import testcase
from polyspec.orm import codes
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogTableMetadata,
    _Session,
    connect_catalog,
)
from polyspec.orm.errors import OrmError

# A table in the SQLite form of the dbspec renderer (engine/dbspec/render.go): each TIME and DATETIME column has the
# CHECK that fixes its fraction digits.
TEMPORAL_DDL = """CREATE TABLE temporal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  d DATE NOT NULL CHECK ("d" IS date("d")),
  t0 TIME NOT NULL CHECK ("t0" IS time("t0") AND "t0" < '24:00:00'),
  t3 TIME NOT NULL CHECK (length("t3") = 12 AND substr("t3", 1, 8) IS time(substr("t3", 1, 8)) AND substr("t3", 1, 8) < '24:00:00' AND substr("t3", 9, 1) = '.' AND substr("t3", 10) GLOB '[0-9][0-9][0-9]'),
  dt0 DATETIME NOT NULL CHECK (length("dt0") = 19 AND "dt0" IS datetime("dt0") AND substr("dt0", 12, 2) < '24'),
  dt6 DATETIME NOT NULL CHECK (length("dt6") = 26 AND substr("dt6", 1, 19) IS datetime(substr("dt6", 1, 19)) AND substr("dt6", 12, 2) < '24' AND substr("dt6", 20, 1) = '.' AND substr("dt6", 21) GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]')
)"""


def temporal_values():
    return [
        ("d", "2024-02-29"),
        ("t0", "12:34:56"),
        ("t3", "12:34:56.500"),
        ("dt0", "2024-02-29 01:02:03"),
        ("dt6", "2024-02-29 01:02:03.500000"),
    ]


class SqliteCatalog:
    """A catalog connection to a temporary SQLite file whose schema the case gives; the file goes with the case."""

    def __init__(self, case: unittest.TestCase, script: str):
        directory = tempfile.TemporaryDirectory(prefix="orm-catalog-temporal-")
        case.addCleanup(directory.cleanup)
        path = os.path.join(directory.name, "catalog.sqlite3")
        native = sqlite3.connect(path)
        try:
            native.executescript(script)
            native.commit()
        finally:
            native.close()
        self.catalog = connect_catalog(f"sqlite://{path}")
        case.addCleanup(self.catalog.close)


class FakeCursor:
    """A driver cursor that returns one fixed result and records the loaders a read registers."""

    def __init__(self, description, rows, loaders):
        self.description = description
        self._rows = list(rows)
        self.rowcount = len(self._rows)
        self.lastrowid = None
        self.adapters = SimpleNamespace(
            register_loader=lambda oid, loader: loaders.append((oid, loader))
        )

    def execute(self, text, args):
        pass

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None

    def close(self):
        pass


class FakeConnection:
    def __init__(self, description, rows):
        self.description = description
        self.rows = rows
        self.loaders = []
        self.closed = False

    def cursor(self):
        return FakeCursor(self.description, self.rows, self.loaders)


def metadata_of(dialect: str, native_types: list) -> CatalogTableMetadata:
    namespace = "public" if dialect == "postgres" else "app"
    return CatalogTableMetadata(
        table={"namespace": namespace, "name": "temporal"},
        kind="table",
        columns=[
            CatalogColumn(f"c{index}", native, index != 0, False)
            for index, native in enumerate(native_types)
        ],
        primary_key=["c0"],
        reliable_row_identity=True,
    )


class CatalogDescribedTemporalTest(unittest.TestCase):
    # Requirements: INT-103, INT-117.
    def test_sqlite_described_reads_return_temporal_text(self):
        catalog = SqliteCatalog(self, TEMPORAL_DDL).catalog
        table = {"namespace": "main", "name": "temporal"}
        metadata = catalog.describe_table(table)
        self.assertEqual(
            [column.check_precision for column in metadata.columns],
            [None, None, 0, 3, 0, 6],
        )
        want = [
            1,
            "2024-02-29",
            "12:34:56",
            "12:34:56.500",
            "2024-02-29 01:02:03",
            "2024-02-29 01:02:03.500000",
        ]
        inserted = catalog.insert_row(metadata, temporal_values())
        self.assertEqual(inserted.rows, [want])
        page = catalog.table_page(table, 10, 0)
        self.assertEqual(page.result.rows, [want])
        original = catalog.row_snapshot_from_page(page, 0)
        updated = catalog.update_row(original, [("dt6", "2024-03-01 00:00:00.000001")])
        want[5] = "2024-03-01 00:00:00.000001"
        self.assertEqual(updated.rows, [want])
        current = catalog.row_snapshot_from_page(catalog.table_page(table, 10, 0), 0)
        self.assertEqual(catalog.delete_row(current), 1)

    # Requirements: INT-103.
    def test_sqlite_text_outside_its_check_fails(self):
        for name, script, code in (
            (
                "loose",
                "CREATE TABLE loose (id INTEGER PRIMARY KEY, dt DATETIME); INSERT INTO loose VALUES (1, '2024-02-29 01:02:03')",
                codes.GRID_TEMPORAL_PRECISION,
            ),
            (
                "wrong",
                "CREATE TABLE wrong (id INTEGER PRIMARY KEY, d DATE); INSERT INTO wrong VALUES (1, 'not a date')",
                codes.GRID_TEMPORAL_VALUE,
            ),
        ):
            with self.subTest(table=name):
                catalog = SqliteCatalog(self, script).catalog
                with self.assertRaises(OrmError) as raised:
                    catalog.table_page({"namespace": "main", "name": name}, 10, 0)
                self.assertEqual(raised.exception.code, code)

    # Requirements: INT-111, INT-123.
    def test_write_refuses_a_datetime_for_a_temporal_column(self):
        catalog = SqliteCatalog(self, TEMPORAL_DDL).catalog
        table = {"namespace": "main", "name": "temporal"}
        metadata = catalog.describe_table(table)
        values = temporal_values()
        values[3] = ("dt0", datetime(2024, 2, 29, 1, 2, 3))
        with self.assertRaises(OrmError) as insert:
            catalog.insert_row(metadata, values)
        self.assertEqual(insert.exception.code, codes.ROW_INSERT_INVALID)
        catalog.insert_row(metadata, temporal_values())
        original = catalog.row_snapshot_from_page(catalog.table_page(table, 10, 0), 0)
        for name in ("d", "t3", "dt6"):
            with self.subTest(column=name):
                with self.assertRaises(OrmError) as update:
                    catalog.update_row(original, [(name, datetime(2024, 3, 1))])
                self.assertEqual(update.exception.code, codes.ROW_UPDATE_INVALID)

    # Requirements: INT-101, INT-103.
    def test_described_temporal_text(self):
        from polyspec.orm.catalog import _described_temporal

        stamp = datetime(2026, 1, 2, 3, 4, 5, 123000)
        whole = datetime(2026, 1, 2, 3, 4, 5)
        aware = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        cases = [
            (
                "MySQL datetime of default precision",
                whole,
                "datetime",
                "mysql",
                "2026-01-02 03:04:05",
            ),
            (
                "MySQL datetime(3)",
                stamp,
                "datetime(3)",
                "mysql",
                "2026-01-02 03:04:05.123",
            ),
            (
                "MySQL datetime(6)",
                stamp,
                "datetime(6)",
                "mysql",
                "2026-01-02 03:04:05.123000",
            ),
            ("MySQL date", date(2024, 2, 29), "date", "mysql", "2024-02-29"),
            (
                "MySQL time(3)",
                timedelta(hours=12, minutes=34, seconds=56, microseconds=500000),
                "time(3)",
                "mysql",
                "12:34:56.500",
            ),
            (
                "MySQL time",
                timedelta(hours=12, minutes=34, seconds=56),
                "time",
                "mysql",
                "12:34:56",
            ),
            (
                "PostgreSQL timestamp text of default precision",
                "2026-01-02 03:04:05.123",
                "timestamp without time zone",
                "postgres",
                "2026-01-02 03:04:05.123000",
            ),
            (
                "PostgreSQL timestamp(3) text",
                "2026-01-02 03:04:05.123",
                "timestamp(3) without time zone",
                "postgres",
                "2026-01-02 03:04:05.123",
            ),
            ("PostgreSQL date text", "2024-02-29", "date", "postgres", "2024-02-29"),
            (
                "PostgreSQL time(3) without trailing zeros",
                "12:34:56.5",
                "time(3) without time zone",
                "postgres",
                "12:34:56.500",
            ),
            (
                "PostgreSQL time of default precision",
                "12:34:56",
                "time without time zone",
                "postgres",
                "12:34:56.000000",
            ),
            ("NULL", None, "datetime(3)", "mysql", None),
            ("not a dbspec type", aware, "timestamp with time zone", "postgres", aware),
            (
                "MySQL TIMESTAMP is not a dbspec type",
                whole,
                "timestamp",
                "mysql",
                whole,
            ),
            (
                "SQLite text of its CHECK precision",
                "12:34:56.500",
                "TIME",
                "sqlite",
                "12:34:56.500",
            ),
            ("SQLite date", "2024-02-29", "DATE", "sqlite", "2024-02-29"),
            (
                "SQLite TIME(3) is not a dbspec declaration",
                "12:34:56.5",
                "TIME(3)",
                "sqlite",
                "12:34:56.5",
            ),
        ]
        for name, value, native, dialect, want in cases:
            with self.subTest(case=name):
                column = CatalogColumn(
                    "c",
                    native,
                    True,
                    False,
                    check_precision=3 if native == "TIME" else None,
                )
                self.assertEqual(_described_temporal(value, column, dialect), want)
        refused = [
            (
                "digit past the declared precision",
                stamp,
                "datetime(2)",
                "mysql",
                codes.GRID_TEMPORAL_PRECISION,
            ),
            (
                "time digit past the declared precision",
                "12:34:56.5",
                "time",
                "mysql",
                codes.GRID_TEMPORAL_PRECISION,
            ),
            (
                "PostgreSQL digit past the declared precision",
                "12:34:56.1234",
                "time(3) without time zone",
                "postgres",
                codes.GRID_TEMPORAL_PRECISION,
            ),
            (
                "time outside a day",
                "25:00:00",
                "time",
                "mysql",
                codes.GRID_TEMPORAL_VALUE,
            ),
            (
                "MySQL time outside a day",
                timedelta(hours=25),
                "time",
                "mysql",
                codes.GRID_TEMPORAL_VALUE,
            ),
            (
                "MySQL negative time",
                timedelta(seconds=-1),
                "time",
                "mysql",
                codes.GRID_TEMPORAL_VALUE,
            ),
            (
                "MySQL zero date",
                "0000-00-00",
                "date",
                "mysql",
                codes.GRID_TEMPORAL_VALUE,
            ),
            (
                "PostgreSQL 24:00:00",
                "24:00:00",
                "time without time zone",
                "postgres",
                codes.GRID_TEMPORAL_VALUE,
            ),
            (
                "PostgreSQL infinity",
                "infinity",
                "timestamp without time zone",
                "postgres",
                codes.GRID_TEMPORAL_VALUE,
            ),
            (
                "PostgreSQL BC date",
                "0044-03-15 BC",
                "date",
                "postgres",
                codes.GRID_TEMPORAL_VALUE,
            ),
            ("aware datetime", aware, "datetime", "mysql", codes.GRID_TEMPORAL_VALUE),
            (
                "SQLite text of other digits than its CHECK",
                "12:34:56.5",
                "TIME",
                "sqlite",
                codes.GRID_TEMPORAL_PRECISION,
            ),
            (
                "SQLite time text in a DATETIME column",
                "12:34:56",
                "DATETIME",
                "sqlite",
                codes.GRID_TEMPORAL_VALUE,
            ),
            ("SQLite integer", 20240229, "DATE", "sqlite", codes.GRID_TEMPORAL_VALUE),
            (
                "SQLite date with a time",
                "2024-02-29 00:00:00",
                "DATE",
                "sqlite",
                codes.GRID_TEMPORAL_VALUE,
            ),
        ]
        for name, value, native, dialect, code in refused:
            with self.subTest(case=name):
                column = CatalogColumn(
                    "c",
                    native,
                    True,
                    False,
                    check_precision=3 if native == "TIME" else None,
                )
                with self.assertRaises(OrmError) as raised:
                    _described_temporal(value, column, dialect)
                self.assertEqual(raised.exception.code, code)

    # Requirements: INT-103.
    def test_sqlite_check_precision_of_a_column(self):
        from polyspec.orm.catalog import _check_precision

        self.assertEqual(_check_precision(TEMPORAL_DDL, "t0"), 0)
        self.assertEqual(_check_precision(TEMPORAL_DDL, "t3"), 3)
        self.assertEqual(_check_precision(TEMPORAL_DDL, "dt0"), 0)
        self.assertEqual(_check_precision(TEMPORAL_DDL, "dt6"), 6)
        self.assertIsNone(_check_precision(TEMPORAL_DDL, "missing"))
        self.assertIsNone(
            _check_precision(
                "CREATE TABLE loose (id INTEGER PRIMARY KEY, dt DATETIME)", "dt"
            )
        )

    # Requirements: INT-117.
    def test_write_comparison_is_exact_text(self):
        from polyspec.orm.catalog import _same_row

        for stored, requested, want in (
            ("2026-01-02 03:04:05.123", "2026-01-02 03:04:05.123", True),
            ("2026-01-02 03:04:05.123", "2026-01-02 03:04:05.124", False),
            ("2026-01-02 03:04:05.123", "2026-01-02 03:04:05.1230", False),
            ("12:34:56.500", "12:34:56.5", False),
            ("2026-01-02 03:04:05", datetime(2026, 1, 2, 3, 4, 5), False),
        ):
            with self.subTest(stored=stored, requested=requested):
                self.assertEqual(_same_row([stored], [requested]), want)

    # Requirements: INT-103.
    def test_mysql_read_back_returns_temporal_text(self):
        description = [
            ("c0", 8, None, None, None, 0, False),
            ("c1", 10, None, None, None, 0, True),
            ("c2", 11, None, None, None, 3, True),
            ("c3", 12, None, None, None, 3, True),
            ("c4", 7, None, None, None, 0, True),
        ]
        stamp = datetime(2026, 1, 2, 3, 4, 5)
        rows = [
            (
                1,
                date(2024, 2, 29),
                timedelta(hours=12, minutes=34, seconds=56, microseconds=500000),
                datetime(2026, 1, 2, 3, 4, 5, 123000),
                stamp,
            )
        ]
        connection = FakeConnection(description, rows)
        session = _Session("mysql", SimpleNamespace(connection=connection))
        metadata = metadata_of(
            "mysql", ["bigint", "date", "time(3)", "datetime(3)", "timestamp"]
        )
        self.assertEqual(
            session.lookup(metadata, [1], lock=False),
            [[1, "2024-02-29", "12:34:56.500", "2026-01-02 03:04:05.123", stamp]],
        )

    # Requirements: INT-103.
    def test_postgres_read_back_returns_temporal_text(self):
        from psycopg.postgres import types as pg_types
        from psycopg.types.string import TextLoader

        description = [
            ("c0", 20, None, None, None, None, False),
            ("c1", 1082, None, None, None, None, True),
            ("c2", 1083, None, None, None, None, True),
            ("c3", 1114, None, None, None, None, True),
            ("c4", 1184, None, None, None, None, True),
        ]
        aware = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        rows = [(1, "2024-02-29", "12:34:56.5", "2026-01-02 03:04:05.123", aware)]
        connection = FakeConnection(description, rows)
        session = _Session("postgres", SimpleNamespace(connection=connection))
        metadata = metadata_of(
            "postgres",
            [
                "bigint",
                "date",
                "time(3) without time zone",
                "timestamp without time zone",
                "timestamp with time zone",
            ],
        )
        self.assertEqual(
            session.lookup(metadata, [1], lock=False),
            [[1, "2024-02-29", "12:34:56.500", "2026-01-02 03:04:05.123000", aware]],
        )
        self.assertEqual(
            sorted(connection.loaders, key=lambda item: item[0]),
            sorted(
                (
                    (pg_types[name].oid, TextLoader)
                    for name in ("date", "time", "timestamp")
                ),
                key=lambda item: item[0],
            ),
        )


if __name__ == "__main__":
    testcase.main()
