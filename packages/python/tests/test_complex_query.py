import unittest

from . import testcase
from polyspec.orm.engine import Engine, model_of_documents, parse_document_set
from polyspec.orm.model import Model, register_model


SCHEMA = """dbspec 1 complex_query

table product {
  seq i64
  name varchar(191)
  short_description text
  content text
  primary key (seq)
}

table product_brand_lang {
  seq i64
  product_brand_seq i64
  name varchar(191)
  description text
  primary key (seq)
}

table product_lang {
  seq i64
  product_seq i64
  name varchar(191)
  short_description text
  content text
  primary key (seq)
}

table product_relation_1 {
  seq i64
  product_seq i64
  primary key (seq)
}

table product_relation_2 {
  seq i64
  product_seq i64
  primary key (seq)
}

table product_relation_3 {
  seq i64
  product_seq i64
  primary key (seq)
}

table product_relation_4 {
  seq i64
  product_seq i64
  primary key (seq)
}

table product_relation_5 {
  seq i64
  product_seq i64
  primary key (seq)
}

table product_relation_6 {
  seq i64
  product_seq i64
  primary key (seq)
}
"""


class ComplexQueryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = model_of_documents(parse_document_set([SCHEMA]))
        cls.registry = register_model(
            cls.runtime.manifest_text,
            cls.runtime.manifest_hash,
            cls.runtime.external_text,
        )

        def make_model(entity_name):
            class GeneratedModel(Model):
                @property
                def entity_def(self):
                    return cls.registry.entity_of(entity_name, GeneratedModel)

            return GeneratedModel

        cls.Product = make_model("product")
        cls.ProductBrandLang = make_model("product_brand_lang")
        cls.ProductLang = make_model("product_lang")
        cls.Relations = [
            make_model(f"product_relation_{index}") for index in range(1, 7)
        ]

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
            self.ProductBrandLang,
            "fulltext_boolean_name_with_description",
            ["name", "description"],
        )
        self.assert_fulltext_chain(
            self.ProductLang,
            "fulltext_boolean_name_with_short_description_with_content",
            ["name", "short_description", "content"],
        )
        self.assert_fulltext_chain(
            self.Product,
            "fulltext_boolean_name_with_short_description_with_content",
            ["name", "short_description", "content"],
        )

    def test_paginate_runs_root_count_then_six_relations(self):
        from unittest.mock import patch

        from polyspec.orm import database

        root = self.Product()
        for relation in self.Relations:
            root.relation(relation().match_seq_with_product_seq())
        query = root.core.clone()
        query.set_limit(0, 10)
        built = query.build("paginate")
        self.assertIsNone(built.error)
        request = built.finish()
        plan = Engine(self.runtime, "mysql").compile(request)
        self.assertEqual(
            [step["role"] for step in plan["steps"]],
            ["main", "count"] + ["relation"] * 6,
        )
        events = []

        class FakeDb:
            driver = "mysql"
            request_hook = None

            def plan(self, _request):
                return {"plan": plan}

            def _send_step(self, _ex, _sql, step, _params):
                events.append(step["role"])
                return {"rows": [[7]]}

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
        self.assertEqual(result["total"], 7)


if __name__ == "__main__":
    testcase.main()
