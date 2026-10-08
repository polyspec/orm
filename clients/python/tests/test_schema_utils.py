# The schema tools of a connection: db.utils().schema() returns the SchemaUtils of that connection
# (docs/schema.md "Schema registration"; clients/typescript/src/utils.ts).
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
