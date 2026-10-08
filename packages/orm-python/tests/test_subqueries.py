# A subquery column: a column function whose callback returns an aggregate model, which is
# written as a correlated scalar subquery of the outer rows (docs/usage.md "Subqueries").
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class SubqueryColumnTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-subquery-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/subquery.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        cls.db._connection.execute('INSERT INTO "user" ("name") VALUES (?)', ['u1'])
        cls.db._connection.execute('INSERT INTO "user" ("name") VALUES (?)', ['u2'])
        for read_count in (5, 7):
            cls.db._connection.execute(
                'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
                '"service_member_seq", "start_dt", "end_dt", "read_count", "aes_key_version") '
                'VALUES (?, 1, 7, 1, 1, ?, ?, ?, 1)',
                ['a', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000', read_count])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_read_total_is_the_sum_of_the_correlated_rows(self):
        users = (self.models.User().connect(self.db)
                 .add_column_read_total(lambda u: self.models.Author().sum_read_count()
                                        .user_seq_eq_seq(u).and_service_seq(7))
                 .seq(1).order_by_seq_asc().gets())
        totals = [(u.get_seq(), u.get_read_total()) for u in users.values()]
        self.assertEqual(totals, [(1, 12)])


if __name__ == '__main__':
    unittest.main()
