# The test entry point polyspec.orm.testing.fail_next_statement outside the fault cases: the package entry point does
# not export it, the distribution holds it and no import loads it, and every case of contracts/fixtures/statement_fault.json
# has its test method in statement_fault.py.
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

from polyspec.orm import testing
from . import statement_fault
from . import testcase

PACKAGE = Path(__file__).resolve().parents[1]


class StatementFaultEntryTest(unittest.TestCase):
    deadline = testcase.PROCESS

    def test_the_package_entry_point_does_not_export_the_fault(self):
        import polyspec.orm

        self.assertFalse(hasattr(polyspec.orm, "fail_next_statement"))
        self.assertNotIn("fail_next_statement", polyspec.orm.__all__)
        self.assertTrue(callable(testing.fail_next_statement))

    def test_the_distribution_holds_the_test_entry_point_that_no_import_loads(self):
        with (PACKAGE / "pyproject.toml").open("rb") as file:
            find = tomllib.load(file)["tool"]["setuptools"]["packages"]["find"]
        self.assertNotIn("polyspec.orm.testing", find.get("exclude", []))
        loaded = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys, polyspec.orm, polyspec.orm.database; "
                'print("polyspec.orm.testing" in sys.modules)',
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        self.assertEqual(loaded.stdout.strip(), "False")


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
