# A new empty database of a dialect for one case, dropped when the case ends, as packages/ts/tests/case-database.mjs
# gives the TypeScript tests. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN (TEST_ENV); a
# missing variable fails the case.
import contextlib
import os
import uuid

from .server_database import server_database
from .statement_fault import required_dsn


@contextlib.contextmanager
def case_database(dialect: str, directory: str, prefix: str):
    """The DSN of a new empty database named by prefix and a random part: a SQLite file in directory, or a MySQL or
    PostgreSQL database on the test server."""
    if dialect == "sqlite":
        yield f"sqlite://{os.path.join(directory, f'{prefix}_{uuid.uuid4().hex}.sqlite3')}"
        return
    dsn = required_dsn(dialect)
    name = f"{prefix}_{uuid.uuid4().hex[:12]}"
    with server_database(dialect, dsn, name) as case_dsn:
        yield case_dsn
