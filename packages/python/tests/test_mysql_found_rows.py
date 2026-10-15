# An update counts the rows it matched on every database (protocol.md Write result), so the MySQL connection asks the
# server for found rows, not only changed rows. The test reads the connection flags and needs no server.
import unittest
from unittest import mock
from urllib.parse import urlparse


from polyspec.orm import database  # noqa: E402
from . import testcase


class _Parsed:
    url = urlparse("mysql://root@127.0.0.1:3306/orm")
    ssl_ca = None


class MysqlFoundRowsTest(unittest.TestCase):
    def test_connection_asks_for_found_rows(self):
        import pymysql
        from pymysql.constants import CLIENT

        with (
            mock.patch.object(pymysql, "connect") as connect,
            mock.patch.object(database._MysqlConnection, "execute"),
        ):
            database._MysqlConnection(_Parsed)
        flags = connect.call_args.kwargs["client_flag"]
        self.assertTrue(flags & CLIENT.FOUND_ROWS)


if __name__ == "__main__":
    testcase.main()
