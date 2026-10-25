# The session sql_mode that the client sets on every MySQL connection equals sql_mode.session of
# tests/dsn/mysql-session.json, not the server default (docs/spec/config.md "Runtime connection").
# The case connects with ORM_TEST_MYSQL_DSN through the client's own connection setup, and a
# missing variable fails it.
import json
import os
import unittest
from pathlib import Path

from . import testcase
from polyspec.orm.database import _MysqlConnection, _PostgresConnection, parse_dsn

ROOT = Path(__file__).resolve().parents[3]
VECTOR = json.loads((ROOT / "tests" / "dsn" / "mysql-session.json").read_text())


class MysqlSessionTest(unittest.TestCase):
    # Requirements: CFG-7.
    def test_session_sql_mode(self):
        dsn = os.environ.get("ORM_TEST_MYSQL_DSN", "")
        if not dsn:
            self.fail("ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers")
        connection = _MysqlConnection(parse_dsn(dsn), statement_timeout_ms=237)
        try:
            rows = connection.execute(
                "SELECT @@SESSION.sql_mode, @@SESSION.time_zone, @@SESSION.max_execution_time",
                [],
            )["rows"]
        finally:
            connection.close()
        self.assertEqual(
            rows[0][0], VECTOR["sql_mode"]["session"], "@@SESSION.sql_mode"
        )
        self.assertEqual(rows[0][1], "+00:00", "@@SESSION.time_zone")
        self.assertEqual(rows[0][2], 237, "@@SESSION.max_execution_time")

    # Requirements: CFG-7.
    def test_postgres_session_settings_are_startup_parameters(self):
        dsn = os.environ.get("ORM_TEST_POSTGRES_DSN", "")
        if not dsn:
            self.fail("ORM_TEST_POSTGRES_DSN is not set; run make orm-test-servers")
        connection = _PostgresConnection(parse_dsn(dsn), statement_timeout_ms=237)
        try:
            rows = connection.execute(
                "SELECT name, setting, source FROM pg_settings WHERE name IN ('TimeZone', 'statement_timeout')",
                [],
            )["rows"]
        finally:
            connection.close()
        settings = {name: (setting, source) for name, setting, source in rows}
        self.assertEqual(settings.get("TimeZone", (None,))[0], "UTC", "TimeZone")
        self.assertEqual(
            settings.get("statement_timeout", (None,))[0], "237", "statement_timeout"
        )
        if os.environ.get("ORM_TEST_POSTGRES_DSN") == os.environ.get(
            "ORM_TEST_POSTGRES_SERVER_DSN"
        ):
            self.assertEqual(
                settings.get("TimeZone", (None, None))[1],
                "client",
                "TimeZone startup source",
            )
            self.assertEqual(
                settings.get("statement_timeout", (None, None))[1],
                "client",
                "timeout startup source",
            )


if __name__ == "__main__":
    testcase.main()
