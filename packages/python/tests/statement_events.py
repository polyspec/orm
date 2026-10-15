# statement-events: every case of tests/events/vectors.json runs with the Python client on SQLite, MySQL and PostgreSQL
# and its recorded events equal the expected events of the dialect (docs/usage.md "Statement events"), as
# packages/ts/tests/statement-events-run.mjs and the other clients' tests do. Each case runs on a new case database
# with the fixture installed (unless install is false), opens a new connection, registers one recording subscriber and
# runs its steps in order; transaction numbers count from 1 in their order of appearance within the case, and a case
# whose compare is "tables" compares only the events that name a table. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and
# ORM_TEST_POSTGRES_DSN, and a missing variable fails the case. Each case is a test named by its id; a case passes when
# it agrees on every dialect.
import json
import os
import tempfile
import unittest
from pathlib import Path

from polyspec.orm import OrmError
from polyspec.orm.database import Db
from . import testcase
from .case_database import case_database
from .test_sqlite import generate_document
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads((ROOT / 'tests' / 'events' / 'vectors.json').read_text(encoding='utf-8'))
DIALECTS = ('mysql', 'postgres', 'sqlite')
STATE = {}


class CallbackError(Exception):
    """The error of a transaction callback that fails (a transaction step with fail)."""


def setUpModule():  # noqa: N802 - unittest's function name
    directory = tempfile.TemporaryDirectory(prefix='orm-statement-events-')
    STATE['directory'] = directory
    STATE['models'] = generate_document(os.path.join(directory.name, 'models'), ROOT / VECTORS['fixture'])


def tearDownModule():  # noqa: N802 - unittest's function name
    STATE['directory'].cleanup()


class EventRun:
    """The state of one case run on one connection."""

    def __init__(self, db: Db, problems: list) -> None:
        self.db = db
        self.problems = problems
        self.records = []
        self.numbers = {}
        self.stop_recording = db.subscribe(self.record)
        self.stop_failing = None

    def record(self, event) -> None:
        if not (isinstance(event.elapsed, (int, float)) and event.elapsed >= 0):
            self.problems.append(f'event {event.sql!r} has the elapsed time {event.elapsed!r}')
        if event.error is not None and not isinstance(event.error, OrmError):
            self.problems.append(f'event {event.sql!r} has the error {event.error!r}')
        transaction = None
        if event.transaction is not None:
            transaction = self.numbers.setdefault(event.transaction, len(self.numbers) + 1)
        self.records.append({'sql': event.sql, 'binds': json.loads(json.dumps(list(event.binds))),
                             'kind': event.kind, 'tables': list(event.tables), 'transaction': transaction,
                             'error': None if event.error is None else event.error.code})

    def model(self):
        return STATE['models'].EventProbe().connect(self.db)

    def step(self, step: dict) -> None:
        op = step['op']
        if op == 'create':
            self.model().set_label(step['label']).create()
        elif op == 'get':
            self.model().get_by_label(step['label'])
        elif op == 'count':
            count = self.model().get_count()
            if 'result' in step and count != step['result']:
                self.problems.append(f'count = {count}, want {step["result"]}')
        elif op == 'update':
            self.model().get_by_label(step['label']).set_label(step['to']).update()
        elif op == 'delete':
            self.model().get_by_label(step['label']).delete()
        elif op == 'transaction':
            def body():
                for inner in step['steps']:
                    self.checked(inner)
                if step.get('fail'):
                    raise CallbackError('callback failed')
            self.db.transaction(body, {'retry': 0})
        elif op == 'install':
            self.db.utils().schema().install(STATE['models'].SCHEMA)
        elif op == 'fail_subscriber':
            def refuse(event):
                if event.kind == step['kind']:
                    raise RuntimeError('subscriber refused the event')
            self.stop_failing = self.db.subscribe(refuse)
        elif op == 'stop_failing':
            self.stop_failing()
        elif op == 'unsubscribe':
            self.stop_recording()
        else:
            raise ValueError(f'unknown step {op}')

    def checked(self, step: dict) -> None:
        """Runs a step and checks that its error is the one the step expects; another error ends the case. The
        callback error a transaction step expects is handled by the outer callback."""
        try:
            self.step(step)
        except CallbackError:
            if step.get('error') != 'callback':
                raise
            return
        except OrmError as error:
            if step.get('error') != error.code:
                raise
            if error.code == 'SUBSCRIBER' and str(error.cause) != 'subscriber refused the event':
                self.problems.append(f'SUBSCRIBER keeps the subscriber error as its cause: {error.cause!r}')
            return
        if 'error' in step:
            raise AssertionError(f'step {step["op"]} succeeded, want {step["error"]}')


def run_case(case: dict, dialect: str, dsn: str) -> list:
    """Runs the case on the dialect's database and returns its problems."""
    problems = []
    schema = STATE['models'].SCHEMA
    db = Db.connect_schema(dsn, schema)
    try:
        if case.get('install', True):
            db.utils().schema().install(schema)
        run = EventRun(db, problems)
        for step in case['steps']:
            run.checked(step)
        got = [r for r in run.records if r['tables']] if case.get('compare') == 'tables' else run.records
        want = [{key: event[key] for key in ('sql', 'binds', 'kind', 'tables', 'transaction', 'error')}
                for event in case['events'][dialect]]
        if got != want:
            problems.append(f'events\n got {json.dumps(got, indent=2)}\nwant {json.dumps(want, indent=2)}')
    finally:
        db.close()
    return problems


def check_case(test: unittest.TestCase, case: dict) -> None:
    """Runs the case on every dialect to its end, so one dialect's failure does not hide another's."""
    failures = []
    for dialect in DIALECTS:
        try:
            with case_database(dialect, STATE['directory'].name, 'orm_events') as dsn:
                failures += [f'{dialect}: {problem}' for problem in run_case(case, dialect, dsn)]
        except Exception as error:  # noqa: BLE001 - the case reports every dialect's error
            failures.append(f'{dialect}: {type(error).__name__}: {error}')
    if failures:
        test.fail('\n'.join(failures))


class Case(VectorCase):
    """A case of tests/events/vectors.json."""
    deadline = testcase.DATABASE


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each case of the file, named by the case id."""
    tests.addTests(vector_tests(Case, VECTORS['cases'], check_case))
    return tests


if __name__ == '__main__':
    testcase.main()
