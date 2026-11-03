# The coverage helper: where it takes the repository root from.
import unittest

from . import testcase
from .coverage_case import REPOSITORY_ROOT


class CoverageCaseTest(unittest.TestCase):
    def test_repository_root_holds_the_feature_manifest(self):
        self.assertTrue((REPOSITORY_ROOT / "contracts" / "features.json").is_file())


if __name__ == "__main__":
    testcase.main()
