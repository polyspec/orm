# Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, PRT-75.
# The suite unit fulltext-search-recipe-postgres (docs/spec/feature-coverage.md FCV-22): the recipe
# contracts/fixtures/fulltext_search/fulltext_search.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/fulltext_search/fulltext_search.json", "postgres"
)

if __name__ == "__main__":
    testcase.main()
