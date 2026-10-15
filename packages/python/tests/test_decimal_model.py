# decimal_model: every case of contracts/fixtures/decimal_model.json normalizes a decimal column value to its declared
# scale, or fails with its error code, and its SQLite scaled-integer storage reads back as the same text, as
# packages/ts/tests/decimal_model.mjs and the other clients' tests do. Each case is a test named by its id.
import json
import unittest
from pathlib import Path

from polyspec.orm.dbspec import parse_dbspec, render_dbspec
from polyspec.orm.decimal import decimal_from_scaled, decimal_scaled, normalize_decimal
from polyspec.orm.errors import OrmError
from . import testcase
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((ROOT / 'contracts' / 'fixtures' / 'decimal_model.json').read_text(encoding='utf-8'))
COLUMNS = {column['id']: column for column in FIXTURE['columns']}


def check_case(test: unittest.TestCase, case: dict) -> None:
    test.assertEqual(case['operation'], 'decimal_value')
    column = COLUMNS.get(case['column'])
    test.assertIsNotNone(column, f'unknown column {case["column"]}')
    precision, scale = column['precision'], column['scale']
    if 'error' in case['expected']:
        with test.assertRaises(OrmError) as raised:
            normalize_decimal(case['input'], precision, scale)
        test.assertEqual(raised.exception.code, case['expected']['error'])
        return
    test.assertEqual(normalize_decimal(case['input'], precision, scale), case['expected']['value'])
    stored = decimal_scaled(case['input'], precision, scale)
    test.assertEqual(decimal_from_scaled(stored, precision, scale), case['expected']['value'], 'SQLite round trip')


class Case(VectorCase):
    """A case of decimal_model.json."""


class SqliteDecimalDdlTest(unittest.TestCase):
    def test_a_sqlite_decimal_column_is_scaled_integer_storage(self) -> None:
        document, _positions, diagnostics = parse_dbspec(
            'dbspec 1 decimal\n\ntable t {\n  seq i64\n  amount decimal(13,4)\n  primary key (seq)\n}\n', {})
        self.assertEqual(list(diagnostics), [])
        rendered = render_dbspec([document], 'sqlite')
        self.assertEqual(list(rendered['diagnostics']), [])
        self.assertIn('"amount" DECIMALINT(13,4) NOT NULL', rendered['statements'][0])


def load_tests(loader: unittest.TestLoader, tests: unittest.TestSuite, pattern: object) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    tests.addTests(vector_tests(Case, FIXTURE['cases'], check_case))
    return tests


if __name__ == '__main__':
    testcase.main()
