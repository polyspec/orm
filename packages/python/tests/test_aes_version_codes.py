# Requirements: COD-44.
# The codes of AES key-version failures: an undeclared key version is CONFIG, a stored version that is not a positive
# 32-bit integer is CODEC_DECODE on the read path and on the rotation path, and an AES column or version column that the
# client selected but did not get is INTERNAL.
import unittest
from types import SimpleNamespace

from . import testcase
from polyspec.orm.aes import AesKeyring, _stored_version
from polyspec.orm.codec import host_encode
from polyspec.orm.database import _decode_assembly
from polyspec.orm.errors import OrmError

KEYRING = AesKeyring({1: "old-key", 2: "new-key"}, 2)
DB = SimpleNamespace(aes_keyring=KEYRING, aes_key="new-key")
CIPHER = host_encode("value", ["aes", "hex"], "old-key")
ASSEMBLE = {
    "entity": "Account",
    "children": [],
    "aes_version": 1,
    "columns": [
        {"index": 0, "name": "email", "styles": ["aes", "hex"]},
        {"index": 1, "name": "aes_key_version", "styles": []},
    ],
}
COLUMN = SimpleNamespace(name="email", styles=["aes", "hex"])


def code_of(run) -> str:
    try:
        run()
    except OrmError as error:
        return error.code
    return ""


class AesVersionCodesTest(unittest.TestCase):
    def test_read_path_codes(self):
        cases = [
            ("abc", "CODEC_DECODE"),
            (0, "CODEC_DECODE"),
            (2**31, "CODEC_DECODE"),
            (9, "CONFIG"),
            ("1", ""),
        ]
        for stored, want in cases:
            with self.subTest(stored=stored):
                row = [CIPHER, stored]
                got = code_of(lambda: _decode_assembly(row, ASSEMBLE, DB))
                self.assertEqual(got, want)

    def test_stored_version_accepts_only_positive_i32(self):
        self.assertEqual(_stored_version("2"), 2)
        self.assertEqual(_stored_version(2147483647), 2147483647)
        for bad in ["1x", "", True, -1, 0, 2**31, 1.0, None]:
            with self.subTest(value=bad):
                self.assertEqual(code_of(lambda: _stored_version(bad)), "CODEC_DECODE")

    def test_read_plan_without_version_column_is_internal(self):
        no_version = {key: value for key, value in ASSEMBLE.items() if key != "aes_version"}
        row = [CIPHER, 1]
        self.assertEqual(code_of(lambda: _decode_assembly(row, no_version, DB)), "INTERNAL")

    def test_read_keyring_lacks_stored_version_is_config(self):
        single = host_encode("value", ["aes", "hex"], "single-key")
        db = SimpleNamespace(aes_keyring=KEYRING, aes_key="single-key")
        row = [single, 9]
        self.assertEqual(code_of(lambda: _decode_assembly(row, ASSEMBLE, db)), "CONFIG")

    def test_read_null_version_with_aes_value_is_codec_decode(self):
        row = [CIPHER, None]
        self.assertEqual(code_of(lambda: _decode_assembly(row, ASSEMBLE, DB)), "CODEC_DECODE")

    def test_read_null_aes_with_null_version_stays_null(self):
        row = [None, None]
        self.assertEqual(code_of(lambda: _decode_assembly(row, ASSEMBLE, DB)), "")
        self.assertIsNone(row[0])

    def test_rotation_null_aes_is_left_unchanged(self):
        for row in ({"aes_key_version": None, "email": None}, {"aes_key_version": 1, "email": None}):
            with self.subTest(row=row):
                got = KEYRING.rotate_row(dict(row), "aes_key_version", [COLUMN], 2)
                self.assertEqual(got, row)

    def test_rotation_codes(self):
        cases = [
            ({"aes_key_version": 0, "email": CIPHER}, "CODEC_DECODE"),
            ({"aes_key_version": 9, "email": CIPHER}, "CONFIG"),
            ({"aes_key_version": 1}, "INTERNAL"),
            ({"email": CIPHER}, "INTERNAL"),
        ]
        for row, want in cases:
            with self.subTest(row=row):
                got = code_of(lambda: KEYRING.rotate_row(row, "aes_key_version", [COLUMN], 2))
                self.assertEqual(got, want)


if __name__ == "__main__":
    testcase.main()
