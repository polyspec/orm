# The shared helpers of the Python tests. A native owner of a feature (scripts/features/coverage.mts) runs as
# `<python> -m <module> <case id>...`; coverage_main runs exactly the requested test methods, each of which prints its
# `CASE <id> [<database>] PASS` line.
import contextlib
import io
import sys
import unittest
from pathlib import Path

# The repository root, resolved from this file.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def coverage_main(test_class: type) -> None:
    """The entry point of a coverage program: `python -m <module> <case id>...` runs exactly the test methods of the
    command line, in their order, and exits nonzero when one fails; an unknown, repeated or missing ID is a usage error
    before any case runs. The checker reads the output as CASE lines only, so the unittest report is kept back and
    written to standard error when a case fails; a passing run writes nothing but the CASE lines and the PERF lines of a
    performance owner, which the checker reads apart from the CASE lines."""
    names = sorted(
        name[len("test_") :] for name in dir(test_class) if name.startswith("test_")
    )
    requested = sys.argv[1:]
    if (
        not requested
        or len(set(requested)) != len(requested)
        or any(i not in names for i in requested)
    ):
        raise SystemExit(
            f"usage: {Path(sys.argv[0]).name} {'|'.join(names)}...; got {requested}"
        )
    suite = unittest.TestSuite(test_class(f"test_{case_id}") for case_id in requested)
    report = io.StringIO()
    result = unittest.TextTestRunner(stream=report, verbosity=0).run(suite)
    if not result.wasSuccessful():
        sys.stderr.write(report.getvalue())
        raise SystemExit(1)


@contextlib.contextmanager
def native_session(driver: str, dsn: str):
    """Opens one connection on the database of a DSN through its native driver, outside the client under test, and
    yields a function that runs a statement and returns its rows as dicts in column order."""
    from urllib.parse import parse_qsl, unquote, urlsplit

    url = urlsplit(dsn)
    if driver == "sqlite":
        import sqlite3

        connection = sqlite3.connect(unquote(url.path), isolation_level=None)
        connection.row_factory = sqlite3.Row
        # The foreign keys are enforced, as by node:sqlite, which the TypeScript runner uses.
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield lambda sql: [dict(row) for row in connection.execute(sql).fetchall()]
        finally:
            connection.close()
        return
    parameters = dict(parse_qsl(url.query))
    if driver == "mysql":
        import pymysql
        import pymysql.cursors

        connection = pymysql.connect(
            host=url.hostname,
            port=url.port or 3306,
            unix_socket=parameters.get("socket"),
            user=unquote(url.username or ""),
            password=unquote(url.password or ""),
            database=unquote(url.path.lstrip("/")),
            autocommit=True,
            cursorclass=pymysql.cursors.DictCursor,
        )

        def run_mysql(sql: str) -> list[dict]:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                return list(cursor.fetchall())

        try:
            yield run_mysql
        finally:
            connection.close()
        return
    import psycopg
    from psycopg.rows import dict_row

    connection = psycopg.connect(
        host=parameters.get("host") or url.hostname,
        port=url.port or 5432,
        dbname=unquote(url.path.lstrip("/")),
        user=unquote(url.username or "") or None,
        password=unquote(url.password or "") or None,
        autocommit=True,
        row_factory=dict_row,
    )

    def run_postgres(sql: str) -> list[dict]:
        cursor = connection.execute(sql)
        return list(cursor.fetchall()) if cursor.description else []

    try:
        yield run_postgres
    finally:
        connection.close()


def native_query(driver: str, dsn: str, statements: list[str]) -> list[list[dict]]:
    """Runs statements on the database of a DSN through its native driver, outside the client under test, and
    returns the rows of each statement as dicts in column order."""
    with native_session(driver, dsn) as run:
        return [run(sql) for sql in statements]
