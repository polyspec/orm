# The MySQL reader of a SHOW CREATE TABLE statement (_create_checks of introspect_mysql.py, T62-4-8) reads
# every case of tests/dbspec/show-create.json to the body that the case expects in CHECK_CLAUSE form, or to
# no body for a name the statement does not have.
import json
import unittest
from pathlib import Path
from polyspec.orm.dbspec.introspect_mysql import _create_checks
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


DATA = json.loads(
    (ROOT / "tests" / "dbspec" / "show-create.json").read_text(encoding="utf-8")
)


def check_case(test: unittest.TestCase, case: dict) -> None:
    checks = _create_checks("\n".join(case["create"]) + "\n")
    got = checks.get(case["name"])
    if case["expected"] == "not found":
        test.assertIsNone(got, f"{case['name']} read as {got!r}, want not found")
    else:
        test.assertEqual(got, case["expected"])


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """Every case reads to its expected body: one test for each case, named by the case."""
    if not DATA["cases"]:
        raise AssertionError("tests/dbspec/show-create.json has no cases")
    tests.addTests(vector_tests(Case, DATA["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
