# Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
# FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
# The suite unit request_hook-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/request_hook/request_hook.json on MariaDB, a server of the MySQL dialect (DIA-200).
# Requirements: INT-78, PRT-2, PRT-4, PRT-5, PRT-6, PRT-41, CFG-21, INT-36, INT-37, PLN-16, DIA-161, INT-38, PRT-65.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/request_hook/request_hook.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
