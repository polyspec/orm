# Applies the chain of tests/dbspec/plans.json (create-from-empty and rename-table-and-column) to one database with the
# Python client (docs/spec/plans.md "Apply"), the Python runner of the apply pair comparison (packages/go/internal/dialects
# TestApplyChainAcrossClients, make dbspec-apply-pairs-check), in the form of packages/ts/testing/dbspec/apply/typescript.mts. The
# action is apply-first (the first plan), apply (the whole chain), stop (stop after statement 1 of the second plan ran),
# recover (finish the interrupted plan), rollback (undo the last plan), apply-representative (apply the representative
# plan), finalize (finalize that plan), or lock-wait (hold a database lock while an apply statement waits). stdout holds one result line:
# "ok", "stopped" or "error <code>". Any other error goes to stderr and the process ends with 1.
#
# Usage: python packages/python/tests/dbspec_apply_runner.py <apply-first|apply|stop|recover|rollback>
#        <mysql|postgres|sqlite> <uri> <plans.json>
import json
import sqlite3
import sys
import time
from urllib.parse import unquote, urlsplit

import psycopg

from polyspec.orm.dbspec.apply import (
    DbspecApplyError,
    apply_plans,
    finalize_plans,
    recover_plans,
    rollback_plans,
)
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.placeholders import for_mysql, for_postgres
from runner_connect import mysql_connect

# The statements every client runs on a new connection (packages/go/internal/dialects connectionRules).
CONNECTION_RULES = {
    "mysql": ["SET time_zone = '+00:00'"],
    "postgres": ["SET TimeZone = 'UTC'"],
    "sqlite": ["PRAGMA foreign_keys = ON"],
}
# The tool clock: 2026-10-01T00:00:00.123456789Z cut to microseconds since the epoch.
NOW = 1_790_812_800_000_000 + 123_456


class Adapter:
    """The connection apply takes: execute(sql, values) returns {'rows': [...]}. The engine writes `?` for MySQL and
    SQLite and `$n` for PostgreSQL; the driver statement is formed as the client's own connection forms it."""

    def __init__(self, dialect: str, connection) -> None:
        self.dialect = dialect
        self.connection = connection

    def execute(self, sql: str, values=()):
        values = list(values)
        if self.dialect == "sqlite":
            cursor = self.connection.execute(sql, tuple(values))
            rows = cursor.fetchall()
            cursor.close()
            return {"rows": [list(row) for row in rows]}
        text, args = (for_mysql if self.dialect == "mysql" else for_postgres)(
            sql, values
        )
        cursor = self.connection.cursor()
        try:
            cursor.execute(text, args)
            rows = cursor.fetchall() if cursor.description else []
        finally:
            cursor.close()
        return {"rows": [list(row) for row in rows]}


class ReleaseSQLiteBlocker:
    """Releases the real file lock as soon as SQLite reports its bounded wait expired."""

    def __init__(self, connection, blocker) -> None:
        self.connection = connection
        self.blocker = blocker

    def execute(self, sql: str, values=()):
        try:
            return self.connection.execute(sql, tuple(values))
        except sqlite3.OperationalError:
            if sql == "BEGIN EXCLUSIVE" and self.blocker.in_transaction:
                self.blocker.execute("ROLLBACK")
            raise


def connect(dialect: str, uri: str):
    """Opens the URI as the driver connection of its dialect, in the compare URI form of packages/go/internal/dialects."""
    url = urlsplit(uri)
    if dialect == "mysql" and url.scheme == "mysql" and not url.query:
        return mysql_connect(uri, url.path[1:])
    if dialect == "postgres" and url.scheme == "postgres":
        return psycopg.connect(uri, autocommit=True)
    if dialect == "sqlite" and url.scheme == "sqlite" and not url.query:
        return sqlite3.connect(unquote(uri[len("sqlite://") :]), isolation_level=None)
    raise ValueError(f"{dialect}: unsupported URI {uri}")


def chain(vectors: str) -> list:
    """The plans create-from-empty and rename-table-and-column of plans.json, parsed."""
    with open(vectors, encoding="utf-8") as handle:
        cases = json.load(handle)["cases"]
    plans = []
    for case in cases:
        if case["id"] in ("create-from-empty", "rename-table-and-column"):
            parsed = parse_plan("\n".join(case["plan"]) + "\n")
            if parsed["plan"] is None:
                raise ValueError(f"{case['id']}: {parsed['diagnostics']}")
            plans.append(parsed["plan"])
    if len(plans) != 2 or plans[1]["from"] != plans[0]["to"]:
        raise ValueError(
            "plans.json does not chain create-from-empty and rename-table-and-column"
        )
    return plans


def representative_chain(vectors: str) -> list:
    """A source plan followed by the shared representative plan with hidden objects to finalize."""
    with open(vectors, encoding="utf-8") as handle:
        cases = json.load(handle)["cases"]
    case = next(item for item in cases if item["id"] == "representative")
    source = parse_plan(
        "\n".join(["dbplan 1 base", "from empty", "", *case["source"]]) + "\n"
    )
    target = parse_plan("\n".join(case["plan"]) + "\n")
    if source["plan"] is None or target["plan"] is None:
        raise ValueError(
            f"representative: {source['diagnostics'][:1] or target['diagnostics'][:1]}"
        )
    return [source["plan"], target["plan"]]


class Stop(Exception):
    """The stop of the stop action, raised by the event handler."""


def run(action: str, dialect: str, connection, plans: list) -> str:
    adapter = Adapter(dialect, connection)
    for rule in CONNECTION_RULES[dialect]:
        adapter.execute(rule)
    second = plans[1]

    def stop(event: dict) -> None:
        if (
            event["kind"] == "applied"
            and event["plan"] == second["name"]
            and event["step"] == 1
        ):
            raise Stop()

    try:
        if action == "apply-first":
            apply_plans(adapter, dialect, plans[:1], lambda: NOW)
        elif action == "apply":
            apply_plans(adapter, dialect, plans, lambda: NOW)
        elif action == "recover":
            recover_plans(adapter, dialect, plans, lambda: NOW)
        elif action == "rollback":
            rollback_plans(adapter, dialect, plans, lambda: NOW)
        elif action == "apply-representative":
            apply_plans(adapter, dialect, plans, lambda: NOW)
        elif action == "finalize":
            finalize_plans(adapter, dialect, plans, lambda: NOW)
        elif action == "stop":
            apply_plans(adapter, dialect, plans, lambda: NOW, stop)
            raise RuntimeError("stop: apply did not stop")
        else:
            raise ValueError(f"unknown action {action}")
    except Stop:
        return "stopped"
    except DbspecApplyError as error:
        return f"error {error.code}"
    return "ok"


def run_lock_wait(
    dialect: str, uri: str, connection, vectors: str, blocker=None
) -> str:
    """Checks the SQLite lock-acquisition bound or a server statement lock wait."""
    adapter = Adapter(dialect, connection)
    owns_blocker = blocker is None
    if blocker is None:
        blocker = connect(dialect, uri)
    started = None
    try:
        for rule in CONNECTION_RULES[dialect]:
            adapter.execute(rule)
        if dialect == "sqlite":
            blocker.execute("BEGIN EXCLUSIVE")
            plans = []
            want_code = "locked"
            adapter.connection = ReleaseSQLiteBlocker(adapter.connection, blocker)
        else:
            plans = representative_chain(vectors)
            apply_plans(adapter, dialect, plans[:1], lambda: NOW)
            if dialect == "mysql":
                blocker.autocommit(False)
                cursor = blocker.cursor()
                try:
                    cursor.execute("INSERT INTO archive (note) VALUES ('lock wait')")
                    cursor.execute("SELECT id FROM archive FOR UPDATE")
                    cursor.fetchall()
                finally:
                    cursor.close()
            else:
                blocker.autocommit = False
                blocker.execute("INSERT INTO archive (note) VALUES ('lock wait')")
                blocker.execute("SELECT id FROM archive FOR UPDATE").fetchall()
            want_code = "failed"
        started = time.monotonic()
        step_events = []

        def observe(event):
            if event["kind"] in ("statement", "applied"):
                step_events.append((event["kind"], event["step"]))

        try:
            if dialect == "sqlite":
                apply_plans(adapter, dialect, [], lambda: NOW)
            else:
                apply_plans(adapter, dialect, plans, lambda: NOW, observe)
        except DbspecApplyError as error:
            elapsed = time.monotonic() - started
            if error.code != want_code:
                raise AssertionError(
                    f"lock wait returned {error.code}; want {want_code}"
                ) from error
            detail = str(error.cause).lower()
            if "lock" not in detail and "timeout" not in detail:
                raise AssertionError(
                    f"statement failure does not name the held lock: {error.cause}"
                ) from error
            if dialect != "sqlite" and (
                error.plan != "representative" or error.step != 0
            ):
                raise AssertionError(
                    f"statement lock wait failed at {error.plan} step {error.step}; want representative step 0"
                ) from error
            if dialect != "sqlite" and step_events != [("statement", 0)]:
                raise AssertionError(
                    f"step event sequence = {step_events}; want only statement 0"
                ) from error
            if elapsed < 4 or elapsed >= 10:
                raise AssertionError(
                    f"lock wait returned after {elapsed:.3f}s; want 4s <= elapsed < 10s"
                ) from error
            return f"error {error.code}"
        raise AssertionError("apply did not stop at the held database lock")
    finally:
        if dialect == "sqlite":
            if blocker.in_transaction:
                blocker.execute("ROLLBACK")
        else:
            blocker.rollback()
        if owns_blocker:
            blocker.close()


def main() -> None:
    if len(sys.argv) != 5:
        sys.stderr.write(
            "usage: python packages/python/tests/dbspec_apply_runner.py "
            "<apply-first|apply|stop|recover|rollback|apply-representative|finalize|lock-wait> "
            "<mysql|postgres|sqlite> <uri> <plans.json>\n"
        )
        raise SystemExit(2)
    action, dialect, uri, vectors = sys.argv[1:]
    plans = (
        representative_chain(vectors)
        if action in ("apply-representative", "finalize", "lock-wait")
        else chain(vectors)
    )
    connection = connect(dialect, uri)
    try:
        if action == "lock-wait":
            result = run_lock_wait(dialect, uri, connection, vectors)
        else:
            result = run(action, dialect, connection, plans)
    finally:
        connection.close()
    print(result)


if __name__ == "__main__":
    main()
