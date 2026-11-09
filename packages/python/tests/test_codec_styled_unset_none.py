# The recipe tests/codec/codec-styled-unset.json without a database: a styled value that is neither SQL NULL nor a value is refused (COD-70).
# Requirements: COD-70.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/codec/codec-styled-unset.json", NONE)

if __name__ == "__main__":
    testcase.main()
