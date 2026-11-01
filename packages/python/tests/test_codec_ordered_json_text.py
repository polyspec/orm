# A text that is not a sequence of Unicode scalar values is no JSON text (RFC 8259, 8.1), so an ordered_json stage returns
# CODEC_ENCODE for it (COD-64); a recipe text is a JSON string, which holds Unicode only, so each client tests this.
# Requirements: COD-64.
import unittest

from polyspec.orm.codec import CodecError, encode
from polyspec.orm.styled_value import StyledValue
from . import testcase


class CodecOrderedJsonTextTest(unittest.TestCase):
    deadline = testcase.COMPUTE

    def test_ordered_json_refuses_a_text_that_is_not_unicode(self):
        # A lone surrogate is a Python str that is no sequence of Unicode scalar values.
        with self.assertRaises(CodecError) as caught:
            encode(["ordered_json"], StyledValue.value("\ud800"))
        self.assertEqual(caught.exception.code, "CODEC_ENCODE")


if __name__ == "__main__":
    testcase.main()
