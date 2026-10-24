import json
import unittest

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError
from polyspec.orm.markdown import MdNode
from .coverage_case import REPOSITORY_ROOT


class ScalarSubqueryTypeTest(unittest.TestCase):
    def test_missing_post_validation_column_is_internal(self):
        fixture = json.loads(
            (REPOSITORY_ROOT / "contracts/fixtures/planner.json").read_text(
                encoding="utf-8"
            )
        )
        case = next(
            case
            for case in fixture["cases"]
            if case["id"] == "planner_scalar_column_subquery"
        )
        schema = (REPOSITORY_ROOT / case["schema"]).read_text(encoding="utf-8")
        model = model_of_documents(parse_document_set([schema]))
        request = dict(case["input"], manifest_hash=model.manifest_hash)
        validate(model, request)
        request["columns"]["sub"]["first_author"]["column"] = "missing_column"
        with self.subTest(caller="markdown answer assembly"):
            try:
                MdNode(model, request, False).out_col("first_author", 0)
            except OrmError as error:
                self.assertEqual(error.code, "INTERNAL")
                self.assertIn("author.missing_column", str(error))
            else:
                self.fail(
                    "markdown answer assembly accepted a missing post-validation scalar column"
                )
        for dialect in ("mysql", "postgres", "sqlite"):
            with self.subTest(dialect=dialect):
                caught = None
                try:
                    Planner(model, dialect_of(dialect)()).compile(request)
                except OrmError as error:
                    caught = error
                self.assertIsNotNone(
                    caught,
                    "planner accepted a missing post-validation scalar subquery column",
                )
                assert caught is not None
                self.assertEqual(caught.code, "INTERNAL")
                self.assertIn("author.missing_column", str(caught))


if __name__ == "__main__":
    unittest.main()
