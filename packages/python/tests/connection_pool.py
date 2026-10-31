# The connection pool of the Python client (docs/spec/config.md "Runtime connection"), as the Go, TypeScript and Rust clients
# keep one: poolSize bounds the open connections (10 when zero or unset), transactions of different threads run on
# connections of their own at the same time, a transaction that needs a connection while all of them are in use waits
# for one, poolIdleSize bounds the idle connections, poolLifetimeMs closes a connection whose lifetime passed, and a
# negative value or an idle size above the pool size is CONFIG. Each case runs on SQLite, MySQL and PostgreSQL; MySQL
# and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
# Usage: python -m packages.python.tests.connection_pool
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from urllib.parse import urlsplit

import psycopg
from psycopg.pq import ConnStatus
from polyspec.orm.errors import OrmError
from polyspec.orm.database import _MysqlConnection, _PostgresConnection
from .models import models
from polyspec.orm.database import _Pool, _PoolConfig

from . import testcase
from .bench_set import install_bench
from .case_database import case_database
from .runner_connect import mysql_connect
from .server_database import with_database

DIALECTS = ("sqlite", "mysql", "postgres")
TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-connection-pool-")


def tearDownModule():
    TEMP["dir"].cleanup()


def code_of(run):
    try:
        run()
    except OrmError as error:
        return error.code
    return None


def read_only(db, body):
    return db.transaction(body, {"readOnly": True, "retry": 0})


class ConnectionPoolTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def each(self, body):
        for dialect in DIALECTS:
            with (
                self.subTest(dialect=dialect),
                case_database(dialect, TEMP["dir"].name, "orm_pool") as dsn,
            ):
                setup = models.connect(dsn)
                install_bench(setup)
                setup.close()
                body(dialect, dsn)

    def test_idle_pool_discards_connection_that_fails_liveness_check(self):
        class Connection:
            def __init__(self, alive):
                self.alive = alive
                self.closed = False

            def is_alive(self):
                return self.alive

            def close(self):
                self.closed = True

        opened = []

        def open_connection():
            connection = Connection(True)
            opened.append(connection)
            return connection

        pool = _Pool(open_connection, _PoolConfig(1, 1, 0, 0))
        stale = pool.acquire()
        pool.release(stale)
        stale.alive = False

        replacement = pool.acquire()
        try:
            self.assertEqual(len(opened), 2, "one replacement connection was opened")
            self.assertTrue(stale.closed, "the dead idle connection was discarded")
            self.assertIs(replacement, opened[1], "the replacement was leased")
            self.assertEqual(pool.stats(), (1, 1, 0), "pool accounting")
        finally:
            pool.release(replacement)
            pool.close()

    def test_idle_pool_reuses_connection_that_passes_liveness_check(self):
        class Connection:
            def __init__(self):
                self.closed = False
                self.checks = 0

            def is_alive(self):
                self.checks += 1
                return True

            def close(self):
                self.closed = True

        opened = []

        def open_connection():
            connection = Connection()
            opened.append(connection)
            return connection

        pool = _Pool(open_connection, _PoolConfig(1, 1, 0, 0))
        original = pool.acquire()
        pool.release(original)
        reused = pool.acquire()
        try:
            self.assertIs(reused, original, "a healthy idle connection is reused")
            self.assertEqual(len(opened), 1, "no replacement was opened")
            self.assertEqual(original.checks, 1, "the idle connection was checked")
        finally:
            pool.release(reused)
            pool.close()

    def test_mysql_idle_liveness_uses_non_reconnecting_ping(self):
        class Connection:
            def __init__(self):
                self.reconnect = None

            def ping(self, reconnect=False):
                self.reconnect = reconnect

        connection = Connection()
        pooled = object.__new__(_MysqlConnection)
        pooled.connection = connection

        self.assertTrue(pooled.is_alive())
        self.assertIs(connection.reconnect, False, "ping never reconnects a session")

    def test_postgres_idle_liveness_syncs_pipeline_without_query(self):
        class Pipeline:
            def __init__(self, error):
                self.error = error

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                if self.error is not None:
                    raise self.error

        class Connection:
            closed = False

            def __init__(self, status, error=None):
                self.pgconn = SimpleNamespace(status=status)
                self.pipeline_calls = 0
                self.error = error

            def execute(self, *_args):
                raise AssertionError("liveness check must not execute SQL")

            def pipeline(self):
                self.pipeline_calls += 1
                return Pipeline(self.error)

        pooled = object.__new__(_PostgresConnection)
        pooled.connection = Connection(int(ConnStatus.OK))
        self.assertTrue(pooled.is_alive())
        self.assertEqual(pooled.connection.pipeline_calls, 1)

        pooled.connection = Connection(
            int(ConnStatus.BAD), psycopg.OperationalError("server ended idle session")
        )
        self.assertFalse(pooled.is_alive())

    # Requirements: CFG-4, CFG-5.
    def test_options(self):
        def body(dialect, dsn):
            db = models.connect(dsn)
            try:
                self.assertEqual(
                    db.stats().max_open_connections, 10, "the default pool size"
                )
            finally:
                db.close()
            db = models.connect(dsn, poolSize=3)
            try:
                self.assertEqual(db.stats().max_open_connections, 3, "poolSize")
            finally:
                db.close()
            for options in (
                {"poolSize": -1},
                {"poolIdleSize": -1},
                {"poolLifetimeMs": -1},
                {"poolSize": 2, "poolIdleSize": 3},
            ):
                self.assertEqual(
                    code_of(
                        lambda options=options: models.connect(dsn, **options).close()
                    ),
                    "CONFIG",
                    f"{options}",
                )

        self.each(body)

    def test_concurrent_transactions_and_the_limit(self):
        def body(dialect, dsn):
            db = models.connect(dsn, poolSize=2)
            try:
                first_in = threading.Event()
                first_out = threading.Event()
                order = []

                def holder():
                    def inside():
                        order.append("first begins")
                        first_in.set()
                        first_out.wait(10)
                        models.User().connect(db).get_count()
                        order.append("first ends")

                    read_only(db, inside)

                threads = [threading.Thread(target=holder)]
                threads[0].start()
                self.assertTrue(first_in.wait(10), "the first transaction began")
                # A second transaction runs on a connection of its own while the first one is open.
                read_only(db, lambda: models.User().connect(db).get_count())
                order.append("second ran")
                stats = db.stats()
                self.assertEqual(
                    (stats.open_connections, stats.in_use),
                    (2, 1),
                    "two open, the first in use",
                )
                second_in = threading.Event()
                second_out = threading.Event()

                def second_holder():
                    def inside():
                        second_in.set()
                        second_out.wait(10)

                    read_only(db, inside)

                threads.append(threading.Thread(target=second_holder))
                threads[1].start()
                self.assertTrue(second_in.wait(10), "the second holder began")
                self.assertEqual(db.stats().in_use, 2, "both connections in use")

                # A third transaction waits for a connection until the first one is released.
                def third():
                    read_only(db, lambda: models.User().connect(db).get_count())
                    order.append("third ran")

                threads.append(threading.Thread(target=third))
                threads[2].start()
                time.sleep(0.3)
                self.assertNotIn(
                    "third ran", order, "the third transaction waits for a connection"
                )
                first_out.set()
                threads[0].join(10)
                threads[2].join(10)
                second_out.set()
                threads[1].join(10)
                self.assertEqual(
                    order,
                    ["first begins", "second ran", "first ends", "third ran"],
                    "the order of the transactions",
                )
                self.assertLessEqual(
                    db.stats().open_connections,
                    2,
                    "the pool opened no more than its size",
                )
            finally:
                db.close()

        self.each(body)

    # Requirements: CFG-12. Each connection commits every write while writers share one SQLite file.
    def test_sqlite_concurrent_writers_commit_every_row(self):
        with tempfile.TemporaryDirectory(prefix="orm-sqlite-writers-") as directory:
            dsn = f"sqlite://{directory}/writers.sqlite3"
            setup = models.connect(dsn)
            install_bench(setup)
            setup.close()
            dbs = [models.connect(dsn) for _ in range(8)]

            def write(db, name):
                for index in range(10):

                    def body(iteration=index):
                        models.Service().connect(db).get_count()
                        models.Service().connect(db).set_name(
                            f"{name}-{iteration}"
                        ).create()

                    db.transaction(body, {"retry": 0})

            try:
                with ThreadPoolExecutor(max_workers=len(dbs)) as workers:
                    futures = [
                        workers.submit(write, db, f"connection-{index}")
                        for index, db in enumerate(dbs)
                    ]
                    for future in futures:
                        future.result()
                self.assertEqual(models.Service().connect(dbs[0]).get_count(), 80)
            finally:
                for db in dbs:
                    db.close()

    # Requirements: CFG-13. A separate connection sees committed rows, not the writer's pending insert.
    def test_sqlite_read_during_write_sees_only_committed_rows(self):
        with tempfile.TemporaryDirectory(
            prefix="orm-sqlite-read-during-write-"
        ) as directory:
            dsn = f"sqlite://{directory}/reads.sqlite3"
            setup = models.connect(dsn)
            install_bench(setup)
            setup.close()
            writer = models.connect(dsn)
            reader = models.connect(dsn)
            try:
                install_bench(writer)
                install_bench(reader)

                def body():
                    models.Service().connect(writer).set_name("pending").create()
                    self.assertEqual(models.Service().connect(reader).get_count(), 0)
                    count = reader.transaction(
                        lambda: models.Service().get_count(),
                        {"readOnly": True, "retry": 0},
                    )
                    self.assertEqual(count, 0)

                writer.transaction(body, {"retry": 0})
                self.assertEqual(models.Service().connect(reader).get_count(), 1)
            finally:
                reader.close()
                writer.close()

    def test_idle_size_and_lifetime(self):
        def body(dialect, dsn):
            db = models.connect(dsn, poolSize=3, poolIdleSize=1)
            try:
                barrier = threading.Barrier(3)

                def hold():
                    read_only(db, lambda: barrier.wait(10))

                threads = [threading.Thread(target=hold) for _ in range(3)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(10)
                stats = db.stats()
                self.assertEqual(
                    (stats.open_connections, stats.idle),
                    (1, 1),
                    "the idle connections kept",
                )
            finally:
                db.close()
            db = models.connect(dsn, poolSize=1, poolLifetimeMs=200)
            try:
                # The driver connection of a transaction; a pooler in front of the server reuses its server sessions,
                # so the session id of the server does not tell the client connections apart.
                def taken():
                    return db.transaction(
                        lambda: db.active_frame().connection, {"retry": 0}
                    )

                first = taken()
                self.assertIs(
                    taken(), first, "a connection within its lifetime is reused"
                )
                time.sleep(0.4)
                self.assertIsNot(
                    taken(), first, "a connection past its lifetime is closed"
                )
            finally:
                db.close()

        self.each(body)

    # Requirements: INT-92.
    def test_idle_server_end_discards_connection(self):
        for dialect in ("mysql", "postgres"):
            with (
                self.subTest(dialect=dialect),
                case_database(dialect, TEMP["dir"].name, "orm_idle_end") as dsn,
            ):
                db = models.connect(dsn, poolSize=1, poolIdleSize=1)
                try:
                    self.assertFalse(db.utils().schema().exists("orm"))
                    self.assertEqual(
                        db.stats().idle, 1, "the pool holds one idle connection"
                    )
                    server = os.environ.get(f"ORM_TEST_{dialect.upper()}_SERVER_DSN")
                    self.assertTrue(server, f"the {dialect} server DSN is required")
                    admin_dsn = with_database(server, urlsplit(dsn).path.lstrip("/"))

                    if dialect == "postgres":
                        with psycopg.connect(admin_dsn, autocommit=True) as admin:
                            rows = admin.execute(
                                "SELECT pid FROM pg_stat_activity WHERE datname = current_database() "
                                "AND pid <> pg_backend_pid()"
                            ).fetchall()
                            self.assertEqual(
                                len(rows), 1, "one idle client session is present"
                            )
                            ended = admin.execute(
                                "SELECT pg_terminate_backend(%s, 5000)", (rows[0][0],)
                            ).fetchone()[0]
                            self.assertTrue(ended, "the server ended the idle session")
                    else:
                        database = urlsplit(admin_dsn).path.lstrip("/")
                        with mysql_connect(admin_dsn, database) as admin:
                            with admin.cursor() as cursor:
                                cursor.execute(
                                    "SELECT ID FROM information_schema.PROCESSLIST "
                                    "WHERE DB = DATABASE() AND ID <> CONNECTION_ID()"
                                )
                                rows = cursor.fetchall()
                                self.assertEqual(
                                    len(rows), 1, "one idle client session is present"
                                )
                                session_id = int(rows[0][0])
                                cursor.execute(f"KILL {session_id}")
                                deadline = time.monotonic() + 10
                                while True:
                                    cursor.execute(
                                        "SELECT COUNT(*) FROM information_schema.PROCESSLIST "
                                        "WHERE ID = %s",
                                        (session_id,),
                                    )
                                    if cursor.fetchone()[0] == 0:
                                        break
                                    if time.monotonic() >= deadline:
                                        self.fail(
                                            f"server still lists idle session {session_id} after KILL"
                                        )
                                    time.sleep(0.02)

                    self.assertFalse(
                        db.utils().schema().exists("orm"),
                        "the next statement succeeds after the server ends the idle connection",
                    )
                    self.assertEqual(
                        db.stats().idle, 1, "the pool retained a replacement connection"
                    )
                finally:
                    db.close()


if __name__ == "__main__":
    testcase.main()
