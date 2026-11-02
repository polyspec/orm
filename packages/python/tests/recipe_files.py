# The document file cases of the dbspec reader recipe, tests/dbspec/files.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-4, DBS-155, DBS-171.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/files.json", NONE)

if __name__ == "__main__":
    testcase.main()
