# Requirements: CFG-15, INT-155, CFG-12.
# The suite unit transactions-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/transactions/transactions.json on markdown.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/transactions/transactions.json", "markdown"
)

if __name__ == "__main__":
    testcase.main()
