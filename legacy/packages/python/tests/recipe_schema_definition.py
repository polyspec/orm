# The schema definition recipe, tests/dbspec/schema-definition.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4):
# each case parses, emits, builds the manifest, renders, analyzes and formats the dbspec documents named by its steps, through
# the public dbspec API. Requirements: DBS-1, DBS-99, DBS-103, DBS-123, DBS-134, DBS-135, DBS-141, DBS-142, ORES-14.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/schema-definition.json", NONE)

if __name__ == "__main__":
    testcase.main()
