"""CFG-9: an asyncio Future cancels the active SQLite statement of its handle."""

import asyncio
import os
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from polyspec.orm.database import (
    Db,
    _ActiveStatement,
    _FutureCancellation,
    _MysqlConnection,
)
from polyspec.orm.errors import OrmError

from . import testcase


class QueryCancelTest(unittest.IsolatedAsyncioTestCase):
    deadline = testcase.COMPUTE

    async def test_cancel_state_is_observed_before_done_callback_dispatch(self):
        loop = asyncio.get_running_loop()
        admission_future = loop.create_future()
        admission = _FutureCancellation(admission_future)
        admission_future.cancel()
        with self.assertRaises(OrmError) as rejected:
            admission.start(object())
        self.assertEqual(rejected.exception.code, "CANCELED")

        class CancellationConnection:
            def __init__(self):
                self.requested = threading.Event()

            def cancel_query(self):
                self.requested.set()

        finish_future = loop.create_future()
        cancellation = _FutureCancellation(finish_future)
        connection = CancellationConnection()
        operation = _ActiveStatement(connection)
        with cancellation._lock:
            cancellation._active.add(operation)
        finish_future.cancel()
        self.assertTrue(cancellation.finish(operation))
        self.assertTrue(connection.requested.is_set())

    async def test_worker_observes_future_only_on_its_owner_loop(self):
        loop = asyncio.get_running_loop()
        owner_thread = threading.get_ident()

        class OwnerLoopFuture(asyncio.Future):
            def cancelled(self):
                if threading.get_ident() != owner_thread:
                    raise AssertionError(
                        "Future state was read outside its loop thread"
                    )
                return super().cancelled()

        future = OwnerLoopFuture(loop=loop)
        cancellation = _FutureCancellation(future)
        future.cancel()
        with self.assertRaises(OrmError) as rejected:
            await asyncio.to_thread(cancellation.start, object())
        self.assertEqual(rejected.exception.code, "CANCELED")

        finish_future = OwnerLoopFuture(loop=loop)
        finishing = _FutureCancellation(finish_future)

        class CancellationConnection:
            def __init__(self):
                self.requested = threading.Event()

            def cancel_query(self):
                self.requested.set()

        connection = CancellationConnection()
        operation = _ActiveStatement(connection)
        with finishing._lock:
            finishing._active.add(operation)
        finish_future.cancel()
        self.assertTrue(await asyncio.to_thread(finishing.finish, operation))
        self.assertTrue(connection.requested.is_set())

    async def test_mysql_cancellation_uses_bounded_control_socket_timeouts(self):
        calls = []
        statements = []

        class ControlCursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql):
                statements.append(sql)

        class ControlConnection:
            closed = False

            def cursor(self):
                return ControlCursor()

            def close(self):
                self.closed = True

        control = ControlConnection()

        def connect(**options):
            calls.append(options)
            return control

        class MysqlConnection:
            def thread_id(self):
                return 73

        mysql = object.__new__(_MysqlConnection)
        mysql._connect_options = {"host": "db.test", "user": "orm"}
        mysql.connection = MysqlConnection()
        with patch.dict(sys.modules, {"pymysql": SimpleNamespace(connect=connect)}):
            mysql.cancel_query()

        self.assertEqual(
            calls,
            [
                {
                    "host": "db.test",
                    "user": "orm",
                    "connect_timeout": 10,
                    "read_timeout": 10,
                    "write_timeout": 10,
                }
            ],
        )
        self.assertEqual(statements, ["KILL QUERY 73"])
        self.assertTrue(control.closed)

        timeout = TimeoutError("control connection timed out")

        def fail_connect(**_options):
            raise timeout

        with patch.dict(
            sys.modules,
            {
                "pymysql": SimpleNamespace(
                    connect=fail_connect,
                    MySQLError=type("MySQLError", (Exception,), {}),
                )
            },
        ):
            operation = _ActiveStatement(mysql)
            operation.cancel()
            operation.wait()
        self.assertIs(operation.error, timeout)

    async def test_cancel_interrupts_active_statement_and_root_is_reusable(self):
        with tempfile.TemporaryDirectory(prefix="orm-query-cancel-") as directory:
            db = Db(
                f"sqlite:///{os.path.join(directory, 'cancel.sqlite3')}",
                {"poolSize": 1},
            )
            self.addCleanup(db.close)
            entered = threading.Event()
            resume = threading.Event()

            def progress():
                entered.set()
                resume.wait()
                return 0

            loop = asyncio.get_running_loop()
            future = loop.create_future()
            handle = db.with_future(future)
            completed = loop.create_future()
            completed_handle = db.with_future(completed)
            callback_ran = asyncio.Event()
            completed.add_done_callback(lambda _: callback_ran.set())
            completed.set_result(None)
            await callback_ran.wait()
            completed_handle.execute(
                {"sql": "SELECT 1", "bind_slots": [], "tables": [], "assemble": None},
                [],
            )
            db._connection.execute(
                "CREATE TABLE cancellation_probe (value INTEGER)", []
            )
            step = {
                "sql": (
                    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL "
                    "SELECT x + 1 FROM n WHERE x < 1000000) SELECT sum(x) FROM n"
                ),
                "bind_slots": [],
                "tables": [],
                "assemble": None,
            }

            def transaction():
                db._connection.execute("INSERT INTO cancellation_probe VALUES (1)", [])
                physical = db.active_frame().connection
                physical.connection.set_progress_handler(progress, 100)
                try:
                    handle.execute(step, [])
                finally:
                    physical.connection.set_progress_handler(None, 0)

            task = asyncio.create_task(
                asyncio.to_thread(handle.transaction, transaction, {"retry": 0})
            )
            callback_ran = asyncio.Event()
            future.add_done_callback(lambda _: callback_ran.set())
            try:
                self.assertTrue(
                    await asyncio.to_thread(entered.wait, 10),
                    "SQLite query reached its progress callback",
                )
                future.cancel()
                await callback_ran.wait()
            except BaseException as primary_error:
                resume.set()
                cleanup_results = await asyncio.shield(
                    asyncio.gather(task, return_exceptions=True)
                )
                cleanup_result = cleanup_results[0]
                if isinstance(cleanup_result, BaseException):
                    primary_error.add_note(
                        f"SQLite worker cleanup also failed: {cleanup_result!r}"
                    )
                raise
            else:
                resume.set()
            with self.assertRaises(OrmError) as raised:
                await asyncio.shield(task)
            self.assertEqual(raised.exception.code, "CANCELED")
            self.assertIsNotNone(
                raised.exception.cause, "SQLite supplies the native interruption cause"
            )

            count = db._connection.execute(
                "SELECT count(*) FROM cancellation_probe", []
            )["rows"][0][0]
            self.assertEqual(
                count, 0, "cancelled transaction rolled back its earlier write"
            )
            self.assertEqual(db.stats().in_use, 0)
            with self.assertRaises(OrmError) as still_cancelled:
                await asyncio.to_thread(handle.execute, step, [])
            self.assertEqual(still_cancelled.exception.code, "CANCELED")


if __name__ == "__main__":
    testcase.main()
