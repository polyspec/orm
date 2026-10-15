# The invalid Mermaid diagrams of tests/dbspec/mermaid.json: one test for each case of 'invalid', named by the case id (dbspec_mermaid).
# Run: python -m packages.python.tests.test_dbspec_mermaid_invalid
import unittest

from .dbspec_mermaid import RUNS, kind_cases
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A case of 'invalid' of mermaid.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of 'invalid', named by the case id."""
    tests.addTests(
        vector_tests(Case, kind_cases("invalid"), lambda _test, c: RUNS["invalid"](c))
    )
    return tests


if __name__ == "__main__":
    testcase.main()
