# The markdown message and control recipe, tests/bind/messages-dynamic.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: PRT-67.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/bind/messages-dynamic.json", NONE)

if __name__ == "__main__":
    testcase.main()
