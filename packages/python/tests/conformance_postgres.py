# The conformance vectors on postgres: one test for each vector of the postgres expectations, named by the vector name
# (conformance_case). The bench database comes from BENCH_POSTGRES_DSN.
# Run: python -m packages.python.tests.conformance_postgres
from .conformance_case import conformance_module
from .vector_case import VectorCase
from . import testcase


class Case(VectorCase):
    """A conformance vector on postgres."""


setUpModule, load_tests = conformance_module("postgres", Case)


if __name__ == "__main__":
    testcase.main()
