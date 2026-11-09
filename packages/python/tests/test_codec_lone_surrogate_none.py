# The recipe tests/codec/codec-lone-surrogate.json without a database: a text with a lone surrogate is refused (COD-64, COD-70).
# Requirements: COD-64, COD-70.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/codec/codec-lone-surrogate.json", NONE)

if __name__ == "__main__":
    testcase.main()
