# Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134, CFG-30, INT-50, INT-72.
# The suite unit utils-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe contracts/fixtures/utils/utils.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/utils/utils.json", "mariadb")

if __name__ == "__main__":
    testcase.main()
