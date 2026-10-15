# Schema inspection, table privileges and connection statistics of the Python client on SQLite, MySQL and
# PostgreSQL, the cases that packages/ts/tests/model.mjs (schemaEmpty), packages/php/tests/ModelTest.php
# (utilities) and packages/rust/tests/src/integration.rs (schema_empty) run: schema().empty() on a new case
# database, with an empty PostgreSQL schema other than public and with the installed tables; exists and installed;
# the privileges that only PostgreSQL supports; stats. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
import contextlib
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit
from . import testcase

import psycopg
import pymysql

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.database import Db, DbStats  # noqa: E402
from polyspec.orm.engine import model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.schema import Schema  # noqa: E402

MODEL = model_of_documents(
    parse_document_set([(ROOT / "contracts" / "fixtures" / "rollback.dbs").read_text()])
)
SCHEMA = Schema(
    manifest_text=MODEL.manifest_text,
    manifest_hash=MODEL.manifest_hash,
    external_text=MODEL.external_text,
)
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
            f"run make test-servers and source its env file, which exports it"
        )
    return value


def with_database(dsn: str, name: str) -> str:
    url = urlsplit(dsn)
    return urlunsplit((url.scheme, url.netloc, "/" + name, url.query, url.fragment))


@contextlib.contextmanager
def case_database(dialect: str):
    """Gives the DSN and the database name of a new empty case database and drops it at the end."""
    if dialect == "sqlite":
        yield f"sqlite://{TEMP['dir'].name}/{uuid.uuid4().hex}.sqlite3", None
        return
    dsn = required_dsn(dialect)
    name = f"orm_t147_{uuid.uuid4().hex[:12]}"
    if dialect == "mysql":
        url = urlsplit(dsn)
        admin = pymysql.connect(
            host=url.hostname,
            port=url.port,
            user=unquote(url.username or ""),
            password=unquote(url.password or ""),
            autocommit=True,
        )
        with admin.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE `{name}`")
    else:
        admin = psycopg.connect(dsn, autocommit=True)
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        yield with_database(dsn, name), name
    finally:
        try:
            if dialect == "mysql":
                with admin.cursor() as cursor:
                    cursor.execute(f"DROP DATABASE `{name}`")
            else:
                admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        finally:
            admin.close()


def postgres(dsn: str, statement: str) -> None:
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(statement)


def role_privileges(dsn: str, role: str) -> set:
    """The table privileges of a role on the probe table that need the usage of its schema."""
    with psycopg.connect(dsn, autocommit=True) as connection:
        if not connection.execute(
            "SELECT has_schema_privilege(%s, 'public', 'USAGE')", [role]
        ).fetchone()[0]:
            return set()
        return {
            p
            for p in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")
            if connection.execute(
                "SELECT has_table_privilege(%s, %s, %s)", [role, f"public.{TABLE}", p]
            ).fetchone()[0]
        }


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
        privileges = db.utils().privileges()
        if dialect == "mysql":
            self.assertTrue(schema.exists(name), "mysql: the case database is a schema")
            self.assertTrue(schema.installed(name, TABLE), "mysql: the installed table")
            self.assertFalse(
                schema.installed(name, "missing"), "mysql: a missing table"
            )
            self.assertEqual(
                self.code(lambda: privileges.inspect_table(f"public.{TABLE}")),
                "CAPABILITY_UNSUPPORTED",
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
            got = privileges.inspect_table(f"public.{TABLE}")
            self.assertTrue(
                got.select
                and got.insert
                and got.update
                and got.delete
                and got.truncate,
                f"postgres: the owner privileges {got}",
            )
            self.assertEqual(
                self.code(lambda: privileges.inspect_table(TABLE)),
                "CONFIG",
                "unqualified table",
            )
            self.assertEqual(
                self.code(
                    lambda: privileges.revoke_table(f"public.{TABLE}", "drop", "nobody")
                ),
                "CONFIG",
                "unsupported privilege",
            )
            # The test user may be a superuser, whose privileges the grants do not change, so a new role
            # receives them and the catalog reports its privileges.
            role = f"orm_t147_{uuid.uuid4().hex[:12]}"
            postgres(dsn, f'CREATE ROLE "{role}"')
            try:
                privileges.grant_table(f"public.{TABLE}", role)
                self.assertEqual(
                    role_privileges(dsn, role),
                    {"INSERT", "SELECT", "UPDATE", "DELETE"},
                    "postgres: the granted privileges",
                )
                privileges.revoke_table(f"public.{TABLE}", " select ", role)
                self.assertEqual(
                    role_privileges(dsn, role),
                    {"INSERT", "UPDATE", "DELETE"},
                    "postgres: SELECT revoked",
                )
            finally:
                postgres(dsn, f'DROP OWNED BY "{role}"')
                postgres(dsn, f'DROP ROLE "{role}"')
        else:
            self.assertFalse(
                schema.installed("ormexample", TABLE), "sqlite: a schema without tables"
            )
            self.assertEqual(
                self.code(lambda: privileges.grant_table(f"public.{TABLE}", "orm")),
                "CAPABILITY_UNSUPPORTED",
            )
        self.assertEqual(
            db.utils().stats(),
            DbStats(max_open_connections=10, open_connections=1, in_use=0, idle=1),
        )

    def test_sqlite(self):
        self.run_case("sqlite")

    def test_mysql(self):
        self.run_case("mysql")

    def test_postgres(self):
        self.run_case("postgres")


if __name__ == "__main__":
    testcase.main()
