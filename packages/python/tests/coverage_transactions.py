# The behaviour of the host cancellation handle in a transaction: an abandoned query is cancelled. The rows are written only
# to composite_account and removed when the case ends.
import asyncio
import threading

from polyspec.orm.errors import OrmError

from .coverage_case import (
    CoverageCase,
    coverage_main,
    expect_equal,
    run_on_empty_tenant,
    with_cleanup,
)
from .models import models

TENANT = 990003


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
    # Requirements: CFG-9.
    def test_handle_abandoned_query(self):
        self.each_item("handle_abandoned_query", handle_abandoned_query)


if __name__ == "__main__":
    coverage_main(CoverageTest)
