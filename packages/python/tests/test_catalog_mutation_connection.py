# Requirements: INT-106e.
# Runtime-unique (FCV-14): which connection a mutation takes is a choice of each runtime, and the spec names only its fresh transaction.
import os
import unittest

from . import testcase
from polyspec.orm import codes
from polyspec.orm.catalog import connect_catalog
from polyspec.orm.errors import OrmError


def _run(catalog, sql):
    session = catalog._open()
    try:
        rows = session.run(sql).rows
        if catalog.dialect != "postgres":
            return rows
        session.raw.commit()
        return rows
    finally:
        catalog._close(session)


class CommittedMutationsTest(unittest.TestCase):
    def _writers(self, dsn: str, column: str) -> list:
        table = f"orm_mutation_connection_{os.getpid()}"
        catalog = connect_catalog(dsn)
        self.addCleanup(catalog.close)
        _run(catalog, f"DROP TABLE IF EXISTS {table}")
        _run(catalog, f"CREATE TABLE {table}(id BIGINT PRIMARY KEY, backend {column})")
        self.addCleanup(_run, catalog, f"DROP TABLE {table}")
        namespace = catalog.current_namespace()
        declared = catalog.describe_table({"namespace": namespace, "name": table})

        def insert(key: int):
            catalog.insert_row(declared, [("id", key)])

        for key in range(1, 6):
            insert(key)
        # A refused insert rolls back and discards its connection, and the next one still writes in a transaction of its own.
        with self.assertRaises(OrmError) as refused:
            insert(1)
        self.assertEqual(refused.exception.code, codes.ROW_CONFLICT)
        insert(7)
        self.assertEqual(_run(catalog, f"SELECT COUNT(*) FROM {table}")[0][0], 6)
        return [
            row[0] for row in _run(catalog, f"SELECT backend FROM {table} WHERE id < 7")
        ]

    def test_committed_mutations_share_one_connection(self):
        for variable, column in (
            ("ORM_TEST_POSTGRES_DSN", "INTEGER NOT NULL DEFAULT pg_backend_pid()"),
            ("ORM_TEST_MYSQL_DSN", "BIGINT NOT NULL DEFAULT (CONNECTION_ID())"),
        ):
            dsn = os.environ.get(variable)
            self.assertTrue(dsn, f"{variable} is required; run make orm-test-servers")
            writers = self._writers(dsn, column)
            self.assertEqual(len(writers), 5, writers)
            self.assertEqual(len(set(writers)), 1, writers)


if __name__ == "__main__":
    testcase.main()
