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
import unittest
import uuid
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


class ConnectionPoolTest(unittest.TestCase):

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
                    # On MySQL and MariaDB the idle connection holds a named lock, which its thread releases when it
                    # ends: KILL returns before the killed thread has ended, and GET_LOCK of that lock, with a wait that
                    # the server limits, answers when it has (T475). execute runs DO GET_LOCK on the connection of the
                    # pool, which then returns to it.
                    lock = f"orm_int92_{uuid.uuid4().hex}"
                    if dialect == "mysql":
                        db.execute(
                            {
                                "id": 0,
                                "role": "write",
                                "sql": f"DO GET_LOCK('{lock}', 0)",
                                "tables": [],
                                "bind_slots": [],
                            },
                            [],
                        )
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
                                # One read: the idle connection holds the lock unless the pool reset its session
                                # when it took it back.
                                cursor.execute("SELECT IS_USED_LOCK(%s)", (lock,))
                                holder = cursor.fetchone()[0]
                                self.assertEqual(
                                    holder,
                                    session_id,
                                    f"the idle session {session_id} does not hold the named lock {lock}: "
                                    f"IS_USED_LOCK is {holder}, so the pool reset its session when it took it back",
                                )
                                cursor.execute(f"KILL {session_id}")
                                cursor.execute("SELECT GET_LOCK(%s, 30)", (lock,))
                                taken = cursor.fetchone()[0]
                                self.assertEqual(
                                    taken,
                                    1,
                                    f"GET_LOCK({lock}, 30) returned {taken}: the killed session {session_id} "
                                    "did not end within the limit of the server",
                                )
                                cursor.execute("SELECT RELEASE_LOCK(%s)", (lock,))
                                cursor.fetchall()

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
