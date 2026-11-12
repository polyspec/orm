# Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
# FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
# The suite unit request_hook-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/request_hook/request_hook.json on flowmark.
# Requirements: INT-78, PRT-65.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/request_hook/request_hook.json", "markdown"
)

if __name__ == "__main__":
    testcase.main()
