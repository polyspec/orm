# Requirements: PLN-73, PLN-74, PLN-75, PLN-76, PLN-77, PLN-78, PLN-79, PLN-80, PLN-81, PLN-82, PLN-83.
# The plan cases of tests/dbspec/plans.json: one test for each case of 'cases', named by the case id (dbspec_plans).
# Run: python -m packages.python.tests.test_dbspec_plan_cases
import unittest

from .dbspec_plans import CHECKS, section_cases
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A case of 'cases' of plans.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of 'cases', named by the case id."""
    tests.addTests(vector_tests(Case, section_cases("cases"), CHECKS["cases"]))
    return tests


if __name__ == "__main__":
    testcase.main()
