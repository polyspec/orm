# model_writes coverage uses CompositeAccount for CRUD and seeded Author.read_count for arithmetic.
# The arithmetic case rolls back its updates to preserve the seeded row and identity sequence.

from polyspec.orm import OrmError, codes
from polyspec.orm.models import models

from .coverage_case import (
    CoverageCase,
    coverage_main,
    error_code,
    expect_equal,
    run_on_empty_tenant,
    with_cleanup,
)

TENANT = 990002


def model_write_cycle(item):
    def case(_db, account):
        def body():
            created = (
                account()
                .set_tenant_id(TENANT)
                .set_account_id(1)
                .set_name("created")
                .create()
            )
            expect_equal(created.get_name(), "created", "the created name")
            inserted = account().creates(
                [
                    models.CompositeAccount()
                    .set_tenant_id(TENANT)
                    .set_account_id(i)
                    .set_name(f"many-{i}")
                    for i in (2, 3, 4)
                ],
                2,
            )
            expect_equal(inserted, 3, "rows inserted by creates")
            account().get_by_tenant_id_and_account_id(TENANT, 1).set_name(
                "updated"
            ).update()
            expect_equal(
                account().get_by_tenant_id_and_account_id(TENANT, 1).get_name(),
                "updated",
                "updated name",
            )
            account().set_tenant_id(TENANT).set_account_id(1).set_name(
                "ignored"
            ).duplication(models.CompositeAccount().set_name("upserted")).create()
            expect_equal(
                account().get_by_tenant_id_and_account_id(TENANT, 1).get_name(),
                "upserted",
                "duplication assignment",
            )
            expect_equal(
                account().tenant_id(TENANT).get_count(), 4, "rows of the tenant"
            )
            names = [
                a.get_name()
                for a in account()
                .tenant_id(TENANT)
                .order_by_account_id_asc()
                .gets()
                .values()
            ]
            expect_equal(
                names,
                ["upserted", "many-2", "many-3", "many-4"],
                "names of the tenant rows",
            )
            account().tenant_id(TENANT).gets().delete()
            expect_equal(
                account().get_by_tenant_id_and_account_id(TENANT, 1),
                None,
                "deleted row",
            )
            expect_equal(
                account().tenant_id(TENANT).get_count(),
                0,
                "every row of the tenant deleted",
            )

        # A failed run leaves no row of this case either.
        with_cleanup(body, lambda: account().tenant_id(TENANT).gets().delete())

    run_on_empty_tenant(models, item, TENANT, case)


def save_key_dispatch(item):
    driver, dsn = item
    db = models.connect(dsn)
    writes = []
    sentinel = OrmError(codes.CONFIG, "DSL-109 request hook stopped the write")

    def hook(request, _add_param, _params):
        if request.kind in ("insert", "update"):
            writes.append(request.kind)
            raise sentinel
        return request

    hooked = db.with_request_hook(hook)

    def account():
        return models.Account().connect(hooked)

    def assert_rejected(save):
        try:
            save()
        except OrmError as error:
            expect_equal(
                error is sentinel, True, "Save propagates the request-hook sentinel"
            )
            return
        raise AssertionError("Save reached execution instead of the request hook")

    try:
        expect_equal(db.driver, driver, "the driver")
        assert_rejected(lambda: account().set_name("missing").save())
        expect_equal(writes, ["insert"], "missing key Save selects INSERT")

        writes.clear()
        assert_rejected(lambda: account().set_seq(0).set_name("zero").save())
        expect_equal(writes, ["update"], "explicit zero Save selects UPDATE")

        writes.clear()
        loaded = (
            models.Author()
            .connect(hooked)
            .remove_all_columns()
            .add_column_seq()
            .add_column_read_count()
            .get_by_seq(1)
        )
        expect_equal(
            loaded is not None, True, "seed author 1 loads through the hooked handle"
        )
        assert_rejected(lambda: loaded.set_read_count(loaded.get_read_count()).save())
        expect_equal(writes, ["update"], "loaded original key Save selects UPDATE")
    finally:
        db.close()


def model_write_arithmetic_attributes(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    unsubscribe = None
    try:
        expect_equal(db.driver, driver, "the driver")

        def author():
            return models.Author().connect(db)

        before = author().add_all_columns().get_by_seq(1)
        expect_equal(before is not None, True, "seed author 1 exists")
        before_read_count = before.get_read_count()
        before_updated_ts = before.get_updated_ts()
        expect_equal(before_read_count, 1, "seed author 1 read_count")
        boom = RuntimeError("PLN-26 rollback sentinel")
        events = []
        caught = None

        def work():
            nonlocal unsubscribe
            loaded = author().add_all_columns().get_by_seq(1)
            expect_equal(
                loaded is not None, True, "seed author 1 is readable in the transaction"
            )
            loaded.set_read_count(1).update()
            unsubscribe = db.subscribe(
                lambda event: (
                    events.append(event)
                    if event.kind == "update" and "author" in event.tables
                    else None
                )
            )
            loaded = author().add_all_columns().get_by_seq(1)
            loaded.plus_read_count(7).update()
            expect_equal(
                author().add_all_columns().get_by_seq(1).get_read_count(),
                8,
                "plus updates the non-key column",
            )
            expect_equal(
                any(7 in event.binds for event in events), True, "plus amount is bound"
            )
            loaded.update()
            expect_equal(len(events), 1, "a write clears the pending arithmetic change")
            current = author().add_all_columns().get_by_seq(1)
            current.minus_read_count(9).update()
            after_minus = author().add_all_columns().get_by_seq(1)
            expect_equal(after_minus.get_read_count(), 0, "minus clamps at zero")
            expect_equal(
                any(9 in event.binds for event in events), True, "minus amount is bound"
            )
            raise boom

        try:
            db.transaction(work, {"retry": 0})
        except RuntimeError as error:
            caught = error
        expect_equal(caught is boom, True, "transaction returns the rollback sentinel")
        after = author().add_all_columns().get_by_seq(1)
        expect_equal(
            after.get_read_count(), before_read_count, "rollback restores read_count"
        )
        expect_equal(
            after.get_updated_ts(), before_updated_ts, "rollback restores updated_ts"
        )
    finally:
        try:
            if unsubscribe is not None:
                unsubscribe()
        finally:
            db.close()


class CoverageTest(CoverageCase):
    # Requirements: DSL-104, INT-35, PRT-41.
    def test_create_parts(self):
        tenant = TENANT + 1

        def case(_db, account):
            events = []
            unsubscribe = _db.subscribe(events.append)
            try:
                refused = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(1)
                    .set_name("refused")
                ]
                expect_equal(
                    error_code(lambda: account().creates(refused, 0)),
                    "CONFIG",
                    "batch zero error",
                )
                expect_equal(events, [], "refused batch sends no statements")
                limit = 999 if _db.driver == "sqlite" else 65535
                oversized = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(8)
                    .set_name("oversized")
                    for _ in range(limit // 3 + 1)
                ]
                expect_equal(
                    error_code(lambda: account().creates(oversized, len(oversized))),
                    "BATCH_TOO_LARGE",
                    "over-limit batch is refused",
                )
                expect_equal(events, [], "over-limit batch sends no statements")

                labels = [
                    "ordered-5",
                    "ordered-4",
                    "ordered-3",
                    "ordered-2",
                    "ordered-1",
                ]
                rows = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(i + 1)
                    .set_name(label)
                    for i, label in enumerate(labels)
                ]
                expect_equal(account().creates(rows, 2), 5, "rows inserted")
                inserts = [event for event in events if event.kind == "insert"]
                expect_equal(
                    [len(event.binds) // 3 for event in inserts],
                    [2, 2, 1],
                    "INSERT batch sizes",
                )
                stored = account().tenant_id(tenant).order_by_account_id_asc().gets()
                expect_equal(
                    [row.get_name() for row in stored], labels, "stored row order"
                )

                account().tenant_id(tenant).gets().delete()
                events.clear()
                account().set_tenant_id(tenant).set_account_id(99).set_name(
                    "existing"
                ).create()
                events.clear()
                failing = [
                    models.CompositeAccount()
                    .set_tenant_id(tenant)
                    .set_account_id(key)
                    .set_name(f"rollback-{key}")
                    for key in (10, 11, 12, 13, 99)
                ]
                expect_equal(
                    error_code(lambda: account().creates(failing, 2)),
                    "DUPLICATE_KEY",
                    "third batch conflicts with sentinel",
                )
                failed_inserts = [event for event in events if event.kind == "insert"]
                expect_equal(
                    [len(event.binds) // 3 for event in failed_inserts],
                    [2, 2, 1],
                    "failing INSERT batches",
                )
                expect_equal(
                    account().tenant_id(tenant).get_count(),
                    1,
                    "failed call rolls back earlier batches",
                )
                expect_equal(
                    account().get_by_tenant_id_and_account_id(tenant, 99).get_name(),
                    "existing",
                    "sentinel survives rollback",
                )
            finally:
                try:
                    unsubscribe()
                finally:
                    account().tenant_id(tenant).gets().delete()

            def assert_clean():
                account().tenant_id(tenant).gets().delete()
                expect_equal(
                    account().tenant_id(tenant).get_count(), 0, "case leaves no rows"
                )

            with_cleanup(
                assert_clean,
                lambda: account().tenant_id(tenant).gets().delete(),
            )

        self.each_item(
            "create_parts", lambda item: run_on_empty_tenant(models, item, tenant, case)
        )

    # Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
    def test_model_write_cycle(self):
        self.each_item("model_write_cycle", model_write_cycle)

    # Requirements: DSL-109.
    def test_save_key_dispatch(self):
        self.each_item("save_key_dispatch", save_key_dispatch)

    # Requirements: PLN-26.
    def test_model_write_arithmetic_attributes(self):
        self.each_item(
            "model_write_arithmetic_attributes", model_write_arithmetic_attributes
        )


if __name__ == "__main__":
    coverage_main(CoverageTest)
