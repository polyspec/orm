import unittest

from polyspec.orm import OrmError, codes
from polyspec.orm.catalog import (
    CatalogColumn,
    CatalogConnection,
    CatalogRowSnapshot,
    CatalogTableMetadata,
)
from . import testcase


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

    # Requirements: INT-111.
    def test_row_update_checks_declared_text_and_binary_capacity_before_writing(self):
        metadata = CatalogTableMetadata(
            table={"namespace": "main", "name": "capacity_probe"},
            kind="table",
            columns=[
                CatalogColumn("id", "INTEGER", False, False),
                CatalogColumn("varchar_value", "varchar(3)", False, False),
                CatalogColumn("varying_value", "character varying(3)", False, False),
                CatalogColumn("varbinary_text_value", "varbinary(3)", False, False),
                CatalogColumn("varbinary_value", "varbinary(3)", False, False),
                CatalogColumn("binary_value", "binary(3)", False, False),
            ],
            primary_key=["id"],
            reliable_row_identity=True,
        )
        original = CatalogRowSnapshot(
            metadata,
            [1, "ok", "ok", "ok", b"ok", b"ok"],
            [0],
            "original revision",
        )
        catalog = object.__new__(CatalogConnection)
        catalog._dialect = "sqlite"
        writes = []
        marker = object()

        def write(work):
            writes.append(work)
            return marker

        catalog._write = write
        result = catalog.update_row(
            original,
            [
                ("varchar_value", "éxy"),
                ("varying_value", "éxy"),
                ("varbinary_text_value", "éx"),
                ("varbinary_value", b"\x00\xffx"),
                ("binary_value", b"\x00\xffx"),
            ],
        )
        self.assertIs(result, marker)
        self.assertEqual(len(writes), 1)

        for name, value in (
            ("varchar_value", "éxyz"),
            ("varying_value", "éxyz"),
            ("varbinary_text_value", "éxy"),
            ("varbinary_value", b"\x00\xffxy"),
            ("binary_value", b"\x00\xffxy"),
        ):
            with self.subTest(column=name):
                with self.assertRaises(OrmError) as raised:
                    catalog.update_row(original, [(name, value)])
                self.assertEqual(raised.exception.code, codes.ROW_UPDATE_INVALID)
                self.assertEqual(
                    len(writes), 1, "invalid values are refused before a write session"
                )


if __name__ == "__main__":
    testcase.main()
