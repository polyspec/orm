# The suite unit complex_query-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/complex_query/complex_query.json on mysql.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/complex_query/complex_query.json", "mysql"
)

if __name__ == "__main__":
    testcase.main()
