# The normalize cases of the dbspec format recipe, tests/dbspec/normalize.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: ORES-15, ORES-17, ORES-19.
# Requirements: ORES-13.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/normalize.json", NONE)

if __name__ == "__main__":
    testcase.main()
