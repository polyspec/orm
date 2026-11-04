# A rollback that fails on the driver reports both the callback error and the rollback error, and the test entry point
# polyspec.orm.testing stays out of the package (docs/spec/protocol.md "Errors" and "Test faults",
# packages/ts/tests/transaction-failure.mjs, packages/php/tests/RollbackTest.php). The rollback fault itself is the
# recipe `transactions`.
import os
import sqlite3
from types import SimpleNamespace
import tempfile
import tomllib
import unittest
from pathlib import Path

from polyspec.orm import testing
from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError

from . import testcase
from .entry_point_check import assert_import_does_not_load_testing
from .test_sqlite import generate_document, installed_sqlite

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]


class _TransactionRecordingConnection:
    def __init__(self):
        self.closed = False
        self.transaction = False
        self.statements = []

    def execute(self, sql: str, values):
        self.statements.append(sql)
        if sql in ("BEGIN", "BEGIN IMMEDIATE"):
            self.transaction = True
        elif sql == "ROLLBACK" or sql == "COMMIT":
            self.transaction = False
        return {"rows": [], "insert_id": None, "affected": 0}

    def in_transaction(self) -> bool:
        return self.transaction

    def close(self) -> None:
        self.closed = True


class _LostRollbackConnection(_TransactionRecordingConnection):
    def __init__(self, index: int):
        super().__init__()
        self.index = index

    def execute(self, sql: str, values):
        if sql == "ROLLBACK":
            self.statements.append(sql)
            raise OrmError("CONNECTION_LOST", "rollback connection lost in test driver")
        return super().execute(sql, values)


class _LostRollbackDb(Db):
    def __init__(self):
        self.connections = []
        super().__init__("sqlite:///transaction-failure-fake.sqlite", {"poolSize": 1})

    def _open(self):
        connection = _LostRollbackConnection(len(self.connections) + 1)
        self.connections.append(connection)
        return connection


class _FailingStartConnection(_TransactionRecordingConnection):
    """A connection whose statement `failing` fails as SQLite fails a BEGIN IMMEDIATE that waits on another
    writer."""

    def __init__(self, failing: str):
        super().__init__()
        self.failing = failing

    def execute(self, sql: str, values):
        if sql == self.failing:
            self.statements.append(sql)
            raise OrmError("CANCELED", "sqlite: database is locked")
        return super().execute(sql, values)


class _FailingStartDb(Db):
    def __init__(self, failing: str):
        self.connections = []
        self.failing = failing
        super().__init__("sqlite:///failing-start.sqlite", {"poolSize": 1})

    def _open(self):
        connection = _FailingStartConnection(self.failing)
        self.connections.append(connection)
        return connection


class _CloseDuringTransactionDb(Db):
    def __init__(self):
        self.connections = []
        super().__init__("sqlite:///close-during-transaction.sqlite", {"poolSize": 1})
        self._shared.row_lock_ready = True

    def _open(self):
        connection = _TransactionRecordingConnection()
        self.connections.append(connection)
        return connection


def check_rollback(case: unittest.TestCase, error, subject: str):
    """A ROLLBACK error has two errors, and its message records both."""
    case.assertIsInstance(error, OrmError, f"{subject} raises {error!r}")
    case.assertEqual(error.code, "ROLLBACK", f"{subject}: {error}")
    case.assertIsNotNone(error.cause, f"{subject} keeps the callback error")
    case.assertIsNotNone(
        getattr(error, "rollback", None), f"{subject} keeps the rollback error"
    )
    case.assertEqual(
        str(error),
        f"ROLLBACK: transaction failed ({error.cause}) and rollback failed ({error.rollback})",
    )


class RollbackFaultTest(unittest.TestCase):
    deadline = testcase.DATABASE

    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-rollback-")
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        cls.models = generate_document(
            os.path.join(tmp.name, "models"),
            ROOT / "contracts" / "fixtures" / "rollback.dbs",
        )

    def setUp(self):
        self.path = os.path.join(self.dir, f"{self._testMethodName}.sqlite3")
        self.db = installed_sqlite(self, self.path, self.models)

    def probe(self, label: str):
        return self.models.RollbackProbe().connect(self.db).set_label(label)

    def count(self) -> int:
        return self.models.RollbackProbe().connect(self.db).get_count()

    def raised(self, run):
        try:
            run()
        except BaseException as error:  # noqa: BLE001 - the probe returns any exception the run raises
            return error
        return None

    def check_rollback(self, error, subject: str):
        check_rollback(self, error, subject)

    def failed_rollback(self, label: str):
        """Runs a transaction that creates the row label and then fails, and returns its ROLLBACK error, after checking
        that it keeps the callback error and a rollback error, with the function that runs that transaction again."""
        callback = RuntimeError("rollback callback failed")

        def failing():
            self.probe(label).create()
            raise callback

        def run():
            return self.db.transaction(failing, {"retry": 0})

        error = self.raised(run)
        self.check_rollback(error, "transaction")
        self.assertIs(error.cause, callback)
        self.assertIsInstance(error.rollback, OrmError)
        return error, run

    # Requirements: INT-72.
    def test_a_failed_rollback_reports_the_callback_error_and_the_rollback_error(self):
        # SQLite's authorizer refuses the ROLLBACK of the transaction, so the rollback fails while the transaction is
        # still open. A trigger's RAISE(ROLLBACK) does not serve here: SQLite then ends the transaction itself, and the
        # client sends no ROLLBACK (INT-155).
        raw = self.db._shared.pool._idle[0].connection
        refused = []

        def authorize(action, first, second, database, source):
            if (
                action == sqlite3.SQLITE_TRANSACTION
                and first == "ROLLBACK"
                and not refused
            ):
                refused.append(first)
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        raw.set_authorizer(authorize)
        self.addCleanup(raw.set_authorizer, None)
        error, _ = self.failed_rollback("kept")
        self.assertIn("not authorized", str(error.rollback))
        self.assertEqual(refused, ["ROLLBACK"])

    # Requirements: DIA-181, PLN-17.
    def test_a_failed_savepoint_rollback_and_transaction_rollback_report_both(self):
        raw = self.db._shared.pool._idle[0].connection
        self.addCleanup(raw.set_authorizer, None)
        scenarios = [
            ("rollback-only", {"ROLLBACK"}),
            ("release-only", {"RELEASE"}),
            ("both-endpoints", {"ROLLBACK", "RELEASE"}),
        ]
        for name, rejected in scenarios:
            controls = []

            def authorize(action, first, second, database, source):
                if action == sqlite3.SQLITE_SAVEPOINT and second == "orm_sp_1":
                    controls.append(first)
                    if first in rejected:
                        return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK

            raw.set_authorizer(authorize)
            callback = RuntimeError("savepoint callback failed")

            def nested_failure():
                def inner():
                    raise callback

                return self.db.transaction(
                    lambda: self.db.transaction(inner), {"retry": 0}
                )

            error = self.raised(nested_failure)
            self.check_rollback(error, name)
            self.assertIs(error.cause, callback, name)
            self.assertIn("not authorized", str(error.rollback), name)
            self.assertEqual(
                controls,
                ["BEGIN", "ROLLBACK", "RELEASE"],
                f"{name}: savepoint creation and both endpoints are ordered",
            )
            self.assertIsInstance(error.rollback.cause, sqlite3.Error, name)

        controls = []

        def authorize_release(action, first, second, database, source):
            if action == sqlite3.SQLITE_SAVEPOINT and second == "orm_sp_1":
                controls.append(first)
                if first == "RELEASE":
                    return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        raw.set_authorizer(authorize_release)
        error = self.raised(
            lambda: self.db.transaction(
                lambda: self.db.transaction(lambda: None), {"retry": 0}
            )
        )
        self.assertIsInstance(error, OrmError)
        self.assertEqual(error.code, "DRIVER")
        self.assertIsInstance(error.cause, sqlite3.Error)
        self.assertIn("not authorized", str(error))
        self.assertNotIn("savepoint callback failed", str(error))
        self.assertEqual(controls, ["BEGIN", "RELEASE"])
        raw.set_authorizer(None)

    def test_lost_rollback_connection_is_closed_before_the_next_transaction(self):
        # Requirements: INT-72.
        db = _LostRollbackDb()
        first = db.connections[0]
        callback = RuntimeError("transaction callback failed")

        def failing():
            raise callback

        try:
            error = self.raised(lambda: db.transaction(failing, {"retry": 0}))
            self.assertIsInstance(error, OrmError)
            self.assertEqual(error.code, "ROLLBACK")
            self.assertIs(error.cause, callback)
            self.assertIsInstance(error.rollback, OrmError)
            self.assertEqual(error.rollback.code, "CONNECTION_LOST")
            self.assertTrue(
                first.closed, "the connection lost during rollback is closed"
            )
            self.assertEqual(
                db.stats().open_connections, 0, "the broken connection leaves the pool"
            )

            db.transaction(lambda: "ok", {"retry": 0})
            self.assertEqual(len(db.connections), 2)
            self.assertIsNot(db.connections[1], first)
            self.assertFalse(db.connections[1].closed)
        finally:
            db.close()

    def test_a_failed_begin_closes_its_connection(self):
        # Requirements: INT-72.
        db = _FailingStartDb("BEGIN IMMEDIATE")
        try:
            error = self.raised(lambda: db.transaction(lambda: None, {"retry": 0}))
            self.assertIsInstance(error, OrmError)
            self.assertEqual(error.code, "CANCELED")
            first = db.connections[0]
            self.assertTrue(first.closed, "the connection whose BEGIN failed is closed")
            self.assertEqual(db.stats().open_connections, 0, "it leaves the pool")
            self.assertEqual(db.stats().in_use, 0)
        finally:
            db.close()

    def test_a_failed_start_step_after_begin_rolls_back_and_gives_the_connection_back(
        self,
    ):
        # Requirements: INT-72.
        db = _FailingStartDb("PRAGMA query_only = 1")
        try:
            error = self.raised(
                lambda: db.transaction(lambda: None, {"retry": 0, "readOnly": True})
            )
            self.assertIsInstance(error, OrmError)
            self.assertEqual(error.code, "CANCELED")
            first = db.connections[0]
            self.assertIn(
                "ROLLBACK", first.statements, "the opened transaction is rolled back"
            )
            self.assertFalse(first.transaction)
            self.assertEqual(db.stats().in_use, 0, "the connection is given back")
            db.close()
            self.assertTrue(first.closed, "close closes the given-back connection")
        finally:
            db.close()


class RollbackFaultEntryTest(unittest.TestCase):
    deadline = testcase.PROCESS

    def test_the_package_entry_point_does_not_export_the_fault(self):
        # Requirements: PRT-47.
        import polyspec.orm

        self.assertFalse(hasattr(polyspec.orm, "fail_next_rollback"))
        self.assertNotIn("fail_next_rollback", polyspec.orm.__all__)
        self.assertTrue(callable(testing.fail_next_rollback))

    # Requirements: INT-148, PRT-57, PRT-62.
    def test_the_package_entry_point_does_not_export_the_other_entry_points(self):
        # Requirements: PRT-57, PRT-62.
        import polyspec.orm

        for name in ("fix_clock", "last_affected"):
            self.assertFalse(hasattr(polyspec.orm, name), name)
            self.assertNotIn(name, polyspec.orm.__all__)
            self.assertTrue(callable(getattr(testing, name)), name)

    # Requirements: INT-148, PRT-47, PRT-57, PRT-62.
    def test_the_distribution_holds_the_test_entry_point_that_no_import_loads(self):
        # Requirements: PRT-47, PRT-57, PRT-62.
        # As with testing/Faults.php in PHP, the distribution contains the test entry point, and the package entry point does not
        # load it. Only the consumer's tests import it by that name to inject faults.
        with (PACKAGE / "pyproject.toml").open("rb") as file:
            find = tomllib.load(file)["tool"]["setuptools"]["packages"]["find"]
        self.assertNotIn("polyspec.orm.testing", find.get("exclude", []))
        self.assertNotIn("polyspec.orm.testing.*", find.get("exclude", []))
        self.assertTrue(
            (PACKAGE / "src" / "polyspec" / "orm" / "testing" / "__init__.py").is_file()
        )
        assert_import_does_not_load_testing(self)


class NativeFaultEntryUnitTest(unittest.TestCase):
    # Requirements: INT-148, PRT-47, PRT-52, PRT-57, PRT-62.
    deadline = testcase.COMPUTE

    def test_test_fault_facade_sets_only_the_requested_connection_state(self):
        db = SimpleNamespace(
            _shared=SimpleNamespace(
                rollback_fault=False,
                statement_fault=None,
                fixed_clock=None,
                last_affected=7,
            )
        )

        testing.fail_next_rollback(db)
        self.assertTrue(db._shared.rollback_fault)
        testing.fail_next_statement(db, "FAULT", "refused")
        self.assertEqual(db._shared.statement_fault, ("FAULT", "refused"))
        with self.assertRaises(ValueError):
            testing.fail_next_statement(db, "", "refused")
        self.assertEqual(db._shared.statement_fault, ("FAULT", "refused"))

        testing.fix_clock(db, "2026-01-02 03:04:05.006007")
        self.assertEqual(db._shared.fixed_clock, 1_767_323_045_006_007)
        with self.assertRaises(ValueError):
            testing.fix_clock(db, "2026-01-02 03:04:05")
        self.assertEqual(db._shared.fixed_clock, 1_767_323_045_006_007)
        self.assertEqual(testing.last_affected(db), 7)
        db._shared.last_affected = None
        self.assertIsNone(testing.last_affected(db))


class HandleDisposalTest(unittest.TestCase):
    # Requirements: INT-67.
    deadline = testcase.COMPUTE

    def test_close_during_transaction_rolls_back_and_closes_connection(self):
        db = _CloseDuringTransactionDb()
        connection = db.connections[0]
        abandoned = RuntimeError("the caller abandoned the transaction")

        def abandon():
            db.close()
            raise abandoned

        try:
            with self.assertRaises(RuntimeError) as caught:
                db.transaction(abandon, {"retry": 0})

            self.assertIs(caught.exception, abandoned)
            self.assertEqual(
                connection.statements,
                ["BEGIN IMMEDIATE", "ROLLBACK"],
                "closing the Db while its transaction is active rolls back before releasing the session",
            )
            self.assertFalse(connection.transaction)
            self.assertTrue(
                connection.closed,
                "the closed pool disposes the checked-out connection on return",
            )
            self.assertTrue(db.closed)
        finally:
            db.close()


if __name__ == "__main__":
    testcase.main()
