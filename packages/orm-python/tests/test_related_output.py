# A related model is part of the row output under its relation name, as the Go client writes it
# (docs/usage.md "Relations").
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))


class RelatedOutputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-related-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/related.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        cls.db._connection.execute('INSERT INTO "service" ("name") VALUES (?)', ['svc'])
        cls.db._connection.execute(
            'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
            '"service_member_seq", "start_dt", "end_dt", "aes_key_version") '
            'VALUES (?, 1, 1, 1, 1, ?, ?, 1)',
            ['a', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000'])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_relation_model_is_written_under_its_relation_name(self):
        rows = (self.models.Author().connect(self.db)
                .relation(self.models.Service().match_service_seq_with_seq())
                .get_by_seq(1))
        self.assertEqual(rows.to_array()['service_model'], {'seq': 1, 'name': 'svc'})


if __name__ == '__main__':
    unittest.main()
