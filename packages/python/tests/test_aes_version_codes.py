# Requirements: COD-48, COD-55, COD-56 (native, FCV-2); the other AES version codes are recipe cases.
# The codes of AES key-version failures: an undeclared key version is CONFIG, a stored version that is not a positive
# 32-bit integer is CODEC_DECODE on the read path and on the rotation path, and an AES column or version column that the
# client selected but did not get is INTERNAL.
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from polyspec.orm.aes import AesKeyring
from polyspec.orm.codec import host_encode
from polyspec.orm.database import Db, _decode_assembly
from polyspec.orm.errors import OrmError

from . import testcase

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
    # Requirements: COD-8.
    def test_connection_rejects_aes_key_that_differs_from_current_keyring_key(self):
        with TemporaryDirectory(prefix="orm-aes-key-conflict-") as directory:
            database = Path(directory) / "must-not-open.sqlite"
            with self.assertRaises(OrmError) as caught:
                Db.connect(
                    f"sqlite://{database}",
                    {
                        "aesKey": "different-key",
                        "aesVersion": 1,
                        "aesKeyring": AesKeyring({1: "current-key"}, 1),
                    },
                )
            self.assertEqual(caught.exception.code, "CONFIG")
            self.assertFalse(database.exists(), "config validation opened SQLite")

    # Requirements: INT-74, INT-130.
    def test_keyring_exposes_current_version_and_sorted_versions(self):
        keyring = AesKeyring({3: "third", 1: "first", 2: "second"}, 2)
        self.assertEqual(keyring.current_version, 2)
        self.assertEqual(keyring.versions(), [1, 2, 3])

    # Requirements: COD-56. A read plan cannot infer a missing version column.
    def test_read_plan_without_version_column_is_internal(self):
        no_version = {
            key: value for key, value in ASSEMBLE.items() if key != "aes_version"
        }
        row = [CIPHER, 1]
        self.assertEqual(
            code_of(lambda: _decode_assembly(row, no_version, DB)), "INTERNAL"
        )

    # Requirements: COD-48. A selected encrypted row missing its version cell is an internal invariant failure.
    def test_read_row_without_version_cell_is_internal(self):
        row = [CIPHER]
        self.assertEqual(
            code_of(lambda: _decode_assembly(row, ASSEMBLE, DB)), "INTERNAL"
        )

    # Requirements: COD-55. Rotation requires the AES column and the version column in the row.
    def test_rotation_codes(self):
        cases = [
            ({"aes_key_version": 1}, "INTERNAL"),
            ({"email": CIPHER}, "INTERNAL"),
        ]
        for row, want in cases:
            with self.subTest(row=row):
                got = code_of(
                    lambda r=row: KEYRING.rotate_row(r, "aes_key_version", [COLUMN], 2)
                )
                self.assertEqual(got, want)


if __name__ == "__main__":
    testcase.main()
