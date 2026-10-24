"""CFG-9: an asyncio Future cancels the active SQLite statement of its handle."""

import asyncio
import os
import tempfile
import threading
import unittest

from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError

from . import testcase


class QueryCancelTest(unittest.IsolatedAsyncioTestCase):
    deadline = testcase.COMPUTE

    async def test_cancel_interrupts_active_statement_and_root_is_reusable(self):
        with tempfile.TemporaryDirectory(prefix="orm-query-cancel-") as directory:
            db = Db(
                f"sqlite:///{os.path.join(directory, 'cancel.sqlite3')}",
                {"poolSize": 1},
            )
            self.addCleanup(db.close)
            connection = db._shared.pool._idle[0]
            entered = threading.Event()
            resume = threading.Event()

            def progress():
                entered.set()
                resume.wait()
                return 0

            loop = asyncio.get_running_loop()
            connection.connection.set_progress_handler(progress, 100)
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
            finally:
                resume.set()
            with self.assertRaises(OrmError) as raised:
                await task
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
