# Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134.
# The suite unit utils-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe contracts/fixtures/utils/utils.json on Sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/utils/utils.json", "sqlite")

if __name__ == "__main__":
    testcase.main()
