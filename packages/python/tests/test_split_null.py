import unittest

from polyspec.orm import codes
from polyspec.orm.database import _split_row_key
from polyspec.orm.errors import OrmError
from packages.python.tests.testcase import COMPUTE


class SplitNullTest(unittest.TestCase):
    deadline = COMPUTE

    def test_split_root_merge_rejects_sql_null_identity(self):
        with self.assertRaises(OrmError) as caught:
            _split_row_key([None], [{"column": "id", "index": 0}])
        self.assertEqual(caught.exception.code, codes.CODEC_DECODE)
        self.assertEqual(
            str(caught.exception),
            "CODEC_DECODE: split query row identity contains SQL NULL",
        )

    def test_split_root_merge_retains_falsey_non_null_identities(self):
        refs = [{"column": "id", "index": 0}]
        self.assertNotEqual(_split_row_key([0], refs), _split_row_key([""], refs))
        self.assertNotEqual(_split_row_key([False], refs), _split_row_key([0], refs))
        self.assertNotEqual(_split_row_key([""], refs), _split_row_key(["0"], refs))


if __name__ == "__main__":
    from packages.python.tests.testcase import main

    main()
