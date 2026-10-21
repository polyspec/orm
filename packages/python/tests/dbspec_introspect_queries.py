# Counts the catalog queries that the Python client sends to introspect one case of tests/dbspec/introspect.json on each
# dialect (DIA-133: every query reads all tables at once, so their number does not depend on the table count). Each
# case is rendered and run in its empty database, schema or file, the same way dbspec_introspect.py runs it, and the
# number of queries introspect_dbspec sends must equal the number that packages/ts/tests/dbspec-introspect-round-trip.mjs
# asserts for the same dialect: MySQL 9, PostgreSQL 7, SQLite 3.
# make dbspec-introspect-python-check runs this file with the python in the venv.
import json
import os
import tempfile
import unittest
from pathlib import Path

from . import testcase
from .dbspec_introspect import CONNECTION_RULES, ROOT, case_database
from .runner_connect import Adapter

from polyspec.orm.dbspec import parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.introspect import introspect_dbspec  # noqa: E402
from polyspec.orm.dbspec.render import render_dbspec  # noqa: E402

# The counts that the TypeScript round-trip test asserts for each dialect (QUERY_COUNTS there).
QUERY_COUNTS = {"mysql": 9, "postgres": 7, "sqlite": 3}


class CountingAdapter:
    """Wraps an adapter and counts each execute of the introspection."""

    def __init__(self, inner):
        self.inner = inner
        self.count = 0

    def execute(self, sql, values=()):
        self.count += 1
        return self.inner.execute(sql, values)


def first_case(dialect):
    """The first case of tests/dbspec/introspect.json for the dialect."""
    data = json.loads((ROOT / "tests" / "dbspec" / "introspect.json").read_text())
    for case in data["cases"]:
        if case["dialect"] == dialect:
            return case
    raise AssertionError(f"tests/dbspec/introspect.json has no {dialect} case")


def count_queries(dialect, dsn, sqlite_dir, index):
    case = first_case(dialect)
    texts = {name: "\n".join(lines) for name, lines in case["documents"].items()}
    documents = [
        parse_dbspec(text, {k: v for k, v in texts.items() if k != name})[0]
        for name, text in texts.items()
    ]
    statements = render_dbspec(documents, dialect)["statements"]
    name = f"dbspec_pyq_{os.getpid()}_{index}"
    schema = "main" if dialect == "sqlite" else name
    with case_database(dialect, name, dsn, sqlite_dir) as connection:
        db = Adapter(connection)
        for sql in [*CONNECTION_RULES[dialect], *statements]:
            db.execute(sql)
        for sql in case["statements"]:
            db.execute(sql.replace("{schema}", schema))
        counting = CountingAdapter(db)
        introspect_dbspec(counting, dialect, "introspected")
    return counting.count


class DbspecIntrospectQueryCountTest(unittest.TestCase):
    """One test per dialect, named by the dialect."""

    @classmethod
    def setUpClass(cls):
        cls.sqlite_dir = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.sqlite_dir.cleanup()

    def _check(self, dialect, dsn):
        got = count_queries(dialect, dsn, self.sqlite_dir.name, 0)
        self.assertEqual(
            QUERY_COUNTS[dialect],
            got,
            f"{dialect}: introspection sent {got} queries, want {QUERY_COUNTS[dialect]}",
        )

    # Requirements: DIA-133.
    def test_sqlite(self):
        self._check("sqlite", None)

    # Requirements: DIA-133.
    def test_mysql(self):
        dsn = os.environ.get("ORM_TEST_MYSQL_DSN")
        if not dsn:
            raise SystemExit("ORM_TEST_MYSQL_DSN is required; run make dbspec-introspect-python-check, which passes TEST_ENV")
        self._check("mysql", dsn)

    # Requirements: DIA-133.
    def test_postgres(self):
        dsn = os.environ.get("ORM_TEST_POSTGRES_DSN")
        if not dsn:
            raise SystemExit("ORM_TEST_POSTGRES_DSN is required; run make dbspec-introspect-python-check, which passes TEST_ENV")
        self._check("postgres", dsn)


if __name__ == "__main__":
    testcase.main()
