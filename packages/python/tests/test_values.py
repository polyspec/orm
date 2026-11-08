# Checks that value functions and column functions build IR, and codec unit cases (unittest).
import unittest
import math


from polyspec.orm.codec import (
    CodecError,
    encode,
)
from polyspec.orm.errors import OrmError
from polyspec.orm.styled_value import StyledValue
from polyspec.orm.database import convert
from . import testcase


class DatabaseCellConversionTest(unittest.TestCase):
    def test_non_finite_float_cells_are_codec_decode(self):
        for value in (float("nan"), float("inf"), float("-inf"), 10**1000):
            with self.subTest(value=value):
                with self.assertRaises(OrmError) as raised:
                    convert("f64", value, "+00:00")
                self.assertEqual(raised.exception.code, "CODEC_DECODE")
        self.assertTrue(math.isfinite(convert("f64", 1.25, "+00:00")))
        # An integer cell of an f64 column reads as the nearest f64, as in every client (COD-1).
        self.assertEqual(convert("f64", 2**63 - 1, "+00:00"), float(2**63 - 1))


class ValueFunctionTest(unittest.TestCase):
    # Requirements: PRT-77.
    def test_a_naive_cell_is_in_the_connection_zone_whatever_the_process_zone(self):
        import datetime
        import os
        import time
        from polyspec.orm.database import read_time, time_value

        saved = os.environ.get("TZ")
        os.environ["TZ"] = "Asia/Seoul"
        time.tzset()
        try:
            cell = datetime.datetime(2026, 10, 11, 6, 7, 8, 123456)
            self.assertEqual(
                read_time(cell, "datetime", "+00:00", 6), "2026-10-11 06:07:08.123456"
            )
            self.assertEqual(
                time_value(cell, "datetime", "+00:00", 6), "2026-10-11 06:07:08.123456"
            )
            self.assertEqual(
                read_time(cell, "datetime", "+09:00", 6), "2026-10-11 06:07:08.123456"
            )
            # A value with a time zone is converted to the connection's time zone.
            aware = cell.replace(tzinfo=datetime.timezone.utc)
            self.assertEqual(
                read_time(aware, "datetime", "+09:00", 6), "2026-10-11 15:07:08.123456"
            )
        finally:
            if saved is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = saved
            time.tzset()


class NativeTimeReadTest(unittest.TestCase):
    """PyMySQL reads a TIME cell as timedelta and psycopg as datetime.time; a DATE cell is a date. read_time
    takes each as the text form, and a value it cannot read is CODEC_DECODE, never another exception."""

    def test_driver_time_and_date_cells_read_as_text(self):
        import datetime
        from polyspec.orm.database import read_time

        cases = [
            (
                datetime.timedelta(
                    hours=10, minutes=11, seconds=12, microseconds=345000
                ),
                "time",
                3,
                "10:11:12.345",
            ),
            (
                datetime.timedelta(hours=10, minutes=11, seconds=12),
                "time",
                0,
                "10:11:12",
            ),
            (datetime.time(10, 11, 12, 345000), "time", 3, "10:11:12.345"),
            (datetime.time(0, 0, 0), "time", 0, "00:00:00"),
            (datetime.date(2026, 6, 1), "date", 0, "2026-06-01"),
        ]
        for value, col_type, precision, text in cases:
            with self.subTest(value=repr(value), col_type=col_type):
                self.assertEqual(read_time(value, col_type, "+00:00", precision), text)

    def test_driver_time_cells_outside_the_form_are_codec_decode(self):
        import datetime
        from polyspec.orm.database import read_time

        cases = [
            (datetime.timedelta(hours=24), "time", 3),
            (datetime.timedelta(seconds=-1), "time", 3),
            (datetime.timedelta(hours=1, microseconds=5), "time", 0),
            (datetime.time(10, 11, 12, 1), "time", 0),
            (datetime.timedelta(days=1), "date", 0),
            (object(), "date", 0),
            (object(), "time", 0),
        ]
        for value, col_type, precision in cases:
            with self.subTest(value=repr(value), col_type=col_type):
                with self.assertRaises(OrmError) as caught:
                    read_time(value, col_type, "+00:00", precision)
                self.assertEqual(caught.exception.code, "CODEC_DECODE")


class TypedBooleanCellTest(unittest.TestCase):
    def test_boolean_cells_accept_only_declared_boolean_forms(self):
        for value, expected in (
            (True, True),
            (False, False),
            (1, True),
            (0, False),
            ("1", True),
            ("0", False),
            ("t", True),
            ("f", False),
            ("true", True),
            ("false", False),
        ):
            with self.subTest(value=value):
                self.assertIs(convert("bool", value, "+00:00"), expected)
        for value in (2, -1, 1.5, "2", "yes"):
            with self.subTest(value=value):
                with self.assertRaises(OrmError) as caught:
                    convert("bool", value, "+00:00")
                self.assertEqual(caught.exception.code, "CODEC_DECODE")


class RuntimeValueTypesDatabaseTest(unittest.TestCase):
    """INT-99 database reads preserve declared types, defaults and selected styled SQL NULL."""

    @classmethod
    def setUpClass(cls):
        import tempfile
        from pathlib import Path
        from .test_sqlite import generate_document

        cls.tmp = tempfile.TemporaryDirectory(prefix="orm-python-runtime-value-types-")
        cls.addClassCleanup(cls.tmp.cleanup)
        document = Path(cls.tmp.name) / "value_types.dbs"
        document.write_text(
            "dbspec 1 value_types\n\n"
            "table value_record {\n"
            "  seq i64 identity\n"
            "  small i16\n"
            "  rank i16 default 3\n"
            "  wide i64\n"
            "  ratio f64\n"
            "  active bool\n"
            "  code uuid\n"
            "  opens time(3)\n"
            "  day date\n"
            "  note varchar(20) null\n"
            "  payload text null\n"
            "  primary key (seq)\n"
            "  settings {\n"
            "    select explicit note\n"
            "    codec payload ordered_json\n"
            "  }\n"
            "}\n",
            encoding="utf-8",
        )
        cls.models = generate_document(str(Path(cls.tmp.name) / "generated"), document)

    def run_case(self, driver, body):
        from .case_database import case_database

        with case_database(driver, self.tmp.name, "runtime_values") as dsn:
            db = self.models.connect(dsn)
            try:
                db.utils().schema().install(self.models.SCHEMA)
                row = (
                    self.models.ValueRecord()
                    .connect(db)
                    .set_small(-32768)
                    .set_wide(42)
                    .set_ratio(1.25)
                    .set_active(False)
                    .set_code("0f0e0d0c-0b0a-4908-8706-050403020100")
                    .set_opens("08:30:00.250")
                    .set_day("2026-01-02")
                    .create()
                )
                body(db, row.get_seq())
            finally:
                db.close()

    # Requirements: INT-99, DBS-68, COD-20.
    # Requirements: INT-147, DIA-48, PRT-67.
    def test_runtime_value_types_and_styled_sql_null_read(self):
        uuid = "0f0e0d0c-0b0a-4908-8706-050403020100"
        for driver in ("sqlite", "mysql", "postgres"):
            with self.subTest(driver=driver):

                def check(db, seq):
                    row = self.models.ValueRecord().connect(db).get_by_seq(seq)
                    self.assertEqual(row.get_small(), -32768)
                    self.assertEqual(row.get_rank(), 3)
                    self.assertEqual(row.get_code(), uuid)
                    self.assertEqual(row.get_opens(), "08:30:00.250")
                    self.assertEqual(row.get_day(), "2026-01-02")
                    self.assertEqual(row.get_payload().kind, "sql-null")
                    selected = (
                        self.models.ValueRecord()
                        .connect(db)
                        .add_column_note()
                        .get_by_seq(seq)
                    )
                    self.assertIsNone(selected.get_note())

                self.run_case(driver, check)


class StyledValueTest(unittest.TestCase):
    def test_sql_null_has_no_payload(self):
        with self.assertRaises(OrmError):
            StyledValue.sql_null().payload()
        self.assertIsNone(encode(["serialize"], StyledValue.sql_null()))

    def test_a_cycle_is_no_codec_value(self):
        # A cycle is a value that no recipe wrapper holds (FCV-2): each value stage refuses it by its rule of COD-70, the
        # ordered_json stage as the nesting that it exceeds.
        value = {}
        value["self"] = value
        for styles, message in (
            (["serialize"], "CODEC_ENCODE: serialize: the value is not a codec value"),
            (["yaml"], "CODEC_ENCODE: yaml: the value is not a codec value"),
            (["ordered_json"], "CODEC_ENCODE: json: value nesting exceeds 256 levels"),
        ):
            with self.subTest(styles=styles):
                with self.assertRaises(CodecError) as caught:
                    encode(styles, StyledValue.value(value))
                self.assertEqual(str(caught.exception), message)


if __name__ == "__main__":
    testcase.main()
