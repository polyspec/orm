# model_queries coverage: the conditions, order, limit, sum and relation reads of the generated models on the seeded
# bench database, as the model_queries coverage of Go, PHP, TypeScript and Rust does. It only reads.
from polyspec.orm.models import models
from .coverage_case import expect_equal, CoverageCase, coverage_main


def model_query_rows(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")
        def author():
            return models.Author().connect(db)
        expect_equal(author().user_seq(1).get_count(), 20, "authors of user 1")
        rows = author().service_seq(7).order_by_seq_desc().limit(0, 3).gets()
        expect_equal(
            [row.get_name() for row in rows.values()],
            ["author-99906", "author-99806", "author-99706"],
            "ordered and limited rows",
        )
        expect_equal(
            author().service_seq(7).sum_read_count().get_sum(),
            456000,
            "sum of read_count",
        )
        loaded = (
            author().relation(models.User().match_user_seq_with_seq()).get_by_seq(5000)
        )
        expect_equal(
            loaded.get_user_model().get_name(),
            "user-1",
            "user loaded through the relation",
        )
    finally:
        db.close()


class CoverageTest(CoverageCase):
    # Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-80, DSL-82, DSL-99, PLN-11.
    def test_model_query_rows(self):
        self.each_item("model_query_rows", model_query_rows)


if __name__ == "__main__":
    coverage_main(CoverageTest)
