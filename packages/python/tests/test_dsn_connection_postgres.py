# The suite unit dsn_connection-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/dsn_connection/dsn_connection.json on Postgres.
# Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-19.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/dsn_connection/dsn_connection.json", "postgres"
)

if __name__ == "__main__":
    testcase.main()
