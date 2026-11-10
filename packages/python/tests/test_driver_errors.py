# Driver errors are ORM errors: a condition of the error catalog has its code, every other driver
# error is DRIVER, and each keeps the driver message and the driver error as its cause
# (docs/spec/protocol.md "Errors", packages/ts/src/driver.ts driverError, packages/php/src/Orm.php
# OrmException::fromDriver). The SQLite cases run statements on a database file; the MySQL and
# PostgreSQL cases run the statement path of the connection on the error values of PyMySQL and
# psycopg without a server.
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import psycopg
import pymysql
from polyspec.orm.database import (
    MYSQL_SET_NAMES,
    Db,
    Subscription,
    _lock_error,
    _MysqlConnection,
    _PostgresConnection,
    _sqlite_code,
    _mysql_statement_timeout,
    parse_dsn,
)
from polyspec.orm.errors import OrmError

from . import testcase
from .test_sqlite import generate_document, installed_sqlite

DOCUMENT = """dbspec 1 refusal

table parent {
  seq i64 identity
  name varchar(32)
  amount i32
  primary key (seq)
  unique uq_parent_name (name)
  check ck_parent_amount (amount > 0)
}

table child {
  seq i64 identity
  parent_seq i64
  primary key (seq)
  index ix_child_parent (parent_seq)
  foreign key fk_child_parent (parent_seq) references parent (seq) on delete restrict on update restrict
}
"""


class SqliteDriverErrorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-driver-errors-")
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        schema = Path(tmp.name) / "refusal.dbs"
        schema.write_text(DOCUMENT, encoding="utf-8")
        cls.models = generate_document(os.path.join(tmp.name, "models"), schema)

    def setUp(self):
        self.path = os.path.join(self.dir, f"{self._testMethodName}.sqlite3")
        self.db = installed_sqlite(self, self.path, self.models)
        self.events = []
        self.db.subscribe(self.events.append)

    def parent(self, name: str, amount: int = 1):
        return self.models.Parent().connect(self.db).set_name(name).set_amount(amount)

    def assert_driver_error(self, run, code: str, message: str):
        with self.assertRaises(OrmError) as caught:
            run()
        error = caught.exception
        self.assertEqual(error.code, code, str(error))
        self.assertIsInstance(error.cause, sqlite3.Error)
        self.assertEqual(str(error), f"{code}: sqlite: {message}")
        # The driver text comes first, and the name of the extended result code ends it (INT-154).
        self.assertTrue(
            str(error).startswith(f"{code}: sqlite: {error.cause} ("), str(error)
        )
        # The event of a failed statement carries the ORM error that the caller receives.
        failed = [event.error for event in self.events if event.error is not None]
        self.assertEqual(len(failed), 1)
        self.assertIs(failed[0], error)

    def test_a_missing_parent_row_is_foreign_key(self):
        self.assert_driver_error(
            lambda: self.models.Child().connect(self.db).set_parent_seq(99).create(),
            "FOREIGN_KEY",
            "FOREIGN KEY constraint failed (SQLITE_CONSTRAINT_FOREIGNKEY)",
        )

    def test_a_restricted_delete_is_foreign_key(self):
        created = self.parent("kept").create()
        self.models.Child().connect(self.db).set_parent_seq(created.get_seq()).create()
        self.assert_driver_error(
            lambda: created.delete(),
            "FOREIGN_KEY",
            "FOREIGN KEY constraint failed (SQLITE_CONSTRAINT_TRIGGER)",
        )

    def test_a_check_violation_is_constraint(self):
        self.assert_driver_error(
            lambda: self.parent("zero", 0).create(),
            "CONSTRAINT",
            "CHECK constraint failed: ck_parent_amount (SQLITE_CONSTRAINT_CHECK)",
        )

    def test_a_write_in_a_read_only_transaction_is_read_only(self):
        self.assert_driver_error(
            lambda: self.db.transaction(
                lambda: self.parent("ro").create(), {"readOnly": True, "retry": 0}
            ),
            "READ_ONLY",
            "attempt to write a readonly database (SQLITE_READONLY)",
        )

    def test_a_write_that_a_trigger_refuses_is_driver(self):
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                "CREATE TRIGGER parent_refuse BEFORE INSERT ON parent WHEN NEW.name = 'refused' "
                "BEGIN SELECT RAISE(ABORT, 'parent refused'); END"
            )
        conn.close()
        self.assert_driver_error(
            lambda: self.parent("refused").create(),
            "DRIVER",
            "parent refused (SQLITE_CONSTRAINT_TRIGGER)",
        )

    def test_a_busy_nowait_row_lock_is_lock_not_available(self):
        self.db.close()
        self.db = Db.connect_schema(
            f"sqlite://{self.path}?_pragma=busy_timeout(0)", self.models.SCHEMA
        )
        self.addCleanup(self.db.close)
        holder = sqlite3.connect(self.path, isolation_level=None)
        try:
            holder.execute("BEGIN IMMEDIATE")
            with self.assertRaises(OrmError) as caught:
                self.parent("busy").create()
        finally:
            holder.execute("ROLLBACK")
            holder.close()
        busy = caught.exception
        self.assertEqual(busy.code, "CANCELED")

        class Frame:
            """Transaction frame that fails only row lock statements with a busy error. run
            Takes the same arguments as TxFrame.run, and checks, for a statement on a row lock table,
            that it does not consume the fault (protocol 3.2), using faultable."""

            def run(
                self,
                sql,
                values=None,
                kind="utility",
                binds=None,
                tables=(),
                faultable=True,
            ):
                if faultable:
                    raise AssertionError(
                        f"the row lock statement consumes the statement fault: {sql}"
                    )
                if sql.startswith("INSERT"):
                    raise busy
                return {"rows": [[0]]}

        with self.assertRaises(OrmError) as caught:
            self.db.row_lock(Frame(), "update_nowait")
        self.assertEqual(
            caught.exception.code, "LOCK_NOT_AVAILABLE", str(caught.exception)
        )
        self.assertIs(caught.exception.cause, busy.cause)
        self.assertEqual(str(caught.exception), f"LOCK_NOT_AVAILABLE: {busy}")


class _Cursor:
    def __init__(self, error):
        self.error = error

    def execute(self, *_):
        raise self.error

    def close(self):
        pass


class _Connection:
    """Driver connection that throws the given error on every execute."""

    def __init__(self, error, closed=False):
        self.error = error
        self.closed = closed

    def cursor(self):
        return _Cursor(self.error)


class _RecordingCursor:
    def __init__(self, sent, version):
        self.sent = sent
        self.version = version
        self.rows = []
        self.lastrowid = None
        self.rowcount = 0

    def execute(self, sql, *_):
        self.sent.append(sql)
        self.rows = [(self.version,)] if sql == "SELECT VERSION()" else []

    def fetchall(self):
        return self.rows

    def close(self):
        pass


class _RecordingConnection:
    """Driver connection that records each statement and answers SELECT VERSION() with version."""

    def __init__(self, sent, version):
        self.sent = sent
        self.version = version

    def cursor(self):
        return _RecordingCursor(self.sent, self.version)


def mysql_error(cls, number: int, message: str):
    return cls(number, message)


def postgres_error(sqlstate: str, message: str):
    return psycopg.errors.lookup(sqlstate)(message)


class ServerDriverErrorTest(unittest.TestCase):
    """The statement path of the MySQL and PostgreSQL connections maps driver errors to the same table."""

    MYSQL = (
        (
            pymysql.err.IntegrityError,
            1062,
            "Duplicate entry 'a' for key 'parent.uq_parent_name'",
            "DUPLICATE_KEY",
        ),
        (
            pymysql.err.IntegrityError,
            1451,
            "Cannot delete or update a parent row",
            "FOREIGN_KEY",
        ),
        (
            pymysql.err.IntegrityError,
            1452,
            "Cannot add or update a child row",
            "FOREIGN_KEY",
        ),
        (
            pymysql.err.OperationalError,
            3819,
            "Check constraint 'ck_parent_amount' is violated.",
            "CONSTRAINT",
        ),
        (
            pymysql.err.OperationalError,
            1213,
            "Deadlock found when trying to get lock",
            "DEADLOCK",
        ),
        (
            pymysql.err.OperationalError,
            3572,
            "Statement aborted because lock(s) could not be acquired",
            "LOCK_NOT_AVAILABLE",
        ),
        (
            pymysql.err.OperationalError,
            1317,
            "Query execution was interrupted",
            "CANCELED",
        ),
        (
            pymysql.err.OperationalError,
            3024,
            "Query execution was interrupted, maximum statement execution time exceeded",
            "CANCELED",
        ),
        (
            pymysql.err.OperationalError,
            1205,
            "Lock wait timeout exceeded; try restarting transaction",
            "CANCELED",
        ),
        (
            pymysql.err.InternalError,
            1290,
            "The MySQL server is running with the --read-only option",
            "READ_ONLY",
        ),
        (
            pymysql.err.InternalError,
            1792,
            "Cannot execute statement in a READ ONLY transaction.",
            "READ_ONLY",
        ),
        (
            pymysql.err.OperationalError,
            2006,
            "MySQL server has gone away",
            "CONNECTION_LOST",
        ),
        (
            pymysql.err.OperationalError,
            2013,
            "Lost connection to MySQL server during query",
            "CONNECTION_LOST",
        ),
        (
            pymysql.err.OperationalError,
            4031,
            "The client was disconnected by the server because of inactivity.",
            "CONNECTION_LOST",
        ),
        (pymysql.err.OperationalError, 1644, "immutable row", "DRIVER"),
        (
            pymysql.err.ProgrammingError,
            1064,
            "You have an error in your SQL syntax",
            "DRIVER",
        ),
    )
    POSTGRES = (
        (
            "23505",
            'duplicate key value violates unique constraint "uq_parent_name"',
            "DUPLICATE_KEY",
        ),
        (
            "23503",
            'insert or update on table "child" violates foreign key constraint',
            "FOREIGN_KEY",
        ),
        (
            "23514",
            'new row for relation "parent" violates check constraint "ck_parent_amount"',
            "CONSTRAINT",
        ),
        ("40P01", "deadlock detected", "DEADLOCK"),
        ("40001", "could not serialize access due to concurrent update", "DEADLOCK"),
        (
            "55P03",
            'could not obtain lock on row in relation "parent"',
            "LOCK_NOT_AVAILABLE",
        ),
        ("57014", "canceling statement due to statement timeout", "CANCELED"),
        ("25006", "cannot execute INSERT in a read-only transaction", "READ_ONLY"),
        (
            "57P01",
            "terminating connection due to administrator command",
            "CONNECTION_LOST",
        ),
        ("08006", "connection failure", "CONNECTION_LOST"),
        ("P0001", "immutable row", "DRIVER"),
        ("42601", 'syntax error at or near "SELEC"', "DRIVER"),
    )

    def run_mysql(self, error, server="mysql"):
        connection = _MysqlConnection.__new__(_MysqlConnection)
        connection.connection = _Connection(error)
        connection.server = server
        with self.assertRaises(OrmError) as caught:
            connection.execute("INSERT INTO `parent` (`name`) VALUES (?)", ["a"])
        return caught.exception

    def run_postgres(self, error, closed=False):
        connection = _PostgresConnection.__new__(_PostgresConnection)
        connection.connection = _Connection(error, closed)
        with self.assertRaises(OrmError) as caught:
            connection.execute('INSERT INTO "parent" ("name") VALUES ($1)', ["a"])
        return caught.exception

    # Requirements: CFG-6, PRT-79.
    def test_mysql_errors_have_the_codes_of_the_catalog(self):
        for cls, number, message, code in self.MYSQL:
            with self.subTest(number=number):
                driver_error = mysql_error(cls, number, message)
                error = self.run_mysql(driver_error)
                self.assertEqual(error.code, code)
                self.assertIs(error.cause, driver_error)
                self.assertEqual(str(error), f"{code}: mysql: {message}")

    # Requirements: DIA-201. A mysql error number is read by the table of its server: MySQL's 4025 is an InnoDB option error
    # and MariaDB's a failed CHECK, and MySQL's 3572, 3819, 3024 and 4031 name no MariaDB condition.
    def test_a_mysql_error_number_is_read_by_the_table_of_its_server(self):
        for number, mysql, mariadb in [
            (4025, "DRIVER", "CONSTRAINT"),
            (3819, "CONSTRAINT", "DRIVER"),
            (3572, "LOCK_NOT_AVAILABLE", "DRIVER"),
            (3024, "CANCELED", "DRIVER"),
            (4031, "CONNECTION_LOST", "DRIVER"),
            (1969, "DRIVER", "CANCELED"),
            (1062, "DUPLICATE_KEY", "DUPLICATE_KEY"),
            (1452, "FOREIGN_KEY", "FOREIGN_KEY"),
            (1213, "DEADLOCK", "DEADLOCK"),
            (1290, "READ_ONLY", "READ_ONLY"),
            (1205, "CANCELED", "CANCELED"),
        ]:
            for server, code in (("mysql", mysql), ("mariadb", mariadb)):
                with self.subTest(number=number, server=server):
                    driver_error = mysql_error(
                        pymysql.err.OperationalError, number, "m"
                    )
                    self.assertEqual(self.run_mysql(driver_error, server).code, code)

    # Requirements: DIA-209. MariaDB fails a NOWAIT lock that it cannot take with 1205: the 1205 of a statement of a
    # *_nowait lock on MariaDB is LOCK_NOT_AVAILABLE, and the 1205 of any other statement, or of MySQL, stays CANCELED.
    def test_a_mariadb_lock_wait_of_a_nowait_lock_is_lock_not_available(self):
        for server, lock, number, code in [
            ("mariadb", "update_nowait", 1205, "LOCK_NOT_AVAILABLE"),
            ("mariadb", "share_nowait", 1205, "LOCK_NOT_AVAILABLE"),
            ("mariadb", "update", 1205, "CANCELED"),
            ("mariadb", "share", 1205, "CANCELED"),
            ("mariadb", "", 1205, "CANCELED"),
            ("mariadb", "update_nowait", 1317, "CANCELED"),
            ("mariadb", "update_nowait", 1969, "CANCELED"),
            ("mariadb", "update_nowait", 1213, "DEADLOCK"),
            ("mysql", "update_nowait", 1205, "CANCELED"),
            ("mysql", "share_nowait", 3572, "LOCK_NOT_AVAILABLE"),
        ]:
            with self.subTest(server=server, lock=lock, number=number):
                driver_error = mysql_error(pymysql.err.OperationalError, number, "m")
                error = _lock_error(self.run_mysql(driver_error, server), server, lock)
                self.assertEqual(error.code, code)
                self.assertIs(error.cause, driver_error)
                self.assertEqual(str(error), f"{code}: mysql: m")
        # An error that is no driver error is returned as it is.
        other = OrmError("CANCELED", "canceled")
        self.assertIs(_lock_error(other, "mariadb", "update_nowait"), other)

    # Requirements: DIA-208, CFG-6. The statement timeout takes the variable of the server: max_execution_time in
    # milliseconds on MySQL, max_statement_time in seconds with three fraction digits on MariaDB.
    def test_the_statement_timeout_takes_the_variable_of_the_server(self):
        for server, timeout_ms, setting in [
            ("mysql", 237, "SESSION max_execution_time = 237"),
            ("mysql", 1500, "SESSION max_execution_time = 1500"),
            ("mariadb", 237, "SESSION max_statement_time = 0.237"),
            ("mariadb", 5, "SESSION max_statement_time = 0.005"),
            ("mariadb", 1500, "SESSION max_statement_time = 1.500"),
            ("mariadb", 61000, "SESSION max_statement_time = 61.000"),
        ]:
            with self.subTest(server=server, timeout_ms=timeout_ms):
                self.assertEqual(_mysql_statement_timeout(server, timeout_ms), setting)
        with self.assertRaises(OrmError) as caught:
            _mysql_statement_timeout("postgres", 237)
        self.assertEqual(caught.exception.code, "INTERNAL")

    # Requirements: DIA-208, DIA-201. A connection reads its server, then sets the timeout of that server in its session
    # statement, before any statement of the caller; a connection without a timeout sets none.
    def test_a_mysql_connection_sets_the_timeout_of_its_server_when_it_connects(self):
        for version, timeout_ms, setting in [
            ("8.4.3", 237, ", SESSION max_execution_time = 237"),
            ("11.8.2-MariaDB", 237, ", SESSION max_statement_time = 0.237"),
            ("11.8.2-MariaDB", 0, ""),
        ]:
            with self.subTest(version=version, timeout_ms=timeout_ms):
                sent = []
                with patch.object(
                    pymysql, "connect", return_value=_RecordingConnection(sent, version)
                ):
                    connection = _MysqlConnection(
                        parse_dsn("mysql://root@127.0.0.1:3306/orm_test"), timeout_ms
                    )
                self.assertEqual(
                    connection.server, "mariadb" if "MariaDB" in version else "mysql"
                )
                self.assertEqual(len(sent), 3)
                self.assertEqual(sent[0], MYSQL_SET_NAMES)
                self.assertEqual(sent[1], "SELECT VERSION()")
                self.assertTrue(
                    sent[2].startswith("SET time_zone = '+00:00', sql_mode = ")
                )
                self.assertTrue(sent[2].endswith("'" + setting), sent[2])

    def test_a_statement_on_a_closed_mysql_connection_is_connection_lost(self):
        driver_error = pymysql.err.InterfaceError(0, "")
        error = self.run_mysql(driver_error)
        self.assertEqual(error.code, "CONNECTION_LOST")
        self.assertIs(error.cause, driver_error)

    def test_postgres_errors_have_the_codes_of_the_catalog(self):
        for sqlstate, message, code in self.POSTGRES:
            with self.subTest(sqlstate=sqlstate):
                driver_error = postgres_error(sqlstate, message)
                error = self.run_postgres(driver_error)
                self.assertEqual(error.code, code)
                self.assertIs(error.cause, driver_error)
                self.assertEqual(str(error), f"{code}: postgres: {message}")

    def test_a_postgres_error_of_a_broken_connection_is_connection_lost(self):
        driver_error = psycopg.OperationalError(
            "server closed the connection unexpectedly"
        )
        self.assertEqual(
            self.run_postgres(driver_error, closed=True).code, "CONNECTION_LOST"
        )
        self.assertEqual(self.run_postgres(driver_error, closed=False).code, "DRIVER")

    # Requirements: DIA-194, PRT-79.
    def test_subscription_cleanup_preserves_driver_failure_and_propagates_other_errors(
        self,
    ):
        notify_error = psycopg.OperationalError("listener connection was lost")

        class BrokenListener:
            closed = True

            def notifies(self, **_kwargs):
                raise notify_error

        class SubscriptionConnection:
            connection = BrokenListener()

            def __init__(self, cleanup_error):
                self.cleanup_error = cleanup_error

            def close(self):
                raise self.cleanup_error

        native_cleanup = psycopg.OperationalError("close also lost the connection")
        subscription = Subscription(SubscriptionConnection(native_cleanup))
        with self.assertRaises(OrmError) as mapped:
            subscription.receive()
        self.assertEqual(mapped.exception.code, "CONNECTION_LOST")
        self.assertIs(mapped.exception.cause, notify_error)
        self.assertIs(mapped.exception.__cause__, notify_error)
        self.assertEqual(
            mapped.exception.__notes__,
            [
                "closing the lost LISTEN connection also failed: close also lost the connection"
            ],
        )

        unexpected_cleanup = RuntimeError("unexpected listener cleanup failure")
        subscription = Subscription(SubscriptionConnection(unexpected_cleanup))
        with self.assertRaises(RuntimeError) as propagated:
            subscription.receive()
        self.assertIs(propagated.exception, unexpected_cleanup)


class SqliteLockedClassifierTest(unittest.TestCase):
    # Requirements: PLN-24.
    def test_sqlite_locked_is_driver_not_deadlock(self):
        for number in (6, 262):
            error = sqlite3.Error("database table is locked")
            error.sqlite_errorcode = number
            self.assertEqual(_sqlite_code(error), "DRIVER", f"SQLITE_LOCKED {number}")


if __name__ == "__main__":
    testcase.main()
