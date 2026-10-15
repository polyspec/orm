# The plan chains of tests/dbspec/plans.json: one test for each case of 'chains', named by the case id (dbspec_plans).
# Run: python -m packages.python.tests.test_dbspec_plan_chains
import unittest

from .dbspec_plans import CHECKS, section_cases
from .vector_case import VectorCase, vector_tests
from . import testcase


class Case(VectorCase):
    """A case of 'chains' of plans.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of 'chains', named by the case id."""
    tests.addTests(vector_tests(Case, section_cases("chains"), CHECKS["chains"]))
    return tests


if __name__ == "__main__":
    testcase.main()
