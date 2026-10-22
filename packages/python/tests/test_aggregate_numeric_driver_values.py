# The driver values of an aggregate scalar beyond the cases of contracts/fixtures/aggregate_numeric.json: a Decimal and its
# text give the same value, and a boolean is no number.
import unittest
from decimal import Decimal

from polyspec.orm.errors import OrmError
from polyspec.orm.model_exec import _aggregate_number
from . import testcase


class DriverValueTest(unittest.TestCase):
    # Requirements: DSL-66.
    def test_decimal_and_text_give_the_same_value(self) -> None:
        self.assertEqual(
            _aggregate_number(Decimal("48.0450")), _aggregate_number("48.0450")
        )

    def test_a_boolean_is_no_number(self) -> None:
        with self.assertRaises(OrmError) as raised:
            _aggregate_number(True)
        self.assertEqual(raised.exception.code, "CODEC_DECODE")


if __name__ == "__main__":
    testcase.main()
