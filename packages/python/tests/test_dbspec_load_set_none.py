# The load of a document set, tests/dbspec/load-set.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: SCH-12, DBS-156.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/load-set.json", NONE)

if __name__ == "__main__":
    testcase.main()
