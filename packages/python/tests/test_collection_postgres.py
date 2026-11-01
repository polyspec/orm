# The suite unit collection-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# tests/collection/collection.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("tests/collection/collection.json", "postgres")

if __name__ == "__main__":
    testcase.main()
