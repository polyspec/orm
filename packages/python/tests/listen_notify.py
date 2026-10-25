# LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
# with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
# channel; a receive whose deadline expires raises CANCELED; and MySQL and SQLite refuse notify and listen with
# CAPABILITY_UNSUPPORTED before any statement runs. Each case runs in a case database of its own (case_database.py),
# created through ORM_TEST_POSTGRES_DSN or ORM_TEST_MYSQL_DSN; the test fails when either is unset.
# Usage: packages/python/.venv/bin/python -m unittest packages.python.tests.listen_notify
import os
import tempfile
import unittest
from urllib.parse import urlsplit

import psycopg

from polyspec.orm import Db, OrmError

from .case_database import case_database
from .server_database import with_database


class ListenNotifyTest(unittest.TestCase):
    # Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.
    def test_listen_notify(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with case_database("postgres", directory, "orm_listen") as dsn:
                db = Db.connect(dsn)
                try:
                    subscription = db.listen("t229_events")
                    for channel in ("", "x" * 64, "é" * 32, "bad\x00channel"):
                        with self.assertRaises(OrmError) as notify_error:
                            db.notify(channel, "invalid channel")
                        self.assertEqual("CONFIG", notify_error.exception.code)
                        with self.assertRaises(OrmError) as listen_error:
                            db.listen(channel)
                        self.assertEqual("CONFIG", listen_error.exception.code)
                    db.notify("é" * 31, "valid 62-byte channel")
                    for payload in (
                        "x" * 8000,
                        "x" * 8001,
                        "é" * 4000,
                        "é" * 4001,
                        "bad\x00payload",
                    ):
                        with self.assertRaises(OrmError) as notify_error:
                            db.notify("t229_events", payload)
                        self.assertEqual("DRIVER", notify_error.exception.code)
                    boundary = "x" * 7999
                    db.transaction(lambda: db.notify("t229_events", "committed"))
                    first = subscription.receive()
                    self.assertEqual(
                        ("t229_events", "committed"), (first.channel, first.payload)
                    )
                    db.notify("t229_events", boundary)
                    self.assertEqual(boundary, subscription.receive().payload)
                    for payload in ("buffer-1", "buffer-2", "buffer-3"):
                        db.notify("t229_events", payload)
                    self.assertEqual(
                        ["buffer-1", "buffer-2", "buffer-3"],
                        [subscription.receive().payload for _ in range(3)],
                        "notifications waiting in the connection retain arrival order",
                    )

                    def fail_after_notify() -> None:
                        db.notify("t229_events", "rolled back")
                        raise RuntimeError("roll back")

                    with self.assertRaises(RuntimeError):
                        db.transaction(fail_after_notify)
                    db.notify("t229_events", "outside")
                    second = subscription.receive()
                    self.assertEqual(
                        "outside",
                        second.payload,
                        "the rolled back notification must not arrive",
                    )

                    subscription.unlisten("t229_events")
                    db.notify("t229_events", "after unlisten")
                    with self.assertRaises(OrmError) as no_delivery:
                        subscription.receive(0.05)
                    self.assertEqual("CANCELED", no_delivery.exception.code)
                    with self.assertRaises(OrmError) as closed:
                        subscription.receive(0.05)
                    self.assertEqual("CONFIG", closed.exception.code)
                    subscription.close()

                    lost_db = Db.connect(dsn)
                    lost = lost_db.listen("t229_connection_lost")
                    lost_db.close()
                    server = os.environ.get("ORM_TEST_POSTGRES_SERVER_DSN")
                    self.assertIsNotNone(
                        server, "ORM_TEST_POSTGRES_SERVER_DSN is required"
                    )
                    name = urlsplit(dsn).path.lstrip("/")
                    with psycopg.connect(
                        with_database(server, name), autocommit=True
                    ) as admin:
                        row = admin.execute(
                            "SELECT pid FROM pg_stat_activity WHERE datname = current_database() "
                            "AND pid <> pg_backend_pid() AND query = %s LIMIT 1",
                            ('LISTEN "t229_connection_lost"',),
                        ).fetchone()
                        self.assertIsNotNone(
                            row, "the listener backend is visible in pg_stat_activity"
                        )
                        terminated = admin.execute(
                            "SELECT pg_terminate_backend(%s, 5000)", (row[0],)
                        ).fetchone()[0]
                        self.assertTrue(
                            terminated, "the listener backend was terminated"
                        )
                    with self.assertRaises(OrmError) as lost_error:
                        lost.receive(5.0)
                    self.assertEqual("CONNECTION_LOST", lost_error.exception.code)
                    with self.assertRaises(OrmError) as closed_error:
                        lost.receive(0.05)
                    self.assertEqual("CONFIG", closed_error.exception.code)
                    lost.close()

                    waiting = db.listen("t229_cancel")
                    with self.assertRaises(OrmError) as raised:
                        waiting.receive(0.05)
                    self.assertEqual("CANCELED", raised.exception.code)
                    waiting.close()
                finally:
                    db.close()

            for dialect in ("sqlite", "mysql"):
                with case_database(dialect, directory, "orm_listen") as dsn:
                    db = Db.connect(dsn)
                    try:
                        with self.assertRaises(OrmError) as notify:
                            db.notify("t229_events", "x")
                        self.assertEqual(
                            "CAPABILITY_UNSUPPORTED", notify.exception.code, dialect
                        )
                        with self.assertRaises(OrmError) as listen:
                            db.listen("t229_events")
                        self.assertEqual(
                            "CAPABILITY_UNSUPPORTED", listen.exception.code, dialect
                        )
                    finally:
                        db.close()
