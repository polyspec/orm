# transactions coverage: an error of the callback rolls the transaction back and reaches the caller as it is, and a
# nested transaction rolls back only its own write through a savepoint, as the transactions coverage of Go, PHP,
# TypeScript and Rust does. The rows are written only to composite_account and removed when the case ends.
from polyspec.orm.models import models
from .coverage_case import (
    expect_equal,
    CoverageCase,
    coverage_main,
    run_on_empty_tenant,
    with_cleanup,
)

TENANT = 990003


class Requested(Exception):
    """The error a callback raises to end its transaction."""


def with_tenant(item, body):
    """Opens the selected database, runs the case and removes every row of the tenant afterwards."""

    def case(db, account):
        with_cleanup(
            lambda: body(db), lambda: account().tenant_id(TENANT).gets().delete()
        )

    run_on_empty_tenant(models, item, TENANT, case)


def exists(db, account_id) -> bool:
    return (
        models.CompositeAccount()
        .connect(db)
        .tenant_id(TENANT)
        .and_account_id(account_id)
        .get_count()
        == 1
    )


def caught(run):
    try:
        run()
    except Requested as error:
        return error
    return None


def transaction_rollback(item):
    def body(db):
        boom = Requested("rollback requested by the callback")

        def callback():
            models.CompositeAccount().set_tenant_id(TENANT).set_account_id(1).set_name(
                "rolled"
            ).create()
            raise boom

        expect_equal(
            caught(lambda: db.transaction(callback)),
            boom,
            "the callback error reaches the caller",
        )
        expect_equal(exists(db, 1), False, "the rolled back row exists")

    with_tenant(item, body)


def transaction_savepoint(item):
    def body(db):
        boom = Requested("inner transaction failed")
        inner = []

        def nested():
            models.CompositeAccount().set_tenant_id(TENANT).set_account_id(3).set_name(
                "inner"
            ).create()
            raise boom

        def outer():
            models.CompositeAccount().set_tenant_id(TENANT).set_account_id(2).set_name(
                "outer"
            ).create()
            inner.append(caught(lambda: db.transaction(nested)))

        db.transaction(outer)
        expect_equal(
            inner, [boom], "the nested transaction error reaches the outer callback"
        )
        expect_equal(exists(db, 2), True, "the outer row is committed")
        expect_equal(
            exists(db, 3), False, "the inner row is rolled back to the savepoint"
        )
        models.CompositeAccount().connect(db).get_by_tenant_id_and_account_id(
            TENANT, 2
        ).delete()
        expect_equal(exists(db, 2), False, "the outer row is deleted")

    with_tenant(item, body)


class CoverageTest(CoverageCase):
    # Requirements: DSL-118, INT-45, PLN-13, PLN-20.
    def test_transaction_rollback(self):
        self.each_item("transaction_rollback", transaction_rollback)

    # Requirements: DSL-119, INT-45, INT-46, PLN-17.
    def test_transaction_savepoint(self):
        self.each_item("transaction_savepoint", transaction_savepoint)


if __name__ == "__main__":
    coverage_main(CoverageTest)
