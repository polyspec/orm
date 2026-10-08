# AesUtils.rotate: the rows whose key version is not the current one are encrypted again with the
# current key and get the current version; the number of rotated rows is returned (docs/schema.md
# "AES key rotation"; packages/orm-npm/src/utils.ts).
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import generate

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.aes import AesKeyring  # noqa: E402


class AesRotateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-aes-rotate-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/rotate.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        from test_sqlite import DDL, run_script
        run_script(cls.db, DDL)
        import datetime
        start = datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc)
        for name in ('a', 'b', 'c'):
            (cls.models.Author().connect(cls.db).set_name(name).set_user_seq(1).set_service_seq(1)
             .set_service_region_seq(1).set_service_member_seq(1).set_start_dt(start).set_end_dt(start)
             .set_aes_hex_email(f'{name}@example.com').create())

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_rotates_every_row_not_at_the_current_version(self):
        keyring = AesKeyring({1: 'bench-salt', 2: 'bench-salt-2'}, 2)
        before = [r[0] for r in self.db._connection.execute(
            'SELECT "aes_hex_email" FROM "author" ORDER BY "seq"', [])['rows']]
        rotated = self.db.utils().aes().rotate(self.models.Author(), keyring)
        self.assertEqual(rotated, 3)
        rows = self.db._connection.execute(
            'SELECT "aes_key_version", "aes_hex_email" FROM "author" ORDER BY "seq"', [])['rows']
        self.assertEqual([r[0] for r in rows], [2, 2, 2])
        self.assertNotEqual([r[1] for r in rows], before)
        self.assertEqual(self.db.utils().aes().rotate(self.models.Author(), keyring), 0)


if __name__ == '__main__':
    unittest.main()
