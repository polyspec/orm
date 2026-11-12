# The recipe contracts/fixtures/dsn_reject/dsn_reject_parameters.json on no database (docs/spec/feature-coverage.md FCV-3).
# Go and Rust pass another parameter to their drivers.
# Requirements: CFG-19, CFG-20, CFG-37.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/dsn_reject/dsn_reject_parameters.json", NONE
)

if __name__ == "__main__":
    testcase.main()
