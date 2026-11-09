# Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
# The suite unit dbspec-render-physical-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# tests/dbspec/render-physical.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/render-physical.json", "mariadb")

if __name__ == "__main__":
    testcase.main()
