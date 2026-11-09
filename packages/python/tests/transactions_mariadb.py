# Requirements: CFG-15, INT-155.
# The suite unit transactions-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/transactions/transactions.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/transactions/transactions.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
