# One unittest case per case of a shared vector file, reported under the case id. A test module that runs a vector
# file defines unittest's load_tests protocol with vector_tests, so the loader (unittest.main, `python -m unittest`
# and discover) builds a VectorCase for each case of the file, and the runner reports each one by its id.
import unittest
from typing import Any, Callable, Iterable


class VectorCase(unittest.TestCase):
    """A case of a shared vector file: check(test, case) runs it, and the case id names it."""

    def __init__(self, case_id: str, check: Callable[[unittest.TestCase, Any], None], case: Any) -> None:
        super().__init__('runTest')
        self.case_id = case_id
        self.check = check
        self.case = case

    def runTest(self) -> None:  # noqa: N802 - the method name unittest runs by default
        self.check(self, self.case)

    def id(self) -> str:
        return self.case_id

    def __str__(self) -> str:
        return self.case_id

    def __repr__(self) -> str:
        return f'<VectorCase {self.case_id}>'

    def shortDescription(self) -> None:  # noqa: N802 - unittest's method name
        return None


def vector_tests(cases: Iterable[Any], check: Callable[[unittest.TestCase, Any], None],
                 case_id: Callable[[Any], str] = lambda case: case['id']) -> unittest.TestSuite:
    """The suite of one VectorCase for each case, in the order of the file."""
    return unittest.TestSuite(VectorCase(case_id(case), check, case) for case in cases)
