# The CPX-2 product search case runs through the generated public model API on the selected database.
import os
import tempfile
import unittest
from pathlib import Path

from polyspec.orm.errors import OrmError

from .complex_query_product import FIXTURE, SCHEMA_PATH, product_search_query
from .coverage_case import coverage_main
from .test_sqlite import generate_document


class ComplexQueryCoverageTest(unittest.TestCase):
    def test_complex_query_product_search(self):
        driver = os.environ.get("ORM_FEATURE_DATABASE", "")
        dsn = os.environ.get("ORM_FEATURE_DSN", "")
        self.assertIn(driver, ("mysql", "postgres", "sqlite"))
        target = {
            "mysql": "complex-query-python-mysql-check",
            "postgres": "complex-query-python-postgres-check",
            "sqlite": "complex-query-python-sqlite-check",
        }[driver]
        self.assertTrue(dsn, f"ORM_FEATURE_DSN is required; run make {target}")

        with tempfile.TemporaryDirectory(
            prefix="orm-complex-query-models-"
        ) as directory:
            models = generate_document(str(Path(directory) / "models"), SCHEMA_PATH)
            db = models.connect(dsn)
            try:
                if db.driver != driver:
                    self.fail("ORM_FEATURE_DSN selects another database")
                if driver == "sqlite":
                    self.assert_sqlite_refuses_before_statement(models, db)
                    return
                events = []
                unsubscribe = db.subscribe(events.append)
                try:
                    page = (
                        product_search_query(models, FIXTURE["input"])
                        .connect(db)
                        .gets_page(
                            FIXTURE["input"]["page"], FIXTURE["input"]["per_page"]
                        )
                    )
                finally:
                    unsubscribe()
                assert_product_page(self, page)
                self.assertEqual(
                    [
                        {"kind": event.kind, "tables": list(event.tables)}
                        for event in events
                    ],
                    FIXTURE["expected_events"][driver],
                )
            finally:
                db.close()

    def assert_sqlite_refuses_before_statement(self, models, db):
        events = []
        unsubscribe = db.subscribe(events.append)
        try:
            with self.assertRaises(OrmError) as raised:
                product_search_query(models, FIXTURE["input"]).connect(db).gets_page(
                    FIXTURE["input"]["page"], FIXTURE["input"]["per_page"]
                )
        finally:
            unsubscribe()
        self.assertEqual(getattr(raised.exception, "code", ""), "OPERATOR_NOT_ALLOWED")
        self.assertEqual(events, [])


def assert_product_page(test: unittest.TestCase, page) -> None:
    expected = FIXTURE["expected"]
    test.assertEqual(page["totalCount"], expected["total_count"])
    test.assertEqual(page["totalPages"], expected["total_pages"])
    products = page["items"]
    test.assertEqual([product.get_seq() for product in products], expected["row_seqs"])

    for product in products:
        product_seq = product.get_seq()
        key = str(product_seq)
        if key in expected["product_lang_seqs"]:
            localized = product.get_product_lang_model()
            test.assertIsNotNone(localized)
            test.assertEqual(localized.get_seq(), expected["product_lang_seqs"][key])
        if key in expected["brand_seqs"]:
            brand = product.get_brand()
            test.assertIsNotNone(brand)
            brand_seq = expected["brand_seqs"][key]
            test.assertEqual(brand.get_seq(), brand_seq)
            brand_lang = brand.get_product_brand_lang_model()
            test.assertIsNotNone(brand_lang)
            test.assertEqual(
                brand_lang.get_seq(),
                expected["brand_lang_seqs"][str(brand_seq)],
            )
        if key in expected["review_seqs"]:
            reviews = product.get_reviews().values()
            review_seqs = [review.get_seq() for review in reviews]
            test.assertEqual(review_seqs, expected["review_seqs"][key])
            for review in reviews:
                review_key = str(review.get_seq())
                if review_key in expected["review_user_seqs"]:
                    user = review.get_user()
                    test.assertIsNotNone(user)
                    test.assertEqual(
                        user.get_seq(), expected["review_user_seqs"][review_key]
                    )
        if key in expected["order_product_item_seqs"]:
            item = product.get_my_order_item()
            test.assertIsNotNone(item)
            test.assertEqual(item.get_seq(), expected["order_product_item_seqs"][key])


if __name__ == "__main__":
    coverage_main(ComplexQueryCoverageTest)
