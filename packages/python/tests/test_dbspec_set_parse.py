# The shared set parse vectors of tests/dbspec/set-parse.json (docs/dbspec.md "Parsing a set"): every
# case runs parse_dbspec_set on its owned and external texts and compares each document's name,
# external mark, whether it parsed and its diagnostics.
import json
import unittest
from pathlib import Path
from typing import Any

from polyspec.orm.dbspec import parse_dbspec_set
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / "tests" / "dbspec" / "set-parse.json"


def _diagnostic(d, full):
    out = {"rule": d.rule, "line": d.line, "column": d.column}
    if full:
        out["message"] = d.message
    return out


class Case(VectorCase):
    """A case of tests/dbspec/set-parse.json."""


def check_case(test: unittest.TestCase, case: Any) -> None:
    """The case's texts parse to its documents: name, external mark, parsed, diagnostics."""
    test.assertEqual(set(case), {"id", "name", "owned", "external", "documents"})
    got = parse_dbspec_set(case["owned"], case["external"])
    test.assertEqual(len(got), len(case["documents"]))
    for doc, want in zip(got, case["documents"]):
        test.assertEqual(doc.name, want["name"])
        test.assertEqual(doc.external, want["external"])
        test.assertEqual(doc.document is not None, want["parsed"])
        if doc.document is not None:
            test.assertEqual(doc.document.external, want["external"])
        test.assertEqual(
            [
                _diagnostic(d, "message" in w)
                for d, w in zip(doc.diagnostics, want["diagnostics"])
            ],
            want["diagnostics"],
        )
        test.assertEqual(len(doc.diagnostics), len(want["diagnostics"]))


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """One test for each case of set-parse.json, named by its id."""
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    if data["schema"] != 1 or not data["cases"]:
        raise ValueError(f"{VECTORS}: schema 1 with cases is required")
    tests.addTests(vector_tests(Case, data["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
