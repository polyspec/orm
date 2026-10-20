# The execution flow of a Python transaction, on a SQLite file: a transaction is active in the thread that opened it, so
# a thread started inside the callback has no active transaction and an unconnected model there returns CONFIG; and the
# client has no public begin, commit or rollback. The test of DSL-122 and DSL-124 (docs/spec/dsl.md "Transactions").
import tempfile
import threading
import unittest
from pathlib import Path

from polyspec.orm import Db, OrmError

from .test_sqlite import DDL, generate, run_script
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


class TransactionFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory(prefix="orm-transaction-flow-")
        cls.addClassCleanup(tmp.cleanup)
        cls.models = generate(
            tmp.name, ROOT / "contracts" / "fixtures" / "bench" / "dbspec-set.json"
        )
        cls.db = cls.models.connect(
            f"sqlite://{tmp.name}/transaction-flow.sqlite3",
            aesKey="bench-salt",
            blindIndexKey="bench-blind-index",
        )
        run_script(cls.db, DDL)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def test_a_thread_started_in_the_callback_has_no_transaction(self):
        seen = {}

        def other_thread():
            try:
                seen["count"] = self.models.Service().get_count()
            except OrmError as error:
                seen["error"] = error.code

        def body():
            seen["inside"] = self.models.Service().get_count()
            thread = threading.Thread(target=other_thread)
            thread.start()
            thread.join()

        self.db.transaction(body, {"retry": 0})
        self.assertEqual(seen, {"inside": 0, "error": "CONFIG"})

    def test_begin_commit_and_rollback_are_not_public(self):
        public = {name.lower() for name in dir(Db) if not name.startswith("_")}
        self.assertIn("transaction", public)
        self.assertEqual(public & {"begin", "commit", "rollback"}, set())


if __name__ == "__main__":
    testcase.main()
