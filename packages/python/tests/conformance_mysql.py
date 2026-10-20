# The conformance vectors on mysql: one test for each vector of the mysql expectations, named by the vector name
# (conformance_case). The bench database comes from BENCH_MYSQL_DSN.
# Run: python -m packages.python.tests.conformance_mysql
from .conformance_case import conformance_module
from .vector_case import VectorCase
from . import testcase


class Case(VectorCase):
    """A conformance vector on mysql."""


setUpModule, load_tests = conformance_module("mysql", Case)


if __name__ == "__main__":
    testcase.main()
