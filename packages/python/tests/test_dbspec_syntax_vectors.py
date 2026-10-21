# The shared token vectors of tests/dbspec/syntax.json: every runtime matches them exactly. The inputs are
# built as scripts/dbspec/syntax-vectors.mts vectorInputs builds them, and every case must be present.
import json
import unittest
from pathlib import Path


from polyspec.orm.dbspec import analyze_dbspec
from .dbspec_cases_reader import read_cases
from .vector_case import VectorCase, vector_tests
from . import testcase

ROOT = Path(__file__).resolve().parents[3]
SECTIONS = ("canonical", "normalize", "invalid")


def join(lines, crlf, mixed=False):
    """Mirrors join in the generator: LF, CRLF when crlf, or alternating CRLF and LF with no final line end when mixed."""
    if mixed:
        last = len(lines) - 1
        return "".join(
            line if i == last else line + ("\r\n" if i % 2 == 0 else "\n")
            for i, line in enumerate(lines)
        )
    end = "\r\n" if crlf else "\n"
    return end.join(lines) + end


def header_name(lines):
    return lines[0].split(" ")[2]


def vector_inputs(cases):
    """The (id, text, documents) of every analysis the vectors need, in file order (mirrors vectorInputs)."""
    inputs = []
    for section in SECTIONS:
        for case in cases[section]:
            main = case["documents"][case["main"]]
            documents = {
                name: join(lines, case.get("crlf") is True, case.get("mixed") is True)
                for name, lines in case["documents"].items()
                if name != case["main"]
            }
            inputs.append(
                (
                    f"{section}.{case['id']}",
                    join(main, case.get("crlf") is True, case.get("mixed") is True),
                    documents,
                )
            )
    for case in cases["sets"]:
        everything = case["documents"] + case.get("external", [])
        for i, lines in enumerate(case["documents"]):
            documents = {
                name: join(other, False) for name, other in case["parsing"].items()
            }
            for j, other in enumerate(everything):
                if j != i:
                    documents[header_name(other)] = join(other, False)
            inputs.append((f"sets.{case['id']}.{i + 1}", join(lines, False), documents))
    for case in cases["hashes"]:
        for name in case["documents"]:
            documents = {
                other: join(lines, False)
                for other, lines in case["documents"].items()
                if other != name
            }
            inputs.append(
                (
                    f"hashes.{case['id']}.{name}",
                    join(case["documents"][name], False),
                    documents,
                )
            )
    return inputs


def read_vectors():
    with open(ROOT / "tests" / "dbspec" / "syntax.json", encoding="utf-8") as handle:
        return json.load(handle)


class Case(VectorCase):
    """A case of the vector file of this module."""


def load_tests(
    loader: unittest.TestLoader, tests: unittest.TestSuite, _pattern: object
) -> unittest.TestSuite:
    """The tokens of each case match the shared vectors: one test for each case, named by the case id."""
    inputs = {
        case_id: (text, documents)
        for case_id, text, documents in vector_inputs(read_cases())
    }

    def check_case(test: unittest.TestCase, case: dict) -> None:
        test.assertIn(case["id"], inputs, "the case has no input in cases.json")
        text, documents = inputs[case["id"]]
        found = [
            [t.line, t.start, t.end, t.token_class]
            for t in analyze_dbspec(text, documents).tokens
        ]
        test.assertEqual(found, case["tokens"])

    tests.addTests(vector_tests(Case, read_vectors()["cases"], check_case))
    return tests


if __name__ == "__main__":
    testcase.main()
