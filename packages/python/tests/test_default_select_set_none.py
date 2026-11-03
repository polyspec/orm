# The default select set, tests/planner/default-select-set.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: PRT-9, DBS-68.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/planner/default-select-set.json", NONE)

if __name__ == "__main__":
    testcase.main()
