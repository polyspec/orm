# Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit parameter_chunking-sqlite.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/parameter_chunking/parameter_chunking.json", "sqlite"
)

if __name__ == "__main__":
    testcase.main()
