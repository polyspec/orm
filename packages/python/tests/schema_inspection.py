# Schema inspection and connection statistics of the Python client on SQLite, MySQL and
# PostgreSQL, the cases that packages/ts/tests/model.mjs (schemaEmpty), packages/php/tests/ModelTest.php
# (utilities) and packages/rust/tests/tests/integration_program/main.rs (schema_empty) run: schema().empty() on a new case
# database, with an empty PostgreSQL schema other than public and with the installed tables; exists and installed;
# stats. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
import contextlib
import os
import tempfile
import unittest
import uuid
from . import testcase

import psycopg

from .server_database import server_database

from polyspec.orm.database import Db, DbStats
from polyspec.orm.errors import OrmError
from .test_sqlite import rollback_schema

SCHEMA = rollback_schema()
TABLE = "rollback_probe"
DSN_VARIABLES = {"mysql": "ORM_TEST_MYSQL_DSN", "postgres": "ORM_TEST_POSTGRES_DSN"}
TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-schema-inspection-")


def tearDownModule():
    TEMP["dir"].cleanup()


def required_dsn(dialect: str) -> str:
    value = os.environ.get(DSN_VARIABLES[dialect])
    if not value:
        raise AssertionError(
            f"{DSN_VARIABLES[dialect]} is required for the {dialect} schema inspection cases; "
            f"run make orm-test-servers and source its env file, which exports it"
        )
    return value


@contextlib.contextmanager
def case_database(dialect: str):
    """Gives the DSN and the database name of a new empty case database and drops it at the end."""
    if dialect == "sqlite":
        yield f"sqlite://{TEMP['dir'].name}/{uuid.uuid4().hex}.sqlite3", None
        return
    dsn = required_dsn(dialect)
    name = f"orm_t147_{uuid.uuid4().hex[:12]}"
    with server_database(dialect, dsn, name) as case_dsn:
        yield case_dsn, name


def postgres(dsn: str, statement: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(statement)


class SchemaInspectionTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def code(self, call) -> str:
        with self.assertRaises(OrmError) as caught:
            call()
        return caught.exception.code

    def run_case(self, dialect: str) -> None:
        with case_database(dialect) as (dsn, name):
            db = Db.connect_schema(dsn, SCHEMA)
            try:
                self.inspect(dialect, db, dsn, name)
            finally:
                db.close()

    def inspect(self, dialect: str, db: Db, dsn: str, name: str | None) -> None:
        schema = db.utils().schema()
        self.assertTrue(schema.empty(), f"{dialect}: a database without tables")
        if dialect == "postgres":
            postgres(dsn, "CREATE SCHEMA unowned_empty")
            try:
                self.assertFalse(
                    schema.empty(), "postgres: an empty schema other than public"
                )
            finally:
                postgres(dsn, "DROP SCHEMA unowned_empty")
            self.assertTrue(schema.empty(), "postgres: the empty schema dropped")
        schema.install(SCHEMA)
        self.assertFalse(schema.empty(), f"{dialect}: installed tables")
        self.assertEqual(
            self.code(lambda: schema.exists("bad name")),
            "CONFIG",
            f"{dialect}: invalid schema name",
        )
        if dialect == "mysql":
            self.assertTrue(schema.exists(name), "mysql: the case database is a schema")
            self.assertTrue(schema.installed(name, TABLE), "mysql: the installed table")
            self.assertFalse(
                schema.installed(name, "missing"), "mysql: a missing table"
            )
        elif dialect == "postgres":
            self.assertTrue(schema.exists("public"), "postgres: public")
            self.assertFalse(
                schema.exists("unowned_empty"), "postgres: the dropped schema"
            )
            self.assertTrue(
                schema.installed("public", TABLE), "postgres: the installed table"
            )
            self.assertFalse(
                schema.installed("public", "missing"), "postgres: a missing table"
            )
        else:
            self.assertFalse(
                schema.installed("ormexample", TABLE), "sqlite: a schema without tables"
            )
        self.assertEqual(
            db.utils().stats(),
            DbStats(max_open_connections=10, open_connections=1, in_use=0, idle=1),
        )

    # Requirements: INT-57, INT-58, INT-59, INT-79.
    def test_sqlite(self):
        self.run_case("sqlite")

    # Requirements: INT-57, INT-58, INT-59, INT-79.
    def test_mysql(self):
        self.run_case("mysql")

    # Requirements: INT-57, INT-58, INT-59, INT-79.
    def test_postgres(self):
        self.run_case("postgres")


if __name__ == "__main__":
    testcase.main()
