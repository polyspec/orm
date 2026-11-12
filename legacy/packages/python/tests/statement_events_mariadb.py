# Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md), INT-149.
# The suite unit statement_events-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/statement_events/statement_events.json on MariaDB, a server of the MySQL dialect (DIA-200).
# Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, INT-96.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/statement_events/statement_events.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
