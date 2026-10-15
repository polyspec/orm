# The shared set parse vectors of tests/dbspec/set-parse.json (docs/dbspec.md "Parsing a set"): every
# case runs parse_dbspec_set on its owned and external texts and compares each document's name,
# external mark, whether it parsed and its diagnostics.
import json
import unittest
from pathlib import Path

from polyspec.orm.dbspec import parse_dbspec_set
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / "tests" / "dbspec" / "set-parse.json"


def _diagnostic(d, full):
    out = {"rule": d.rule, "line": d.line, "column": d.column}
    if full:
        out["message"] = d.message
    return out


class SetParseVectors(unittest.TestCase):
    def test_vectors(self):
        data = json.loads(VECTORS.read_text(encoding="utf-8"))
        self.assertEqual(data["schema"], 1)
        self.assertTrue(data["cases"])
        for case in data["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(set(case), {"name", "owned", "external", "documents"})
                got = parse_dbspec_set(case["owned"], case["external"])
                self.assertEqual(len(got), len(case["documents"]))
                for doc, want in zip(got, case["documents"]):
                    self.assertEqual(doc.name, want["name"])
                    self.assertEqual(doc.external, want["external"])
                    self.assertEqual(doc.document is not None, want["parsed"])
                    if doc.document is not None:
                        self.assertEqual(doc.document.external, want["external"])
                    self.assertEqual(
                        [
                            _diagnostic(d, "message" in w)
                            for d, w in zip(doc.diagnostics, want["diagnostics"])
                        ],
                        want["diagnostics"],
                    )
                    self.assertEqual(len(doc.diagnostics), len(want["diagnostics"]))


if __name__ == "__main__":
    testcase.main()
