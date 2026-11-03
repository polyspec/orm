# The suite unit conformance_verification-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/conformance_verification/conformance_verification.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/conformance_verification/conformance_verification.json",
    "postgres",
)

if __name__ == "__main__":
    testcase.main()
