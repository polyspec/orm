# The abandoned query of test_query_cancel on MySQL; query_cancel_mariadb is the same case on MariaDB, a server of the MySQL
# dialect (docs/spec/dialects.md DIA-200).
import unittest

from . import testcase
from .test_query_cancel import AbandonedQueryCase


class AbandonedQueryMysqlTest(AbandonedQueryCase, unittest.IsolatedAsyncioTestCase):
    # Requirements: CFG-9.
    async def test_abandoned_query_is_canceled_and_rolled_back_mysql(self):
        await self.abandon("mysql")


if __name__ == "__main__":
    testcase.main()
