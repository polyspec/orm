# SchemaUtils.addTablesAndColumns: an installed set takes a newer schema version by adding its tables
# and nullable columns; a change that cannot be added is refused with SCHEMA_DIFFERS before any
# statement (packages/orm-npm/src/utils.ts, docs/schema.md "Adding tables and columns").
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.schema import Schema  # noqa: E402

USERS_ID = 'table users {\n  id i64 identity\n  primary key (id)\n}\n'
USERS_EMAIL_NULL = 'table users {\n  id i64 identity\n  email varchar(191) null\n  primary key (id)\n}\n'
USERS_EMAIL_NOT_NULL = 'table users {\n  id i64 identity\n  email varchar(191)\n  primary key (id)\n}\n'
NOTE = 'table note {\n  id i64 identity\n  body text null\n  primary key (id)\n}\n'


def schema_of(body: str) -> Schema:
    document, diagnostics = parse_dbspec(f'dbspec 1 shop\n\n{body}', {})
    assert not diagnostics, diagnostics
    manifest, diagnostics = dbspec_manifest([document])
    assert manifest is not None, diagnostics
    return Schema(manifest_text=manifest.manifest_text, manifest_hash=manifest.manifest_hash,
                  external_text=manifest.external_text)


class AddTablesAndColumnsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='orm-add-tables-')
        self.addCleanup(self.tmp.cleanup)

    def connect(self, name: str):
        path = os.path.join(self.tmp.name, name)
        return path, Db.connect(f'sqlite://{path}')

    def test_adds_the_new_table_and_the_nullable_column(self):
        path, db = self.connect('add.sqlite3')
        try:
            db.utils().schema().install(schema_of(USERS_ID))
            added = db.utils().schema().add_tables_and_columns(schema_of(NOTE + USERS_EMAIL_NULL))
            self.assertEqual(added, ['note', 'users.email'])
            db.utils().schema().install(schema_of(NOTE + USERS_EMAIL_NULL))
        finally:
            db.close()

    def test_a_column_without_null_or_default_is_refused_before_any_statement(self):
        path, db = self.connect('refuse.sqlite3')
        try:
            db.utils().schema().install(schema_of(USERS_ID))
            with self.assertRaises(OrmError) as caught:
                db.utils().schema().add_tables_and_columns(schema_of(USERS_EMAIL_NOT_NULL))
            self.assertEqual(caught.exception.code, 'SCHEMA_DIFFERS')
            self.assertIn('add_column users.email without null or default', str(caught.exception))
        finally:
            db.close()


if __name__ == '__main__':
    unittest.main()
