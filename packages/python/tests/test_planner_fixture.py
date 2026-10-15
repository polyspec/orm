# planner fixture: contracts/fixtures/planner.json의 request를 그 case의 schema 문서의 manifest hash와
# 함께 dialect마다 검사하고 compile해서, statement(role, sql, bind slot의 출처, param 번호, type,
# table)나 오류 code가 기대값과 같은지 본다. Go, PHP, Rust, TypeScript의 planner coverage가 같은
# 파일을 읽는다.
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.engine import model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.engine.dialect import dialect_of  # noqa: E402
from polyspec.orm.engine.planner import Planner  # noqa: E402
from polyspec.orm.engine.validate import validate  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from . import testcase


def _slot(slot: dict) -> dict:
    """bind slot의 출처와 type: param slot은 request 값의 번호를, parent slot은 key type을 싣는다."""
    if slot['from'] == 'parent':
        return {'from': 'parent', 'key_types': slot['key_types']}
    out = {'from': slot['from'], 'type': slot.get('col_type', '')}
    if slot['from'] == 'param':
        out = {'from': 'param', 'param': slot['param'], 'type': out['type']}
    if out['type'] in ('datetime', 'time'):
        out['precision'] = slot.get('precision', 0)
    return out


class PlannerFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads((ROOT / 'contracts' / 'fixtures' / 'planner.json').read_text())
        # The runtime model of each schema document that a case names, by repository path.
        cls.models = {}
        for case in cls.fixture['cases']:
            schema = case.get('schema') or ''
            if schema == '':
                raise AssertionError(f'case {case["id"]} names no schema; give it the repository path of its '
                                     f'dbspec document')
            if schema not in cls.models:
                cls.models[schema] = model_of_documents(parse_document_set([(ROOT / schema).read_text()]))

    def test_every_case(self):
        self.assertEqual(self.fixture['feature'], 'planner')
        for case in self.fixture['cases']:
            with self.subTest(case['id']):
                self.assertEqual(case['operation'], 'compile')
                model = self.models[case['schema']]
                request = dict(case['input'], manifest_hash=model.manifest_hash)
                for dialect in ('mysql', 'postgres', 'sqlite'):
                    planner = Planner(model, dialect_of(dialect)())
                    if 'error' in case['expected']:
                        with self.assertRaises(OrmError) as raised:
                            validate(model, request)
                            planner.compile(request)
                        self.assertEqual(raised.exception.code, case['expected']['error'],
                                         f'{dialect}: {raised.exception}')
                        continue
                    validate(model, request)
                    plan = planner.compile(request)
                    statements = [{'role': step['role'], 'slots': [_slot(s) for s in step['bind_slots']],
                                   'sql': step['sql'], 'tables': step['tables']}
                                  for step in plan['steps']]
                    self.assertEqual(statements, case['expected'][dialect], dialect)


if __name__ == '__main__':
    testcase.main()
