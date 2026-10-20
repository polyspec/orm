# Introspects one database with the Python client and writes it in the output format of tests/dbspec/introspect:
# canonical document on stdout and unsupported object lines "! kind<TAB>table<TAB>name", and "elapsed <ms>" on stderr.
# make dbspec-introspect-compare-check runs this file with the python in the venv (TestIntrospectCompare).
#
# Usage: python packages/python/tests/dbspec_introspect_runner.py <mysql|postgres|sqlite> <uri>
import sys
import time
from urllib.parse import unquote, urlsplit


import psycopg  # noqa: E402
import sqlite3  # noqa: E402

from polyspec.orm.dbspec import emit_dbspec  # noqa: E402
from polyspec.orm.dbspec.introspect import introspect_dbspec  # noqa: E402
from runner_connect import Adapter, mysql_connect  # noqa: E402


def connect(dialect, uri):
    """Opens the URI as the dialect's driver connection. This is the compare URI format of packages/go/internal/dialects."""
    url = urlsplit(uri)
    if dialect == "mysql" and url.scheme == "mysql":
        return mysql_connect(uri, url.path[1:])
    if dialect == "postgres" and url.scheme == "postgres":
        return psycopg.connect(uri, autocommit=True)
    if dialect == "sqlite" and uri.startswith("sqlite://"):
        return sqlite3.connect(unquote(uri[len("sqlite://") :]))
    raise SystemExit(f"python: unsupported URI {uri}")


def main() -> None:
    if len(sys.argv) != 3:
        sys.stderr.write(
            "usage: python packages/python/tests/dbspec_introspect_runner.py <mysql|postgres|sqlite> <uri>\n"
        )
        raise SystemExit(2)
    dialect, uri = sys.argv[1:]
    connection = connect(dialect, uri)
    try:
        start = time.perf_counter()
        result = introspect_dbspec(Adapter(connection), dialect, "introspected")
        elapsed = (time.perf_counter() - start) * 1000
        out = emit_dbspec(result["document"])
        for u in result["unsupported"]:
            out += f"! {u['kind']}\t{u['table']}\t{u['name']}\n"
        sys.stdout.write(out)
        sys.stderr.write(f"elapsed {elapsed:.1f}\n")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
