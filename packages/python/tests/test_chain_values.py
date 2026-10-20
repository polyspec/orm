# The values that a chain accepts: Python resolves a chain at call time, so a value that the operator does not take
# fails with CONFIG when the request runs. The test of DSL-50 (a list and null only without an operator, with Eq and
# with Ne) (docs/spec/dsl.md).
import tempfile
import unittest
from pathlib import Path

from polyspec.orm import OrmError

from .test_sqlite import DDL, generate, run_script
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


class ChainValuesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-chain-values-")
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.db = cls.models.connect(
            f"sqlite://{tmp.name}/chain-values.sqlite3",
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
        )
        run_script(cls.db, DDL)
        for read_count in (5, 10, 20):
            cls.db._connection.execute(
                'INSERT INTO "author" ("name", "user_seq", "service_seq", "service_region_seq", '
                '"service_member_seq", "start_dt", "end_dt", "read_count", "aes_key_version") '
                "VALUES (?, 1, 7, 1, 1, ?, ?, ?, 1)",
                [
                    "c",
                    "2026-06-01 00:00:00.000000",
                    "2026-06-01 00:00:00.000000",
                    read_count,
                ],
            )

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def author(self):
        return self.models.Author().connect(self.db)

    def code(self, run):
        with self.assertRaises(OrmError) as caught:
            run()
        return caught.exception.code

    def test_list_and_null_only_without_an_operator_or_with_eq_and_ne(self):
        self.assertEqual(self.author().read_count([5, 20]).get_count(), 2)
        self.assertEqual(self.author().eq_read_count([5, 20]).get_count(), 2)
        self.assertEqual(self.author().ne_read_count([5, 20]).get_count(), 1)
        self.assertEqual(self.author().gt_read_count(5).get_count(), 2)
        self.assertEqual(
            self.code(lambda: self.author().gt_read_count([5, 20]).get_count()),
            "CONFIG",
        )
        self.assertEqual(
            self.code(lambda: self.author().gt_read_count(None).get_count()), "CONFIG"
        )


if __name__ == "__main__":
    testcase.main()
