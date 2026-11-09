# The suite unit dsn_connection-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/dsn_connection/dsn_connection.json on MariaDB, a server of the MySQL dialect (DIA-200).
# Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-16, CFG-2, DIA-57, DSL-141, DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/dsn_connection/dsn_connection.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
