# The package data of the distribution: every key of [tool.setuptools.package-data] names a package under src,
# and polyspec.orm ships py.typed in its wheel.
import tomllib
import unittest
import polyspec.orm as orm
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"


class PackageDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / "pyproject.toml").open("rb") as file:
            cls.package_data = tomllib.load(file)["tool"]["setuptools"]["package-data"]

    def test_every_package_data_key_names_a_package_under_src(self):
        for key in self.package_data:
            init = SRC.joinpath(*key.split(".")) / "__init__.py"
            self.assertTrue(
                init.is_file(),
                f"package-data key {key!r} names no package under {SRC}: {init} is missing; "
                "use the dotted name of the package, such as polyspec.orm",
            )

    def test_polyspec_orm_declares_py_typed(self):
        self.assertIn(
            "py.typed",
            self.package_data.get("polyspec.orm", []),
            "package-data of polyspec.orm must list py.typed in pyproject.toml; add "
            '"polyspec.orm" = ["py.typed"] under [tool.setuptools.package-data]',
        )
        self.assertTrue((SRC / "polyspec" / "orm" / "py.typed").is_file())

    def test_public_entry_point_exports_are_unique_and_importable(self):
        exports = orm.__all__
        self.assertEqual(
            len(exports),
            len(set(exports)),
            "polyspec.orm.__all__ contains duplicate names; keep each public export once",
        )
        namespace = {}
        exec("from polyspec.orm import *", namespace)
        self.assertEqual(
            set(namespace) - {"__builtins__"},
            set(exports),
            "from polyspec.orm import * must expose exactly the names declared by __all__",
        )
        for name in exports:
            self.assertIn(
                name,
                namespace,
                f"polyspec.orm declares {name!r} public but the package import does not bind it",
            )


if __name__ == "__main__":
    testcase.main()
