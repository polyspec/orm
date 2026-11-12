# The markdown message recipe of the one case that only Python holds, tests/bind/messages-python-null.json, without a database
# (docs/spec/feature-coverage.md FCV-2, FCV-4). Requirements: DBS-121a.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/bind/messages-python-null.json", NONE)

if __name__ == "__main__":
    testcase.main()
