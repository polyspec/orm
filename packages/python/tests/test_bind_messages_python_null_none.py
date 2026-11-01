# The markdown message and control recipe, tests/bind/messages-python-null.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: PRT-67.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/bind/messages-python-null.json", NONE)

if __name__ == "__main__":
    testcase.main()
