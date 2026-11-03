# The plans of the runtime model, tests/planner/runtime-model.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-112, PRT-32, PRT-81, PRT-82, DIA-24, PRT-33, DBS-67.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/planner/runtime-model.json", NONE)

if __name__ == "__main__":
    testcase.main()
