# The DSN parameters and the MySQL TLS connection of the Python client (docs/spec/config.md), the cases of
# packages/php/tests/MysqlTlsTest.php and packages/ts/tests/mysql_tls.mjs: a DSN uses only the parameters of its scheme,
# `ssl-mode=VERIFY_IDENTITY` with an absolute `ssl-ca` and a host name is the only MySQL TLS mode, and every other
# parameter and mode is CONFIG. The connection case needs ORM_TEST_MYSQL_TLS_DSN, ORM_TEST_MYSQL_TLS_OTHER_CA_DSN and
# ORM_TEST_MYSQL_TLS_MISMATCH_DSN of make orm-test-servers, and a missing one fails it.
# Usage: python -m packages.python.tests.mysql_tls
import os
import re
import unittest

from polyspec.orm.database import Db, parse_dsn
from polyspec.orm.errors import OrmError
from . import testcase


class MysqlTlsParametersTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def refused(self, dsn: str, wanted: str) -> None:
        with self.assertRaises(OrmError, msg=f"accepted {dsn}") as raised:
            parse_dsn(dsn)
        self.assertEqual(raised.exception.code, "CONFIG", f"{dsn}: {raised.exception}")
        self.assertIn(wanted, str(raised.exception), dsn)

    # Requirements: CFG-17, CFG-18, CFG-19.
    def test_parameters(self):
        self.refused(
            "mysql://root@db.local/orm_example?charset=latin1",
            "unknown parameter charset",
        )
        self.refused(
            "mysql://root@db.local/orm_example?sslmode=disable",
            "unknown parameter sslmode",
        )
        self.refused(
            "postgres://root@db.local/orm_example?application_name=orm",
            "unknown parameter application_name",
        )
        self.refused(
            "postgres://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY",
            "unknown parameter ssl-mode",
        )
        self.refused(
            "sqlite:///tmp/orm-tls.sqlite?cache=shared", "unknown parameter cache"
        )
        for mode in (
            "VERIFY_CA",
            "REQUIRED",
            "PREFERRED",
            "DISABLED",
            "verify_identity",
            "",
        ):
            self.refused(
                f"mysql://root@db.local/orm_example?ssl-mode={mode}&ssl-ca=/tmp/ca.pem",
                "ssl-mode",
            )
        self.refused(
            "mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY", "ssl-ca"
        )
        self.refused(
            "mysql://root@db.local/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=ca.pem",
            "absolute",
        )
        self.refused("mysql://root@db.local/orm_example?ssl-ca=/tmp/ca.pem", "ssl-mode")
        for host in ("127.0.0.1", "[::1]"):
            self.refused(
                f"mysql://root@{host}/orm_example?ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem",
                "host name",
            )
        self.refused(
            "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem",
            "socket",
        )
        parsed = parse_dsn(
            "mysql://root@db.local/orm_example?timezone=UTC&ssl-mode=VERIFY_IDENTITY&ssl-ca=/tmp/ca.pem"
        )
        self.assertEqual((parsed.driver, parsed.ssl_ca), ("mysql", "/tmp/ca.pem"))
        for dsn in (
            "postgres://orm@127.0.0.1/orm_example?sslmode=disable&timezone=UTC",
            "postgres:///orm_example?host=/tmp",
            "sqlite:///tmp/orm-tls.sqlite?_pragma=busy_timeout(5000)&timezone=UTC",
            "mysql://root@localhost/orm_example?socket=/tmp/mysql.sock&timezone=UTC",
        ):
            parse_dsn(dsn)


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
