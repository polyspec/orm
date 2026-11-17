"""Requirements: INT-191, PRT-91. Dynamic request shape before schema lookup."""

# Requirements: INT-191, PRT-91.
import copy
import json
from pathlib import Path
import tempfile
import unittest

from polyspec.orm import OrmError
from .models import models
from . import testcase

CASES = {
    case["id"]: case
    for case in json.loads(
        (Path(__file__).parents[3] / "tests/ir/restore-analysis-shape.json").read_text()
    )
}


class RestoreAnalysisShapeTest(unittest.TestCase):
    def check_shape(self, name):
        fixture = CASES[name]
        with tempfile.TemporaryDirectory(prefix="orm-restore-shape-") as directory:
            db = models.connect(f"sqlite://{directory}/shape.sqlite")
            request = copy.deepcopy(fixture["request"])
            if fixture.get("use_fixture_hash", False):
                request["manifest_hash"] = models.MANIFEST_HASH
            before = copy.deepcopy(request)
            try:
                if "analysis" in fixture:
                    self.assertEqual(db.analyze_restore(request), fixture["analysis"])
                else:
                    with self.assertRaises(OrmError) as caught:
                        db.analyze_restore(request)
                    self.assertEqual(caught.exception.code, fixture["code"])
                    self.assertEqual(str(caught.exception), fixture["message"])
                self.assertEqual(request, before, "analysis preserves the raw request")
            finally:
                db.close()

    def test_manifest_type(self):
        self.check_shape("manifest_type")

    def test_missing_manifest(self):
        self.check_shape("missing_manifest")

    def test_null_manifest(self):
        self.check_shape("null_manifest")

    def test_null_predicate_column(self):
        self.check_shape("null_predicate_column")


if __name__ == "__main__":
    testcase.main()
