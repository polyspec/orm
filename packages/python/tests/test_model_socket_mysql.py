# Requirements: FCV-3, FCV-4, FCV-9, FCV-13, CFG-10, CFG-19.
# The suite unit model_socket-mysql (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/model_socket/model_socket.json on mysql.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/model_socket/model_socket.json", "mysql")

if __name__ == "__main__":
    testcase.main()
