# The ops of the dbspec apply API (docs/spec/feature-coverage.md FCV-4): each command is one call of the public API on a named
# connection, and steps nested in its on field run inside the event handler.
import os
import sqlite3
import tempfile
import time
from urllib.parse import unquote, urlsplit

import psycopg

from polyspec.orm.dbspec import dbspec_manifest
from polyspec.orm.dbspec.apply import (
    DbspecApplyError,
    apply_plans,
    finalize_plans,
    recover_plans,
    rollback_plans,
)
from polyspec.orm.dbspec.introspect import introspect_dbspec
from polyspec.orm.dbspec.plan import parse_plan
from polyspec.orm.database import parse_dsn
from polyspec.orm.markdown import MarkdownConnection

from .case_database import case_database, case_server
from .dbspec_apply_runner import Adapter
from .runner_connect import mysql_connect

# The fixed clock of the commands in microseconds, 2023-11-14T22:13:20Z.
_NOW = 1_700_000_000_000_000
# The statements that a client runs on a new direct connection.
_CONNECTION_RULES = {
    "mysql": ["SET time_zone = '+00:00'"],
    "postgres": ["SET TimeZone = 'UTC'"],
    "sqlite": ["PRAGMA foreign_keys = ON"],
}
_SERVER_ENV = {
    "mysql": "ORM_TEST_MYSQL_SERVER_DSN",
    # MariaDB, a server of the MySQL dialect, is a server of its own (DIA-200, FCV-3).
    "mariadb": "ORM_TEST_MARIADB_SERVER_DSN",
    "postgres": "ORM_TEST_POSTGRES_SERVER_DSN",
}
_COMMANDS = {
    "dbspec.apply": apply_plans,
    "dbspec.recover": recover_plans,
    "dbspec.rollback": rollback_plans,
    "dbspec.finalize": finalize_plans,
}


def _dialect_of(database: str) -> str:
    """The SQL dialect of a case database: a corpus runs SQL in SQLite's (DIA-185), MariaDB in MySQL's (DIA-200)."""
    return {"markdown": "sqlite", "mariadb": "mysql"}.get(database, database)


class _Stop(Exception):
    """What an on with stop raises from the event handler, so the code of the command is stopped."""


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise AssertionError(
            f"{name} is required; run make orm-test-servers, which starts the databases and writes it"
        )
    return value


class _Session:
    """A named connection: the driver connection, the adapter that the apply API takes, and one statement as rows."""

    def __init__(self, dialect: str, connection) -> None:
        self.dialect = dialect
        self.connection = connection
        # A corpus session already runs a statement with its values and answers {'rows': [...]}.
        self.adapter = (
            connection
            if isinstance(connection, MarkdownConnection)
            else Adapter(dialect, connection)
        )

    def run(self, text: str) -> list:
        if isinstance(self.connection, MarkdownConnection):
            return self.connection.execute(text, [])["rows"]
        if self.dialect == "sqlite":
            cursor = self.connection.execute(text)
            rows = cursor.fetchall()
            cursor.close()
            return rows
        cursor = self.connection.cursor()
        try:
            cursor.execute(text)
            return cursor.fetchall() if cursor.description else []
        finally:
            cursor.close()

    def close(self) -> None:
        self.connection.close()


def _direct(context: dict, dsn: str) -> _Session:
    """The session of a direct connection to the database of the case DSN dsn, with the rules of a new connection."""
    database = context["database"]
    if database == "markdown":
        # A corpus is reached through one session of its flowmark server, which answers SQLite's statements (DIA-185).
        connection = MarkdownConnection(parse_dsn(dsn).markdown)
    elif database == "sqlite":
        connection = sqlite3.connect(
            unquote(dsn[len("sqlite://") :]), isolation_level=None
        )
    else:
        name = urlsplit(dsn).path[1:]
        server = _required(_SERVER_ENV[database])
        connection = (
            mysql_connect(server, name)
            if _dialect_of(database) == "mysql"
            else psycopg.connect(server, dbname=name, autocommit=True)
        )
    session = _Session(_dialect_of(database), connection)
    for rule in _CONNECTION_RULES[_dialect_of(database)]:
        session.run(rule)
    return session


def _session_of(step: dict, context: dict) -> _Session:
    session = context["bound"].get(step["connection"])
    if not isinstance(session, _Session):
        raise AssertionError(f"connection {step['connection']} is not bound")
    return session


def _cell(value) -> dict:
    if value is None:
        return {"null": True}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"text": bytes(value).decode()}
    return {"text": str(value)}


def _plan(step: dict, context: dict) -> dict:
    parsed = parse_plan("\n".join(step["lines"]) + "\n")
    if parsed["plan"] is None:
        raise AssertionError(f"dbspec.plan {step['as']}: {parsed['diagnostics']}")
    return {"bind": parsed["plan"]}


def _connect(step: dict, context: dict) -> dict:
    if step.get("through") == "pooler":
        session = _Session(
            "postgres",
            psycopg.connect(
                _required("ORM_TEST_PGBOUNCER_DSN"),
                dbname=urlsplit(context["dsn"]).path[1:],
                autocommit=True,
                prepare_threshold=None,
            ),
        )
    else:
        session = _direct(context, context["dsn"])
    context["closers"].append(session.close)
    return {"bind": session}


def _schema(step: dict, context: dict) -> dict:
    result = introspect_dbspec(
        _session_of(step, context).adapter,
        _dialect_of(context["database"]),
        case_server(context["database"]),
        "x",
    )
    if result["unsupported"]:
        raise AssertionError(f"dbspec.schema: unsupported {result['unsupported']}")
    document = result["document"]
    if not document.tables:
        return {"value": {"text": ""}}
    manifest, diagnostics = dbspec_manifest([document])
    if manifest is None:
        raise AssertionError(f"dbspec.schema: {diagnostics}")
    return {"value": {"text": manifest.schema_text}}


def apply_ops(sql, run_step) -> dict:
    """The ops of the apply API; sql and run_step are those of the recipe helper."""

    def exec_op(step: dict, context: dict) -> dict:
        text = sql(step["sql"], context).replace(
            "{step}", str(context.get("apply_step", 0))
        )
        rows = _session_of(step, context).run(text)
        return {
            "value": {"array": [{"array": [_cell(c) for c in row]} for row in rows]}
        }

    def other_database(step: dict, context: dict) -> dict:
        with (
            tempfile.TemporaryDirectory(prefix="orm_recipe_") as directory,
            case_database(context["database"], directory, "orm_recipe") as dsn,
        ):
            session = _direct(context, dsn)
            try:
                context["bound"][step["as"]] = session
                for nested in step["steps"]:
                    run_step(nested, context)
            finally:
                session.close()
        return {}

    def command(step: dict, context: dict) -> dict:
        session = _session_of(step, context)
        plans = [context["bound"][name] for name in step["plans"]]
        on = step.get("on")
        kinds: dict = {}
        state = {"events": 0, "ran": False}

        def handler(event: dict) -> None:
            state["events"] += 1
            kinds[event["kind"]] = kinds.get(event["kind"], 0) + 1
            if on is None or on["event"] != event["kind"]:
                return
            if state["ran"] and not on.get("every"):
                return
            if on.get("plan", event["plan"]) != event["plan"]:
                return
            if on.get("step", event["step"]) != event["step"]:
                return
            state["ran"] = True
            context["apply_step"] = event["step"]
            for nested in on.get("steps", []):
                run_step(nested, context)
            if on.get("stop"):
                raise _Stop()

        started = time.monotonic()
        code = "ok"
        try:
            _COMMANDS[step["op"]](
                session.adapter,
                _dialect_of(context["database"]),
                case_server(context["database"]),
                plans,
                lambda: _NOW,
                handler,
            )
        except _Stop:
            code = "stopped"
        except DbspecApplyError as error:
            code = error.code
            _holds(step, error)
        except Exception as error:
            if str(error) != step.get("message"):
                raise
            code = "message"
            _holds(step, error)
        elapsed = (time.monotonic() - started) * 1000
        bounds = step.get("elapsed")
        if bounds and not bounds["at_least_ms"] <= elapsed < bounds["below_ms"]:
            raise AssertionError(f"the command took {elapsed} ms, want {bounds}")
        members = [["code", {"text": code}]]
        if "count" not in step:
            members.append(["events", {"int": str(state["events"])}])
        for kind in step.get("count", []):
            members.append([kind, {"int": str(kinds.get(kind, 0))}])
        return {"value": {"object": members}}

    ops = {
        "dbspec.plan": _plan,
        "dbspec.connect": _connect,
        "dbspec.exec": exec_op,
        "dbspec.schema": _schema,
        "dbspec.other_database": other_database,
    }
    for name in _COMMANDS:
        ops[name] = command
    return ops


def _holds(step: dict, error: Exception) -> None:
    detail = step.get("detail")
    if detail is not None and detail.lower() not in str(error).lower():
        raise AssertionError(f"the message {error} does not hold {detail}")
