# The next statement of a connection fails deterministically with the code and message of the
# fixture contracts/fixtures/statement_fault.json through the test entry point
# polyspec.orm.testing.fail_next_statement (docs/protocol.md "3.2 Test statement fault"). Each case
# runs on SQLite, MySQL and PostgreSQL; MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
import contextlib
import importlib
import json
import os
import subprocess
import sys
import tempfile
import tomllib
import unittest
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit

import psycopg
import pymysql

from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]

from polyspec.orm.database import Db  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from . import testcase

FIXTURE = json.loads((ROOT / 'contracts' / 'fixtures' / 'statement_fault.json').read_text())
CODE = FIXTURE['code']
MESSAGE = FIXTURE['message']
DIALECTS = ('sqlite', 'mysql', 'postgres')
DSN_VARIABLES = {'mysql': 'ORM_TEST_MYSQL_DSN', 'postgres': 'ORM_TEST_POSTGRES_DSN'}
RAN = set()  # (case, dialect) pairs whose case started
MODELS = {}


def fail_next_statement(db, code, message) -> None:
    """test entry point를 그 module에서 읽어 부른다. module이 없으면 ModuleNotFoundError다."""
    importlib.import_module('polyspec.orm.testing').fail_next_statement(db, code, message)


def setUpModule():
    tmp = tempfile.TemporaryDirectory(prefix='orm-statement-fault-')
    MODELS['dir'] = tmp
    MODELS['models'] = generate_document(os.path.join(tmp.name, 'models'), ROOT / 'contracts' / 'fixtures' / 'rollback.dbs')


def tearDownModule():
    """fixture의 case가 모든 dialect에서 실행되지 않았으면 실패한다."""
    MODELS['dir'].cleanup()
    missing = [(case, dialect) for case in FIXTURE['cases'] for dialect in DIALECTS if (case, dialect) not in RAN]
    if missing:
        raise AssertionError(f'statement fault cases did not run: {missing}')


def required_dsn(dialect: str) -> str:
    value = os.environ.get(DSN_VARIABLES[dialect])
    if not value:
        raise AssertionError(f'{DSN_VARIABLES[dialect]} is required for the {dialect} statement fault cases; '
                             f'run make client-db-check, which passes the test servers')
    return value


def with_database(dsn: str, name: str) -> str:
    url = urlsplit(dsn)
    return urlunsplit((url.scheme, url.netloc, '/' + name, url.query, url.fragment))


def admin_mysql(dsn: str):
    url = urlsplit(dsn)
    return pymysql.connect(host=url.hostname, port=url.port, user=unquote(url.username or ''),
                           password=unquote(url.password or ''), autocommit=True)


@contextlib.contextmanager
def fresh_db(dialect: str):
    """빈 database를 만들고 rollback probe schema를 설치한 Db를 준다. 끝나면 그 database를 지운다."""
    models = MODELS['models']
    if dialect == 'sqlite':
        path = os.path.join(MODELS['dir'].name, f'{uuid.uuid4().hex}.sqlite3')
        db = Db.connect_schema(f'sqlite://{path}', models.SCHEMA)
        try:
            db.utils().schema().install(models.SCHEMA)
            yield db
        finally:
            db.close()
        return
    dsn = required_dsn(dialect)
    name = f'orm_t78_{uuid.uuid4().hex[:12]}'
    if dialect == 'mysql':
        admin = admin_mysql(dsn)
        with admin.cursor() as cursor:
            cursor.execute(f'CREATE DATABASE `{name}`')
    else:
        admin = psycopg.connect(dsn, autocommit=True)
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        db = Db.connect_schema(with_database(dsn, name), models.SCHEMA)
        try:
            db.utils().schema().install(models.SCHEMA)
            yield db
        finally:
            db.close()
    finally:
        if dialect == 'mysql':
            with admin.cursor() as cursor:
                cursor.execute(f'DROP DATABASE `{name}`')
            admin.close()
        else:
            admin.execute(f'DROP DATABASE "{name}"')
            admin.close()


class StatementFaultTest(unittest.TestCase):
    deadline = testcase.DATABASE
    def each_dialect(self, case: str, body):
        """case를 dialect마다 새 database에서 실행한다. case는 모든 dialect에서 통과해야 PASS다(testcase.py).

        한 dialect의 실패가 다른 dialect를 막지 않도록 각 dialect를 끝까지 실행하고, 실패한 dialect의 이유를 모아
        case의 실패 이유로 쓴다.
        """
        reasons = []
        for dialect in DIALECTS:
            RAN.add((case, dialect))
            try:
                with fresh_db(dialect) as db:
                    body(db)
            except Exception as error:  # noqa: BLE001
                reasons.append(f'{dialect}: {type(error).__name__}: {error}')
        if reasons:
            self.fail('; '.join(reasons))

    def probe(self, db, label: str):
        return MODELS['models'].RollbackProbe().connect(db).set_label(label)

    def count(self, db) -> int:
        return MODELS['models'].RollbackProbe().connect(db).get_count()

    def raised(self, run):
        try:
            run()
        except BaseException as error:  # noqa: BLE001
            return error
        return None

    def check_fault(self, error, code: str = CODE, message: str = MESSAGE):
        self.assertIsInstance(error, OrmError, f'the statement raises {error!r}')
        self.assertEqual(error.code, code, f'{error}')
        self.assertEqual(str(error), f'{code}: {message}')

    def test_refused_insert(self):
        def run(db):
            fail_next_statement(db, CODE, MESSAGE)
            events = []
            unsubscribe = db.subscribe(events.append)
            self.addCleanup(unsubscribe)
            error = self.raised(lambda: self.probe(db, 'refused').create())
            self.check_fault(error)
            self.assertTrue(any(event.error is error for event in events),
                            'the statement event of the refused statement carries the error')
            self.assertEqual(self.count(db), 0, 'the refused insert is not sent to the database')
        self.each_dialect('refused_insert', run)

    def test_consumed_by_one_statement(self):
        def run(db):
            fail_next_statement(db, CODE, MESSAGE)
            self.check_fault(self.raised(lambda: self.probe(db, 'first').create()))
            self.assertIsNone(self.raised(lambda: self.probe(db, 'second').create()),
                              'the statement after the consumed fault runs')
            self.assertEqual(self.count(db), 1)
        self.each_dialect('consumed_by_one_statement', run)

    def test_refused_in_transaction(self):
        def run(db):
            fail_next_statement(db, CODE, MESSAGE)
            events = []
            unsubscribe = db.subscribe(events.append)
            self.addCleanup(unsubscribe)
            error = self.raised(lambda: db.transaction(lambda: self.probe(db, 'in transaction').create(),
                                                       {'retry': 0}))
            self.check_fault(error)
            refused = [event for event in events if event.error is error]
            self.assertEqual(len(refused), 1, 'exactly one statement event carries the error')
            self.assertIn('insert', refused[0].sql.lower(), 'the insert is the refused statement')
            self.assertTrue(events and events[0].error is None and 'insert' not in events[0].sql.lower(),
                            'the transaction control statement before the insert is not refused')
            self.assertEqual(self.count(db), 0, 'the refused insert and its transaction leave no row')
            self.assertIsNone(self.raised(lambda: db.transaction(lambda: self.probe(db, 'later').create(),
                                                                 {'retry': 0})),
                              'the transaction after the consumed fault commits')
            self.assertEqual(self.count(db), 1)
        self.each_dialect('refused_in_transaction', run)

    def test_empty_argument_refused(self):
        def run(db):
            for code, message in (('', MESSAGE), (CODE, '')):
                error = self.raised(lambda: fail_next_statement(db, code, message))
                self.assertIsInstance(error, ValueError, f'empty code {code!r} or message {message!r} is refused')
            self.assertIsNone(self.raised(lambda: self.probe(db, 'after refusal').create()),
                              'a refused argument arms nothing')
            self.assertEqual(self.count(db), 1)
        self.each_dialect('empty_argument_refused', run)


class StatementFaultEntryTest(unittest.TestCase):
    deadline = testcase.PROCESS
    def test_the_package_entry_point_does_not_export_the_fault(self):
        import polyspec.orm
        self.assertFalse(hasattr(polyspec.orm, 'fail_next_statement'))
        self.assertNotIn('fail_next_statement', polyspec.orm.__all__)
        self.assertTrue(callable(importlib.import_module('polyspec.orm.testing').fail_next_statement))

    def test_the_distribution_holds_the_test_entry_point_that_no_import_loads(self):
        with (PACKAGE / 'pyproject.toml').open('rb') as file:
            find = tomllib.load(file)['tool']['setuptools']['packages']['find']
        self.assertNotIn('polyspec.orm.testing', find.get('exclude', []))
        loaded = subprocess.run([sys.executable, '-c', 'import sys, polyspec.orm, polyspec.orm.database; '
                                 'print("polyspec.orm.testing" in sys.modules)'],
                                capture_output=True, text=True)
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        self.assertEqual(loaded.stdout.strip(), 'False')


class StatementFaultFixtureTest(unittest.TestCase):
    def test_every_fixture_case_has_a_test_method(self):
        for case in FIXTURE['cases']:
            self.assertTrue(callable(getattr(StatementFaultTest, f'test_{case}', None)),
                            f'fixture case {case} has no test method')


if __name__ == '__main__':
    testcase.main()
