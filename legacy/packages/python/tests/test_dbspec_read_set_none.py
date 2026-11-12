# The set reader recipe, tests/dbspec/set-files.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
# Requirements: DBS-6, DBS-7, DBS-8, DBS-9, DBS-10, DBS-11, DBS-12, DBS-13, DBS-14, DBS-15, DBS-17, DBS-18, DBS-19, DBS-20, DBS-21, DBS-22, DBS-23, DBS-24, DBS-25, DBS-26, ORES-20, ORES-28, ORES-29, ORES-30, ORES-31, ORES-32, ORES-33, ORES-34, ORES-35, ORES-36.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/set-files.json", NONE)

if __name__ == "__main__":
    testcase.main()
