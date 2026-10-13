# The unit test of the feature coverage case runner (packages/orm-python/tests/coverage_case.py). The Python
# coverage tests share the runner, so its change runs this test instead of every feature's coverage
# (the helpers of contracts/features.json); make check runs the whole coverage.
# Usage: python packages/orm-python/tests/coverage_case_test.py
import contextlib
import io
import sys
import unittest
from pathlib import Path


from coverage_case import REPOSITORY_ROOT, run_cases  # noqa: E402


def run_with_arguments(ids, cases):
    """Runs the cases as the checker would name them on the command line and returns the printed lines."""
    argv = sys.argv
    sys.argv = ['x.py', *ids]
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
        lines = run_with_arguments(['b', 'a'], {'a': lambda: ran.append('a'), 'b': lambda: ran.append('b')})
        self.assertEqual(ran, ['b', 'a'])
        self.assertEqual(lines, ['CASE b PASS', 'CASE a PASS'])

    def test_refuses_missing_repeated_and_unknown_ids_before_any_case(self):
        ran = []
        for ids in ([], ['a', 'a'], ['a', 'z']):
            with self.assertRaisesRegex(SystemExit, r'^usage: x\.py a\.\.\.; got '):
                run_with_arguments(ids, {'a': lambda: ran.append('a')})
        self.assertEqual(ran, [])

    def test_a_failed_case_raises_and_prints_no_pass(self):
        def fail():
            raise AssertionError('broken')
        out = io.StringIO()
        argv = sys.argv
        sys.argv = ['x.py', 'a', 'b']
        try:
            with contextlib.redirect_stdout(out), self.assertRaisesRegex(AssertionError, 'broken'):
                run_cases({'a': lambda: None, 'b': fail})
        finally:
            sys.argv = argv
        self.assertEqual(out.getvalue().splitlines(), ['CASE a PASS'])

    def test_repository_root_holds_the_feature_manifest(self):
        self.assertTrue((REPOSITORY_ROOT / 'contracts' / 'features.json').is_file())


if __name__ == '__main__':
    unittest.main()
