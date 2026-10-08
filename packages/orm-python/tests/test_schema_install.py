# SchemaUtils.install: creates the set's tables on an empty SQLite database, creates nothing when
# they all exist, refuses a partial set, and refuses a database that differs from the set
# (packages/orm-npm/src/utils.ts, docs/schema.md "Schema installation").
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import generate

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.errors import OrmError  # noqa: E402


def tables_of(path: str) -> list:
    with sqlite3.connect(path) as conn:
        return sorted(r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'orm__%'"))


class SchemaInstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-schema-install-')
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')

    def connect(self, name: str):
        path = os.path.join(self.dir, name)
        return path, self.models.connect(f'sqlite://{path}', aesKey='bench-salt', blindIndexKey='bench-blind-index')

    def test_installs_into_an_empty_database_and_then_creates_nothing(self):
        path, db = self.connect('empty.sqlite3')
        try:
            db.utils().schema().install(self.models.SCHEMA)
            created = tables_of(path)
            self.assertIn('author', created)
            db.utils().schema().install(self.models.SCHEMA)
            self.assertEqual(tables_of(path), created)
        finally:
            db.close()

    def test_a_partial_set_is_config(self):
        path, db = self.connect('partial.sqlite3')
        try:
            with sqlite3.connect(path) as conn:
                conn.execute('CREATE TABLE "user" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT)')
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().install(self.models.SCHEMA)
            self.assertEqual(caught.exception.code, 'CONFIG')
            self.assertIn('install found only some tables of the document set', str(caught.exception))
        finally:
            db.close()

    def test_a_database_that_differs_from_the_set_is_config(self):
        path, db = self.connect('differs.sqlite3')
        try:
            db.utils().schema().install(self.models.SCHEMA)
            with sqlite3.connect(path) as conn:
                conn.execute('ALTER TABLE "author" ADD COLUMN "junk" INTEGER NULL')
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().install(self.models.SCHEMA)
            self.assertEqual(caught.exception.code, 'CONFIG')
            self.assertIn('the database differs from the document set', str(caught.exception))
            self.assertIn('unsupported_column author.junk: declared type INTEGER with CHECK "" has no dbspec type',
                          str(caught.exception))
        finally:
            db.close()


if __name__ == '__main__':
    unittest.main()
