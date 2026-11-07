# Requirements: INT-103
# The suite unit catalog_connection-sqlite-only-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json on flowmark.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json",
    "markdown",
)

if __name__ == "__main__":
    testcase.main()
