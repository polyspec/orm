# Connection statistics, schema inspection and table privileges on SQLite (docs/interfaces.md "Utilities"):
# Db.stats and Utils.stats, SchemaUtils.exists, installed and empty, and the PrivilegeUtils that only
# PostgreSQL supports. The MySQL and PostgreSQL forms run in schema_inspection.py (make
# python-schema-inspection-check), as packages/ts/tests/model.mjs and packages/php/tests/ModelTest.php
# run them.
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.engine import model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.schema import Schema  # noqa: E402
from . import testcase

MODEL = model_of_documents(parse_document_set([(ROOT / 'contracts' / 'fixtures' / 'rollback.dbs').read_text()]))
SCHEMA = Schema(manifest_text=MODEL.manifest_text, manifest_hash=MODEL.manifest_hash,
                external_text=MODEL.external_text)


class SchemaInspectionTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='orm-schema-inspection-')
        self.addCleanup(tmp.cleanup)
        self.db = Db.connect(f'sqlite://{tmp.name}/inspection.sqlite3')
        self.addCleanup(self.db.close)

    def code(self, call) -> str:
        with self.assertRaises(OrmError) as caught:
            call()
        return caught.exception.code

    def test_stats_report_the_one_connection_of_the_db(self):
        from polyspec.orm.database import DbStats
        idle = DbStats(max_open_connections=1, open_connections=1, in_use=0, idle=1)
        self.assertEqual(self.db.stats(), idle)
        self.assertEqual(self.db.utils().stats(), idle)
        seen = []
        self.db.transaction(lambda: seen.append((self.db.stats(), self.db.utils().stats())), {'retry': 0})
        busy = DbStats(max_open_connections=1, open_connections=1, in_use=1, idle=0)
        self.assertEqual(seen, [(busy, busy)])

    def test_empty_counts_tables_and_views_but_not_the_orm_tables(self):
        schema = self.db.utils().schema()
        self.assertTrue(schema.empty())
        self.db._connection.execute('CREATE TABLE "orm__probe" ("k" TEXT)', [])
        self.assertTrue(schema.empty(), 'an orm__ table is not content')
        self.db._connection.execute('CREATE VIEW "listing" AS SELECT 1 AS "one"', [])
        self.assertFalse(schema.empty(), 'a view is content')
        self.db._connection.execute('DROP VIEW "listing"', [])
        self.assertTrue(schema.empty())
        schema.install(SCHEMA)
        self.assertFalse(schema.empty(), 'installed tables are content')

    def test_exists_and_installed_read_the_prefixed_tables_of_a_schema(self):
        schema = self.db.utils().schema()
        self.assertFalse(schema.exists('app'))
        self.db._connection.execute('CREATE TABLE "app__user" ("k" TEXT)', [])
        self.db._connection.execute('CREATE TABLE "apps" ("k" TEXT)', [])
        self.assertTrue(schema.exists('app'))
        self.assertFalse(schema.exists('ap'), 'the schema prefix is the whole name before __')
        self.assertFalse(schema.exists('a_p'), 'an underscore of the name is not a wildcard')
        self.assertTrue(schema.installed('app', 'user'))
        self.assertFalse(schema.installed('app', 'missing'))
        self.assertFalse(schema.installed('ormexample', 'user'))

    def test_inspection_runs_in_the_active_transaction(self):
        schema = self.db.utils().schema()
        seen = []

        def body():
            self.db._connection.execute('CREATE TABLE "app__user" ("k" TEXT)', [])
            seen.append((schema.installed('app', 'user'), schema.empty()))
        self.db.transaction(body, {'retry': 0})
        self.assertEqual(seen, [(True, False)])

    def test_inspection_sends_schema_statement_events(self):
        events = []
        self.db.subscribe(events.append)
        self.db.utils().schema().empty()
        self.assertEqual([(e.kind, e.transaction) for e in events], [('schema', None)])

    def test_invalid_names_are_config(self):
        schema = self.db.utils().schema()
        self.assertEqual(self.code(lambda: schema.exists('bad name')), 'CONFIG')
        self.assertEqual(self.code(lambda: schema.exists('')), 'CONFIG')
        self.assertEqual(self.code(lambda: schema.installed('app', 'bad name')), 'CONFIG')
        self.assertEqual(self.code(lambda: schema.installed('.app', 'user')), 'CONFIG')

    def test_privileges_are_unsupported_off_postgres(self):
        privileges = self.db.utils().privileges()
        self.assertEqual(self.code(lambda: privileges.grant_table('public.user', 'orm')), 'CAPABILITY_UNSUPPORTED')
        self.assertEqual(self.code(lambda: privileges.revoke_table('public.user', 'select', 'orm')),
                         'CAPABILITY_UNSUPPORTED')
        self.assertEqual(self.code(lambda: privileges.inspect_table('public.user')), 'CAPABILITY_UNSUPPORTED')


if __name__ == '__main__':
    testcase.main()
