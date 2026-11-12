# The suite unit dsn_connection-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/dsn_connection/dsn_connection.json on Markdown.
# Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-2, CFG-26, DIA-57, DSL-141, CFG-12, CFG-13, CFG-24.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/dsn_connection/dsn_connection.json", "markdown"
)

if __name__ == "__main__":
    testcase.main()
