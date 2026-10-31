# Every connection reads and writes datetime values in UTC whatever the server zone (docs/spec/dialects.md "Date and time",
# docs/operations/interface-implementation.md IF-02), the case of TestConnectionsUseUTC, connectionUtc of
# packages/php/tests/ModelTest.php and connectionsUseUtc of packages/ts/tests/model.mjs: the MySQL server of the tests
# runs in SYSTEM (KST) and the PostgreSQL server in Asia/Seoul. An instant with an offset is stored as its UTC wall
# clock, the clock default is UTC, and the filters by instant and by text find the row; a DSN timezone other than UTC
# or +00:00 is CONFIG. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable
# fails the case.
# Usage: python -m packages.python.tests.connection_utc
import datetime
import os
import tempfile
import unittest

from polyspec.orm.database import connect, parse_dsn
from polyspec.orm.errors import OrmError
from . import testcase

DIALECTS = ("sqlite", "mysql", "postgres")
TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-connection-utc-")


def tearDownModule():
    TEMP["dir"].cleanup()


def code_of(run):
    try:
        run()
    except OrmError as error:
        return error.code
    return None


def with_zone(dsn: str, zone: str) -> str:
    if zone == "":
        return dsn
    return dsn + ("&" if "?" in dsn else "?") + "timezone=" + zone.replace("+", "%2B")


class DsnTimezoneTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    # Requirements: CFG-26.
    def test_sqlite_dsn_requires_absolute_path(self):
        with self.assertRaises(OrmError) as raised:
            parse_dsn("sqlite://relative.sqlite")
        self.assertEqual(raised.exception.code, "CONFIG")
        self.assertEqual(parse_dsn("sqlite:///tmp/orm-example.sqlite").driver, "sqlite")

    # Requirements: CFG-26. A SQLite DSN with a query creates the file from the path alone. An opener that puts the
    # query in the file name creates a file such as `named.sqlite?_pragma=…` (docs/spec/dialects.md "Probe environment").
    def test_sqlite_file_name_is_the_path(self):
        with tempfile.TemporaryDirectory(prefix="orm-python-sqlite-name-") as directory:
            connect(
                f"sqlite://{directory}/named.sqlite?_pragma=busy_timeout(5000)&timezone=%2B00:00"
            ).close()
            names = sorted(os.listdir(directory))
        self.assertIn("named.sqlite", names, f"files {names}: named.sqlite is missing")
        allowed = (
            "named.sqlite",
            "named.sqlite-journal",
            "named.sqlite-shm",
            "named.sqlite-wal",
        )
        for name in names:
            self.assertIn(
                name, allowed, f"files {names}: {name} is not named by the path"
            )

    # Every client rejects a DSN timezone other than UTC before opening a connection (CFG-2).
    def test_dsn_rejects_non_utc_timezones(self):
        for dsn in (
            "mysql://root@localhost/orm_example?timezone=%2B09:00",
            "postgres://root@localhost/orm_example?timezone=Asia/Seoul",
            "sqlite:///tmp/orm_example.sqlite?timezone=Asia%2FSeoul",
        ):
            with self.subTest(dsn=dsn):
                with self.assertRaises(OrmError, msg=f"accepted {dsn}") as raised:
                    parse_dsn(dsn)
                self.assertEqual(raised.exception.code, "CONFIG", dsn)
        for dsn in (
            "mysql://root@localhost/orm_example",
            "postgres://root@localhost/orm_example?timezone=UTC",
            "sqlite:///tmp/orm_example.sqlite?timezone=%2B00:00",
        ):
            with self.subTest(dsn=dsn):
                self.assertEqual(parse_dsn(dsn).zone, "+00:00", dsn)


class ConnectionUtcTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def connections_use_utc(self, dialect: str, db) -> None:
        from .models import models
        from .bench_set import install_bench

        install_bench(db)
        user = models.User().connect(db).set_name("zone-user").create()
        service = models.Service().connect(db).set_name("zone-service").create()
        region = (
            models.ServiceRegion()
            .connect(db)
            .set_service_seq(service.get_seq())
            .set_name("zone-region")
            .create()
        )
        member = (
            models.ServiceMember()
            .connect(db)
            .set_service_seq(service.get_seq())
            .set_user_seq(user.get_seq())
            .create()
        )
        before = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
        created = (
            models.Author()
            .connect(db)
            .set_name("zone")
            .set_user_seq(user.get_seq())
            .set_service_seq(service.get_seq())
            .set_service_region_seq(region.get_seq())
            .set_service_member_seq(member.get_seq())
            .set_start_dt("2026-01-02T00:00:00+09:00")
            .set_end_dt("2026-01-03 00:00:00")
            .create()
        )

        def author():
            return models.Author().connect(db)

        row = author().get_by_seq(created.get_seq())
        self.assertEqual(row.get_start_dt(), "2026-01-01 15:00:00.000000", "start_dt")
        wall = datetime.datetime.fromisoformat(row.get_created_ts()[:23])
        self.assertLess(
            abs((wall - before).total_seconds()),
            60,
            f"created_ts {row.get_created_ts()} at {before.isoformat()}",
        )
        self.assertEqual(
            author().start_dt("2026-01-02T00:00:00+09:00").get_count(),
            1,
            "equality filter with an instant",
        )
        self.assertEqual(
            author().start_dt("2026-01-01 15:00:00").get_count(),
            1,
            "equality filter by text",
        )
        self.assertEqual(
            author().start_dt("2026-01-01T15:00:00.0").get_count(),
            1,
            "equality filter by text with fraction",
        )
        self.assertEqual(
            author()
            .start_dt(["2026-01-01 15:00:00", "2026-01-03 00:00:00"])
            .get_count(),
            1,
            "in filter by text",
        )
        self.assertEqual(
            author()
            .between_start_dt(["2026-01-01 15:00:00", "2026-01-01 15:00:00.5"])
            .get_count(),
            1,
            "between filter by text",
        )
        if dialect == "sqlite":
            self.assertEqual(
                code_of(lambda: author().start_dt("2026-01-02").get_count()),
                "CODEC_ENCODE",
                "date-only datetime text",
            )

    # The test of DSL-141, DIA-57 (docs/spec).
    # Requirements: CFG-2, CFG-7.
    def test_connections_use_utc(self):
        from .models import models
        from .case_database import case_database

        for dialect in DIALECTS:
            for zone in ("", "UTC", "+00:00"):
                with self.subTest(dialect=dialect, zone=zone):
                    with case_database(dialect, TEMP["dir"].name, "orm_utc") as dsn:
                        db = models.connect(
                            with_zone(dsn, zone),
                            aesKey="test-aes-key",
                            blindIndexKey="test-blind-key",
                        )
                        try:
                            self.connections_use_utc(dialect, db)
                        finally:
                            db.close()

    def test_other_zone_refused(self):
        from .models import models
        from .case_database import case_database

        for dialect in DIALECTS:
            with case_database(dialect, TEMP["dir"].name, "orm_utc") as dsn:
                for zone in ("Asia/Seoul", "+09:00", "SYSTEM"):
                    self.assertEqual(
                        code_of(lambda: models.connect(with_zone(dsn, zone)).close()),
                        "CONFIG",
                        f"{dialect} {zone}",
                    )


if __name__ == "__main__":
    testcase.main()
