# The suite unit external_audit-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/external_audit/external_audit.json on MariaDB, a server of the MySQL dialect (DIA-200).
# Requirements: SCH-14, DBS-110.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/external_audit/external_audit.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
