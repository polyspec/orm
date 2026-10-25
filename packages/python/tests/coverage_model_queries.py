# model_queries coverage: the conditions, order, limit, sum and relation reads of the generated models on the seeded
# bench database, as the model_queries coverage of Go, PHP, TypeScript and Rust does. It only reads.
from decimal import Decimal

from polyspec.orm import orm
from polyspec.orm.models import models
from .coverage_case import expect_equal, CoverageCase, coverage_main


def model_query_rows(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")

        def author():
            return models.Author().connect(db)

        expect_equal(author().seq(-1).get(), None, "get for a missing author")
        expect_equal(author().user_seq(1).get_count(), 20, "authors of user 1")
        rows = author().service_seq(7).order_by_seq_desc().limit(0, 3).gets()
        expect_equal(
            [row.get_name() for row in rows.values()],
            ["author-99906", "author-99806", "author-99706"],
            "ordered and limited rows",
        )
        query = author().service_seq(7).order_by_seq_desc()
        page = query.gets_page(1, 3)
        expect_equal(
            [row.get_name() for row in page["items"]],
            [row.get_name() for row in rows.values()],
            "first page contains the first ordered rows",
        )
        expect_equal(
            page["totalCount"], query.get_count(), "page total matches get_count"
        )
        expect_equal(
            author().service_seq(7).sum_read_count().get_sum(),
            456000,
            "sum of read_count",
        )
        alias = (
            author()
            .remove_all_columns()
            .add_column_start_dt_alias_start_year(orm.year())
            .get_by_seq(42)
        )
        alias_values = alias.to_array()
        expect_equal(
            "StartYear" in alias_values, False, "alias uses its snake_case name"
        )
        expect_equal(
            alias_values.get("start_year"), 2026, "alias contains the year result"
        )
        join_sql = []
        unsubscribe = db.subscribe(
            lambda event: join_sql.append(event.sql) if event.kind == "select" else None
        )
        joined = (
            author()
            .service_seq(7)
            .join_service_member_seq_with_seq(
                models.ServiceMember().force_index_ix_service_member_service()
            )
            .join_user_seq_with_seq(
                models.User()
                .add_column_read_total(
                    lambda user: models.Author().sum_read_count().user_seq_eq_seq(user)
                )
                .order_by_seq_desc()
            )
            .gets()
        )
        unsubscribe()
        sql = join_sql[-1] if join_sql else ""
        if driver == "sqlite":
            expect_equal(
                'INDEXED BY "ix_service_member_service"' in sql,
                True,
                "joined table forceIndex",
            )
        elif driver == "mysql":
            expect_equal(
                "FORCE INDEX (`ix_service_member_service`)" in sql,
                True,
                "joined table forceIndex",
            )
        joined_rows = joined.values()
        expect_equal(len(joined_rows) > 0, True, "joined query returns authors")
        previous_user_seq = None
        for row in joined_rows:
            user = row.get_user_model()
            expect_equal(user is not None, True, "joined user")
            user_seq = user.get_seq()
            if previous_user_seq is not None:
                expect_equal(
                    user_seq <= previous_user_seq, True, "joined order is descending"
                )
            previous_user_seq = user_seq
            expect_equal(
                Decimal(str(user.get_read_total())),
                Decimal(str(author().user_seq(user_seq).sum_read_count().get_sum())),
                "joined aggregate",
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


def model_query_remove_columns(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")
        row = (
            models.Author()
            .connect(db)
            .remove_all_columns()
            .add_column_name()
            .get_by_seq(42)
        )
        expect_equal(
            sorted(row.to_array()),
            [
                "name",
                "seq",
                "service_member_seq",
                "service_region_seq",
                "service_seq",
                "user_seq",
            ],
            "removeAllColumns keeps keys and the added column",
        )
    finally:
        db.close()


class CoverageTest(CoverageCase):
    # Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-32, INT-33, PLN-11, PLN-25.
    def test_model_query_rows(self):
        self.each_item("model_query_rows", model_query_rows)

    # Requirements: DSL-76.
    def test_remove_columns_keys_and_added_column(self):
        self.each_item(
            "remove_columns_keys_and_added_column", model_query_remove_columns
        )


if __name__ == "__main__":
    coverage_main(CoverageTest)
