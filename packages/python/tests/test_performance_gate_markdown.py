# The suite unit performance_gate-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/performance_gate/performance_gate.json on flowmark.
# Requirements: PERF-1.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/performance_gate/performance_gate.json", "markdown"
)

if __name__ == "__main__":
    testcase.main()
