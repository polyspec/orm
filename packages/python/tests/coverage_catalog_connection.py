# Requirements: INT-123, SCH-6a
# catalog_connection native checks that no recipe case covers (docs/spec/feature-coverage.md FCV-2). Every other behaviour of
# this file is asserted by the shared recipe contracts/fixtures/catalog_connection/catalog_connection.json, which runs on the
# three databases through test_catalog_connection_mysql.py, test_catalog_connection_postgres.py and
# test_catalog_connection_sqlite.py. Each check that stays here is a GAP: the behaviour needs a recipe case that does not
# exist yet, and the check names it.
import os
import secrets
import sqlite3
import tempfile
import unittest

from polyspec.orm import OrmError, codes, connect_catalog
from polyspec.orm.codec import CodecError, decode as decode_styled
from polyspec.orm.database import parse_dsn
from . import testcase

TENANT = 990005

# Refusals that stay here (GAP, see test_grid_refused_values). The recipe's grid refusals name GRID_TEMPORAL_VALUE for the
# time values and have no date infinity case.
GRID_REFUSED = {
    "mysql": ["SELECT CAST('-01:00:00' AS TIME(6)) AS t"],
    "postgres": ["SELECT '24:00:00'::time AS t", "SELECT 'infinity'::date AS t"],
    "sqlite": [],
}


class CatalogConnectionCoverageTest(unittest.TestCase):
    def setUp(self):
        self.driver = os.environ.get("ORM_FEATURE_DATABASE", "")
        self.dsn = os.environ.get("ORM_FEATURE_DSN")
        self.assertIn(
            self.driver,
            ("mysql", "postgres", "sqlite"),
            "ORM_FEATURE_DATABASE is required; run it through make feature-check",
        )
        self.catalog = connect_catalog(self.dsn)
        self.assertEqual(
            self.catalog.dialect,
            self.driver,
            "ORM_FEATURE_DSN selects another database",
        )

    def tearDown(self):
        self.catalog.close()

    # Requirements: DBS-113, INT-106, INT-108, INT-109, INT-110, INT-111.
    # GAP: the stored revision of a row is the same after refused updates. The recipe's revision op reads the revision of the
    # snapshot it is given, and no recipe step reads the row again after a refused update.
    def test_row_mutation(self):
        table = {
            "namespace": self.catalog.current_namespace(),
            "name": "composite_account",
        }
        meta = self.catalog.describe_table(table)
        self.catalog.insert_row(
            meta, [("tenant_id", TENANT), ("account_id", 1), ("name", "catalog")]
        )

        def find():
            page = self.catalog.table_page(table, 1000, 0)
            index = page.column_index("tenant_id")
            found = [
                i for i, row in enumerate(page.result.rows) if row[index] == TENANT
            ]
            return self.catalog.row_snapshot_from_page(page, found[0])

        original = find()
        original_revision = original.revision
        for values in [
            [("name", "first"), ("name", "second")],
            [("absent", "value")],
            [("name", None)],
            [("name", "x" * 192)],
        ]:
            with self.assertRaises(OrmError):
                self.catalog.update_row(original, values)
        self.assertEqual(find().revision, original_revision)
        self.catalog.delete_row(find())
        if self.driver == "sqlite":
            with tempfile.TemporaryDirectory(
                prefix="orm-catalog-auto-key-"
            ) as directory:
                path = os.path.join(directory, "catalog.sqlite3")
                raw = sqlite3.connect(path)
                try:
                    raw.execute(
                        "CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)"
                    )
                    raw.execute(
                        "CREATE TABLE literal_key (tenant BIGINT NOT NULL, seq VARCHAR(30) NOT NULL DEFAULT 'generated', n BIGINT NOT NULL, PRIMARY KEY (tenant, seq))"
                    )
                    raw.execute(
                        "CREATE TABLE expression_key (seq TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) PRIMARY KEY, n BIGINT NOT NULL UNIQUE, label TEXT NULL)"
                    )
                finally:
                    raw.close()
                catalog = connect_catalog(f"sqlite://{path}")
                try:
                    metadata = catalog.describe_table(
                        {"namespace": "main", "name": "sample"}
                    )
                    self.assertEqual(metadata.primary_key, ["id"])
                    self.assertTrue(metadata.columns[0].automatic_key)
                    self.assertIsNone(metadata.columns[0].default_expression)
                    inserted = catalog.insert_row(metadata, [("payload", "generated")])
                    self.assertEqual(inserted.rows, [[1, "generated"]])
                    stored = catalog.read_only_query(
                        'SELECT "id", "payload" FROM "sample"', []
                    )
                    self.assertEqual(stored.rows, [[1, "generated"]])

                    literal_table = {"namespace": "main", "name": "literal_key"}
                    literal_metadata = catalog.describe_table(literal_table)
                    literal = catalog.insert_row(
                        literal_metadata, [("tenant", 2), ("n", 50)]
                    )
                    literal_stored = catalog.read_only_query(
                        'SELECT "tenant", "seq", "n" FROM "literal_key"', []
                    )
                    self.assertEqual(literal.rows, [[2, "generated", 50]])
                    self.assertEqual(literal.rows, literal_stored.rows)

                    expression_table = {
                        "namespace": "main",
                        "name": "expression_key",
                    }
                    expression_metadata = catalog.describe_table(expression_table)
                    expression = catalog.insert_row(
                        expression_metadata, [("n", 1), ("label", None)]
                    )
                    expression_stored = catalog.read_only_query(
                        'SELECT "seq", "n", "label" FROM "expression_key"', []
                    )
                    self.assertRegex(expression.rows[0][0], r"[0-9a-f]{32}")
                    self.assertEqual(
                        expression.rows, [[expression.rows[0][0], 1, None]]
                    )
                    self.assertEqual(expression.rows, expression_stored.rows)
                finally:
                    catalog.close()

    # GAP for the refusals kept here: the native check names CATALOG_VALUE, while the library raises GRID_TEMPORAL_VALUE for
    # the time values (catalog.py _refuse_temporal), so this check is likely stale and is not yet run against the library.
    def test_grid_refused_values(self):
        refused = GRID_REFUSED[self.driver]
        if not refused:
            self.skipTest("no refusal kept for this database")
        for sql in refused:
            with self.assertRaisesRegex(Exception, "CATALOG_VALUE"):
                self.catalog.read_only_grid_query(sql, [])

    # GAP: MySQL refuses a TIME(7) column at CREATE TABLE. The recipe's sql.exec step cannot expect a server error.
    def test_mysql_temporal_precision_refused(self):
        if self.driver != "mysql":
            self.skipTest("MySQL only")
        import pymysql

        url = parse_dsn(self.dsn).url
        invalid = (
            f"catalog_temporal_precision_{os.getpid()}_{secrets.token_hex(4)}_invalid"
        )
        native = pymysql.connect(
            host=url.hostname,
            port=url.port or 3306,
            user=url.username,
            password=url.password or "",
            database=url.path.lstrip("/"),
            autocommit=True,
        )
        try:
            with native.cursor() as cursor:
                with self.assertRaises(
                    Exception, msg="MySQL rejects temporal precision above 6"
                ) as rejected:
                    cursor.execute(
                        f"CREATE TABLE `{invalid}` (id BIGINT PRIMARY KEY, t TIME(7))"
                    )
            self.assertIn("precision", str(rejected.exception).lower())
        finally:
            native.close()

    # GAP: no catalog_connection case decodes an empty ordered_json text. The recipe's codec ops run only in the recipes
    # without a database, and no codec recipe case asserts this refusal.
    def test_ordered_json_empty_text_refused(self):
        with self.assertRaises(CodecError) as empty_json:
            decode_styled(["ordered_json"], "")
        self.assertEqual(empty_json.exception.code, codes.CODEC_DECODE)


if __name__ == "__main__":
    testcase.main()
