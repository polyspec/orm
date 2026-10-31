# transactions coverage: an error of the callback rolls the transaction back and reaches the caller as it is, and a
# nested transaction rolls back only its own write through a savepoint, as the transactions coverage of Go, PHP,
# TypeScript and Rust does. The rows are written only to composite_account and removed when the case ends.
import asyncio
import threading

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from .models import models

from .coverage_case import (
    CoverageCase,
    coverage_main,
    error_code,
    expect_equal,
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
        expect_equal(
            error_code(lambda: models.CompositeAccount().get_count()),
            "CONFIG",
            "an unconnected model outside a transaction returns CONFIG",
        )
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
            for options in (
                {"isolation": "serializable"},
                {"readOnly": True},
                {"timeoutMs": 1},
            ):
                called = []

                def invoke_invalid_nested(options=options, called=called):
                    def callback():
                        called.append(True)

                    return db.transaction(callback, options)

                expect_equal(
                    error_code(invoke_invalid_nested),
                    "CONFIG",
                    "a nested transaction rejects every option except retry",
                )
                expect_equal(
                    called, [], "an invalid nested option does not run its callback"
                )
            for lock in (
                "for_update",
                "for_share",
                "for_update_no_wait",
                "for_share_no_wait",
            ):
                query = (
                    models.CompositeAccount()
                    .connect(db)
                    .tenant_id(TENANT)
                    .and_account_id(2)
                )
                row = getattr(query, lock)().get()
                expect_equal(
                    row is not None, True, f"{lock} works inside a transaction"
                )
            calls = []

            def nested_once():
                calls.append(True)
                return nested()

            inner.append(caught(lambda: db.transaction(nested_once, {"retry": 3})))
            expect_equal(calls, [True], "nested retry is accepted and ignored")

        for isolation in (
            "read_uncommitted",
            "read_committed",
            "repeatable_read",
            "serializable",
        ):
            db.transaction(lambda: None, {"isolation": isolation, "retry": 0})
        db.transaction(outer, {"retry": 0})
        expect_equal(
            inner, [boom], "the nested transaction error reaches the outer callback"
        )
        expect_equal(exists(db, 2), True, "the outer row is committed")
        expect_equal(
            exists(db, 3), False, "the inner row is rolled back to the savepoint"
        )
        for lock in (
            "for_update",
            "for_share",
            "for_update_no_wait",
            "for_share_no_wait",
        ):
            query = (
                models.CompositeAccount()
                .connect(db)
                .tenant_id(TENANT)
                .and_account_id(2)
            )
            expect_equal(
                error_code(lambda query=query, lock=lock: getattr(query, lock)().get()),
                "CONFIG",
                f"{lock} outside a transaction returns CONFIG",
            )
        models.CompositeAccount().connect(db).get_by_tenant_id_and_account_id(
            TENANT, 2
        ).delete()
        expect_equal(exists(db, 2), False, "the outer row is deleted")

        flow_errors = []

        def check_other_thread():
            try:
                models.CompositeAccount().get_count()
            except OrmError as error:
                flow_errors.append(error.code)

        def check_flow():
            thread = threading.Thread(target=check_other_thread)
            thread.start()
            thread.join()

        db.transaction(check_flow, {"retry": 0})
        expect_equal(
            flow_errors,
            [codes.CONFIG],
            "a thread started inside the callback has no active transaction",
        )

        read_only_error = None
        try:
            db.transaction(
                lambda: (
                    models.CompositeAccount()
                    .set_tenant_id(TENANT)
                    .set_account_id(4)
                    .set_name("read only")
                    .create()
                ),
                {"readOnly": True, "retry": 0},
            )
        except OrmError as error:
            read_only_error = error
        expect_equal(
            getattr(read_only_error, "code", None),
            codes.READ_ONLY,
            "read-only write error",
        )
        expect_equal(exists(db, 4), False, "read-only transaction wrote a row")

        timeout_error = None
        timeout_calls = 0

        def timeout_body():
            nonlocal timeout_calls
            timeout_calls += 1

        try:
            db.transaction(timeout_body, {"timeoutMs": 500, "retry": 0})
        except OrmError as error:
            timeout_error = error
        if item[0] == "postgres":
            expect_equal(
                timeout_error, None, "PostgreSQL supports transaction timeoutMs"
            )
            expect_equal(timeout_calls, 1, "PostgreSQL timeout callback ran")
        else:
            expect_equal(
                getattr(timeout_error, "code", None),
                codes.CAPABILITY_UNSUPPORTED,
                "timeoutMs unsupported driver",
            )
            expect_equal(
                timeout_calls, 0, "unsupported timeout fails before the callback"
            )

        if item[0] == "postgres":
            models.CompositeAccount().connect(db).set_tenant_id(TENANT).set_account_id(
                6
            ).set_name("before timeout").create()
            holder = models.connect(
                item[1], aesKey="bench-salt", blindIndexKey="bench-blind-index"
            )
            row_locked = threading.Event()
            release_holder = threading.Event()
            holder_errors = []

            def hold_row_lock():
                def body():
                    try:
                        models.CompositeAccount().connect(holder).tenant_id(
                            TENANT
                        ).for_update().get()
                    except Exception as error:
                        holder_errors.append(error)
                        row_locked.set()
                        raise
                    row_locked.set()
                    release_holder.wait()

                holder.transaction(body, {"retry": 0})

            thread = threading.Thread(target=hold_row_lock)
            thread.start()
            if not row_locked.wait(10):
                release_holder.set()
                thread.join()
                raise AssertionError("the row-lock holder did not acquire its lock")
            if holder_errors:
                release_holder.set()
                thread.join()
                raise holder_errors[0]
            locked_timeout = None
            try:
                db.transaction(
                    lambda: (
                        models.CompositeAccount()
                        .connect(db)
                        .get_by_tenant_id_and_account_id(TENANT, 6)
                        .set_name("timed out")
                        .update()
                    ),
                    {"timeoutMs": 250, "retry": 0},
                )
            except OrmError as error:
                locked_timeout = error
            finally:
                release_holder.set()
                thread.join()
                holder.close()
            expect_equal(
                getattr(locked_timeout, "code", None),
                codes.CANCELED,
                "locked statement timeout",
            )
            timed_row = (
                models.CompositeAccount()
                .connect(db)
                .get_by_tenant_id_and_account_id(TENANT, 6)
            )
            expect_equal(
                timed_row.get_name(), "before timeout", "timed out update rolled back"
            )
            timed_row.delete()

        attempts = 0

        def retrying():
            nonlocal attempts
            attempts += 1
            models.CompositeAccount().set_tenant_id(TENANT).set_account_id(5).set_name(
                f"attempt-{attempts}"
            ).create()
            if attempts < 3:
                raise OrmError(codes.DEADLOCK, "coverage retry")

        db.transaction(
            retrying,
            {"isolation": "read_committed", "retry": 3},
        )
        expect_equal(attempts, 3, "retry reruns the complete callback")
        final_attempt = (
            models.CompositeAccount()
            .connect(db)
            .get_by_tenant_id_and_account_id(TENANT, 5)
        )
        expect_equal(
            final_attempt.get_name(),
            "attempt-3",
            "the final callback attempt committed",
        )
        final_attempt.delete()

        default_attempts = 0

        def default_retrying():
            nonlocal default_attempts
            default_attempts += 1
            if default_attempts < 3:
                raise OrmError(codes.DEADLOCK, "default coverage retry")

        db.transaction(default_retrying)
        expect_equal(default_attempts, 3, "default retry count is three")

        attempts = 0

        def no_retry():
            nonlocal attempts
            attempts += 1
            raise OrmError(codes.DEADLOCK, "coverage retry disabled")

        retry_error = None
        try:
            db.transaction(no_retry, {"retry": 0})
        except OrmError as error:
            retry_error = error
        expect_equal(
            getattr(retry_error, "code", None),
            codes.DEADLOCK,
            "retry=0 returns the deadlock",
        )
        expect_equal(attempts, 1, "retry=0 invokes the callback once")

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
    # Requirements: DSL-118, INT-45, INT-67, PLN-13, PLN-16, PLN-20, PLN-44.
    def test_transaction_rollback(self):
        self.each_item("transaction_rollback", transaction_rollback)

    # Requirements: DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-47, INT-48, PLN-17, PLN-21, PLN-24, PLN-44.
    def test_transaction_savepoint(self):
        self.each_item("transaction_savepoint", transaction_savepoint)

    # Requirements: CFG-9, INT-67.
    def test_handle_abandoned_query(self):
        self.each_item("handle_abandoned_query", handle_abandoned_query)


if __name__ == "__main__":
    coverage_main(CoverageTest)
