# constraints_and_relations coverage: a foreign key, check and unique violation that the database refuses is reported
# as FOREIGN_KEY, CONSTRAINT and DUPLICATE_KEY and changes no row, as the constraints_and_relations coverage of Go, PHP,
# TypeScript and Rust does.
import os
import tempfile
from pathlib import Path

from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from polyspec.orm.models import models

from .coverage_case import (
    CoverageCase,
    coverage_main,
    error_code,
    expect_equal,
    native_query,
    table_exists,
)
from .test_sqlite import generate_document

REFUSAL_DOCUMENT = (
    Path(__file__).resolve().parents[3] / "contracts/fixtures/refusal.dbs"
)


def drop_refusal(driver, dsn):
    native_query(driver, dsn, ["DROP TABLE IF EXISTS refused_row"])
    if driver == "postgres":
        native_query(
            driver,
            dsn,
            [
                'DROP FUNCTION IF EXISTS "refused_row$immutable_update"()',
                'DROP FUNCTION IF EXISTS "refused_row$immutable_delete"()',
            ],
        )


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


def external_relation(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    try:
        expect_equal(db.driver, driver, "the driver")
        rows = (
            models.NoteReader()
            .connect(db)
            .relation(models.SharedNote().match_shared_note_seq_with_seq())
            .order_by_seq_asc()
            .gets()
        )
        got = [
            f"{row.get_seq()}:{row.get_shared_note_model().get_title()}"
            for row in rows.values()
        ]
        expect_equal(
            got, ["1:note-1", "2:note-1", "3:note-3"], "external shared_note relation"
        )
    finally:
        db.close()


def immutable_write(item):
    driver, dsn = item
    expect_equal(
        table_exists(driver, dsn, "refused_row"), False, "refusal table before the case"
    )
    with tempfile.TemporaryDirectory(prefix="orm-constraints-immutable-") as work:
        refusal_models = generate_document(
            os.path.join(work, "models"), REFUSAL_DOCUMENT
        )
        db = Db.connect(dsn)
        try:
            db.utils().schema().install(refusal_models.SCHEMA)
            row = refusal_models.RefusedRow().connect(db).set_amount(1).create()
            try:
                row.set_amount(2).update()
            except OrmError as error:
                expect_equal(error.code, "DRIVER", "an immutable table refuses update")
                expect_equal(
                    "table refused_row is immutable" in str(error),
                    True,
                    "immutable write message",
                )
                expect_equal(
                    error.__cause__ is not None, True, "immutable write driver cause"
                )
            else:
                raise AssertionError("immutable table update succeeded")
            stored = refusal_models.RefusedRow().connect(db).get_by_seq(row.get_seq())
            expect_equal(stored.get_amount(), 1, "the immutable row was changed")
        finally:
            try:
                drop_refusal(driver, dsn)
            finally:
                db.close()
        expect_equal(
            table_exists(driver, dsn, "refused_row"),
            False,
            "refusal table after the case",
        )


class CoverageTest(CoverageCase):
    # Requirements: CFG-33.
    def test_constraint_errors(self):
        self.each_item("constraint_errors", constraint_errors)

    def test_external_relation(self):
        self.each_item("external_relation", external_relation)

    def test_immutable_write(self):
        # Requirements: DBS-84.
        self.each_item("immutable_write", immutable_write)


if __name__ == "__main__":
    coverage_main(CoverageTest)
