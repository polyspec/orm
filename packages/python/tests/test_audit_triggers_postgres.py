# The suite unit audit_triggers-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/audit_triggers/audit_triggers.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/audit_triggers/audit_triggers.json", "postgres"
)

if __name__ == "__main__":
    testcase.main()
