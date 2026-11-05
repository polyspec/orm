import json
import unittest
from packages.python.tests import testcase

from polyspec.orm.engine import model_of_documents, parse_document_set
from polyspec.orm.engine.dialect import dialect_of
from polyspec.orm.engine.planner import Planner
from polyspec.orm.engine.validate import validate
from polyspec.orm.errors import OrmError
from polyspec.orm.markdown import MdNode

from .coverage_case import REPOSITORY_ROOT


def scalar_subquery_case():
    """The planner_scalar_column_subquery step of tests/planner/compile.json and the model of its schema."""
    recipe = json.loads(
        (REPOSITORY_ROOT / "tests/planner/compile.json").read_text(encoding="utf-8")
    )
    case = next(
        case["steps"][0]
        for case in recipe["cases"]
        if case["id"] == "planner_scalar_column_subquery"
    )
    schema = (REPOSITORY_ROOT / "tests/planner" / case["schema"]).resolve()
    return case, model_of_documents(
        parse_document_set([schema.read_text(encoding="utf-8")])
    )


class ScalarSubqueryTypeTest(unittest.TestCase):
    def test_missing_post_validation_column_is_internal(self):
        case, model = scalar_subquery_case()
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
    testcase.main()
