# The MySQL reader of a SHOW CREATE TABLE statement (_create_checks of introspect_mysql.py, T62-4-8) reads
# every case of tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or to
# no body for a name the statement does not have.
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.dbspec.introspect_mysql import _create_checks  # noqa: E402


class ShowCreateVectors(unittest.TestCase):
    def test_every_case_reads_to_its_expected_body(self):
        data = json.loads((ROOT / 'tests' / 'dbspec' / 'show-create.json').read_text(encoding='utf-8'))
        self.assertTrue(data['cases'], 'tests/dbspec/show-create.json has no cases')
        for case in data['cases']:
            with self.subTest(case=case['id']):
                checks = _create_checks('\n'.join(case['create']) + '\n')
                got = checks.get(case['name'])
                if case['expected'] == 'not found':
                    self.assertIsNone(got, f"{case['name']} read as {got!r}, want not found")
                else:
                    self.assertEqual(got, case['expected'])


if __name__ == '__main__':
    unittest.main()
