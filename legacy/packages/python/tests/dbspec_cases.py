# The unit tests of the parse positions of the dbspec Python client (ORES-83): a position is a frozen value with a tuple
# path, which tests/dbspec/positions.json cannot state. The other parse positions and the shared cases of the
# dbspec recipes run from recipe_<section>.py; these unit tests have no shared vector and stay native.
# Run: python -m legacy.packages.python.tests.dbspec_cases
import dataclasses
import unittest


from polyspec.orm.dbspec import (
    DbspecPosition,
)
from . import testcase


class DbspecPositionTest(unittest.TestCase):
    # Requirements: ORES-83.
    def test_position_is_frozen_with_tuple_path(self):
        position = DbspecPosition("table", ("orders",), 5, 7)
        self.assertEqual(
            (position.kind, position.path, position.line, position.column),
            ("table", ("orders",), 5, 7),
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            position.line = 6


if __name__ == "__main__":
    testcase.main()
