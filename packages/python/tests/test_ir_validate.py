# Shared validation cases (tests/ir/validate.json): adds the schema's manifest_hash to each request, gives it only to the validator,
# and checks that it accepts or fails with the expected error code. Go, PHP, Rust and TypeScript read the same file from their own
# package.
import json
import unittest
from pathlib import Path
from . import testcase

ROOT = Path(__file__).resolve().parents[3]

from polyspec.orm.engine import model_of_documents, parse_document_set  # noqa: E402
from polyspec.orm.engine.validate import validate  # noqa: E402
from polyspec.orm.errors import OrmError  # noqa: E402
from .vector_case import VectorCase, vector_tests  # noqa: E402


FILE = json.loads((ROOT / "tests" / "ir" / "validate.json").read_text())


def check_case(test: unittest.TestCase, case: dict) -> None:
    request = dict(case["request"], manifest_hash=MODEL.manifest_hash)
    if case.get("valid"):
        validate(MODEL, request)
        return
    with test.assertRaises(OrmError) as raised:
        validate(MODEL, request)
    test.assertEqual(raised.exception.code, case["error"])


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each validation case, named by the case."""
    global MODEL
    if FILE["schema"] != "contracts/fixtures/bench/bench.dbs" or not FILE["cases"]:
        raise AssertionError(
            "validate.json names contracts/fixtures/bench/bench.dbs and has cases"
        )
    MODEL = model_of_documents(
        parse_document_set([(ROOT / FILE["schema"]).read_text()])
    )
    tests.addTests(
        vector_tests(Case, FILE["cases"], check_case, lambda case: case["name"])
    )
    return tests


if __name__ == "__main__":
    testcase.main()
