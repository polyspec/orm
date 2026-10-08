# The package data of the distribution: every key of [tool.setuptools.package-data] names a package under src,
# and polyspec.orm ships py.typed in its wheel.
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'src'


class PackageDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / 'pyproject.toml').open('rb') as file:
            cls.package_data = tomllib.load(file)['tool']['setuptools']['package-data']

    def test_every_package_data_key_names_a_package_under_src(self):
        for key in self.package_data:
            init = SRC.joinpath(*key.split('.')) / '__init__.py'
            self.assertTrue(
                init.is_file(),
                f'package-data key {key!r} names no package under {SRC}: {init} is missing; '
                'use the dotted name of the package, such as polyspec.orm',
            )

    def test_polyspec_orm_declares_py_typed(self):
        self.assertIn(
            'py.typed',
            self.package_data.get('polyspec.orm', []),
            'package-data of polyspec.orm must list py.typed in pyproject.toml; add '
            '"polyspec.orm" = ["py.typed"] under [tool.setuptools.package-data]',
        )
        self.assertTrue((SRC / 'polyspec' / 'orm' / 'py.typed').is_file())


if __name__ == '__main__':
    unittest.main()
