# The startup parameters of a PostgreSQL session (CFG-7). The MySQL session settings are the case
# mysql_session_settings of contracts/fixtures/dsn_connection.
import os
import unittest

from . import testcase
from polyspec.orm.database import _PostgresConnection, parse_dsn

class MysqlSessionTest(unittest.TestCase):
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
