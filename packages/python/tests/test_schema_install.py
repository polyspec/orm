# SchemaUtils.install: creates the set's tables on an empty SQLite database, creates nothing when
# they all exist, refuses a partial set, and refuses a database that differs from the set
# (packages/ts/src/utils.ts, docs/spec/schema.md "Schema installation").
import os
import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from polyspec.orm.errors import OrmError
from . import testcase

from polyspec.orm import Schema
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec, read_dbspec_file

from .test_sqlite import generate

ROOT = Path(__file__).resolve().parents[3]


def bench_shared() -> Schema:
    """The schema value of the external document bench_shared.dbs, as the set that owns it generates it."""
    path = ROOT / "contracts" / "fixtures" / "bench" / "bench_shared.dbs"
    text, diagnostics = read_dbspec_file(str(path))
    if text is None:
        raise AssertionError(f"{path}: {diagnostics}")
    document, _positions, diagnostics = parse_dbspec(text, {})
    if document is None:
        raise AssertionError(f"{path}: {diagnostics}")
    manifest, diagnostics = dbspec_manifest([document])
    if manifest is None:
        raise AssertionError(f"{path}: {diagnostics}")
    return Schema(manifest.manifest_text, manifest.manifest_hash)


def tables_of(path: str) -> list:
    with closing(sqlite3.connect(path)) as conn, conn:
        return sorted(
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'orm__%'"
            )
        )


class SchemaInstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-schema-install-")
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )

    def install_external(self, db):
        """Installs the external document of the set, as the set requires its table to exist before it installs."""
        db.utils().schema().install(bench_shared())

    def connect(self, name: str):
        path = os.path.join(self.dir, name)
        return path, self.models.connect(
            f"sqlite://{path}", aesKey="bench-salt", blindIndexKey="bench-blind-index"
        )

    def test_installs_into_an_empty_database_and_then_creates_nothing(self):
        path, db = self.connect("empty.sqlite3")
        try:
            self.install_external(db)
            db.utils().schema().install(self.models.SCHEMA)
            created = tables_of(path)
            self.assertIn("author", created)
            db.utils().schema().install(self.models.SCHEMA)
            self.assertEqual(tables_of(path), created)
        finally:
            db.close()

    def test_a_partial_set_is_config(self):
        path, db = self.connect("partial.sqlite3")
        try:
            self.install_external(db)
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute(
                    'CREATE TABLE "user" ("seq" INTEGER PRIMARY KEY AUTOINCREMENT)'
                )
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().install(self.models.SCHEMA)
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertIn(
                "install found only some tables of the document set",
                str(caught.exception),
            )
        finally:
            db.close()

    # Requirements: SCH-7, DBS-108.
    def test_a_database_that_differs_from_the_set_is_config(self):
        path, db = self.connect("differs.sqlite3")
        try:
            self.install_external(db)
            db.utils().schema().install(self.models.SCHEMA)
            with closing(sqlite3.connect(path)) as conn, conn:
                conn.execute('ALTER TABLE "author" ADD COLUMN "junk" INTEGER NULL')
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().install(self.models.SCHEMA)
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertIn(
                "the database differs from the document set", str(caught.exception)
            )
            self.assertIn(
                'unsupported_column author.junk: declared type INTEGER with CHECK "" has no dbspec type',
                str(caught.exception),
            )
        finally:
            db.close()


if __name__ == "__main__":
    testcase.main()
