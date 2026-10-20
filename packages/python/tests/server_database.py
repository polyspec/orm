# The databases that a test case creates on the MySQL or PostgreSQL server of its dialect and drops when the case ends:
# server_database is the one create-and-drop that case_database, statement_fault, identity_load and schema_inspection
# use. A caller gives the DSN of the server (ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN, checked by the caller).
import contextlib
from urllib.parse import urlsplit, urlunsplit

import psycopg

from .runner_connect import mysql_connect


def with_database(dsn: str, name: str) -> str:
    url = urlsplit(dsn)
    return urlunsplit((url.scheme, url.netloc, "/" + name, url.query, url.fragment))


def admin_connection(dialect: str, dsn: str):
    """A connection to the server of dsn with no database selected, which creates and drops the case databases."""
    if dialect == "mysql":
        return mysql_connect(dsn)
    return psycopg.connect(dsn, autocommit=True)


@contextlib.contextmanager
def server_database(dialect: str, dsn: str, name: str):
    """Creates the empty database name on the server of dsn, gives its DSN, and drops it and closes the administrative
    connection when the case ends."""
    admin = admin_connection(dialect, dsn)
    try:
        if dialect == "mysql":
            with admin.cursor() as cursor:
                cursor.execute(f"CREATE DATABASE `{name}`")
        else:
            admin.execute(f'CREATE DATABASE "{name}"')
        try:
            yield with_database(dsn, name)
        finally:
            if dialect == "mysql":
                with admin.cursor() as cursor:
                    cursor.execute(f"DROP DATABASE `{name}`")
            else:
                admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
    finally:
        admin.close()
