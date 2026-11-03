# The MySQL introspection of the checks of SHOW CREATE TABLE on the canned catalog of tests/dbspec/show-create.json, the recipe tests/dbspec/show-create-introspect.json (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DIA-84.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/show-create-introspect.json", NONE)

if __name__ == "__main__":
    testcase.main()
