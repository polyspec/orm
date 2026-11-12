# The test entry point polyspec.orm.testing.fail_next_statement outside the fault cases: the package entry point does
# not export it, the distribution holds it and no import loads it, and every case of contracts/fixtures/statement_fault.json
# has its test method in statement_fault.py.
import tomllib
import unittest
from pathlib import Path

from polyspec.orm import testing
from . import statement_fault
from . import testcase
from .entry_point_check import assert_import_does_not_load_testing

PACKAGE = Path(__file__).resolve().parents[1]


class StatementFaultEntryTest(unittest.TestCase):
    deadline = testcase.PROCESS

    # Requirements: PRT-52.
    def test_the_package_entry_point_does_not_export_the_fault(self):
        import polyspec.orm

        self.assertFalse(hasattr(polyspec.orm, "fail_next_statement"))
        self.assertNotIn("fail_next_statement", polyspec.orm.__all__)
        self.assertTrue(callable(testing.fail_next_statement))

    def test_the_distribution_holds_the_test_entry_point_that_no_import_loads(self):
        with (PACKAGE / "pyproject.toml").open("rb") as file:
            find = tomllib.load(file)["tool"]["setuptools"]["packages"]["find"]
        self.assertNotIn("polyspec.orm.testing", find.get("exclude", []))
        assert_import_does_not_load_testing(self)


class StatementFaultFixtureTest(unittest.TestCase):
    def test_every_fixture_case_has_a_test_method(self):
        for case in statement_fault.FIXTURE["cases"]:
            self.assertTrue(
                callable(
                    getattr(statement_fault.StatementFaultTest, f"test_{case}", None)
                ),
                f"fixture case {case} has no test method",
            )


if __name__ == "__main__":
    testcase.main()
