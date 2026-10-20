# A related model is part of the row output under its relation name, as the Go client writes it
# (docs/operations/usage.md "Relations").
import tempfile
import unittest
from pathlib import Path

from .test_sqlite import DDL, generate, insert_service_and_author, run_script
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


class RelatedOutputTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-related-")
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.db = cls.models.connect(
            f"sqlite://{tmp.name}/related.sqlite3",
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
        )
        run_script(cls.db, DDL)
        insert_service_and_author(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    # Requirements: CPX-1, DBS-118.
    def test_relation_model_is_written_under_its_relation_name(self):
        rows = (
            self.models.Author()
            .connect(self.db)
            .relation(self.models.Service().match_service_seq_with_seq())
            .get_by_seq(1)
        )
        self.assertEqual(rows.to_array()["service_model"], {"seq": 1, "name": "svc"})


if __name__ == "__main__":
    testcase.main()
