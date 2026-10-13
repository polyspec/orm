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


class IrValidateTest(unittest.TestCase):
    def test_every_case(self):
        file = json.loads((ROOT / 'tests' / 'ir' / 'validate.json').read_text())
        self.assertEqual(file['schema'], 'schema/bench.dbs')
        self.assertTrue(file['cases'], 'validate.json has no cases')
        model = model_of_documents(parse_document_set([(ROOT / file['schema']).read_text()]))
        for case in file['cases']:
            with self.subTest(case['name']):
                request = dict(case['request'], manifest_hash=model.manifest_hash)
                if case.get('valid'):
                    validate(model, request)
                    continue
                with self.assertRaises(OrmError) as raised:
                    validate(model, request)
                self.assertEqual(raised.exception.code, case['error'])


if __name__ == '__main__':
    unittest.main()
