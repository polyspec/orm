# The abandoned query of test_query_cancel on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200), as
# test_query_cancel_mysql runs it on MySQL. make mariadb-recipes-check/python runs this entry, since no test_*.py discovery
# finds it.
import unittest

from . import testcase
from .test_query_cancel import AbandonedQueryCase


class AbandonedQueryMariadbTest(AbandonedQueryCase, unittest.IsolatedAsyncioTestCase):
    # Requirements: CFG-9.
    async def test_abandoned_query_is_canceled_and_rolled_back_mariadb(self):
        await self.abandon("mariadb")


if __name__ == "__main__":
    testcase.main()
