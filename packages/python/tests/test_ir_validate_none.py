# The request validation recipe, tests/ir/validate.json, without a database (docs/spec/feature-coverage.md FCV-3).
# Requirements: PRT-1, INT-24, PRT-4, PRT-6, PRT-8, PRT-10, PRT-12, PRT-14, PRT-16, PRT-17, PRT-18, PRT-20, PRT-21, PRT-22, PRT-24, PRT-78,
# DBS-59, DBS-113, DSL-113, DSL-128.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/ir/validate.json", NONE)

if __name__ == "__main__":
    testcase.main()
