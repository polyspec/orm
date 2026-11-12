import unittest
from packages.python.tests import testcase

import polyspec.orm as orm


class PackageEntryTest(unittest.TestCase):
    # Requirements: INT-138.
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
