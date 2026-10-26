# The unit test of the feature coverage case runner (packages/python/tests/coverage_case.py). The Python
# coverage tests share the runner, so its change runs this test instead of every feature's coverage
# (the helpers of contracts/features.json); make orm-check runs the whole coverage.
# Usage: python packages/python/tests/coverage_case_test.py
import contextlib
import io
import os
import sys
import unittest
from unittest.mock import patch

from . import coverage_case, testcase
from .coverage_case import REPOSITORY_ROOT, run_cases


def run_with_arguments(ids, cases):
    """Runs the cases as the checker would name them on the command line and returns the printed lines."""
    argv = sys.argv
    sys.argv = ["x.py", *ids]
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            run_cases(cases)
    finally:
        sys.argv = argv
    return out.getvalue().splitlines()


class CoverageCaseTest(unittest.TestCase):
    def test_runs_requested_cases_in_order(self):
        ran = []
        lines = run_with_arguments(
            ["b", "a"], {"a": lambda: ran.append("a"), "b": lambda: ran.append("b")}
        )
        self.assertEqual(ran, ["b", "a"])
        self.assertEqual(lines, ["CASE b PASS", "CASE a PASS"])

    def test_runs_each_case_on_every_database_item_of_the_file(self):
        ran = []
        original = coverage_case.feature_items
        coverage_case.feature_items = lambda test: [
            ("sqlite", "sqlite:///x"),
            ("mysql", "mysql://y"),
        ]
        try:
            lines = run_with_arguments(["a"], {"a": lambda item: ran.append(item[0])})
        finally:
            coverage_case.feature_items = original
        self.assertEqual(ran, ["sqlite", "mysql"])
        self.assertEqual(lines, ["CASE a [sqlite] PASS", "CASE a [mysql] PASS"])

    def test_refuses_missing_repeated_and_unknown_ids_before_any_case(self):
        ran = []
        for ids in ([], ["a", "a"], ["a", "z"]):
            with self.assertRaisesRegex(SystemExit, r"^usage: x\.py a\.\.\.; got "):
                run_with_arguments(ids, {"a": lambda: ran.append("a")})
        self.assertEqual(ran, [])

    def test_a_failed_case_raises_and_prints_no_pass(self):
        def fail():
            raise AssertionError("broken")

        out = io.StringIO()
        argv = sys.argv
        sys.argv = ["x.py", "a", "b"]
        try:
            with (
                contextlib.redirect_stdout(out),
                self.assertRaisesRegex(AssertionError, "broken"),
            ):
                run_cases({"a": lambda: None, "b": fail})
        finally:
            sys.argv = argv
        self.assertEqual(out.getvalue().splitlines(), ["CASE a PASS"])

    def test_repository_root_holds_the_feature_manifest(self):
        self.assertTrue((REPOSITORY_ROOT / "contracts" / "features.json").is_file())

    def test_empty_tenant_helper_forwards_bench_codec_keys(self):
        class Account:
            def connect(self, _db):
                return self

            def tenant_id(self, _tenant):
                return self

            def get_count(self):
                return 0

        class Database:
            driver = "sqlite"

            def close(self):
                pass

        class Models:
            def __init__(self):
                self.calls = []
                self.db = Database()

            def connect(self, dsn, **options):
                self.calls.append((dsn, options))
                return self.db

            def CompositeAccount(self):
                return Account()

        models = Models()
        seen = []
        coverage_case.run_on_empty_tenant(
            models,
            ("sqlite", "sqlite:///bench.sqlite"),
            9,
            lambda db, _account: seen.append(db),
            aes_key="bench-salt",
            blind_index_key="bench-blind-index",
        )
        self.assertEqual(
            models.calls,
            [
                (
                    "sqlite:///bench.sqlite",
                    {"aesKey": "bench-salt", "blindIndexKey": "bench-blind-index"},
                )
            ],
        )
        self.assertEqual(seen, [models.db])

    def test_feature_items_selects_the_runner_database_only_when_set(self):
        listed = '[{"database":"sqlite","dsn":"sqlite:///selected.sqlite"}]'
        with patch("subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = listed
            run.return_value.stderr = ""
            with patch.dict(os.environ):
                os.environ.pop("ORM_FEATURE_DATABASE", None)
                coverage_case.feature_items(
                    "packages/python/tests/coverage_constraints_and_relations.py"
                )
                default_arguments = run.call_args.args[0]
                self.assertNotIn("--database", default_arguments)

            with patch.dict(os.environ, {"ORM_FEATURE_DATABASE": "sqlite"}):
                items = coverage_case.feature_items(
                    "packages/python/tests/coverage_constraints_and_relations.py"
                )
                selected_arguments = run.call_args.args[0]
                self.assertEqual(selected_arguments[-2:], ["--database", "sqlite"])
                self.assertEqual(items, [("sqlite", "sqlite:///selected.sqlite")])


if __name__ == "__main__":
    testcase.main()
