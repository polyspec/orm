# The refusal of an unknown dialect, tests/dbspec/dialect-refusal.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-174.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/dialect-refusal.json", NONE)

if __name__ == "__main__":
    testcase.main()
