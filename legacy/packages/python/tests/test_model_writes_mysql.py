# Requirements: FCV-8, FCV-9, FCV-10, FCV-13, FCV-14.
# The suite unit model_writes-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/model_writes/model_writes.json on mysql.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/model_writes/model_writes.json", "mysql")

if __name__ == "__main__":
    testcase.main()
