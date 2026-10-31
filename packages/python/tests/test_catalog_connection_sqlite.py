# The suite unit catalog_connection-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/catalog_connection/catalog_connection.json on SQLite.
# Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123, INT-136,
# SCH-6a.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/catalog_connection/catalog_connection.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
