# The suite unit composite_keys-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/composite_keys/composite_keys.json on sqlite.
# Requirements: DSL-82, INT-87, PRT-12, PRT-40.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/composite_keys/composite_keys.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
