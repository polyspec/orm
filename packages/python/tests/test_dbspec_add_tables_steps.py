# The add tables steps of the recipe tests/dbspec/add-tables-steps.json: one test for each case, named by the case id (FCV-3).
# Requirements: INT-56, SCH-8.

from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/add-tables-steps.json", NONE)

if __name__ == "__main__":
    testcase.main()
