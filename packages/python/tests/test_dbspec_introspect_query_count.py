"""SQLite-memory owner case for the query count observed by the Python introspector."""
import sqlite3
import unittest

from .runner_connect import Adapter
from . import testcase
from polyspec.orm.dbspec.introspect import introspect_dbspec


class CountingAdapter:
    def __init__(self, inner):
        self.inner = inner
        self.count = 0

    def execute(self, sql, values=()):
        self.count += 1
        return self.inner.execute(sql, values)


class DbspecIntrospectQueryCountUnitTest(unittest.TestCase):
    # Requirements: DIA-198.
    def test_sqlite_memory_count_independent_of_table_count(self):
        for table_count in (1, 5):
            with self.subTest(table_count=table_count):
                connection = sqlite3.connect(":memory:")
                try:
                    for index in range(table_count):
                        connection.execute(
                            f'CREATE TABLE "item_{index}" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "label" TEXT NULL)'
                        )
                    counting = CountingAdapter(Adapter(connection))
                    result = introspect_dbspec(counting, "sqlite", "introspected")
                    self.assertEqual([], result["unsupported"])
                    self.assertEqual(table_count, len(result["document"].tables))
                    self.assertEqual(3, counting.count)
                finally:
                    connection.close()


if __name__ == "__main__":
    testcase.main()
