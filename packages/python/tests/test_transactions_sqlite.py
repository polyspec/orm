# Requirements: CFG-15, INT-155.
# The suite unit transactions-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/transactions/transactions.json on sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/transactions/transactions.json", "sqlite")

if __name__ == "__main__":
    testcase.main()
