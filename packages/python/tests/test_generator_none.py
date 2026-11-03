# The generator recipe, contracts/fixtures/generator/generator.json, without a database (docs/spec/feature-coverage.md FCV-3).
# Requirements: DSL-37, DSL-116, DSL-127, DSL-129, DSL-130, PLN-22.

from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/generator/generator.json", NONE)

if __name__ == "__main__":
    testcase.main()
