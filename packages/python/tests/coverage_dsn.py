# dsn_connection coverage: a DSN of an unknown scheme is CONFIG, and the DSN of the selected database opens a
# connection of its driver, as the DSN coverage of Go, PHP, TypeScript and Rust does. The feature coverage check runs
# `-m packages.python.tests.coverage_dsn dsn_connection` (scripts/features/coverage.mts, coverage_case.py).
from polyspec.orm import Db
from polyspec.orm.models import models
from .coverage_case import error_code, expect_equal, feature_database, run_cases


def dsn_connection():
    driver, dsn = feature_database()
    expect_equal(
        error_code(lambda: Db.connect("invalid://database")),
        "CONFIG",
        "an unsupported DSN scheme",
    )
    db = models.connect(dsn)
    try:
        expect_equal(db.driver, driver, "the driver the DSN selects")
    finally:
        db.close()


if __name__ == "__main__":
    run_cases({"dsn_connection": dsn_connection})
