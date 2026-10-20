# One unittest case per case of a shared vector file, reported under the case id. A test module that runs a vector
# file declares its subclass of VectorCase and defines unittest's load_tests protocol with vector_tests, so the loader
# (unittest.main, `python -m unittest` and discover) builds one instance for each case of the file, and the runner
# reports each one by its id. The subclass belongs to the test module, so unittest runs that module's setUpModule and
# tearDownModule around its cases.
import unittest
from typing import Any, Callable, Iterable


class VectorCase(unittest.TestCase):
    """A case of a shared vector file: check(test, case) runs it, and the case id names it."""

    def __init__(
        self, case_id: str, check: Callable[[unittest.TestCase, Any], None], case: Any
    ) -> None:
        # The method is not runTest, so the loader does not build a case of this class by itself.
        super().__init__("run_case")
        self.case_id = case_id
        self.check = check
        self.case = case

    def run_case(self) -> None:
        self.check(self, self.case)

    def id(self) -> str:
        return self.case_id

    def __str__(self) -> str:
        return self.case_id

    def __repr__(self) -> str:
        return f"<VectorCase {self.case_id}>"

    def shortDescription(self) -> None:  # noqa: N802 - unittest's method name
        return None


def vector_tests(
    kind: type[VectorCase],
    cases: Iterable[Any],
    check: Callable[[unittest.TestCase, Any], None],
    case_id: Callable[[Any], str] = lambda case: case["id"],
) -> unittest.TestSuite:
    """The suite of one `kind` instance for each case, in the order of the file."""
    return unittest.TestSuite(kind(case_id(case), check, case) for case in cases)


def vector_load_tests(
    kind: type[VectorCase],
    cases: Iterable[Any],
    check: Callable[[unittest.TestCase, Any], None],
):
    """The load_tests protocol of a test module that runs one fixture: one test for each case, named by the case id."""

    def load_tests(_loader, tests, _pattern):
        tests.addTests(vector_tests(kind, cases, check))
        return tests

    return load_tests
