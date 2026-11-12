# The suite unit composite_keys-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/composite_keys/composite_keys.json on mysql.
# Requirements: DSL-82, INT-87, PRT-12, PRT-40.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/composite_keys/composite_keys.json", "mysql"
)

if __name__ == "__main__":
    testcase.main()
