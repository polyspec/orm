# constraints_and_relations coverage: a foreign key, check and unique violation that the database refuses is reported
# as FOREIGN_KEY, CONSTRAINT and DUPLICATE_KEY and changes no row, as the constraints_and_relations coverage of Go, PHP,
# TypeScript and Rust does.
from polyspec.orm.models import models
from .coverage_case import error_code, expect_equal, CoverageCase, coverage_main


# CFG-33: a violated foreign key, check or unique key is reported as FOREIGN_KEY, CONSTRAINT or DUPLICATE_KEY, and no row changes.
def constraint_errors(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")

        def snapshot():
            first = models.Author().connect(db).add_all_columns().get_by_seq(1)
            user = models.User().connect(db).get_by_seq(1)
            return first.to_json_text(), user.to_json_text()

        before = snapshot()
        second = models.Author().connect(db).get_by_seq(2)
        expect_equal(type(second.get_uuid()), str, "the uuid of author 2")
        user = models.User().connect(db).get_by_seq(1)
        expect_equal(
            error_code(user.delete), "FOREIGN_KEY", "delete of a referenced user"
        )
        expect_equal(
            error_code(
                lambda: (
                    models.Author().connect(db).set_seq(1).set_like_count(-1).update()
                )
            ),
            "CONSTRAINT",
            "ck_author_counts",
        )
        expect_equal(
            error_code(
                lambda: (
                    models.Author()
                    .connect(db)
                    .set_seq(1)
                    .set_uuid(second.get_uuid())
                    .update()
                )
            ),
            "DUPLICATE_KEY",
            "uq_author_uuid",
        )
        expect_equal(snapshot(), before, "the rejected writes changed nothing")
    finally:
        db.close()


class CoverageTest(CoverageCase):
    # Requirements: CFG-33.
    def test_constraint_errors(self):
        self.each_item("constraint_errors", constraint_errors)


if __name__ == "__main__":
    coverage_main(CoverageTest)
