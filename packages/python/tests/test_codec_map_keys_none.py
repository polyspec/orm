# The recipe tests/codec/codec-map-keys.json without a database: a map key that is not a string is refused (COD-70).
# Requirements: COD-16, COD-70.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/codec/codec-map-keys.json", NONE)

if __name__ == "__main__":
    testcase.main()
