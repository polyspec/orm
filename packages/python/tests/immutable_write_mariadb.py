# The suite unit immutable_write-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/immutable_write/immutable_write.json on MariaDB, a server of the MySQL dialect (DIA-200).
# Requirements: DBS-84.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/immutable_write/immutable_write.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
