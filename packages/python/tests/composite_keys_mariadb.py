# The suite unit composite_keys-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/composite_keys/composite_keys.json on MariaDB, a server of the MySQL dialect (DIA-200).
# Requirements: DSL-82, INT-87, PRT-12, PRT-40.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/composite_keys/composite_keys.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
