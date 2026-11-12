# Requirements: PRT-67.
# The suite unit conformance_verification_dynamic-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/conformance_verification/conformance_verification_dynamic.json on sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/conformance_verification/conformance_verification_dynamic.json",
    "sqlite",
)

if __name__ == "__main__":
    testcase.main()
