import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

from . import testcase
from polyspec.orm import codes
from polyspec.orm.catalog import (
    CatalogColumn,
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


class CatalogDescribedTemporalTest(unittest.TestCase):
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

    def test_described_temporal_text(self):
        stamp = datetime(2026, 1, 2, 3, 4, 5, 123000)
        whole = datetime(2026, 1, 2, 3, 4, 5)
        aware = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        # A MySQL value carries the field type of its column, a PostgreSQL text the cell class of its type OID.
        mysql_codes = {"date": 10, "time": 11, "datetime": 12, "timestamp": 7}
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
                b"2026-01-02 03:04:05.123",
                "timestamp(3) without time zone",
                "postgres",
                "2026-01-02 03:04:05.123",
            ),
            ("PostgreSQL date text", b"2024-02-29", "date", "postgres", "2024-02-29"),
            (
                "PostgreSQL time(3) without trailing zeros",
                b"12:34:56.5",
                "time(3) without time zone",
                "postgres",
                "12:34:56.500",
            ),
            (
                "PostgreSQL time of default precision",
                b"12:34:56",
                "time without time zone",
                "postgres",
                "12:34:56.000000",
            ),
            ("NULL", None, "datetime(3)", "mysql", None),
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
            (
                "SQLite TIME(3) holds a text that is no time",
                "abc",
                "TIME(3)",
                "sqlite",
                "abc",
            ),
        ]
        for name, value, native, dialect, want in cases:
            with self.subTest(case=name):
                self.assertEqual(_described(native, dialect, value, mysql_codes), want)
        refused = [
            (
                "a zoned PostgreSQL value",
                b"2026-01-02 03:04:05+00",
                "timestamp with time zone",
                "postgres",
                "CATALOG_VALUE: column 2: PostgreSQL timestamptz and timetz are unsupported",
            ),
            (
                "a MySQL TIMESTAMP",
                whole,
                "timestamp",
                "mysql",
                "CATALOG_VALUE: column 2: MySQL TIMESTAMP follows a time zone",
            ),
            (
                "digit past the declared precision",
                stamp,
                "datetime(2)",
                "mysql",
                "GRID_TEMPORAL_PRECISION: column 2: temporal value has more fraction digits than its precision",
            ),
            (
                "PostgreSQL digit past the declared precision",
                b"12:34:56.1234",
                "time(3) without time zone",
                "postgres",
                "GRID_TEMPORAL_PRECISION: column 2: temporal value has more fraction digits than its precision",
            ),
            (
                "a native type of more than 6 fraction digits",
                stamp,
                "datetime(7)",
                "mysql",
                "GRID_TEMPORAL_PRECISION: column 2: native type declares more than 6 fraction digits",
            ),
            (
                "MySQL time outside a day",
                timedelta(hours=25),
                "time",
                "mysql",
                "GRID_TEMPORAL_VALUE: column 2: time outside 00:00:00 to 23:59:59.999999",
            ),
            (
                "MySQL negative time",
                timedelta(seconds=-1),
                "time",
                "mysql",
                "GRID_TEMPORAL_VALUE: column 2: time outside 00:00:00 to 23:59:59.999999",
            ),
            (
                "MySQL zero date",
                "0000-00-00",
                "date",
                "mysql",
                "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31",
            ),
            (
                "MySQL invalid calendar date",
                "2024-02-30",
                "date",
                "mysql",
                "GRID_TEMPORAL_VALUE: column 2: date is not a calendar date",
            ),
            (
                "PostgreSQL 24:00:00",
                b"24:00:00",
                "time without time zone",
                "postgres",
                "GRID_TEMPORAL_VALUE: column 2: time outside 00:00:00 to 23:59:59.999999",
            ),
            (
                "PostgreSQL infinity",
                b"infinity",
                "timestamp without time zone",
                "postgres",
                "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31",
            ),
            (
                "PostgreSQL BC date",
                b"0044-03-15 BC",
                "date",
                "postgres",
                "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31",
            ),
            (
                "aware datetime",
                aware,
                "datetime",
                "mysql",
                "CATALOG_VALUE: column 2: unsupported driver value",
            ),
            (
                "SQLite text of other digits than its CHECK",
                "12:34:56.5",
                "TIME",
                "sqlite",
                "GRID_TEMPORAL_PRECISION: column 2: the fraction digits are not the count that its dbspec CHECK fixes",
            ),
            (
                "SQLite time text in a DATETIME column",
                "12:34:56",
                "DATETIME",
                "sqlite",
                "GRID_TEMPORAL_VALUE: column 2: the stored value is not a dbspec datetime",
            ),
            (
                "SQLite integer",
                20240229,
                "DATE",
                "sqlite",
                "GRID_TEMPORAL_VALUE: column 2: the stored value is not a dbspec date",
            ),
            (
                "SQLite date with a time",
                "2024-02-29 00:00:00",
                "DATE",
                "sqlite",
                "GRID_TEMPORAL_VALUE: column 2: the stored value is not a dbspec date",
            ),
            (
                "SQLite time of the year 0",
                "0000-01-01",
                "DATE",
                "sqlite",
                "GRID_TEMPORAL_VALUE: column 2: date outside 0001-01-01 to 9999-12-31",
            ),
            (
                "SQLite time outside a day",
                "24:00:00.500",
                "TIME",
                "sqlite",
                "GRID_TEMPORAL_VALUE: column 2: time outside 00:00:00 to 23:59:59.999999",
            ),
        ]
        for name, value, native, dialect, message in refused:
            with self.subTest(case=name):
                with self.assertRaises(OrmError) as raised:
                    _described(native, dialect, value, mysql_codes)
                self.assertEqual(str(raised.exception), message)


def _described(native: str, dialect: str, value, mysql_codes: dict):
    """The described value of one value of a column of the native type at position 2 of its table."""
    from polyspec.orm.catalog import _PG_CLASSES, _described_value

    column = CatalogColumn(
        "c", native, True, False, check_precision=3 if native == "TIME" else None
    )
    base = native.split("(")[0].split(" ")[0]
    code = mysql_codes.get(base) if dialect == "mysql" else None
    cls = None
    if dialect == "postgres":
        zoned = "with time zone" in native
        cls = (
            "zoned"
            if zoned
            else _PG_CLASSES[{"date": 1082, "time": 1083, "timestamp": 1114}[base]]
        )
    return _described_value(value, column, dialect, code, 2, cls)


if __name__ == "__main__":
    testcase.main()
