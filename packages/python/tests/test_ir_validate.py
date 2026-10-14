# 공유 검증 case(tests/ir/validate.json): 각 request에 schema의 manifest_hash를 더해 검증기에만 주고,
# 받아들이는지나 기대한 오류 code로 실패하는지 본다. Go, PHP, Rust, TypeScript가 같은 파일을 자기
# package에서 읽는다.
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.engine import model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.engine.validate import validate  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from .vector_case import VectorCase, vector_tests  # noqa: E402


FILE = json.loads((ROOT / 'tests' / 'ir' / 'validate.json').read_text())


def check_case(test: unittest.TestCase, case: dict) -> None:
    request = dict(case['request'], manifest_hash=MODEL.manifest_hash)
    if case.get('valid'):
        validate(MODEL, request)
        return
    with test.assertRaises(OrmError) as raised:
        validate(MODEL, request)
    test.assertEqual(raised.exception.code, case['error'])


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each validation case, named by the case."""
    global MODEL
    if FILE['schema'] != 'schema/bench.dbs' or not FILE['cases']:
        raise AssertionError('validate.json names schema/bench.dbs and has cases')
    MODEL = model_of_documents(parse_document_set([(ROOT / FILE['schema']).read_text()]))
    tests.addTests(vector_tests(Case, FILE['cases'], check_case, lambda case: case['name']))
    return tests


if __name__ == '__main__':
    unittest.main()
