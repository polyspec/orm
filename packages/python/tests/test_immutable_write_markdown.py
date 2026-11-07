# The suite unit immutable_write-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/immutable_write/immutable_write.json on markdown.
# Requirements: DBS-84.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/immutable_write/immutable_write.json", "markdown"
)

if __name__ == "__main__":
    testcase.main()
