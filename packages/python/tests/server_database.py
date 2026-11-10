# The databases that a test case creates on the MySQL or PostgreSQL server of its dialect and drops when the case ends:
# server_database is the one create-and-drop that case_database, statement_fault, identity_load and schema_inspection
# use. A caller gives the DSN of the server (ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN, checked by the caller).
import contextlib
import os
import uuid
from urllib.parse import urlsplit, urlunsplit

import psycopg

from . import testcase
from .runner_connect import mysql_connect


def with_database(dsn: str, name: str) -> str:
    url = urlsplit(dsn)
    return urlunsplit((url.scheme, url.netloc, "/" + name, url.query, url.fragment))


def admin_connection(dialect: str, dsn: str):
    """A connection to the server of dsn with no database selected, which creates and drops the case databases."""
    if dialect in ("mysql", "mariadb"):
        return mysql_connect(dsn)
    return psycopg.connect(dsn, autocommit=True)


@contextlib.contextmanager
def server_database(dialect: str, dsn: str, name: str):
    """Creates the empty database name on the server of dsn, gives its DSN, and drops it and closes the administrative
    connection when the case ends. The drop is the last statement of that connection, so the foreign_key_checks that it
    turns off (DIA-212) reach no later statement."""
    admin = admin_connection(dialect, dsn)
    try:
        if dialect in ("mysql", "mariadb"):
            with admin.cursor() as cursor:
                cursor.execute(f"CREATE DATABASE `{name}`")
        else:
            admin.execute(f'CREATE DATABASE "{name}"')
        try:
            yield with_database(dsn, name)
        finally:
            if dialect in ("mysql", "mariadb"):
                with admin.cursor() as cursor:
                    # One session with foreign_key_checks = 0 (DIA-212): a DROP DATABASE that MariaDB cannot
                    # finish logs the tables it dropped as one DROP TABLE list under the checks of the session.
                    cursor.execute("SET SESSION foreign_key_checks = 0")
                    cursor.execute(f"DROP DATABASE `{name}`")
            else:
                admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    finally:
        admin.close()


class DropDiscardsItsSessionCase:
    """The case of the drop of a case database of dialect (mysql or mariadb) on the server of ORM_TEST_<DIALECT>_DSN: the
    drop turns the foreign_key_checks of its session off (DIA-212), so the next session of admin_connection has them on.
    The entries test_case_database_mysql and case_database_mariadb run it on the two servers of the MySQL dialect
    (DIA-200)."""

    deadline = testcase.DATABASE
    dialect = ""

    def test_next_admin_session_has_foreign_key_checks(self):
        variable = f"ORM_TEST_{self.dialect.upper()}_DSN"
        dsn = os.environ.get(variable)
        self.assertTrue(
            dsn, f"{variable} is required; run the test through its make target"
        )
        name = f"orm_drop_session_{uuid.uuid4().hex[:12]}"
        with server_database(self.dialect, dsn, name):
            pass
        admin = admin_connection(self.dialect, dsn)
        try:
            with admin.cursor() as cursor:
                cursor.execute("SELECT @@SESSION.foreign_key_checks")
                (checks,) = cursor.fetchone()
        finally:
            admin.close()
        self.assertEqual(
            checks, 1, "the next admin session has the foreign_key_checks of the drop"
        )
        testcase.step("the next admin session has foreign_key_checks 1")
