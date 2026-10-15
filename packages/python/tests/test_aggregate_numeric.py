# aggregate_numeric: every case of contracts/fixtures/aggregate_numeric.json converts the scalar of a sum or an average
# to the binary64 value of its bits, or fails with its error code, as packages/ts/tests/aggregate_numeric.mjs and the
# other clients' tests do. Each case is a test named by its id.
import json
import struct
import unittest
from pathlib import Path

from polyspec.orm.errors import OrmError
from polyspec.orm.model_exec import _aggregate_number
from . import testcase
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = json.loads(
    (ROOT / "contracts" / "fixtures" / "aggregate_numeric.json").read_text(
        encoding="utf-8"
    )
)
# The value a driver gives for each input type of the fixture: PyMySQL and psycopg give an integer sum as int and a
# decimal sum or average as Decimal, and SQLite gives text of a DECIMALINT column.
INPUTS = {
    "integer_text": int,
    "decimal_text": str,
    "null": lambda value: None,
}


def check_case(test: unittest.TestCase, case: dict) -> None:
    test.assertEqual(case["operation"], "aggregate_numeric")
    convert = INPUTS.get(case["input_type"])
    test.assertIsNotNone(convert, f"unknown input type {case['input_type']}")
    value = convert(case["input"])
    if "error" in case["expected"]:
        with test.assertRaises(OrmError) as raised:
            _aggregate_number(value)
        test.assertEqual(raised.exception.code, case["expected"]["error"])
        return
    bits = struct.pack(">d", _aggregate_number(value)).hex()
    test.assertEqual(bits, case["expected"]["bits"])


class Case(VectorCase):
    """A case of aggregate_numeric.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the fixture, named by the case id."""
    tests.addTests(vector_tests(Case, FIXTURE["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
