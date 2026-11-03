# Requirements: DBS-108, SCH-7, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
# The suite unit dbspec-set-decimal-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# tests/dbspec/set-decimal.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/set-decimal.json", "postgres")

if __name__ == "__main__":
    testcase.main()
