# The suite unit audit_triggers-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/audit_triggers/audit_triggers.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/audit_triggers/audit_triggers.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
