# Requirements: PRT-67.
# The suite unit conformance_verification_dynamic-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/conformance_verification/conformance_verification_dynamic.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/conformance_verification/conformance_verification_dynamic.json",
    "mariadb",
)

if __name__ == "__main__":
    testcase.main()
