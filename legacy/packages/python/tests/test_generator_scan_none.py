# The generator scan recipe, contracts/fixtures/generator_scan/generator_scan.json, without a database (docs/spec/feature-coverage.md FCV-3).
# Requirements: DSL-44, DSL-151, DSL-152.

from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/generator_scan/generator_scan.json", NONE)

if __name__ == "__main__":
    testcase.main()
