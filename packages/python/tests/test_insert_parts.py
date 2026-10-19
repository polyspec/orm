# The shared cases of contracts/fixtures/insert_parts.json: one test for each case, named by its id. _insert_parts
# splits the rows of the case into batches of its batch size (docs/spec/protocol.md "Multi-row inserts").
# Run: python -m packages.python.tests.test_insert_parts
import json
import unittest
from pathlib import Path
from typing import Any

from polyspec.orm.model_exec import _insert_parts

from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


class Case(VectorCase):
    """A case of contracts/fixtures/insert_parts.json."""


def check_case(test: unittest.TestCase, case: Any) -> None:
    """The parts of the case's rows are its expected parts."""
    test.assertEqual(case["operation"], "insert_parts")
    given = case["input"]
    test.assertEqual(_insert_parts(given["rows"], given["batch"]), case["expected"])


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of insert_parts.json, named by its id."""
    cases = json.loads(
        (ROOT / "contracts" / "fixtures" / "insert_parts.json").read_text()
    )["cases"]
    tests.addTests(vector_tests(Case, cases, check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
