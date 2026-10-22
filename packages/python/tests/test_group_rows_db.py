# Group rows on the seeded bench database (BENCH_SQLITE_DSN, from make run-databases), read through the generated model:
# a group holds only the grouped column and its count, the grouped boolean and integer values keep their types, the counts
# sum to the row count, and a SQL NULL group is kept (docs/spec/interfaces.md "GroupRows").
import os
import unittest

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from polyspec.orm.models import models as bench
from . import testcase


class GroupRowsDatabaseTest(unittest.TestCase):
    # Requirements: INT-31.
    def test_group_rows_database(self):
        dsn = os.environ.get("BENCH_SQLITE_DSN")
        if not dsn:
            self.fail("BENCH_SQLITE_DSN is required; run it through make run-databases")
        db = bench.connect(
            dsn,
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
            auditSource=lambda: {},
        )
        try:
            groups = (
                bench.Author()
                .connect(db)
                .group_by_is_close()
                .order_by_is_close_asc()
                .gets_count()
            )
            self.assertEqual(groups.length, 2, "getsCount returned partial models")
            total = 0
            for row in groups:
                self.assertIsInstance(
                    row.value("is_close"), bool, "grouped boolean has the wrong type"
                )
                self.assertGreaterEqual(row.count, 1)
                self.assertEqual(
                    sorted(row.to_array()),
                    ["is_close", "row_count"],
                    "group row includes an unselected field",
                )
                with self.assertRaises(OrmError) as caught:
                    row.value("name")
                self.assertEqual(caught.exception.code, codes.COLUMN_UNSELECTED)
                total += row.count
            self.assertEqual(
                total,
                bench.Author().connect(db).get_count(),
                "group counts do not sum to the row count",
            )
            services = bench.Author().connect(db).group_by_service_seq().gets_count()
            service_total = 0
            for row in services:
                self.assertIsInstance(
                    row.value("service_seq"), int, "grouped integer changed type"
                )
                service_total += row.count
            self.assertEqual(service_total, total, "service group counts differ")
            nullable = bench.Author().connect(db).group_by_price().gets_count()
            saw_null = False
            nullable_total = 0
            for row in nullable:
                saw_null = saw_null or row.value("price") is None
                nullable_total += row.count
            self.assertTrue(
                saw_null and nullable_total == total, "SQL NULL group value was lost"
            )
        finally:
            db.close()


if __name__ == "__main__":
    testcase.main()
