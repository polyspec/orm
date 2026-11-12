# Requirements: PLN-89, PLN-90, PLN-91, PLN-92, PLN-93, PLN-94, PLN-95, PLN-96, PLN-104, PLN-105.
# The suite unit dbspec_apply-sqlite (docs/spec/feature-coverage.md FCV-3): the recipe contracts/fixtures/dbspec_apply/dbspec_apply.json on Sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/dbspec_apply/dbspec_apply.json", "sqlite")

if __name__ == "__main__":
    testcase.main()
