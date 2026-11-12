# The entities of the runtime model, tests/dbspec/runtime-model.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-65, DBS-85, DBS-111, DBS-112, DBS-100, DBS-103.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/runtime-model.json", NONE)

if __name__ == "__main__":
    testcase.main()
