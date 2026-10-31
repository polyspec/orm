# The recipe tests/codec/codec-integer-beyond-i64.json without a database: an integer beyond i64 is refused (COD-62).
# Requirements: COD-62.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/codec/codec-integer-beyond-i64.json", NONE)

if __name__ == "__main__":
    testcase.main()
