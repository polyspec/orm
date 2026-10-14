# contracts/fixtures/identity_load.json의 공유 case를 Python client로 실행한다. compile case는 세 dialect의
# Engine으로 request를 compile해 statement나 오류를 비교하고, execute case는 database마다 새 case database에
# fixture를 설치한 뒤 각 step의 request를 그 database의 Engine으로 compile해 Db.execute로 실행하고, 마지막에
# 파일의 read SQL로 load_probe의 행을 native driver로 읽어 비교한다. MySQL과 PostgreSQL은
# ORM_TEST_MYSQL_DSN과 ORM_TEST_POSTGRES_DSN이 필요하며, 변수가 없으면 그 case는 실패한다.
import contextlib
import copy
import json
import os
import signal
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit

import psycopg
import pymysql

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from polyspec.orm.schema import Schema  # noqa: E402
from vector_case import VectorCase, vector_tests  # noqa: E402

CASES = json.loads((ROOT / 'contracts' / 'fixtures' / 'identity_load.json').read_text())
MODEL = model_of_documents(parse_document_set([(ROOT / CASES['fixture']).read_text()]))
SCHEMA = Schema(manifest_text=MODEL.manifest_text, manifest_hash=MODEL.manifest_hash,
                external_text=MODEL.external_text)
DIALECTS = ('mysql', 'postgres', 'sqlite')
DSN_VARIABLES = {'mysql': 'ORM_TEST_MYSQL_DSN', 'postgres': 'ORM_TEST_POSTGRES_DSN'}
# case 하나(한 database)의 wall-clock 기한이다: database 작업이 멈춘 case만 끝낸다.
CASE_SECONDS = 60
RAN = set()  # 시작한 (case, dialect) 쌍이다.
TEMP = {}


def setUpModule():
    TEMP['dir'] = tempfile.TemporaryDirectory(prefix='orm-identity-load-')


def tearDownModule():
    """파일의 모든 case가 실행되지 않았으면 실패한다."""
    TEMP['dir'].cleanup()
    expected = {(case['id'], dialect) for case in CASES['cases'] for dialect in DIALECTS}
    missing = sorted(expected - RAN)
    if missing:
        raise AssertionError(f'identity load cases did not run: {missing}')


class CaseTimeout(Exception):
    pass


@contextlib.contextmanager
def deadline(seconds: int, name: str):
    """case가 seconds 안에 끝나지 않으면 CaseTimeout을 던진다."""
    def expire(signum, frame):
        raise CaseTimeout(f'{name} did not finish within {seconds}s')
    previous = signal.signal(signal.SIGALRM, expire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def compile_request(dialect: str, request: dict) -> dict:
    """request에 fixture의 manifest_hash를 더해 dialect의 Engine으로 compile한다."""
    if 'manifest_hash' in request:
        raise AssertionError('request already holds manifest_hash')
    return Engine(MODEL, dialect).compile({'manifest_hash': MODEL.manifest_hash, **copy.deepcopy(request)})


def statements(plan: dict) -> list:
    """plan step마다 role, SQL, bind slot(출처, param slot의 번호, type), table이다."""
    out = []
    for step in plan['steps']:
        slots = []
        for slot in step['bind_slots']:
            s = {'from': slot['from']}
            if slot['from'] == 'param':
                s['param'] = slot['param']
            if slot['col_type']:
                s['type'] = slot['col_type']
            slots.append(s)
        out.append({'role': step['role'], 'sql': step['sql'], 'slots': slots, 'tables': step['tables']})
    return out


def check_error(error, code: str, message: str) -> None:
    if not isinstance(error, OrmError) or error.code != code or not str(error).endswith(message):
        raise AssertionError(f'error = {error!r}; want {code} {message!r}')


def required_dsn(dialect: str) -> str:
    value = os.environ.get(DSN_VARIABLES[dialect])
    if not value:
        raise AssertionError(f'{DSN_VARIABLES[dialect]} is required for the {dialect} identity load cases; '
                             f'run make test-servers and source its env file, which exports it')
    return value


def with_database(dsn: str, name: str) -> str:
    url = urlsplit(dsn)
    return urlunsplit((url.scheme, url.netloc, '/' + name, url.query, url.fragment))


def mysql_connection(dsn: str, database: str | None = None):
    url = urlsplit(dsn)
    return pymysql.connect(host=url.hostname, port=url.port, user=unquote(url.username or ''),
                           password=unquote(url.password or ''), database=database, autocommit=True)


@contextlib.contextmanager
def case_database(dialect: str):
    """빈 case database를 만들어 그 DSN을 주고, 끝나면 지운다."""
    if dialect == 'sqlite':
        path = os.path.join(TEMP['dir'].name, f'{uuid.uuid4().hex}.sqlite3')
        try:
            yield f'sqlite://{path}'
        finally:
            if os.path.exists(path):
                os.remove(path)
        return
    dsn = required_dsn(dialect)
    name = f'orm_t120_{os.getpid()}_{uuid.uuid4().hex[:8]}'
    if dialect == 'mysql':
        admin = mysql_connection(dsn)
        with admin.cursor() as cursor:
            cursor.execute(f'CREATE DATABASE `{name}`')
    else:
        admin = psycopg.connect(dsn, autocommit=True)
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        yield with_database(dsn, name)
    finally:
        try:
            if dialect == 'mysql':
                with admin.cursor() as cursor:
                    cursor.execute(f'DROP DATABASE `{name}`')
            else:
                admin.execute(f'DROP DATABASE "{name}"')
        finally:
            admin.close()


def read_rows(dialect: str, dsn: str) -> list:
    """파일의 read SQL로 load_probe의 행을 native driver로 읽는다."""
    sql = CASES['read'][dialect]
    if dialect == 'sqlite':
        connection = sqlite3.connect(urlsplit(dsn).path)
        try:
            rows = connection.execute(sql).fetchall()
        finally:
            connection.close()
    elif dialect == 'mysql':
        connection = mysql_connection(dsn, urlsplit(dsn).path.lstrip('/'))
        try:
            with connection.cursor() as cursor:
                cursor.execute(sql)
                rows = cursor.fetchall()
        finally:
            connection.close()
    else:
        with psycopg.connect(dsn, autocommit=True) as connection:
            rows = connection.execute(sql).fetchall()
    return [[row[0], row[1]] for row in rows]


def run_execute_case(dialect: str, case: dict) -> None:
    with case_database(dialect) as dsn:
        db = Db.connect_schema(dsn, SCHEMA)
        try:
            db.utils().schema().install(SCHEMA)
            for i, step in enumerate(case['steps']):
                plan = compile_request(dialect, step['request'])
                try:
                    db.execute(plan['steps'][0], list(step['params']))
                except Exception as error:  # noqa: BLE001
                    if 'error' not in step:
                        raise AssertionError(f'step {i}: execute: {error!r}') from error
                    try:
                        check_error(error, step['error'], step['message'])
                    except AssertionError as mismatch:
                        raise AssertionError(f'step {i}: {mismatch}') from error
                    continue
                if 'error' in step:
                    raise AssertionError(f'step {i}: execute succeeded; want {step["error"]} {step["message"]!r}')
        finally:
            db.close()
        got = read_rows(dialect, dsn)
        if got != case['expected']['rows']:
            raise AssertionError(f'rows = {got}, want {case["expected"]["rows"]}')


def compile_case(case: dict) -> list:
    """compile case를 세 dialect에서 실행하고 실패한 dialect의 이유를 돌려준다."""
    expected = case['expected']
    reasons = []
    for dialect in DIALECTS:
        RAN.add((case['id'], dialect))
        try:
            plan = compile_request(dialect, case['input'])
        except Exception as error:  # noqa: BLE001
            if 'error' not in expected:
                reasons.append(f'{dialect}: compile: {error!r}')
                continue
            try:
                check_error(error, expected['error'], expected['message'])
            except AssertionError as mismatch:
                reasons.append(f'{dialect}: {mismatch}')
            continue
        if 'error' in expected:
            reasons.append(f'{dialect}: compile succeeded; want {expected["error"]} {expected["message"]!r}')
            continue
        got = statements(plan)
        if not expected.get(dialect) or got != expected[dialect]:
            reasons.append(f'{dialect} statements: got {json.dumps(got)} want {json.dumps(expected.get(dialect))}')
    return reasons


def execute_case(case: dict) -> list:
    """execute case를 database마다 새 case database에서 기한 안에 실행하고 실패한 database의 이유를
    돌려준다. 한 database의 실패가 다른 database를 막지 않는다."""
    reasons = []
    for dialect in DIALECTS:
        RAN.add((case['id'], dialect))
        started = time.monotonic()
        try:
            with deadline(CASE_SECONDS, f'{case["id"]} on {dialect}'):
                run_execute_case(dialect, case)
        except Exception as error:  # noqa: BLE001
            reasons.append(f'{dialect}: {type(error).__name__}: {error} '
                           f'(elapsed={time.monotonic() - started:.3f}s)')
    return reasons


def check_case(test: unittest.TestCase, case: dict) -> None:
    """Runs one case of the file and prints its harness line `PASS|FAIL <case id> elapsed=...`."""
    name = case['id']
    started = time.monotonic()
    if case['operation'] == 'compile':
        reasons = compile_case(case)
    elif case['operation'] == 'execute':
        reasons = execute_case(case)
    else:
        reasons = [f'unknown operation {case["operation"]!r}']
    elapsed = time.monotonic() - started
    if reasons:
        print(f'FAIL {name} elapsed={elapsed:.3f}s: ' + '; '.join(reasons), flush=True)
        test.fail(f'{name}: ' + '; '.join(reasons))
    print(f'PASS {name} elapsed={elapsed:.3f}s', flush=True)


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each case of the file, named by the case id."""
    tests.addTests(vector_tests(Case, CASES['cases'], check_case))
    return tests

if __name__ == '__main__':
    # verbosity 0은 진행 문자를 쓰지 않아 harness 줄이 줄 머리에서 시작한다.
    unittest.main(verbosity=0)
