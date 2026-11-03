# The suite unit immutable_write-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/immutable_write/immutable_write.json on sqlite.
# Requirements: DBS-84.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/immutable_write/immutable_write.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
