import copy
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
    """The planner_scalar_column_subquery case of contracts/fixtures/planner.json and the model of its schema."""
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
    return case, model_of_documents(parse_document_set([schema]))


class ScalarSubqueryTypeTest(unittest.TestCase):
    # Requirements: DIA-33.
    def test_all_columns_select_aes_version_once(self):
        schema = (REPOSITORY_ROOT / "contracts/fixtures/bench/bench.dbs").read_text(
            encoding="utf-8"
        )
        model = model_of_documents(parse_document_set([schema]))
        request = {
            "ir_version": 1,
            "manifest_hash": model.manifest_hash,
            "kind": "one",
            "entity": "author",
            "n_params": 1,
            "where": {"items": [{"pred": {"column": "seq", "op": "eq", "p": 0}}]},
        }
        validate(model, request)
        for dialect in ("mysql", "postgres", "sqlite"):
            with self.subTest(dialect=dialect):
                for selection, columns in (
                    ("selected", {"mode": "all"}),
                    ("default", None),
                ):
                    with self.subTest(selection=selection):
                        selected_request = dict(request)
                        if columns is not None:
                            selected_request["columns"] = columns
                        step = Planner(model, dialect_of(dialect)()).compile(
                            selected_request
                        )["steps"][0]
                        quote = "`" if dialect == "mysql" else '"'
                        version_column = (
                            f"{quote}a{quote}.{quote}aes_key_version{quote} AS "
                        )
                        self.assertEqual(step["sql"].count(version_column), 1)
                        assemble = step["assemble"]
                        version = assemble["aes_version"]
                        column = assemble["columns"][version]
                        self.assertEqual(column["column"], "aes_key_version")
                        self.assertEqual(column["hidden"], selection == "default")

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

    # Requirements: PRT-69.
    def test_scalar_subquery_aggregate_types_remain_i64_and_f64(self):
        case, model = scalar_subquery_case()
        for aggregate, column, expected in (
            ("count", "", "i64"),
            ("avg", "read_count", "f64"),
        ):
            with self.subTest(aggregate=aggregate):
                request = copy.deepcopy(case["input"])
                request["manifest_hash"] = model.manifest_hash
                selected = request["columns"]["sub"]["first_author"]
                selected["agg"] = aggregate
                selected["column"] = column
                selected["query"].pop("limit", None)
                selected["query"].pop("order", None)
                validate(model, request)
                plan = Planner(model, dialect_of("sqlite")()).compile(request)
                output = next(
                    item
                    for item in plan["steps"][0]["assemble"]["columns"]
                    if item["name"] == "first_author"
                )
                self.assertEqual(output["type"], expected)


if __name__ == "__main__":
    testcase.main()
