# A SQLite connection refuses a SQLite library older than 3.46 with CAPABILITY_UNSUPPORTED, as every client does
# (docs/spec/dialects.md). Python links the SQLite of the system, so the version is the module's sqlite_version, which the case
# replaces to stand for an older library; a supported version connects.
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from polyspec.orm.database import Db
from polyspec.orm.errors import OrmError
from . import testcase


class SqliteVersionTest(unittest.TestCase):
    def connect(self, version: str):
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(sqlite3, "sqlite_version", version),
        ):
            db = Db.connect(f"sqlite://{Path(directory) / 'v.sqlite'}")
            db.close()

    def test_refuses_older_than_3_46(self):
        for version in ["3.45.3", "3.9.0", "2.8.17"]:
            with self.subTest(version=version):
                with self.assertRaises(OrmError) as raised:
                    self.connect(version)
                self.assertEqual(raised.exception.code, "CAPABILITY_UNSUPPORTED")
                self.assertEqual(
                    str(raised.exception),
                    f"CAPABILITY_UNSUPPORTED: SQLite {version} is older than 3.46",
                )

    def test_accepts_3_46_and_later(self):
        for version in ["3.46.0", "3.50.4", "4.0.0"]:
            with self.subTest(version=version):
                self.connect(version)


if __name__ == "__main__":
    testcase.main()
