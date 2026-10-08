# Conformance result check of the Python runner (tests/conformance/runner_python.py): the output
# encoder writes the Go encoder's layout, and the runner rejects invalid arguments with exit 2.
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'tests' / 'conformance' / 'runner_python.py'
sys.path.insert(0, str(RUNNER.parent))

import runner_python as runner  # noqa: E402


class EncodeTest(unittest.TestCase):
    def test_encodes_the_go_layout(self):
        self.assertEqual(runner.encode({'a': [1, None], 'b': {}}, 0),
                         '{\n "a": [\n  1,\n  null\n ],\n "b": {}\n}')

    def test_floats_follow_the_go_shortest_form(self):
        self.assertEqual(runner.go_float(0.5), '0.5')
        self.assertEqual(runner.go_float(12.0), '12')
        self.assertEqual(runner.go_float(1e21), '1e+21')

    def test_escapes_html_characters_as_go_does(self):
        self.assertEqual(runner.go_escape('<a&b>'), '\\u003ca\\u0026b\\u003e')

    def test_result_maps_have_sorted_keys(self):
        self.assertEqual(list(runner.sorted_maps({'b': 1, 'a': {'d': 2, 'c': 3}})), ['a', 'b'])
        self.assertEqual(list(runner.sorted_maps({'b': 1, 'a': {'d': 2, 'c': 3}})['a']), ['c', 'd'])


class ArgumentsTest(unittest.TestCase):
    def run_runner(self, *args):
        return subprocess.run([sys.executable, str(RUNNER), *args], capture_output=True, text=True,
                              env=dict(os.environ, PYTHONPATH=''))

    def test_missing_dsn_exits_2(self):
        self.assertEqual(self.run_runner('--models', '/tmp/none').returncode, 2)

    def test_missing_models_exits_2_with_the_fix(self):
        result = self.run_runner('--dsn', 'sqlite://x.db')
        self.assertEqual(result.returncode, 2)
        self.assertIn('make conformance-python-models', result.stderr)

    def test_unexpected_argument_exits_2(self):
        self.assertEqual(self.run_runner('--models', 'm', '--dsn', 'd', '--bogus', 'x').returncode, 2)


if __name__ == '__main__':
    unittest.main()
