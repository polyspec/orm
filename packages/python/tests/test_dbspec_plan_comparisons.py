# The schema comparisons of tests/dbspec/plans.json: one test for each case of 'comparisons', named by the case id (dbspec_plans).
# Run: python -m packages.python.tests.test_dbspec_plan_comparisons
import unittest

from .dbspec_plans import CHECKS, section_cases
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A case of 'comparisons' of plans.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of 'comparisons', named by the case id."""
    tests.addTests(
        vector_tests(Case, section_cases("comparisons"), CHECKS["comparisons"])
    )
    return tests


if __name__ == "__main__":
    testcase.main()
