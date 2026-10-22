# Driver cells of the Python client: a DECIMAL or NUMERIC cell is text, as in the TypeScript and PHP clients. PyMySQL
# and psycopg return decimal.Decimal, which the codec of the client does not read; the driver conversions named here
# return the exact text of the cell instead.
import unittest


from polyspec.orm.driver_cells import mysql_conversions, postgres_loaders
import psycopg
import pymysql
from psycopg.pq import Format
from psycopg.postgres import types as pg_types
from pymysql.constants import FIELD_TYPE
from . import testcase


class MysqlCells(unittest.TestCase):
    # Requirements: COD-2.
    def test_decimal_and_newdecimal_cells_are_their_exact_text(self):
        conversions = mysql_conversions()
        self.assertEqual(conversions[FIELD_TYPE.DECIMAL](b"1.50"), "1.50")
        self.assertEqual(conversions[FIELD_TYPE.NEWDECIMAL](b"-0.001"), "-0.001")

    def test_other_cells_keep_the_driver_conversion(self):
        self.assertIs(
            mysql_conversions()[FIELD_TYPE.LONG],
            pymysql.converters.conversions[FIELD_TYPE.LONG],
        )


class PostgresCells(unittest.TestCase):
    def test_numeric_cells_load_as_text(self):
        adapters = psycopg.adapt.AdaptersMap(psycopg.adapters)
        postgres_loaders(adapters)
        loader = adapters.get_loader(pg_types["numeric"].oid, Format.TEXT)
        self.assertEqual(loader.__name__, "TextLoader")


if __name__ == "__main__":
    testcase.main()
