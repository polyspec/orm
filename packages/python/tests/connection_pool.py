# The connection pool of the Python client (docs/spec/config.md "Runtime connection"), as the Go, TypeScript and Rust clients
# keep one: poolSize bounds the open connections (10 when zero or unset), transactions of different threads run on
# connections of their own at the same time, a transaction that needs a connection while all of them are in use waits
# for one, poolIdleSize bounds the idle connections, poolLifetimeMs closes a connection whose lifetime passed, and a
# negative value or an idle size above the pool size is CONFIG. Each case runs on SQLite, MySQL and PostgreSQL; MySQL
# and PostgreSQL need ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, and a missing variable fails the case.
# Usage: python -m packages.python.tests.connection_pool
import tempfile
import threading
import time
import unittest

from polyspec.orm.errors import OrmError
from polyspec.orm.models import models
from . import testcase
from .bench_set import install_bench
from .case_database import case_database

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
            with self.subTest(dialect=dialect):
                with case_database(dialect, TEMP["dir"].name, "orm_pool") as dsn:
                    setup = models.connect(dsn)
                    install_bench(setup)
                    setup.close()
                    body(dialect, dsn)

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
                    code_of(lambda: models.connect(dsn, **options).close()),
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


if __name__ == "__main__":
    testcase.main()
