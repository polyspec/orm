# removeAllColumns() keeps only the primary and foreign keys of the entity, and each added column
# (docs/dsl.md, the removeAllColumns row of the chain table).
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class RemoveColumnsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-remove-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/remove.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        cls.db._connection.execute(
            'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
            '"service_member_seq", "start_dt", "end_dt", "aes_key_version") '
            'VALUES (?, 2, 3, 4, 5, ?, ?, 1)',
            ['r', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000'])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_keys_and_the_added_column_only(self):
        row = (self.models.Author().connect(self.db).remove_all_columns().add_column_name()
               .get_by_seq(1)).to_array()
        self.assertEqual(sorted(row), ['name', 'seq', 'service_member_seq', 'service_region_seq',
                                       'service_seq', 'user_seq'])


if __name__ == '__main__':
    unittest.main()
