# Requirements: DBS-115, DIA-11, DIA-14, DIA-18, DIA-24, DIA-37, DIA-56, DSL-54, DSL-99, DSL-137, DSL-139, DSL-144, INT-39, PRT-77, DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
# The suite unit conformance_verification-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/conformance_verification/conformance_verification.json on markdown.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/conformance_verification/conformance_verification.json",
    "markdown",
)

if __name__ == "__main__":
    testcase.main()
