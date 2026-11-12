# Requirements: CFG-4, CFG-5, CFG-5a, PRT-77.
# The suite unit connection_pool-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/connection_pool/connection_pool.json on sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/connection_pool/connection_pool.json",
    "sqlite",
)

if __name__ == "__main__":
    testcase.main()
