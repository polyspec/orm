import os
import sqlite3
import tempfile
import unittest

from . import testcase
from polyspec.orm import connect_catalog


class CatalogAutoKeyTest(unittest.TestCase):
    def test_sqlite_automatic_primary_key_insert_returns_stored_row(self):
        with tempfile.TemporaryDirectory(prefix="orm-catalog-auto-key-") as directory:
            path = os.path.join(directory, "catalog.sqlite3")
            raw = sqlite3.connect(path)
            try:
                raw.execute(
                    "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)"
                )
            finally:
                raw.close()

            catalog = connect_catalog(f"sqlite://{path}")
            try:
                metadata = catalog.describe_table(
                    {"namespace": "main", "name": "sample"}
                )
                self.assertEqual(metadata.primary_key, ["id"])
                identity = metadata.columns[0]
                self.assertTrue(identity.automatic_key)
                self.assertIsNone(identity.default_expression)

                inserted = catalog.insert_row(metadata, [("payload", "generated")])

                self.assertEqual(inserted.columns, ["id", "payload"])
                self.assertEqual(inserted.rows, [[1, "generated"]])
                stored = catalog.read_only_query(
                    'SELECT "id", "payload" FROM "sample"', []
                )
                self.assertEqual(stored.rows, [[1, "generated"]])
            finally:
                catalog.close()


if __name__ == "__main__":
    testcase.main()
