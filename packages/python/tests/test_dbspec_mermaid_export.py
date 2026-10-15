# The Mermaid export cases of tests/dbspec/mermaid.json: one test for each case of 'export', named by the case id (dbspec_mermaid).
# Run: python -m packages.python.tests.test_dbspec_mermaid_export
import unittest

from .dbspec_mermaid import RUNS, kind_cases
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A case of 'export' of mermaid.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of 'export', named by the case id."""
    tests.addTests(
        vector_tests(Case, kind_cases("export"), lambda _test, c: RUNS["export"](c))
    )
    return tests


if __name__ == "__main__":
    testcase.main()
