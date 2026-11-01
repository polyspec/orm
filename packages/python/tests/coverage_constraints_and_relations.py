# constraints_and_relations coverage that the recipe contracts/fixtures/constraints_and_relations/constraints_and_relations.json
# does not state: an immutable table refuses an update with DRIVER and changes no row. The constraint_errors and
# external_relation cases run in the recipe test_constraints_and_relations_<database>.py.
import os
import tempfile
from pathlib import Path

from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError

from .coverage_case import (
    CoverageCase,
    coverage_main,
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
    def test_immutable_write(self):
        # Requirements: DBS-84.
        self.each_item("immutable_write", immutable_write)


if __name__ == "__main__":
    coverage_main(CoverageTest)
