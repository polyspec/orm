# 공유 introspect 사례(tests/dbspec/introspect.json)를 Python client로 실행한다. 사례마다
# 빈 database(MySQL), schema(PostgreSQL) 또는 file(SQLite)을 만들고, render한 statement와 사례의
# statement를 실행한 뒤 introspect한 문서와 미지원 객체를 사례와 비교하고, 지운 뒤 남은 것이
# 없는지 본다. MySQL과 PostgreSQL은 ORM_TEST_MYSQL_DSN과 ORM_TEST_POSTGRES_DSN(TEST_ENV)의
# 서버를 쓴다. 미지원 객체의 네 번째 원소는 reason이 포함해야 하는 rule이다.
# make dbspec-introspect-python-check가 이 파일을 venv의 python으로 실행한다.
import contextlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

import psycopg  # noqa: E402
import pymysql  # noqa: E402

from polyspec.orm.dbspec import emit_dbspec, parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.introspect import introspect_dbspec  # noqa: E402
from polyspec.orm.dbspec.render import render_dbspec  # noqa: E402

# tests/dbspec/introspect의 연결 규칙과 같다(packages/orm-npm/tests/dbspec-introspect.mjs).
CONNECTION_RULES = {
    'mysql': ["SET time_zone = '+00:00'"],
    'postgres': ["SET TimeZone = 'UTC'"],
    'sqlite': ['PRAGMA foreign_keys = ON'],
}


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


def mysql_connect(dsn, database):
    url = urlsplit(dsn)
    return pymysql.connect(host=url.hostname, port=url.port, user=unquote(url.username or ''),
                           password=unquote(url.password or ''), database=database, autocommit=True)


@contextlib.contextmanager
def case_database(dialect, name, dsn, sqlite_dir):
    """사례의 빈 database, schema 또는 file을 만들고 그 연결을 준다. 지운 뒤 남은 것이 있으면 실패한다."""
    if dialect == 'sqlite':
        path = os.path.join(sqlite_dir, name + '.sqlite')
        connection = sqlite3.connect(path, isolation_level=None)
        try:
            yield connection
        finally:
            connection.close()
            if os.path.exists(path):
                os.remove(path)
        return
    if dialect == 'mysql':
        admin = mysql_connect(dsn, None)
        Adapter(admin).execute(f'CREATE DATABASE `{name}`')
        try:
            connection = mysql_connect(dsn, name)
            try:
                yield connection
            finally:
                connection.close()
        finally:
            Adapter(admin).execute(f'DROP DATABASE `{name}`')
            left = Adapter(admin).execute(
                'SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s', (name,))
            admin.close()
            assert left['rows'][0][0] == 0, f'database {name} remains after cleanup'
        return
    admin = psycopg.connect(dsn, autocommit=True)
    Adapter(admin).execute(f'CREATE SCHEMA "{name}"')
    try:
        connection = psycopg.connect(dsn, autocommit=True)
        try:
            Adapter(connection).execute('SET client_min_messages = warning')
            Adapter(connection).execute(f'SET search_path TO "{name}"')
            yield connection
        finally:
            connection.close()
    finally:
        # 두 번째 schema가 필요한 case는 그것을 <schema>_b로 만든다.
        Adapter(admin).execute(f'DROP SCHEMA IF EXISTS "{name}_b" CASCADE')
        Adapter(admin).execute(f'DROP SCHEMA "{name}" CASCADE')
        left = Adapter(admin).execute(
            'SELECT COUNT(*) FROM pg_namespace WHERE nspname IN (%s, %s)', (name, f'{name}_b'))
        admin.close()
        assert left['rows'][0][0] == 0, f'schema {name} remains after cleanup'


def check_case(case, index, dsns, sqlite_dir):
    dialect, case_id = case['dialect'], case['id']
    texts = {name: '\n'.join(lines) for name, lines in case['documents'].items()}
    documents = [parse_dbspec(text, {k: v for k, v in texts.items() if k != name})[0]
                 for name, text in texts.items()]
    statements = render_dbspec(documents, dialect)['statements']
    name = f'dbspec_py_{os.getpid()}_{index}'
    schema = 'main' if dialect == 'sqlite' else name
    with case_database(dialect, name, dsns.get(dialect), sqlite_dir) as connection:
        db = Adapter(connection)
        for sql in [*CONNECTION_RULES[dialect], *statements]:
            db.execute(sql)
        for sql in case['statements']:
            # {schema}는 이 case의 database 또는 schema 이름이다.
            db.execute(sql.replace('{schema}', schema))
        result = introspect_dbspec(db, dialect, 'introspected')
    assert emit_dbspec(result['document']).splitlines() == case['document'], \
        f'{case_id}: introspected document differs'
    got = [[u['kind'], u['table'], u['name']] for u in result['unsupported']]
    want = [w[:3] for w in case['unsupported']]
    assert got == want, f'{case_id}: unsupported objects differ: want {want}, got {got}'
    for u, w in zip(result['unsupported'], case['unsupported']):
        if len(w) == 4:
            assert w[3] in u['reason'], \
                f'{case_id}: reason of {w[:3]} differs: want rule {w[3]!r}, got {u["reason"]!r}'


def main() -> None:
    data = json.loads((ROOT / 'tests' / 'dbspec' / 'introspect.json').read_text())
    dsns = {'mysql': os.environ.get('ORM_TEST_MYSQL_DSN'),
            'postgres': os.environ.get('ORM_TEST_POSTGRES_DSN')}
    for dialect, dsn in dsns.items():
        if not dsn:
            raise SystemExit(f'ORM_TEST_{dialect.upper()}_DSN is required; run make dbspec-introspect-python-check, which passes TEST_ENV')
    counts = {}
    failures = []
    with tempfile.TemporaryDirectory() as sqlite_dir:
        for index, case in enumerate(data['cases']):
            # 한 case의 실패가 다른 case를 막지 않도록 모두 실행하고 마지막에 보고한다.
            try:
                check_case(case, index, dsns, sqlite_dir)
            except AssertionError as error:
                failures.append(str(error))
            counts[case['dialect']] = counts.get(case['dialect'], 0) + 1
    if failures:
        raise SystemExit(f'{len(failures)} of {len(data["cases"])} cases differ:\n' + '\n'.join(failures))
    summary = ', '.join(f'{counts[d]} {d}' for d in sorted(counts))
    print(f'introspect: {len(data["cases"])} cases agree ({summary})')


if __name__ == '__main__':
    main()
