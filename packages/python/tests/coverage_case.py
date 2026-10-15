# The shared runner of the Python feature coverage tests (scripts/features/coverage.mts). The checker runs
# `<python> <file> <case id>...`, and the whole output must be `CASE <id> PASS` lines, so the runner runs
# exactly the requested cases in their order and writes that one line for each case that passed. A failure
# raises, so the process ends with a nonzero code and the error.
import sys
from pathlib import Path

# The repository root, resolved from this file.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def run_cases(cases):
    """Runs exactly the case IDs of the command line in their order, each on every coverage item of this file (the
    databases the manifest lists for it, or one item without a database). The output is `CASE <id> [<database>] PASS`
    for each case that passed on a database item, and `CASE <id> PASS` for an item without one. A case takes its item
    (driver, dsn) or None; an unknown, repeated or missing ID is an error before any case runs."""
    requested = sys.argv[1:]
    if (
        not requested
        or len(set(requested)) != len(requested)
        or any(i not in cases for i in requested)
    ):
        raise SystemExit(
            f"usage: {Path(sys.argv[0]).name} {'|'.join(cases)}...; got {requested}"
        )
    test = Path(sys._getframe(1).f_globals["__file__"]).resolve().relative_to(REPOSITORY_ROOT).as_posix()
    items = feature_items(test)
    for case_id in requested:
        for item in items:
            cases[case_id](item)
            if item is None:
                print(f"CASE {case_id} PASS", flush=True)
            else:
                print(f"CASE {case_id} [{item[0]}] PASS", flush=True)


def feature_items(test: str):
    """The coverage items of this test file from the feature manifest: the coverage resolver of scripts/features/coverage.mts
    (`--items`) gives one (driver, dsn) for each database the manifest lists for the file. A file without a database
    gives None. A DSN variable that is unset fails with its name."""
    import json
    import subprocess

    listed = subprocess.run(
        ["node", str(REPOSITORY_ROOT / "scripts/features/coverage.mts"), "--items", test],
        cwd=REPOSITORY_ROOT, capture_output=True, text=True, check=False,
    )
    if listed.returncode != 0:
        raise AssertionError(f"coverage items of {test}: {listed.stderr.strip()}")
    items = []
    for item in json.loads(listed.stdout):
        if item["database"] == "none":
            items.append(None)
        else:
            items.append((item["database"], item["dsn"]))
    return items or [None]


def native_query(driver: str, dsn: str, statements: list[str]) -> list[list[dict]]:
    """Runs statements on the database of a DSN through its native driver, outside the client under test, and
    returns the rows of each statement as dicts in column order."""
    from urllib.parse import parse_qsl, unquote, urlsplit

    url = urlsplit(dsn)
    results = []
    if driver == "sqlite":
        import sqlite3

        connection = sqlite3.connect(unquote(url.path), isolation_level=None)
        connection.row_factory = sqlite3.Row
        # The foreign keys are enforced, as by node:sqlite, which the TypeScript runner uses.
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            for sql in statements:
                results.append(
                    [dict(row) for row in connection.execute(sql).fetchall()]
                )
        finally:
            connection.close()
        return results
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
        try:
            for sql in statements:
                with connection.cursor() as cursor:
                    cursor.execute(sql)
                    results.append(list(cursor.fetchall()))
        finally:
            connection.close()
        return results
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
    try:
        for sql in statements:
            cursor = connection.execute(sql)
            results.append(list(cursor.fetchall()) if cursor.description else [])
    finally:
        connection.close()
    return results


def table_exists(driver: str, dsn: str, table: str) -> bool:
    """Whether a table exists in the database or schema the DSN connects to."""
    import re

    if not re.fullmatch(r"[a-z_][a-z0-9_]*", table):
        raise AssertionError(f"table name {table} is not a plain identifier")
    sql = {
        "mysql": "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() "
        f"AND TABLE_NAME = '{table}'",
        "postgres": "SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() "
        f"AND tablename = '{table}'",
        "sqlite": f"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '{table}'",
    }[driver]
    ((row,),) = native_query(driver, dsn, [sql])
    return int(row["n"]) == 1


def error_code(run) -> str | None:
    """The code of the ORM error that run raises, or None when it returns."""
    from polyspec.orm.errors import OrmError

    try:
        run()
    except OrmError as error:
        return error.code
    return None


def with_cleanup(body, cleanup) -> None:
    """Runs body, then cleanup even when body failed; a failed cleanup never hides the failure of the case."""
    failure = None
    try:
        body()
    except BaseException as error:  # noqa: BLE001
        failure = error
    try:
        cleanup()
    except BaseException as error:  # noqa: BLE001
        if failure is None:
            failure = error
        else:
            raise BaseExceptionGroup(
                "the case and its cleanup failed", [failure, error]
            ) from None
    if failure is not None:
        raise failure


def expect_equal(got, want, what: str) -> None:
    """Raises with both values when they differ; an assert statement would vanish under python -O."""
    if got != want:
        raise AssertionError(f"{what}: got {got!r}, want {want!r}")
