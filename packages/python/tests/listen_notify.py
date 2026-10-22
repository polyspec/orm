# LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
# with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
# channel; a receive whose deadline expires raises CANCELED; and MySQL and SQLite refuse notify and listen with
# CAPABILITY_UNSUPPORTED before any statement runs. Each case runs in a case database of its own (case_database.py),
# created through ORM_TEST_POSTGRES_DSN or ORM_TEST_MYSQL_DSN; the test fails when either is unset.
# Usage: packages/python/.venv/bin/python -m unittest packages.python.tests.listen_notify
import tempfile
import unittest

from polyspec.orm import Db, OrmError

from .case_database import case_database


class ListenNotifyTest(unittest.TestCase):
    # Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.
    def test_listen_notify(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with case_database("postgres", directory, "orm_listen") as dsn:
                db = Db.connect(dsn)
                try:
                    subscription = db.listen("t229_events")
                    db.transaction(lambda: db.notify("t229_events", "committed"))
                    first = subscription.receive()
                    self.assertEqual(("t229_events", "committed"), (first.channel, first.payload))

                    def fail_after_notify() -> None:
                        db.notify("t229_events", "rolled back")
                        raise RuntimeError("roll back")

                    with self.assertRaises(RuntimeError):
                        db.transaction(fail_after_notify)
                    db.notify("t229_events", "outside")
                    second = subscription.receive()
                    self.assertEqual("outside", second.payload, "the rolled back notification must not arrive")

                    subscription.unlisten("t229_events")
                    db.notify("t229_events", "after unlisten")
                    subscription.close()

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
                        self.assertEqual("CAPABILITY_UNSUPPORTED", notify.exception.code, dialect)
                        with self.assertRaises(OrmError) as listen:
                            db.listen("t229_events")
                        self.assertEqual("CAPABILITY_UNSUPPORTED", listen.exception.code, dialect)
                    finally:
                        db.close()
