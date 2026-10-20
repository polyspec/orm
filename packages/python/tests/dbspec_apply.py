# Applies the chain of the shared plan case (tests/dbspec/plans.json) to SQLite
# (docs/spec/plans.md "Apply"). Applies only the first plan, applies the whole chain, and the second
# plan stops after statement 1 and resumes, then reverts the last plan. MySQL and
# PostgreSQL are checked by conformance and the apply order-pair comparison (dbspec_apply_runner.py, make dbspec-apply-pairs-check).
# Run: make dbspec-python-check
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.dbspec.apply import _finish, apply_plans, recover_plans, rollback_plans  # noqa: E402
from polyspec.orm.dbspec.plan import parse_plan  # noqa: E402
from polyspec.orm.dbspec.plan_steps import plan_steps  # noqa: E402
from . import testcase  # noqa: E402

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
    """The create-from-empty and rename-table-and-column chains from plans.json."""
    data = json.loads((ROOT / "tests" / "dbspec" / "plans.json").read_text())
    plans = []
    for case_id in ("create-from-empty", "rename-table-and-column"):
        case = next(c for c in data["cases"] if c["id"] == case_id)
        result = parse_plan("\n".join(case["plan"]) + "\n")
        assert result["plan"] is not None, result["diagnostics"][:1]
        plans.append(result["plan"])
    return plans


def history(conn: Conn) -> list:
    rows = conn.execute('SELECT "name", "state", "step" FROM "dbspec$plans"', [])[
        "rows"
    ]
    return sorted(tuple(row) for row in rows)


class DbspecApplyTest(unittest.TestCase):
    def test_sqlite_scenarios(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dbspec-apply-") as tmp:
            scenarios(tmp)

    # Requirements: PLN-101.
    def test_cleanup_failure_notes(self) -> None:
        """A failure with failing cleanups is raised itself, with one note per cleanup error in order."""
        failure = RuntimeError("stop")

        def fail() -> None:
            raise failure

        def release() -> None:
            raise RuntimeError("release failed")

        def restore() -> None:
            raise RuntimeError("restore failed")

        with self.assertRaises(RuntimeError) as raised:
            _finish(fail, release, restore)
        self.assertIs(raised.exception, failure)
        self.assertEqual(getattr(raised.exception, "__notes__", []), ["cleanup failed: release failed", "cleanup failed: restore failed"])


def scenarios(tmp: str) -> None:
    plans = chain()
    sources = [None, plans[0]["schema"]]
    steps = [
        len(plan_steps(source, p, "sqlite")["steps"])
        for p, source in zip(plans, sources)
    ]
    # Applies only the first plan.
    conn = Conn(os.path.join(tmp, "first.sqlite3"))
    apply_plans(conn, "sqlite", plans[:1], lambda: NOW)
    assert history(conn) == [("create_from_empty", "applied", steps[0])], history(conn)
    assert conn.value('SELECT COUNT(*) FROM "users"') == 0
    conn.close()
    # Applies the whole chain.
    conn = Conn(os.path.join(tmp, "chain.sqlite3"))
    apply_plans(conn, "sqlite", plans, lambda: NOW)
    assert history(conn) == [
        ("create_from_empty", "applied", steps[0]),
        ("rename_table_and_column", "applied", steps[1]),
    ], history(conn)
    conn.close()
    # Stops after statement 1 of the second plan and finishes with recover.
    conn = Conn(os.path.join(tmp, "stopped.sqlite3"))
    stopped = []

    def stop(event):
        stopped.append(event["kind"])
        if (
            event["kind"] == "applied"
            and event["plan"] == "rename_table_and_column"
            and event["step"] == 1
        ):
            raise RuntimeError("stop")

    try:
        apply_plans(conn, "sqlite", plans, lambda: NOW, stop)
        raise AssertionError("stop did not interrupt the chain")
    except RuntimeError as error:
        assert str(error) == "stop"
    assert history(conn) == [
        ("create_from_empty", "applied", steps[0]),
        ("rename_table_and_column", "applying", 1),
    ], history(conn)
    recover_plans(conn, "sqlite", plans, lambda: NOW)
    assert history(conn) == [
        ("create_from_empty", "applied", steps[0]),
        ("rename_table_and_column", "applied", steps[1]),
    ], history(conn)
    # Reverts the last plan.
    rollback_plans(conn, "sqlite", plans, lambda: NOW)
    assert history(conn) == [("create_from_empty", "applied", steps[0])], history(conn)
    assert conn.value('SELECT COUNT(*) FROM "users"') == 0
    conn.close()


if __name__ == "__main__":
    testcase.main()
