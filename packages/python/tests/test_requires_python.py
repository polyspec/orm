# The Python support range of the package states the minor release that CI tests (T115-1).
#
# CI runs the package only under the pinned interpreter of make install-python, the minor release of .python-version, so
# requires-python of packages/python/pyproject.toml is that minor release and nothing older: its dependency
# polyspec-ordered-json 0.0.8 requires 3.14, so a floor such as >=3.11 declares a range that the package cannot install on.
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / 'packages/python'


class RequiresPythonTest(unittest.TestCase):
    def test_requires_python_is_the_minor_release_of_python_version(self):
        with (PACKAGE / 'pyproject.toml').open('rb') as file:
            declared = tomllib.load(file)['project']['requires-python']
        minor = (ROOT / '.python-version').read_text().strip()
        self.assertRegex(minor, r'^\d+\.\d+$', '.python-version holds the minor release, such as 3.14')
        self.assertRegex(declared, r'^>=\d+\.\d+$', 'requires-python is ">=<major>.<minor>", such as ">=3.14"')
        self.assertEqual(
            declared,
            f'>={minor}',
            f'requires-python of packages/python/pyproject.toml must state the tested minor release of '
            f'.python-version ({minor}), not an untested floor; set requires-python = ">={minor}"',
        )


if __name__ == '__main__':
    unittest.main()
