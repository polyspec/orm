# The databases that a test case creates on the MySQL or PostgreSQL server of its dialect and drops when the case ends:
# server_database is the one create-and-drop that case_database, statement_fault and schema_inspection
# use. A caller gives the DSN of the server (ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN, checked by the caller).
import contextlib
import os
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pymysql

from . import testcase
from .runner_connect import mysql_connect

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


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
            with testcase.ending(
                f"drop of {name}", lambda: drop_ended(dialect, dsn, name)
            ):
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


def drop_ended(dialect: str, dsn: str, name: str) -> None:
    """Drops the database name of a case that the harness ended (testcase.ending), on a connection of its own: a session
    of the case may still run a statement in it, which would hold the drop, so on MySQL and MariaDB each other session
    on the database is ended first; PostgreSQL ends them with the drop (WITH (FORCE))."""
    admin = admin_connection(dialect, dsn)
    try:
        if dialect in ("mysql", "mariadb"):
            with admin.cursor() as cursor:
                cursor.execute(
                    "SELECT ID FROM information_schema.PROCESSLIST WHERE DB = %s AND ID <> CONNECTION_ID()",
                    (name,),
                )
                for (session,) in cursor.fetchall():
                    try:
                        cursor.execute(f"KILL {int(session)}")
                    except pymysql.err.OperationalError as error:
                        # ER_NO_SUCH_THREAD: the session ended meanwhile.
                        if error.args[0] != 1094:
                            raise
                cursor.execute("SET SESSION foreign_key_checks = 0")
                cursor.execute(f"DROP DATABASE IF EXISTS `{name}`")
        else:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
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

    def test_a_case_ended_by_its_guard_drops_its_database(self):
        """A case that its step guard ends ends its process (testcase.StepGuard): its database is dropped all the same,
        though a session of the case still runs a statement in it."""
        variable = f"ORM_TEST_{self.dialect.upper()}_DSN"
        dsn = os.environ.get(variable)
        self.assertTrue(
            dsn, f"{variable} is required; run the test through its make target"
        )
        name = f"orm_drop_exit_{uuid.uuid4().hex[:12]}"
        program = (
            "import sys\n"
            "from packages.python.tests import testcase\n"
            "from packages.python.tests.server_database import admin_connection, server_database, with_database\n"
            "from packages.python.tests.runner_connect import mysql_connect\n"
            "dialect, dsn, name = sys.argv[1:4]\n"
            "with server_database(dialect, dsn, name) as case_dsn:\n"
            "    session = mysql_connect(case_dsn)\n"
            "    testcase.StepGuard('drop_exit', 3600, 0.5)\n"
            "    with session.cursor() as cursor:\n"
            "        cursor.execute('SELECT SLEEP(60)')\n"
        )
        ended = subprocess.run(
            [sys.executable, "-c", program, self.dialect, dsn, name],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            timeout=testcase.DATABASE,
        )
        self.assertEqual(ended.returncode, 1, ended.stderr)
        self.assertIn("drop_exit: no step was applied within 0.5s", ended.stderr)
        admin = admin_connection(self.dialect, dsn)
        try:
            with admin.cursor() as cursor:
                cursor.execute(
                    "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s",
                    (name,),
                )
                (left,) = cursor.fetchone()
        finally:
            admin.close()
        self.assertEqual(
            left, 0, f"the case database {name} is left after its guard ended the case"
        )
        testcase.step("a case ended by its guard leaves no database")
