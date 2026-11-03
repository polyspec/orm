# Group rows (docs/spec/interfaces.md "GroupRow"): a row count that is not an exact nonnegative integer fails with
# CODEC_DECODE, and a row with no row_count is INTERNAL.
import unittest

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from polyspec.orm.group_rows import GroupRow
from . import testcase


class GroupRowDriverCellFormsTest(unittest.TestCase):
    # The forms of a count that only a driver cell holds: a text, a float and a repeated column. The answer of a listener holds
    # none of them, since its count is a JSON number and its row a JSON object (PRT-69), so the collection recipe cannot write
    # them (FCV-2). Requirements: INT-68, INT-90.
    def test_driver_cell_forms(self):
        for count in (
            "three",
            "-1",
            "00",
            "+1",
            "",
            "9007199254740992",
            1.5,
            -1.0,
            9007199254740992.0,
        ):
            with self.subTest(count=count):
                with self.assertRaises(OrmError) as caught:
                    GroupRow([("row_count", count)])
                self.assertEqual(caught.exception.code, codes.CODEC_DECODE)
        for count, want in (
            ("0", 0),
            ("9007199254740991", 9007199254740991),
            (3.0, 3),
            (9007199254740991.0, 9007199254740991),
        ):
            with self.subTest(valid_count=count):
                row = GroupRow([("row_count", count)])
                self.assertEqual(row.count, want)
                self.assertEqual(row.to_array()["row_count"], want)
        with self.assertRaises(OrmError) as caught:
            GroupRow([("row_count", 1), ("row_count", 2)])
        self.assertEqual(caught.exception.code, codes.CONFIG)


if __name__ == "__main__":
    testcase.main()
