# The recipe contracts/fixtures/dsn_reject/dsn_reject_checked.json on no database (docs/spec/feature-coverage.md FCV-3).
# Rust passes the TLS options to its driver and its fields are unsigned.
# Requirements: CFG-4, CFG-5, CFG-6, CFG-18, CFG-36.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/dsn_reject/dsn_reject_checked.json", NONE)

if __name__ == "__main__":
    testcase.main()
