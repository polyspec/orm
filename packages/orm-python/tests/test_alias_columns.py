# Alias columns: an add-column function named Alias<Name> writes its result under the
# snake_case name of the alias, and its value is the function result (docs/usage.md).
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.values import orm  # noqa: E402


class AliasColumnsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-alias-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/alias.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        cls.db._connection.execute(
            'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
            '"service_member_seq", "start_dt", "end_dt", "aes_key_version") '
            'VALUES (?, 1, 1, 1, 1, ?, ?, 1)',
            ['alias', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000'])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_alias_column_is_keyed_by_its_snake_case_name(self):
        row = (self.models.Author().connect(self.db)
               .add_column_start_dt_alias_start_year(orm.year()).get_by_seq(1))
        values = row.to_array()
        self.assertNotIn('StartYear', values)
        self.assertEqual(values['start_year'], 2026)


if __name__ == '__main__':
    unittest.main()
