# transactions coverage: an error of the callback rolls the transaction back and reaches the caller as it is, and a
# nested transaction rolls back only its own write through a savepoint, as the transactions coverage of Go, PHP,
# TypeScript and Rust does. The rows are written only to composite_account and removed when the case ends.
import asyncio
import threading

from polyspec.orm.errors import OrmError
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


def handle_abandoned_query(item):
    """Interrupts an in-flight statement with the selected native database driver."""

    def body(db):
        models.CompositeAccount().set_tenant_id(TENANT).set_account_id(6).set_name(
            "original"
        ).create()

        async def cancel_query():
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            handle = db.with_future(future)
            entered = threading.Event()
            resume = threading.Event()
            callback_ran = asyncio.Event()
            future.add_done_callback(lambda _: callback_ran.set())

            def transaction():
                models.CompositeAccount().connect(db).tenant_id(TENANT).and_account_id(
                    6
                ).set_name("temporary").update()
                physical = db.active_frame().connection
                raw = physical.connection
                if item[0] == "sqlite":

                    def progress():
                        entered.set()
                        resume.wait()
                        return 0

                    raw.set_progress_handler(progress, 100)
                    sql = (
                        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL "
                        "SELECT x + 1 FROM n WHERE x < 1000000) SELECT sum(x) FROM n"
                    )
                elif item[0] == "mysql":
                    original_write = raw._write_bytes

                    def write(packet):
                        original_write(packet)
                        if (
                            len(packet) > 4
                            and packet[4] == 3
                            and b"orm-cancel-probe" in packet[5:]
                        ):
                            entered.set()

                    raw._write_bytes = write
                    sql = "SELECT SLEEP(60) /* orm-cancel-probe */"
                else:

                    def notice(diagnostic):
                        if diagnostic.message_primary == "orm-cancel-probe":
                            entered.set()

                    raw.add_notice_handler(notice)
                    sql = (
                        "DO $$ BEGIN RAISE NOTICE 'orm-cancel-probe'; "
                        "PERFORM pg_sleep(60); END $$"
                    )
                try:
                    handle.execute(
                        {"sql": sql, "bind_slots": [], "tables": [], "assemble": None},
                        [],
                    )
                finally:
                    if item[0] == "sqlite":
                        raw.set_progress_handler(None, 0)
                    elif item[0] == "mysql":
                        del raw._write_bytes
                    else:
                        raw.remove_notice_handler(notice)

            task = asyncio.create_task(
                asyncio.to_thread(lambda: handle.transaction(transaction, {"retry": 0}))
            )
            try:
                assert await asyncio.to_thread(entered.wait, 20), (
                    f"{item[0]} statement reached its driver boundary"
                )
                future.cancel()
                await callback_ran.wait()
            finally:
                resume.set()
            try:
                await task
            except OrmError as error:
                assert error.code == "CANCELED", f"{item[0]} cancellation: {error}"
                assert error.cause is not None, f"{item[0]} driver cancellation cause"
            else:
                raise AssertionError(
                    f"{item[0]} statement completed after Future cancellation"
                )

        asyncio.run(cancel_query())
        name = (
            models.CompositeAccount()
            .connect(db)
            .get_by_tenant_id_and_account_id(TENANT, 6)
            .get_name()
        )
        expect_equal(name, "original", f"{item[0]} cancellation rolled back the write")

    with_tenant(item, body)


class CoverageTest(CoverageCase):
    # Requirements: DSL-118, INT-45, INT-67, PLN-13, PLN-20.
    def test_transaction_rollback(self):
        self.each_item("transaction_rollback", transaction_rollback)

    # Requirements: DSL-119, INT-45, INT-46, PLN-17.
    def test_transaction_savepoint(self):
        self.each_item("transaction_savepoint", transaction_savepoint)

    # Requirements: CFG-9, INT-67.
    def test_handle_abandoned_query(self):
        self.each_item("handle_abandoned_query", handle_abandoned_query)


if __name__ == "__main__":
    coverage_main(CoverageTest)
