import json
import unittest
from . import testcase

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.params import param_uses
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError
from .coverage_case import CASE_ROOT


class ColumnFunctionMetadataTest(unittest.TestCase):
    def setUp(self):
        recipe = json.loads(
            (CASE_ROOT / "tests/planner/compile.json").read_text(encoding="utf-8")
        )
        self.step = next(
            case["steps"][0]
            for case in recipe["cases"]
            if case["id"] == "planner_column_function_date"
        )
        schema = (CASE_ROOT / "tests/planner" / self.step["schema"]).resolve()
        self.model = model_of_documents(
            parse_document_set([schema.read_text(encoding="utf-8")])
        )

    def test_missing_post_validation_field_is_internal(self):
        request = dict(self.step["input"], manifest_hash=self.model.manifest_hash)
        validate(self.model, request)
        self.assertEqual(param_uses(self.model, request)[0][0].type, "date")
        for dialect in ("mysql", "postgres", "sqlite"):
            Planner(self.model, dialect_of(dialect)()).compile(request)
        request["where"]["items"][0]["pred"]["column"] = "missing_column"
        with self.assertRaises(OrmError) as use_error:
            param_uses(self.model, request)
        self.assertEqual(use_error.exception.code, "INTERNAL")
        self.assertIn("author.missing_column", str(use_error.exception))

        for dialect in ("mysql", "postgres", "sqlite"):
            with self.subTest(caller="planner", dialect=dialect):
                with self.assertRaises(OrmError) as planner_error:
                    Planner(self.model, dialect_of(dialect)()).compile(request)
                self.assertEqual(planner_error.exception.code, "INTERNAL")
                self.assertIn("author.missing_column", str(planner_error.exception))


if __name__ == "__main__":
    testcase.main()
