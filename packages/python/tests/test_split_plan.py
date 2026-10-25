# A root IN list over the bind limit is split before it is planned (KSTD-7-3-3): the count of 70300 values on
# SQLite plans its parts within the bind limit and never the whole list, a bind slot per padded value.
import os
import tempfile
import tracemalloc
import unittest

from polyspec.orm.models import models

from . import testcase
from .bench_set import install_bench

# The traced allocations may peak at most this much above their start during the count. The values, their canonical
# form and the part plans within the bind limit stay well below it; the plan of the whole list, which the split read
# no longer compiles, peaked far above it.
SPLIT_COUNT_PEAK_LIMIT = 64 * 1024 * 1024


class SplitPlanTest(unittest.TestCase):
    deadline = testcase.DATABASE

    def test_split_root_in_count_plans_no_statement_over_the_bind_limit(self):
        with tempfile.TemporaryDirectory(prefix="orm-split-plan-") as directory:
            db = models.connect(
                "sqlite://" + os.path.join(directory, "split.sqlite"),
                aesKey="bench-salt",
                blindIndexKey="bench-blind-index",
            )
            try:
                install_bench(db)
                models.Service().connect(db).set_name("first").create()
                models.Service().connect(db).set_name("second").create()
                values = list(range(1, 70301))
                tracemalloc.start()
                try:
                    start = tracemalloc.get_traced_memory()[0]
                    count = models.Service().connect(db).seq(values).get_count()
                    peak = tracemalloc.get_traced_memory()[1] - start
                finally:
                    tracemalloc.stop()
                testcase.step(
                    f"the split count peaked {peak / 1048576:.1f} MB above its start"
                )
                self.assertEqual(count, 2, "count of the split IN list")
                self.assertLess(
                    peak,
                    SPLIT_COUNT_PEAK_LIMIT,
                    f"the split count peaked {peak / 1048576:.1f} MB above its start",
                )
            finally:
                db.close()


if __name__ == "__main__":
    testcase.main()
