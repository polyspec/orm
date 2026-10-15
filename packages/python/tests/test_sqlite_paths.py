# sqlite-paths: every case of tests/dsn/sqlite-paths.json connects with sqlite://<directory>/<path> in a new temporary
# directory. A DSN path is percent-decoded to the file it opens, and an invalid path fails with its code and leaves
# the directory empty (docs/config.md "Runtime connection"), as packages/ts/tests/dsn.mjs and the other clients' tests
# do. Each case is a test named by its id.
import json
import os
import tempfile
import unittest
from pathlib import Path

from polyspec.orm import OrmError, connect
from . import testcase
from .vector_case import VectorCase, vector_tests

ROOT = Path(__file__).resolve().parents[3]
VECTORS = json.loads(
    (ROOT / "tests" / "dsn" / "sqlite-paths.json").read_text(encoding="utf-8")
)


def check_case(test: unittest.TestCase, case: dict) -> None:
    with tempfile.TemporaryDirectory(prefix="orm-python-sqlite-path-") as directory:
        code = None
        try:
            connect(f"sqlite://{directory}/{case['path']}").close()
        except OrmError as error:
            code = error.code
        names = sorted(os.listdir(directory))
    if "error" in case:
        test.assertEqual(
            (code, names), (case["error"], []), "the error code and no file"
        )
        return
    test.assertIsNone(code)
    allowed = {case["file"] + suffix for suffix in ("", "-journal", "-shm", "-wal")}
    test.assertEqual(
        [name for name in names if name not in allowed],
        [],
        f"files other than {case['file']}",
    )
    test.assertIn(case["file"], names)


class Case(VectorCase):
    """A case of sqlite-paths.json."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of the file, named by the case id."""
    if VECTORS["version"] != 1 or not VECTORS["cases"]:
        raise ValueError("tests/dsn/sqlite-paths.json has no cases")
    tests.addTests(vector_tests(Case, VECTORS["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
