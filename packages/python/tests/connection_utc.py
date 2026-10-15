# Every connection reads and writes datetime values in UTC whatever the server zone (docs/dialects.md "Date and time",
# docs/interface-implementation.md IF-02), the case of TestConnectionsUseUTC, connectionUtc of
# packages/php/tests/ModelTest.php and connectionsUseUtc of packages/ts/tests/model.mjs: the MySQL server of the tests
# runs in SYSTEM (KST) and the PostgreSQL server in Asia/Seoul. An instant with an offset is stored as its UTC wall
# clock, the clock default is UTC, and the filters by instant and by text find the row; a DSN timezone other than UTC
# or +00:00 is CONFIG. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable
# fails the case.
# Usage: python -m packages.python.tests.connection_utc
import datetime
import tempfile
import unittest

from polyspec.orm.errors import OrmError
from polyspec.orm.models import models
from . import testcase
from .case_database import case_database

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


class ConnectionUtcTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def connections_use_utc(self, dialect: str, db) -> None:
        db.utils().schema().install(models.SCHEMA)
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
        kst = datetime.timezone(datetime.timedelta(hours=9))
        midnight = datetime.datetime(2026, 1, 2, 0, 0, 0, tzinfo=kst)
        before = datetime.datetime.now(datetime.UTC).replace(tzinfo=None)
        created = (
            models.Author()
            .connect(db)
            .set_name("zone")
            .set_user_seq(user.get_seq())
            .set_service_seq(service.get_seq())
            .set_service_region_seq(region.get_seq())
            .set_service_member_seq(member.get_seq())
            .set_start_dt(midnight)
            .set_end_dt("2026-01-03 00:00:00")
            .create()
        )
        author = lambda: models.Author().connect(db)  # noqa: E731
        row = author().get_by_seq(created.get_seq())
        self.assertEqual(row.get_start_dt(), "2026-01-01 15:00:00.000000", "start_dt")
        wall = datetime.datetime.fromisoformat(row.get_created_ts()[:23])
        self.assertLess(
            abs((wall - before).total_seconds()),
            60,
            f"created_ts {row.get_created_ts()} at {before.isoformat()}",
        )
        self.assertEqual(
            author().start_dt(midnight).get_count(),
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

    def test_connections_use_utc(self):
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
