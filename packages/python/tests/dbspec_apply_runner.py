# Applies the chain of tests/dbspec/plans.json (create-from-empty and rename-table-and-column) to one database with the
# Python client (docs/spec/plans.md "Apply"), the Python runner of the apply pair comparison (packages/go/internal/dialects
# TestApplyChainAcrossClients, make dbspec-apply-pairs-check), in the form of packages/ts/testing/dbspec/apply/typescript.mts. The
# action is apply-first (the first plan), apply (the whole chain), stop (stop after statement 1 of the second plan ran),
# recover (finish the interrupted plan) or rollback (undo the last plan of the history). stdout holds one result line:
# "ok", "stopped" or "error <code>". Any other error goes to stderr and the process ends with 1.
#
# Usage: python packages/python/tests/dbspec_apply_runner.py <apply-first|apply|stop|recover|rollback>
#        <mysql|postgres|sqlite> <uri> <plans.json>
import json
import sqlite3
import sys
from urllib.parse import unquote, urlsplit

import psycopg
import pymysql

from polyspec.orm.dbspec.apply import (
    DbspecApplyError,
    apply_plans,
    recover_plans,
    rollback_plans,
)
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.placeholders import for_mysql, for_postgres

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


def connect(dialect: str, uri: str):
    """Opens the URI as the driver connection of its dialect, in the compare URI form of packages/go/internal/dialects."""
    url = urlsplit(uri)
    if dialect == "mysql" and url.scheme == "mysql" and not url.query:
        return pymysql.connect(
            host=url.hostname,
            port=url.port,
            user=unquote(url.username or ""),
            password=unquote(url.password or ""),
            database=url.path[1:],
            autocommit=True,
        )
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


def main() -> None:
    if len(sys.argv) != 5:
        sys.stderr.write(
            "usage: python packages/python/tests/dbspec_apply_runner.py "
            "<apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>\n"
        )
        raise SystemExit(2)
    action, dialect, uri, vectors = sys.argv[1:]
    plans = chain(vectors)
    connection = connect(dialect, uri)
    try:
        result = run(action, dialect, connection, plans)
    finally:
        connection.close()
    print(result)


if __name__ == "__main__":
    main()
