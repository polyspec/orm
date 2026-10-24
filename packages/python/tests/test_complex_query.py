import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from . import testcase
from .complex_query_product import FIXTURE, SCHEMA_PATH, product_search_query
from .test_sqlite import generate_document
from polyspec.orm import codes
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError


class ComplexQueryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory(prefix="orm-complex-query-models-")
        cls.addClassCleanup(temporary.cleanup)
        cls.models = generate_document(
            str(Path(temporary.name) / "models"), SCHEMA_PATH
        )
        cls.runtime = model_of_documents(
            parse_document_set([SCHEMA_PATH.read_text(encoding="utf-8")])
        )

    def assert_fulltext_chain(self, model, method, columns):
        query = model()
        getattr(query, method)("alpha beta")
        built = query.core.build("all")
        request = built.finish()
        predicate = request["where"]["items"][0]["pred"]
        self.assertEqual(
            predicate,
            {"op": "fulltext_boolean", "cols": columns, "p": 0},
        )
        self.assertEqual(built.params, ["alpha beta"])
        for dialect in ("mysql", "postgres"):
            plan = Engine(self.runtime, dialect).compile(request)
            self.assertEqual(len(plan["steps"]), 1)
            slot = plan["steps"][0]["bind_slots"][0]
            self.assertEqual(slot["param"], 0)
            if dialect == "mysql":
                self.assertEqual(slot["transform"], "fulltext_boolean")

    def test_public_fulltext_boolean_chain_builds_typed_ir(self):
        self.assert_fulltext_chain(
            self.models.ProductBrandLang,
            "fulltext_boolean_name_with_description",
            ["name", "description"],
        )
        self.assert_fulltext_chain(
            self.models.ProductLang,
            "fulltext_boolean_name_with_short_description_with_content",
            ["name", "short_description", "content"],
        )
        self.assert_fulltext_chain(
            self.models.Product,
            "fulltext_boolean_name_with_short_description_with_content",
            ["name", "short_description", "content"],
        )

    def test_public_semijoin_product_search_builds_page_plan(self):
        from polyspec.orm import database

        query = product_search_query(self.models, FIXTURE["input"])
        limited = query.core.clone()
        page = FIXTURE["input"]["page"]
        per_page = FIXTURE["input"]["per_page"]
        limited.set_limit((page - 1) * per_page, per_page)
        built = limited.build("paginate")
        self.assertIsNone(built.error)
        request = built.finish()

        for dialect in ("mysql", "postgres"):
            with self.subTest(dialect=dialect):
                plan = Engine(self.runtime, dialect).compile(request)
                expected_steps = FIXTURE["expected_plan_steps"][dialect]
                self.assertEqual(
                    [
                        {"role": step["role"], "tables": step["tables"]}
                        for step in plan["steps"]
                    ],
                    expected_steps,
                )
                events = []

                class FakeDb:
                    driver = dialect
                    request_hook = None

                    def plan(self, _request):
                        return {"plan": plan}

                    def _send_step(self, _ex, _sql, step, _params):
                        events.append(step["role"])
                        return {"rows": [[FIXTURE["expected"]["total_count"]]]}

                def read_root(_ex, _cached, _step, _params):
                    events.append("main")
                    return []

                def read_relations(_ex, cached, _params, main):
                    events.extend(
                        step["role"]
                        for step in cached["plan"]["steps"][1:]
                        if step["role"] == "relation"
                    )
                    return {"main": main}

                with (
                    patch.object(database, "_select", read_root),
                    patch.object(database, "_relations", read_relations),
                ):
                    result = database.paginate(
                        database.Executor(FakeDb()), request, built.params
                    )
                self.assertEqual(events, ["main", "count"] + ["relation"] * 6)
                self.assertEqual(result["total"], FIXTURE["expected"]["total_count"])

        with self.assertRaises(OrmError) as raised:
            Engine(self.runtime, "sqlite").compile(request)
        self.assertEqual(raised.exception.code, codes.OPERATOR_NOT_ALLOWED)


if __name__ == "__main__":
    testcase.main()
