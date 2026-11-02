# The declaration position cases of the dbspec parse recipe, tests/dbspec/positions.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: ORES-72.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/positions.json", NONE)

if __name__ == "__main__":
    testcase.main()
