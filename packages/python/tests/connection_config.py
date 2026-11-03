# The catalog session of the Python client through a transaction pooler (docs/spec/config.md CFG-41), which needs
# ORM_TEST_PGBOUNCER_SINGLE_DSN; a missing variable fails the case.
# Usage: python -m packages.python.tests.connection_config
import os
import tempfile
import unittest
import uuid
from pathlib import Path

import psycopg

from polyspec.orm.catalog import connect_catalog
from . import testcase
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


class ConnectionConfigTest(unittest.TestCase):
    deadline = testcase.DATABASE

    # Through the one server connection of ORM_TEST_PGBOUNCER_SINGLE_DSN, another client leaves a named statement, a schema change
    # changes its result type, and a catalog session runs the same text: the DEALLOCATE ALL that opens the session, and no
    # ROLLBACK of an earlier session, is what makes the Parse reach the server.
    # Requirements: CFG-41.
    def test_catalog_session_after_a_schema_change_through_a_pooler(self):
        single = os.environ.get("ORM_TEST_PGBOUNCER_SINGLE_DSN")
        if not single:
            raise AssertionError(
                "ORM_TEST_PGBOUNCER_SINGLE_DSN is required; database tests never skip; run make orm-test-servers"
            )
        table = f"pooler_{uuid.uuid4().hex[:8]}"
        catalog = connect_catalog(single)
        with psycopg.connect(single, autocommit=True) as setup:
            setup.execute(f"CREATE TABLE {table} (id int PRIMARY KEY, v int)")
            setup.execute(f"INSERT INTO {table} VALUES (1, 5)")
            try:
                with psycopg.connect(
                    single, prepare_threshold=0, autocommit=True
                ) as holder:
                    holder.execute(f"SELECT id, v FROM {table} WHERE id = %s", (1,))
                    setup.execute(
                        f"ALTER TABLE {table} ALTER COLUMN v TYPE varchar(16) USING v::text"
                    )
                    result = catalog.read_only_query(
                        f"SELECT id, v FROM {table} WHERE id = $1", (1,)
                    )
                    self.assertEqual(result.rows, [[1, "5"]])
            finally:
                catalog.close()
                setup.execute(f"DROP TABLE {table}")


if __name__ == "__main__":
    testcase.main()
