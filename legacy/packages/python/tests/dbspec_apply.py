# The Python-only failures of apply on SQLite that the recipe dbspec_apply cannot state (FCV-2): a statement failure that a fake
# connection reports at its step, which no public path produces, and the session busy_timeout and the driver cause of the
# exclusive lock, which are Python's own connection and error. The chain and its scenarios are the recipe
# contracts/fixtures/dbspec_apply/dbspec_apply.json.
import os
import sqlite3
import tempfile
import time
import unittest

from polyspec.orm.dbspec.apply import (
    DbspecApplyError,
    apply_plans,
)
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.dbspec.plan_steps import plan_steps
from .dbspec_plans import plan_cases
from . import testcase

NOW = 1_700_000_000_000_000


class Conn:
    """Connection used by apply: execute(sql, values) returns rows."""

    def __init__(self, path: str):
        self.connection = sqlite3.connect(path)
        self.connection.isolation_level = None

    def execute(self, sql: str, values):
        cursor = self.connection.execute(sql, tuple(values))
        rows = [list(row) for row in cursor.fetchall()]
        cursor.close()
        return {"rows": rows, "insert_id": None, "affected": 0}

    def value(self, sql: str):
        return self.execute(sql, [])["rows"][0][0]

    def close(self) -> None:
        self.connection.close()


def chain() -> list:
    """The create-from-empty and rename-table-and-column chains from plan-cases.json."""
    cases = plan_cases()
    plans = []
    for case_id in ("create-from-empty", "rename-table-and-column"):
        case = next(c for c in cases if c["id"] == case_id)
        result = parse_plan("\n".join(case["plan"]) + "\n")
        assert result["plan"] is not None, result["diagnostics"][:1]
        plans.append(result["plan"])
    return plans


class DbspecApplyTest(unittest.TestCase):

    # Requirement: PLN-107. The in-memory SQLite case verifies the configured bound and
    # failed-step result when the driver reports a statement-level lock failure.
    def test_sqlite_statement_lock_timeout_is_failed_at_its_step(self) -> None:
        plans = chain()[:1]
        conn = Conn(":memory:")
        try:
            statements = []
            conn.connection.set_trace_callback(statements.append)
            execute = conn.execute
            busy_during_apply = []
            failed_statement = plan_steps(None, plans[0], "sqlite")["steps"][0][
                "statement"
            ]

            def execute_with_lock_timeout(sql, values):
                if sql == failed_statement:
                    raise sqlite3.OperationalError("database is locked")
                return execute(sql, values)

            conn.execute = execute_with_lock_timeout

            def observe(event):
                if event["kind"] == "plan":
                    busy_during_apply.append(conn.value("PRAGMA busy_timeout"))

            with self.assertRaises(DbspecApplyError) as raised:
                apply_plans(conn, "sqlite", "sqlite", plans, lambda: NOW, observe)
            self.assertEqual(busy_during_apply, [5000])
            self.assertIn("PRAGMA busy_timeout = 5000", statements)
            self.assertEqual(raised.exception.code, "failed")
            self.assertEqual(raised.exception.plan, plans[0]["name"])
            self.assertEqual(raised.exception.step, 0)
            self.assertIsInstance(raised.exception.cause, sqlite3.OperationalError)
            self.assertEqual(str(raised.exception.cause), "database is locked")
        finally:
            conn.close()

    # Requirement: PLN-107. SQLite's apply lock waits on BEGIN EXCLUSIVE before any plan step.
    def test_sqlite_apply_waits_for_an_exclusive_lock_within_its_bound(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dbspec-lock-wait-") as tmp:
            path = os.path.join(tmp, "locked.sqlite3")
            blocker = sqlite3.connect(path, isolation_level=None)
            connection = Conn(path)
            blocker.execute("BEGIN EXCLUSIVE")
            try:
                statements = []
                connection.connection.set_trace_callback(statements.append)
                execute = connection.execute

                def release_blocker_after_wait(sql, values):
                    try:
                        return execute(sql, values)
                    except sqlite3.OperationalError:
                        if sql == "BEGIN EXCLUSIVE" and blocker.in_transaction:
                            blocker.execute("ROLLBACK")
                        raise

                connection.execute = release_blocker_after_wait
                started = time.monotonic()
                with self.assertRaises(DbspecApplyError) as raised:
                    apply_plans(connection, "sqlite", "sqlite", [], lambda: NOW)
                elapsed = time.monotonic() - started
                self.assertIn("PRAGMA busy_timeout = 5000", statements)
                self.assertEqual(raised.exception.code, "locked")
                self.assertIsInstance(raised.exception.cause, sqlite3.OperationalError)
                self.assertIn("locked", str(raised.exception.cause).lower())
                self.assertGreaterEqual(elapsed, 4.8)
                self.assertLess(elapsed, 7)
            finally:
                if blocker.in_transaction:
                    blocker.execute("ROLLBACK")
                blocker.close()
                connection.close()


if __name__ == "__main__":
    testcase.main()
