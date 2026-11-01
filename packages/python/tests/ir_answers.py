# The read answer recipe, tests/ir/answers.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: PRT-69, PRT-71, PRT-72.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/ir/answers.json", NONE)

if __name__ == "__main__":
    testcase.main()
