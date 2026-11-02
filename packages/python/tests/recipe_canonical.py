# The canonical cases of the dbspec format recipe, tests/dbspec/canonical.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: ORES-19.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/canonical.json", NONE)

if __name__ == "__main__":
    testcase.main()
