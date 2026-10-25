# The session state of a transaction ends with the transaction (docs/spec/config.md CFG-30), on SQLite, MySQL and
# PostgreSQL, as packages/ts/tests/session_state.mjs runs it. A transaction on a connection with one pooled connection
# takes the named lock of utils().lock, sets a local value with utils().set_local and commits. After it the same server
# session holds no value: PostgreSQL has no setting ormtest.session and MySQL no user variable orm.ormtest.session, which
# a statement on that one connection reads, and another connection takes the same lock. SQLite has no session setting,
# so it checks the lock alone. MySQL and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN; a missing
# variable fails the case.
# Requirements: CFG-30.
# Usage: python -m packages.python.tests.session_state
import os
import tempfile
import unittest
from urllib.parse import urlsplit

from polyspec.orm.database import Db

from . import testcase
from .case_database import case_database

TEMP = {}
LEFTOVER = {
    "postgres": "SELECT current_setting('ormtest.session', true)",
    "mysql": "SELECT @`orm.ormtest.session`",
}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-session-state-")


def tearDownModule():
    TEMP["dir"].cleanup()


class SessionStateTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def session_state_ends_with_transaction(self, dialect: str) -> None:
        with case_database(dialect, TEMP["dir"].name, "orm_session") as dsn:
            key = f"orm_test.session.{os.getpid()}"
            db = Db.connect(dsn, {"poolSize": 1})
            other = Db.connect(dsn)
            try:

                def first():
                    db.utils().lock(key)
                    db.utils().set_local("ormtest.session", "kept")
                    self.assertEqual(db.utils().local("ormtest.session"), "kept")

                db.transaction(first, {"retry": 0})
                leftover = LEFTOVER.get(urlsplit(dsn).scheme)
                if leftover is not None:
                    [[value]] = db.utils()._read("utility", [], leftover, [])
                    self.assertIn(
                        value,
                        (None, ""),
                        f"{dialect}: the session keeps the local value of the committed transaction",
                    )
                other.transaction(lambda: other.utils().lock(key), {"retry": 0})
            finally:
                other.close()
                db.close()

    def test_session_state_ends_with_transaction_sqlite(self):
        self.session_state_ends_with_transaction("sqlite")

    def test_session_state_ends_with_transaction_mysql(self):
        self.session_state_ends_with_transaction("mysql")

    def test_session_state_ends_with_transaction_postgres(self):
        self.session_state_ends_with_transaction("postgres")


if __name__ == "__main__":
    testcase.main()
