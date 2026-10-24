import json
import sqlite3
import unittest
from pathlib import Path

from packages.python.tests.testcase import COMPUTE
from polyspec.orm.dbspec.apply import DbspecApplyError, apply_plans, rollback_plans
from polyspec.orm.dbspec.plan import parse_plan

ROOT = Path(__file__).resolve().parents[3]
MASTER_QUERY = """SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name"""
NOW = 1_700_000_000_000_000


def create_from_empty():
    data = json.loads((ROOT / "tests" / "dbspec" / "plans.json").read_text())
    case = next(c for c in data["cases"] if c["id"] == "create-from-empty")
    parsed = parse_plan("\n".join(case["plan"]) + "\n")
    assert parsed["plan"] is not None, parsed["diagnostics"][:1]
    return [parsed["plan"]]


class FaultingConnection:
    def __init__(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.isolation_level = None
        self.failure = None
        self.failure_call = 1
        self.catalog_reads = 0

    def execute(self, sql, args):
        if sql == MASTER_QUERY:
            self.catalog_reads += 1
            if self.failure is not None and self.catalog_reads == self.failure_call:
                raise self.failure
        cursor = self.connection.execute(sql, tuple(args))
        rows = [list(row) for row in cursor.fetchall()]
        cursor.close()
        return {"rows": rows, "insert_id": None, "affected": 0}

    def close(self):
        self.connection.close()

    def history_state(self):
        return self.connection.execute('SELECT state FROM "dbspec$plans"').fetchone()[0]


class DbspecVerifyErrorsTest(unittest.TestCase):
    deadline = COMPUTE

    def test_settled_introspection_error_and_real_drift(self):
        plans = create_from_empty()
        connection = FaultingConnection()
        cause = RuntimeError("catalog read failed")
        connection.failure = cause
        try:
            with self.assertRaises(DbspecApplyError) as caught:
                apply_plans(connection, "sqlite", plans, lambda: NOW)
            self.assertEqual(caught.exception.code, "verify")
            self.assertIs(caught.exception.cause, cause)
        finally:
            connection.close()

        connection = FaultingConnection()
        try:
            connection.execute("CREATE TABLE unrelated (id INTEGER)", [])
            with self.assertRaises(DbspecApplyError) as caught:
                apply_plans(connection, "sqlite", plans, lambda: NOW)
            self.assertEqual(caught.exception.code, "drift")
        finally:
            connection.close()

    def test_rollback_preserves_introspection_error(self):
        plans = create_from_empty()
        connection = FaultingConnection()
        cause = RuntimeError("catalog read failed")
        try:
            apply_plans(connection, "sqlite", plans, lambda: NOW)
            connection.failure = cause
            connection.failure_call = connection.catalog_reads + 1
            with self.assertRaises(DbspecApplyError) as caught:
                rollback_plans(connection, "sqlite", plans, lambda: NOW)
            self.assertEqual(caught.exception.code, "verify")
            self.assertIs(caught.exception.cause, cause)
        finally:
            connection.close()

    def test_post_forward_introspection_error_does_not_report_success(self):
        plans = create_from_empty()
        connection = FaultingConnection()
        cause = RuntimeError("post-forward catalog read failed")
        connection.failure = cause
        connection.failure_call = 2
        events = []
        try:
            with self.assertRaises(DbspecApplyError) as caught:
                apply_plans(
                    connection,
                    "sqlite",
                    plans,
                    lambda: NOW,
                    lambda event: events.append(event["kind"]),
                )
            self.assertEqual(caught.exception.code, "verify")
            self.assertIs(caught.exception.cause, cause)
            self.assertEqual(connection.history_state(), "applying")
            self.assertNotIn("verified", events)
            self.assertNotIn("done", events)
        finally:
            connection.close()


if __name__ == "__main__":
    from packages.python.tests.testcase import main

    main()
