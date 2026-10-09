# A statement event subscriber that raises fails the statement with SUBSCRIBER, whose message holds the
# text of the subscriber error and whose cause is that error, as the TypeScript client gives it
# (packages/orm-npm/src/events.ts, docs/usage.md "Statement events").
import sys
import tempfile
import unittest
from pathlib import Path

from test_sqlite import DDL, generate, run_script

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.errors import OrmError  # noqa: E402


class SubscriberErrorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-subscriber-')
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(tmp.name, ROOT / 'schema' / 'bench.dbs')
        cls.db = cls.models.connect(f'sqlite://{tmp.name}/subscriber.sqlite3',
                                    aesKey='bench-salt', blindIndexKey='bench-blind-index')
        run_script(cls.db, DDL)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def fail_with(self, error: Exception) -> OrmError:
        def subscriber(event):
            raise error
        stop = self.db.subscribe(subscriber)
        try:
            with self.assertRaises(OrmError) as raised:
                self.db.transaction(lambda: self.db.utils().lock('subscriber_error'), {'retry': 0})
        finally:
            stop()
        return raised.exception

    def test_an_orm_error_of_a_subscriber(self):
        cause = OrmError('CONFIG', 'the subscriber refuses the statement')
        failure = self.fail_with(cause)
        self.assertEqual(failure.code, 'SUBSCRIBER')
        self.assertEqual(str(failure), 'SUBSCRIBER: statement event subscriber failed: '
                                       'CONFIG: the subscriber refuses the statement')
        self.assertIs(failure.cause, cause)

    def test_another_error_of_a_subscriber(self):
        cause = ValueError('the subscriber failed')
        failure = self.fail_with(cause)
        self.assertEqual(failure.code, 'SUBSCRIBER')
        self.assertEqual(str(failure), 'SUBSCRIBER: statement event subscriber failed: the subscriber failed')
        self.assertIs(failure.cause, cause)


if __name__ == '__main__':
    unittest.main()
