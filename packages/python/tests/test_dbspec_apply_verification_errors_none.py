# The apply verification errors of tests/dbspec/apply-verification-errors.json on a memory connection (docs/spec/feature-coverage.md FCV-3).
# Requirements: PLN-92, PLN-93, PLN-96.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/apply-verification-errors.json", NONE)

if __name__ == "__main__":
    testcase.main()
