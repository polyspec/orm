# Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
# The suite unit dbspec-render-physical-markdown (docs/spec/feature-coverage.md FCV-3): the recipe
# tests/dbspec/render-physical.json on markdown.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("tests/dbspec/render-physical.json", "markdown")

if __name__ == "__main__":
    testcase.main()
