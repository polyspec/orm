# The connection pool of the Python client (docs/spec/config.md "Runtime connection"), as the Go, TypeScript and Rust clients
# keep one: poolSize bounds the open connections (10 when zero or unset), transactions of different threads run on
# connections of their own at the same time, a transaction that needs a connection while all of them are in use waits
# for one, poolIdleSize bounds the idle connections, poolLifetimeMs closes a connection whose lifetime passed, and a
# negative value or an idle size above the pool size is CONFIG. Each case runs on SQLite, MySQL and PostgreSQL; MySQL
# and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
# Usage: python -m legacy.packages.python.tests.connection_pool
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
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


# One writer process of test_sqlite_several_process_writers_commit_every_row: read-then-write transactions without retries.
SQLITE_WRITER_PROCESS = """
import sys
from legacy.packages.python.tests.models import models
dsn, name, count = sys.argv[1], sys.argv[2], int(sys.argv[3])
db = models.connect(dsn)
try:
    for index in range(count):
        def body(iteration=index):
            models.Service().connect(db).get_count()
            models.Service().connect(db).set_name(f"{name}-{iteration}").create()
        db.transaction(body, {"retry": 0})
finally:
    db.close()
"""


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

    def each(self, body, dialects=DIALECTS):
        for dialect in dialects:
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

        self.each(body, ("sqlite",))

    def test_idle_size_and_lifetime(self):
        def body(_dialect, dsn):
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

        # The pool of SQLite differs by runtime; the recipe connection_pool states MySQL and PostgreSQL.
        self.each(body, ("sqlite",))

    # Requirements: CFG-42. A recipe case runs on the connections of one test process in Python, so this test starts the processes.
    def test_sqlite_several_process_writers_commit_every_row(self):
        with tempfile.TemporaryDirectory(prefix="orm-sqlite-processes-") as directory:
            # The writers wait up to 60 seconds for the file lock (CFG-12), so the load of the runner does not end a wait (CFG-42).
            dsn = f"sqlite://{directory}/processes.sqlite3?_pragma=busy_timeout(60000)"
            setup = models.connect(dsn)
            install_bench(setup)
            setup.close()
            # The repository root, where the module legacy.packages.python.tests imports.
            root = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "..", "..", "..")
            )
            children = [
                subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        SQLITE_WRITER_PROCESS,
                        dsn,
                        f"process-{index}",
                        "40",
                    ],
                    cwd=root,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                for index in range(6)
            ]
            for child in children:
                output, _ = child.communicate()
                self.assertEqual(child.returncode, 0, output)
            reader = models.connect(dsn)
            try:
                self.assertEqual(models.Service().connect(reader).get_count(), 240)
            finally:
                reader.close()

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
