import unittest

from . import testcase
from polyspec.orm import OrmError, codes
from polyspec.orm.catalog import CatalogColumn, CatalogConnection, CatalogTableMetadata


class CatalogPageValidationTest(unittest.TestCase):
    # Requirements: INT-121.
    def test_rejects_prepared_column_and_in_scope_descriptor_changes(self):
        before = CatalogTableMetadata(
            table={"namespace": "main", "name": "page_probe"},
            kind="table",
            columns=[CatalogColumn("id", "INTEGER", False, False)],
            primary_key=["id"],
            reliable_row_identity=True,
        )
        changed = CatalogTableMetadata(
            table=before.table,
            kind="table",
            columns=[CatalogColumn("id", "INTEGER", True, False)],
            primary_key=["id"],
            reliable_row_identity=True,
        )
        for after, names in ((before, ["renamed"]), (changed, ["id"])):
            calls = 0

            class FakeSession:
                def describe(self, _table):
                    nonlocal calls
                    calls += 1
                    return before if calls == 1 else after

                def run(self, _query, _params, _max_rows, _max_bytes):
                    return type("Raw", (), {"names": names, "rows": []})()

            catalog = object.__new__(CatalogConnection)
            catalog._dialect = "sqlite"
            catalog._read = lambda work: work(FakeSession())
            with self.assertRaises(OrmError) as raised:
                catalog.table_page(before.table, 1, 0)
            self.assertEqual(raised.exception.code, codes.TABLE_PAGE_METADATA_CHANGED)


if __name__ == "__main__":
    testcase.main()
