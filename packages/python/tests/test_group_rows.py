# Group rows (docs/spec/interfaces.md "GroupRow"): a row count that is not an exact nonnegative integer fails with
# CODEC_DECODE, and a row with no row_count is INTERNAL.
import unittest

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from polyspec.orm.group_rows import GroupRow
from . import testcase


class GroupRowCountTest(unittest.TestCase):
    # Requirements: INT-90.
    def test_negative_row_count_is_codec_decode(self):
        for count in (-1, "-1", -1.0):
            with self.subTest(count=count):
                with self.assertRaises(OrmError) as caught:
                    GroupRow([("status", "open"), ("row_count", count)])
                self.assertEqual(caught.exception.code, codes.CODEC_DECODE)

    # Requirements: INT-90.
    def test_missing_row_count_is_internal(self):
        with self.assertRaises(OrmError) as caught:
            GroupRow([("status", "open")])
        self.assertEqual(caught.exception.code, codes.INTERNAL)


if __name__ == "__main__":
    testcase.main()
