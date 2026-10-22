# Statement comparison of the shared ddl case (tests/dbspec/ddl.json): checks that the Python render writes the
# statements of the three dialects with the same bytes as the other clients. The behavior stage (running against a real database)
# is checked by conformance.
import json
import unittest
from pathlib import Path
from polyspec.orm.dbspec import parse_dbspec
from polyspec.orm.dbspec.render import render_dbspec
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


def parse_set(documents: dict) -> list:
    """Parses the document set of the case; the main document represents the set."""
    out: list = []
    for name, lines in documents.items():
        document, _positions, diagnostics = parse_dbspec(
            "\n".join(lines),
            {k: "\n".join(v) for k, v in documents.items() if k != name},
        )
        if diagnostics:
            raise SystemExit(f"ddl case document {name}: {diagnostics[0]}")
        out.append(document)
    return out


DATA = json.loads((ROOT / "tests" / "dbspec" / "ddl.json").read_text())


def check_case(test: unittest.TestCase, case: dict) -> None:
    documents = parse_set(case["documents"])
    for dialect in ("mysql", "postgres", "sqlite"):
        result = render_dbspec(documents, dialect)
        test.assertIsNotNone(
            result["statements"], f"{case['id']} {dialect}: {result['diagnostics'][:1]}"
        )
        test.assertEqual(
            result["statements"],
            case["statements"][dialect],
            f"{case['id']} {dialect}: rendered statements differ",
        )


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each ddl case, named by the case id."""
    tests.addTests(vector_tests(Case, DATA["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
