# Requirements: SCH-13
# Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11, INT-56, INT-57, INT-58, SCH-8, SCH-9
# The suite unit schema_install-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/schema_install/schema_install.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/schema_install/schema_install.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
