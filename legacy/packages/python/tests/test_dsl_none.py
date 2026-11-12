# The chain value recipe, contracts/fixtures/dsl/dsl.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DSL-49, DSL-50, PLN-4.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/dsl/dsl.json", NONE)

if __name__ == "__main__":
    testcase.main()
