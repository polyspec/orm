# The suite unit public_interface-none (docs/spec/feature-coverage.md FCV-3): the public interface recipe, contracts/fixtures/public_interface/public_interface.json, on no database.
# Requirements: INT-74, INT-88, INT-89, INT-130.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/public_interface/public_interface.json", NONE)

if __name__ == "__main__":
    testcase.main()
