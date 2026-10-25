import json
import unittest

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.params import param_uses
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError
from polyspec.orm.markdown import MdNode
from .coverage_case import REPOSITORY_ROOT


class ColumnFunctionMetadataTest(unittest.TestCase):
    def setUp(self):
        fixture = json.loads(
            (REPOSITORY_ROOT / "contracts/fixtures/planner.json").read_text(
                encoding="utf-8"
            )
        )
        self.case = next(
            case
            for case in fixture["cases"]
            if case["id"] == "planner_column_function_date"
        )
        schema = (REPOSITORY_ROOT / self.case["schema"]).read_text(encoding="utf-8")
        self.model = model_of_documents(parse_document_set([schema]))

    def test_missing_post_validation_field_is_internal(self):
        request = dict(self.case["input"], manifest_hash=self.model.manifest_hash)
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

    def test_markdown_assembly_rejects_missing_post_validation_field(self):
        request = {
            "ir_version": 1,
            "manifest_hash": self.model.manifest_hash,
            "kind": "all",
            "n_params": 0,
            "entity": "author",
            "columns": {
                "mode": "none",
                "fn": {"selected_year": {"column": "start_dt", "fn": {"name": "year"}}},
            },
        }
        validate(self.model, request)
        request["columns"]["fn"]["selected_year"]["column"] = "missing_column"
        with self.assertRaises(OrmError) as error:
            MdNode(self.model, request, False).out_col("selected_year", 0)
        self.assertEqual(error.exception.code, "INTERNAL")
        self.assertIn("author.missing_column", str(error.exception))


if __name__ == "__main__":
    unittest.main()
