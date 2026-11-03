import tempfile
import unittest
from pathlib import Path

from polyspec.orm.engine import Engine, model_of_documents, parse_document_set

from . import testcase
from .test_sqlite import generate_document

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "fixtures"
    / "complex_query"
    / "complex_query.dbs"
)


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

    def assert_fulltext_chain(self, model, method, columns, op="fulltext_boolean"):
        query = model()
        getattr(query, method)("alpha beta")
        built = query.core.build("all")
        request = built.finish()
        predicate = request["where"]["items"][0]["pred"]
        self.assertEqual(
            predicate,
            {"op": op, "cols": columns, "p": 0},
        )
        self.assertEqual(built.params, ["alpha beta"])
        for dialect in ("mysql", "postgres"):
            plan = Engine(self.runtime, dialect).compile(request)
            self.assertEqual(len(plan["steps"]), 1)
            slot = plan["steps"][0]["bind_slots"][0]
            self.assertEqual(slot["param"], 0)
            if op == "fulltext_boolean" and dialect == "mysql":
                self.assertEqual(slot["transform"], "fulltext_boolean")
            else:
                self.assertNotEqual(slot.get("transform"), "fulltext_boolean")

    # Requirements: DSL-33a.
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
        self.assert_fulltext_chain(
            self.models.ProductBrandLang,
            "fulltext_name_with_description",
            ["name", "description"],
            op="fulltext",
        )


if __name__ == "__main__":
    testcase.main()
