# Driver errors are ORM errors: a condition of the error catalog has its code, every other driver
# error is DRIVER, and each keeps the driver message and the driver error as its cause
# (docs/protocol.md "Errors", packages/orm-npm/src/driver.ts driverError, packages/orm-php/src/Orm.php
# OrmException::fromDriver). The SQLite cases run statements on a database file; the MySQL and
# PostgreSQL cases run the statement path of the connection on the error values of PyMySQL and
# psycopg without a server.
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import psycopg
import pymysql

from test_sqlite import generate

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from polyspec.orm.database import Db, _MysqlConnection, _PostgresConnection  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402

DOCUMENT = '''dbspec 1 refusal

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
'''


class SqliteDriverErrorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix='orm-driver-errors-')
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = tmp.name
        schema = Path(tmp.name) / 'refusal.dbs'
        schema.write_text(DOCUMENT, encoding='utf-8')
        cls.models = generate(os.path.join(tmp.name, 'models'), schema)

    def setUp(self):
        self.path = os.path.join(self.dir, f'{self._testMethodName}.sqlite3')
        self.db = Db.connect_schema(f'sqlite://{self.path}', self.models.SCHEMA)
        self.addCleanup(self.db.close)
        self.db.utils().schema().install(self.models.SCHEMA)
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
        self.assertEqual(str(error), f'{code}: sqlite: {message}')
        self.assertEqual(str(error), f'{code}: sqlite: {error.cause}')
        # 실패한 statement의 event는 caller가 받는 그 ORM 오류를 담는다.
        failed = [event.error for event in self.events if event.error is not None]
        self.assertEqual(len(failed), 1)
        self.assertIs(failed[0], error)

    def test_a_duplicate_unique_key_is_duplicate_key(self):
        self.parent('a').create()
        self.assert_driver_error(lambda: self.parent('a').create(), 'DUPLICATE_KEY',
                                 'UNIQUE constraint failed: parent.name')

    def test_a_missing_parent_row_is_foreign_key(self):
        self.assert_driver_error(
            lambda: self.models.Child().connect(self.db).set_parent_seq(99).create(),
            'FOREIGN_KEY', 'FOREIGN KEY constraint failed')

    def test_a_restricted_delete_is_foreign_key(self):
        created = self.parent('kept').create()
        self.models.Child().connect(self.db).set_parent_seq(created.get_seq()).create()
        self.assert_driver_error(
            lambda: created.delete(),
            'FOREIGN_KEY', 'FOREIGN KEY constraint failed')

    def test_a_check_violation_is_constraint(self):
        self.assert_driver_error(lambda: self.parent('zero', 0).create(), 'CONSTRAINT',
                                 'CHECK constraint failed: ck_parent_amount')

    def test_a_write_in_a_read_only_transaction_is_read_only(self):
        self.assert_driver_error(
            lambda: self.db.transaction(lambda: self.parent('ro').create(), {'readOnly': True, 'retry': 0}),
            'READ_ONLY', 'attempt to write a readonly database')

    def test_a_write_that_a_trigger_refuses_is_driver(self):
        with sqlite3.connect(self.path) as conn:
            conn.execute("CREATE TRIGGER parent_refuse BEFORE INSERT ON parent WHEN NEW.name = 'refused' "
                         "BEGIN SELECT RAISE(ABORT, 'parent refused'); END")
        conn.close()
        self.assert_driver_error(lambda: self.parent('refused').create(), 'DRIVER', 'parent refused')

    def test_a_lock_held_past_busy_timeout_is_canceled(self):
        self.db.close()
        self.db = Db.connect_schema(f'sqlite://{self.path}?_pragma=busy_timeout(0)', self.models.SCHEMA)
        self.events = []
        self.db.subscribe(self.events.append)
        holder = sqlite3.connect(self.path, isolation_level=None)
        try:
            holder.execute('BEGIN IMMEDIATE')
            self.assert_driver_error(lambda: self.parent('busy').create(), 'CANCELED', 'database is locked')
        finally:
            holder.execute('ROLLBACK')
            holder.close()

    def test_a_busy_nowait_row_lock_is_lock_not_available(self):
        self.db.close()
        self.db = Db.connect_schema(f'sqlite://{self.path}?_pragma=busy_timeout(0)', self.models.SCHEMA)
        holder = sqlite3.connect(self.path, isolation_level=None)
        try:
            holder.execute('BEGIN IMMEDIATE')
            with self.assertRaises(OrmError) as caught:
                self.parent('busy').create()
        finally:
            holder.execute('ROLLBACK')
            holder.close()
        busy = caught.exception
        self.assertEqual(busy.code, 'CANCELED')

        class Frame:
            """row lock statement만 busy 오류로 실패하는 transaction frame이다."""

            def run(self, sql, values=None, kind='utility', tables=()):
                if sql.startswith('INSERT'):
                    raise busy
                return {'rows': [[0]]}

        with self.assertRaises(OrmError) as caught:
            self.db.row_lock(Frame(), 'update_nowait')
        self.assertEqual(caught.exception.code, 'LOCK_NOT_AVAILABLE', str(caught.exception))
        self.assertIs(caught.exception.cause, busy.cause)
        self.assertEqual(str(caught.exception), f'LOCK_NOT_AVAILABLE: {busy}')


class _Cursor:
    def __init__(self, error):
        self.error = error

    def execute(self, *_):
        raise self.error

    def close(self):
        pass


class _Connection:
    """execute마다 주어진 오류를 던지는 driver 연결이다."""

    def __init__(self, error, closed=False):
        self.error = error
        self.closed = closed

    def cursor(self):
        return _Cursor(self.error)


def mysql_error(cls, number: int, message: str):
    return cls(number, message)


def postgres_error(sqlstate: str, message: str):
    return psycopg.errors.lookup(sqlstate)(message)


class ServerDriverErrorTest(unittest.TestCase):
    """MySQL과 PostgreSQL 연결의 statement 경로가 driver 오류를 같은 표로 바꾼다."""

    MYSQL = [
        (pymysql.err.IntegrityError, 1062, "Duplicate entry 'a' for key 'parent.uq_parent_name'", 'DUPLICATE_KEY'),
        (pymysql.err.IntegrityError, 1451, 'Cannot delete or update a parent row', 'FOREIGN_KEY'),
        (pymysql.err.IntegrityError, 1452, 'Cannot add or update a child row', 'FOREIGN_KEY'),
        (pymysql.err.OperationalError, 3819, "Check constraint 'ck_parent_amount' is violated.", 'CONSTRAINT'),
        (pymysql.err.OperationalError, 4025, 'CONSTRAINT `ck` failed', 'CONSTRAINT'),
        (pymysql.err.OperationalError, 1213, 'Deadlock found when trying to get lock', 'DEADLOCK'),
        (pymysql.err.OperationalError, 3572, 'Statement aborted because lock(s) could not be acquired', 'LOCK_NOT_AVAILABLE'),
        (pymysql.err.OperationalError, 1317, 'Query execution was interrupted', 'CANCELED'),
        (pymysql.err.OperationalError, 3024, 'Query execution was interrupted, maximum statement execution time exceeded', 'CANCELED'),
        (pymysql.err.InternalError, 1290, 'The MySQL server is running with the --read-only option', 'READ_ONLY'),
        (pymysql.err.InternalError, 1792, 'Cannot execute statement in a READ ONLY transaction.', 'READ_ONLY'),
        (pymysql.err.OperationalError, 2006, 'MySQL server has gone away', 'CONNECTION_LOST'),
        (pymysql.err.OperationalError, 2013, 'Lost connection to MySQL server during query', 'CONNECTION_LOST'),
        (pymysql.err.OperationalError, 4031, 'The client was disconnected by the server because of inactivity.', 'CONNECTION_LOST'),
        (pymysql.err.OperationalError, 1644, 'immutable row', 'DRIVER'),
        (pymysql.err.ProgrammingError, 1064, 'You have an error in your SQL syntax', 'DRIVER'),
    ]
    POSTGRES = [
        ('23505', 'duplicate key value violates unique constraint "uq_parent_name"', 'DUPLICATE_KEY'),
        ('23503', 'insert or update on table "child" violates foreign key constraint', 'FOREIGN_KEY'),
        ('23514', 'new row for relation "parent" violates check constraint "ck_parent_amount"', 'CONSTRAINT'),
        ('40P01', 'deadlock detected', 'DEADLOCK'),
        ('40001', 'could not serialize access due to concurrent update', 'DEADLOCK'),
        ('55P03', 'could not obtain lock on row in relation "parent"', 'LOCK_NOT_AVAILABLE'),
        ('57014', 'canceling statement due to statement timeout', 'CANCELED'),
        ('25006', 'cannot execute INSERT in a read-only transaction', 'READ_ONLY'),
        ('57P01', 'terminating connection due to administrator command', 'CONNECTION_LOST'),
        ('08006', 'connection failure', 'CONNECTION_LOST'),
        ('P0001', 'immutable row', 'DRIVER'),
        ('42601', 'syntax error at or near "SELEC"', 'DRIVER'),
    ]

    def run_mysql(self, error):
        connection = _MysqlConnection.__new__(_MysqlConnection)
        connection.connection = _Connection(error)
        with self.assertRaises(OrmError) as caught:
            connection.execute('INSERT INTO `parent` (`name`) VALUES (?)', ['a'])
        return caught.exception

    def run_postgres(self, error, closed=False):
        connection = _PostgresConnection.__new__(_PostgresConnection)
        connection.connection = _Connection(error, closed)
        with self.assertRaises(OrmError) as caught:
            connection.execute('INSERT INTO "parent" ("name") VALUES ($1)', ['a'])
        return caught.exception

    def test_mysql_errors_have_the_codes_of_the_catalog(self):
        for cls, number, message, code in self.MYSQL:
            with self.subTest(number=number):
                driver_error = mysql_error(cls, number, message)
                error = self.run_mysql(driver_error)
                self.assertEqual(error.code, code)
                self.assertIs(error.cause, driver_error)
                self.assertEqual(str(error), f'{code}: mysql: {message}')

    def test_a_statement_on_a_closed_mysql_connection_is_connection_lost(self):
        driver_error = pymysql.err.InterfaceError(0, '')
        error = self.run_mysql(driver_error)
        self.assertEqual(error.code, 'CONNECTION_LOST')
        self.assertIs(error.cause, driver_error)

    def test_postgres_errors_have_the_codes_of_the_catalog(self):
        for sqlstate, message, code in self.POSTGRES:
            with self.subTest(sqlstate=sqlstate):
                driver_error = postgres_error(sqlstate, message)
                error = self.run_postgres(driver_error)
                self.assertEqual(error.code, code)
                self.assertIs(error.cause, driver_error)
                self.assertEqual(str(error), f'{code}: postgres: {message}')

    def test_a_postgres_error_of_a_broken_connection_is_connection_lost(self):
        driver_error = psycopg.OperationalError('server closed the connection unexpectedly')
        self.assertEqual(self.run_postgres(driver_error, closed=True).code, 'CONNECTION_LOST')
        self.assertEqual(self.run_postgres(driver_error, closed=False).code, 'DRIVER')


if __name__ == '__main__':
    unittest.main()
