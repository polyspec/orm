import os
import unittest

from .coverage_case import coverage_main
from .coverage_performance_gate import feature_hot_path_gate


# Requirements: PERF-1.
class CoverageTest(unittest.TestCase):
    def test_hot_path_gate(self):
        self.assertEqual(os.environ.get("ORM_FEATURE_DATABASE"), "postgres")
        feature_hot_path_gate()
        print("CASE hot_path_gate [postgres] PASS", flush=True)


if __name__ == "__main__":
    coverage_main(CoverageTest)
