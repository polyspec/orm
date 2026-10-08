# A terminal-by method (getCountBy<Column>) after other conditions joins its condition with AND
# to them, as the chain of a query does (docs/usage.md "Terminal methods").
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class TerminalByTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-terminal-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/terminal.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        for is_close in (0, 0, 1):
            cls.db._connection.execute(
                'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
                '"service_member_seq", "start_dt", "end_dt", "is_close", "aes_key_version") '
                'VALUES (?, 1, 7, 1, 1, ?, ?, ?, 1)',
                ['t', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000', is_close])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_terminal_by_after_a_condition_counts_the_joined_rows(self):
        query = self.models.Author().connect(self.db).service_seq(7)
        self.assertEqual(query.get_count_by_is_close(True), 1)
        self.assertEqual(query.get_count(), 3)


if __name__ == '__main__':
    unittest.main()
