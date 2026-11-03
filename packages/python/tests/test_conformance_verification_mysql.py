# Requirements: DIA-24, INT-39.
# The suite unit conformance_verification-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/conformance_verification/conformance_verification.json on mysql.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/conformance_verification/conformance_verification.json", "mysql"
)

if __name__ == "__main__":
    testcase.main()
