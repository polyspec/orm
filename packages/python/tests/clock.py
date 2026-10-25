# The clock of datetime(6) columns on SQLite, MySQL and PostgreSQL, with the fixtures contracts/fixtures/clock.dbs and
# clock_mark.dbs, as packages/ts/tests/clock.mjs and packages/go/orm/clock_test.go run them. An insert that omits created_ts
# (default now) and a soft deletion store a value with six fraction digits near the wall clock: MySQL takes
# CURRENT_TIMESTAMP(6), and PostgreSQL and SQLite take the text that the executor binds to the `now` slot
# (docs/spec/dialects.md DIA-18). A clock with millisecond resolution stores every value as `.mmm000`, so at least one of
# sixteen values ends in other digits. A row read right after its insert matches created_ts <= now() and
# created_ts <= seconds_later(0) (DSL-137, DIA-56). Each case runs on a case database of its own; MySQL and PostgreSQL need
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
# Requirements: DIA-18, DIA-56, DSL-137.
# Usage: python -m packages.python.tests.clock
import datetime
import os
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from polyspec.orm import orm
from polyspec.orm.database import Db

from . import testcase
from .case_database import case_database
from .runner_connect import mysql_connect
from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
TEMP = {}
SIX_DIGITS = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$")


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-clock-")
    fixtures = ROOT / "contracts" / "fixtures"
    TEMP["clock"] = generate_document(
        os.path.join(TEMP["dir"].name, "clock"), fixtures / "clock.dbs"
    )
    TEMP["mark"] = generate_document(
        os.path.join(TEMP["dir"].name, "mark"), fixtures / "clock_mark.dbs"
    )


def tearDownModule():
    TEMP["dir"].cleanup()


def stamp_text(value) -> str:
    """The stored value as `YYYY-MM-DD HH:MM:SS.ffffff`: the text a driver returns, or a datetime written so."""
    if isinstance(value, datetime.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S.%f")
    return str(value)


def read_deleted_at(dsn: str) -> list[str]:
    """deleted_at of every clock_mark row in seq order, read with the database driver as text of six fraction digits,
    since a model read excludes a soft-deleted row."""
    url = urlsplit(dsn)
    if url.scheme == "mysql":
        conn = mysql_connect(dsn, url.path.lstrip("/"))
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    "SELECT DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s.%f') FROM clock_mark ORDER BY seq"
                )
                return [row[0] for row in cursor.fetchall()]
        finally:
            conn.close()
    if url.scheme == "postgres":
        with psycopg.connect(dsn) as conn:
            rows = conn.execute(
                "SELECT to_char(deleted_at, 'YYYY-MM-DD HH24:MI:SS.US') FROM clock_mark ORDER BY seq"
            ).fetchall()
            return [row[0] for row in rows]
    with sqlite3.connect(url.path) as conn:
        rows = conn.execute("SELECT deleted_at FROM clock_mark ORDER BY seq").fetchall()
    conn.close()
    return [row[0] for row in rows]


class ClockTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def installed(self, dialect: str, models, body) -> None:
        """Runs body(db, dsn) on a Db with the document of models installed in a new case database of dialect."""
        with case_database(dialect, TEMP["dir"].name, "orm_clock") as dsn:
            db = Db.connect_schema(dsn, models.SCHEMA)
            try:
                db.utils().schema().install(models.SCHEMA)
                body(db, dsn)
            finally:
                db.close()

    def clock_microseconds(self, dialect: str) -> None:
        """Sixteen inserts in separate statements store created_ts with six fraction digits near the wall clock, and
        at least one value has a microsecond that a millisecond clock cannot give."""
        models = TEMP["clock"]

        def body(db, dsn):
            before = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
            for i in range(16):
                models.ClockEvent().connect(db).set_label(f"event-{i}").create()
            after = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
            rows = list(models.ClockEvent().connect(db).order_by_seq_asc().gets())
            self.assertEqual(len(rows), 16)
            stamps = [stamp_text(row.get_created_ts()) for row in rows]
            for stamp in stamps:
                self.assertRegex(
                    stamp,
                    SIX_DIGITS,
                    f"{dialect}: created_ts {stamp} has six fraction digits",
                )
                at = datetime.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S.%f")
                low = before - datetime.timedelta(milliseconds=1)
                high = after + datetime.timedelta(milliseconds=1)
                self.assertTrue(
                    low <= at <= high,
                    f"{dialect}: created_ts {stamp} lies between {before} and {after}",
                )
            self.assertTrue(
                any(not stamp.endswith("000") for stamp in stamps),
                f"{dialect}: every created_ts ends in 000: {stamps}",
            )

        self.installed(dialect, models, body)

    def clock_soft_delete_microseconds(self, dialect: str) -> None:
        """Sixteen soft deletions in separate statements store deleted_at with six fraction digits, and at least one
        value has a microsecond that a millisecond clock cannot give."""
        models = TEMP["mark"]

        def body(db, dsn):
            for i in range(16):
                models.ClockMark().connect(db).set_label(f"mark-{i}").create().delete()
            stamps = read_deleted_at(dsn)
            self.assertEqual(len(stamps), 16)
            for stamp in stamps:
                self.assertRegex(
                    str(stamp),
                    SIX_DIGITS,
                    f"{dialect}: deleted_at {stamp} has six fraction digits",
                )
            self.assertTrue(
                any(not str(stamp).endswith("000") for stamp in stamps),
                f"{dialect}: every deleted_at ends in 000: {stamps}",
            )

        self.installed(dialect, models, body)

    def clock_now_condition(self, dialect: str) -> None:
        """Sixteen rows are read back right after their insert with created_ts <= now() and created_ts <=
        seconds_later(0): the clock of the condition is not earlier than the stored creation time."""
        models = TEMP["mark"]

        def body(db, dsn):
            for i in range(16):
                seq = (
                    models.ClockMark()
                    .connect(db)
                    .set_label(f"mark-{i}")
                    .create()
                    .get_seq()
                )
                for name, value in (
                    ("now()", orm.now()),
                    ("seconds_later(0)", orm.seconds_later(0)),
                ):
                    found = (
                        models.ClockMark()
                        .connect(db)
                        .seq(seq)
                        .and_le_created_ts(value)
                        .get_count()
                    )
                    self.assertEqual(
                        found, 1, f"{dialect}: row {seq} with created_ts <= {name}"
                    )

        self.installed(dialect, models, body)

    def test_clock_microseconds_sqlite(self):
        self.clock_microseconds("sqlite")

    def test_clock_microseconds_mysql(self):
        self.clock_microseconds("mysql")

    def test_clock_microseconds_postgres(self):
        self.clock_microseconds("postgres")

    def test_clock_soft_delete_microseconds_sqlite(self):
        self.clock_soft_delete_microseconds("sqlite")

    def test_clock_soft_delete_microseconds_mysql(self):
        self.clock_soft_delete_microseconds("mysql")

    def test_clock_soft_delete_microseconds_postgres(self):
        self.clock_soft_delete_microseconds("postgres")

    def test_clock_now_condition_sqlite(self):
        self.clock_now_condition("sqlite")

    def test_clock_now_condition_mysql(self):
        self.clock_now_condition("mysql")

    def test_clock_now_condition_postgres(self):
        self.clock_now_condition("postgres")


if __name__ == "__main__":
    testcase.main()
