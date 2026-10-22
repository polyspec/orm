# Runs the shared introspect case (tests/dbspec/introspect.json) with the Python client. For each case
# creates an empty database (MySQL), schema (PostgreSQL), or file (SQLite), and the rendered statements and the case's
# statements are run, the introspected document and unsupported objects are compared with the case, and it checks that what remains after the drop
# is nothing. MySQL and PostgreSQL use ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN (TEST_ENV)
# servers. The fourth element of an unsupported object is the rule its reason must include.
# make dbspec-introspect-python-check runs this file with the python in the venv.
import contextlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
import psycopg
from polyspec.orm.dbspec import emit_dbspec, parse_dbspec
from polyspec.orm.dbspec.introspect import introspect_dbspec
from polyspec.orm.dbspec.render import render_dbspec
from .runner_connect import Adapter, mysql_connect
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


# Same connection rules as tests/dbspec/introspect (packages/ts/tests/dbspec-introspect.mjs).
CONNECTION_RULES = {
    "mysql": ["SET time_zone = '+00:00'"],
    "postgres": ["SET TimeZone = 'UTC'"],
    "sqlite": ["PRAGMA foreign_keys = ON"],
}


@contextlib.contextmanager
def case_database(dialect, name, dsn, sqlite_dir):
    """Creates the case's empty database, schema or file and gives its connection. Fails if anything remains after the drop."""
    if dialect == "sqlite":
        path = os.path.join(sqlite_dir, name + ".sqlite")
        connection = sqlite3.connect(path, isolation_level=None)
        try:
            yield connection
        finally:
            connection.close()
            if os.path.exists(path):
                os.remove(path)
        return
    if dialect == "mysql":
        admin = mysql_connect(dsn, None)
        Adapter(admin).execute(f"CREATE DATABASE `{name}`")
        try:
            connection = mysql_connect(dsn, name)
            try:
                yield connection
            finally:
                connection.close()
        finally:
            Adapter(admin).execute(f"DROP DATABASE `{name}`")
            left = Adapter(admin).execute(
                "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s",
                (name,),
            )
            admin.close()
            assert left["rows"][0][0] == 0, f"database {name} remains after cleanup"
        return
    admin = psycopg.connect(dsn, autocommit=True)
    Adapter(admin).execute(f'CREATE SCHEMA "{name}"')
    try:
        connection = psycopg.connect(dsn, autocommit=True)
        try:
            Adapter(connection).execute("SET client_min_messages = warning")
            Adapter(connection).execute(f'SET search_path TO "{name}"')
            yield connection
        finally:
            connection.close()
    finally:
        # A case that needs a second schema creates it as <schema>_b.
        Adapter(admin).execute(f'DROP SCHEMA IF EXISTS "{name}_b" CASCADE')
        Adapter(admin).execute(f'DROP SCHEMA "{name}" CASCADE')
        left = Adapter(admin).execute(
            "SELECT COUNT(*) FROM pg_namespace WHERE nspname IN (%s, %s)",
            (name, f"{name}_b"),
        )
        admin.close()
        assert left["rows"][0][0] == 0, f"schema {name} remains after cleanup"


def check_case(case, index, dsns, sqlite_dir):
    dialect, case_id = case["dialect"], case["id"]
    texts = {name: "\n".join(lines) for name, lines in case["documents"].items()}
    documents = [
        parse_dbspec(text, {k: v for k, v in texts.items() if k != name})[0]
        for name, text in texts.items()
    ]
    statements = render_dbspec(documents, dialect)["statements"]
    name = f"dbspec_py_{os.getpid()}_{index}"
    schema = "main" if dialect == "sqlite" else name
    with case_database(dialect, name, dsns.get(dialect), sqlite_dir) as connection:
        db = Adapter(connection)
        for sql in [*CONNECTION_RULES[dialect], *statements]:
            db.execute(sql)
        for sql in case["statements"]:
            # {schema} is this case's database or schema name.
            db.execute(sql.replace("{schema}", schema))
        result = introspect_dbspec(db, dialect, "introspected")
    assert emit_dbspec(result["document"]).splitlines() == case["document"], (
        f"{case_id}: introspected document differs"
    )
    got = [[u["kind"], u["table"], u["name"]] for u in result["unsupported"]]
    want = [w[:3] for w in case["unsupported"]]
    assert got == want, f"{case_id}: unsupported objects differ: want {want}, got {got}"
    for u, w in zip(result["unsupported"], case["unsupported"]):
        if len(w) == 4:
            assert w[3] in u["reason"], (
                f"{case_id}: reason of {w[:3]} differs: want rule {w[3]!r}, got {u['reason']!r}"
            )


TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory()


def tearDownModule():
    TEMP["dir"].cleanup()


class Case(VectorCase):
    """A case of the vector file of this module."""

    deadline = testcase.DATABASE


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each introspect case, named by the case id. A failed case does not stop the others."""
    data = json.loads((ROOT / "tests" / "dbspec" / "introspect.json").read_text())
    dsns = {
        "mysql": os.environ.get("ORM_TEST_MYSQL_DSN"),
        "postgres": os.environ.get("ORM_TEST_POSTGRES_DSN"),
    }
    for dialect, dsn in dsns.items():
        if not dsn:
            raise SystemExit(
                f"ORM_TEST_{dialect.upper()}_DSN is required; run make dbspec-introspect-python-check, which passes TEST_ENV"
            )
    cases = list(enumerate(data["cases"]))
    tests.addTests(
        vector_tests(
            Case,
            cases,
            lambda _test, item: check_case(item[1], item[0], dsns, TEMP["dir"].name),
            lambda item: item[1]["id"],
        )
    )
    return tests


if __name__ == "__main__":
    testcase.main()
