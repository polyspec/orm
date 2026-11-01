# The suite unit dsn_connection-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/dsn_connection/dsn_connection.json on Sqlite.
# Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/dsn_connection/dsn_connection.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
