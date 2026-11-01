# The recipe tests/codec/codec-bytes-value.json without a database: bytes are not a codec value (COD-63).
# Requirements: COD-63.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/codec/codec-bytes-value.json", NONE)

if __name__ == "__main__":
    testcase.main()
