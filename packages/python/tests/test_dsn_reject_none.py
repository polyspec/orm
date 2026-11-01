# The suite unit dsn_reject-none (docs/spec/feature-coverage.md FCV-3): the refused DSN recipe,
# contracts/fixtures/dsn_reject/dsn_reject.json, on no database.
# Requirements: CFG-2, CFG-17, CFG-19, CFG-26.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/dsn_reject/dsn_reject.json", NONE)

if __name__ == "__main__":
    testcase.main()
