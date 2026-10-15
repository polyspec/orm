# The statement timeout of the Python client's connection configuration (docs/config.md "Runtime connection"), the
# cases of test_statement_timeout and test_statement_timeout_through_a_pooler of packages/php/tests/ModelTest.php:
# statementTimeoutMs bounds the statements of its connection on MySQL and PostgreSQL, and a locking read past the bound
# returns CANCELED. The pool options are the cases of connection_pool.py. MySQL and PostgreSQL need
# ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, the pooler case ORM_TEST_PGBOUNCER_SINGLE_DSN, and a missing variable
# fails the case.
# Usage: python -m packages.python.tests.connection_config
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

import psycopg
import pymysql

from polyspec.orm.errors import OrmError
from . import testcase
from .case_database import case_database
from .statement_fault import required_dsn
from .test_sqlite import generate_document

DIALECTS = ("sqlite", "mysql", "postgres")
TEMP = {}


def setUpModule():
    TEMP["dir"] = tempfile.TemporaryDirectory(prefix="orm-connection-config-")


def tearDownModule():
    TEMP["dir"].cleanup()


def probe_models(directory: str, table: str):
    """The generated models of a document with the one table `table` (seq, label), generated under directory."""
    work = Path(directory) / uuid.uuid4().hex
    work.mkdir()
    document = work / "probe.dbs"
    document.write_text(
        f"dbspec 1 probe\n\ntable {table} {{\n  seq i64 identity\n  label varchar(32)\n  primary key (seq)\n}}\n",
        encoding="utf-8",
    )
    models = generate_document(str(work / "models"), document)
    (model,) = [
        value
        for value in vars(models).values()
        if isinstance(value, type)
        and value.__module__ == models.__name__
        and hasattr(value, "entity_def")
    ]
    return models, model


def hold_rows(dialect: str, dsn: str, table: str):
    """A driver connection of its own that holds every row of `table` in an open transaction."""
    url = urlsplit(dsn)
    if dialect == "mysql":
        holder = pymysql.connect(
            host=url.hostname,
            port=url.port,
            user=unquote(url.username or ""),
            password=unquote(url.password or ""),
            database=url.path.lstrip("/"),
        )
        with holder.cursor() as cursor:
            cursor.execute(f"UPDATE `{table}` SET `seq` = `seq`")
        return holder
    holder = psycopg.connect(dsn.split("?")[0])
    holder.execute(f'UPDATE "{table}" SET "seq" = "seq"')
    return holder


def locked_read(db, model) -> None:
    db.transaction(lambda: model().connect(db).for_update().get(), {"retry": 0})


def code_of(run) -> str | None:
    try:
        run()
    except OrmError as error:
        return error.code
    return None


class ConnectionConfigTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def test_statement_timeout(self):
        table = f"timeout_{uuid.uuid4().hex[:8]}"
        models, model = probe_models(TEMP["dir"].name, table)
        for dialect in DIALECTS:
            with case_database(dialect, TEMP["dir"].name, "orm_timeout") as dsn:
                self.assertEqual(
                    code_of(lambda: models.connect(dsn, statementTimeoutMs=-1)),
                    "CONFIG",
                    f"{dialect}: negative",
                )
                # MySQL bounds SELECT statements with max_execution_time, PostgreSQL bounds every statement, and
                # SQLite has no session timeout. The bounded statement is a locking read of a row that another
                # connection holds, so it waits past the bound.
                if dialect == "sqlite":
                    continue
                setup = models.connect(dsn)
                setup.utils().schema().install(models.SCHEMA)
                model().connect(setup).set_label("held").create()
                setup.close()
                holder = hold_rows(dialect, dsn, table)
                try:
                    bounded = models.connect(dsn, statementTimeoutMs=200)
                    self.assertEqual(
                        code_of(lambda: locked_read(bounded, model)),
                        "CANCELED",
                        f"{dialect}: past the bound",
                    )
                    bounded.close()
                finally:
                    holder.rollback()
                    holder.close()

    # A pooler in transaction mode hands one server session to every client in turn. Through
    # ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server connection, so the statement timeout of one
    # connection must bound only the statements of that connection. The pool of that DSN is bound to the database of
    # ORM_TEST_POSTGRES_DSN, so the case makes one table of its own name there and drops it at the end.
    def test_statement_timeout_through_a_pooler(self):
        single = os.environ.get("ORM_TEST_PGBOUNCER_SINGLE_DSN")
        if not single:
            raise AssertionError(
                "ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip; run make test-servers"
            )
        direct = required_dsn("postgres")
        table = f"pooler_{uuid.uuid4().hex[:8]}"
        models, model = probe_models(TEMP["dir"].name, table)
        setup = models.connect(direct)
        try:
            setup.utils().schema().install(models.SCHEMA)
            for i in range(4):
                model().connect(setup).set_label(f"probe-{i}").create()
            holder = hold_rows("postgres", direct, table)
            bounded = models.connect(single, statementTimeoutMs=200)
            try:
                self.assertEqual(
                    code_of(lambda: locked_read(bounded, model)),
                    "CANCELED",
                    "the bounded connection",
                )
            finally:
                holder.rollback()
                holder.close()
            plain = models.connect(single)
            # Another connection holds the rows for 400 ms, past the 200 ms bound of the other connection, so the
            # plain read waits that long.
            holder = hold_rows("postgres", direct, table)
            release = threading.Timer(0.4, holder.rollback)
            release.start()
            started = time.monotonic()
            locked_read(plain, model)
            waited = time.monotonic() - started
            release.join()
            holder.close()
            self.assertGreaterEqual(
                waited,
                0.2,
                "a connection without a timeout after the bounded one waits past the bound",
            )
            holder = hold_rows("postgres", direct, table)
            try:
                self.assertEqual(
                    code_of(lambda: locked_read(bounded, model)),
                    "CANCELED",
                    "the bounded connection after the plain one",
                )
            finally:
                holder.rollback()
                holder.close()
            bounded.close()
            plain.close()
        finally:
            setup._connection.execute(f'DROP TABLE IF EXISTS "{table}"', [])
            setup.close()


if __name__ == "__main__":
    testcase.main()
