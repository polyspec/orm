# install-changed-database: every case of contracts/fixtures/install/changed_database.json installs its document set,
# changes the database outside the ORM with its statement, and requires a second install of the same set to fail with
# the dialect's code and message and to leave the database as it is (docs/spec/schema.md "Schema installation"), on SQLite,
# MySQL and PostgreSQL, as packages/ts/tests/install_changed_database.mjs and the other clients' tests do. MySQL and PostgreSQL need
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable fails the case. Each case is a test named by its
# id; a case passes when it agrees on every dialect.
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote, urlsplit

import psycopg
import pymysql

from polyspec.orm import OrmError, Schema, connect
from polyspec.orm.dbspec import dbspec_manifest, parse_dbspec
from . import testcase
from .case_database import case_database
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "install" / "changed_database.json").read_text(
        encoding="utf-8"
    )
)
DIALECTS = ("sqlite", "mysql", "postgres")
STATE = {}


def setUpModule():  # noqa: N802 - unittest's function name
    STATE["directory"] = tempfile.TemporaryDirectory(prefix="orm-install-changed-")


def tearDownModule():  # noqa: N802 - unittest's function name
    STATE["directory"].cleanup()


def schema_of(path: str) -> Schema:
    document, _positions, diagnostics = parse_dbspec(
        (ROOT / "contracts" / "fixtures" / path).read_text(), {}
    )
    if diagnostics:
        raise AssertionError(f"{path}: {diagnostics}")
    manifest, diagnostics = dbspec_manifest([document])
    if diagnostics:
        raise AssertionError(f"{path}: {diagnostics}")
    return Schema(manifest.manifest_text, manifest.manifest_hash)


def native(dialect: str, dsn: str, sql: str) -> None:
    """Runs one statement through the driver, outside the ORM."""
    if dialect == "sqlite":
        connection = sqlite3.connect(unquote(urlsplit(dsn).path), isolation_level=None)
        try:
            connection.execute(sql).fetchall()
        finally:
            connection.close()
        return
    if dialect == "mysql":
        url = urlsplit(dsn)
        connection = pymysql.connect(
            host=url.hostname,
            port=url.port,
            user=unquote(url.username or ""),
            password=unquote(url.password or ""),
            database=url.path[1:],
            autocommit=True,
        )
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                cursor.fetchall()
        finally:
            connection.close()
        return
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(sql)


def run_case(case: dict, dialect: str, dsn: str) -> None:
    schema = schema_of(case["document"])
    db = connect(dsn)
    try:
        db.utils().schema().install(schema)
        native(dialect, dsn, case["statement"])
        want = f"{case['expected']['code']}: {case['expected']['message'][dialect]}"
        try:
            db.utils().schema().install(schema)
        except OrmError as error:
            if error.code != case["expected"]["code"] or str(error) != want:
                raise AssertionError(
                    f"install over the changed database: {error}, want {want}"
                ) from None
        else:
            raise AssertionError(
                f"install over the changed database succeeded, want {want}"
            )
        native(dialect, dsn, case["remaining"])
    finally:
        db.close()


def check_case(test: unittest.TestCase, case: dict) -> None:
    """Runs the case on every dialect to its end, so one dialect's failure does not hide another's."""
    test.assertEqual(case["operation"], "install")
    failures = []
    for dialect in DIALECTS:
        try:
            with case_database(dialect, STATE["directory"].name, "orm_install") as dsn:
                run_case(case, dialect, dsn)
        except Exception as error:  # noqa: BLE001 - the case reports every dialect's error
            failures.append(f"{dialect}: {type(error).__name__}: {error}")
    if failures:
        test.fail("\n".join(failures))


class Case(VectorCase):
    """A case of contracts/fixtures/install/changed_database.json."""

    deadline = testcase.DATABASE


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    if not FIXTURE["cases"]:
        raise ValueError(
            "contracts/fixtures/install/changed_database.json has no cases"
        )
    tests.addTests(vector_tests(Case, FIXTURE["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
