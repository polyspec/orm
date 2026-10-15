# The conformance vectors on mysql: one test for each vector of the mysql expectations, named by the vector name
# (conformance_case). The bench database comes from BENCH_MYSQL_DSN.
# Run: python -m packages.python.tests.conformance_mysql
import unittest

from .conformance_case import conformance_tests
from .vector_case import VectorCase
from . import testcase


class Case(VectorCase):
    """A conformance vector on mysql."""


RUN, SUITE = conformance_tests("mysql", Case)


def setUpModule():  # noqa: N802 - unittest's hook name
    RUN.start()


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each vector, named by its name."""
    tests.addTests(SUITE)
    return tests


if __name__ == "__main__":
    testcase.main()
