# The session sql_mode that the client sets on every MySQL connection equals sql_mode.session of
# tests/dsn/mysql-session.json, not the server default (docs/spec/config.md "Runtime connection").
# The case connects with ORM_TEST_MYSQL_DSN through the client's own connection setup, and a
# missing variable fails it.
import json
import os
import unittest
from pathlib import Path

from . import testcase
from polyspec.orm.database import _MysqlConnection, parse_dsn

ROOT = Path(__file__).resolve().parents[3]
VECTOR = json.loads((ROOT / "tests" / "dsn" / "mysql-session.json").read_text())


class MysqlSessionTest(unittest.TestCase):
    def test_session_sql_mode(self):
        dsn = os.environ.get("ORM_TEST_MYSQL_DSN", "")
        if not dsn:
            self.fail("ORM_TEST_MYSQL_DSN is not set; run make orm-test-servers")
        connection = _MysqlConnection(parse_dsn(dsn))
        try:
            rows = connection.execute("SELECT @@SESSION.sql_mode", [])["rows"]
        finally:
            connection.close()
        self.assertEqual(
            rows[0][0], VECTOR["sql_mode"]["session"], "@@SESSION.sql_mode"
        )


if __name__ == "__main__":
    testcase.main()
