# A connection to the primary and one to its replica work side by side (docs/spec/config.md "Primary and replicas"), the
# cases of test_primary_and_replica and test_read_only of packages/php/tests/ModelTest.php: a model uses the
# connection it is connected to and no other, a model without a connection inside a transaction uses the transaction,
# a write through the replica returns READ_ONLY, and so does a write to a SQLite file opened read-only. MySQL and
# PostgreSQL need ORM_TEST_MYSQL_DSN, ORM_TEST_POSTGRES_DSN, ORM_TEST_MYSQL_REPLICA_DSN and
# ORM_TEST_POSTGRES_REPLICA_DSN, and a missing variable fails the case.
# Usage: python -m packages.python.tests.replica
import os
import stat
import tempfile
import time
import unittest
from urllib.parse import urlsplit

import psycopg

from polyspec.orm.errors import OrmError
from . import testcase
from .case_database import case_database
from .connection_config import probe_models
from .runner_connect import mysql_connect
from .server_database import with_database

TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-replica-")
    TEMP["models"] = probe_models(TEMP["dir"].name, "replica_probe")


def tearDownModule():
    TEMP["dir"].cleanup()


def await_replica(dialect: str, primary: str, replica: str) -> None:
    """Returns after the replica has applied every change the primary committed before the call. On PostgreSQL a
    transaction with synchronous_commit=remote_apply that writes WAL, here a transactional logical message, commits
    after the standby has applied it. On MySQL SOURCE_POS_WAIT on the replica waits for the binary log position of the
    primary, for at most 60 seconds, since the replica applies the writes of every client that runs in parallel."""
    if dialect == "postgres":
        with psycopg.connect(primary.split("?")[0]) as source:
            source.execute("SET LOCAL synchronous_commit = remote_apply")
            (mode,) = source.execute(
                "SELECT current_setting('synchronous_commit'), pg_logical_emit_message(true, 'orm-test-barrier', '')"
            ).fetchone()[:1]
            if mode != "remote_apply":
                raise AssertionError(
                    f"synchronous_commit of the barrier transaction is {mode}"
                )
        return
    source = mysql_connect(primary, urlsplit(primary).path.lstrip("/") or None)
    with source.cursor() as cursor:
        cursor.execute("SHOW BINARY LOG STATUS")
        file, position = cursor.fetchone()[:2]
    source.close()
    target = mysql_connect(replica, urlsplit(replica).path.lstrip("/") or None)
    with target.cursor() as cursor:
        cursor.execute("SELECT SOURCE_POS_WAIT(%s, %s, 60)", (file, int(position)))
        (waited,) = cursor.fetchone()
    target.close()
    if waited is None or int(waited) < 0:
        raise AssertionError(f"the replica did not reach {file}:{position}")


def code_of(run) -> str | None:
    try:
        run()
    except OrmError as error:
        return error.code
    return None


class ReplicaTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def primary_and_replica(self, dialect: str) -> None:
        variable = f"ORM_TEST_{dialect.upper()}_REPLICA_DSN"
        replica = os.environ.get(variable)
        if not replica:
            raise AssertionError(
                f"{variable} is required; database tests never skip; run make orm-test-servers"
            )
        models, probe = TEMP["models"]
        with case_database(dialect, TEMP["dir"].name, "orm_replica") as primary:
            setup = models.connect(primary)
            setup.utils().schema().install(models.SCHEMA)
            setup.close()
            master = models.connect(primary)
            name = f"replica-{time.monotonic_ns() % 10**8}"
            probe().connect(master).set_label(name).create()
            # The replica copies the case database of the primary under the same name; MySQL connects to it only
            # after it exists on the replica, so the case waits through the shared replica database first.
            await_replica(dialect, primary, replica)
            slave1 = models.connect(
                with_database(replica, urlsplit(primary).path.lstrip("/"))
            )
            try:
                self.assertEqual(
                    probe().connect(slave1).label(name).get_count(),
                    1,
                    "the replica reads the primary's row",
                )
                self.assertEqual(
                    code_of(
                        lambda: probe().connect(slave1).set_label(f"{name}-r").create()
                    ),
                    "READ_ONLY",
                    "a write through the replica connection",
                )
                self.assertEqual(
                    probe().connect(master).label(f"{name}-r").get_count(),
                    0,
                    "no write reaches the primary",
                )
                # A row read through the replica is written through the primary.
                probe().connect(slave1).label(name).get().connect(master).set_label(
                    f"{name}-n"
                ).update()

                def inside():
                    probe().set_label(f"{name}-t").create()
                    self.assertEqual(
                        probe().connect(master).label(f"{name}-t").get_count(),
                        1,
                        "the primary in its transaction",
                    )
                    self.assertEqual(
                        probe().connect(slave1).label(f"{name}-t").get_count(),
                        0,
                        "no uncommitted row on the replica",
                    )

                master.transaction(inside)
                await_replica(dialect, primary, replica)
                self.assertEqual(
                    probe()
                    .connect(slave1)
                    .label([f"{name}-n", f"{name}-t"])
                    .get_count(),
                    2,
                    "the committed rows",
                )
            finally:
                slave1.close()
                master.close()

    # Requirements: CFG-21, CFG-22.
    def test_primary_and_replica_mysql(self):
        self.primary_and_replica("mysql")

    def test_primary_and_replica_postgres(self):
        self.primary_and_replica("postgres")

    # A connection to a SQLite database file that the process may only read: SQLite opens it read-only, reads
    # succeed, and a write returns READ_ONLY.
    # Requirements: CFG-24.
    def test_read_only(self):
        models, probe = TEMP["models"]
        path = os.path.join(TEMP["dir"].name, "read-only.sqlite")
        writable = models.connect(f"sqlite://{path}")
        writable.utils().schema().install(models.SCHEMA)
        probe().connect(writable).set_label("read-only").create()
        writable.close()
        os.chmod(path, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        read_only = models.connect(f"sqlite://{path}")
        try:
            self.assertEqual(
                probe().connect(read_only).label("read-only").get_count(),
                1,
                "the read-only database reads",
            )
            self.assertEqual(
                code_of(
                    lambda: probe().connect(read_only).set_label("rejected").create()
                ),
                "READ_ONLY",
                "a write",
            )
        finally:
            read_only.close()


if __name__ == "__main__":
    testcase.main()
