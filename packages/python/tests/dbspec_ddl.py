# 공유 ddl 사례(tests/dbspec/ddl.json)의 문장 대조: Python render가 세 dialect의
# 문장을 다른 client와 같은 byte로 쓰는지 확인한다. behavior 단계(실제 database
# 실행)는 conformance가 검사한다.
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.dbspec import parse_dbspec  # noqa: E402
from polyspec.orm.dbspec.render import render_dbspec  # noqa: E402
from .vector_case import VectorCase, vector_tests  # noqa: E402
from . import testcase


def parse_set(documents: dict) -> list:
    """사례의 문서 집합을 parse한다; main 문서가 집합을 대표한다."""
    out: list = []
    for name, lines in documents.items():
        document, _positions, diagnostics = parse_dbspec('\n'.join(lines),
                                             {k: '\n'.join(v)
                                              for k, v in documents.items() if k != name})
        if diagnostics:
            raise SystemExit(f'ddl case document {name}: {diagnostics[0]}')
        out.append(document)
    return out


DATA = json.loads((ROOT / 'tests' / 'dbspec' / 'ddl.json').read_text())


def check_case(test: unittest.TestCase, case: dict) -> None:
    documents = parse_set(case['documents'])
    for dialect in ('mysql', 'postgres', 'sqlite'):
        result = render_dbspec(documents, dialect)
        test.assertIsNotNone(result['statements'], f'{case["id"]} {dialect}: {result["diagnostics"][:1]}')
        test.assertEqual(result['statements'], case['statements'][dialect],
                         f'{case["id"]} {dialect}: rendered statements differ')


class RenderDialectTest(unittest.TestCase):
    def test_unknown_dialect_is_a_type_error(self):
        documents = parse_set(DATA['cases'][-1]['documents'])
        with self.assertRaises(TypeError):
            render_dbspec(documents, 'oracle')


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each ddl case, named by the case id."""
    tests.addTests(vector_tests(Case, DATA['cases'], check_case))
    return tests


if __name__ == '__main__':
    testcase.main()
