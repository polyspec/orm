# Requirements: CFG-15, INT-155.
# The suite unit transactions-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/transactions/transactions.json on mysql.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/transactions/transactions.json", "mysql")

if __name__ == "__main__":
    testcase.main()
