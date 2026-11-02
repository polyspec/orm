# Requirements: INT-101.
# The one native check of catalog_connection (FCV-2, docs/spec/feature-coverage.md "Catalog connection exclusions"): the
# MySQL server refuses a TIME(7) (DIA-54). The recipe's sql.exec step cannot expect a server error, so the check stays
# here. It takes its MySQL database from ORM_TEST_MYSQL_DSN, as the recipe entries do.
import os
import secrets
import unittest

from polyspec.orm.database import parse_dsn
from . import testcase


class CatalogConnectionCoverageTest(unittest.TestCase):
    def test_mysql_temporal_precision_refused(self):
        dsn = os.environ.get("ORM_TEST_MYSQL_DSN")
        if not dsn:
            self.fail("ORM_TEST_MYSQL_DSN is required; database tests never skip")
        import pymysql

        url = parse_dsn(dsn).url
        invalid = (
            f"catalog_temporal_precision_{os.getpid()}_{secrets.token_hex(4)}_invalid"
        )
        native = pymysql.connect(
            host=url.hostname,
            port=url.port or 3306,
            user=url.username,
            password=url.password or "",
            database=url.path.lstrip("/"),
            autocommit=True,
        )
        try:
            with native.cursor() as cursor:
                with self.assertRaises(
                    Exception, msg="MySQL rejects temporal precision above 6"
                ) as rejected:
                    cursor.execute(
                        f"CREATE TABLE `{invalid}` (id BIGINT PRIMARY KEY, t TIME(7))"
                    )
            self.assertIn("precision", str(rejected.exception).lower())
        finally:
            native.close()


if __name__ == "__main__":
    testcase.main()
