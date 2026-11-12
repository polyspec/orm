# The suite unit complex_query-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/complex_query/complex_query.json on markdown.
# Requirements: CPX-5, DSL-128.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/complex_query/complex_query.json",
    "markdown",
)

if __name__ == "__main__":
    testcase.main()
