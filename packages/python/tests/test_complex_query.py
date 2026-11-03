import tempfile
import unittest
from pathlib import Path

from polyspec.orm import codes
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.errors import OrmError

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

    # Requirements: DSL-159.
    def test_get_page_plan_steps_gives_the_steps_of_the_plan_of_gets_page(self):
        with tempfile.TemporaryDirectory(prefix="orm-plan-steps-") as directory:
            db = self.models.connect("sqlite://" + str(Path(directory) / "steps.sqlite"))
            try:
                db.utils().schema().install(self.models.SCHEMA)

                def query():
                    return (
                        self.models.Product()
                        .connect(db)
                        .relations(
                            self.models.ProductReview()
                            .match_seq_with_product_seq()
                            .alias_reviews()
                        )
                        .service_seq(7)
                        .order_by_seq_desc()
                    )

                steps = query().get_page_plan_steps(2, 20)
                self.assertEqual(
                    [{"role": s["role"], "tables": s["tables"]} for s in steps],
                    [
                        {"role": "main", "tables": ["product"]},
                        {"role": "count", "tables": ["product"]},
                        {"role": "relation", "tables": ["product_review"]},
                    ],
                )
                # The steps are the statements that gets_page sends.
                events = []
                unsubscribe = db.subscribe(lambda event: events.append(event.sql))
                try:
                    query().gets_page(2, 20)
                finally:
                    unsubscribe()
                self.assertEqual(events, [steps[0]["sql"], steps[1]["sql"]])
                for refused in (
                    lambda: query().get_page_plan_steps(0, 20),
                    lambda: query().get_page_plan_steps(1, 0),
                    lambda: query().limit(0, 1).get_page_plan_steps(1, 20),
                    lambda: self.models.Product().get_page_plan_steps(1, 20),
                ):
                    with self.assertRaises(OrmError) as raised:
                        refused()
                    self.assertEqual(raised.exception.code, codes.CONFIG)
                with self.assertRaises(OrmError) as raised:
                    (
                        self.models.Product()
                        .connect(db)
                        .fulltext_boolean_name_with_short_description_with_content(
                            "alpha"
                        )
                        .get_page_plan_steps(1, 20)
                    )
                self.assertEqual(raised.exception.code, codes.OPERATOR_NOT_ALLOWED)
            finally:
                db.close()


if __name__ == "__main__":
    testcase.main()
