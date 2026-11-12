# The Mermaid recipe, tests/dbspec/mermaid.json, without a database (docs/spec/feature-coverage.md FCV-3).
# Requirements: MER-1, MER-2, MER-3, MER-4, MER-5, MER-6, MER-7, MER-8, MER-9, MER-10, MER-11, MER-12, MER-13.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/mermaid.json", NONE)

if __name__ == "__main__":
    testcase.main()
