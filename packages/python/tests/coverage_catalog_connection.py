# catalog_connection coverage (Requirements: SCH-5, SCH-6a): runs the two shared cases against the bench database that the
# feature check selected (ORM_FEATURE_DATABASE, ORM_FEATURE_DSN) through connect_catalog. The read case only reads; the
# mutation case inserts, updates and deletes one row of composite_account in tenant 990005 and ends in the state it started in.
import os
import unittest

from polyspec_orm import connect_catalog

TENANT = 990005


def quote(name, driver):
    return f"`{name}`" if driver == "mysql" else f'"{name}"'


class CatalogConnectionCoverageTest(unittest.TestCase):
    def setUp(self):
        self.driver = os.environ.get("ORM_FEATURE_DATABASE", "")
        self.assertIn(self.driver, ("mysql", "postgres", "sqlite"), "ORM_FEATURE_DATABASE is required; run it through make feature-check")
        self.catalog = connect_catalog(os.environ["ORM_FEATURE_DSN"])
        self.assertEqual(self.catalog.dialect, self.driver, "ORM_FEATURE_DSN selects another database")

    def tearDown(self):
        self.catalog.close()

    def test_read(self):
        driver = self.driver
        namespace = self.catalog.current_namespace()
        author = {"namespace": namespace, "name": "author"}
        meta = self.catalog.describe_table(author)
        self.assertEqual(meta.primary_key, ["seq"])
        self.assertTrue(meta.reliable_row_identity)
        self.assertIn("start_dt", [c.name for c in meta.columns])
        page = self.catalog.table_page(author, 3, 0)
        self.assertEqual(page.order_by, ["seq"])
        self.assertTrue(page.has_more)
        self.assertEqual(len(page.result.rows), 3)
        count = self.catalog.read_only_query(f"SELECT COUNT(*) FROM {quote('user', driver)}", [])
        self.assertEqual(int(count.rows[0][0]), 5000)
        with self.assertRaisesRegex(Exception, "QUERY_READ_ONLY"):
            self.catalog.read_only_query(f"UPDATE {quote('user', driver)} SET name = name WHERE seq = 1", [])

    def test_row_mutation(self):
        driver = self.driver
        account = quote("composite_account", driver)
        count_sql = f"SELECT COUNT(*) FROM {account} WHERE tenant_id = {TENANT}"

        def tenant_rows():
            return int(self.catalog.read_only_query(count_sql, []).rows[0][0])

        self.assertEqual(tenant_rows(), 0)
        table = {"namespace": self.catalog.current_namespace(), "name": "composite_account"}
        meta = self.catalog.describe_table(table)
        inserted = self.catalog.insert_row(meta, [("tenant_id", TENANT), ("account_id", 1), ("name", "catalog")])
        self.assertEqual(len(inserted.rows), 1)

        def find(want):
            page = self.catalog.table_page(table, 1000, 0)
            self.assertFalse(page.has_more)
            index = page.column_index("tenant_id")
            found = [i for i, row in enumerate(page.result.rows) if row[index] == TENANT]
            self.assertEqual(len(found), 1)
            self.assertEqual(page.result.rows[found[0]][page.column_index("name")], want)
            return self.catalog.row_snapshot_from_page(page, found[0])

        updated = self.catalog.update_row(find("catalog"), [("name", "catalog-updated")])
        self.assertEqual(len(updated.rows), 1)
        self.assertEqual(self.catalog.delete_row(find("catalog-updated")), 1)
        self.assertEqual(tenant_rows(), 0)


if __name__ == "__main__":
    unittest.main()
