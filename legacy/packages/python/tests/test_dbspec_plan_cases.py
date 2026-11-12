# The plan cases of the recipe tests/dbspec/plan-cases.json: one test for each case, named by the case id (FCV-3).
# Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57,
# PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71,
# PLN-72, PLN-73, PLN-74, PLN-75, PLN-76, PLN-77, PLN-78, PLN-79, PLN-80, PLN-81, PLN-82, PLN-83, PLN-84, PLN-85,
# PLN-86, PLN-87, PLN-88.

from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/plan-cases.json", NONE)

if __name__ == "__main__":
    testcase.main()
