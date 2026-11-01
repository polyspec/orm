# Physical run of the rendered statements (tests/dbspec/ddl.json "behavior" steps): every case with behavior
# steps applies its rendered statements to a fresh MySQL database, PostgreSQL schema and SQLite file, then
# runs the steps of the vector. Requirement: DIA-113 (check-recipes CR16-1).
#
# Usage: ORM_TEST_MYSQL_SERVER_DSN=... ORM_TEST_POSTGRES_SERVER_DSN=... python -m unittest packages/python/tests/dbspec_render_physical.py
# Each DSN is required; the run fails naming the variable that is unset.
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

import psycopg
import pymysql
from polyspec.orm.dbspec.render import render_dbspec

from . import testcase
from .dbspec_ddl import parse_set
from .dbspec_introspect import CONNECTION_RULES, case_database
from .runner_connect import Adapter
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
DIALECTS = ("mysql", "postgres", "sqlite")
# The errors that the DB-API drivers of the three dialects raise for a statement that the database refuses.
REFUSED = (pymysql.MySQLError, psycopg.Error, sqlite3.Error)
DATA = json.loads((ROOT / "tests" / "dbspec" / "ddl.json").read_text())
DSNS = {
    "mysql": os.environ.get("ORM_TEST_MYSQL_SERVER_DSN"),
    "postgres": os.environ.get("ORM_TEST_POSTGRES_SERVER_DSN"),
}
TEMP = {}


def refused(db, sql: str) -> bool:
    """Whether the database refuses sql with the error of its driver."""
    try:
        db.execute(sql)
    except REFUSED:
        return True
    return False


def run_steps(db, dialect: str, steps: list) -> None:
    for step in steps:
        if "dialects" in step and dialect not in step["dialects"]:
            continue
        if "sql" in step:
            if step.get("fails"):
                if not refused(db, step["sql"]):
                    raise AssertionError(f"{dialect}: {step['sql']} must fail")
                continue
            db.execute(step["sql"])
            continue
        rows = db.execute(step["query"])["rows"]
        got = str(rows[0][0])
        if got != step["want"]:
            raise AssertionError(
                f"{dialect}: {step['query']}: want {step['want']!r}, got {got!r}"
            )


def check_physical(test: unittest.TestCase, case: dict) -> None:
    documents = parse_set(case["documents"])
    for dialect in DIALECTS:
        statements = render_dbspec(documents, dialect)["statements"]
        name = f"render_py_{os.getpid()}_{case['id'].replace('-', '_')}"
        with case_database(
            dialect, name, DSNS.get(dialect), TEMP["dir"].name
        ) as connection:
            db = Adapter(connection)
            for sql in [*CONNECTION_RULES[dialect], *statements]:
                db.execute(sql)
            run_steps(db, dialect, case["behavior"])


class Case(VectorCase):
    """A case of the vector file of this module."""


def setUpModule():
    for name, dialect in (
        ("ORM_TEST_MYSQL_SERVER_DSN", "mysql"),
        ("ORM_TEST_POSTGRES_SERVER_DSN", "postgres"),
    ):
        if not DSNS[dialect]:
            raise SystemExit(
                f"{name} is required for the physical run of the rendered statements; pass TEST_ENV"
            )
    TEMP["dir"] = tempfile.TemporaryDirectory()


def tearDownModule():
    TEMP["dir"].cleanup()


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test per case with behavior steps, named by the case id."""
    cases = [c for c in DATA["cases"] if c.get("behavior")]
    tests.addTests(vector_tests(Case, cases, check_physical))
    return tests


if __name__ == "__main__":
    testcase.main()
