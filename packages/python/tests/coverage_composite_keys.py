# composite_keys coverage: a row of a two-column primary key is read by its key, a relation joins membership through
# both components of its foreign key (tenant_id, account_id), and deleting an account removes its membership through
# ON DELETE CASCADE, as the composite_keys coverage of Go, PHP, TypeScript and Rust does. Every written row is removed.
from polyspec.orm.models import models
from .coverage_case import expect_equal, CoverageCase, coverage_main, with_cleanup

# Another tenant also has account 2, so a relation that joins on account_id alone would show.
TENANT = 990004
OTHER_TENANT = 990006


def composite_key_rows(item):
    driver, dsn = item
    db = models.connect(dsn)
    try:
        expect_equal(db.driver, driver, "the driver")
        def account():
            return models.CompositeAccount().connect(db)
        def membership():
            return models.CompositeMembership().connect(db)
        for tenant in (TENANT, OTHER_TENANT):
            expect_equal(
                account().tenant_id(tenant).get_count(),
                0,
                f"composite_account rows of tenant {tenant}",
            )
            expect_equal(
                membership().tenant_id(tenant).get_count(),
                0,
                f"composite_membership rows of tenant {tenant}",
            )

        def body():
            account().set_tenant_id(TENANT).set_account_id(1).set_name("a").create()
            account().set_tenant_id(TENANT).set_account_id(2).set_name("b").create()
            account().set_tenant_id(OTHER_TENANT).set_account_id(2).set_name(
                "c"
            ).create()
            membership().set_tenant_id(TENANT).set_account_id(1).set_role(
                "member"
            ).create()
            membership().set_tenant_id(TENANT).set_account_id(2).set_role(
                "owner"
            ).create()
            membership().set_tenant_id(OTHER_TENANT).set_account_id(2).set_role(
                "guest"
            ).create()
            expect_equal(
                account().get_by_tenant_id_and_account_id(TENANT, 2).get_name(),
                "b",
                "row read by both key components",
            )
            # The relation joins both components of the foreign key in key order. A child with a connection of its own is
            # read apart after the parent rows; both paths give the same result.
            same = (
                account()
                .tenant_id(TENANT)
                .relations(
                    models.CompositeMembership()
                    .match_tenant_id_with_tenant_id()
                    .match_account_id_with_account_id()
                    .alias_memberships()
                )
                .gets()
            )
            own = (
                account()
                .tenant_id(TENANT)
                .relations(
                    models.CompositeMembership()
                    .connect(db)
                    .match_tenant_id_with_tenant_id()
                    .match_account_id_with_account_id()
                    .alias_memberships()
                )
                .gets()
            )
            for path, loaded in (("same statement", same), ("own connection", own)):
                got = [
                    f"{a.get_tenant_id()}/{a.get_account_id()}:{m.get_tenant_id()}/{m.get_account_id()}/{m.get_role()}"
                    for a in loaded.values()
                    for m in a.get_memberships().values()
                ]
                expect_equal(
                    got,
                    [f"{TENANT}/1:{TENANT}/1/member", f"{TENANT}/2:{TENANT}/2/owner"],
                    f"{path}: memberships of tenant {TENANT} accounts",
                )
            account().get_by_tenant_id_and_account_id(TENANT, 2).delete()
            expect_equal(
                membership().tenant_id(TENANT).get_count(),
                1,
                "ON DELETE CASCADE removed the membership of account 2",
            )
            for tenant in (TENANT, OTHER_TENANT):
                account().tenant_id(tenant).gets().delete()
                expect_equal(
                    account().tenant_id(tenant).get_count(),
                    0,
                    f"no account of tenant {tenant} remains",
                )
                expect_equal(
                    membership().tenant_id(tenant).get_count(),
                    0,
                    f"no membership of tenant {tenant} remains",
                )

        def cleanup():
            # A failed run leaves no row of this case either.
            for tenant in (TENANT, OTHER_TENANT):
                membership().tenant_id(tenant).gets().delete()
                account().tenant_id(tenant).gets().delete()

        with_cleanup(body, cleanup)
    finally:
        db.close()


class CoverageTest(CoverageCase):
    def test_composite_key_rows(self):
        # Requirements: PRT-12.
        self.each_item("composite_key_rows", composite_key_rows)


if __name__ == "__main__":
    coverage_main(CoverageTest)
