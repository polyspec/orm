# 한 database를 Python client로 introspect해 tests/dbspec/introspect의 출력 형식으로 쓴다:
# stdout에 canonical 문서와 미지원 객체 줄 "! kind<TAB>table<TAB>name", stderr에 "elapsed <ms>".
# make dbspec-introspect-compare-check가 이 파일을 venv의 python으로 실행한다(TestIntrospectCompare).
#
# Usage: python packages/orm-python/tests/dbspec_introspect_runner.py <mysql|postgres|sqlite> <uri>
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import psycopg  # noqa: E402
import pymysql  # noqa: E402
import sqlite3  # noqa: E402

from polyspec.orm.dbspec import emit_dbspec  # noqa: E402
from polyspec.orm.dbspec.introspect import introspect_dbspec  # noqa: E402


class Adapter:
    """introspect_dbspec이 쓰는 연결: execute(sql, values)가 {'rows': [...]}를 돌려준다."""

    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, values=()):
        cursor = self.connection.cursor()
        try:
            if values:
                cursor.execute(sql, values)
            else:
                cursor.execute(sql)
            rows = cursor.fetchall() if cursor.description else []
        finally:
            cursor.close()
        return {'rows': [list(row) for row in rows]}


def connect(dialect, uri):
    """URI를 dialect의 driver connection으로 연다. tests/dialects의 compare URI 형식이다."""
    url = urlsplit(uri)
    if dialect == 'mysql' and url.scheme == 'mysql':
        return pymysql.connect(host=url.hostname, port=url.port, user=unquote(url.username or ''),
                               password=unquote(url.password or ''), database=url.path[1:], autocommit=True)
    if dialect == 'postgres' and url.scheme == 'postgres':
        return psycopg.connect(uri, autocommit=True)
    if dialect == 'sqlite' and uri.startswith('sqlite://'):
        return sqlite3.connect(unquote(uri[len('sqlite://'):]))
    raise SystemExit(f'python: unsupported URI {uri}')


def main() -> None:
    if len(sys.argv) != 3:
        sys.stderr.write('usage: python packages/orm-python/tests/dbspec_introspect_runner.py <mysql|postgres|sqlite> <uri>\n')
        raise SystemExit(2)
    dialect, uri = sys.argv[1:]
    connection = connect(dialect, uri)
    try:
        start = time.perf_counter()
        result = introspect_dbspec(Adapter(connection), dialect, 'introspected')
        elapsed = (time.perf_counter() - start) * 1000
        out = emit_dbspec(result['document'])
        for u in result['unsupported']:
            out += f"! {u['kind']}\t{u['table']}\t{u['name']}\n"
        sys.stdout.write(out)
        sys.stderr.write(f'elapsed {elapsed:.1f}\n')
    finally:
        connection.close()


if __name__ == '__main__':
    main()
