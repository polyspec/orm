# The position cases of tests/dbspec/cases.json: one test for each case of the section, named by the case id
# (dbspec_cases.check_positions).
# Run: python -m packages.python.tests.test_dbspec_positions
import unittest

from .dbspec_cases import check_positions
from .dbspec_cases_reader import read_cases
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A case of the positions section of cases.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the positions section, named by the case id."""
    tests.addTests(vector_tests(Case, read_cases()["positions"], check_positions))
    return tests


if __name__ == "__main__":
    testcase.main()
