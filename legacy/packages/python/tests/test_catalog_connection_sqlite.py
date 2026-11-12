# Requirements: INT-107, COD-31, INT-4, INT-8, SCH-3, SCH-5
# The suite unit catalog_connection-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/catalog_connection/catalog_connection.json on SQLite.
# Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123, INT-136,
# SCH-6a.
# Requirements: DBS-113, INT-34, INT-102, INT-106, INT-108, INT-110, INT-112, SCH-5.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/catalog_connection/catalog_connection.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
