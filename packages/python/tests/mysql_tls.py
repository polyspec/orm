# The MySQL TLS connection of the Python client (docs/spec/config.md), the cases of packages/php/tests/MysqlTlsTest.php
# and packages/ts/tests/mysql_tls.mjs. The refused parameters and modes are cases of contracts/fixtures/dsn_reject.
# The connection case needs ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN and
# ORM_TEST_MYSQL_TLS_MISMATCH_DSN of make orm-test-servers, and a missing one fails it.
# Usage: python -m packages.python.tests.mysql_tls
import os
import re
import unittest

from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from . import testcase


def ssl_version(dsn: str) -> str:
    db = Db.connect(dsn)
    try:
        rows = db._connection.execute("SHOW SESSION STATUS LIKE 'Ssl_version'", [])[
            "rows"
        ]
        return str(rows[0][1]) if rows else ""
    finally:
        db.close()


class MysqlTlsConnectionsTest(unittest.TestCase):
    deadline = testcase.DATABASE

    # Requirements: CFG-16.
    def test_connections(self):
        dsns = []
        for name in (
            "ORM_TEST_MYSQL_TLS_DSN",
            "ORM_TEST_MYSQL_TLS_OTHER_CA_DSN",
            "ORM_TEST_MYSQL_TLS_MISMATCH_DSN",
        ):
            value = os.environ.get(name)
            if not value:
                raise AssertionError(f"{name} is not set; run make orm-test-servers")
            dsns.append(value)
        version = ssl_version(dsns[0])
        self.assertRegex(
            version,
            r"^TLSv1\.[23]$",
            "the Ssl_version of the VERIFY_IDENTITY connection",
        )
        for name, dsn in (
            ("another CA", dsns[1]),
            ("a certificate of another host", dsns[2]),
        ):
            with self.assertRaises(
                OrmError, msg=f"the connection with {name} was accepted"
            ) as raised:
                ssl_version(dsn)
            self.assertEqual(
                raised.exception.code, "CONFIG", f"{name}: {raised.exception}"
            )
            self.assertTrue(
                re.search(
                    r"SSL|certificate|hostname", str(raised.exception), re.IGNORECASE
                ),
                f"the connection with {name} failed for another cause: {raised.exception}",
            )


if __name__ == "__main__":
    testcase.main()
