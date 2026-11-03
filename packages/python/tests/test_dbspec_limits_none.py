# The limit and stress recipe, tests/dbspec/limits.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-123, DBS-144, DBS-151, DBS-170.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/limits.json", NONE)

if __name__ == "__main__":
    testcase.main()
