# model_writes coverage: create, creates, update, upsert and delete once each with the generated CompositeAccount
# model, as the model_writes coverage of Go, PHP, TypeScript and Rust does. It writes only composite_account, which has
# no identity column, and deletes every row it wrote, so the database state stays as it was.
from polyspec.orm.models import models
from .coverage_case import (
    expect_equal,
    CoverageCase,
    coverage_main,
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


class CoverageTest(CoverageCase):
    # Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
    def test_model_write_cycle(self):
        self.each_item("model_write_cycle", model_write_cycle)


if __name__ == "__main__":
    coverage_main(CoverageTest)
