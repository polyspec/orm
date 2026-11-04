# Requirements: PLN-102.
# Requirements: DBS-42, DBS-84, DBS-94, DIA-110, DIA-111, DIA-112, DIA-133, DIA-134, DIA-135, DIA-136, DIA-137.
# Requirements: DIA-138, DIA-139, DIA-140, DIA-141, DIA-142, DIA-143, DIA-144, DIA-145, DIA-146, DIA-147, DIA-148.
# Requirements: DIA-149, DIA-150, DIA-151, DIA-152, DIA-153, DIA-198, DIA-39, DIA-44, DIA-49, DIA-50, DIA-59, DIA-71.
# Requirements: FCV-2.
# The suite unit dbspec_introspect-postgres (docs/spec/feature-coverage.md FCV-3): the recipe
# contracts/fixtures/dbspec_introspect/dbspec_introspect.json on postgres.
from .recipe import recipe_tests
from . import testcase

load_tests = recipe_tests(
    "contracts/fixtures/dbspec_introspect/dbspec_introspect.json",
    "postgres",
)

if __name__ == "__main__":
    testcase.main()
