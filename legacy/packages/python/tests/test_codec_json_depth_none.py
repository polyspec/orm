# The recipe tests/codec/codec-json-depth.json without a database: a value nested deeper than 256 levels is refused (COD-70).
# Requirements: COD-70.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/codec/codec-json-depth.json", NONE)

if __name__ == "__main__":
    testcase.main()
