# The Python support range of the package states the minor release that CI tests (T115-1).
#
# CI runs the package only under the pinned interpreter of make install-python, the Python release of mise.toml, so
# requires-python of packages/python/pyproject.toml is its minor release and nothing older: its dependency
# polyspec-ordered-json 0.0.9 requires 3.14, so a floor such as >=3.11 declares a range that the package cannot install on.
import tomllib
import unittest
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / "packages/python"


class RequiresPythonTest(unittest.TestCase):
    def test_requires_python_is_the_minor_release_of_mise_python(self):
        with (PACKAGE / "pyproject.toml").open("rb") as file:
            declared = tomllib.load(file)["project"]["requires-python"]
        with (ROOT / "mise.toml").open("rb") as file:
            release = tomllib.load(file)["tools"]["python"]
        self.assertRegex(
            release,
            r"^\d+\.\d+\.\d+$",
            "mise.toml pins the exact Python release, such as 3.14.8",
        )
        minor = ".".join(release.split(".")[:2])
        self.assertRegex(
            declared,
            r"^>=\d+\.\d+$",
            'requires-python is ">=<major>.<minor>", such as ">=3.14"',
        )
        self.assertEqual(
            declared,
            f">={minor}",
            f"requires-python of packages/python/pyproject.toml must state the tested minor release of the Python of "
            f'mise.toml ({minor}), not an untested floor; set requires-python = ">={minor}"',
        )


if __name__ == "__main__":
    testcase.main()
