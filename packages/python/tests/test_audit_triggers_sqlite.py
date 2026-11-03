# The suite unit audit_triggers-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/audit_triggers/audit_triggers.json on sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/audit_triggers/audit_triggers.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
