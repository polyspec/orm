# The suite unit constraints_and_relations-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# Requirements: CFG-33, INT-87, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
# contracts/fixtures/constraints_and_relations/constraints_and_relations.json on PostgreSQL.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/constraints_and_relations/constraints_and_relations.json",
    "postgres",
)

if __name__ == "__main__":
    testcase.main()
