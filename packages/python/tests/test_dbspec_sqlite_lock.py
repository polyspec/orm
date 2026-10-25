import unittest

from packages.python.tests.testcase import COMPUTE
from polyspec.orm.dbspec.apply import DbspecApplyError, _Applier


class FailingSqlite:
    def __init__(self, failure):
        self.failure = failure
        self.pragmas = {
            "foreign_keys": 1,
            "legacy_alter_table": 1,
            "busy_timeout": 1300,
            "locking_mode": "normal",
        }
        self.unexpected = []
        self.operations = []

    def execute(self, query, _args):
        self.operations.append(query)
        if query == "BEGIN EXCLUSIVE":
            raise self.failure
        if query.startswith("PRAGMA ") and " = " in query:
            name, value = query.removeprefix("PRAGMA ").split(" = ", 1)
            if name in self.pragmas:
                self.pragmas[name] = value.lower() if name == "locking_mode" else int(value)
            else:
                self.unexpected.append(query)
            return {"rows": []}
        values = {
            "PRAGMA foreign_keys": self.pragmas["foreign_keys"],
            "PRAGMA legacy_alter_table": self.pragmas["legacy_alter_table"],
            "PRAGMA busy_timeout": self.pragmas["busy_timeout"],
            "PRAGMA locking_mode": self.pragmas["locking_mode"],
            "SELECT COUNT(*) FROM sqlite_master": 0,
        }
        if query not in values:
            self.unexpected.append(query)
            return {"rows": []}
        return {"rows": [[values[query]]]}


class SqliteLockResultTest(unittest.TestCase):
    deadline = COMPUTE

    def assert_restored(self, connection):
        self.assertEqual(
            connection.pragmas,
            {"foreign_keys": 1, "legacy_alter_table": 1, "busy_timeout": 1300, "locking_mode": "normal"},
        )
        self.assertEqual(connection.unexpected, [])
        self.assertEqual(
            connection.operations,
            [
                "PRAGMA foreign_keys",
                "PRAGMA legacy_alter_table",
                "PRAGMA busy_timeout",
                "PRAGMA locking_mode",
                "PRAGMA busy_timeout = 5000",
                "PRAGMA locking_mode = EXCLUSIVE",
                "BEGIN EXCLUSIVE",
                "PRAGMA foreign_keys = 1",
                "PRAGMA legacy_alter_table = 1",
                "PRAGMA locking_mode = normal",
                "SELECT COUNT(*) FROM sqlite_master",
                "PRAGMA busy_timeout = 1300",
            ],
        )

    # Requirements: PLN-89, PLN-90.
    def test_primary_and_extended_busy_and_locked_results(self):
        class DriverError(Exception):
            pass

        for code in (5, 6, 261, 517, 773, 262, 518):
            error = DriverError(f"SQLite result {code}")
            error.sqlite_errorcode = code
            with self.subTest(code=code):
                connection = FailingSqlite(error)
                applier = _Applier(connection, "sqlite", [], lambda: 0, None)
                with self.assertRaises(DbspecApplyError) as caught:
                    applier._sqlite_session(lambda: None)
                self.assertEqual(caught.exception.code, "locked")
                self.assertIs(caught.exception.cause, error)
                self.assert_restored(connection)

    # Requirements: PLN-89, PLN-90.
    def test_non_lock_and_missing_codes_are_preserved(self):
        class DriverError(Exception):
            pass

        for code in (10, 8, 14, 23, 1):
            error = DriverError(f"SQLite result {code}")
            error.sqlite_errorcode = code
            with self.subTest(code=code):
                connection = FailingSqlite(error)
                applier = _Applier(connection, "sqlite", [], lambda: 0, None)
                with self.assertRaises(DriverError) as caught:
                    applier._sqlite_session(lambda: None)
                self.assertIs(caught.exception, error)
                self.assert_restored(connection)
        for error in (DriverError("database is locked"), RuntimeError("io failed")):
            connection = FailingSqlite(error)
            applier = _Applier(connection, "sqlite", [], lambda: 0, None)
            with self.assertRaises(type(error)) as caught:
                applier._sqlite_session(lambda: None)
            self.assertIs(caught.exception, error)
            self.assert_restored(connection)


if __name__ == "__main__":
    from packages.python.tests.testcase import main

    main()
