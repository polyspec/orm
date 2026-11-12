# The suite unit performance_gate-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/performance_gate/performance_gate.json on MySQL.
# Requirements: PERF-1.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/performance_gate/performance_gate.json", "mysql"
)

if __name__ == "__main__":
    testcase.main()
