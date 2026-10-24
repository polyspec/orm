import unittest

from packages.python.tests.testcase import COMPUTE
from polyspec.orm.dbspec.apply import DbspecApplyError, _Applier


class FailingSqlite:
    def __init__(self, failure):
        self.failure = failure

    def execute(self, query, _args):
        if query == "BEGIN EXCLUSIVE":
            raise self.failure
        values = {
            "PRAGMA foreign_keys": [1],
            "PRAGMA legacy_alter_table": [0],
            "PRAGMA busy_timeout": [5000],
            "PRAGMA locking_mode": ["normal"],
            "SELECT COUNT(*) FROM sqlite_master": [0],
        }
        return {"rows": [[values[query][0]]] if query in values else []}


class SqliteLockResultTest(unittest.TestCase):
    deadline = COMPUTE

    def test_primary_and_extended_busy_and_locked_results(self):
        class DriverError(Exception):
            pass

        for code in (5, 6, 261, 517, 773, 262, 518):
            error = DriverError(f"SQLite result {code}")
            error.sqlite_errorcode = code
            with self.subTest(code=code):
                applier = _Applier(FailingSqlite(error), "sqlite", [], lambda: 0, None)
                with self.assertRaises(DbspecApplyError) as caught:
                    applier._sqlite_session(lambda: None)
                self.assertEqual(caught.exception.code, "locked")
                self.assertIs(caught.exception.cause, error)

    def test_non_lock_and_missing_codes_are_preserved(self):
        class DriverError(Exception):
            pass

        for code in (10, 8, 14, 23, 1):
            error = DriverError(f"SQLite result {code}")
            error.sqlite_errorcode = code
            with self.subTest(code=code):
                applier = _Applier(FailingSqlite(error), "sqlite", [], lambda: 0, None)
                with self.assertRaises(DriverError) as caught:
                    applier._sqlite_session(lambda: None)
                self.assertIs(caught.exception, error)
        for error in (DriverError("database is locked"), RuntimeError("io failed")):
            applier = _Applier(FailingSqlite(error), "sqlite", [], lambda: 0, None)
            with self.assertRaises(type(error)) as caught:
                applier._sqlite_session(lambda: None)
            self.assertIs(caught.exception, error)


if __name__ == "__main__":
    from packages.python.tests.testcase import main

    main()
