# Requirements: INT-55, INT-77, INT-91, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
# The suite unit statement_events-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/statement_events/statement_events.json on SQLite.
# Requirements: INT-55, INT-77, INT-91.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/statement_events/statement_events.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
