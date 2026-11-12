# The suite unit complex_query-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/complex_query/complex_query.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/complex_query/complex_query.json",
    "postgres",
)

if __name__ == "__main__":
    testcase.main()
