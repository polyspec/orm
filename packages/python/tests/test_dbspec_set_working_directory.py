# A set path without a directory, whose root is the working directory (docs/spec/dbspec.md "Document sets"): the working
# directory is the state of a process, so no recipe step can state it (FCV-2).
# Requirements: DBS-12.
import os
import tempfile
import unittest
from pathlib import Path

from polyspec.orm.dbspec import read_dbspec_set

from . import testcase


class SetWorkingDirectoryTest(unittest.TestCase):
    def test_a_set_path_without_a_directory_reads_from_the_working_directory(self):
        with tempfile.TemporaryDirectory(prefix="orm-set-working-directory-") as root:
            (Path(root) / "shop.dbs").write_bytes(b"dbspec 1 shop\n")
            (Path(root) / "dbspec-set.json").write_bytes(
                b'{"schema": 1, "documents": ["shop.dbs"]}'
            )
            previous = os.getcwd()
            os.chdir(root)
            try:
                result, errors = read_dbspec_set("dbspec-set.json")
            finally:
                os.chdir(previous)
        self.assertEqual(errors, ())
        self.assertEqual(
            [(file.path, file.data) for file in result.documents],
            [("shop.dbs", b"dbspec 1 shop\n")],
        )
        self.assertEqual(list(result.external), [])


if __name__ == "__main__":
    testcase.main()
