# The unit tests of the parse positions of the dbspec Python client (ORES-83): a position is a frozen value with a tuple
# path, a failed parse returns no positions, and a successful parse returns them in source order. The shared cases of the
# dbspec recipes run from recipe_<section>.py; these unit tests have no shared vector and stay native.
# Run: python -m packages.python.tests.dbspec_cases
import dataclasses
import unittest


from polyspec.orm.dbspec import (
    DbspecPosition,
    parse_dbspec,
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

    def test_failed_parse_returns_no_positions(self):
        for text in (
            "dbspec 1 bad\n\ntable orders {\n",
            "dbspec 1 bad\n\ntable orders {\n  id i64\n}\n  x\n",
        ):
            with self.subTest(text=text):
                document, positions, diagnostics = parse_dbspec(text, {})
                self.assertIsNone(document)
                self.assertIsNone(positions)
                self.assertTrue(diagnostics)

    def test_successful_parse_returns_positions_in_source_order(self):
        document, positions, diagnostics = parse_dbspec(
            "dbspec 1 shop\n\ntable orders {\n  id i64 identity\n  primary key (id)\n}\n",
            {},
        )
        self.assertIsNotNone(document)
        self.assertEqual(list(diagnostics), [])
        self.assertEqual(
            [(p.kind, p.path, p.line, p.column) for p in positions],
            [
                ("document", ("shop",), 1, 10),
                ("table", ("orders",), 3, 7),
                ("column", ("orders", "id"), 4, 3),
                ("constraint", ("orders", "primary key"), 5, 3),
            ],
        )


if __name__ == "__main__":
    testcase.main()
