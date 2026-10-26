import unittest

from . import testcase
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogRowSnapshot,
    CatalogTableMetadata,
    _revision,
    _same_row,
)


class CatalogRowBaselineTest(unittest.TestCase):
    # Requirements: INT-107.
    def test_compares_exact_typed_values_and_preserves_generated_original(self):
        for left, right in (
            (0.0, -0.0),
            ("100.23000", "100.23"),
            (b"\x00\xff", b"\x00\xfe"),
            (False, 0),
        ):
            with self.subTest(left=left, right=right):
                self.assertFalse(_same_row([left], [right]))

        metadata = CatalogTableMetadata(
            table={"namespace": "main", "name": "computed_values"},
            kind="table",
            columns=[
                CatalogColumn("id", "INTEGER", False, False),
                CatalogColumn("value", "TEXT", False, False),
                CatalogColumn("value_length", "INTEGER", False, True),
            ],
            primary_key=["id"],
            reliable_row_identity=True,
        )
        original = [1, "four", 4]
        snapshot = CatalogRowSnapshot(
            metadata, original, [0], _revision(metadata, original)
        )
        changed = [1, "changed", 7]
        self.assertEqual(snapshot.cells[2], 4)
        self.assertFalse(_same_row(snapshot.cells, changed))
        self.assertNotEqual(snapshot.revision, _revision(metadata, changed))


if __name__ == "__main__":
    testcase.main()
