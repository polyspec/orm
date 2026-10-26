# model_queries coverage: the conditions, order, limit, sum and relation reads of the generated models on the seeded
# bench database, as the model_queries coverage of Go, PHP, TypeScript and Rust does. It only reads.
from decimal import Decimal

from polyspec.orm import orm
from polyspec.orm.models import models

from .coverage_case import (
    CoverageCase,
    connect_bench_author,
    coverage_main,
    error_code,
    expect_equal,
)
from .test_group_rows_db import check_group_rows_database


def model_query_rows(item):
    db, author, driver, dsn = connect_bench_author(models, item)
    try:
        rows = (
            author()
            .service_seq(7)
            .and_is_close(False)
            .or_()
            .read_count(6)
            .order_by_seq_asc()
            .limit(0, 3)
            .gets()
        )
        expect_equal(
            [row.get_name() for row in rows.values()],
            ["author-6", "author-106", "author-206"],
            "condition connectors",
        )
        grouped = (
            author()
            .service_seq(7)
            .and_(
                lambda query: query.is_display(False).or_(
                    lambda nested: nested.is_close(True).and_gt_read_count(500)
                )
            )
            .order_by_seq_desc()
            .limit(0, 3)
            .gets()
        )
        expect_equal(
            [row.get_name() for row in grouped.values()],
            ["author-99906", "author-99806", "author-99606"],
            "nested condition groups",
        )
        query = author().service_seq(7)
        query.get_count_by_is_close(True)
        expect_equal(
            query.get_count(),
            author().service_seq(7).get_count(),
            "a terminal operation leaves its builder unchanged",
        )
        expect_equal(
            error_code(lambda: author().name("a").is_close(True).gets()),
            "CONFIG",
            "a missing condition connector",
        )
        expect_equal(
            error_code(lambda: author().and_().gets()),
            "CONFIG",
            "a dangling condition connector",
        )
        expect_equal(
            error_code(lambda: author().seq([]).gets()),
            "EMPTY_IN",
            "an empty IN list",
        )
        expect_equal(
            error_code(lambda: author().and_(lambda query: query.get_count()).gets()),
            "CONFIG",
            "a terminal inside a condition group",
        )

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
        selected = (
            author()
            .remove_all_columns()
            .add_column_name()
            .add_column_start_dt_alias_start_year(orm.year())
            .remove_column_name()
            .get_by_seq(42)
        )
        expect_equal(
            selected.to_array(),
            {
                "seq": 42,
                "user_seq": 43,
                "service_seq": 43,
                "service_region_seq": 3,
                "service_member_seq": 43,
                "start_year": 2026,
            },
            "removing an added column keeps the selected generated column",
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
        other = models.connect(
            dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index"
        )
        try:
            connected = (
                author()
                .relation(
                    models.User()
                    .connect(other)
                    .match_user_seq_with_seq()
                    .alias_writer()
                )
                .get_by_seq(5000)
            )
            expect_equal(
                connected.get_writer().get_name(),
                "user-1",
                "a connected relation child uses its own connection",
            )
            expect_equal(
                error_code(
                    lambda: (
                        author()
                        .join_user_seq_with_seq(models.User().connect(other))
                        .gets()
                    )
                ),
                "CONFIG",
                "a joined child cannot have its own connection",
            )
        finally:
            other.close()
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


def model_query_group_rows(item, test_case):
    db, author, driver, _ = connect_bench_author(models, item)
    try:
        expect_equal(db.driver, driver, "the driver")
        check_group_rows_database(test_case, db, author)
    finally:
        db.close()


class CoverageTest(CoverageCase):
    # Requirements: DBS-118, DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-32, INT-33, PLN-6, PLN-7, PLN-8, PLN-9, PLN-10, PLN-11, PLN-14, PLN-23, PLN-25, PLN-28, PLN-34, PLN-35, PLN-37, PLN-38, PLN-39, PLN-41, PLN-42, PLN-43.
    def test_model_query_rows(self):
        self.each_item("model_query_rows", model_query_rows)

    # Requirements: DSL-76.
    def test_remove_columns_keys_and_added_column(self):
        self.each_item(
            "remove_columns_keys_and_added_column", model_query_remove_columns
        )

    # Requirements: INT-31.
    def test_group_rows_database(self):
        self.each_item(
            "group_rows_database", lambda item: model_query_group_rows(item, self)
        )


if __name__ == "__main__":
    coverage_main(CoverageTest)
