# Applies the chain of the shared plan case (tests/dbspec/plans.json) to SQLite
# (docs/spec/plans.md "Apply"). Applies only the first plan, applies the whole chain, and the second
# plan stops after statement 1 and resumes, then reverts the last plan. MySQL and
# PostgreSQL are checked by conformance and the apply order-pair comparison (dbspec_apply_runner.py, make dbspec-apply-pairs-check).
# Run: make dbspec-python-check
import json
import os
import psycopg
import sqlite3
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from polyspec.orm.dbspec.apply import (
    DbspecApplyError,
    _finish,
    apply_plans,
    finalize_plans,
    recover_plans,
    rollback_plans,
)
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.dbspec.plan_steps import plan_steps
from .dbspec_apply_runner import Adapter as ApplyAdapter, run_lock_wait
from .dbspec_introspect import CONNECTION_RULES, case_database
from .runner_connect import mysql_connect
from . import testcase

ROOT = Path(__file__).resolve().parents[3]

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


def representative_chain() -> list:
    """The shared plan case with dropped tables and columns that finalize removes."""
    data = json.loads((ROOT / "tests" / "dbspec" / "plans.json").read_text())
    case = next(c for c in data["cases"] if c["id"] == "representative")
    source = parse_plan(
        "\n".join(["dbplan 1 base", "from empty", "", *case["source"]]) + "\n"
    )
    plan = parse_plan("\n".join(case["plan"]) + "\n")
    assert source["plan"] is not None, source["diagnostics"][:1]
    assert plan["plan"] is not None, plan["diagnostics"][:1]
    return [source["plan"], plan["plan"]]


def stress_plan():
    """The 100-table stress input applied by every client for PLN-104."""
    result = subprocess.run(
        ["node", str(ROOT / "tests" / "dbspec" / "stress.mts"), "100"],
        check=True,
        capture_output=True,
        text=True,
    )
    if not result.stdout.startswith("dbspec 1 stress\n"):
        raise AssertionError("stress document header is missing")
    document = result.stdout.replace("dbspec 1 stress\n", "dbspec 1 schema\n", 1)
    parsed = parse_plan("dbplan 1 stress\nfrom empty\n\n" + document)
    if parsed["plan"] is None:
        raise AssertionError(f"stress plan diagnostics: {parsed['diagnostics'][:1]}")
    if len(parsed["plan"]["schema"].tables) != 100:
        raise AssertionError("stress plan does not contain exactly 100 tables")
    return parsed["plan"]


def history(conn: Conn) -> list:
    rows = conn.execute('SELECT "name", "state", "step" FROM "dbspec$plans"', [])[
        "rows"
    ]
    return sorted(tuple(row) for row in rows)


def database_dsns() -> dict:
    """The DSN of each dialect from TEST_ENV; SQLite needs none, and a missing server DSN stops the case."""
    dsns = {
        "mysql": os.environ.get("ORM_TEST_MYSQL_DSN"),
        "postgres": os.environ.get("ORM_TEST_POSTGRES_DSN"),
        "sqlite": None,
    }
    for dialect in ("mysql", "postgres"):
        if not dsns[dialect]:
            raise RuntimeError(
                f"ORM_TEST_{dialect.upper()}_DSN is required; pass TEST_ENV"
            )
    return dsns


class DbspecApplyTest(unittest.TestCase):
    deadline = testcase.DATABASE

    # Requirement: PLN-104.
    def test_stress_plan_commits_each_step_and_leaves_no_postgres_relation_locks(
        self,
    ) -> None:
        plan = stress_plan()
        dsns = {
            "mysql": os.environ.get("ORM_TEST_MYSQL_SERVER_DSN"),
            "postgres": os.environ.get("ORM_TEST_POSTGRES_SERVER_DSN"),
            "sqlite": None,
        }
        for dialect in ("mysql", "postgres"):
            if not dsns[dialect]:
                raise RuntimeError(
                    f"ORM_TEST_{dialect.upper()}_SERVER_DSN is required; pass TEST_ENV"
                )
        with tempfile.TemporaryDirectory(prefix="dbspec-apply-stress-") as tmp:
            for index, dialect in enumerate(("mysql", "postgres", "sqlite")):
                name = f"dbspec_apply_stress_{os.getpid()}_{index}"
                with case_database(dialect, name, dsns[dialect], tmp) as connection:
                    adapter = ApplyAdapter(dialect, connection)
                    for rule in CONNECTION_RULES[dialect]:
                        adapter.execute(rule)
                    watch = None
                    pid = None
                    if dialect == "postgres":
                        locks = adapter.execute("SHOW max_locks_per_transaction")[
                            "rows"
                        ]
                        self.assertEqual(
                            locks, [["64"]], "PostgreSQL default relation-lock limit"
                        )
                        pid = adapter.execute("SELECT pg_backend_pid()")["rows"][0][0]
                        watch = psycopg.connect(dsns[dialect], autocommit=True)
                        ApplyAdapter(dialect, watch).execute(
                            f'SET search_path TO "{name}"'
                        )

                    applied = 0
                    try:

                        def observe(event):
                            nonlocal applied
                            if event["kind"] != "applied":
                                return
                            applied += 1
                            if watch is not None:
                                locks = watch.execute(
                                    "SELECT COUNT(*) FROM pg_locks "
                                    "WHERE pid = %s AND locktype = 'relation'",
                                    (pid,),
                                ).fetchone()[0]
                                self.assertEqual(
                                    locks,
                                    0,
                                    f"PostgreSQL relation locks remain after step {applied}",
                                )

                        apply_plans(adapter, dialect, [plan], lambda: NOW, observe)
                    finally:
                        if watch is not None:
                            watch.close()

                    steps = plan_steps(None, plan, dialect)["steps"]
                    self.assertEqual(applied, len(steps), f"{dialect} applied events")
                    quote = "`" if dialect == "mysql" else '"'
                    rows = adapter.execute(
                        f"SELECT name, state, step FROM {quote}dbspec$plans{quote} ORDER BY name"
                    )["rows"]
                    self.assertEqual(
                        rows,
                        [["stress", "applied", len(steps)]],
                        f"{dialect} complete step history",
                    )

    # Requirements: PLN-93, PLN-95, PLN-96.
    def test_sqlite_scenarios(self) -> None:
        with tempfile.TemporaryDirectory(prefix="dbspec-apply-") as tmp:
            scenarios(tmp)

    # Requirement: PLN-90. A real held lock bounds apply on SQLite, MySQL, and PostgreSQL.
    def _test_lock_wait(self, dialect: str, index: int) -> None:
        dsns = {
            "mysql": os.environ.get("ORM_TEST_MYSQL_DSN"),
            "postgres": os.environ.get("ORM_TEST_POSTGRES_DSN"),
            "sqlite": None,
        }
        if dialect in ("mysql", "postgres") and not dsns[dialect]:
            raise RuntimeError(
                f"ORM_TEST_{dialect.upper()}_DSN is required; pass TEST_ENV"
            )
        vectors = str(ROOT / "tests" / "dbspec" / "plans.json")
        with tempfile.TemporaryDirectory(prefix="dbspec-apply-lock-wait-") as tmp:
            name = f"dbspec_apply_lock_wait_{os.getpid()}_{index}"
            with case_database(dialect, name, dsns[dialect], tmp) as connection:
                blocker = None
                try:
                    if dialect == "mysql":
                        blocker = mysql_connect(dsns[dialect], name)
                    elif dialect == "postgres":
                        blocker = psycopg.connect(dsns[dialect], autocommit=True)
                        ApplyAdapter(dialect, blocker).execute(
                            f'SET search_path TO "{name}"'
                        )
                    else:
                        path = connection.execute("PRAGMA database_list").fetchone()[2]
                        blocker = sqlite3.connect(path, isolation_level=None)
                    result = run_lock_wait(dialect, "", connection, vectors, blocker)
                    expected = "error locked" if dialect == "sqlite" else "error failed"
                    self.assertEqual(result, expected, dialect)
                finally:
                    if blocker is not None:
                        blocker.close()

    def test_lock_wait_mysql(self) -> None:
        self._test_lock_wait("mysql", 0)

    def test_lock_wait_postgres(self) -> None:
        self._test_lock_wait("postgres", 1)

    def test_lock_wait_sqlite(self) -> None:
        self._test_lock_wait("sqlite", 2)

    # Requirements: PLN-105.
    def test_apply_through_a_transaction_pooler(self) -> None:
        server_dsn = os.environ.get("ORM_TEST_POSTGRES_SERVER_DSN")
        pooler_dsn = os.environ.get("ORM_TEST_PGBOUNCER_DSN")
        if not server_dsn or not pooler_dsn:
            raise RuntimeError(
                "ORM_TEST_POSTGRES_SERVER_DSN and ORM_TEST_PGBOUNCER_DSN are required; pass TEST_ENV"
            )
        plans = chain()

        def run_scenario(name: str, hold_session: bool) -> None:
            database = f"orm_case_{os.getpid()}_{uuid.uuid4().hex[:12]}_pooler_{name}"
            admin = psycopg.connect(server_dsn, autocommit=True)
            created = False
            apply = None
            other = None
            try:
                admin.execute(f'CREATE DATABASE "{database}"')
                created = True
                apply = psycopg.connect(
                    pooler_dsn,
                    dbname=database,
                    autocommit=True,
                    prepare_threshold=None,
                )
                other = psycopg.connect(
                    pooler_dsn,
                    dbname=database,
                    autocommit=True,
                    prepare_threshold=None,
                )
                adapter = ApplyAdapter("postgres", apply)
                if not hold_session:
                    other.execute(
                        "SELECT pg_advisory_lock(hashtext('dbspec$plans'), hashtext(current_schema()))"
                    )
                held = False

                def take_apply_session(event) -> None:
                    nonlocal held
                    if hold_session and event["kind"] == "statement" and not held:
                        held = True
                        other.execute("BEGIN")
                        other.execute("SELECT 1")

                try:
                    apply_plans(
                        adapter,
                        "postgres",
                        plans,
                        lambda: NOW,
                        take_apply_session if hold_session else None,
                    )
                except DbspecApplyError as error:
                    self.assertEqual(error.code, "session", name)
                    self.assertIn(
                        "a direct or session-pooled connection", error.detail, name
                    )
                else:
                    self.fail(f"{name}: apply through a transaction pooler succeeded")
                if held:
                    other.execute("ROLLBACK")
            finally:
                if other is not None:
                    other.close()
                if apply is not None:
                    apply.close()
                if created:
                    admin.execute(f'DROP DATABASE "{database}" WITH (FORCE)')
                admin.close()

        run_scenario("lock_shared", False)
        run_scenario("session_changed", True)

    # Requirements: PLN-91, PLN-92.
    def test_history_and_state_on_every_database(self) -> None:
        dsns = database_dsns()
        plans = chain()
        with tempfile.TemporaryDirectory(prefix="dbspec-apply-state-") as tmp:
            for index, dialect in enumerate(("mysql", "postgres", "sqlite")):
                name = f"dbspec_apply_state_{os.getpid()}_{index}"
                with case_database(dialect, name, dsns[dialect], tmp) as connection:
                    adapter = ApplyAdapter(dialect, connection)
                    for rule in CONNECTION_RULES[dialect]:
                        adapter.execute(rule)
                    events = []
                    apply_plans(adapter, dialect, plans, lambda: NOW, events.append)
                    quote = "`" if dialect == "mysql" else '"'
                    history_table = f"{quote}dbspec$plans{quote}"
                    rows = adapter.execute(
                        f"SELECT name, from_hash, to_hash, state, step, steps, applied_at "
                        f"FROM {history_table} ORDER BY name"
                    )["rows"]
                    self.assertEqual(
                        len(rows), 2, f"{dialect}: one history row per plan"
                    )
                    self.assertEqual(
                        rows[0],
                        [
                            plans[0]["name"],
                            "empty",
                            plans[0]["to"],
                            "applied",
                            len(plan_steps(None, plans[0], dialect)["steps"]),
                            len(plan_steps(None, plans[0], dialect)["steps"]),
                            "2023-11-14T22:13:20.000000Z",
                        ],
                        f"{dialect}: history values and microsecond clock",
                    )
                    self.assertEqual(
                        rows[1][0:4],
                        [plans[1]["name"], plans[1]["from"], plans[1]["to"], "applied"],
                    )
                    second_steps = len(
                        plan_steps(plans[0]["schema"], plans[1], dialect)["steps"]
                    )
                    self.assertEqual(
                        rows[1][4:6],
                        [second_steps, second_steps],
                        f"{dialect}: all steps recorded",
                    )
                    before = [tuple(row) for row in rows]
                    repeated_events = []
                    apply_plans(
                        adapter, dialect, plans, lambda: NOW, repeated_events.append
                    )
                    self.assertEqual(
                        repeated_events, [], f"{dialect}: identical apply is a no-op"
                    )
                    self.assertEqual(
                        [
                            tuple(row)
                            for row in adapter.execute(
                                f"SELECT name, from_hash, to_hash, state, step, steps, applied_at "
                                f"FROM {history_table} ORDER BY name"
                            )["rows"]
                        ],
                        before,
                        f"{dialect}: repeated apply preserves history state",
                    )
                    adapter.execute(
                        "CREATE TABLE external_drift (id integer PRIMARY KEY)"
                    )
                    with self.assertRaises(DbspecApplyError) as raised:
                        apply_plans(adapter, dialect, plans, lambda: NOW)
                    self.assertEqual(
                        raised.exception.code,
                        "drift",
                        f"{dialect}: schema differs from recorded state",
                    )

                for command_name, command in (
                    ("apply", apply_plans),
                    ("recover", recover_plans),
                    ("rollback", rollback_plans),
                    ("finalize", finalize_plans),
                ):
                    empty_name = (
                        f"dbspec_apply_empty_{os.getpid()}_{index}_{command_name}"
                    )
                    with case_database(
                        dialect, empty_name, dsns[dialect], tmp
                    ) as connection:
                        adapter = ApplyAdapter(dialect, connection)
                        events = []
                        command(adapter, dialect, [], lambda: NOW, events.append)
                        self.assertEqual(
                            events,
                            [],
                            f"{dialect} {command_name}: empty chain emits no events",
                        )
                        quote = "`" if dialect == "mysql" else '"'
                        rows = adapter.execute(
                            f"SELECT COUNT(*) FROM {quote}dbspec$plans{quote}"
                        )["rows"]
                        self.assertEqual(
                            rows,
                            [[0]],
                            f"{dialect} {command_name}: creates the empty history table",
                        )

    # Requirement: PLN-89.
    def test_lock_scope_on_every_database(self) -> None:
        dsns = database_dsns()
        plans = chain()
        with tempfile.TemporaryDirectory(prefix="dbspec-apply-lock-") as tmp:
            for index, dialect in enumerate(("mysql", "postgres", "sqlite")):
                name = f"dbspec_apply_lock_{os.getpid()}_{index}"
                with case_database(dialect, name, dsns[dialect], tmp) as connection:
                    first = ApplyAdapter(dialect, connection)
                    for rule in CONNECTION_RULES[dialect]:
                        first.execute(rule)
                    if dialect == "mysql":
                        same_connection = mysql_connect(dsns[dialect], name)
                    elif dialect == "postgres":
                        same_connection = psycopg.connect(
                            dsns[dialect], autocommit=True
                        )
                        ApplyAdapter(dialect, same_connection).execute(
                            f'SET search_path TO "{name}"'
                        )
                    else:
                        same_connection = sqlite3.connect(
                            os.path.join(tmp, name + ".sqlite"), isolation_level=None
                        )
                    same = ApplyAdapter(dialect, same_connection)
                    try:
                        for rule in CONNECTION_RULES[dialect]:
                            same.execute(rule)
                        lock_checked = False

                        def observe(event):
                            nonlocal lock_checked
                            if event["kind"] != "plan" or lock_checked:
                                return
                            lock_checked = True
                            with self.assertRaises(DbspecApplyError) as raised:
                                apply_plans(same, dialect, plans, lambda: NOW)
                            self.assertEqual(
                                raised.exception.code,
                                "locked",
                                f"{dialect}: same database is locked",
                            )
                            second_name = f"{name}_other"
                            with case_database(
                                dialect, second_name, dsns[dialect], tmp
                            ) as second_connection:
                                second = ApplyAdapter(dialect, second_connection)
                                for rule in CONNECTION_RULES[dialect]:
                                    second.execute(rule)
                                apply_plans(second, dialect, plans, lambda: NOW)
                                quote = "`" if dialect == "mysql" else '"'
                                rows = second.execute(
                                    f"SELECT COUNT(*) FROM {quote}dbspec$plans{quote}"
                                )["rows"]
                                self.assertEqual(
                                    rows,
                                    [[2]],
                                    f"{dialect}: other database/schema/file proceeds",
                                )

                        apply_plans(first, dialect, plans, lambda: NOW, observe)
                        self.assertTrue(
                            lock_checked,
                            f"{dialect}: lock-scope assertion ran inside the lock",
                        )
                    finally:
                        same_connection.close()

    # Requirements: PLN-101, PLN-106. This case checks that Python keeps the original failure and adds each cleanup error as a note in order.
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
        self.assertEqual(
            getattr(raised.exception, "__notes__", []),
            ["cleanup failed: release failed", "cleanup failed: restore failed"],
        )

    # Requirement: PLN-90. The in-memory SQLite case verifies the configured bound and
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
                apply_plans(conn, "sqlite", plans, lambda: NOW, observe)
            self.assertEqual(busy_during_apply, [5000])
            self.assertIn("PRAGMA busy_timeout = 5000", statements)
            self.assertEqual(raised.exception.code, "failed")
            self.assertEqual(raised.exception.plan, plans[0]["name"])
            self.assertEqual(raised.exception.step, 0)
            self.assertIsInstance(raised.exception.cause, sqlite3.OperationalError)
            self.assertEqual(str(raised.exception.cause), "database is locked")
        finally:
            conn.close()

    # Requirement: PLN-90. SQLite's apply lock waits on BEGIN EXCLUSIVE before any plan step.
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
                    apply_plans(connection, "sqlite", [], lambda: NOW)
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

    # Requirement: PLN-94.
    def test_finalize_removes_hidden_tables_and_columns(self) -> None:
        plans = representative_chain()
        conn = Conn(":memory:")
        try:
            apply_plans(conn, "sqlite", plans, lambda: NOW)
            finalize_plans(conn, "sqlite", plans, lambda: NOW)
            rows = history(conn)
            self.assertEqual(
                [row[0] for row in rows], sorted(plan["name"] for plan in plans)
            )
            self.assertTrue(all(row[1] == "done" for row in rows), rows)
            tables = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'", []
            )["rows"]
            self.assertFalse(
                any(
                    row[0].startswith("dbspec$") and row[0] != "dbspec$plans"
                    for row in tables
                ),
                tables,
            )
            for (table,) in tables:
                columns = conn.execute(f"PRAGMA table_info({table!r})", [])["rows"]
                self.assertFalse(
                    any(column[1].startswith("dbspec$") for column in columns),
                    (table, columns),
                )
        finally:
            conn.close()


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
