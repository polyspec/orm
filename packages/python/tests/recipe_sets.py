# The document set cases of the dbspec manifest recipe, tests/dbspec/sets.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-30, DBS-35, DBS-99, DBS-101, DBS-105, DBS-106, DBS-168.
# Requirements: ORES-13.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/sets.json", NONE)

if __name__ == "__main__":
    testcase.main()
