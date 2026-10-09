# The rollback of a transaction fails deterministically through the test entry point
# polyspec.orm.testing.fail_next_rollback, and a failed rollback reports both the callback error and
# the rollback error (docs/protocol.md "Errors" and "Test faults", packages/orm-npm/tests/rollback.mjs,
# packages/orm-php/tests/rollback_test.php).
import importlib
import os
import sqlite3
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

from test_sqlite import generate

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE / 'src'))

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402

FAULT_MESSAGE = 'test fault: the rollback of the transaction ran and is reported as failed'


def fail_next_rollback(db) -> None:
    """test entry point를 그 module에서 읽어 부른다. module이 없으면 ModuleNotFoundError다."""
    importlib.import_module('polyspec.orm.testing').fail_next_rollback(db)


class RollbackFaultTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-rollback-')
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate(os.path.join(tmp.name, 'models'), ROOT / 'contracts' / 'fixtures' / 'rollback.dbs')

    def setUp(self):
        self.path = os.path.join(self.dir, f'{self._testMethodName}.sqlite3')
        self.db = Db.connect_schema(f'sqlite://{self.path}', self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)

    def probe(self, label: str):
        return self.models.RollbackProbe().connect(self.db).set_label(label)

    def count(self) -> int:
        return self.models.RollbackProbe().connect(self.db).get_count()

    def raised(self, run):
        try:
            run()
        except BaseException as error:  # noqa: BLE001
            return error
        return None

    def check_rollback(self, error, subject: str):
        """ROLLBACK 오류는 두 오류를 갖고 message가 둘을 적는다."""
        self.assertIsInstance(error, OrmError, f'{subject} raises {error!r}')
        self.assertEqual(error.code, 'ROLLBACK', f'{subject}: {error}')
        self.assertIsNotNone(error.cause, f'{subject} keeps the callback error')
        self.assertIsNotNone(getattr(error, 'rollback', None), f'{subject} keeps the rollback error')
        self.assertEqual(str(error),
                         f'ROLLBACK: transaction failed ({error.cause}) and rollback failed ({error.rollback})')

    def test_the_fault_reports_the_next_failed_rollback(self):
        fail_next_rollback(self.db)
        committed = self.raised(lambda: self.db.transaction(lambda: self.probe('committed').create(), {'retry': 0}))
        self.assertIsNone(committed, 'a committed transaction with an armed fault raises nothing')
        callback = RuntimeError('rollback fault callback failed')

        def failing():
            self.probe('rolled back').create()
            raise callback

        error = self.raised(lambda: self.db.transaction(failing, {'retry': 0}))
        self.check_rollback(error, 'transaction')
        self.assertIs(error.cause, callback)
        self.assertIsInstance(error.rollback, OrmError)
        self.assertEqual(error.rollback.code, 'FAULT')
        self.assertEqual(str(error.rollback), f'FAULT: {FAULT_MESSAGE}')
        self.assertEqual(self.count(), 1, 'the faulted rollback keeps only the committed row')
        again = self.raised(lambda: self.db.transaction(failing, {'retry': 0}))
        self.assertIs(again, callback, 'the transaction after the consumed fault raises the callback error')
        self.assertEqual(self.count(), 1)

    def test_a_savepoint_rollback_does_not_consume_the_fault(self):
        fail_next_rollback(self.db)
        inner = RuntimeError('savepoint callback failed')

        def nested():
            self.probe('outer').create()

            def failing():
                self.probe('inner').create()
                raise inner
            self.assertIs(self.raised(lambda: self.db.transaction(failing)), inner)

        self.assertIsNone(self.raised(lambda: self.db.transaction(nested, {'retry': 0})))
        self.assertEqual(self.count(), 1)
        callback = RuntimeError('callback failed')

        def failing_outer():
            raise callback
        error = self.raised(lambda: self.db.transaction(failing_outer, {'retry': 0}))
        self.check_rollback(error, 'transaction')
        self.assertEqual(error.rollback.code, 'FAULT')

    def test_a_failed_rollback_reports_the_callback_error_and_the_rollback_error(self):
        with sqlite3.connect(self.path) as conn:
            conn.execute("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' "
                         "BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END")
        conn.close()

        def ended():
            self.probe('kept').create()
            self.probe('end').create()

        error = self.raised(lambda: self.db.transaction(ended, {'retry': 0}))
        self.check_rollback(error, 'transaction')
        self.assertIsInstance(error.cause, OrmError)
        self.assertIn('rollback probe ended the transaction', str(error.cause))
        self.assertIsInstance(error.rollback, OrmError)
        self.assertEqual(self.count(), 0, 'the trigger rolled the transaction back and the connection serves later requests')

    def test_a_failed_savepoint_rollback_and_transaction_rollback_report_both(self):
        with sqlite3.connect(self.path) as conn:
            conn.execute("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' "
                         "BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END")
        conn.close()

        def nested():
            self.probe('kept').create()

            def inner():
                self.probe('nested').create()
                self.probe('end').create()
            self.db.transaction(inner)

        error = self.raised(lambda: self.db.transaction(nested, {'retry': 0}))
        self.check_rollback(error, 'transaction')
        self.check_rollback(error.cause, 'savepoint')
        self.assertEqual(self.count(), 0)


class RollbackFaultEntryTest(unittest.TestCase):
    def test_the_package_entry_point_does_not_export_the_fault(self):
        import polyspec.orm
        self.assertFalse(hasattr(polyspec.orm, 'fail_next_rollback'))
        self.assertNotIn('fail_next_rollback', polyspec.orm.__all__)
        self.assertTrue(callable(importlib.import_module('polyspec.orm.testing').fail_next_rollback))

    def test_the_distribution_holds_the_test_entry_point_that_no_import_loads(self):
        # PHP의 testing/Faults.php처럼 배포는 test entry point를 담고, package entry point는 그것을 load하지
        # 않는다. 소비자의 test만 그 이름으로 import해서 fault를 건다.
        with (PACKAGE / 'pyproject.toml').open('rb') as file:
            find = tomllib.load(file)['tool']['setuptools']['packages']['find']
        self.assertNotIn('polyspec.orm.testing', find.get('exclude', []))
        self.assertNotIn('polyspec.orm.testing.*', find.get('exclude', []))
        self.assertTrue((PACKAGE / 'src' / 'polyspec' / 'orm' / 'testing' / '__init__.py').is_file())
        loaded = subprocess.run([sys.executable, '-c', 'import sys, polyspec.orm, polyspec.orm.database; '
                                 'print("polyspec.orm.testing" in sys.modules)'],
                                capture_output=True, text=True, env={**os.environ, 'PYTHONPATH': str(PACKAGE / 'src')
                                                                     + os.pathsep + os.environ.get('PYTHONPATH', '')})
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        self.assertEqual(loaded.stdout.strip(), 'False')

if __name__ == '__main__':
    unittest.main()
