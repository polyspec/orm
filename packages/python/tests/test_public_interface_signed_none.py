# The suite unit public_interface_signed-none (docs/spec/feature-coverage.md FCV-3): the signed public interface recipe, contracts/fixtures/public_interface/public_interface_signed.json (the signed limit, which Rust refuses at compile time), on no database.
# Requirements: INT-159.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/public_interface/public_interface_signed.json", NONE)

if __name__ == "__main__":
    testcase.main()
