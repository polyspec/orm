# Statement events show an executor clock bind as $NOW and a bound secret as $SECRET
# (docs/usage.md "Statement events").
import datetime
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class EventPlaceholdersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-placeholder-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/placeholder.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_clock_and_secret_binds_are_shown_as_placeholders(self):
        events = []
        self.db.subscribe(events.append)
        start = datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc)
        (self.models.Author().connect(self.db).set_name('p').set_user_seq(1).set_service_seq(1)
         .set_service_region_seq(1).set_service_member_seq(1).set_start_dt(start)
         .set_end_dt(start).set_aes_hex_email('p@example.com').create())
        insert = [e for e in events if e.sql.startswith('INSERT INTO "author"')][-1]
        self.assertIn('$NOW', insert.binds)
        self.assertNotIn('<now>', insert.binds)
        self.assertNotIn('<secret>', insert.binds)
        self.assertFalse(any(b == '<secret>' or b == '<now>' for b in insert.binds))


if __name__ == '__main__':
    unittest.main()
