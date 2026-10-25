import unittest

from packages.python.tests.testcase import COMPUTE
from polyspec.orm.dbspec.apply import DbspecApplyError, _Applier


class FailingSqlite:
    """locked: another connection holds the database, so the release read after BEGIN EXCLUSIVE is busy too."""

    def __init__(self, failure, locked=False):
        self.failure = failure
        self.locked = locked
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
                self.pragmas[name] = (
                    value.lower() if name == "locking_mode" else int(value)
                )
            else:
                self.unexpected.append(query)
            return {"rows": []}
        if self.locked and query == "SELECT COUNT(*) FROM sqlite_master":
            raise coded_error(5)
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


class DriverError(Exception):
    pass


def coded_error(code):
    """A driver error that carries the SQLite result code, as sqlite3 errors do."""
    error = DriverError(f"SQLite result {code}")
    error.sqlite_errorcode = code
    return error


def failing_session(error, locked=False):
    """The fake connection that fails BEGIN EXCLUSIVE with error, and the applier over it."""
    connection = FailingSqlite(error, locked)
    return connection, _Applier(connection, "sqlite", [], lambda: 0, None)


class SqliteLockResultTest(unittest.TestCase):
    deadline = COMPUTE

    def assert_restored(self, connection, locked=False):
        self.assertEqual(
            connection.pragmas,
            {
                "foreign_keys": 1,
                "legacy_alter_table": 1,
                "busy_timeout": 1300,
                "locking_mode": "normal",
            },
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
                # The release read does not wait for the lock that another connection holds.
                *(["PRAGMA busy_timeout = 0"] if locked else []),
                "PRAGMA foreign_keys = 1",
                "PRAGMA legacy_alter_table = 1",
                "PRAGMA locking_mode = normal",
                "SELECT COUNT(*) FROM sqlite_master",
                "PRAGMA busy_timeout = 1300",
            ],
        )

    # Requirements: PLN-89, PLN-90.
    def test_primary_and_extended_busy_and_locked_results(self):
        for code in (5, 6, 261, 517, 773, 262, 518):
            error = coded_error(code)
            with self.subTest(code=code):
                connection, applier = failing_session(error, locked=True)
                with self.assertRaises(DbspecApplyError) as caught:
                    applier._sqlite_session(lambda: None)
                self.assertEqual(caught.exception.code, "locked")
                self.assertIs(caught.exception.cause, error)
                # A lock result of the release read, which held no lock, adds no cleanup error.
                self.assertIsNone(getattr(caught.exception, "__notes__", None))
                self.assert_restored(connection, locked=True)

    # Requirements: PLN-89, PLN-90.
    def test_non_lock_and_missing_codes_are_preserved(self):
        for code in (10, 8, 14, 23, 1):
            error = coded_error(code)
            with self.subTest(code=code):
                connection, applier = failing_session(error)
                with self.assertRaises(DriverError) as caught:
                    applier._sqlite_session(lambda: None)
                self.assertIs(caught.exception, error)
                self.assert_restored(connection)
        for error in (DriverError("database is locked"), RuntimeError("io failed")):
            connection, applier = failing_session(error)
            with self.assertRaises(type(error)) as caught:
                applier._sqlite_session(lambda: None)
            self.assertIs(caught.exception, error)
            self.assert_restored(connection)


if __name__ == "__main__":
    from packages.python.tests.testcase import main

    main()
