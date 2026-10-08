# db.utils(): transaction-local values, the lock and the AES key version status (docs/usage.md).
# The SQLite checks run here; the MySQL and PostgreSQL forms of lock and set_local run in CI.
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.aes import AesKeyring  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402


class UtilsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-utils-')
        cls.addClassCleanup(tmp.cleanup)
        cls.out = tmp.name
        cls.models = generate(cls.out, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{cls.out}/utils.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)
        for version in (1, 1, 2):
            cls.db._connection.execute(
                'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
                '"service_member_seq", "start_dt", "end_dt", "aes_key_version") '
                'VALUES (?, 1, 1, 1, 1, ?, ?, ?)',
                ['u', '2026-06-01 00:00:00.000000', '2026-06-01 00:00:00.000000', version])

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_local_value_is_readable_inside_the_transaction(self):
        seen = []

        def body():
            self.db.utils().set_local('ormtest.actor', 'runner')
            seen.append(self.db.utils().local('ormtest.actor'))
        self.db.transaction(body, {'retry': 0})
        self.assertEqual(seen, ['runner'])

    def test_local_outside_a_transaction_is_a_config_error(self):
        with self.assertRaisesRegex(OrmError, 'CONFIG'):
            self.db.utils().set_local('ormtest.actor', 'runner')

    def test_missing_local_value_is_no_rows(self):
        def body():
            with self.assertRaisesRegex(OrmError, 'NO_ROWS'):
                self.db.utils().local('ormtest.missing')
        self.db.transaction(body, {'retry': 0})

    def test_lock_is_taken_inside_a_transaction(self):
        self.db.transaction(lambda: self.db.utils().lock('conformance'), {'retry': 0})

    def test_aes_status_counts_the_rows_of_each_key_version(self):
        keyring = AesKeyring({1: 'bench-salt', 2: 'bench-salt-2'}, 2)
        status = self.db.utils().aes().status(self.models.Author(), keyring)
        self.assertEqual(status.current, 2)
        self.assertEqual(dict(status.versions), {1: 2, 2: 1})
        self.assertEqual(status.pending, 2)


if __name__ == '__main__':
    unittest.main()
