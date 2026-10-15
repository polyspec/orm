# planner coverage: compiles the request of every case of contracts/fixtures/planner.json with the manifest hash of the
# case's schema document in every dialect, and compares the statements (role, sql, the source of each bind slot, its
# param number and type, the tables) or the error code with the expectation, as the planner coverage of Go, PHP,
# TypeScript and Rust does. The feature coverage check runs `-m packages.python.tests.coverage_planner <case id>...`
# (scripts/features/coverage.mts, coverage_case.py); a unittest run of this module, such as the parity check's, runs
# every case as a test named by its id.
import json
import unittest

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError
from .coverage_case import REPOSITORY_ROOT, run_cases
from .vector_case import VectorCase, vector_tests

FIXTURE = json.loads((REPOSITORY_ROOT / 'contracts' / 'fixtures' / 'planner.json').read_text(encoding='utf-8'))
DIALECTS = ('mysql', 'postgres', 'sqlite')
# The runtime model of each schema document that a case names, by repository path.
MODELS = {}


def expect_equal(got, want, what):
    """Raises with both values when they differ; an assert statement would vanish under python -O."""
    if got != want:
        raise AssertionError(f'{what}: got {got!r}, want {want!r}')


def model_of(case: dict):
    schema = case.get('schema') or ''
    if schema == '':
        raise AssertionError(f'case {case["id"]} names no schema; give it the repository path of its dbspec document')
    if schema not in MODELS:
        MODELS[schema] = model_of_documents(parse_document_set([(REPOSITORY_ROOT / schema).read_text()]))
    return MODELS[schema]


def planner_slot(slot: dict) -> dict:
    """A bind slot's source and type: the request value number of a param slot, the key types of a parent slot."""
    if slot['from'] == 'parent':
        return {'from': 'parent', 'key_types': slot['key_types']}
    out = {'from': slot['from'], 'type': slot.get('col_type', '')}
    if slot['from'] == 'param':
        out = {'from': 'param', 'param': slot['param'], 'type': out['type']}
    # A datetime or time slot carries its fraction digits.
    if out['type'] in ('datetime', 'time'):
        out['precision'] = slot.get('precision', 0)
    return out


def compile_case(case: dict) -> None:
    """Validates and compiles the request of a case in every dialect and compares the expectation."""
    expect_equal(case['operation'], 'compile', f'operation of case {case["id"]}')
    model = model_of(case)
    request = dict(case['input'], manifest_hash=model.manifest_hash)
    for dialect in DIALECTS:
        planner = Planner(model, dialect_of(dialect)())
        if 'error' in case['expected']:
            try:
                validate(model, request)
                planner.compile(request)
            except OrmError as error:
                expect_equal(error.code, case['expected']['error'], f'{dialect} error')
                continue
            raise AssertionError(f'{dialect}: compiled, want {case["expected"]["error"]}')
        validate(model, request)
        plan = planner.compile(request)
        statements = [{'role': step['role'], 'slots': [planner_slot(s) for s in step['bind_slots']],
                       'sql': step['sql'], 'tables': step['tables']} for step in plan['steps']]
        expect_equal(statements, case['expected'][dialect], f'{dialect} statements')


class Case(VectorCase):
    """A case of planner.json."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    tests.addTests(vector_tests(Case, FIXTURE['cases'], lambda test, case: compile_case(case)))
    return tests


if __name__ == '__main__':
    expect_equal(FIXTURE['feature'], 'planner', 'the feature of planner.json')
    run_cases({case['id']: (lambda case=case: compile_case(case)) for case in FIXTURE['cases']})
