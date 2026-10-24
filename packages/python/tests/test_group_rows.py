# Group rows (docs/spec/interfaces.md "GroupRow"): a row count that is not an exact nonnegative integer fails with
# CODEC_DECODE, and a row with no row_count is INTERNAL.
import unittest

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from polyspec.orm.group_rows import GroupRow
from polyspec.orm.model_exec import _group_value
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

    def test_count_exactness(self):
        for count in (
            True,
            1.5,
            -1,
            9007199254740992,
            9007199254740992.0,
            "9007199254740992",
        ):
            with self.subTest(count=count):
                with self.assertRaises(OrmError) as caught:
                    GroupRow([("row_count", count)])
                self.assertEqual(caught.exception.code, codes.CODEC_DECODE)
        with self.assertRaises(OrmError) as caught:
            GroupRow([("selected", "x")])
        self.assertEqual(caught.exception.code, codes.INTERNAL)
        for count, want in (
            (0, 0),
            ("0", 0),
            (9007199254740991, 9007199254740991),
            ("9007199254740991", 9007199254740991),
        ):
            with self.subTest(valid_count=count):
                row = GroupRow([("row_count", count)])
                self.assertEqual(row.count, want)
                self.assertEqual(row.to_array()["row_count"], want)


class GroupBooleanValueTest(unittest.TestCase):
    # PRT-36: a non-boolean stored value is not coerced to a truth value.
    def test_group_boolean_rejects_non_boolean_float(self):
        with self.assertRaises(OrmError) as caught:
            _group_value(
                None,
                {"name": "active", "column": "", "type": "bool"},
                1.0,
                None,
            )
        self.assertEqual(caught.exception.code, codes.CODEC_DECODE)
        self.assertIn("active is not boolean", str(caught.exception))


class GroupExactI64ValueTest(unittest.TestCase):
    def test_group_result_preserves_exact_i64_value(self):
        want = 9007199254740991
        value = _group_value(
            None,
            {"name": "exact_value", "column": "", "type": "i64"},
            want,
            None,
        )
        row = GroupRow([("exact_value", value), ("row_count", 1)])
        self.assertEqual(value, want)
        self.assertEqual(row.value("exact_value"), want)
        self.assertEqual(row.to_array(), {"exact_value": want, "row_count": 1})


if __name__ == "__main__":
    testcase.main()
