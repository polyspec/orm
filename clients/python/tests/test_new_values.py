# A value attached with NewLabel stays on the created model and is written in its output, as the
# Go client writes it (docs/usage.md "Model writes").
import datetime
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class NewValuesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-newvalue-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/newvalue.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_created_model_writes_its_attached_value(self):
        start = datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc)
        created = (self.models.Author().connect(self.db).set_name('n').set_user_seq(1)
                   .set_service_seq(1).set_service_region_seq(1).set_service_member_seq(1)
                   .set_start_dt(start).set_end_dt(start).new_label('created').create())
        self.assertEqual(created.to_array()['label'], 'created')


if __name__ == '__main__':
    unittest.main()
