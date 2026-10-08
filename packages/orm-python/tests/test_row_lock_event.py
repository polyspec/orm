# The SQLite row lock statement names the row lock table in the tables of its statement event
# (docs/usage.md "Statement events").
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class RowLockEventTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-rowlock-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/rowlock.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_row_lock_take_names_the_row_lock_table(self):
        events = []
        self.db.subscribe(events.append)
        self.db.transaction(lambda: self.db.utils().lock('rowlock_event'), {'retry': 0})
        take = [e for e in events if e.sql.startswith('INSERT INTO "orm__row_lock"')]
        self.assertEqual(len(take), 1)
        self.assertEqual(list(take[0].tables), ['orm__row_lock'])


if __name__ == '__main__':
    unittest.main()
