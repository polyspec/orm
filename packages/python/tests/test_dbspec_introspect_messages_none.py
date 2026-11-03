# The SQLite unsupported column reason of tests/dbspec/introspect-messages.json on a memory connection (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DIA-191.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/introspect-messages.json", NONE)

if __name__ == "__main__":
    testcase.main()
