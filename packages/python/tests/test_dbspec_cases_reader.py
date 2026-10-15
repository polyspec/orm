# The reader of tests/dbspec/cases.json (dbspec_cases_reader.py) refuses a missing or an unknown section or field of
# every section, naming it, as the readers of the other runtimes do.
import json
import unittest
from pathlib import Path

from .dbspec_cases_reader import CasesError, check_cases
from . import testcase

ROOT = Path(__file__).resolve().parents[3]


class DbspecCasesReaderTest(unittest.TestCase):
    """The reader of cases.json refuses a missing or an unknown section or field of every section, naming it."""

    def test_rejects_missing_and_unknown_fields(self):
        with open(ROOT / "tests" / "dbspec" / "cases.json", encoding="utf-8") as handle:
            text = handle.read()
        manifest = next(
            i for i, c in enumerate(json.loads(text)["sets"]) if "manifest" in c
        )
        mutations = (
            ("note", "is missing", lambda v: v.pop("note")),
            ("extra", "is not a known field", lambda v: v.update(extra=[])),
            (
                "canonical[0].extra",
                "is not a known field",
                lambda v: v["canonical"][0].update(extra=True),
            ),
            (
                "normalize[0].canonical",
                "is missing",
                lambda v: v["normalize"][0].pop("canonical"),
            ),
            (
                "invalid[0].errors[0].extra",
                "is not a known field",
                lambda v: v["invalid"][0]["errors"][0].update(extra=1),
            ),
            (
                "hashes[0].extra",
                "is not a known field",
                lambda v: v["hashes"][0].update(extra=True),
            ),
            (
                "sets[0].extra",
                "is not a known field",
                lambda v: v["sets"][0].update(extra=True),
            ),
            (
                f"sets[{manifest}].manifest.extra",
                "is not a known field",
                lambda v: v["sets"][manifest]["manifest"].update(extra=[]),
            ),
            ("files[0].errors", "is missing", lambda v: v["files"][0].pop("errors")),
            (
                "positions[0].positions[0].extra",
                "is not a known field",
                lambda v: v["positions"][0]["positions"][0].update(extra=1),
            ),
            (
                "positions[0].positions[0].line",
                "is not an integer",
                lambda v: v["positions"][0]["positions"][0].update(line=True),
            ),
        )
        for location, problem, change in mutations:
            with self.subTest(location=location):
                value = json.loads(text)
                change(value)
                with self.assertRaises(CasesError) as raised:
                    check_cases(value)
                self.assertEqual(
                    str(raised.exception),
                    f"tests/dbspec/cases.json: {location} {problem}",
                )


if __name__ == "__main__":
    testcase.main()
