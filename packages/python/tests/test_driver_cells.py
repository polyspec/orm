# Driver cells of the Python client: DECIMAL and NUMERIC cells stay exact text, and binary cells retain their bytes.
# PyMySQL and psycopg return decimal.Decimal, which the codec of the client does not read; the conversions return exact
# text, while the native binary conversion remains unchanged.
import unittest
from types import SimpleNamespace


import psycopg
import pymysql
from psycopg.pq import Format
from psycopg.postgres import types as pg_types
from pymysql.constants import FIELD_TYPE

from polyspec.orm.core import Core
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec
from polyspec.orm.driver_cells import mysql_conversions, postgres_loaders
from polyspec.orm.model import EntityDef, Model, register_model
from polyspec.orm.model_exec import _Assembler
from . import testcase


class MysqlCells(unittest.TestCase):
    # Requirements: COD-2.
    # Requirements: INT-145, COD-2.
    def test_decimal_and_newdecimal_cells_are_their_exact_text(self):
        conversions = mysql_conversions()
        self.assertEqual(conversions[FIELD_TYPE.DECIMAL](b"1.50"), "1.50")
        self.assertEqual(conversions[FIELD_TYPE.NEWDECIMAL](b"-0.001"), "-0.001")

    def test_other_cells_keep_the_driver_conversion(self):
        self.assertIs(
            mysql_conversions()[FIELD_TYPE.LONG],
            pymysql.converters.conversions[FIELD_TYPE.LONG],
        )

    # Requirements: INT-5, PRT-69.
    def test_binary_cells_keep_the_exact_driver_bytes(self):
        source = b"\x00\x7f\x80\xffA"
        conversion = mysql_conversions()[FIELD_TYPE.BLOB]
        self.assertIs(conversion, pymysql.converters.conversions[FIELD_TYPE.BLOB])
        driver_cell = conversion(source)
        self.assertEqual(driver_cell, source)

        document, _positions, parse_diagnostics = parse_dbspec(
            "dbspec 1 native_cell\n\ntable native_cell {\n"
            "  id i32\n  body bytes\n  primary key (id)\n}\n",
            {},
        )
        self.assertFalse(parse_diagnostics)
        manifest, manifest_diagnostics = dbspec_manifest([document])
        self.assertFalse(manifest_diagnostics)
        registered = register_model(manifest.manifest_text, manifest.manifest_hash)
        entity = EntityDef(
            registered,
            registered.entities["native_cell"],
            lambda core: NativeByteCell(core),
        )

        class NativeByteCell(Model):
            @property
            def entity_def(self):
                return entity

        assembler = _Assembler({}, SimpleNamespace(zone=None), None)
        row = assembler.model(
            Core(entity),
            {
                "columns": [
                    {"index": 0, "name": "id", "column": "id", "hidden": False},
                    {"index": 1, "name": "body", "column": "body", "hidden": False},
                ],
                "key": [{"column": "id", "index": 0}],
                "children": [],
            },
            [1, driver_cell],
        )
        self.assertEqual(row.self.core.values["body"], source)


class PostgresCells(unittest.TestCase):
    # Requirements: INT-145, COD-2.
    def test_numeric_cells_load_as_text(self):
        adapters = psycopg.adapt.AdaptersMap(psycopg.adapters)
        postgres_loaders(adapters)
        loader = adapters.get_loader(pg_types["numeric"].oid, Format.TEXT)
        self.assertEqual(loader.__name__, "TextLoader")


if __name__ == "__main__":
    testcase.main()
