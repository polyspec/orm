# A transaction or savepoint whose callback fails and whose rollback fails too, on SQLite, MySQL and PostgreSQL, with the
# fixture contracts/fixtures/rollback.dbs, as packages/ts/tests/rollback.mjs and packages/go/orm/rollback_test.go run
# them. The client raises one OrmError with the code ROLLBACK and the message `transaction failed (<cause>) and rollback
# failed (<rollback error>)` that keeps the callback error as its cause and the rollback error as its rollback. The
# callback runs only model calls. On SQLite a trigger that the test creates raises ROLLBACK when a row labeled `end` is
# inserted, which ends the transaction, so the client's ROLLBACK finds no transaction. On MySQL and PostgreSQL a test
# connection ends the server session that holds the transaction, so the next statement and the rollback fail with
# CONNECTION_LOST (docs/spec/config.md CFG-15); that connection reaches the server through ORM_TEST_MYSQL_SERVER_DSN or
# ORM_TEST_POSTGRES_SERVER_DSN, not through a pooler, which may handle a KILL on its own. Each case runs on a case
# database of its own; a missing variable fails the case.
# Requirements: CFG-15.
# Usage: python -m packages.python.tests.rollback
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
from polyspec.orm.database import Db

from . import testcase
from .case_database import case_database
from .runner_connect import mysql_connect
from .server_database import with_database
from .test_rollback_fault import check_rollback
from .test_sqlite import generate_document

ROOT = Path(__file__).resolve().parents[3]
TEMP = {}
END_TRIGGER = (
    "CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' "
    "BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END"
)


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-rollback-")
    TEMP["models"] = generate_document(
        os.path.join(TEMP["dir"].name, "models"),
        ROOT / "contracts" / "fixtures" / "rollback.dbs",
    )


def tearDownModule():
    TEMP["dir"].cleanup()


def server_dsn(dialect: str, dsn: str) -> str:
    """The DSN of the case database dsn on the server itself, ORM_TEST_<DIALECT>_SERVER_DSN with the case database."""
    variable = f"ORM_TEST_{dialect.upper()}_SERVER_DSN"
    server = os.environ.get(variable)
    if not server:
        raise AssertionError(
            f"{variable} is required; database tests never skip; run the test through its make target, which reads the "
            f"environment of make orm-test-servers"
        )
    return with_database(server, urlsplit(dsn).path.lstrip("/"))


def end_session(dialect: str, dsn: str) -> None:
    """Ends the server session that holds a lock on rollback_probe in the case database of dsn; SQLite needs none, its
    trigger ends the transaction."""
    if dialect == "sqlite":
        return
    session = server_dsn(dialect, dsn)
    if dialect == "postgres":
        with psycopg.connect(session, autocommit=True) as conn:
            row = conn.execute(
                "SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = "
                "(SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' "
                "AND l.pid <> pg_backend_pid() LIMIT 1"
            ).fetchone()
            if row is None:
                raise AssertionError("no session holds a lock on rollback_probe")
            conn.execute("SELECT pg_terminate_backend(%s, 5000)", (row[0],))
        return
    conn = mysql_connect(session, urlsplit(session).path.lstrip("/"))
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t "
                "ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' "
                "LIMIT 1"
            )
            row = cursor.fetchone()
            if row is None:
                raise AssertionError("no session holds a lock on rollback_probe")
            cursor.execute(f"KILL {int(row[0])}")
    finally:
        conn.close()


class RollbackTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def run_case(self, dialect: str, body) -> None:
        """Runs body(db, dsn) on a Db with the fixture installed in a new case database of dialect."""
        models = TEMP["models"]
        with case_database(dialect, TEMP["dir"].name, "orm_rollback") as dsn:
            db = Db.connect_schema(dsn, models.SCHEMA)
            try:
                db.utils().schema().install(models.SCHEMA)
                if dialect == "sqlite":
                    with sqlite3.connect(urlsplit(dsn).path) as raw:
                        raw.execute(END_TRIGGER)
                    raw.close()
                body(db, dsn)
            finally:
                db.close()

    def probe(self, db, label: str):
        return TEMP["models"].RollbackProbe().connect(db).set_label(label)

    def count(self, db) -> int:
        return TEMP["models"].RollbackProbe().connect(db).get_count()

    def raised(self, run):
        try:
            run()
        except BaseException as error:  # noqa: BLE001 - the probe returns any exception the run raises
            return error
        return None

    def check_rollback(self, error, subject: str):
        check_rollback(self, error, subject)

    def rollback_failed(self, dialect: str) -> None:
        """The callback of a transaction fails and the rollback fails."""

        def body(db, dsn):
            def ended():
                self.probe(db, "kept").create()
                end_session(dialect, dsn)
                self.probe(db, "end").create()

            error = self.raised(lambda: db.transaction(ended, {"retry": 0}))
            self.check_rollback(error, "transaction")
            if dialect == "sqlite":
                self.assertIn("rollback probe ended the transaction", str(error.cause))
                self.assertEqual(
                    self.count(db),
                    0,
                    "the trigger rolled the transaction back and the connection serves later requests",
                )
                return
            # The next statement and the rollback on a session the server ended are connection-lost errors.
            self.assertEqual(
                getattr(error.cause, "code", None),
                "CONNECTION_LOST",
                f"the callback error: {error.cause}",
            )
            self.assertEqual(
                getattr(error.rollback, "code", None),
                "CONNECTION_LOST",
                f"the rollback error: {error.rollback}",
            )

        self.run_case(dialect, body)

    def savepoint_rollback_failed(self, dialect: str) -> None:
        """The callback of a savepoint fails and the savepoint rollback fails, and then the transaction rollback fails."""

        def body(db, dsn):
            def nested():
                self.probe(db, "nested").create()
                end_session(dialect, dsn)
                self.probe(db, "end").create()

            def outer():
                self.probe(db, "kept").create()
                db.transaction(nested)

            error = self.raised(lambda: db.transaction(outer, {"retry": 0}))
            self.check_rollback(error, "transaction")
            self.check_rollback(error.cause, "savepoint")
            if dialect == "sqlite":
                self.assertIn(
                    "rollback probe ended the transaction", str(error.cause.cause)
                )
                self.assertEqual(
                    self.count(db),
                    0,
                    "the trigger rolled the transaction back and the connection serves later requests",
                )

        self.run_case(dialect, body)

    def test_rollback_failed_sqlite(self):
        self.rollback_failed("sqlite")

    def test_rollback_failed_mysql(self):
        self.rollback_failed("mysql")

    def test_rollback_failed_postgres(self):
        self.rollback_failed("postgres")

    def test_savepoint_rollback_failed_sqlite(self):
        self.savepoint_rollback_failed("sqlite")

    def test_savepoint_rollback_failed_mysql(self):
        self.savepoint_rollback_failed("mysql")

    def test_savepoint_rollback_failed_postgres(self):
        self.savepoint_rollback_failed("postgres")


if __name__ == "__main__":
    testcase.main()
