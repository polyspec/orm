# Group rows (docs/spec/interfaces.md "GroupRow"): a row count that is not an exact nonnegative integer fails with
# CODEC_DECODE, and a row with no row_count is INTERNAL.
import unittest

from polyspec.orm import codes
from polyspec.orm.errors import OrmError
from polyspec.orm.group_rows import GroupRow
from polyspec.orm.model_exec import _group_value
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
    # Requirements: INT-68, PRT-69, INT-1. The grouped row preserves its selected value and public output representation.
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
