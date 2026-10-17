# dsn_connection coverage: a DSN of an unknown scheme is CONFIG, and the DSN of the selected database opens a
# connection of its driver, as the DSN coverage of Go, PHP, TypeScript and Rust does. The feature coverage check runs
# `-m packages.python.tests.coverage_dsn dsn_connection` (scripts/features/coverage.mts, coverage_case.py).
from polyspec.orm import Db
from polyspec.orm.models import models
from .coverage_case import error_code, expect_equal, CoverageCase, coverage_main


def dsn_connection(item):
    driver, dsn = item
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


class CoverageTest(CoverageCase):
    def test_dsn_connection(self):
        self.each_item("dsn_connection", dsn_connection)


if __name__ == "__main__":
    coverage_main(CoverageTest)
