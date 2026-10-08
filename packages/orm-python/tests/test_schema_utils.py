# The schema tools of a connection: db.utils().schema() returns the SchemaUtils of that connection
# (docs/schema.md "Schema registration"; packages/orm-npm/src/utils.ts).
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import generate

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class SchemaAccessorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-schema-utils-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/schema.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_schema_returns_the_schema_tools_of_the_connection(self):
        from polyspec.orm.utils import SchemaUtils
        tools = self.db.utils().schema()
        self.assertIsInstance(tools, SchemaUtils)
        self.assertIs(tools.db, self.db)


if __name__ == '__main__':
    unittest.main()


class SchemaRegisterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-schema-register-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.schema = cls.models.SCHEMA
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/register.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_mismatched_hash_is_config_and_registers_nothing(self):
        from polyspec.orm.errors import OrmError
        from polyspec.orm.schema import Schema
        before = dict(self.db.engines)
        wrong = Schema(manifest_text=self.schema.manifest_text,
                       manifest_hash='sha256:' + '0' * 64, external_text=self.schema.external_text)
        with self.assertRaises(OrmError) as caught:
            self.db.utils().schema().register(wrong)
        self.assertEqual(caught.exception.code, 'CONFIG')
        self.assertEqual(dict(self.db.engines), before)

    def test_registering_the_same_set_again_changes_nothing(self):
        before = dict(self.db.engines)
        self.db.utils().schema().register(self.schema)
        self.db.utils().schema().register(self.schema)
        self.assertEqual(set(self.db.engines), set(before) | {self.schema.manifest_hash})
        self.assertIs(self.db.engines[self.schema.manifest_hash],
                      self.db.engines.get(self.schema.manifest_hash))
