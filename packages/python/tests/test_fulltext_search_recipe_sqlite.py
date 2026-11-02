# Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, DIA-187, PRT-75.
# The suite unit fulltext-search-recipe-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/fulltext_search/fulltext_search.json on sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/fulltext_search/fulltext_search.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
