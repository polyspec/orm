# A new empty database of a dialect for one case, dropped when the case ends, as packages/ts/tests/case-database.mjs
# gives the TypeScript tests. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN (TEST_ENV); a
# missing variable fails the case.
import contextlib
import os
import uuid

import psycopg

from .statement_fault import admin_mysql, required_dsn, with_database


@contextlib.contextmanager
def case_database(dialect: str, directory: str, prefix: str):
    """The DSN of a new empty database named by prefix and a random part: a SQLite file in directory, or a MySQL or
    PostgreSQL database on the test server."""
    if dialect == "sqlite":
        yield f"sqlite://{os.path.join(directory, f'{prefix}_{uuid.uuid4().hex}.sqlite3')}"
        return
    dsn = required_dsn(dialect)
    name = f"{prefix}_{uuid.uuid4().hex[:12]}"
    if dialect == "mysql":
        admin = admin_mysql(dsn)
        with admin.cursor() as cursor:
            cursor.execute(f"CREATE DATABASE `{name}`")
    else:
        admin = psycopg.connect(dsn, autocommit=True)
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        yield with_database(dsn, name)
    finally:
        if dialect == "mysql":
            with admin.cursor() as cursor:
                cursor.execute(f"DROP DATABASE `{name}`")
        else:
            admin.execute(f'DROP DATABASE "{name}"')
        admin.close()
