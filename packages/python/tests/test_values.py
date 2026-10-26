# Checks that value functions and column functions build IR, and codec unit cases (unittest).
import unittest
import json


from polyspec.orm.codec import (
    CodecError,
    decode,
    encode,
    host_decode,
    host_encode,
    php_serialize,
)
from polyspec.orm.errors import OrmError
from polyspec.orm.styled_value import StyledValue
from polyspec.orm.values import ColumnFunction, ValueFunction, orm
from . import testcase


class ValueFunctionTest(unittest.TestCase):
    # Requirements: PRT-77.
    def test_ir_carry_name_and_parameters(self):
        params = ["preceding"]
        self.assertEqual(
            orm.seconds_ago(30).ir(lambda v: params.append(v) or len(params) - 1),
            {"name": "seconds_ago", "ps": [1]},
        )
        self.assertEqual(
            json.dumps(orm.seconds_ago(30).ir(lambda v: 0), separators=(",", ":")),
            '{"name":"seconds_ago","ps":[0]}',
        )
        self.assertEqual(
            json.dumps(orm.now().ir(lambda v: 0), separators=(",", ":")),
            '{"name":"now"}',
        )
        self.assertIsInstance(orm.day_of_week(), ColumnFunction)
        self.assertIsInstance(orm.months_later(3), ValueFunction)
        self.assertEqual(orm.year().name, "year")


class NaiveDatetimeTest(unittest.TestCase):
    """MySQL and PostgreSQL drivers return a datetime without a time zone in the connection's time zone. The process's local
    time zone (TZ) does not change that value."""

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
                    self.assertNotIn("note", row.to_array())
                    selected = (
                        self.models.ValueRecord()
                        .connect(db)
                        .add_column_note()
                        .get_by_seq(seq)
                    )
                    self.assertIsNone(selected.get_note())

                self.run_case(driver, check)

    # Requirements: INT-98.
    def test_invalid_database_cells_fail_typed_reads(self):
        from polyspec.orm.errors import OrmError

        def read_column(db, seq, column):
            query = self.models.ValueRecord().connect(db).remove_all_columns()
            getattr(query, f"add_column_{column}")()
            return query.get_by_seq(seq)

        for driver in ("sqlite", "mysql", "postgres"):
            with self.subTest(driver=driver):

                def check(db, seq):
                    if driver == "mysql":
                        db._connection.execute(
                            "ALTER TABLE value_record MODIFY wide BIGINT UNSIGNED", []
                        )
                        db._connection.execute(
                            "UPDATE value_record SET wide = 18446744073709551615 WHERE seq = ?",
                            [seq],
                        )
                        with self.assertRaises(OrmError) as caught:
                            read_column(db, seq, "wide").get_wide()
                        self.assertEqual(caught.exception.code, "CODEC_DECODE")
                        db._connection.execute(
                            "ALTER TABLE value_record DROP CHECK `value_record$active`",
                            [],
                        )
                        db._connection.execute(
                            "UPDATE value_record SET wide = 42, active = 2 WHERE seq = ?",
                            [seq],
                        )
                        with self.assertRaises(OrmError) as caught:
                            read_column(db, seq, "active").get_active()
                        self.assertEqual(caught.exception.code, "CODEC_DECODE")
                    elif driver == "postgres":
                        db._connection.execute(
                            "UPDATE value_record SET ratio = 'NaN' WHERE seq = $1",
                            [seq],
                        )
                        with self.assertRaises(OrmError) as caught:
                            read_column(db, seq, "ratio").get_ratio()
                        self.assertEqual(caught.exception.code, "CODEC_DECODE")
                    else:
                        db._connection.execute(
                            "PRAGMA ignore_check_constraints = ON", []
                        )
                        try:
                            db._connection.execute(
                                "UPDATE value_record SET wide = 'not-an-integer' WHERE seq = ?",
                                [seq],
                            )
                        finally:
                            db._connection.execute(
                                "PRAGMA ignore_check_constraints = OFF", []
                            )
                        with self.assertRaises(OrmError) as caught:
                            read_column(db, seq, "wide").get_wide()
                        self.assertEqual(caught.exception.code, "CODEC_DECODE")

                self.run_case(driver, check)


class HostCodecTest(unittest.TestCase):
    def test_ip_round_trip(self):
        for address in ["127.0.0.1", "255.255.255.255", "2001:db8::1", "::1", "fe80::"]:
            packed = host_encode(address, ["ip"], "")
            self.assertIsInstance(packed, bytes)
            self.assertEqual(host_decode(packed, ["ip"], ""), address)

    def test_mapped_ipv6_writes_four_bytes(self):
        # A v4 mapped address is stored in 4 bytes and comes back in v4 form.
        packed = host_encode("::ffff:192.168.0.1", ["ip"], "")
        self.assertEqual(packed, bytes([192, 168, 0, 1]))
        self.assertEqual(host_decode(packed, ["ip"], ""), "192.168.0.1")

    def test_ip_rejects_a_non_address(self):
        with self.assertRaises(CodecError) as caught:
            host_encode("not-an-address", ["ip"], "")
        self.assertEqual(caught.exception.code, "CODEC_ENCODE")

    def test_hex_stage(self):
        encoded = host_encode("value", ["hex"], "")
        self.assertEqual(encoded, "76616C7565")
        self.assertEqual(host_decode(encoded, ["hex"], ""), "value")

    def test_hex_rejects_odd_and_non_hex(self):
        for raw in ["1", "zz"]:
            with self.assertRaises(CodecError) as caught:
                host_decode(raw, ["hex"], "")
            self.assertEqual(caught.exception.code, "CODEC_DECODE")

    def test_aes_requires_a_key(self):
        with self.assertRaises(CodecError):
            host_encode("value", ["aes"], "")
        with self.assertRaises(CodecError):
            host_decode(b"x", ["aes"], "")


class SerializeTest(unittest.TestCase):
    def test_scalars_and_containers(self):
        self.assertEqual(php_serialize(None), "N;")
        self.assertEqual(php_serialize(True), "b:1;")
        self.assertEqual(php_serialize(False), "b:0;")
        self.assertEqual(php_serialize(42), "i:42;")
        self.assertEqual(php_serialize(-7), "i:-7;")
        self.assertEqual(php_serialize(1.5), "d:1.5;")
        self.assertEqual(php_serialize(2.0), "d:2.0;")
        self.assertEqual(php_serialize("ab"), 's:2:"ab";')
        self.assertEqual(php_serialize([1, "b"]), 'a:2:{i:0;i:1;i:1;s:1:"b";}')
        self.assertEqual(
            php_serialize({"b": 1, "a": 2}), 'a:2:{s:1:"a";i:2;s:1:"b";i:1;}'
        )
        self.assertEqual(php_serialize({"2": "x"}), 'a:1:{i:2;s:1:"x";}')

    def test_utf8_length_is_bytes(self):
        self.assertEqual(php_serialize("말"), 's:3:"말";')
        decoded = decode(["serialize"], 's:3:"맛";'.encode("utf-8"))
        self.assertEqual(decoded.payload(), "맛")

    def test_unsafe_integers_fail(self):
        with self.assertRaises(CodecError):
            php_serialize(2**53)
        with self.assertRaises(CodecError):
            php_serialize(-(2**53) - 1)


class StyledValueTest(unittest.TestCase):
    def test_sql_null_has_no_payload(self):
        with self.assertRaises(OrmError):
            StyledValue.sql_null().payload()
        self.assertIsNone(encode(["serialize"], StyledValue.sql_null()))

    def test_rejects_unsupported_payloads(self):
        for value in [
            float("nan"),
            float("inf"),
            object(),
            {"a": float("nan")},
            b"bytes",
        ]:
            with self.assertRaises(OrmError) as caught:
                StyledValue.value(value).payload()
            self.assertEqual(caught.exception.code, "CODEC_ENCODE")

    def test_rejects_a_cycle(self):
        value = {}
        value["self"] = value
        with self.assertRaises(OrmError):
            StyledValue.value(value).payload()

    def test_deep_nesting_is_bounded(self):
        value = current = {}
        for _ in range(257):
            current["n"] = {}
            current = current["n"]
        with self.assertRaises(OrmError):
            StyledValue.value(value).payload()


class CodecStageTest(unittest.TestCase):
    def test_empty_cell_fails(self):
        with self.assertRaises(CodecError):
            decode(["serialize"], b"")

    def test_stage_after_a_value_fails(self):
        with self.assertRaises(CodecError) as caught:
            decode(["serialize", "base64"], b"a:0:{}")
        self.assertEqual(caught.exception.code, "CODEC_DECODE")

    def test_gz_must_be_last_on_encode(self):
        with self.assertRaises(CodecError) as caught:
            encode(["gz", "base64"], StyledValue.value("text"))
        self.assertEqual(caught.exception.code, "CODEC_UNSUPPORTED")

    def test_first_gz_takes_a_string(self):
        import zlib
        import base64

        raw = encode(["gz"], StyledValue.value("payload"))
        self.assertIsInstance(raw, bytes)
        self.assertEqual(zlib.decompress(raw, 47), b"payload")
        with self.assertRaises(CodecError):
            encode(["gz"], StyledValue.value({"a": 1}))
        encoded = encode(["base64", "gz"], StyledValue.value("payload"))
        self.assertIsInstance(encoded, bytes)
        self.assertEqual(base64.b64decode(zlib.decompress(encoded, 47)), b"payload")

    # Requirements: COD-16.
    def test_ordered_json_decode_keeps_member_order(self):
        from polyspec.ordered_json import Value, stringify

        text = '{"b":1,"a":[],"c":{},"n":1.50}'
        decoded = decode(["ordered_json"], text.encode())
        payload = decoded.payload()
        self.assertIsInstance(payload, Value)
        self.assertEqual(list(payload.members()), ["b", "a", "c", "n"])
        self.assertEqual(stringify(payload), text)
        self.assertEqual(encode(["ordered_json"], StyledValue.value(payload)), text)

    def test_base64_decode_rejects_bad_input(self):
        with self.assertRaises(CodecError):
            decode(["serialize", "base64"], b"%%%")
        with self.assertRaises(CodecError):
            decode(["serialize", "base64"], b"abc")


if __name__ == "__main__":
    testcase.main()
