# The suite unit external_audit-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/external_audit/external_audit.json on mysql.
# Requirements: SCH-14, DBS-110.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/external_audit/external_audit.json", "mysql"
)

if __name__ == "__main__":
    testcase.main()
