# model_writes coverage: create, creates, update, upsert and delete once each with the generated CompositeAccount
# model, as the model_writes coverage of Go, PHP, TypeScript and Rust does. It writes only composite_account, which has
# no identity column, and deletes every row it wrote, so the database state stays as it was.
import os

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


def model_write_arithmetic_attributes(item):
    driver, dsn = item
    db = models.connect(dsn, aesKey="bench-salt", blindIndexKey="bench-blind-index")
    tenant = 1_000_000_000_000 + os.getpid()
    unsubscribe = None
    try:
        expect_equal(db.driver, driver, "the driver")

        def account():
            return models.CompositeAccount().connect(db)

        expect_equal(account().tenant_id(tenant).get_count(), 0, "scratch tenant starts empty")
        account().set_tenant_id(tenant).set_account_id(1).set_name("arithmetic").create()
        loaded = account().get_by_tenant_id_and_account_id(tenant, 1)
        events = []
        unsubscribe = db.subscribe(
            lambda event: events.append(event)
            if event.kind == "update" and "composite_account" in event.tables
            else None
        )
        loaded.plus_account_id(7).update()
        expect_equal(
            account().get_by_tenant_id_and_account_id(tenant, 8).get_name(),
            "arithmetic",
            "plus amount changes the key",
        )
        expect_equal(any(7 in event.binds for event in events), True, "plus amount is bound")
        loaded.update()
        expect_equal(len(events), 1, "a write clears the pending arithmetic change")

        current = account().get_by_tenant_id_and_account_id(tenant, 8)
        amount = current.get_account_id() + 1
        current.minus_account_id(amount).update()
        expect_equal(
            account().get_by_tenant_id_and_account_id(tenant, 0).get_name(),
            "arithmetic",
            "minus clamps at zero",
        )
        expect_equal(any(amount in event.binds for event in events), True, "minus amount is bound")
    finally:
        try:
            account().tenant_id(tenant).gets().delete()
            expect_equal(account().tenant_id(tenant).get_count(), 0, "scratch row is removed")
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

    # Requirements: PLN-26.
    def test_model_write_arithmetic_attributes(self):
        self.each_item("model_write_arithmetic_attributes", model_write_arithmetic_attributes)


if __name__ == "__main__":
    coverage_main(CoverageTest)
