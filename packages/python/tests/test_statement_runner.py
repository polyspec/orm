# utils().run(fn): the public statement runner of INT-150. fn is called with the transaction frame of the
# connection; outside a transaction the runner opens one and ends it without retry, inside one it joins
# that transaction. frame.run returns the statement result with its rows and a non-text statement is CONFIG
# (packages/ts/src/utils.ts Utils.run, packages/ts/tests/statement-runner.mjs).
# These cases stay native (FCV-2): `active_frame()` is public only in Python (INT-161), and a statement that is not text
# can be passed only where the language does not type it. The shared behaviour is the recipe statement_runner.
import os
import tempfile
import unittest


from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from . import testcase
from .case_database import case_database


def first_number(result) -> int:
    return int(result["rows"][0][0])


class StatementRunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="orm-statement-runner-")
        self.addCleanup(self.tmp.cleanup)

    def server_case(self, dialect: str, body):
        with case_database(dialect, self.tmp.name, f"orm_stmt_{dialect}") as dsn:
            db = Db.connect(dsn)
            try:
                body(db)
            finally:
                db.close()

    def assert_runner_outside_and_inside(self, db):
        seen = {}

        def outside(frame):
            seen["outside_frame"] = frame
            seen["outside_active"] = db.active_frame()
            return frame.run("SELECT 1", [], "utility")

        result = db.utils().run(outside)
        self.assertEqual(first_number(result), 1)
        self.assertIs(seen["outside_active"], seen["outside_frame"])
        self.assertIsNone(db.active_frame())

        def inside(frame):
            seen["inside_frame"] = frame
            return frame.run("SELECT 1", [], "utility")

        def joined():
            outer = db.active_frame()
            self.assertIsNotNone(outer)
            result = db.utils().run(inside)
            seen["outer_frame"] = outer
            return result

        joined_result = db.transaction(joined, {"retry": 0})
        self.assertEqual(first_number(joined_result), 1)
        self.assertIs(seen["inside_frame"], seen["outer_frame"])
        self.assertIsNone(db.active_frame())

    def assert_frame_rows_and_config(self, db):
        def read(frame):
            return frame.run("SELECT 1", [], "utility")

        result = db.utils().run(read)
        self.assertIsInstance(result, dict)
        self.assertEqual(result["rows"], [[1]])

        def not_text(frame):
            frame.run(None, [], "utility")

        with self.assertRaises(OrmError) as caught:
            db.utils().run(not_text)
        self.assertEqual(caught.exception.code, "CONFIG")
        self.assertIsNone(db.active_frame())

    # Requirements: INT-150, INT-150b.
    def test_frame_run_returns_rows_and_a_non_text_statement_is_config_sqlite(self):
        db = Db.connect(f"sqlite://{os.path.join(self.tmp.name, 'frame.sqlite3')}")
        try:
            self.assert_frame_rows_and_config(db)
        finally:
            db.close()

    # Requirements: INT-150a.
    def test_frame_after_its_transaction_ended_is_config_sqlite(self):
        db = Db.connect(f"sqlite://{os.path.join(self.tmp.name, 'ended.sqlite3')}")
        try:
            kept = []
            db.utils().run(kept.append)
            with self.assertRaises(OrmError) as caught:
                kept[0].run("SELECT 1", [], "utility")
            self.assertEqual(caught.exception.code, "CONFIG")
        finally:
            db.close()

    # Requirements: INT-150, INT-150b.
    def test_frame_run_returns_rows_and_a_non_text_statement_is_config_mysql(self):
        self.server_case("mysql", self.assert_frame_rows_and_config)

    # Requirements: INT-150, INT-150b.
    def test_frame_run_returns_rows_and_a_non_text_statement_is_config_postgres(self):
        self.server_case("postgres", self.assert_frame_rows_and_config)


    # Requirements: INT-161.
    def test_active_frame_is_the_frame_of_the_runner_sqlite(self):
        db = Db.connect(f"sqlite://{os.path.join(self.tmp.name, 'runner.sqlite3')}")
        try:
            self.assert_runner_outside_and_inside(db)
        finally:
            db.close()

    # Requirements: INT-161.
    def test_active_frame_is_the_frame_of_the_runner_mysql(self):
        self.server_case("mysql", self.assert_runner_outside_and_inside)

    # Requirements: INT-161.
    def test_active_frame_is_the_frame_of_the_runner_postgres(self):
        self.server_case("postgres", self.assert_runner_outside_and_inside)


if __name__ == "__main__":
    testcase.main()
