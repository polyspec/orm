# The suite unit conformance_verification-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/conformance_verification/conformance_verification.json on sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/conformance_verification/conformance_verification.json",
    "sqlite",
)

if __name__ == "__main__":
    testcase.main()
