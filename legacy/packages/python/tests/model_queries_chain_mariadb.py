# Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-90, DSL-99, INT-16, INT-29, INT-30, INT-31, INT-32, INT-33, INT-36, INT-87, PLN-11, PLN-25, PRT-35, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
# The suite unit model_queries_chain-mariadb (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/model_queries_chain/model_queries_chain.json on MariaDB, a server of the MySQL dialect (DIA-200).
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/model_queries_chain/model_queries_chain.json", "mariadb"
)

if __name__ == "__main__":
    testcase.main()
