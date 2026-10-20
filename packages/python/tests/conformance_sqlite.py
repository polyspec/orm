# The conformance vectors on sqlite: one test for each vector of the sqlite expectations, named by the vector name
# (conformance_case). The bench database comes from BENCH_SQLITE_DSN.
# Run: python -m packages.python.tests.conformance_sqlite
from .conformance_case import conformance_module
from .vector_case import VectorCase
from . import testcase


class Case(VectorCase):
    """A conformance vector on sqlite."""


setUpModule, load_tests = conformance_module("sqlite", Case)


if __name__ == "__main__":
    testcase.main()
