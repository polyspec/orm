# Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-sqlite.
# INT-151: on SQLite a text stored in an INTEGER or REAL column is a text grid cell; the recipe expects it at step 16 of read_path_codes, rotation_path_codes and stored_version_text. Requirement: INT-151.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests("contracts/fixtures/aes_rotation/aes_rotation.json", "sqlite")

if __name__ == "__main__":
    testcase.main()
