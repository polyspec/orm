# parameter_chunking coverage: a root IN list beyond the bind limit of every driver runs in parts and counts right with
# repeated and absent values, and a limit, which the parts would change, is refused with IR_INVALID, as the
# parameter_chunking coverage of Go, PHP, TypeScript and Rust does. It only reads.
from polyspec.orm.models import models
from .coverage_case import error_code, expect_equal, run_cases


def root_in_chunking(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")
        values = [*range(1, 70001), *range(1, 201), *range(200001, 200101)]
        expect_equal(
            models.Author().connect(db).seq(values).get_count(),
            70000,
            "count of the split IN list",
        )
        expect_equal(
            error_code(
                lambda: models.Author().connect(db).seq(values).limit(0, 10).gets()
            ),
            "IR_INVALID",
            "a limit on a split IN list",
        )
    finally:
        db.close()


if __name__ == "__main__":
    run_cases({"root_in_chunking": root_in_chunking})
