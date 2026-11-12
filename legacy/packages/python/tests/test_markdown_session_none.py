# The session recipe, tests/markdown/session.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4): each
# markdown.session step runs reads of the bind fixture model on a listener that answers from its replies.
# Requirements: PRT-66.
from .recipe import NONE, recipe_tests
from . import testcase

load_tests = recipe_tests("tests/markdown/session.json", NONE)

if __name__ == "__main__":
    testcase.main()
